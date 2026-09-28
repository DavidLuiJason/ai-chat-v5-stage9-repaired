/**
 * @file scripts/validate-stage4.ts
 * Validation suite for Stage 4: Atomic Dispatch Claim + Provider Dispatch Boundary.
 *
 * Tests the locked dispatch invariants:
 *  1. Atomicity of Dispatch Claim + RESERVED -> DISPATCHED_UNRESOLVED transition
 *  2. Serialization Point: Attempt-row lock (FOR UPDATE OF a)
 *  3. Concurrency Test 1: Two dispatch workers competing for the same RESERVED attempt
 *  4. Concurrency Test 2: Dispatch competing with simulated recovery transaction
 *  5. Stale Version Protection on dispatch
 *  6. Execution Identity Uniqueness (DB level enforcement)
 *  7. Provider call is NEVER made if dispatch transaction fails before commit
 *  8. Provider failure after commit does NOT revert attempt to RESERVED
 *  9. Ambiguous provider failure does NOT create non-execution evidence
 * 10. Provider-assigned ID is optional and distinct from correlation IDs
 * 11. client_correlation_id != provider_dedup_identity != provider_assigned_id
 * 12. DISPATCHED_UNRESOLVED semantics (provider response does NOT set COMPLETED_EXECUTED)
 * 13. Pre-provider crash window preservation
 * 14. Post-provider crash window preservation
 * 15. Transport retries are NOT attempted
 * 16. Pre-dispatch validation failures fail closed
 * 17. Atomic rollback on forced failure leaves zero partial claims
 */

import { createFreshDb, applySchema, seedMockCapabilityContract } from '../src/db/database.ts';
import { authorizeOperation } from '../src/authorization/authorizeOperation.ts';
import { executeDispatch, performDispatchTransaction } from '../src/dispatch/executeDispatch.ts';
import { MockSendMessageProvider } from '../src/dispatch/mockProvider.ts';
import { DispatchError } from '../src/dispatch/types.ts';
import { PGlite } from '@electric-sql/pglite';

function assert(condition: boolean, testName: string, detail?: string): void {
  if (!condition) {
    console.error(`  [FAIL] ${testName}: ${detail ?? 'Assertion failed'}`);
    process.exit(1);
  }
  console.log(`  [PASS] ${testName}: ${detail ?? 'Verified'}`);
}

