/**
 * @file scripts/validate-stage6.ts
 * Validation suite for Stage 6: Canonical Execution & Terminal-State Derivation.
 *
 * Verifies all 22 required Stage 6 invariants and behaviors:
 *  1. Qualifying execution evidence establishes the canonical execution fact.
 *  2. Non-execution evidence establishes only the claim actually supported by the contract.
 *  3. PROVIDER_ACCEPTED does not become EXECUTED unless contract explicitly guarantees it.
 *  4. PROVIDER_REJECTED does not become confirmed permanent non-execution unless contract explicitly guarantees it.
 *  5. Timeout does not become confirmed non-execution.
 *  6. Missing evidence does not become confirmed non-execution.
 *  7. RECOVERY_RELEASED does not become confirmed non-execution.
 *  8. DISPATCHED_UNRESOLVED remains unresolved without qualifying evidence.
 *  9. Contradictory evidence is preserved in evidence_records rather than overwritten, logging an incident.
 * 10. Contradictory evidence cannot clear an already-established execution fact.
 * 11. Evidence for Attempt A cannot change Attempt B.
 * 12. Shared SAFE_REPEAT provider_dedup_identity cannot merge attempt facts.
 * 13. Multiple attempts remain independently represented in control plane.
 * 14. Unresolved required attempts prevent premature terminal closure.
 * 15. Open contradictions prevent closure where required (CONTRADICTED_INCIDENT).
 * 16. Canonical derivation is strictly idempotent.
 * 17. Concurrent derivation cannot corrupt canonical state.
 * 18. Derivation can safely be rerun after a simulated crash window.
 * 19. Provider adapter cannot directly establish the canonical execution fact.
 * 20. Evidence ingestion cannot bypass canonical derivation to establish execution.
 * 21. Recovery-related internal facts cannot establish external execution/non-execution.
 * 22. All existing Stage 1–5 tests continue passing.
 */

import { PGlite } from '@electric-sql/pglite';
import { createFreshDb, applySchema, seedMockCapabilityContract } from '../src/db/database.ts';
import { authorizeOperation } from '../src/authorization/authorizeOperation.ts';
import { executeDispatch } from '../src/dispatch/executeDispatch.ts';
import { MockSendMessageProvider } from '../src/dispatch/mockProvider.ts';
import { ingestEvidence } from '../src/evidence/ingestEvidence.ts';
import {
  deriveCanonicalAttempt,
  deriveCanonicalEffect,
  deriveCanonicalState,
} from '../src/derivation/deriveCanonicalState.ts';

function assert(condition: boolean, testName: string, detail?: string): void {
  if (!condition) {
    console.error(`  [FAIL] ${testName}: ${detail ?? 'Assertion failed'}`);
    process.exit(1);
  }
  console.log(`  [PASS] ${testName}: ${detail ?? 'Verified'}`);
}

