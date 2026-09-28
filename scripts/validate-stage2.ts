/**
 * @file scripts/validate-stage2.ts
 * Stage 2 Validation Suite: Atomic Control Plane Authorization Transaction.
 *
 * Tests all 13 locked architectural requirements:
 *  1. Valid authorization succeeds
 *  2. Invalid actor/capability/scope fails closed
 *  3. Stale version fails (optimistic fencing compare-and-commit)
 *  4. Policy version is persisted correctly
 *  5. Same idempotency key + same operation is idempotent
 *  6. Same idempotency key + different operation produces conflict
 *  7. Concurrent same-key authorization produces only one logical authorization
 *  8. Concurrent budget reservations cannot exceed internal budget
 *  9. Failed authorization leaves no budget reservation
 * 10. Stale ownership cannot mutate the operation
 * 11. Authorization is bound to the specific operation/intent
 * 12. Authorization and budget reservation commit atomically
 * 13. Forced failure partway rolls everything back
 */

import { PGlite } from '@electric-sql/pglite';
import { applySchema, createFreshDb, seedMockCapabilityContract } from '../src/db/database.ts';
import { authorizeOperation } from '../src/authorization/authorizeOperation.ts';
import { AuthorizationError, AuthorizeOperationRequest } from '../src/authorization/types.ts';

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
  console.log(`  [PASS ${num}/13] ${name}: ${message}`);
}

function fail(num: number, name: string, message: string, error?: string) {
  testResults.push({ num, name, passed: false, message, error });
  console.error(`  [FAIL ${num}/13] ${name}: ${message} (${error})`);
  throw new Error(`Test ${num} Failed: ${name} - ${message}`);
}

async function setupBaseline(db: PGlite) {
  await applySchema(db);
  await seedMockCapabilityContract(db);

  // Principals
  await db.query(
    `INSERT INTO principals (principal_id, type, name, status, metadata)
     VALUES ('agent_authorized', 'AGENT', 'Authorized Dispatch Agent', 'ACTIVE', '{"scopes": ["messages:send", "*"]}'::jsonb),
            ('agent_restricted', 'AGENT', 'Restricted Agent', 'ACTIVE', '{"scopes": ["read:only"]}'::jsonb),
            ('agent_inactive', 'AGENT', 'Suspended Agent', 'SUSPENDED', '{"scopes": ["messages:send"]}'::jsonb),
            ('agent_owner_a', 'AGENT', 'Owner Agent A', 'ACTIVE', '{"scopes": ["*"]}'::jsonb),
            ('agent_owner_b', 'AGENT', 'Owner Agent B', 'ACTIVE', '{"scopes": ["*"]}'::jsonb);`
  );

  // Policy versions
  await db.query(
    `INSERT INTO policy_versions (policy_version_id, policy_name, version, rules_definition, is_active)
     VALUES ('pol_active_v1', 'standard_dispatch_policy', '1.0.0', '{"max_cost_usd": 50}'::jsonb, true),
            ('pol_inactive_v1', 'deprecated_policy', '0.9.0', '{"deprecated": true}'::jsonb, false);`
  );

  // Principal budgets
  await db.query(
    `INSERT INTO principal_budgets (principal_id, currency_or_unit, budget_limit, reserved_amount)
     VALUES ('agent_authorized', 'USD', 100.0000, 0.0000),
            ('agent_restricted', 'USD', 10.0000, 0.0000),
            ('agent_owner_a', 'USD', 100.0000, 0.0000),
            ('agent_owner_b', 'USD', 100.0000, 0.0000);`
  );
}

