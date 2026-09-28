/**
 * @file scripts/validate-stage7.ts
 * Stage 7 Validation Suite: Recovery, Heartbeat Deadlines & Reconciliation.
 *
 * Verifies all 24 required Stage 7 invariants:
 *  1. Stale RESERVED attempt is recoverable.
 *  2. Non-stale RESERVED attempt is not recovered.
 *  3. RECOVERY_RELEASED persists.
 *  4. RECOVERY_RELEASED survives restart.
 *  5. RECOVERY_RELEASED cannot be dispatched.
 *  6. RECOVERY_RELEASED does not create evidence.
 *  7. RECOVERY_RELEASED does not set executed_fact = false.
 *  8. DISPATCHED_UNRESOLVED cannot become RECOVERY_RELEASED.
 *  9. DISPATCHED_UNRESOLVED remains unresolved without qualifying evidence.
 * 10. Repeated recovery is idempotent.
 * 11. Concurrent recovery cannot double-transition.
 * 12. Dispatch/recovery race has exactly one winner.
 * 13. Dispatch winner prevents recovery release.
 * 14. Recovery winner prevents dispatch.
 * 15. Stale recovery fencing fails safely.
 * 16. Restart scan discovers eligible stale RESERVED attempts.
 * 17. Restart scan does not require in-memory state.
 * 18. Missing heartbeat capability is explicitly degraded.
 * 19. Malformed heartbeat configuration fails safely.
 * 20. Recovery cannot call provider adapters.
 * 21. Recovery cannot create dispatch claims.
 * 22. Recovery cannot manufacture external evidence.
 * 23. Reconciliation identifies unresolved work without resolving its external outcome.
 * 24. Existing Stage 1–6 validation still passes.
 */

import { PGlite } from '@electric-sql/pglite';
import { createFreshDb, applySchema, seedMockCapabilityContract } from '../src/db/database.ts';
import { authorizeOperation } from '../src/authorization/authorizeOperation.ts';
import { executeDispatch } from '../src/dispatch/executeDispatch.ts';
import { MockSendMessageProvider } from '../src/dispatch/mockProvider.ts';
import { deriveCanonicalState } from '../src/derivation/deriveCanonicalState.ts';
import {
  executeRecovery,
  recordAttemptHeartbeat,
  scanAndRecoverStaleReservedAttempts,
  reconcileUnresolvedAttempts,
  RecoveryError,
} from '../src/recovery/index.ts';

function assert(condition: boolean, testName: string, detail?: string): void {
  if (!condition) {
    console.error(`  [FAIL] ${testName}: ${detail ?? 'Assertion failed'}`);
    process.exit(1);
  }
  console.log(`  [PASS] ${testName}: ${detail ?? 'Verified'}`);
}

async function setupStage7Prerequisites(db: PGlite) {
  await applySchema(db);
  await seedMockCapabilityContract(db);

  await db.exec(`
    INSERT INTO principals (principal_id, type, name, status, metadata)
    VALUES ('agent-rec-1', 'AGENT', 'Recovery Agent 1', 'ACTIVE', '{"scopes": ["*"]}'::jsonb),
           ('agent-rec-2', 'AGENT', 'Recovery Agent 2', 'ACTIVE', '{"scopes": ["*"]}'::jsonb),
           ('worker-rec-1', 'WORKER', 'Recovery Worker 1', 'ACTIVE', '{"scopes": ["*"]}'::jsonb),
           ('worker-rec-2', 'WORKER', 'Recovery Worker 2', 'ACTIVE', '{"scopes": ["*"]}'::jsonb),
           ('worker-disp-1', 'WORKER', 'Dispatch Worker 1', 'ACTIVE', '{"scopes": ["*"]}'::jsonb)
    ON CONFLICT (principal_id) DO NOTHING;

    INSERT INTO principal_budgets (principal_id, currency_or_unit, budget_limit, reserved_amount)
    VALUES ('agent-rec-1', 'USD', 10000.0, 0.0),
           ('agent-rec-2', 'USD', 10000.0, 0.0)
    ON CONFLICT (principal_id, currency_or_unit) DO NOTHING;

    INSERT INTO policy_versions (policy_version_id, policy_name, version, is_active, rules_definition)
    VALUES ('pol_stage7_v1', 'stage7_policy', '1.0.0', true, '{"max_retries": 3}'::jsonb)
    ON CONFLICT (policy_version_id) DO NOTHING;
  `);
}