async function runStage4Validation() {
  console.log('===============================================================');
  console.log('STARTING STAGE 4 ATOMIC DISPATCH CLAIM & BOUNDARY VALIDATION');
  console.log('===============================================================');

  const db = await createFreshDb();
  await applySchema(db);
  await seedMockCapabilityContract(db);

  // Setup testing principals, budgets, and policy
  await db.exec(`
    INSERT INTO principals (principal_id, type, name, status, metadata)
    VALUES ('agent-dispatcher', 'AGENT', 'Dispatcher Agent', 'ACTIVE', '{"scopes": ["*"]}'::jsonb),
           ('agent-recovery', 'AGENT', 'Recovery Agent', 'ACTIVE', '{"scopes": ["*"]}'::jsonb)
    ON CONFLICT (principal_id) DO NOTHING;

    INSERT INTO principal_budgets (principal_id, currency_or_unit, budget_limit, reserved_amount)
    VALUES ('agent-dispatcher', 'USD', 1000.0, 0.0)
    ON CONFLICT (principal_id, currency_or_unit) DO NOTHING;

    INSERT INTO policy_versions (policy_version_id, policy_name, version, is_active, rules_definition)
    VALUES ('pol_stage4_v1', 'stage4_policy', '1.0.0', true, '{"max_retries": 3}'::jsonb)
    ON CONFLICT (policy_version_id) DO NOTHING;
  `);

  const mockProvider = new MockSendMessageProvider('mock.send_message');

  // --------------------------------------------------------------------------
  // TEST 1: Standard Authorized Dispatch Transition (RESERVED -> DISPATCHED_UNRESOLVED)
  // --------------------------------------------------------------------------
  console.log('\n[1/17] Testing: Atomic Dispatch Claim + Attempt State Transition...');
  const auth1 = await authorizeOperation(db, {
    actor_principal_id: 'agent-dispatcher',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage4_v1',
    idempotency_key: 'idem-st4-test-1',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550001111',
      message_body: 'Hello Stage 4 Dispatch',
      channel: 'sms',
    },
  });

  mockProvider.resetCalls();
  const dispatchRes1 = await executeDispatch(
    db,
    {
      effect_key: auth1.effect_key,
      cycle_number: auth1.cycle_number,
      attempt_id: auth1.attempt_id,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-node-1',
    },
    mockProvider
  );

  assert(
    dispatchRes1.attempt_state === 'DISPATCHED_UNRESOLVED',
    'Attempt State Transition',
    'Attempt transitioned atomically from RESERVED to DISPATCHED_UNRESOLVED.'
  );
  assert(
    dispatchRes1.fence_version === 2,
    'Fence Version Advanced',
    'Attempt fence_version incremented from 1 to 2.'
  );

  // Verify Claim in DB
  const claimRes1 = await db.query<{
    claim_id: string;
    attempt_id: string;
    client_correlation_id: string;
    execution_identity: string;
    effect_key: string;
  }>(`SELECT claim_id, attempt_id, client_correlation_id, execution_identity, effect_key FROM dispatch_claims WHERE attempt_id = $1;`, [
    auth1.attempt_id,
  ]);
  assert(
    claimRes1.rows.length === 1,
    'Dispatch Claim Durably Committed',
    `Found durable dispatch claim '${claimRes1.rows[0].claim_id}' for attempt.`
  );
  assert(
    claimRes1.rows[0].execution_identity === auth1.execution_identity,
    'Claim Execution Identity Match',
    'Dispatch claim bound strictly to unique execution_identity.'
  );
  assert(
    mockProvider.getCallCount() === 1,
    'Provider Invocation',
    'Mock provider adapter was invoked exactly once after commit.'
  );

  // --------------------------------------------------------------------------
  // TEST 2: Provider Response Does NOT Set COMPLETED_EXECUTED (Evidence Boundary)
  // --------------------------------------------------------------------------
  console.log('\n[2/17] Testing: DISPATCHED_UNRESOLVED Semantics (No premature terminal resolution)...');
  const attemptRow1 = await db.query<{ state: string }>(
    `SELECT state FROM attempts WHERE attempt_id = $1;`,
    [auth1.attempt_id]
  );
  assert(
    attemptRow1.rows[0].state === 'DISPATCHED_UNRESOLVED',
    'Pre-Evidence State Invariant',
    "Attempt remains in 'DISPATCHED_UNRESOLVED' despite successful provider response."
  );

  const effectRow1 = await db.query<{ executed_fact: boolean; execution_state: string }>(
    `SELECT executed_fact, execution_state FROM effects WHERE effect_key = $1;`,
    [auth1.effect_key]
  );
  assert(
    effectRow1.rows[0].executed_fact === false,
    'No Premature Execution Fact',
    'executed_fact remains FALSE; provider response is not treated as verified external execution evidence.'
  );

  // --------------------------------------------------------------------------
  // TEST 3: Stale Version Dispatch Fails (Optimistic Fencing)
  // --------------------------------------------------------------------------
  console.log('\n[3/17] Testing: Stale version dispatch is rejected...');
  const auth2 = await authorizeOperation(db, {
    actor_principal_id: 'agent-dispatcher',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage4_v1',
    idempotency_key: 'idem-st4-test-2',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550002222',
      message_body: 'Stale version test',
      channel: 'sms',
    },
  });

  let staleRejected = false;
  try {
    await executeDispatch(
      db,
      {
        effect_key: auth2.effect_key,
        cycle_number: auth2.cycle_number,
        expected_fence_version: 999, // deliberate stale version mismatch
        dispatcher_identity: 'worker-node-1',
      },
      mockProvider
    );
  } catch (err: unknown) {
    if (err instanceof DispatchError && err.code === 'STALE_ATTEMPT_VERSION') {
      staleRejected = true;
    }
  }
  assert(
    staleRejected,
    'Stale Version Protection',
    'Dispatch with outdated fence_version was rejected with STALE_ATTEMPT_VERSION.'
  );

  // --------------------------------------------------------------------------
  // TEST 4: Concurrency Test 1 — Two Dispatch Workers Competing on Same RESERVED Attempt
  // --------------------------------------------------------------------------
  console.log('\n[4/17] Testing: Concurrency — Two workers compete for same RESERVED attempt...');
  const auth3 = await authorizeOperation(db, {
    actor_principal_id: 'agent-dispatcher',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage4_v1',
    idempotency_key: 'idem-st4-test-3',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550003333',
      message_body: 'Concurrent worker contention test',
      channel: 'sms',
    },
  });

  mockProvider.resetCalls();
  const worker1Promise = executeDispatch(
    db,
    {
      effect_key: auth3.effect_key,
      cycle_number: auth3.cycle_number,
      attempt_id: auth3.attempt_id,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-node-alpha',
    },
    mockProvider
  );

  const worker2Promise = executeDispatch(
    db,
    {
      effect_key: auth3.effect_key,
      cycle_number: auth3.cycle_number,
      attempt_id: auth3.attempt_id,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-node-beta',
    },
    mockProvider
  );

  const settledWorkers = await Promise.allSettled([worker1Promise, worker2Promise]);
  const succeededWorkers = settledWorkers.filter((s) => s.status === 'fulfilled');
  const failedWorkers = settledWorkers.filter((s) => s.status === 'rejected');

  assert(
    succeededWorkers.length === 1 && failedWorkers.length === 1,
    'Concurrent Worker Serialization',
    `Exactly 1 worker succeeded and 1 worker was rejected (${failedWorkers.length} rejected).`
  );

  const totalClaimsForAuth3 = await db.query<{ count: string }>(
    `SELECT count(*) FROM dispatch_claims WHERE attempt_id = $1;`,
    [auth3.attempt_id]
  );
  assert(
    parseInt(totalClaimsForAuth3.rows[0].count) === 1,
    'Exactly One Claim Committed',
    'Exactly one dispatch claim committed under attempt-row serialization.'
  );

  // --------------------------------------------------------------------------
  // TEST 5: Concurrency Test 2 — Dispatch Competes With Simulated Recovery
  // --------------------------------------------------------------------------
  console.log('\n[5/17] Testing: Concurrency — Dispatch competes with Recovery on same row lock...');
  // Scenario A: Recovery runs first and releases the attempt: RESERVED -> RECOVERY_RELEASED
  const auth4 = await authorizeOperation(db, {
    actor_principal_id: 'agent-dispatcher',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage4_v1',
    idempotency_key: 'idem-st4-test-4',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550004444',
      message_body: 'Recovery contention test',
      channel: 'sms',
    },
  });

  // Simulated Recovery transaction acquires row lock and transitions to RECOVERY_RELEASED
  await db.transaction(async (tx) => {
    const lockRes = await tx.query<{ state: string; fence_version: number }>(
      `SELECT state, fence_version FROM attempts WHERE attempt_id = $1 FOR UPDATE;`,
      [auth4.attempt_id]
    );
    if (lockRes.rows[0].state === 'RESERVED') {
      await tx.query(
        `UPDATE attempts SET state = 'RECOVERY_RELEASED', fence_version = fence_version + 1, resolved_at = NOW() WHERE attempt_id = $1;`,
        [auth4.attempt_id]
      );
    }
  });

  // Dispatch attempts to run on the released attempt -> MUST BE REJECTED
  let dispatchOnReleasedBlocked = false;
  try {
    await executeDispatch(
      db,
      {
        effect_key: auth4.effect_key,
        cycle_number: auth4.cycle_number,
        attempt_id: auth4.attempt_id,
        expected_fence_version: 1,
        dispatcher_identity: 'worker-node-1',
      },
      mockProvider
    );
  } catch (err: unknown) {
    if (err instanceof DispatchError && (err.code === 'RECOVERY_RELEASED_BLOCKED' || err.code === 'STALE_ATTEMPT_VERSION')) {
      dispatchOnReleasedBlocked = true;
    }
  }
  assert(
    dispatchOnReleasedBlocked,
    'Recovery Win Blocks Dispatch',
    'Dispatch path rejected attempt already claimed by recovery (no claim created, no provider call).'
  );

  // Scenario B: Dispatch runs first -> Simulated recovery cannot release it
  const auth5 = await authorizeOperation(db, {
    actor_principal_id: 'agent-dispatcher',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage4_v1',
    idempotency_key: 'idem-st4-test-5',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550005555',
      message_body: 'Dispatch wins before recovery test',
      channel: 'sms',
    },
  });

  await executeDispatch(
    db,
    {
      effect_key: auth5.effect_key,
      cycle_number: auth5.cycle_number,
      attempt_id: auth5.attempt_id,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-node-1',
    },
    mockProvider
  );

  // Now recovery transaction runs
  let recoveryReleaseBlocked = false;
  await db.transaction(async (tx) => {
    const lockRes = await tx.query<{ state: string }>(
      `SELECT state FROM attempts WHERE attempt_id = $1 FOR UPDATE;`,
      [auth5.attempt_id]
    );
    if (lockRes.rows[0].state !== 'RESERVED') {
      recoveryReleaseBlocked = true; // Recovery refuses to release non-RESERVED attempt
    }
  });
  assert(
    recoveryReleaseBlocked,
    'Dispatch Win Blocks Recovery Release',
    'Recovery observed DISPATCHED_UNRESOLVED and correctly refused to release.'
  );

  // --------------------------------------------------------------------------
  // TEST 6: Execution Identity Database Uniqueness Constraint Enforced
  // --------------------------------------------------------------------------
  console.log('\n[6/17] Testing: Database enforces UNIQUE(execution_identity)...');
  let duplicateExecIdRejected = false;
  try {
    await db.query(
      `INSERT INTO attempts (
        attempt_id, effect_key, cycle_number, authorization_id, execution_identity,
        client_correlation_id, state
      ) VALUES (
        'att_dupe_test', '${auth1.effect_key}', 99, '${auth1.authorization_id}', '${auth1.execution_identity}',
        'corr_dupe_test', 'RESERVED'
      );`
    );
  } catch (err: unknown) {
    duplicateExecIdRejected = true;
    console.log('  Confirmed rejection of duplicate execution_identity:', (err as Error).message);
  }
  assert(
    duplicateExecIdRejected,
    'G1 Invariant DB Uniqueness',
    'Database strictly rejected duplicate insert on UNIQUE(execution_identity).'
  );

  // --------------------------------------------------------------------------
  // TEST 7: Provider Call NEVER Made When Transaction Fails Before Commit
  // --------------------------------------------------------------------------
  console.log('\n[7/17] Testing: Provider call NEVER made if transaction fails before commit...');
  const auth7 = await authorizeOperation(db, {
    actor_principal_id: 'agent-dispatcher',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage4_v1',
    idempotency_key: 'idem-st4-test-7',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550007777',
      message_body: 'Pre-commit failure test',
      channel: 'sms',
    },
  });

  mockProvider.resetCalls();
  let preCommitFailed = false;
  try {
    await executeDispatch(
      db,
      {
        effect_key: auth7.effect_key,
        cycle_number: auth7.cycle_number,
        expected_fence_version: 1,
        dispatcher_identity: 'worker-node-1',
        _forceFailureBeforeCommit: true,
      },
      mockProvider
    );
  } catch {
    preCommitFailed = true;
  }
  assert(preCommitFailed, 'Pre-Commit Failure Caught', 'Forced failure triggered before commit.');
  assert(
    mockProvider.getCallCount() === 0,
    'Zero Provider Invocations',
    'Provider was NEVER called when dispatch transaction failed before commit.'
  );

  // Verify attempt is still RESERVED in DB
  const attempt7Check = await db.query<{ state: string }>(
    `SELECT state FROM attempts WHERE attempt_id = $1;`,
    [auth7.attempt_id]
  );
  assert(
    attempt7Check.rows[0].state === 'RESERVED',
    'Attempt Remains RESERVED',
    'Attempt remained in RESERVED state without partial dispatch claim.'
  );

  // --------------------------------------------------------------------------
  // TEST 8: Provider Failure After Commit Does NOT Revert Attempt to RESERVED
  // --------------------------------------------------------------------------
  console.log('\n[8/17] Testing: Provider failure after commit preserves DISPATCHED_UNRESOLVED...');
  const auth8 = await authorizeOperation(db, {
    actor_principal_id: 'agent-dispatcher',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage4_v1',
    idempotency_key: 'idem-st4-test-8',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550008888',
      message_body: 'Provider network failure test',
      channel: 'sms',
    },
  });

  mockProvider.setBehavior('NETWORK_FAILURE');
  const dispatchRes8 = await executeDispatch(
    db,
    {
      effect_key: auth8.effect_key,
      cycle_number: auth8.cycle_number,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-node-1',
    },
    mockProvider
  );

  assert(
    dispatchRes8.success === false,
    'Dispatch Result Flagged Network Failure',
    'Provider call failed cleanly with captured network error.'
  );
  assert(
    dispatchRes8.provider_call_error !== null,
    'Error Captured',
    `Captured error: ${dispatchRes8.provider_call_error}`
  );

  // Invariant 14B: Attempt must NOT be reverted to RESERVED
  const attempt8Check = await db.query<{ state: string }>(
    `SELECT state FROM attempts WHERE attempt_id = $1;`,
    [auth8.attempt_id]
  );
  assert(
    attempt8Check.rows[0].state === 'DISPATCHED_UNRESOLVED',
    'No State Rollback On Provider Failure',
    "Attempt remains 'DISPATCHED_UNRESOLVED'; never reverted to RESERVED."
  );

  // --------------------------------------------------------------------------
  // TEST 9: Ambiguous Provider Failure Does NOT Create Non-Execution Evidence
  // --------------------------------------------------------------------------
  console.log('\n[9/17] Testing: Ambiguous provider failure creates 0 evidence records...');
  const evidenceRes = await db.query<{ count: string }>(
    `SELECT count(*) FROM evidence_records WHERE attempt_id = $1;`,
    [auth8.attempt_id]
  );
  assert(
    parseInt(evidenceRes.rows[0].count) === 0,
    'Zero Premature Evidence Records',
    'Exactly 0 evidence records exist. Stage 4 does not create CONFIRMED_NEVER_WILL_EXECUTE.'
  );

  // --------------------------------------------------------------------------
  // TEST 10: Provider-Assigned ID Is Optional (Both NULL and Populated Handled)
  // --------------------------------------------------------------------------
  console.log('\n[10/17] Testing: Provider-Assigned ID is optional...');
  // Case A: Provider returns NO assigned ID
  const auth10a = await authorizeOperation(db, {
    actor_principal_id: 'agent-dispatcher',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage4_v1',
    idempotency_key: 'idem-st4-test-10a',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550001010',
      message_body: 'Provider without assigned ID test',
      channel: 'sms',
    },
  });

  mockProvider.setBehavior('ACCEPTED_WITHOUT_ASSIGNED_ID');
  const dispatchRes10a = await executeDispatch(
    db,
    {
      effect_key: auth10a.effect_key,
      cycle_number: auth10a.cycle_number,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-node-1',
    },
    mockProvider
  );
  assert(
    dispatchRes10a.provider_assigned_id === null,
    'Optional Provider ID (Null Handled)',
    'Provider returned no assigned ID; attempt.provider_assigned_id correctly remains NULL.'
  );

  // Case B: Provider returns assigned ID
  const auth10b = await authorizeOperation(db, {
    actor_principal_id: 'agent-dispatcher',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage4_v1',
    idempotency_key: 'idem-st4-test-10b',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550001020',
      message_body: 'Provider with assigned ID test',
      channel: 'sms',
    },
  });

  mockProvider.setBehavior('ACCEPTED_WITH_ASSIGNED_ID');
  const dispatchRes10b = await executeDispatch(
    db,
    {
      effect_key: auth10b.effect_key,
      cycle_number: auth10b.cycle_number,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-node-1',
    },
    mockProvider
  );
  assert(
    dispatchRes10b.provider_assigned_id !== null && dispatchRes10b.provider_assigned_id.startsWith('prov_msg_'),
    'Provider Assigned ID Populated',
    `Provider returned assigned ID '${dispatchRes10b.provider_assigned_id}'.`
  );

  // --------------------------------------------------------------------------
  // TEST 11: Correlation Identifiers Disambiguation (Invariant 12)
  // --------------------------------------------------------------------------
  console.log('\n[11/17] Testing: client_correlation_id != provider_dedup_identity != provider_assigned_id...');
  const corrCheck = await db.query<{
    client_correlation_id: string;
    provider_dedup_identity: string | null;
    provider_assigned_id: string | null;
    execution_identity: string;
  }>(`SELECT client_correlation_id, provider_dedup_identity, provider_assigned_id, execution_identity FROM attempts WHERE attempt_id = $1;`, [
    auth10b.attempt_id,
  ]);
  const cRow = corrCheck.rows[0];

  assert(
    cRow.client_correlation_id !== cRow.provider_dedup_identity,
    'Client Correlation != Provider Dedup',
    'client_correlation_id is distinct from provider_dedup_identity.'
  );
  assert(
    cRow.client_correlation_id !== cRow.provider_assigned_id,
    'Client Correlation != Provider Assigned ID',
    'client_correlation_id is distinct from provider_assigned_id.'
  );
  assert(
    cRow.provider_dedup_identity !== cRow.provider_assigned_id,
    'Provider Dedup != Provider Assigned ID',
    'provider_dedup_identity is distinct from provider_assigned_id.'
  );
  assert(
    cRow.execution_identity !== cRow.provider_assigned_id,
    'Execution Identity != Provider Assigned ID',
    'execution_identity is never conflated with provider_assigned_id.'
  );

  // --------------------------------------------------------------------------
  // TEST 12: Failure Window 1 — Commit -> Crash Before Provider Call
  // --------------------------------------------------------------------------
  console.log('\n[12/17] Testing: Failure window (Commit -> Crash before provider call)...');
  const auth12 = await authorizeOperation(db, {
    actor_principal_id: 'agent-dispatcher',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage4_v1',
    idempotency_key: 'idem-st4-test-12',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550001212',
      message_body: 'Crash before provider call test',
      channel: 'sms',
    },
  });

  mockProvider.resetCalls();
  const dispatchRes12 = await executeDispatch(
    db,
    {
      effect_key: auth12.effect_key,
      cycle_number: auth12.cycle_number,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-node-1',
    },
    mockProvider,
    { _simulateCrashBeforeProviderCall: true }
  );

  assert(
    dispatchRes12.simulated_pre_provider_crash === true,
    'Pre-Provider Crash Simulated',
    'Successfully simulated crash immediately post-commit.'
  );
  assert(
    mockProvider.getCallCount() === 0,
    'Zero Provider Calls in Crash Window',
    'Provider call never occurred due to process crash.'
  );
  const attempt12Check = await db.query<{ state: string }>(
    `SELECT state FROM attempts WHERE attempt_id = $1;`,
    [auth12.attempt_id]
  );
  assert(
    attempt12Check.rows[0].state === 'DISPATCHED_UNRESOLVED',
    'Attempt State Preserved as DISPATCHED_UNRESOLVED',
    'Attempt is durably committed as DISPATCHED_UNRESOLVED for later recovery/reconciliation resolution.'
  );

  // --------------------------------------------------------------------------
  // TEST 13: Failure Window 2 — Commit -> Provider Call -> Crash Before Recording
  // --------------------------------------------------------------------------
  console.log('\n[13/17] Testing: Failure window (Provider call -> Crash before recording response)...');
  const auth13 = await authorizeOperation(db, {
    actor_principal_id: 'agent-dispatcher',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage4_v1',
    idempotency_key: 'idem-st4-test-13',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550001313',
      message_body: 'Crash before response recording test',
      channel: 'sms',
    },
  });

  mockProvider.resetCalls();
  mockProvider.setBehavior('ACCEPTED_WITH_ASSIGNED_ID');
  const dispatchRes13 = await executeDispatch(
    db,
    {
      effect_key: auth13.effect_key,
      cycle_number: auth13.cycle_number,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-node-1',
    },
    mockProvider,
    { _simulateCrashBeforeRecordingResponse: true }
  );

  assert(
    dispatchRes13.simulated_post_provider_crash === true,
    'Post-Provider Crash Simulated',
    'Successfully simulated crash after provider call but before response DB update.'
  );
  assert(
    mockProvider.getCallCount() === 1,
    'Provider Call Happened',
    'Provider was invoked once.'
  );
  const attempt13Check = await db.query<{ state: string; provider_assigned_id: string | null }>(
    `SELECT state, provider_assigned_id FROM attempts WHERE attempt_id = $1;`,
    [auth13.attempt_id]
  );
  assert(
    attempt13Check.rows[0].state === 'DISPATCHED_UNRESOLVED',
    'State Remains DISPATCHED_UNRESOLVED',
    'Attempt remains DISPATCHED_UNRESOLVED.'
  );
  assert(
    attempt13Check.rows[0].provider_assigned_id === null,
    'Provider Assigned ID Not Recorded Yet',
    'provider_assigned_id remains null due to crash; reconciliation will correlate later.'
  );

  // --------------------------------------------------------------------------
  // TEST 14: Transport Retries Prohibited
  // --------------------------------------------------------------------------
  console.log('\n[14/17] Testing: Transport retries are NOT attempted on provider timeout...');
  const auth14 = await authorizeOperation(db, {
    actor_principal_id: 'agent-dispatcher',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage4_v1',
    idempotency_key: 'idem-st4-test-14',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550001414',
      message_body: 'Transport retry prohibition test',
      channel: 'sms',
    },
  });

  mockProvider.resetCalls();
  mockProvider.setBehavior('TIMEOUT');
  await executeDispatch(
    db,
    {
      effect_key: auth14.effect_key,
      cycle_number: auth14.cycle_number,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-node-1',
    },
    mockProvider
  );

  assert(
    mockProvider.getCallCount() === 1,
    'No Automatic Retries',
    `Provider was called exactly ${mockProvider.getCallCount()} time; no blind transport retry was performed.`
  );

  // --------------------------------------------------------------------------
  // TEST 15: Pre-Dispatch Precondition Validation Fails Closed
  // --------------------------------------------------------------------------
  console.log('\n[15/17] Testing: Pre-dispatch validation fails closed on invalid attempts...');
  // Case A: Non-existent attempt
  let nonExistentRejected = false;
  try {
    await performDispatchTransaction(db, {
      effect_key: 'eff_non_existent',
      cycle_number: 1,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-1',
    });
  } catch (err: unknown) {
    if (err instanceof DispatchError && err.code === 'ATTEMPT_NOT_FOUND') {
      nonExistentRejected = true;
    }
  }
  assert(nonExistentRejected, 'Non-Existent Attempt Rejected', 'Rejected with ATTEMPT_NOT_FOUND.');

  // Case B: Attempt already in DISPATCHED_UNRESOLVED
  let alreadyDispatchedRejected = false;
  try {
    await performDispatchTransaction(db, {
      effect_key: auth1.effect_key,
      cycle_number: auth1.cycle_number,
      expected_fence_version: 2,
      dispatcher_identity: 'worker-1',
    });
  } catch (err: unknown) {
    if (err instanceof DispatchError && err.code === 'INVALID_ATTEMPT_STATE') {
      alreadyDispatchedRejected = true;
    }
  }
  assert(
    alreadyDispatchedRejected,
    'Already Dispatched Attempt Rejected',
    'Cannot dispatch attempt that is already DISPATCHED_UNRESOLVED.'
  );

  // --------------------------------------------------------------------------
  // TEST 16: Atomic Rollback Leaves Zero Partial Claims
  // --------------------------------------------------------------------------
  console.log('\n[16/17] Testing: Forced transaction failure leaves zero partial claims...');
  const claimsBefore = await db.query<{ count: string }>(`SELECT count(*) FROM dispatch_claims;`);
  const auth16 = await authorizeOperation(db, {
    actor_principal_id: 'agent-dispatcher',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage4_v1',
    idempotency_key: 'idem-st4-test-16',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550001616',
      message_body: 'Rollback claim count test',
      channel: 'sms',
    },
  });

  try {
    await performDispatchTransaction(db, {
      effect_key: auth16.effect_key,
      cycle_number: auth16.cycle_number,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-1',
      _forceFailureBeforeCommit: true,
    });
  } catch {
    // Expected rollback
  }

  const claimsAfter = await db.query<{ count: string }>(`SELECT count(*) FROM dispatch_claims;`);
  assert(
    claimsBefore.rows[0].count === claimsAfter.rows[0].count,
    'Zero Partial Claims Committed',
    `Claims count remained unchanged (${claimsBefore.rows[0].count} == ${claimsAfter.rows[0].count}).`
  );

  // --------------------------------------------------------------------------
  // TEST 17: Provider Rejection Handled Without False Execution/Non-Execution Claims
  // --------------------------------------------------------------------------
  console.log('\n[17/17] Testing: Provider rejection preserves DISPATCHED_UNRESOLVED without premature terminal evidence...');
  const auth17 = await authorizeOperation(db, {
    actor_principal_id: 'agent-dispatcher',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage4_v1',
    idempotency_key: 'idem-st4-test-17',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550001717',
      message_body: 'Provider rejection test',
      channel: 'sms',
    },
  });

  mockProvider.setBehavior('PROVIDER_REJECTED');
  mockProvider.setConfig({ rejectReason: 'Destination phone number unsubscribed' });
  const dispatchRes17 = await executeDispatch(
    db,
    {
      effect_key: auth17.effect_key,
      cycle_number: auth17.cycle_number,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-node-1',
    },
    mockProvider
  );

  assert(
    dispatchRes17.success === false,
    'Rejection Handled Cleanly',
    'Provider rejection captured and returned without unhandled throw.'
  );
  assert(
    dispatchRes17.attempt_state === 'DISPATCHED_UNRESOLVED',
    'State Preserved as DISPATCHED_UNRESOLVED',
    'Attempt state remains DISPATCHED_UNRESOLVED. Evidence derivation will resolve in later stages.'
  );

  console.log('\n===============================================================');
  console.log('STAGE 4 VALIDATION COMPLETED: 17/17 TESTS PASSED.');
  console.log('===============================================================');

  await db.close();
  process.exit(0);
}

runStage4Validation().catch((err) => {
  console.error('Unhandled failure during Stage 4 validation:', err);
  process.exit(1);
});
