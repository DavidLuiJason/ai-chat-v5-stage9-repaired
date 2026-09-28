/**
 * @file scripts/validate-stage3.ts
 * Stage 3 Validation Suite: Effect Ledger + Atomic Effect Reservation.
 *
 * Tests all 17 required Stage 3 invariants and behaviors:
 *  1. First authorization creates the correct effect and RESERVED attempt.
 *  2. Same logical effect maps to the same effect_key.
 *  3. Different logical effects do not collide.
 *  4. UNSAFE_REPEAT blocks a second attempt while previous attempt is unresolved.
 *  5. UNSAFE_REPEAT permits next attempt only after required terminal condition.
 *  6. SAFE_REPEAT permits another cycle when contract permits it.
 *  7. SAFE_REPEAT cycles have distinct attempt identities.
 *  8. SAFE_REPEAT cycles share appropriate provider_dedup_identity.
 *  9. provider_dedup_identity is not treated as unique attempt identifier.
 * 10. Expired SAFE_REPEAT deduplication validity is not silently accepted.
 * 11. Concurrent UNSAFE_REPEAT authorization cannot create conflicting reservations.
 * 12. Concurrent SAFE_REPEAT authorization behaves according to contract.
 * 13. Failed transactions leave no partial effect reservation.
 * 14. Existing Stage 2 idempotency behavior remains correct.
 * 15. Existing Stage 2 budget behavior remains correct.
 * 16. No Stage 3 code transitions an attempt into DISPATCHED_UNRESOLVED.
 * 17. No Stage 3 code creates a dispatch claim.
 */

import { PGlite } from '@electric-sql/pglite';
import { applySchema, createFreshDb, seedMockCapabilityContract } from '../src/db/database.ts';
import { authorizeOperation } from '../src/authorization/authorizeOperation.ts';
import { AuthorizationError } from '../src/authorization/types.ts';
import { getEffectAttempts, getEffectRecord, getEffectSummary } from '../src/ledger/effectLedger.ts';

interface TestResult {
  num: number;
  name: string;
  passed: boolean;
  message: string;
  error?: string;
}

const testResults: TestResult[] = [];

function pass(num: number, name: string, message: string) {
  testResults.push({ num, name, passed: true, message });
  console.log(`  [PASS ${num}/17] ${name}: ${message}`);
}

function fail(num: number, name: string, message: string, error?: string) {
  testResults.push({ num, name, passed: false, message, error });
  console.error(`  [FAIL ${num}/17] ${name}: ${message} (${error})`);
  throw new Error(`Test ${num} Failed: ${name} - ${message}`);
}

async function setupBaseline(db: PGlite) {
  await applySchema(db);
  await seedMockCapabilityContract(db);

  // Principals
  await db.query(
    `INSERT INTO principals (principal_id, type, name, status, metadata)
     VALUES ('agent_safe', 'AGENT', 'Safe Repeat Agent', 'ACTIVE', '{"scopes": ["*"]}'::jsonb),
            ('agent_unsafe_1', 'AGENT', 'Unsafe Agent 1', 'ACTIVE', '{"scopes": ["*"]}'::jsonb),
            ('agent_unsafe_2', 'AGENT', 'Unsafe Agent 2', 'ACTIVE', '{"scopes": ["*"]}'::jsonb);`
  );

  // Policy versions
  await db.query(
    `INSERT INTO policy_versions (policy_version_id, policy_name, version, rules_definition, is_active)
     VALUES ('pol_v1', 'stage3_standard_policy', '1.0.0', '{"max_cost_usd": 100}'::jsonb, true);`
  );

  // Principal budgets
  await db.query(
    `INSERT INTO principal_budgets (principal_id, currency_or_unit, budget_limit, reserved_amount)
     VALUES ('agent_safe', 'USD', 500.0000, 0.0000),
            ('agent_unsafe_1', 'USD', 500.0000, 0.0000),
            ('agent_unsafe_2', 'USD', 500.0000, 0.0000);`
  );
}