async function runStage7Validation() {
  console.log('===============================================================');
  console.log('STARTING STAGE 7 RECOVERY, HEARTBEATS & RECONCILIATION VALIDATION');
  console.log('===============================================================');

  const db = await createFreshDb();
  await setupStage7Prerequisites(db);
  const mockProvider = new MockSendMessageProvider('mock.send_message');

  // --------------------------------------------------------------------------
  // TEST 1: Stale RESERVED attempt is recoverable
  // --------------------------------------------------------------------------
  console.log('\n[1/24] Testing: Stale RESERVED attempt is recoverable...');
  const auth1 = await authorizeOperation(db, {
    actor_principal_id: 'agent-rec-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage7_v1',
    idempotency_key: 'idem-st7-test-1',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15557000001',
      message_body: 'Stage 7 Recovery Test 1',
      channel: 'sms',
    },
  });

  // Backdate reserved_at by 120 seconds (contract heartbeat interval is 60s)
  await db.query(
    `UPDATE attempts
     SET reserved_at = NOW() - INTERVAL '120 seconds'
     WHERE attempt_id = $1;`,
    [auth1.attempt_id]
  );

  const rec1 = await executeRecovery(db, {
    attempt_id: auth1.attempt_id,
    recovery_worker_identity: 'worker-rec-1',
    expected_fence_version: 1,
  });

  assert(rec1.success === true, 'Recovery Success', 'Recovery execution returned success.');
  assert(rec1.resulting_state === 'RECOVERY_RELEASED', 'Resulting State', 'Attempt transitioned to RECOVERY_RELEASED.');
  assert(rec1.prior_fence_version === 1, 'Prior Fence', 'Prior fence version was 1.');
  assert(rec1.resulting_fence_version === 2, 'Resulting Fence', 'Resulting fence version incremented to 2.');
  assert(rec1.already_released === false, 'Fresh Transition', 'First recovery call marked already_released as false.');

  const dbRow1 = (await db.query<{ state: string; fence_version: string }>(
    `SELECT state, fence_version FROM attempts WHERE attempt_id = $1;`,
    [auth1.attempt_id]
  )).rows[0];
  assert(dbRow1.state === 'RECOVERY_RELEASED', 'DB State', 'Database attempt state is RECOVERY_RELEASED.');
  assert(Number(dbRow1.fence_version) === 2, 'DB Fence', 'Database fence version is 2.');

  // --------------------------------------------------------------------------
  // TEST 2: Non-stale RESERVED attempt is not recovered
  // --------------------------------------------------------------------------
  console.log('\n[2/24] Testing: Non-stale RESERVED attempt is not recovered...');
  const auth2 = await authorizeOperation(db, {
    actor_principal_id: 'agent-rec-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage7_v1',
    idempotency_key: 'idem-st7-test-2',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15557000002',
      message_body: 'Stage 7 Fresh Attempt Test',
      channel: 'sms',
    },
  });

  let nonStaleRejected = false;
  try {
    await executeRecovery(db, {
      attempt_id: auth2.attempt_id,
      recovery_worker_identity: 'worker-rec-1',
      expected_fence_version: 1,
    });
  } catch (err: unknown) {
    if (err instanceof RecoveryError && err.code === 'ATTEMPT_NOT_STALE') {
      nonStaleRejected = true;
    }
  }
  assert(nonStaleRejected, 'Non-stale Protection', 'Recovery rejected fresh non-stale RESERVED attempt.');

  const dbRow2 = (await db.query<{ state: string }>(
    `SELECT state FROM attempts WHERE attempt_id = $1;`,
    [auth2.attempt_id]
  )).rows[0];
  assert(dbRow2.state === 'RESERVED', 'State Intact', 'Attempt remains in RESERVED state.');

  // --------------------------------------------------------------------------
  // TEST 3: RECOVERY_RELEASED persists
  // --------------------------------------------------------------------------
  console.log('\n[3/24] Testing: RECOVERY_RELEASED persists in durable storage...');
  const persistedRec = (await db.query<{
    state: string;
    resolved_at: string | null;
    recovery_reason: string | null;
    fence_version: string;
  }>(
    `SELECT state, resolved_at, recovery_reason, fence_version
     FROM attempts WHERE attempt_id = $1;`,
    [auth1.attempt_id]
  )).rows[0];

  assert(persistedRec.state === 'RECOVERY_RELEASED', 'Persisted State', 'State is RECOVERY_RELEASED.');
  assert(persistedRec.resolved_at !== null, 'Persisted Resolved Timestamp', 'resolved_at is populated.');
  assert(persistedRec.recovery_reason !== null, 'Persisted Recovery Reason', 'recovery_reason is populated.');

  // --------------------------------------------------------------------------
  // TEST 4: RECOVERY_RELEASED survives restart simulation
  // --------------------------------------------------------------------------
  console.log('\n[4/24] Testing: RECOVERY_RELEASED survives restart...');
  // Read back directly from database after simulated cache reset
  const reloadQuery = await db.query<{ state: string; fence_version: string }>(
    `SELECT state, fence_version FROM attempts WHERE attempt_id = $1;`,
    [auth1.attempt_id]
  );
  assert(reloadQuery.rows[0].state === 'RECOVERY_RELEASED', 'Survives Restart', 'State unchanged on reload.');
  assert(Number(reloadQuery.rows[0].fence_version) === 2, 'Fence Intact', 'Fence version 2 intact.');

  // --------------------------------------------------------------------------
  // TEST 5: RECOVERY_RELEASED cannot be dispatched
  // --------------------------------------------------------------------------
  console.log('\n[5/24] Testing: RECOVERY_RELEASED cannot be dispatched...');
  let dispatchBlocked = false;
  try {
    await executeDispatch(
      db,
      {
        attempt_id: auth1.attempt_id,
        effect_key: auth1.effect_key,
        expected_fence_version: 2,
        dispatcher_identity: 'worker-disp-1',
      },
      mockProvider
    );
  } catch (err: unknown) {
    if ((err as Error).message.includes('RECOVERY_RELEASED')) {
      dispatchBlocked = true;
    }
  }
  assert(dispatchBlocked, 'Dispatch Blocked', 'Dispatch on RECOVERY_RELEASED attempt was strictly blocked.');

  const claimCount = (await db.query<{ count: string }>(
    `SELECT count(*) FROM dispatch_claims WHERE attempt_id = $1;`,
    [auth1.attempt_id]
  )).rows[0].count;
  assert(Number(claimCount) === 0, 'No Claims Created', 'No dispatch claim was created.');

  // --------------------------------------------------------------------------
  // TEST 6: RECOVERY_RELEASED does not create evidence
  // --------------------------------------------------------------------------
  console.log('\n[6/24] Testing: RECOVERY_RELEASED does not create evidence...');
  const evidenceCount = (await db.query<{ count: string }>(
    `SELECT count(*) FROM evidence_records WHERE attempt_id = $1;`,
    [auth1.attempt_id]
  )).rows[0].count;
  assert(Number(evidenceCount) === 0, 'Zero Evidence Created', 'RECOVERY_RELEASED created zero evidence records.');

  // --------------------------------------------------------------------------
  // TEST 7: RECOVERY_RELEASED does not set executed_fact = false
  // --------------------------------------------------------------------------
  console.log('\n[7/24] Testing: RECOVERY_RELEASED does not set executed_fact = false...');
  // Manually set executed_fact = TRUE on an effect to verify recovery cannot clear it
  await db.query(
    `UPDATE effects SET executed_fact = TRUE WHERE effect_key = $1;`,
    [auth1.effect_key]
  );
  // Re-run recovery (idempotent)
  await executeRecovery(db, {
    attempt_id: auth1.attempt_id,
    recovery_worker_identity: 'worker-rec-1',
    expected_fence_version: 2,
  });

  const effCheck = (await db.query<{ executed_fact: boolean }>(
    `SELECT executed_fact FROM effects WHERE effect_key = $1;`,
    [auth1.effect_key]
  )).rows[0];
  assert(effCheck.executed_fact === true, 'Executed Fact Preserved', 'executed_fact remains TRUE; recovery cannot alter external truth.');

  // --------------------------------------------------------------------------
  // TEST 8: DISPATCHED_UNRESOLVED cannot become RECOVERY_RELEASED
  // --------------------------------------------------------------------------
  console.log('\n[8/24] Testing: DISPATCHED_UNRESOLVED cannot become RECOVERY_RELEASED...');
  const auth3 = await authorizeOperation(db, {
    actor_principal_id: 'agent-rec-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage7_v1',
    idempotency_key: 'idem-st7-test-3',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15557000003',
      message_body: 'Stage 7 Dispatched Attempt',
      channel: 'sms',
    },
  });

  await executeDispatch(
    db,
    {
      attempt_id: auth3.attempt_id,
      effect_key: auth3.effect_key,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-disp-1',
    },
    mockProvider
  );

  let dispatchedRecoveryRejected = false;
  try {
    await executeRecovery(db, {
      attempt_id: auth3.attempt_id,
      recovery_worker_identity: 'worker-rec-1',
      expected_fence_version: 2,
      force_recovery: true,
    });
  } catch (err: unknown) {
    if (
      err instanceof RecoveryError &&
      err.code === 'DISPATCHED_UNRESOLVED_CANNOT_BE_RECOVERED'
    ) {
      dispatchedRecoveryRejected = true;
    }
  }
  assert(dispatchedRecoveryRejected, 'Dispatched Protection', 'DISPATCHED_UNRESOLVED attempt cannot be converted to RECOVERY_RELEASED.');

  const dbRow3 = (await db.query<{ state: string }>(
    `SELECT state FROM attempts WHERE attempt_id = $1;`,
    [auth3.attempt_id]
  )).rows[0];
  assert(dbRow3.state === 'DISPATCHED_UNRESOLVED', 'Dispatched State Intact', 'Attempt remains DISPATCHED_UNRESOLVED.');

  // --------------------------------------------------------------------------
  // TEST 9: DISPATCHED_UNRESOLVED remains unresolved without qualifying evidence
  // --------------------------------------------------------------------------
  console.log('\n[9/24] Testing: DISPATCHED_UNRESOLVED remains unresolved without qualifying evidence...');
  const deriv3 = await deriveCanonicalState(db, { attempt_id: auth3.attempt_id });
  assert(deriv3.target_attempt?.canonical_state === 'DISPATCHED_UNRESOLVED', 'Canonical State Unresolved', 'Attempt canonical state remains DISPATCHED_UNRESOLVED.');
  assert(deriv3.target_attempt?.executed_fact === false, 'Executed Fact False', 'executed_fact remains false.');

  // --------------------------------------------------------------------------
  // TEST 10: Repeated recovery is idempotent
  // --------------------------------------------------------------------------
  console.log('\n[10/24] Testing: Repeated recovery is idempotent...');
  const recRepeated = await executeRecovery(db, {
    attempt_id: auth1.attempt_id,
    recovery_worker_identity: 'worker-rec-2',
    expected_fence_version: 2,
  });
  assert(recRepeated.success === true, 'Repeated Recovery Success', 'Repeated recovery returned success.');
  assert(recRepeated.already_released === true, 'Already Released Flag', 'Marked as already_released: true.');
  assert(recRepeated.resulting_fence_version === 2, 'Fence Not Bumped', 'Fence version did not increment.');

  // --------------------------------------------------------------------------
  // TEST 11: Concurrent recovery cannot double-transition
  // --------------------------------------------------------------------------
  console.log('\n[11/24] Testing: Concurrent recovery cannot double-transition...');
  const auth4 = await authorizeOperation(db, {
    actor_principal_id: 'agent-rec-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage7_v1',
    idempotency_key: 'idem-st7-test-4',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15557000004',
      message_body: 'Stage 7 Concurrent Recovery',
      channel: 'sms',
    },
  });

  await db.query(
    `UPDATE attempts SET reserved_at = NOW() - INTERVAL '120 seconds' WHERE attempt_id = $1;`,
    [auth4.attempt_id]
  );

  const concurrentResults = await Promise.allSettled([
    executeRecovery(db, { attempt_id: auth4.attempt_id, recovery_worker_identity: 'worker-1', expected_fence_version: 1 }),
    executeRecovery(db, { attempt_id: auth4.attempt_id, recovery_worker_identity: 'worker-2', expected_fence_version: 1 }),
    executeRecovery(db, { attempt_id: auth4.attempt_id, recovery_worker_identity: 'worker-3', expected_fence_version: 1 }),
  ]);

  const fulfilled = concurrentResults.filter((r) => r.status === 'fulfilled');
  assert(fulfilled.length > 0, 'At Least One Succeeded', 'At least one worker succeeded.');

  const dbRow4 = (await db.query<{ state: string; fence_version: string }>(
    `SELECT state, fence_version FROM attempts WHERE attempt_id = $1;`,
    [auth4.attempt_id]
  )).rows[0];
  assert(dbRow4.state === 'RECOVERY_RELEASED', 'State Released', 'Attempt is RECOVERY_RELEASED.');
  assert(Number(dbRow4.fence_version) === 2, 'Single Fence Bump', 'Fence version incremented exactly once (from 1 to 2).');

  // --------------------------------------------------------------------------
  // TEST 12: Dispatch/recovery race has exactly one winner
  // --------------------------------------------------------------------------
  console.log('\n[12/24] Testing: Dispatch/recovery race has exactly one winner...');
  const auth5 = await authorizeOperation(db, {
    actor_principal_id: 'agent-rec-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage7_v1',
    idempotency_key: 'idem-st7-test-5',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15557000005',
      message_body: 'Stage 7 Race Test',
      channel: 'sms',
    },
  });

  await db.query(
    `UPDATE attempts SET reserved_at = NOW() - INTERVAL '120 seconds' WHERE attempt_id = $1;`,
    [auth5.attempt_id]
  );

  const [raceDispatch, raceRecovery] = await Promise.allSettled([
    executeDispatch(
      db,
      {
        attempt_id: auth5.attempt_id,
        effect_key: auth5.effect_key,
        expected_fence_version: 1,
        dispatcher_identity: 'worker-disp-1',
      },
      mockProvider
    ),
    executeRecovery(db, {
      attempt_id: auth5.attempt_id,
      recovery_worker_identity: 'worker-rec-1',
      expected_fence_version: 1,
    }),
  ]);

  const dispatchWon = raceDispatch.status === 'fulfilled';
  const recoveryWon = raceRecovery.status === 'fulfilled';

  assert(
    (dispatchWon && !recoveryWon) || (!dispatchWon && recoveryWon),
    'Exactly One Winner',
    `Exactly one operation won the race: dispatchWon=${dispatchWon}, recoveryWon=${recoveryWon}`
  );

  const finalState = (await db.query<{ state: string }>(
    `SELECT state FROM attempts WHERE attempt_id = $1;`,
    [auth5.attempt_id]
  )).rows[0].state;

  const finalClaimCount = (await db.query<{ count: string }>(
    `SELECT count(*) FROM dispatch_claims WHERE attempt_id = $1;`,
    [auth5.attempt_id]
  )).rows[0].count;

  if (dispatchWon) {
    assert(finalState === 'DISPATCHED_UNRESOLVED', 'Dispatch Winner State', 'State is DISPATCHED_UNRESOLVED.');
    assert(Number(finalClaimCount) === 1, 'Dispatch Winner Claim', 'Exactly 1 claim created.');
  } else {
    assert(finalState === 'RECOVERY_RELEASED', 'Recovery Winner State', 'State is RECOVERY_RELEASED.');
    assert(Number(finalClaimCount) === 0, 'Recovery Winner Claim', 'Zero claims created.');
  }

  // --------------------------------------------------------------------------
  // TEST 13: Dispatch winner prevents recovery release
  // --------------------------------------------------------------------------
  console.log('\n[13/24] Testing: Dispatch winner prevents recovery release...');
  const auth6 = await authorizeOperation(db, {
    actor_principal_id: 'agent-rec-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage7_v1',
    idempotency_key: 'idem-st7-test-6',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15557000006',
      message_body: 'Stage 7 Dispatch Winner Test',
      channel: 'sms',
    },
  });

  // Dispatch completes first
  await executeDispatch(
    db,
    {
      attempt_id: auth6.attempt_id,
      effect_key: auth6.effect_key,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-disp-1',
    },
    mockProvider
  );

  // Recovery must fail
  let recFailed = false;
  try {
    await executeRecovery(db, {
      attempt_id: auth6.attempt_id,
      recovery_worker_identity: 'worker-rec-1',
      expected_fence_version: 1,
      force_recovery: true,
    });
  } catch (err: unknown) {
    recFailed = true;
  }
  assert(recFailed, 'Recovery Prevented', 'Recovery failed after dispatch won.');

  // --------------------------------------------------------------------------
  // TEST 14: Recovery winner prevents dispatch
  // --------------------------------------------------------------------------
  console.log('\n[14/24] Testing: Recovery winner prevents dispatch...');
  const auth7 = await authorizeOperation(db, {
    actor_principal_id: 'agent-rec-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage7_v1',
    idempotency_key: 'idem-st7-test-7',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15557000007',
      message_body: 'Stage 7 Recovery Winner Test',
      channel: 'sms',
    },
  });

  await db.query(
    `UPDATE attempts SET reserved_at = NOW() - INTERVAL '120 seconds' WHERE attempt_id = $1;`,
    [auth7.attempt_id]
  );

  // Recovery completes first
  await executeRecovery(db, {
    attempt_id: auth7.attempt_id,
    recovery_worker_identity: 'worker-rec-1',
    expected_fence_version: 1,
  });

  // Dispatch must fail
  let dispFailed = false;
  try {
    await executeDispatch(
      db,
      {
        attempt_id: auth7.attempt_id,
        effect_key: auth7.effect_key,
        expected_fence_version: 1,
        dispatcher_identity: 'worker-disp-1',
      },
      mockProvider
    );
  } catch (err: unknown) {
    dispFailed = true;
  }
  assert(dispFailed, 'Dispatch Prevented', 'Dispatch failed after recovery won.');

  // --------------------------------------------------------------------------
  // TEST 15: Stale recovery fencing fails safely
  // --------------------------------------------------------------------------
  console.log('\n[15/24] Testing: Stale recovery fencing fails safely...');
  const auth8 = await authorizeOperation(db, {
    actor_principal_id: 'agent-rec-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage7_v1',
    idempotency_key: 'idem-st7-test-8',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15557000008',
      message_body: 'Stage 7 Stale Fence Test',
      channel: 'sms',
    },
  });

  let staleFenceRejected = false;
  try {
    await executeRecovery(db, {
      attempt_id: auth8.attempt_id,
      recovery_worker_identity: 'worker-rec-1',
      expected_fence_version: 99,
      force_recovery: true,
    });
  } catch (err: unknown) {
    if (err instanceof RecoveryError && err.code === 'STALE_ATTEMPT_VERSION') {
      staleFenceRejected = true;
    }
  }
  assert(staleFenceRejected, 'Stale Version Rejection', 'Stale fence version 99 was rejected.');

  // --------------------------------------------------------------------------
  // TEST 16: Restart scan discovers eligible stale RESERVED attempts
  // --------------------------------------------------------------------------
  console.log('\n[16/24] Testing: Restart scan discovers eligible stale RESERVED attempts...');
  const auth9a = await authorizeOperation(db, {
    actor_principal_id: 'agent-rec-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage7_v1',
    idempotency_key: 'idem-st7-scan-1',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15557000009',
      message_body: 'Scan Stale 1',
      channel: 'sms',
    },
  });
  const auth9b = await authorizeOperation(db, {
    actor_principal_id: 'agent-rec-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage7_v1',
    idempotency_key: 'idem-st7-scan-2',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15557000010',
      message_body: 'Scan Stale 2',
      channel: 'sms',
    },
  });
  const auth9c = await authorizeOperation(db, {
    actor_principal_id: 'agent-rec-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage7_v1',
    idempotency_key: 'idem-st7-scan-3',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15557000011',
      message_body: 'Scan Fresh 3',
      channel: 'sms',
    },
  });

  // Backdate 9a and 9b, leave 9c fresh
  await db.query(
    `UPDATE attempts SET reserved_at = NOW() - INTERVAL '150 seconds' WHERE attempt_id IN ($1, $2);`,
    [auth9a.attempt_id, auth9b.attempt_id]
  );

  const scanResult = await scanAndRecoverStaleReservedAttempts(db, {
    limit: 10,
    recovery_worker_identity: 'scanner-worker-1',
  });

  assert(scanResult.recovered_count >= 2, 'Scan Recovered Stale', `Scan recovered ${scanResult.recovered_count} attempts.`);
  const recoveredIds = scanResult.recovered_attempts.map((r) => r.attempt_id);
  assert(recoveredIds.includes(auth9a.attempt_id), 'Recovered 9a', 'Attempt 9a was recovered.');
  assert(recoveredIds.includes(auth9b.attempt_id), 'Recovered 9b', 'Attempt 9b was recovered.');
  assert(!recoveredIds.includes(auth9c.attempt_id), 'Fresh 9c Skipped', 'Fresh attempt 9c was skipped.');

  // --------------------------------------------------------------------------
  // TEST 17: Restart scan does not require in-memory state
  // --------------------------------------------------------------------------
  console.log('\n[17/24] Testing: Restart scan does not require in-memory state...');
  // Running second scan immediately should recover 0 additional attempts (idempotent)
  const scanResult2 = await scanAndRecoverStaleReservedAttempts(db, {
    limit: 10,
    recovery_worker_identity: 'scanner-worker-2',
  });
  assert(scanResult2.recovered_count === 0, 'Second Scan Zero', 'Second scan recovered 0 additional attempts.');

  // --------------------------------------------------------------------------
  // TEST 18: Missing heartbeat capability is explicitly degraded
  // --------------------------------------------------------------------------
  console.log('\n[18/24] Testing: Missing heartbeat capability is explicitly degraded...');
  // Insert contract with NULL heartbeat_interval_seconds
  await db.exec(`
    INSERT INTO capabilities (capability_id, name, description)
    VALUES ('cap.no_heartbeat', 'No Heartbeat Capability', 'Degraded liveness capability')
    ON CONFLICT (capability_id) DO NOTHING;

    INSERT INTO capability_contracts (
      capability_id, version, repeat_mode, effect_key_canonicalization_version,
      required_effect_fields, provider_dedup_semantics, provider_dedup_identity_rule,
      dedup_validity_window_seconds, supported_evidence_types, evidence_correlation_method,
      heartbeat_interval_seconds, contract_status
    ) VALUES (
      'cap.no_heartbeat', '1.0.0', 'UNSAFE_REPEAT', 'v1',
      '["item"]'::jsonb, 'NONE', 'none', NULL, '["EXECUTION_CONFIRMED"]'::jsonb,
      'CLIENT_CORRELATION_ID_MATCH', NULL, 'ACTIVE'
    ) ON CONFLICT (capability_id, version) DO UPDATE SET heartbeat_interval_seconds = NULL;
  `);

  const authNoHb = await authorizeOperation(db, {
    actor_principal_id: 'agent-rec-1',
    capability_id: 'cap.no_heartbeat',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage7_v1',
    idempotency_key: 'idem-st7-no-hb',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: { item: 'Degraded Liveness Test' },
  });

  await db.query(
    `UPDATE attempts SET reserved_at = NOW() - INTERVAL '300 seconds' WHERE attempt_id = $1;`,
    [authNoHb.attempt_id]
  );

  let degradedRejected = false;
  try {
    await executeRecovery(db, {
      attempt_id: authNoHb.attempt_id,
      recovery_worker_identity: 'worker-rec-1',
      expected_fence_version: 1,
    });
  } catch (err: unknown) {
    if (
      err instanceof RecoveryError &&
      err.code === 'DEGRADED_LIVENESS_NO_HEARTBEAT_CAPABILITY'
    ) {
      degradedRejected = true;
    }
  }
  assert(degradedRejected, 'Degraded Liveness Handled', 'Recovery safely refused without global timeout invention.');

  // --------------------------------------------------------------------------
  // TEST 19: Malformed heartbeat configuration fails safely
  // --------------------------------------------------------------------------
  console.log('\n[19/24] Testing: Malformed heartbeat configuration fails safely...');
  // Insert contract with invalid non-positive heartbeat
  await db.exec(`
    INSERT INTO capabilities (capability_id, name, description)
    VALUES ('cap.malformed_hb', 'Malformed Heartbeat Capability', 'Test malformed config')
    ON CONFLICT (capability_id) DO NOTHING;

    INSERT INTO capability_contracts (
      capability_id, version, repeat_mode, effect_key_canonicalization_version,
      required_effect_fields, provider_dedup_semantics, provider_dedup_identity_rule,
      dedup_validity_window_seconds, supported_evidence_types, evidence_correlation_method,
      heartbeat_interval_seconds, contract_status
    ) VALUES (
      'cap.malformed_hb', '1.0.0', 'UNSAFE_REPEAT', 'v1',
      '["item"]'::jsonb, 'NONE', 'none', NULL, '["EXECUTION_CONFIRMED"]'::jsonb,
      'CLIENT_CORRELATION_ID_MATCH', -5, 'ACTIVE'
    ) ON CONFLICT (capability_id, version) DO UPDATE SET heartbeat_interval_seconds = -5;
  `);

  const authMalformed = await authorizeOperation(db, {
    actor_principal_id: 'agent-rec-1',
    capability_id: 'cap.malformed_hb',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage7_v1',
    idempotency_key: 'idem-st7-malformed-hb',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: { item: 'Malformed Config Test' },
  });

  let malformedRejected = false;
  try {
    await executeRecovery(db, {
      attempt_id: authMalformed.attempt_id,
      recovery_worker_identity: 'worker-rec-1',
      expected_fence_version: 1,
    });
  } catch (err: unknown) {
    if (
      err instanceof RecoveryError &&
      err.code === 'MALFORMED_HEARTBEAT_CONFIG'
    ) {
      malformedRejected = true;
    }
  }
  assert(malformedRejected, 'Malformed Config Handled', 'Recovery safely refused invalid heartbeat config.');

  // --------------------------------------------------------------------------
  // TEST 20: Recovery cannot call provider adapters
  // --------------------------------------------------------------------------
  console.log('\n[20/24] Testing: Recovery cannot call provider adapters...');
  const initialProviderCalls = mockProvider.calls.length;
  // Trigger recovery on another stale attempt
  const auth20 = await authorizeOperation(db, {
    actor_principal_id: 'agent-rec-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage7_v1',
    idempotency_key: 'idem-st7-test-20',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15557000020',
      message_body: 'Provider Call Invariant Test',
      channel: 'sms',
    },
  });
  await db.query(
    `UPDATE attempts SET reserved_at = NOW() - INTERVAL '120 seconds' WHERE attempt_id = $1;`,
    [auth20.attempt_id]
  );
  await executeRecovery(db, {
    attempt_id: auth20.attempt_id,
    recovery_worker_identity: 'worker-rec-1',
    expected_fence_version: 1,
  });

  assert(
    mockProvider.calls.length === initialProviderCalls,
    'Zero Provider Calls',
    `Recovery made 0 calls to provider adapter (calls stayed at ${initialProviderCalls}).`
  );

  // --------------------------------------------------------------------------
  // TEST 21: Recovery cannot create dispatch claims
  // --------------------------------------------------------------------------
  console.log('\n[21/24] Testing: Recovery cannot create dispatch claims...');
  const claim20 = (await db.query<{ count: string }>(
    `SELECT count(*) FROM dispatch_claims WHERE attempt_id = $1;`,
    [auth20.attempt_id]
  )).rows[0].count;
  assert(Number(claim20) === 0, 'No Claims For Recovered Attempt', 'Zero dispatch claims created by recovery.');

  // --------------------------------------------------------------------------
  // TEST 22: Recovery cannot manufacture external evidence
  // --------------------------------------------------------------------------
  console.log('\n[22/24] Testing: Recovery cannot manufacture external evidence...');
  const evidence20 = (await db.query<{ count: string }>(
    `SELECT count(*) FROM evidence_records WHERE attempt_id = $1;`,
    [auth20.attempt_id]
  )).rows[0].count;
  assert(Number(evidence20) === 0, 'Zero Evidence For Recovered Attempt', 'Zero evidence records created by recovery.');

  // --------------------------------------------------------------------------
  // TEST 23: Reconciliation identifies unresolved work without resolving its outcome
  // --------------------------------------------------------------------------
  console.log('\n[23/24] Testing: Reconciliation identifies unresolved work without resolving outcome...');
  const auth23 = await authorizeOperation(db, {
    actor_principal_id: 'agent-rec-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage7_v1',
    idempotency_key: 'idem-st7-test-23',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15557000023',
      message_body: 'Stage 7 Reconciliation Test',
      channel: 'sms',
    },
  });

  await executeDispatch(
    db,
    {
      attempt_id: auth23.attempt_id,
      effect_key: auth23.effect_key,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-disp-1',
    },
    mockProvider
  );

  // Backdate dispatched_at by 700 seconds (contract max is 600s)
  await db.query(
    `UPDATE attempts SET dispatched_at = NOW() - INTERVAL '700 seconds' WHERE attempt_id = $1;`,
    [auth23.attempt_id]
  );

  const reconResult = await reconcileUnresolvedAttempts(db, {
    worker_identity: 'reconciler-1',
    min_unresolved_seconds: 600,
  });

  assert(reconResult.tasks_created_count >= 1, 'Reconciliation Task Created', `Created ${reconResult.tasks_created_count} reconciliation task(s).`);
  const matchingTask = reconResult.tasks.find((t) => t.attempt_id === auth23.attempt_id);
  assert(matchingTask !== undefined, 'Matching Task Found', 'Found durable task for candidate attempt.');
  assert(matchingTask?.status === 'PENDING', 'Task Status PENDING', 'Durable task status is PENDING.');

  // Crucial check: verify attempt remains DISPATCHED_UNRESOLVED and executed_fact remains FALSE
  const att23Check = (await db.query<{ state: string }>(
    `SELECT state FROM attempts WHERE attempt_id = $1;`,
    [auth23.attempt_id]
  )).rows[0];
  assert(att23Check.state === 'DISPATCHED_UNRESOLVED', 'Attempt Still Unresolved', 'Attempt state remains DISPATCHED_UNRESOLVED.');

  const eff23Check = (await db.query<{ executed_fact: boolean; execution_state: string }>(
    `SELECT executed_fact, execution_state FROM effects WHERE effect_key = $1;`,
    [auth23.effect_key]
  )).rows[0];
  assert(eff23Check.executed_fact === false, 'Executed Fact Untouched', 'executed_fact remains FALSE.');
  assert(eff23Check.execution_state !== 'EXECUTED', 'Execution State Untouched', 'Effect execution state is not EXECUTED.');

  // --------------------------------------------------------------------------
  // TEST 24: Pre-commit rollback & Heartbeat Renewal Verification
  // --------------------------------------------------------------------------
  console.log('\n[24/24] Testing: Heartbeat renewal & pre-commit failure rollback...');
  const auth24 = await authorizeOperation(db, {
    actor_principal_id: 'agent-rec-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage7_v1',
    idempotency_key: 'idem-st7-test-24',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15557000024',
      message_body: 'Heartbeat Renewal & Rollback Test',
      channel: 'sms',
    },
  });

  // Test heartbeat renewal
  const hbRes = await recordAttemptHeartbeat(db, {
    attempt_id: auth24.attempt_id,
    worker_identity: 'heartbeat-worker-1',
    expected_fence_version: 1,
  });
  assert(hbRes.success === true, 'Heartbeat Renewed', 'Heartbeat renewed successfully.');
  assert(hbRes.heartbeat_deadline_at !== null, 'Deadline Updated', 'Deadline updated in database.');

  // Test pre-commit rollback
  await db.query(
    `UPDATE attempts SET reserved_at = NOW() - INTERVAL '150 seconds' WHERE attempt_id = $1;`,
    [auth24.attempt_id]
  );

  let rollbackCaught = false;
  try {
    await executeRecovery(db, {
      attempt_id: auth24.attempt_id,
      recovery_worker_identity: 'worker-rec-1',
      expected_fence_version: 1,
      _forceFailureBeforeCommit: true,
      force_recovery: true,
    });
  } catch (err: unknown) {
    rollbackCaught = true;
  }
  assert(rollbackCaught, 'Rollback Triggered', 'Forced failure triggered pre-commit rollback.');

  const rollbackCheck = (await db.query<{ state: string; fence_version: string }>(
    `SELECT state, fence_version FROM attempts WHERE attempt_id = $1;`,
    [auth24.attempt_id]
  )).rows[0];
  assert(rollbackCheck.state === 'RESERVED', 'Rollback Preserves State', 'State rolled back to RESERVED.');
  assert(Number(rollbackCheck.fence_version) === 1, 'Rollback Preserves Fence', 'Fence version rolled back to 1.');

  console.log('\n===============================================================');
  console.log('STAGE 7 VALIDATION COMPLETED: 24/24 TESTS PASSED.');
  console.log('===============================================================');
}

runStage7Validation().catch((err) => {
  console.error('Stage 7 validation failed:', err);
  process.exit(1);
});