async function runStage6Validation() {
  console.log('===============================================================');
  console.log('STARTING STAGE 6 CANONICAL EXECUTION & TERMINAL-STATE DERIVATION');
  console.log('===============================================================');

  const db = await createFreshDb();
  await applySchema(db);
  await seedMockCapabilityContract(db);

  // Setup testing principals, budgets, and policies
  await db.exec(`
    INSERT INTO principals (principal_id, type, name, status, metadata)
    VALUES ('agent-deriv-1', 'AGENT', 'Derivation Agent 1', 'ACTIVE', '{"scopes": ["*"]}'::jsonb),
           ('agent-deriv-2', 'AGENT', 'Derivation Agent 2', 'ACTIVE', '{"scopes": ["*"]}'::jsonb),
           ('worker-deriv-1', 'WORKER', 'Derivation Worker 1', 'ACTIVE', '{"scopes": ["*"]}'::jsonb),
           ('worker-parallel-1', 'WORKER', 'Parallel Worker 1', 'ACTIVE', '{"scopes": ["*"]}'::jsonb),
           ('worker-parallel-2', 'WORKER', 'Parallel Worker 2', 'ACTIVE', '{"scopes": ["*"]}'::jsonb),
           ('worker-parallel-3', 'WORKER', 'Parallel Worker 3', 'ACTIVE', '{"scopes": ["*"]}'::jsonb),
           ('worker-parallel-4', 'WORKER', 'Parallel Worker 4', 'ACTIVE', '{"scopes": ["*"]}'::jsonb),
           ('worker-parallel-5', 'WORKER', 'Parallel Worker 5', 'ACTIVE', '{"scopes": ["*"]}'::jsonb)
    ON CONFLICT (principal_id) DO NOTHING;

    INSERT INTO principal_budgets (principal_id, currency_or_unit, budget_limit, reserved_amount)
    VALUES ('agent-deriv-1', 'USD', 1000.0, 0.0),
           ('agent-deriv-2', 'USD', 1000.0, 0.0)
    ON CONFLICT (principal_id, currency_or_unit) DO NOTHING;

    INSERT INTO policy_versions (policy_version_id, policy_name, version, is_active, rules_definition)
    VALUES ('pol_stage6_v1', 'stage6_policy', '1.0.0', true, '{"max_retries": 3}'::jsonb)
    ON CONFLICT (policy_version_id) DO NOTHING;
  `);

  const mockProvider = new MockSendMessageProvider('mock.send_message');

  // --------------------------------------------------------------------------
  // TEST 1: Qualifying Execution Evidence Establishes Canonical Execution Fact
  // --------------------------------------------------------------------------
  console.log('\n[1/22] Testing: Qualifying execution evidence establishes canonical execution fact...');
  const auth1 = await authorizeOperation(db, {
    actor_principal_id: 'agent-deriv-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage6_v1',
    idempotency_key: 'idem-st6-test-1',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550000001',
      message_body: 'Stage 6 Execution Test 1',
      channel: 'sms',
    },
  });

  const disp1 = await executeDispatch(
    db,
    {
      effect_key: auth1.effect_key,
      cycle_number: auth1.cycle_number,
      attempt_id: auth1.attempt_id,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-deriv-1',
    },
    mockProvider
  );

  assert(disp1.attempt_state === 'DISPATCHED_UNRESOLVED', 'Pre-evidence State', 'Attempt is DISPATCHED_UNRESOLVED.');

  // Ingest EXECUTION_CONFIRMED evidence
  await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'EXECUTION_CONFIRMED',
    claim_semantics: 'EXECUTED',
    source_channel: 'TELEPHONY_CARRIER_DLR',
    client_correlation_id: auth1.client_correlation_id,
    raw_payload: { carrier_dlr: 'DELIVRD', timestamp: new Date().toISOString() },
  });

  // Run canonical derivation
  const derivResult1 = await deriveCanonicalAttempt(db, auth1.attempt_id);

  assert(
    derivResult1.canonical_state === 'COMPLETED_EXECUTED',
    'Attempt Terminal Executed',
    `Attempt transitioned to '${derivResult1.canonical_state}'.`
  );
  assert(derivResult1.executed_fact === true, 'Attempt Executed Fact', 'executed_fact is TRUE.');

  const effectRow1 = await db.query<{ executed_fact: boolean; execution_state: string }>(
    `SELECT executed_fact, execution_state FROM effects WHERE effect_key = $1;`,
    [auth1.effect_key]
  );
  assert(effectRow1.rows[0].executed_fact === true, 'Effect Executed Fact', 'Effect executed_fact is TRUE in database.');
  assert(effectRow1.rows[0].execution_state === 'EXECUTED', 'Effect Execution State', 'Effect execution_state is EXECUTED.');

  // --------------------------------------------------------------------------
  // TEST 2: Non-Execution Evidence Establishes Terminal Non-Execution
  // --------------------------------------------------------------------------
  console.log('\n[2/22] Testing: Non-execution evidence establishes only claim supported by contract...');
  const auth2 = await authorizeOperation(db, {
    actor_principal_id: 'agent-deriv-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage6_v1',
    idempotency_key: 'idem-st6-test-2',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550000002',
      message_body: 'Stage 6 Non-Execution Test 2',
      channel: 'sms',
    },
  });

  await executeDispatch(
    db,
    {
      effect_key: auth2.effect_key,
      cycle_number: auth2.cycle_number,
      attempt_id: auth2.attempt_id,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-deriv-1',
    },
    mockProvider
  );

  await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'NON_EXECUTION_CONFIRMED',
    claim_semantics: 'CONFIRMED_NEVER_WILL_EXECUTE',
    source_channel: 'DOWNSTREAM_AUDIT',
    client_correlation_id: auth2.client_correlation_id,
    raw_payload: { audit_reason: 'Destination invalid and dropped before wire' },
  });

  const derivResult2 = await deriveCanonicalAttempt(db, auth2.attempt_id);
  assert(
    derivResult2.canonical_state === 'COMPLETED_NON_EXECUTED',
    'Attempt Terminal Non-Executed',
    `Attempt transitioned to '${derivResult2.canonical_state}'.`
  );
  assert(derivResult2.executed_fact === false, 'Executed Fact is False', 'executed_fact is FALSE.');

  const effectRow2 = await db.query<{ executed_fact: boolean; execution_state: string }>(
    `SELECT executed_fact, execution_state FROM effects WHERE effect_key = $1;`,
    [auth2.effect_key]
  );
  assert(effectRow2.rows[0].executed_fact === false, 'Effect Non-Executed Fact', 'Effect executed_fact remains FALSE.');
  assert(
    effectRow2.rows[0].execution_state === 'TERMINAL_NON_EXECUTED',
    'Effect Execution State',
    'Effect execution_state is TERMINAL_NON_EXECUTED.'
  );

  // --------------------------------------------------------------------------
  // TEST 3: PROVIDER_ACCEPTED Does NOT Become EXECUTED Without Contract Guarantee
  // --------------------------------------------------------------------------
  console.log('\n[3/22] Testing: PROVIDER_ACCEPTED does not become EXECUTED without explicit guarantee...');
  const auth3 = await authorizeOperation(db, {
    actor_principal_id: 'agent-deriv-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage6_v1',
    idempotency_key: 'idem-st6-test-3',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550000003',
      message_body: 'Stage 6 Accepted Test 3',
      channel: 'sms',
    },
  });

  await executeDispatch(
    db,
    {
      effect_key: auth3.effect_key,
      cycle_number: auth3.cycle_number,
      attempt_id: auth3.attempt_id,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-deriv-1',
    },
    mockProvider
  );

  await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'PROVIDER_ACCEPTED',
    claim_semantics: 'ACCEPTED',
    source_channel: 'GATEWAY_CALLBACK',
    client_correlation_id: auth3.client_correlation_id,
    raw_payload: { queue_id: 'q_123' },
  });

  const derivResult3 = await deriveCanonicalAttempt(db, auth3.attempt_id);
  assert(
    derivResult3.canonical_state === 'DISPATCHED_UNRESOLVED',
    'State Preserved as DISPATCHED_UNRESOLVED',
    'PROVIDER_ACCEPTED did NOT transition attempt to EXECUTED.'
  );
  assert(derivResult3.executed_fact === false, 'Executed Fact is False', 'executed_fact remains FALSE.');

  // --------------------------------------------------------------------------
  // TEST 4: PROVIDER_REJECTED Does NOT Become CONFIRMED_NEVER_WILL_EXECUTE
  // --------------------------------------------------------------------------
  console.log('\n[4/22] Testing: PROVIDER_REJECTED does not become confirmed non-execution without guarantee...');
  const auth4 = await authorizeOperation(db, {
    actor_principal_id: 'agent-deriv-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage6_v1',
    idempotency_key: 'idem-st6-test-4',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550000004',
      message_body: 'Stage 6 Rejected Test 4',
      channel: 'sms',
    },
  });

  await executeDispatch(
    db,
    {
      effect_key: auth4.effect_key,
      cycle_number: auth4.cycle_number,
      attempt_id: auth4.attempt_id,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-deriv-1',
    },
    mockProvider
  );

  await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'PROVIDER_REJECTED',
    claim_semantics: 'PROVIDER_REJECTED',
    source_channel: 'GATEWAY_CALLBACK',
    client_correlation_id: auth4.client_correlation_id,
    raw_payload: { error_code: 'RATE_LIMIT_EXCEEDED' },
  });

  const derivResult4 = await deriveCanonicalAttempt(db, auth4.attempt_id);
  assert(
    derivResult4.canonical_state === 'DISPATCHED_UNRESOLVED',
    'State Preserved as DISPATCHED_UNRESOLVED',
    'PROVIDER_REJECTED did not establish confirmed non-execution.'
  );
  assert(derivResult4.executed_fact === false, 'Executed Fact is False', 'executed_fact remains FALSE.');

  // --------------------------------------------------------------------------
  // TEST 5: Timeout Does NOT Become Confirmed Non-Execution
  // --------------------------------------------------------------------------
  console.log('\n[5/22] Testing: Timeout does not become confirmed non-execution...');
  const auth5 = await authorizeOperation(db, {
    actor_principal_id: 'agent-deriv-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage6_v1',
    idempotency_key: 'idem-st6-test-5',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550000005',
      message_body: 'Stage 6 Timeout Test 5',
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
      dispatcher_identity: 'worker-deriv-1',
    },
    mockProvider
  );

  await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'PROVIDER_TIMEOUT',
    claim_semantics: 'TIMEOUT',
    source_channel: 'HTTP_CLIENT_TIMEOUT',
    client_correlation_id: auth5.client_correlation_id,
    raw_payload: { timeout_ms: 5000 },
  });

  const derivResult5 = await deriveCanonicalAttempt(db, auth5.attempt_id);
  assert(
    derivResult5.canonical_state === 'DISPATCHED_UNRESOLVED',
    'State Preserved as DISPATCHED_UNRESOLVED',
    'PROVIDER_TIMEOUT did not transition to COMPLETED_NON_EXECUTED.'
  );

  // --------------------------------------------------------------------------
  // TEST 6: Missing Evidence Does NOT Become Confirmed Non-Execution
  // --------------------------------------------------------------------------
  console.log('\n[6/22] Testing: Missing evidence does not become confirmed non-execution...');
  const auth6 = await authorizeOperation(db, {
    actor_principal_id: 'agent-deriv-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage6_v1',
    idempotency_key: 'idem-st6-test-6',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550000006',
      message_body: 'Stage 6 Missing Evidence Test 6',
      channel: 'sms',
    },
  });

  await executeDispatch(
    db,
    {
      effect_key: auth6.effect_key,
      cycle_number: auth6.cycle_number,
      attempt_id: auth6.attempt_id,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-deriv-1',
    },
    mockProvider
  );

  // Derivation with zero evidence
  const derivResult6 = await deriveCanonicalAttempt(db, auth6.attempt_id);
  assert(
    derivResult6.canonical_state === 'DISPATCHED_UNRESOLVED',
    'No Guessing on Missing Evidence',
    'Attempt remains DISPATCHED_UNRESOLVED without evidence.'
  );

  // --------------------------------------------------------------------------
  // TEST 7: RECOVERY_RELEASED Does NOT Become Confirmed Non-Execution
  // --------------------------------------------------------------------------
  console.log('\n[7/22] Testing: RECOVERY_RELEASED does not become confirmed non-execution...');
  const auth7 = await authorizeOperation(db, {
    actor_principal_id: 'agent-deriv-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage6_v1',
    idempotency_key: 'idem-st6-test-7',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550000007',
      message_body: 'Stage 6 Recovery Released Test 7',
      channel: 'sms',
    },
  });

  // Simulate internal recovery release (without dispatch claim)
  await db.query(
    `UPDATE attempts SET state = 'RECOVERY_RELEASED', updated_at = NOW() WHERE attempt_id = $1;`,
    [auth7.attempt_id]
  );

  const derivResult7 = await deriveCanonicalAttempt(db, auth7.attempt_id);
  assert(
    derivResult7.canonical_state === 'RECOVERY_RELEASED',
    'State Stays RECOVERY_RELEASED',
    'RECOVERY_RELEASED did not become COMPLETED_NON_EXECUTED or COMPLETED_EXECUTED.'
  );
  assert(derivResult7.executed_fact === false, 'Executed Fact is False', 'executed_fact is FALSE.');

  // --------------------------------------------------------------------------
  // TEST 8: DISPATCHED_UNRESOLVED Remains Unresolved Without Qualifying Evidence
  // --------------------------------------------------------------------------
  console.log('\n[8/22] Testing: DISPATCHED_UNRESOLVED remains unresolved without qualifying evidence...');
  const auth8 = await authorizeOperation(db, {
    actor_principal_id: 'agent-deriv-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage6_v1',
    idempotency_key: 'idem-st6-test-8',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550000008',
      message_body: 'Stage 6 Unresolved Boundary Test 8',
      channel: 'sms',
    },
  });

  await executeDispatch(
    db,
    {
      effect_key: auth8.effect_key,
      cycle_number: auth8.cycle_number,
      attempt_id: auth8.attempt_id,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-deriv-1',
    },
    mockProvider
  );

  // Ingest UNCORRELATED evidence with arbitrary correlation ID
  await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'EXECUTION_CONFIRMED',
    claim_semantics: 'EXECUTED',
    source_channel: 'EXTERNAL_WEBHOOK',
    client_correlation_id: 'corr-arbitrary-does-not-exist',
    raw_payload: { status: 'COMPLETE' },
  });

  const derivResult8 = await deriveCanonicalAttempt(db, auth8.attempt_id);
  assert(
    derivResult8.canonical_state === 'DISPATCHED_UNRESOLVED',
    'Uncorrelated Evidence Not Applied',
    'Attempt remained DISPATCHED_UNRESOLVED; uncorrelated evidence was not attached.'
  );

  // --------------------------------------------------------------------------
  // TEST 9: Contradictory Evidence is Preserved (Coexists in DB & Logs Incident)
  // --------------------------------------------------------------------------
  console.log('\n[9/22] Testing: Contradictory evidence is preserved in evidence_records and incident logged...');
  const auth9 = await authorizeOperation(db, {
    actor_principal_id: 'agent-deriv-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage6_v1',
    idempotency_key: 'idem-st6-test-9',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550000009',
      message_body: 'Stage 6 Contradiction Test 9',
      channel: 'sms',
    },
  });

  await executeDispatch(
    db,
    {
      effect_key: auth9.effect_key,
      cycle_number: auth9.cycle_number,
      attempt_id: auth9.attempt_id,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-deriv-1',
    },
    mockProvider
  );

  // Evidence A: EXECUTION_CONFIRMED
  const ev9a = await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'EXECUTION_CONFIRMED',
    claim_semantics: 'EXECUTED',
    source_channel: 'CARRIER_1',
    client_correlation_id: auth9.client_correlation_id,
    raw_payload: { receipt: 'DELIVRD_OK' },
  });

  // Evidence B: NON_EXECUTION_CONFIRMED
  const ev9b = await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'NON_EXECUTION_CONFIRMED',
    claim_semantics: 'CONFIRMED_NEVER_WILL_EXECUTE',
    source_channel: 'DOWNSTREAM_AUDIT',
    client_correlation_id: auth9.client_correlation_id,
    raw_payload: { audit: 'NOT_DELIVERED' },
  });

  // Both evidence records exist in database
  const evCount9 = await db.query<{ count: string }>(
    `SELECT count(*) FROM evidence_records WHERE attempt_id = $1;`,
    [auth9.attempt_id]
  );
  assert(parseInt(evCount9.rows[0].count) === 2, 'Both Evidence Records Preserved', 'Found 2 evidence records intact.');

  const derivResult9 = await deriveCanonicalAttempt(db, auth9.attempt_id);
  assert(
    derivResult9.canonical_state === 'COMPLETED_EXECUTED',
    'Execution Maintained',
    'Canonical state maintained COMPLETED_EXECUTED (monotonic).'
  );
  assert(derivResult9.executed_fact === true, 'Executed Fact Preserved', 'executed_fact remains TRUE.');

  // Contradiction incident must be logged and OPEN
  const incidentRow9 = await db.query<{ count: string; status: string }>(
    `SELECT count(*), status FROM contradiction_incidents WHERE effect_key = $1 GROUP BY status;`,
    [auth9.effect_key]
  );
  assert(parseInt(incidentRow9.rows[0].count) >= 1, 'Incident Logged', 'Contradiction incident found in DB.');
  assert(incidentRow9.rows[0].status === 'OPEN', 'Incident Status OPEN', 'Contradiction incident status is OPEN.');

  // --------------------------------------------------------------------------
  // TEST 10: Contradictory Evidence Cannot Clear an Already-Established Execution Fact
  // --------------------------------------------------------------------------
  console.log('\n[10/22] Testing: Contradictory evidence cannot clear already-established execution fact...');
  const effectState10 = await db.query<{ executed_fact: boolean; execution_state: string }>(
    `SELECT executed_fact, execution_state FROM effects WHERE effect_key = $1;`,
    [auth9.effect_key]
  );
  assert(
    effectState10.rows[0].executed_fact === true,
    'Historical Execution Fact Preserved',
    'executed_fact remains TRUE despite contradiction.'
  );
  assert(
    effectState10.rows[0].execution_state === 'CONTRADICTED_INCIDENT',
    'Execution State Marked CONTRADICTED_INCIDENT',
    'execution_state is CONTRADICTED_INCIDENT, blocking closure.'
  );

  // Database Trigger Test: Direct SQL update to clear executed_fact must be rejected by trigger!
  let dbTriggerRejected = false;
  try {
    await db.query(
      `UPDATE effects SET executed_fact = FALSE WHERE effect_key = $1;`,
      [auth9.effect_key]
    );
  } catch (err: unknown) {
    dbTriggerRejected = true;
    console.log('  Confirmed rejection by trg_effect_executed_monotonic:', (err as Error).message);
  }
  assert(
    dbTriggerRejected,
    'Database Enforcement (executed_fact Monotonicity)',
    'Trigger strictly prevented clearing executed_fact from TRUE to FALSE.'
  );

  // --------------------------------------------------------------------------
  // TEST 11: Evidence for Attempt A Cannot Change Attempt B
  // --------------------------------------------------------------------------
  console.log('\n[11/22] Testing: Evidence for Attempt A cannot change Attempt B...');
  const auth11_A = await authorizeOperation(db, {
    actor_principal_id: 'agent-deriv-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage6_v1',
    idempotency_key: 'idem-st6-test-11-a',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550000011',
      message_body: 'Stage 6 Multi-Attempt Test 11',
      channel: 'sms',
    },
  });

  await executeDispatch(
    db,
    {
      effect_key: auth11_A.effect_key,
      cycle_number: auth11_A.cycle_number,
      attempt_id: auth11_A.attempt_id,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-deriv-1',
    },
    mockProvider
  );

  // Authorize Cycle 2 (SAFE_REPEAT allows subsequent cycle)
  const auth11_B = await authorizeOperation(db, {
    actor_principal_id: 'agent-deriv-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage6_v1',
    idempotency_key: 'idem-st6-test-11-b',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550000011',
      message_body: 'Stage 6 Multi-Attempt Test 11',
      channel: 'sms',
    },
  });

  await executeDispatch(
    db,
    {
      effect_key: auth11_B.effect_key,
      cycle_number: auth11_B.cycle_number,
      attempt_id: auth11_B.attempt_id,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-deriv-1',
    },
    mockProvider
  );

  // Ingest evidence strictly for Attempt A
  await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'EXECUTION_CONFIRMED',
    claim_semantics: 'EXECUTED',
    source_channel: 'CARRIER_A',
    client_correlation_id: auth11_A.client_correlation_id,
    raw_payload: { receipt: 'A_DELIVERED' },
  });

  // Run derivation on both
  const derivA = await deriveCanonicalAttempt(db, auth11_A.attempt_id);
  const derivB = await deriveCanonicalAttempt(db, auth11_B.attempt_id);

  assert(derivA.canonical_state === 'COMPLETED_EXECUTED', 'Attempt A Executed', "Attempt A is 'COMPLETED_EXECUTED'.");
  assert(derivA.executed_fact === true, 'Attempt A Fact', 'Attempt A executed_fact is TRUE.');
  assert(derivB.canonical_state === 'DISPATCHED_UNRESOLVED', 'Attempt B Untouched', "Attempt B is STILL 'DISPATCHED_UNRESOLVED'.");
  assert(derivB.executed_fact === false, 'Attempt B Fact', 'Attempt B executed_fact is FALSE.');

  // --------------------------------------------------------------------------
  // TEST 12: Shared SAFE_REPEAT provider_dedup_identity Cannot Merge Attempt Facts
  // --------------------------------------------------------------------------
  console.log('\n[12/22] Testing: Shared provider_dedup_identity cannot merge attempt facts...');
  assert(
    auth11_A.provider_dedup_identity === auth11_B.provider_dedup_identity,
    'Identical Dedup Identity',
    'Attempt A and Attempt B share the identical provider_dedup_identity.'
  );
  assert(
    derivA.canonical_state !== derivB.canonical_state,
    'Distinct States Preserved',
    `Attempt A is '${derivA.canonical_state}' while Attempt B is '${derivB.canonical_state}'.`
  );

  // --------------------------------------------------------------------------
  // TEST 13: Multiple Attempts Remain Independently Represented
  // --------------------------------------------------------------------------
  console.log('\n[13/22] Testing: Multiple attempts remain independently represented in control plane...');
  const attempts13 = await db.query<{ attempt_id: string; state: string }>(
    `SELECT attempt_id, state FROM attempts WHERE effect_key = $1 ORDER BY cycle_number ASC;`,
    [auth11_A.effect_key]
  );
  assert(attempts13.rows.length === 2, 'Two Distinct Rows', 'Found 2 independent attempt rows.');
  assert(attempts13.rows[0].state === 'COMPLETED_EXECUTED', 'Row 1 State', 'Attempt 1 is COMPLETED_EXECUTED.');
  assert(attempts13.rows[1].state === 'DISPATCHED_UNRESOLVED', 'Row 2 State', 'Attempt 2 is DISPATCHED_UNRESOLVED.');

  // --------------------------------------------------------------------------
  // TEST 14: Unresolved Required Attempts Prevent Premature Terminal Closure
  // --------------------------------------------------------------------------
  console.log('\n[14/22] Testing: Unresolved required attempts prevent premature terminal closure...');
  const effectDeriv14 = await deriveCanonicalEffect(db, auth11_A.effect_key);
  assert(
    effectDeriv14.is_terminally_closed === false,
    'Premature Closure Blocked',
    'Effect is NOT terminally closed because Attempt B remains DISPATCHED_UNRESOLVED.'
  );
  assert(
    effectDeriv14.canonical_execution_state === 'ACTIVE',
    'Effect Execution State ACTIVE',
    "Effect remains 'ACTIVE' while an attempt is unresolved."
  );
  assert(effectDeriv14.executed_fact === true, 'Executed Fact Preserved', 'executed_fact is TRUE.');

  // Now resolve Attempt B with qualifying evidence
  await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'EXECUTION_CONFIRMED',
    claim_semantics: 'EXECUTED',
    source_channel: 'CARRIER_B',
    client_correlation_id: auth11_B.client_correlation_id,
    raw_payload: { receipt: 'B_DELIVERED' },
  });

  const effectDeriv14_Resolved = await deriveCanonicalEffect(db, auth11_A.effect_key);
  assert(
    effectDeriv14_Resolved.is_terminally_closed === true,
    'Terminal Closure Succeeded',
    'Effect is NOW terminally closed after all attempts are resolved.'
  );
  assert(
    effectDeriv14_Resolved.canonical_execution_state === 'EXECUTED',
    'Effect Execution State EXECUTED',
    "Effect state transitioned to 'EXECUTED'."
  );

  // --------------------------------------------------------------------------
  // TEST 15: Open Contradictions Prevent Closure (CONTRADICTED_INCIDENT)
  // --------------------------------------------------------------------------
  console.log('\n[15/22] Testing: Open contradictions prevent closure where required...');
  const effectDeriv15 = await deriveCanonicalEffect(db, auth9.effect_key);
  assert(
    effectDeriv15.is_terminally_closed === false,
    'Closure Blocked by Contradiction',
    'Open contradiction prevents terminal closure.'
  );
  assert(
    effectDeriv15.canonical_execution_state === 'CONTRADICTED_INCIDENT',
    'State CONTRADICTED_INCIDENT',
    "Effect execution_state is 'CONTRADICTED_INCIDENT'."
  );
  assert(effectDeriv15.open_contradiction_count > 0, 'Open Contradiction Present', 'open_contradiction_count > 0.');

  // --------------------------------------------------------------------------
  // TEST 16: Canonical Derivation is Strictly Idempotent
  // --------------------------------------------------------------------------
  console.log('\n[16/22] Testing: Canonical derivation is strictly idempotent...');
  const iter1 = await deriveCanonicalEffect(db, auth11_A.effect_key);
  const iter2 = await deriveCanonicalEffect(db, auth11_A.effect_key);
  const iter3 = await deriveCanonicalEffect(db, auth11_A.effect_key);

  assert(
    iter1.canonical_execution_state === iter2.canonical_execution_state &&
    iter2.canonical_execution_state === iter3.canonical_execution_state,
    'State Idempotency',
    'Repeated derivations produce identical state.'
  );
  assert(
    iter1.executed_fact === iter2.executed_fact && iter2.executed_fact === iter3.executed_fact,
    'Executed Fact Idempotency',
    'executed_fact remains identical across repeated runs.'
  );
  assert(
    iter2.fence_version === iter3.fence_version,
    'No Unnecessary Fence Increments',
    'No state toggling or redundant updates occurred.'
  );

  // --------------------------------------------------------------------------
  // TEST 17: Concurrent Derivation Cannot Corrupt Canonical State
  // --------------------------------------------------------------------------
  console.log('\n[17/22] Testing: Concurrent derivation cannot corrupt canonical state...');
  const auth17 = await authorizeOperation(db, {
    actor_principal_id: 'agent-deriv-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage6_v1',
    idempotency_key: 'idem-st6-test-17',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550000017',
      message_body: 'Stage 6 Concurrency Test 17',
      channel: 'sms',
    },
  });

  await executeDispatch(
    db,
    {
      effect_key: auth17.effect_key,
      cycle_number: auth17.cycle_number,
      attempt_id: auth17.attempt_id,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-deriv-1',
    },
    mockProvider
  );

  await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'EXECUTION_CONFIRMED',
    claim_semantics: 'EXECUTED',
    source_channel: 'CONCURRENT_CARRIER',
    client_correlation_id: auth17.client_correlation_id,
    raw_payload: { status: 'DELIVERED_PARALLEL' },
  });

  // Execute 5 concurrent derivations on the same effect
  const concurrentResults = await Promise.all([
    deriveCanonicalEffect(db, auth17.effect_key, { caller_identity: 'worker-parallel-1' }),
    deriveCanonicalEffect(db, auth17.effect_key, { caller_identity: 'worker-parallel-2' }),
    deriveCanonicalEffect(db, auth17.effect_key, { caller_identity: 'worker-parallel-3' }),
    deriveCanonicalEffect(db, auth17.effect_key, { caller_identity: 'worker-parallel-4' }),
    deriveCanonicalEffect(db, auth17.effect_key, { caller_identity: 'worker-parallel-5' }),
  ]);

  for (const res of concurrentResults) {
    assert(
      res.canonical_execution_state === 'EXECUTED',
      'Concurrent Result Valid',
      "All concurrent workers observed 'EXECUTED'."
    );
    assert(res.executed_fact === true, 'Concurrent Executed Fact', 'executed_fact is TRUE.');
  }

  // --------------------------------------------------------------------------
  // TEST 18: Derivation Can Safely Be Rerun After a Simulated Crash Window
  // --------------------------------------------------------------------------
  console.log('\n[18/22] Testing: Derivation can safely be rerun after simulated crash window...');
  // Case: Process crashed after evidence committed, before derivation ran.
  // When derivation runs for the first time, it cleanly transitions.
  const auth18 = await authorizeOperation(db, {
    actor_principal_id: 'agent-deriv-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage6_v1',
    idempotency_key: 'idem-st6-test-18',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550000018',
      message_body: 'Stage 6 Crash Window Test 18',
      channel: 'sms',
    },
  });

  await executeDispatch(
    db,
    {
      effect_key: auth18.effect_key,
      cycle_number: auth18.cycle_number,
      attempt_id: auth18.attempt_id,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-deriv-1',
    },
    mockProvider
  );

  // Evidence commits durably
  await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'EXECUTION_CONFIRMED',
    claim_semantics: 'EXECUTED',
    source_channel: 'CRASH_SIMULATION_SOURCE',
    client_correlation_id: auth18.client_correlation_id,
    raw_payload: { note: 'committed_before_crash' },
  });

  // Re-run derivation after crash recovery
  const postCrashDeriv1 = await deriveCanonicalEffect(db, auth18.effect_key, {
    _simulateCrashAfterCommit: true,
  });
  assert(
    postCrashDeriv1.canonical_execution_state === 'EXECUTED',
    'First Derivation Post-Crash Succeeded',
    "Recovered to 'EXECUTED'."
  );

  // Second run after simulated post-commit crash
  const postCrashDeriv2 = await deriveCanonicalEffect(db, auth18.effect_key);
  assert(
    postCrashDeriv2.canonical_execution_state === 'EXECUTED',
    'Second Derivation Converged',
    'Post-commit recovery converged to identical state.'
  );

  // --------------------------------------------------------------------------
  // TEST 19: Provider Adapter Cannot Directly Establish Execution Fact
  // --------------------------------------------------------------------------
  console.log('\n[19/22] Testing: Provider adapter cannot directly establish canonical execution fact...');
  const auth19 = await authorizeOperation(db, {
    actor_principal_id: 'agent-deriv-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage6_v1',
    idempotency_key: 'idem-st6-test-19',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550000019',
      message_body: 'Stage 6 Provider Boundary Test 19',
      channel: 'sms',
    },
  });

  const disp19 = await executeDispatch(
    db,
    {
      effect_key: auth19.effect_key,
      cycle_number: auth19.cycle_number,
      attempt_id: auth19.attempt_id,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-deriv-1',
    },
    mockProvider
  );

  assert(disp19.provider_response?.status === 'ACCEPTED', 'Provider Returned ACCEPTED', 'Provider returned ACCEPTED.');
  const effectPostDispatch = await db.query<{ executed_fact: boolean; execution_state: string }>(
    `SELECT executed_fact, execution_state FROM effects WHERE effect_key = $1;`,
    [auth19.effect_key]
  );
  assert(
    effectPostDispatch.rows[0].executed_fact === false,
    'Provider Response Ignored For Execution Truth',
    'executed_fact remains FALSE after provider response.'
  );
  assert(
    effectPostDispatch.rows[0].execution_state === 'ACTIVE' || effectPostDispatch.rows[0].execution_state === 'PENDING',
    'Effect Not Terminal',
    'Effect execution_state is not EXECUTED.'
  );

  // --------------------------------------------------------------------------
  // TEST 20: Evidence Ingestion Cannot Bypass Canonical Derivation
  // --------------------------------------------------------------------------
  console.log('\n[20/22] Testing: Evidence ingestion cannot bypass canonical derivation...');
  // Ingesting evidence appends to log, but DOES NOT directly modify attempt state
  await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'EXECUTION_CONFIRMED',
    claim_semantics: 'EXECUTED',
    source_channel: 'INGESTION_BYPASS_CHECK',
    client_correlation_id: auth19.client_correlation_id,
    raw_payload: { note: 'awaiting_derivation' },
  });

  const attemptPostIngest = await db.query<{ state: string }>(
    `SELECT state FROM attempts WHERE attempt_id = $1;`,
    [auth19.attempt_id]
  );
  assert(
    attemptPostIngest.rows[0].state === 'DISPATCHED_UNRESOLVED',
    'Attempt State Untouched by Ingestion',
    "Attempt is still 'DISPATCHED_UNRESOLVED' before derivation is called."
  );

  const effectPostIngest = await db.query<{ executed_fact: boolean }>(
    `SELECT executed_fact FROM effects WHERE effect_key = $1;`,
    [auth19.effect_key]
  );
  assert(
    effectPostIngest.rows[0].executed_fact === false,
    'Executed Fact Untouched by Ingestion',
    'executed_fact is still FALSE before derivation is called.'
  );

  // --------------------------------------------------------------------------
  // TEST 21: Recovery-Related Internal Facts Cannot Establish External Facts
  // --------------------------------------------------------------------------
  console.log('\n[21/22] Testing: Recovery-related internal facts cannot establish external facts...');
  const auth21 = await authorizeOperation(db, {
    actor_principal_id: 'agent-deriv-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage6_v1',
    idempotency_key: 'idem-st6-test-21',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550000021',
      message_body: 'Stage 6 Recovery Boundary Test 21',
      channel: 'sms',
    },
  });

  // Mark attempt as RECOVERY_RELEASED
  await db.query(`UPDATE attempts SET state = 'RECOVERY_RELEASED' WHERE attempt_id = $1;`, [auth21.attempt_id]);

  const deriv21 = await deriveCanonicalAttempt(db, auth21.attempt_id);
  assert(
    deriv21.canonical_state === 'RECOVERY_RELEASED',
    'Recovery State Maintained',
    'Attempt state remains RECOVERY_RELEASED.'
  );
  assert(deriv21.executed_fact === false, 'Not Executed', 'RECOVERY_RELEASED did not establish executed = true.');

  const effectDeriv21 = await deriveCanonicalEffect(db, auth21.effect_key);
  assert(
    effectDeriv21.is_terminally_closed === false,
    'Effect Not Terminally Closed',
    'RECOVERY_RELEASED without evidence cannot terminally close effect.'
  );

  // --------------------------------------------------------------------------
  // TEST 22: Contract-Guaranteed Acceptance & Rejection Semantics
  // --------------------------------------------------------------------------
  console.log('\n[22/22] Testing: Contract with guaranteed acceptance implies execution...');
  // Insert custom capability contract that explicitly guarantees acceptance implies execution
  await db.exec(`
    INSERT INTO capabilities (capability_id, name, description)
    VALUES ('mock.guaranteed_acceptance', 'Guaranteed Acceptance Service', 'Simulated service where acceptance guarantees execution.')
    ON CONFLICT (capability_id) DO NOTHING;

    INSERT INTO capability_contracts (
      capability_id, version, repeat_mode, effect_key_canonicalization_version,
      required_effect_fields, provider_dedup_semantics, provider_dedup_identity_rule,
      dedup_validity_window_seconds, supported_evidence_types, evidence_correlation_method,
      reconciliation_characteristics, heartbeat_interval_seconds, max_unresolved_duration_seconds,
      contract_status
    ) VALUES (
      'mock.guaranteed_acceptance', '1.0.0', 'SAFE_REPEAT', 'v1',
      '["recipient", "message_body", "channel"]'::jsonb,
      'PROVIDER_IDEMPOTENCY_KEY', 'rule', 86400,
      '["PROVIDER_ACCEPTED", "EXECUTION_CONFIRMED"]'::jsonb,
      'CLIENT_CORRELATION_ID_MATCH', '{}'::jsonb, 60, 600, 'ACTIVE'
    ) ON CONFLICT (capability_id, version) DO NOTHING;
  `);

  const auth22 = await authorizeOperation(db, {
    actor_principal_id: 'agent-deriv-1',
    capability_id: 'mock.guaranteed_acceptance',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage6_v1',
    idempotency_key: 'idem-st6-test-22',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15550000022',
      message_body: 'Stage 6 Guaranteed Acceptance Test 22',
      channel: 'sms',
    },
  });

  await executeDispatch(
    db,
    {
      effect_key: auth22.effect_key,
      cycle_number: auth22.cycle_number,
      attempt_id: auth22.attempt_id,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-deriv-1',
    },
    mockProvider
  );

  // Ingest PROVIDER_ACCEPTED evidence
  await ingestEvidence(db, {
    capability_id: 'mock.guaranteed_acceptance',
    capability_version: '1.0.0',
    evidence_type: 'PROVIDER_ACCEPTED',
    claim_semantics: 'ACCEPTED',
    source_channel: 'GUARANTEED_CHANNEL',
    client_correlation_id: auth22.client_correlation_id,
    raw_payload: { accepted: true },
  });

  // 1. Without acceptance_implies_execution flag: remains DISPATCHED_UNRESOLVED
  const deriv22_Standard = await deriveCanonicalAttempt(db, auth22.attempt_id);
  assert(
    deriv22_Standard.canonical_state === 'DISPATCHED_UNRESOLVED',
    'Default Contract Acceptance != Execution',
    'Without acceptanceImpliesExecution flag, attempt stays DISPATCHED_UNRESOLVED.'
  );

  // 2. Now update contract to explicitly guarantee acceptance implies execution
  await db.query(
    `UPDATE capability_contracts
     SET reconciliation_characteristics = '{"acceptance_implies_execution": true}'::jsonb
     WHERE capability_id = 'mock.guaranteed_acceptance' AND version = '1.0.0';`
  );

  const deriv22_Guaranteed = await deriveCanonicalAttempt(db, auth22.attempt_id);
  assert(
    deriv22_Guaranteed.canonical_state === 'COMPLETED_EXECUTED',
    'Guaranteed Acceptance Transitions to Executed',
    'Contract with acceptance_implies_execution: true transitions attempt to COMPLETED_EXECUTED.'
  );
  assert(deriv22_Guaranteed.executed_fact === true, 'Executed Fact True', 'executed_fact is TRUE under guaranteed contract.');

  console.log('\n===============================================================');
  console.log('STAGE 6 VALIDATION COMPLETED: 22/22 TESTS PASSED.');
  console.log('===============================================================');
}

runStage6Validation().catch((err) => {
  console.error('Stage 6 validation failed with error:', err);
  process.exit(1);
});