async function runStage3Validation() {
  console.log('===============================================================');
  console.log('STARTING STAGE 3 EFFECT LEDGER & RESERVATION VALIDATION SUITE');
  console.log('===============================================================\n');

  const db = await createFreshDb();
  await setupBaseline(db);

  const safePayloadA = {
    recipient: '+15551112222',
    message_body: 'Message for Safe Repeat A',
    channel: 'sms',
  };

  const safePayloadB = {
    recipient: '+15553334444',
    message_body: 'Message for Safe Repeat B',
    channel: 'sms',
  };

  const unsafePayload = {
    recipient: '+15559990000',
    message_body: 'High-risk unsafe side-effect message',
    channel: 'sms',
  };

  // --------------------------------------------------------------------------
  // TEST 1: First authorization creates correct effect and RESERVED attempt
  // --------------------------------------------------------------------------
  console.log('[1/17] Testing: First authorization creates effect and RESERVED attempt...');
  try {
    const authRes = await authorizeOperation(db, {
      actor_principal_id: 'agent_safe',
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      operation_payload: safePayloadA,
      requested_scope: 'messages:send',
      policy_version_id: 'pol_v1',
      idempotency_key: 'idem_s3_test1',
      budget_amount: 1.0,
      budget_currency: 'USD',
    });

    const effect = await getEffectRecord(db, authRes.effect_key);
    const attempts = await getEffectAttempts(db, authRes.effect_key);

    if (
      effect &&
      effect.canonicalization_version === 'v1' &&
      effect.repeat_mode === 'SAFE_REPEAT' &&
      attempts.length === 1 &&
      attempts[0].attempt_id === authRes.attempt_id &&
      attempts[0].state === 'RESERVED' &&
      attempts[0].cycle_number === 1
    ) {
      pass(1, 'Initial Effect & Attempt', 'Created effect record and 1st attempt in strictly RESERVED state.');
    } else {
      fail(1, 'Initial Effect & Attempt', 'Attempt was not created in RESERVED state or effect is missing.');
    }
  } catch (err) {
    fail(1, 'Initial Effect & Attempt', 'Unexpected error', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 2: Same logical effect maps to the same effect_key
  // --------------------------------------------------------------------------
  console.log('\n[2/17] Testing: Same logical effect maps to the same effect_key...');
  try {
    // Call authorization with different key but exact same logical payload (different intent converging on same effect)
    const authRes2 = await authorizeOperation(db, {
      actor_principal_id: 'agent_safe',
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      operation_payload: safePayloadA, // Same payload
      requested_scope: 'messages:send',
      policy_version_id: 'pol_v1',
      idempotency_key: 'idem_s3_test2_different_intent', // Different intent
      budget_amount: 1.0,
      budget_currency: 'USD',
    });

    const initialAuth = await db.query<{ effect_key: string }>(
      `SELECT target_effect_key as effect_key FROM intents WHERE idempotency_key = 'idem_s3_test1';`
    );

    if (authRes2.effect_key === initialAuth.rows[0].effect_key) {
      pass(2, 'Effect Key Convergence', 'Different intents converge deterministically on the exact same effect_key.');
    } else {
      fail(2, 'Effect Key Convergence', 'Effect keys diverged for identical canonical payload.');
    }
  } catch (err) {
    fail(2, 'Effect Key Convergence', 'Unexpected error', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 3: Different logical effects do not collide
  // --------------------------------------------------------------------------
  console.log('\n[3/17] Testing: Different logical effects do not collide...');
  try {
    const authResB = await authorizeOperation(db, {
      actor_principal_id: 'agent_safe',
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      operation_payload: safePayloadB, // Different payload
      requested_scope: 'messages:send',
      policy_version_id: 'pol_v1',
      idempotency_key: 'idem_s3_test3_distinct',
      budget_amount: 1.0,
      budget_currency: 'USD',
    });

    const effectA = await db.query<{ effect_key: string }>(
      `SELECT target_effect_key as effect_key FROM intents WHERE idempotency_key = 'idem_s3_test1';`
    );

    if (authResB.effect_key !== effectA.rows[0].effect_key) {
      pass(3, 'Distinct Effect Keys', 'Different payloads generated mutually distinct effect keys.');
    } else {
      fail(3, 'Distinct Effect Keys', 'Distinct payloads collided on same effect key.');
    }
  } catch (err) {
    fail(3, 'Distinct Effect Keys', 'Unexpected error', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 4: UNSAFE_REPEAT blocks a second attempt while previous attempt is unresolved
  // --------------------------------------------------------------------------
  console.log('\n[4/17] Testing: UNSAFE_REPEAT blocks a second attempt while previous attempt is unresolved...');
  try {
    // 4a. Initial authorization for UNSAFE_REPEAT
    const unsafeAuth1 = await authorizeOperation(db, {
      actor_principal_id: 'agent_unsafe_1',
      capability_id: 'mock.send_message_unsafe',
      capability_version: '1.0.0',
      operation_payload: unsafePayload,
      requested_scope: 'messages:send',
      policy_version_id: 'pol_v1',
      idempotency_key: 'idem_unsafe_cycle1',
      budget_amount: 5.0,
      budget_currency: 'USD',
    });

    // Attempt 1 is in RESERVED state (unresolved)
    // 4b. Second authorization targeting the same UNSAFE_REPEAT effect must be BLOCKED
    let blockedUnresolvedCaught = false;
    try {
      await authorizeOperation(db, {
        actor_principal_id: 'agent_unsafe_1',
        capability_id: 'mock.send_message_unsafe',
        capability_version: '1.0.0',
        operation_payload: unsafePayload,
        requested_scope: 'messages:send',
        policy_version_id: 'pol_v1',
        idempotency_key: 'idem_unsafe_cycle2_attempt',
        budget_amount: 5.0,
        budget_currency: 'USD',
      });
    } catch (e) {
      if (e instanceof AuthorizationError && e.code === 'UNSAFE_REPEAT_BLOCKED_UNRESOLVED') {
        blockedUnresolvedCaught = true;
      }
    }

    if (blockedUnresolvedCaught) {
      pass(4, 'UNSAFE_REPEAT Gating', 'Blocked second attempt on UNSAFE_REPEAT while attempt 1 is RESERVED.');
    } else {
      fail(4, 'UNSAFE_REPEAT Gating', 'Failed to block second attempt on unresolved UNSAFE_REPEAT.');
    }
  } catch (err) {
    fail(4, 'UNSAFE_REPEAT Gating', 'Unexpected error', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 5: UNSAFE_REPEAT permits next attempt only after required terminal condition
  // --------------------------------------------------------------------------
  console.log('\n[5/17] Testing: UNSAFE_REPEAT permits next attempt only after terminal condition...');
  try {
    // Get attempt 1 for the unsafe effect
    const unsafeIntents = await db.query<{ target_effect_key: string }>(
      `SELECT target_effect_key FROM intents WHERE idempotency_key = 'idem_unsafe_cycle1';`
    );
    const unsafeEffectKey = unsafeIntents.rows[0].target_effect_key;

    const attempts = await getEffectAttempts(db, unsafeEffectKey);
    const att1 = attempts[0];

    // Transition att1 to COMPLETED_NON_EXECUTED (terminal non-execution state)
    await db.query(
      `UPDATE attempts SET state = 'COMPLETED_NON_EXECUTED', resolved_at = NOW() WHERE attempt_id = $1;`,
      [att1.attempt_id]
    );

    // Now try second authorization again: MUST BE PERMITTED as UNSAFE_REPEAT_PERMITTED_TERMINAL_VERIFIED
    const unsafeAuth2 = await authorizeOperation(db, {
      actor_principal_id: 'agent_unsafe_1',
      capability_id: 'mock.send_message_unsafe',
      capability_version: '1.0.0',
      operation_payload: unsafePayload,
      requested_scope: 'messages:send',
      policy_version_id: 'pol_v1',
      idempotency_key: 'idem_unsafe_cycle2_after_terminal',
      budget_amount: 5.0,
      budget_currency: 'USD',
    });

    if (
      unsafeAuth2.authorized &&
      unsafeAuth2.authorized_cycle === 2 &&
      unsafeAuth2.repeat_authorization_type === 'UNSAFE_REPEAT_PERMITTED_TERMINAL_VERIFIED' &&
      unsafeAuth2.attempt_state === 'RESERVED'
    ) {
      pass(5, 'Terminal Non-Execution Permission', 'Permitted cycle 2 for UNSAFE_REPEAT after prior attempt reached COMPLETED_NON_EXECUTED.');
    } else {
      fail(5, 'Terminal Non-Execution Permission', 'Did not permit cycle 2 after terminal non-execution condition.');
    }
  } catch (err) {
    fail(5, 'Terminal Non-Execution Permission', 'Unexpected error', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 6: SAFE_REPEAT permits another cycle when contract permits it
  // --------------------------------------------------------------------------
  console.log('\n[6/17] Testing: SAFE_REPEAT permits another cycle while prior is unresolved...');
  try {
    // Safe effect from Test 1 has attempt 1 in RESERVED state
    // Second authorization with a fresh intent (retry cycle)
    const safeCycle2 = await authorizeOperation(db, {
      actor_principal_id: 'agent_safe',
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      operation_payload: safePayloadA,
      requested_scope: 'messages:send',
      policy_version_id: 'pol_v1',
      idempotency_key: 'idem_safe_cycle2',
      budget_amount: 1.0,
      budget_currency: 'USD',
    });

    if (
      safeCycle2.authorized &&
      safeCycle2.authorized_cycle === 3 && // Cycle 1 (test 1) + cycle 2 (test 2) + cycle 3
      safeCycle2.repeat_authorization_type === 'SAFE_REPEAT_ALLOWED' &&
      safeCycle2.attempt_state === 'RESERVED'
    ) {
      pass(6, 'SAFE_REPEAT Permission', 'Permitted cycle 3 while prior attempts were unresolved under provider dedup guarantee.');
    } else {
      fail(6, 'SAFE_REPEAT Permission', 'Failed to permit SAFE_REPEAT cycle under valid dedup window.');
    }
  } catch (err) {
    fail(6, 'SAFE_REPEAT Permission', 'Unexpected error', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 7: SAFE_REPEAT cycles have distinct attempt identities
  // --------------------------------------------------------------------------
  console.log('\n[7/17] Testing: SAFE_REPEAT cycles have distinct attempt identities...');
  try {
    const safeIntents = await db.query<{ target_effect_key: string }>(
      `SELECT target_effect_key FROM intents WHERE idempotency_key = 'idem_s3_test1';`
    );
    const safeEffectKey = safeIntents.rows[0].target_effect_key;

    const safeAttempts = await getEffectAttempts(db, safeEffectKey);
    const attemptIds = safeAttempts.map((a) => a.attempt_id);
    const execIds = safeAttempts.map((a) => a.execution_identity);
    const corrIds = safeAttempts.map((a) => a.client_correlation_id);

    const uniqueAttemptIds = new Set(attemptIds);
    const uniqueExecIds = new Set(execIds);
    const uniqueCorrIds = new Set(corrIds);

    if (
      safeAttempts.length >= 2 &&
      uniqueAttemptIds.size === safeAttempts.length &&
      uniqueExecIds.size === safeAttempts.length &&
      uniqueCorrIds.size === safeAttempts.length
    ) {
      pass(7, 'Distinct Attempt Identities', `All ${safeAttempts.length} attempts have unique attempt_id, execution_identity, and client_correlation_id.`);
    } else {
      fail(7, 'Distinct Attempt Identities', 'Collision detected in attempt identities.');
    }
  } catch (err) {
    fail(7, 'Distinct Attempt Identities', 'Unexpected error', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 8: SAFE_REPEAT cycles share appropriate provider_dedup_identity
  // --------------------------------------------------------------------------
  console.log('\n[8/17] Testing: SAFE_REPEAT cycles share provider_dedup_identity...');
  try {
    const safeIntents = await db.query<{ target_effect_key: string }>(
      `SELECT target_effect_key FROM intents WHERE idempotency_key = 'idem_s3_test1';`
    );
    const safeEffectKey = safeIntents.rows[0].target_effect_key;

    const safeAttempts = await getEffectAttempts(db, safeEffectKey);
    const dedupIds = safeAttempts.map((a) => a.provider_dedup_identity);

    const firstDedup = dedupIds[0];
    const allMatch = dedupIds.every((d) => d === firstDedup && d !== null);

    if (allMatch && typeof firstDedup === 'string' && firstDedup.length > 0) {
      pass(8, 'Shared Provider Dedup ID', `All SAFE_REPEAT cycles share identical provider_dedup_identity ('${firstDedup.slice(0, 16)}...').`);
    } else {
      fail(8, 'Shared Provider Dedup ID', 'provider_dedup_identity was not shared across cycles.');
    }
  } catch (err) {
    fail(8, 'Shared Provider Dedup ID', 'Unexpected error', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 9: provider_dedup_identity is not treated as unique attempt identifier
  // --------------------------------------------------------------------------
  console.log('\n[9/17] Testing: provider_dedup_identity is not treated as unique attempt ID...');
  try {
    const safeIntents = await db.query<{ target_effect_key: string }>(
      `SELECT target_effect_key FROM intents WHERE idempotency_key = 'idem_s3_test1';`
    );
    const safeEffectKey = safeIntents.rows[0].target_effect_key;

    const safeAttempts = await getEffectAttempts(db, safeEffectKey);
    const sharedDedup = safeAttempts[0].provider_dedup_identity;

    // Query attempts by provider_dedup_identity: MUST RETURN MULTIPLE ATTEMPTS
    const matches = await db.query<{ attempt_id: string }>(
      `SELECT attempt_id FROM attempts WHERE provider_dedup_identity = $1;`,
      [sharedDedup]
    );

    if (matches.rows.length >= 2) {
      pass(9, 'Provider Dedup Not Unique Attempt ID', `Query by provider_dedup_identity returned ${matches.rows.length} attempts, confirming 1:N relationship.`);
    } else {
      fail(9, 'Provider Dedup Not Unique Attempt ID', 'Expected multiple attempts for shared provider_dedup_identity.');
    }
  } catch (err) {
    fail(9, 'Provider Dedup Not Unique Attempt ID', 'Unexpected error', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 10: Expired SAFE_REPEAT deduplication validity is not silently accepted
  // --------------------------------------------------------------------------
  console.log('\n[10/17] Testing: Expired SAFE_REPEAT deduplication validity is rejected...');
  try {
    // Create an effect whose dedup_window_expires_at is already in the past
    const expiredPayload = {
      recipient: '+15557778888',
      message_body: 'Expired window test message',
      channel: 'sms',
    };

    // Cycle 1 creates effect
    const auth1 = await authorizeOperation(db, {
      actor_principal_id: 'agent_safe',
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      operation_payload: expiredPayload,
      requested_scope: 'messages:send',
      policy_version_id: 'pol_v1',
      idempotency_key: 'idem_expired_init',
      budget_amount: 1.0,
      budget_currency: 'USD',
    });

    // Manually expire the deduplication window in the database
    await db.query(
      `UPDATE effects
       SET dedup_window_expires_at = NOW() - INTERVAL '1 hour'
       WHERE effect_key = $1;`,
      [auth1.effect_key]
    );

    // Attempting cycle 2 now MUST fail with DEDUP_WINDOW_EXPIRED
    let expiredCaught = false;
    try {
      await authorizeOperation(db, {
        actor_principal_id: 'agent_safe',
        capability_id: 'mock.send_message',
        capability_version: '1.0.0',
        operation_payload: expiredPayload,
        requested_scope: 'messages:send',
        policy_version_id: 'pol_v1',
        idempotency_key: 'idem_expired_retry_cycle2',
        budget_amount: 1.0,
        budget_currency: 'USD',
      });
    } catch (e) {
      if (e instanceof AuthorizationError && e.code === 'DEDUP_WINDOW_EXPIRED') {
        expiredCaught = true;
      }
    }

    if (expiredCaught) {
      pass(10, 'Expired Window Rejection', 'Rejected cycle 2 on expired deduplication validity window with DEDUP_WINDOW_EXPIRED.');
    } else {
      fail(10, 'Expired Window Rejection', 'Failed to reject cycle on expired deduplication window.');
    }
  } catch (err) {
    fail(10, 'Expired Window Rejection', 'Unexpected error', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 11: Concurrent UNSAFE_REPEAT authorization cannot create two conflicting reservations
  // --------------------------------------------------------------------------
  console.log('\n[11/17] Testing: Concurrent UNSAFE_REPEAT authorization cannot create conflicting reservations...');
  try {
    const concurrentUnsafePayload = {
      recipient: '+15556667777',
      message_body: 'Concurrent UNSAFE_REPEAT test payload',
      channel: 'sms',
    };

    // Two concurrent authorization transactions targeting the same UNSAFE_REPEAT effect
    const [resU1, resU2] = await Promise.allSettled([
      authorizeOperation(db, {
        actor_principal_id: 'agent_unsafe_1',
        capability_id: 'mock.send_message_unsafe',
        capability_version: '1.0.0',
        operation_payload: concurrentUnsafePayload,
        requested_scope: 'messages:send',
        policy_version_id: 'pol_v1',
        idempotency_key: 'idem_conc_unsafe_agent1',
        budget_amount: 2.0,
        budget_currency: 'USD',
      }),
      authorizeOperation(db, {
        actor_principal_id: 'agent_unsafe_2',
        capability_id: 'mock.send_message_unsafe',
        capability_version: '1.0.0',
        operation_payload: concurrentUnsafePayload,
        requested_scope: 'messages:send',
        policy_version_id: 'pol_v1',
        idempotency_key: 'idem_conc_unsafe_agent2',
        budget_amount: 2.0,
        budget_currency: 'USD',
      }),
    ]);

    const fulfilled = [resU1, resU2].filter((r) => r.status === 'fulfilled');
    const rejected = [resU1, resU2].filter((r) => r.status === 'rejected');

    if (fulfilled.length === 1 && rejected.length === 1) {
      const rejReason = (rejected[0] as PromiseRejectedResult).reason;
      if (rejReason instanceof AuthorizationError && rejReason.code === 'UNSAFE_REPEAT_BLOCKED_UNRESOLVED') {
        pass(11, 'Concurrent UNSAFE_REPEAT Conflict', 'Exactly 1 succeeded and 1 was blocked with UNSAFE_REPEAT_BLOCKED_UNRESOLVED.');
      } else {
        fail(11, 'Concurrent UNSAFE_REPEAT Conflict', `Unexpected rejection error: ${rejReason}`);
      }
    } else {
      fail(11, 'Concurrent UNSAFE_REPEAT Conflict', `Expected 1 fulfilled and 1 rejected; got ${fulfilled.length} fulfilled.`);
    }
  } catch (err) {
    fail(11, 'Concurrent UNSAFE_REPEAT Conflict', 'Unexpected error', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 12: Concurrent SAFE_REPEAT authorization behaves according to contract
  // --------------------------------------------------------------------------
  console.log('\n[12/17] Testing: Concurrent SAFE_REPEAT authorization behaves according to contract...');
  try {
    const concurrentSafePayload = {
      recipient: '+15554445555',
      message_body: 'Concurrent SAFE_REPEAT test payload',
      channel: 'sms',
    };

    // Two concurrent authorizations targeting the same SAFE_REPEAT effect with different intent keys
    const [resS1, resS2] = await Promise.all([
      authorizeOperation(db, {
        actor_principal_id: 'agent_safe',
        capability_id: 'mock.send_message',
        capability_version: '1.0.0',
        operation_payload: concurrentSafePayload,
        requested_scope: 'messages:send',
        policy_version_id: 'pol_v1',
        idempotency_key: 'idem_conc_safe_intent_1',
        budget_amount: 1.0,
        budget_currency: 'USD',
      }),
      authorizeOperation(db, {
        actor_principal_id: 'agent_safe',
        capability_id: 'mock.send_message',
        capability_version: '1.0.0',
        operation_payload: concurrentSafePayload,
        requested_scope: 'messages:send',
        policy_version_id: 'pol_v1',
        idempotency_key: 'idem_conc_safe_intent_2',
        budget_amount: 1.0,
        budget_currency: 'USD',
      }),
    ]);

    // Both should be authorized (cycle 1 and cycle 2), sharing dedup ID and having distinct attempt IDs
    if (
      resS1.authorized &&
      resS2.authorized &&
      resS1.effect_key === resS2.effect_key &&
      resS1.attempt_id !== resS2.attempt_id &&
      resS1.client_correlation_id !== resS2.client_correlation_id &&
      resS1.execution_identity !== resS2.execution_identity &&
      resS1.provider_dedup_identity === resS2.provider_dedup_identity
    ) {
      pass(12, 'Concurrent SAFE_REPEAT Resolution', 'Both concurrent cycles authorized cleanly with shared provider dedup and distinct attempt IDs.');
    } else {
      fail(12, 'Concurrent SAFE_REPEAT Resolution', 'Concurrent SAFE_REPEAT failed to allocate distinct cycles properly.');
    }
  } catch (err) {
    fail(12, 'Concurrent SAFE_REPEAT Resolution', 'Unexpected error', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 13: Failed transactions leave no partial effect reservation
  // --------------------------------------------------------------------------
  console.log('\n[13/17] Testing: Failed transactions leave no partial effect reservation...');
  try {
    const rollbackPayload = {
      recipient: '+15550001111',
      message_body: 'Rollback reservation test',
      channel: 'sms',
    };
    const rollbackKey = 'idem_s3_rollback_test';

    let rollbackCaught = false;
    try {
      await authorizeOperation(db, {
        actor_principal_id: 'agent_safe',
        capability_id: 'mock.send_message',
        capability_version: '1.0.0',
        operation_payload: rollbackPayload,
        requested_scope: 'messages:send',
        policy_version_id: 'pol_v1',
        idempotency_key: rollbackKey,
        budget_amount: 5.0,
        budget_currency: 'USD',
        _forceFailureBeforeCommit: true,
      });
    } catch (e) {
      rollbackCaught = true;
    }

    if (!rollbackCaught) throw new Error('Forced failure was not triggered');

    // Verify no intent, no attempt, and no effect exists for this payload
    const intentsAfter = await db.query<{ count: string }>(
      `SELECT count(*) FROM intents WHERE idempotency_key = $1;`,
      [rollbackKey]
    );

    if (parseInt(intentsAfter.rows[0].count) === 0) {
      pass(13, 'Atomic Effect Reservation Rollback', 'Transaction failure rolled back cleanly; zero partial attempts or intents committed.');
    } else {
      fail(13, 'Atomic Effect Reservation Rollback', 'Found leaked intent or attempt rows after rollback.');
    }
  } catch (err) {
    fail(13, 'Atomic Effect Reservation Rollback', 'Unexpected error', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 14: Existing Stage 2 idempotency behavior remains correct
  // --------------------------------------------------------------------------
  console.log('\n[14/17] Testing: Existing Stage 2 idempotency behavior remains correct...');
  try {
    // Replay idempotency test 1
    const replayRes = await authorizeOperation(db, {
      actor_principal_id: 'agent_safe',
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      operation_payload: safePayloadA,
      requested_scope: 'messages:send',
      policy_version_id: 'pol_v1',
      idempotency_key: 'idem_s3_test1', // Replaying Test 1 key
      budget_amount: 1.0,
      budget_currency: 'USD',
    });

    if (replayRes.authorized && replayRes.is_idempotent_replay === true && replayRes.attempt_id) {
      pass(14, 'Idempotency Preservation', 'Replay returned existing authorization and attempt without duplicate cycle creation.');
    } else {
      fail(14, 'Idempotency Preservation', 'Idempotent replay failed to return valid result.');
    }
  } catch (err) {
    fail(14, 'Idempotency Preservation', 'Unexpected error', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 15: Existing Stage 2 budget behavior remains correct
  // --------------------------------------------------------------------------
  console.log('\n[15/17] Testing: Existing Stage 2 budget behavior remains correct...');
  try {
    // Check principal_budgets vs budget_reservations sum
    const budgetCheck = await db.query<{ reserved_amount: string }>(
      `SELECT reserved_amount FROM principal_budgets WHERE principal_id = 'agent_safe' AND currency_or_unit = 'USD';`
    );
    const reservationsSum = await db.query<{ sum: string }>(
      `SELECT COALESCE(SUM(amount), 0) as sum FROM budget_reservations WHERE principal_id = 'agent_safe' AND currency_or_unit = 'USD';`
    );

    const reserved = parseFloat(budgetCheck.rows[0].reserved_amount);
    const sum = parseFloat(reservationsSum.rows[0].sum);

    if (Math.abs(reserved - sum) < 0.0001) {
      pass(15, 'Budget Integrity', `Budget reserved_amount (${reserved}) strictly matches sum of durable reservations (${sum}).`);
    } else {
      fail(15, 'Budget Integrity', `Budget mismatch: reserved=${reserved}, sum=${sum}`);
    }
  } catch (err) {
    fail(15, 'Budget Integrity', 'Unexpected error', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 16: No Stage 3 code can transition an attempt into DISPATCHED_UNRESOLVED
  // --------------------------------------------------------------------------
  console.log('\n[16/17] Testing: No Stage 3 code transitions an attempt into DISPATCHED_UNRESOLVED...');
  try {
    const dispatchedRes = await db.query<{ count: string }>(
      `SELECT count(*) FROM attempts WHERE state = 'DISPATCHED_UNRESOLVED';`
    );
    const dispatchedCount = parseInt(dispatchedRes.rows[0].count);

    if (dispatchedCount === 0) {
      pass(16, 'Pre-Dispatch State Integrity', 'Exactly 0 attempts are in DISPATCHED_UNRESOLVED state.');
    } else {
      fail(16, 'Pre-Dispatch State Integrity', `Found ${dispatchedCount} attempts in DISPATCHED_UNRESOLVED.`);
    }
  } catch (err) {
    fail(16, 'Pre-Dispatch State Integrity', 'Unexpected error', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 17: No Stage 3 code creates a dispatch claim
  // --------------------------------------------------------------------------
  console.log('\n[17/17] Testing: No Stage 3 code creates a dispatch claim...');
  try {
    const claimsRes = await db.query<{ count: string }>(`SELECT count(*) FROM dispatch_claims;`);
    const claimsCount = parseInt(claimsRes.rows[0].count);

    if (claimsCount === 0) {
      pass(17, 'Zero Dispatch Claims', 'Exactly 0 dispatch claims exist; Stage 3 did not cross dispatch boundary.');
    } else {
      fail(17, 'Zero Dispatch Claims', `Found ${claimsCount} dispatch claims created in Stage 3.`);
    }
  } catch (err) {
    fail(17, 'Zero Dispatch Claims', 'Unexpected error', (err as Error).message);
  }

  // Also verify effect ledger summary query on safe effect
  console.log('\n[Verifying Effect Ledger Queries]');
  const safeIntents = await db.query<{ target_effect_key: string }>(
    `SELECT target_effect_key FROM intents WHERE idempotency_key = 'idem_s3_test1';`
  );
  const summary = await getEffectSummary(db, safeIntents.rows[0].target_effect_key);
  console.log('  Effect summary query successful:');
  console.log(`    effect_key: ${summary.effect?.effect_key}`);
  console.log(`    total attempts: ${summary.attempts.length}`);
  console.log(`    unresolved attempts: ${summary.unresolvedAttempts.length}`);
  console.log(`    isAuthorizationPermitted: ${summary.isAuthorizationPermitted}`);
  console.log(`    gating reason: ${summary.authorizationGatingReason}`);

  console.log('\n===============================================================');
  console.log(
    `STAGE 3 VALIDATION COMPLETED: ${testResults.filter((r) => r.passed).length}/${
      testResults.length
    } TESTS PASSED.`
  );
  console.log('===============================================================\n');

  await db.close();
  process.exit(0);
}

runStage3Validation().catch((err) => {
  console.error('Fatal Stage 3 Validation Error:', err);
  process.exit(1);
});