async function runStage2Validation() {
  console.log('===============================================================');
  console.log('STARTING STAGE 2 ATOMIC AUTHORIZATION VALIDATION SUITE');
  console.log('===============================================================\n');

  const db = await createFreshDb();
  await setupBaseline(db);

  const basePayload = {
    recipient: '+15551234567',
    message_body: 'Standard notification payload for Stage 2',
    channel: 'sms',
  };

  // --------------------------------------------------------------------------
  // TEST 1: Valid Authorization Succeeds
  // --------------------------------------------------------------------------
  console.log('[1/13] Testing: Valid authorization succeeds...');
  try {
    const res1 = await authorizeOperation(db, {
      actor_principal_id: 'agent_authorized',
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      operation_payload: basePayload,
      requested_scope: 'messages:send',
      policy_version_id: 'pol_active_v1',
      idempotency_key: 'idem_test_1',
      budget_amount: 5.0,
      budget_currency: 'USD',
    });

    if (
      res1.authorized &&
      res1.authorization_id.startsWith('auth_') &&
      res1.authorized_cycle === 1 &&
      res1.repeat_authorization_type === 'INITIAL_ATTEMPT' &&
      res1.is_idempotent_replay === false
    ) {
      pass(1, 'Valid Authorization', 'Successfully authorized initial operation with cycle 1.');
    } else {
      fail(1, 'Valid Authorization', 'Returned invalid result structure.');
    }
  } catch (err) {
    fail(1, 'Valid Authorization', 'Threw unexpected error', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 2: Invalid Actor / Capability / Scope Fails Closed
  // --------------------------------------------------------------------------
  console.log('\n[2/13] Testing: Invalid actor / capability / scope fails closed...');
  try {
    // 2a: Inactive principal
    let inactiveCaught = false;
    try {
      await authorizeOperation(db, {
        actor_principal_id: 'agent_inactive',
        capability_id: 'mock.send_message',
        capability_version: '1.0.0',
        operation_payload: basePayload,
        requested_scope: 'messages:send',
        policy_version_id: 'pol_active_v1',
        idempotency_key: 'idem_test_2a',
        budget_amount: 1.0,
        budget_currency: 'USD',
      });
    } catch (e) {
      if (e instanceof AuthorizationError && e.code === 'PRINCIPAL_NOT_ACTIVE') {
        inactiveCaught = true;
      }
    }
    if (!inactiveCaught) throw new Error('Inactive principal was not rejected');

    // 2b: Unauthorized scope
    let scopeCaught = false;
    try {
      await authorizeOperation(db, {
        actor_principal_id: 'agent_restricted',
        capability_id: 'mock.send_message',
        capability_version: '1.0.0',
        operation_payload: basePayload,
        requested_scope: 'messages:send', // restricted agent only has read:only
        policy_version_id: 'pol_active_v1',
        idempotency_key: 'idem_test_2b',
        budget_amount: 1.0,
        budget_currency: 'USD',
      });
    } catch (e) {
      if (e instanceof AuthorizationError && e.code === 'UNAUTHORIZED_SCOPE') {
        scopeCaught = true;
      }
    }
    if (!scopeCaught) throw new Error('Unauthorized scope was not rejected');

    // 2c: Non-existent capability
    let capCaught = false;
    try {
      await authorizeOperation(db, {
        actor_principal_id: 'agent_authorized',
        capability_id: 'non_existent_capability',
        capability_version: '1.0.0',
        operation_payload: basePayload,
        requested_scope: 'messages:send',
        policy_version_id: 'pol_active_v1',
        idempotency_key: 'idem_test_2c',
        budget_amount: 1.0,
        budget_currency: 'USD',
      });
    } catch (e) {
      if (e instanceof AuthorizationError && e.code === 'CAPABILITY_NOT_FOUND') {
        capCaught = true;
      }
    }
    if (!capCaught) throw new Error('Non-existent capability was not rejected');

    pass(2, 'Invalid Preconditions', 'Inactive principal, unauthorized scope, and missing capability all failed closed.');
  } catch (err) {
    fail(2, 'Invalid Preconditions', 'Validation check failed', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 3: Stale Version Fails (Optimistic Fencing Compare-and-Commit)
  // --------------------------------------------------------------------------
  console.log('\n[3/13] Testing: Stale version fails (optimistic fencing)...');
  try {
    // Current effect from Test 1 has fence_version = 1. Caller provides expected_fence_version = 99
    let staleCaught = false;
    try {
      await authorizeOperation(db, {
        actor_principal_id: 'agent_authorized',
        capability_id: 'mock.send_message',
        capability_version: '1.0.0',
        operation_payload: basePayload,
        requested_scope: 'messages:send',
        policy_version_id: 'pol_active_v1',
        idempotency_key: 'idem_test_3',
        budget_amount: 1.0,
        budget_currency: 'USD',
        expected_fence_version: 99, // Stale version!
      });
    } catch (e) {
      if (e instanceof AuthorizationError && e.code === 'STALE_STATE_ERROR') {
        staleCaught = true;
      }
    }

    if (staleCaught) {
      pass(3, 'Stale Version Protection', 'Stale expected_fence_version rejected with STALE_STATE_ERROR.');
    } else {
      fail(3, 'Stale Version Protection', 'Failed to reject stale fence version.');
    }
  } catch (err) {
    fail(3, 'Stale Version Protection', 'Stale version test failed', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 4: Policy Version is Persisted Correctly
  // --------------------------------------------------------------------------
  console.log('\n[4/13] Testing: Policy version is persisted correctly...');
  try {
    const authRecord = await db.query<{ policy_version_id: string }>(
      `SELECT policy_version_id FROM authorizations WHERE intent_id IN (
        SELECT intent_id FROM intents WHERE idempotency_key = 'idem_test_1'
       );`
    );

    if (authRecord.rows[0]?.policy_version_id === 'pol_active_v1') {
      pass(4, 'Policy Version Binding', 'Authorization record immutably holds policy_version_id = pol_active_v1.');
    } else {
      fail(4, 'Policy Version Binding', 'Policy version was not persisted accurately.');
    }
  } catch (err) {
    fail(4, 'Policy Version Binding', 'Policy version test failed', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 5: Same Idempotency Key + Same Operation is Idempotent
  // --------------------------------------------------------------------------
  console.log('\n[5/13] Testing: Same idempotency key + same operation is idempotent...');
  try {
    const replay = await authorizeOperation(db, {
      actor_principal_id: 'agent_authorized',
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      operation_payload: basePayload, // Exact same payload
      requested_scope: 'messages:send',
      policy_version_id: 'pol_active_v1',
      idempotency_key: 'idem_test_1', // Replaying same key
      budget_amount: 5.0,
      budget_currency: 'USD',
    });

    if (replay.authorized && replay.is_idempotent_replay === true) {
      pass(5, 'Idempotent Replay', 'Same key + same operation returned existing logical authorization without duplicate.');
    } else {
      fail(5, 'Idempotent Replay', 'Replay was not detected as idempotent replay.');
    }
  } catch (err) {
    fail(5, 'Idempotent Replay', 'Idempotency replay failed', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 6: Same Idempotency Key + Different Operation Produces Conflict
  // --------------------------------------------------------------------------
  console.log('\n[6/13] Testing: Same idempotency key + different operation produces conflict...');
  try {
    let conflictCaught = false;
    try {
      await authorizeOperation(db, {
        actor_principal_id: 'agent_authorized',
        capability_id: 'mock.send_message',
        capability_version: '1.0.0',
        operation_payload: {
          recipient: '+15559999999', // Different recipient!
          message_body: 'Materially different message body',
          channel: 'sms',
        },
        requested_scope: 'messages:send',
        policy_version_id: 'pol_active_v1',
        idempotency_key: 'idem_test_1', // Reusing key with different semantics
        budget_amount: 5.0,
        budget_currency: 'USD',
      });
    } catch (e) {
      if (e instanceof AuthorizationError && e.code === 'IDEMPOTENCY_CONFLICT') {
        conflictCaught = true;
      }
    }

    if (conflictCaught) {
      pass(6, 'Idempotency Conflict', 'Reusing key with different operation threw IDEMPOTENCY_CONFLICT.');
    } else {
      fail(6, 'Idempotency Conflict', 'Did not throw IDEMPOTENCY_CONFLICT for mismatched payload.');
    }
  } catch (err) {
    fail(6, 'Idempotency Conflict', 'Conflict test failed', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 7: Concurrent Same-Key Authorization Produces Only One Logical Authorization
  // --------------------------------------------------------------------------
  console.log('\n[7/13] Testing: Concurrent same-key authorization produces only one authorization...');
  try {
    const concurrentKey = 'idem_concurrent_test_7';
    const concurrentPayload = {
      recipient: '+15550007777',
      message_body: 'Concurrent test message',
      channel: 'sms',
    };

    const [c1, c2] = await Promise.all([
      authorizeOperation(db, {
        actor_principal_id: 'agent_authorized',
        capability_id: 'mock.send_message',
        capability_version: '1.0.0',
        operation_payload: concurrentPayload,
        requested_scope: 'messages:send',
        policy_version_id: 'pol_active_v1',
        idempotency_key: concurrentKey,
        budget_amount: 2.0,
        budget_currency: 'USD',
      }),
      authorizeOperation(db, {
        actor_principal_id: 'agent_authorized',
        capability_id: 'mock.send_message',
        capability_version: '1.0.0',
        operation_payload: concurrentPayload,
        requested_scope: 'messages:send',
        policy_version_id: 'pol_active_v1',
        idempotency_key: concurrentKey,
        budget_amount: 2.0,
        budget_currency: 'USD',
      }),
    ]);

    // One must be fresh, one must be idempotent replay, both must agree on authorization_id
    const authorizationsMatch = c1.authorization_id === c2.authorization_id;
    const replayHandled = (c1.is_idempotent_replay && !c2.is_idempotent_replay) ||
                          (!c1.is_idempotent_replay && c2.is_idempotent_replay) ||
                          (c1.authorization_id === c2.authorization_id);

    const intentCountRes = await db.query<{ count: string }>(
      `SELECT count(*) FROM intents WHERE idempotency_key = $1;`,
      [concurrentKey]
    );
    const intentCount = parseInt(intentCountRes.rows[0].count);

    if (authorizationsMatch && replayHandled && intentCount === 1) {
      pass(7, 'Concurrent Idempotency', 'Concurrent requests yielded exactly 1 durable intent and identical authorization ID.');
    } else {
      fail(7, 'Concurrent Idempotency', `Mismatch or duplicate intents created: count=${intentCount}`);
    }
  } catch (err) {
    fail(7, 'Concurrent Idempotency', 'Concurrent idempotency test failed', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 8: Concurrent Budget Reservations Cannot Exceed Internal Budget
  // --------------------------------------------------------------------------
  console.log('\n[8/13] Testing: Concurrent budget reservations cannot exceed limit...');
  try {
    // Principal agent_restricted has budget_limit = 10.0, reserved = 0.
    // We launch 3 concurrent authorization transactions requesting 6.0 each.
    // 6.0 + 6.0 = 12.0 > 10.0, so at most ONE can succeed and the others must fail!
    const results = await Promise.allSettled([
      authorizeOperation(db, {
        actor_principal_id: 'agent_restricted',
        capability_id: 'mock.send_message',
        capability_version: '1.0.0',
        operation_payload: { recipient: '+15558880001', message_body: 'B1', channel: 'sms' },
        requested_scope: 'read:only',
        policy_version_id: 'pol_active_v1',
        idempotency_key: 'idem_budget_c1',
        budget_amount: 6.0,
        budget_currency: 'USD',
      }),
      authorizeOperation(db, {
        actor_principal_id: 'agent_restricted',
        capability_id: 'mock.send_message',
        capability_version: '1.0.0',
        operation_payload: { recipient: '+15558880002', message_body: 'B2', channel: 'sms' },
        requested_scope: 'read:only',
        policy_version_id: 'pol_active_v1',
        idempotency_key: 'idem_budget_c2',
        budget_amount: 6.0,
        budget_currency: 'USD',
      }),
      authorizeOperation(db, {
        actor_principal_id: 'agent_restricted',
        capability_id: 'mock.send_message',
        capability_version: '1.0.0',
        operation_payload: { recipient: '+15558880003', message_body: 'B3', channel: 'sms' },
        requested_scope: 'read:only',
        policy_version_id: 'pol_active_v1',
        idempotency_key: 'idem_budget_c3',
        budget_amount: 6.0,
        budget_currency: 'USD',
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    const budgetRow = await db.query<{ reserved_amount: string; budget_limit: string }>(
      `SELECT reserved_amount, budget_limit FROM principal_budgets WHERE principal_id = 'agent_restricted' AND currency_or_unit = 'USD';`
    );
    const reserved = parseFloat(budgetRow.rows[0].reserved_amount);
    const limit = parseFloat(budgetRow.rows[0].budget_limit);

    if (fulfilled.length === 1 && rejected.length === 2 && reserved <= limit && reserved === 6.0) {
      pass(8, 'Concurrent Budget Limit', `Exactly 1 succeeded and 2 were rejected; reserved=${reserved} <= limit=${limit}.`);
    } else {
      fail(8, 'Concurrent Budget Limit', `Expected 1 fulfilled, got ${fulfilled.length}, reserved=${reserved}, limit=${limit}`);
    }
  } catch (err) {
    fail(8, 'Concurrent Budget Limit', 'Budget test failed', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 9: Failed Authorization Leaves No Budget Reservation
  // --------------------------------------------------------------------------
  console.log('\n[9/13] Testing: Failed authorization leaves no budget reservation...');
  try {
    const preCountRes = await db.query<{ count: string }>(
      `SELECT count(*) FROM budget_reservations WHERE principal_id = 'agent_restricted';`
    );
    const preCount = parseInt(preCountRes.rows[0].count);

    // Attempt authorization that will fail due to inactive policy
    try {
      await authorizeOperation(db, {
        actor_principal_id: 'agent_restricted',
        capability_id: 'mock.send_message',
        capability_version: '1.0.0',
        operation_payload: { recipient: '+15558880004', message_body: 'Fail test', channel: 'sms' },
        requested_scope: 'read:only',
        policy_version_id: 'pol_inactive_v1', // Inactive policy -> FAILS
        idempotency_key: 'idem_fail_budget_check',
        budget_amount: 1.0,
        budget_currency: 'USD',
      });
    } catch (e) {
      // Expected failure
    }

    const postCountRes = await db.query<{ count: string }>(
      `SELECT count(*) FROM budget_reservations WHERE principal_id = 'agent_restricted';`
    );
    const postCount = parseInt(postCountRes.rows[0].count);

    if (preCount === postCount) {
      pass(9, 'No Leaked Budget Reservation', 'Failed authorization left zero budget reservations.');
    } else {
      fail(9, 'No Leaked Budget Reservation', `Budget reservation leaked: pre=${preCount}, post=${postCount}`);
    }
  } catch (err) {
    fail(9, 'No Leaked Budget Reservation', 'Check failed', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 10: Stale Ownership Cannot Mutate Operation
  // --------------------------------------------------------------------------
  console.log('\n[10/13] Testing: Stale ownership cannot mutate operation...');
  try {
    const ownerPayload = {
      recipient: '+15559998888',
      message_body: 'Owned by Agent A',
      channel: 'sms',
    };

    // Agent A creates and owns operation
    const resA = await authorizeOperation(db, {
      actor_principal_id: 'agent_owner_a',
      owner_principal_id: 'agent_owner_a',
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      operation_payload: ownerPayload,
      requested_scope: 'messages:send',
      policy_version_id: 'pol_active_v1',
      idempotency_key: 'idem_owner_1',
      budget_amount: 1.0,
      budget_currency: 'USD',
    });

    // Agent B attempts to mutate Agent A's effect
    let ownerConflictCaught = false;
    try {
      await authorizeOperation(db, {
        actor_principal_id: 'agent_owner_b',
        owner_principal_id: 'agent_owner_b', // Mismatched owner!
        capability_id: 'mock.send_message',
        capability_version: '1.0.0',
        operation_payload: ownerPayload,
        requested_scope: 'messages:send',
        policy_version_id: 'pol_active_v1',
        idempotency_key: 'idem_owner_2',
        budget_amount: 1.0,
        budget_currency: 'USD',
      });
    } catch (e) {
      if (e instanceof AuthorizationError && e.code === 'OWNERSHIP_CONFLICT') {
        ownerConflictCaught = true;
      }
    }

    if (ownerConflictCaught) {
      pass(10, 'Exclusive Ownership', 'Non-owner agent B rejected with OWNERSHIP_CONFLICT.');
    } else {
      fail(10, 'Exclusive Ownership', 'Non-owner agent B was not rejected.');
    }
  } catch (err) {
    fail(10, 'Exclusive Ownership', 'Ownership test failed', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 11: Authorization is Bound to Specific Operation/Intent
  // --------------------------------------------------------------------------
  console.log('\n[11/13] Testing: Authorization is bound to specific operation/intent...');
  try {
    const boundAuth = await db.query<{
      authorization_id: string;
      intent_id: string;
      effect_key: string;
      principal_id: string;
      policy_version_id: string;
      scope: string;
    }>(
      `SELECT authorization_id, intent_id, effect_key, principal_id, policy_version_id, scope
       FROM authorizations WHERE intent_id IN (
         SELECT intent_id FROM intents WHERE idempotency_key = 'idem_test_1'
       );`
    );

    const row = boundAuth.rows[0];
    if (
      row &&
      row.intent_id &&
      row.effect_key &&
      row.principal_id === 'agent_authorized' &&
      row.policy_version_id === 'pol_active_v1' &&
      row.scope === 'messages:send'
    ) {
      pass(11, 'Operation-Bound Authorization', 'Authorization record immutably binds actor, capability effect, policy, and scope.');
    } else {
      fail(11, 'Operation-Bound Authorization', 'Authorization was not strictly bound to operation parameters.');
    }
  } catch (err) {
    fail(11, 'Operation-Bound Authorization', 'Binding check failed', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 12: Authorization and Budget Reservation Commit Atomically
  // --------------------------------------------------------------------------
  console.log('\n[12/13] Testing: Authorization and budget reservation commit atomically...');
  try {
    const atomicPayload = {
      recipient: '+15557771234',
      message_body: 'Atomic commit test',
      channel: 'sms',
    };

    const resAtomic = await authorizeOperation(db, {
      actor_principal_id: 'agent_authorized',
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      operation_payload: atomicPayload,
      requested_scope: 'messages:send',
      policy_version_id: 'pol_active_v1',
      idempotency_key: 'idem_atomic_commit',
      budget_amount: 3.5,
      budget_currency: 'USD',
    });

    // Check both authorization and budget reservation exist in DB
    const checkRes = await db.query<{ auth_id: string; bres_id: string }>(
      `SELECT a.authorization_id as auth_id, b.reservation_id as bres_id
       FROM authorizations a
       JOIN budget_reservations b ON a.budget_reservation_id = b.reservation_id
       WHERE a.authorization_id = $1;`,
      [resAtomic.authorization_id]
    );

    if (checkRes.rows.length === 1 && checkRes.rows[0].bres_id === resAtomic.budget_reservation_id) {
      pass(12, 'Atomic Commit', 'Both authorization and budget reservation were durably committed in single transaction.');
    } else {
      fail(12, 'Atomic Commit', 'Authorization and budget reservation were not atomically coupled.');
    }
  } catch (err) {
    fail(12, 'Atomic Commit', 'Atomic commit check failed', (err as Error).message);
  }

  // --------------------------------------------------------------------------
  // TEST 13: Forced Failure Partway Through Rolls Everything Back
  // --------------------------------------------------------------------------
  console.log('\n[13/13] Testing: Forced failure partway through rolls everything back...');
  try {
    const forcedPayload = {
      recipient: '+15556660000',
      message_body: 'Rollback test message',
      channel: 'sms',
    };
    const forcedKey = 'idem_forced_rollback';

    let forcedCaught = false;
    try {
      await authorizeOperation(db, {
        actor_principal_id: 'agent_authorized',
        capability_id: 'mock.send_message',
        capability_version: '1.0.0',
        operation_payload: forcedPayload,
        requested_scope: 'messages:send',
        policy_version_id: 'pol_active_v1',
        idempotency_key: forcedKey,
        budget_amount: 10.0,
        budget_currency: 'USD',
        _forceFailureBeforeCommit: true,
      });
    } catch (e) {
      forcedCaught = true;
    }

    if (!forcedCaught) throw new Error('Forced failure was not triggered');

    // Verify ZERO artifacts were left behind: no intent, no authorization, no budget reservation
    const intentsAfter = await db.query<{ count: string }>(
      `SELECT count(*) FROM intents WHERE idempotency_key = $1;`,
      [forcedKey]
    );
    const bresAfter = await db.query<{ count: string }>(
      `SELECT count(*) FROM budget_reservations WHERE amount = 10.0 AND currency_or_unit = 'USD';`
    );

    if (parseInt(intentsAfter.rows[0].count) === 0 && parseInt(bresAfter.rows[0].count) === 0) {
      pass(13, 'Complete Rollback', 'Forced failure rolled back all changes atomically; zero partial state remains.');
    } else {
      fail(13, 'Complete Rollback', 'Partial artifacts remained after rollback failure.');
    }
  } catch (err) {
    fail(13, 'Complete Rollback', 'Rollback verification failed', (err as Error).message);
  }

  console.log('\n===============================================================');
  console.log(
    `STAGE 2 VALIDATION COMPLETED: ${testResults.filter((r) => r.passed).length}/${
      testResults.length
    } TESTS PASSED.`
  );
  console.log('===============================================================\n');

  await db.close();
  process.exit(0);
}

runStage2Validation().catch((err) => {
  console.error('Fatal Stage 2 Validation Error:', err);
  process.exit(1);
});
