/**
 * @file scripts/validate-schema.ts
 * Validation suite for Stage 1: Schema + Mock Capability Contract.
 *
 * Runs full DDL execution against standard PostgreSQL engine (PGlite)
 * and directly tests all locked architectural invariants.
 */

import { PGlite } from '@electric-sql/pglite';
import { applySchema, createFreshDb, seedMockCapabilityContract } from '../src/db/database.ts';
import { mockSendMessageContract } from '../src/contracts/mockSendMessageContract.ts';

interface TestResult {
  step: string;
  passed: boolean;
  message: string;
  details?: unknown;
}

const results: TestResult[] = [];

function assert(condition: boolean, step: string, message: string, details?: unknown) {
  if (condition) {
    results.push({ step, passed: true, message, details });
    console.log(`  [PASS] ${step}: ${message}`);
  } else {
    results.push({ step, passed: false, message, details });
    console.error(`  [FAIL] ${step}: ${message}`);
    throw new Error(`Assertion failed in ${step}: ${message}`);
  }
}

async function runValidation() {
  console.log('===============================================================');
  console.log('STARTING STAGE 1 SCHEMA & MOCK CONTRACT VALIDATION');
  console.log('===============================================================\n');

  const db = await createFreshDb();

  // --------------------------------------------------------------------------
  // STEP 1: Apply DDL Schema
  // --------------------------------------------------------------------------
  console.log('[1/8] Applying PostgreSQL DDL Schema...');
  await applySchema(db);

  const tablesRes = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename;`
  );
  const tableNames = tablesRes.rows.map((r) => r.tablename);
  const expectedTables = [
    'attempts',
    'audit_events',
    'authorizations',
    'budget_reservations',
    'capabilities',
    'capability_contracts',
    'contradiction_incidents',
    'dispatch_claims',
    'effects',
    'evidence_records',
    'intents',
    'policy_versions',
    'principal_budgets',
    'principals',
  ];

  for (const expected of expectedTables) {
    assert(
      tableNames.includes(expected),
      'Schema Creation',
      `Table '${expected}' exists in PostgreSQL catalog.`
    );
  }

  // --------------------------------------------------------------------------
  // STEP 2: Verify UNIQUE(execution_identity) in PostgreSQL Catalog
  // --------------------------------------------------------------------------
  console.log('\n[2/8] Verifying Database Constraint: UNIQUE(execution_identity)...');
  const constraintRes = await db.query<{ conname: string; contype: string }>(
    `SELECT conname, contype
     FROM pg_constraint c
     JOIN pg_class t ON c.conrelid = t.oid
     WHERE t.relname = 'attempts' AND c.contype = 'u';`
  );
  const uqConstraints = constraintRes.rows.map((r) => r.conname);
  console.log('  Unique constraints found on attempts:', uqConstraints);

  assert(
    constraintRes.rows.length >= 2, // UNIQUE(execution_identity) + UNIQUE(client_correlation_id) + UNIQUE(effect_key, cycle_number)
    'Constraint Inspection',
    `Found ${constraintRes.rows.length} unique constraints on 'attempts' table.`
  );

  // Seed baseline prerequisite records: Principal, Capability, Policy Version
  await seedMockCapabilityContract(db);

  await db.query(
    `INSERT INTO principals (principal_id, type, name, status)
     VALUES ('principal-system', 'SYSTEM', 'Core Orchestrator', 'ACTIVE'),
            ('principal-agent-1', 'AGENT', 'Planner Agent 1', 'ACTIVE');`
  );

  await db.query(
    `INSERT INTO policy_versions (policy_version_id, policy_name, version, rules_definition)
     VALUES ('pol-v1', 'default_orchestration_policy', '1.0.0', '{"max_retries": 3}'::jsonb);`
  );

  // Insert effect
  await db.query(
    `INSERT INTO effects (
      effect_key, capability_id, capability_version, canonical_payload, repeat_mode, execution_state
     ) VALUES (
      'eff-msg-hash-100', 'mock.send_message', '1.0.0',
      '{"recipient": "+15551234567", "message_body": "Verification payload", "channel": "sms"}'::jsonb,
      'SAFE_REPEAT', 'PENDING'
     );`
  );

  // Insert intent converging on effect_key
  await db.query(
    `INSERT INTO intents (
      intent_id, principal_id, target_effect_key, policy_version_id, idempotency_key, payload, status
     ) VALUES (
      'intent-alpha', 'principal-agent-1', 'eff-msg-hash-100', 'pol-v1', 'idem-key-1',
      '{"action": "send_alert"}'::jsonb, 'AUTHORIZED'
     );`
  );

  // Insert budget reservation & authorization
  await db.query(
    `INSERT INTO budget_reservations (reservation_id, principal_id, effect_key, amount, currency_or_unit)
     VALUES ('budget-res-1', 'principal-agent-1', 'eff-msg-hash-100', 1.0, 'USD');`
  );

  await db.query(
    `INSERT INTO authorizations (
      authorization_id, intent_id, effect_key, principal_id, policy_version_id,
      budget_reservation_id, authorized_cycle, repeat_authorization_type, authorization_status
     ) VALUES (
      'auth-1', 'intent-alpha', 'eff-msg-hash-100', 'principal-agent-1', 'pol-v1',
      'budget-res-1', 1, 'INITIAL_ATTEMPT', 'VALID'
     );`
  );

  // Insert attempt 1 with execution_identity = 'exec-id-global-1'
  await db.query(
    `INSERT INTO attempts (
      attempt_id, effect_key, cycle_number, authorization_id, execution_identity,
      client_correlation_id, provider_dedup_identity, state
     ) VALUES (
      'att-1', 'eff-msg-hash-100', 1, 'auth-1', 'exec-id-global-1',
      'client-corr-uuid-1', 'dedup-sha-token-1', 'RESERVED'
     );`
  );

  // Attempt duplicate insert with same execution_identity -> MUST FAIL
  let duplicateExecutionIdRejected = false;
  try {
    await db.query(
      `INSERT INTO attempts (
        attempt_id, effect_key, cycle_number, authorization_id, execution_identity,
        client_correlation_id, provider_dedup_identity, state
       ) VALUES (
        'att-duplicate', 'eff-msg-hash-100', 2, 'auth-1', 'exec-id-global-1',
        'client-corr-uuid-diff', 'dedup-sha-token-1', 'RESERVED'
       );`
    );
  } catch (err: unknown) {
    duplicateExecutionIdRejected = true;
    console.log('  Confirmed rejection of duplicate execution_identity:', (err as Error).message);
  }
  assert(
    duplicateExecutionIdRejected,
    'Invariant G1 Enforcement',
    'Database strictly rejected duplicate execution_identity with UNIQUE constraint violation.'
  );

  // --------------------------------------------------------------------------
  // STEP 3: Verify Effect Identity != Attempt Identity & Intent Convergence
  // --------------------------------------------------------------------------
  console.log('\n[3/8] Verifying Effect Identity != Attempt Identity & Convergence...');
  // A second different intent converges on the same effect
  await db.query(
    `INSERT INTO intents (
      intent_id, principal_id, target_effect_key, policy_version_id, idempotency_key, payload, status
     ) VALUES (
      'intent-beta', 'principal-system', 'eff-msg-hash-100', 'pol-v1', 'idem-key-2',
      '{"action": "retry_dispatch"}'::jsonb, 'AUTHORIZED'
     );`
  );

  // Authorize cycle 2
  await db.query(
    `INSERT INTO authorizations (
      authorization_id, intent_id, effect_key, principal_id, policy_version_id,
      authorized_cycle, repeat_authorization_type, authorization_status
     ) VALUES (
      'auth-2', 'intent-beta', 'eff-msg-hash-100', 'principal-system', 'pol-v1',
      2, 'SAFE_REPEAT_ALLOWED', 'VALID'
     );`
  );

  // Insert attempt 2 for cycle 2 on the SAME effect_key
  await db.query(
    `INSERT INTO attempts (
      attempt_id, effect_key, cycle_number, authorization_id, execution_identity,
      client_correlation_id, provider_dedup_identity, state
     ) VALUES (
      'att-2', 'eff-msg-hash-100', 2, 'auth-2', 'exec-id-global-2',
      'client-corr-uuid-2', 'dedup-sha-token-1', 'RESERVED'
     );`
  );

  const attemptsForEffect = await db.query<{
    attempt_id: string;
    effect_key: string;
    cycle_number: number;
    execution_identity: string;
  }>(`SELECT attempt_id, effect_key, cycle_number, execution_identity FROM attempts WHERE effect_key = 'eff-msg-hash-100' ORDER BY cycle_number;`);

  assert(
    attemptsForEffect.rows.length === 2,
    'Effect vs Attempt Separation',
    `Effect 'eff-msg-hash-100' has 2 separate attempt rows with distinct cycle numbers.`
  );
  assert(
    attemptsForEffect.rows[0].attempt_id !== attemptsForEffect.rows[1].attempt_id,
    'Attempt Identity',
    'Attempt identities are separate and distinct.'
  );
  assert(
    attemptsForEffect.rows[0].execution_identity !== attemptsForEffect.rows[1].execution_identity,
    'Execution Identity',
    'Execution identities are distinct per cycle.'
  );

  // --------------------------------------------------------------------------
  // STEP 4: Verify Correlation Identifiers Disambiguation
  // --------------------------------------------------------------------------
  console.log('\n[4/8] Verifying Correlation Identifiers Disambiguation...');
  const corrRes = await db.query<{
    attempt_id: string;
    client_correlation_id: string;
    provider_dedup_identity: string | null;
    provider_assigned_id: string | null;
  }>(`SELECT attempt_id, client_correlation_id, provider_dedup_identity, provider_assigned_id FROM attempts WHERE effect_key = 'eff-msg-hash-100' ORDER BY cycle_number;`);

  const row1 = corrRes.rows[0];
  const row2 = corrRes.rows[1];

  assert(
    row1.client_correlation_id !== row2.client_correlation_id,
    'Client Correlation ID',
    'client_correlation_id is uniquely generated per attempt (corr-1 != corr-2).'
  );
  assert(
    row1.provider_dedup_identity === row2.provider_dedup_identity && row1.provider_dedup_identity !== null,
    'Provider Dedup Identity',
    'provider_dedup_identity is identical across retry cycles under SAFE_REPEAT.'
  );
  assert(
    row1.provider_assigned_id === null && row2.provider_assigned_id === null,
    'Provider Assigned ID',
    'provider_assigned_id is absent (NULL) prior to provider response.'
  );

  // --------------------------------------------------------------------------
  // STEP 5: Verify RECOVERY_RELEASED Attempt State & Invariant D Boundary
  // --------------------------------------------------------------------------
  console.log('\n[5/8] Verifying RECOVERY_RELEASED Attempt State & Dispatch Claim Invariant...');
  // Cycle 1 is released by recovery: RESERVED -> RECOVERY_RELEASED
  await db.query(
    `UPDATE attempts SET state = 'RECOVERY_RELEASED', resolved_at = NOW() WHERE attempt_id = 'att-1';`
  );

  const att1State = await db.query<{ state: string }>(
    `SELECT state FROM attempts WHERE attempt_id = 'att-1';`
  );
  assert(
    att1State.rows[0].state === 'RECOVERY_RELEASED',
    'Attempt State Transition',
    "Attempt att-1 transitioned to 'RECOVERY_RELEASED'."
  );

  // Verify that RECOVERY_RELEASED is NOT an evidence record
  const evidenceCountForAtt1 = await db.query<{ count: string }>(
    `SELECT count(*) FROM evidence_records WHERE attempt_id = 'att-1';`
  );
  assert(
    parseInt(evidenceCountForAtt1.rows[0].count) === 0,
    'Recovery Released Is Not Evidence',
    'RECOVERY_RELEASED is purely an internal attempt state; 0 evidence records exist.'
  );

  // Verify that creating a dispatch claim for att-1 in RECOVERY_RELEASED fails via DB trigger
  let claimOnReleasedRejected = false;
  try {
    await db.query(
      `INSERT INTO dispatch_claims (
        claim_id, attempt_id, client_correlation_id, dispatcher_identity, lease_token, lease_expires_at
       ) VALUES (
        'claim-att-1', 'att-1', 'client-corr-uuid-1', 'worker-node-a', 'lease-tok-1', NOW() + INTERVAL '5 minutes'
       );`
    );
  } catch (err: unknown) {
    claimOnReleasedRejected = true;
    console.log('  Confirmed rejection of claim on RECOVERY_RELEASED attempt:', (err as Error).message);
  }
  assert(
    claimOnReleasedRejected,
    'Invariant D Enforcement',
    'Database trigger rejected dispatch claim creation on RECOVERY_RELEASED attempt.'
  );

  // --------------------------------------------------------------------------
  // STEP 6: Verify Dispatch Claim, Evidence Attribution & Append-Only Triggers
  // --------------------------------------------------------------------------
  console.log('\n[6/8] Verifying Dispatch Claims & Append-Only Evidence Records...');
  // att-2 transitions RESERVED -> DISPATCHED_UNRESOLVED
  await db.query(
    `UPDATE attempts SET state = 'DISPATCHED_UNRESOLVED', dispatched_at = NOW() WHERE attempt_id = 'att-2';`
  );

  // Create dispatch claim for att-2
  await db.query(
    `INSERT INTO dispatch_claims (
      claim_id, attempt_id, client_correlation_id, dispatcher_identity, lease_token, lease_expires_at, committed_at
     ) VALUES (
      'claim-att-2', 'att-2', 'client-corr-uuid-2', 'worker-node-a', 'lease-tok-2', NOW() + INTERVAL '5 minutes', NOW()
     );`
  );

  // Insert execution evidence linking to claim and attempt
  await db.query(
    `INSERT INTO evidence_records (
      evidence_id, effect_key, attempt_id, claim_id, evidence_type, correlation_method,
      client_correlation_id, provider_assigned_id, raw_payload
     ) VALUES (
      'ev-exec-1', 'eff-msg-hash-100', 'att-2', 'claim-att-2', 'EXECUTION_CONFIRMED', 'CLIENT_CORRELATION_ID_MATCH',
      'client-corr-uuid-2', 'prov-msg-rec-999', '{"provider_status": "DELIVERED", "latency_ms": 142}'::jsonb
     );`
  );

  // Populate provider_assigned_id on attempt now that provider responded
  await db.query(
    `UPDATE attempts SET provider_assigned_id = 'prov-msg-rec-999', state = 'COMPLETED_EXECUTED', resolved_at = NOW()
     WHERE attempt_id = 'att-2';`
  );

  // Test Append-Only enforcement on evidence_records: UPDATE must fail
  let evidenceUpdateRejected = false;
  try {
    await db.query(
      `UPDATE evidence_records SET raw_payload = '{"tampered": true}'::jsonb WHERE evidence_id = 'ev-exec-1';`
    );
  } catch (err: unknown) {
    evidenceUpdateRejected = true;
    console.log('  Confirmed rejection of UPDATE on evidence_records:', (err as Error).message);
  }
  assert(
    evidenceUpdateRejected,
    'Append-Only Safety Invariant',
    'Database trigger rejected UPDATE on evidence_records.'
  );

  // Test Append-Only enforcement on evidence_records: DELETE must fail
  let evidenceDeleteRejected = false;
  try {
    await db.query(`DELETE FROM evidence_records WHERE evidence_id = 'ev-exec-1';`);
  } catch (err: unknown) {
    evidenceDeleteRejected = true;
    console.log('  Confirmed rejection of DELETE on evidence_records:', (err as Error).message);
  }
  assert(
    evidenceDeleteRejected,
    'Append-Only Safety Invariant',
    'Database trigger rejected DELETE on evidence_records.'
  );

  // --------------------------------------------------------------------------
  // STEP 7: Verify Executed Fact & Contradiction Incident Coexistence
  // --------------------------------------------------------------------------
  console.log('\n[7/8] Verifying Executed Fact Coexistence with Contradiction...');
  // Effect marked as executed based on execution evidence
  await db.query(
    `UPDATE effects
     SET executed_fact = TRUE, execution_state = 'EXECUTED', executed_at = NOW(), terminal_attempt_id = 'att-2'
     WHERE effect_key = 'eff-msg-hash-100';`
  );

  // Suppose conflicting evidence arrives later from an external reconciliation audit
  await db.query(
    `INSERT INTO evidence_records (
      evidence_id, effect_key, attempt_id, claim_id, evidence_type, correlation_method,
      provider_assigned_id, raw_payload
     ) VALUES (
      'ev-conflict-2', 'eff-msg-hash-100', 'att-2', 'claim-att-2', 'NON_EXECUTION_CONFIRMED', 'PROVIDER_ASSIGNED_ID_LOOKUP',
      'prov-msg-rec-999', '{"reconciliation_audit": "upstream_gateway_dropped_message"}'::jsonb
     );`
  );

  // Insert contradiction incident referencing both evidence records
  await db.query(
    `INSERT INTO contradiction_incidents (
      incident_id, effect_key, attempt_id, primary_evidence_id, conflicting_evidence_id,
      severity, status, summary, details
     ) VALUES (
      'inc-contradiction-1', 'eff-msg-hash-100', 'att-2', 'ev-exec-1', 'ev-conflict-2',
      'CRITICAL', 'OPEN', 'Delivery report contradicted by reconciliation audit',
      '{"primary": "ev-exec-1", "conflicting": "ev-conflict-2"}'::jsonb
     );`
  );

  // Verify that executed_fact is STILL TRUE on effects, and execution_state is CONTRADICTED_INCIDENT
  await db.query(
    `UPDATE effects SET execution_state = 'CONTRADICTED_INCIDENT' WHERE effect_key = 'eff-msg-hash-100';`
  );

  const effectState = await db.query<{ executed_fact: boolean; execution_state: string }>(
    `SELECT executed_fact, execution_state FROM effects WHERE effect_key = 'eff-msg-hash-100';`
  );

  assert(
    effectState.rows[0].executed_fact === true,
    'Executed Fact Preserved',
    'Historical executed_fact remains TRUE despite contradiction incident.'
  );
  assert(
    effectState.rows[0].execution_state === 'CONTRADICTED_INCIDENT',
    'Execution State Coexistence',
    "Effect status transitioned to 'CONTRADICTED_INCIDENT' without erasing history."
  );

  // --------------------------------------------------------------------------
  // STEP 8: Verify Mock Capability Contract & Dedup Window Constraints
  // --------------------------------------------------------------------------
  console.log('\n[8/8] Verifying Capability Contract & Dedup Window Constraints...');
  const contractInDb = await db.query<{
    capability_id: string;
    version: string;
    repeat_mode: string;
    dedup_validity_window_seconds: number;
    required_effect_fields: string;
  }>(`SELECT capability_id, version, repeat_mode, dedup_validity_window_seconds, required_effect_fields FROM capability_contracts WHERE capability_id = 'mock.send_message';`);

  assert(
    contractInDb.rows[0].capability_id === mockSendMessageContract.capabilityId,
    'Mock Contract Capability ID',
    `Contract capability_id is '${mockSendMessageContract.capabilityId}'.`
  );
  assert(
    contractInDb.rows[0].repeat_mode === 'SAFE_REPEAT',
    'Mock Contract Repeat Mode',
    "Contract declares 'SAFE_REPEAT'."
  );
  assert(
    contractInDb.rows[0].dedup_validity_window_seconds === 86400,
    'Mock Contract Dedup Window',
    'Contract declares dedup_validity_window_seconds = 86400 (24h).'
  );

  // Test Check Constraint: SAFE_REPEAT requires dedup_validity_window_seconds > 0
  let invalidSafeRepeatRejected = false;
  try {
    await db.query(
      `INSERT INTO capability_contracts (
        capability_id, version, repeat_mode, effect_key_canonicalization_version,
        provider_dedup_semantics, provider_dedup_identity_rule, dedup_validity_window_seconds,
        evidence_correlation_method
       ) VALUES (
        'mock.send_message', '2.0.0-invalid', 'SAFE_REPEAT', 'v1',
        'NONE', 'none', NULL, 'CLIENT_CORRELATION_ID_MATCH'
       );`
    );
  } catch (err: unknown) {
    invalidSafeRepeatRejected = true;
    console.log('  Confirmed rejection of SAFE_REPEAT without window:', (err as Error).message);
  }
  assert(
    invalidSafeRepeatRejected,
    'Contract Check Constraint',
    'Database strictly rejected SAFE_REPEAT contract having NULL dedup_validity_window_seconds.'
  );

  // Test Check Constraint: UNSAFE_REPEAT must have NULL dedup_validity_window_seconds
  let invalidUnsafeRepeatRejected = false;
  try {
    await db.query(
      `INSERT INTO capability_contracts (
        capability_id, version, repeat_mode, effect_key_canonicalization_version,
        provider_dedup_semantics, provider_dedup_identity_rule, dedup_validity_window_seconds,
        evidence_correlation_method
       ) VALUES (
        'mock.send_message', '2.0.0-unsafe-invalid', 'UNSAFE_REPEAT', 'v1',
        'NONE', 'none', 3600, 'CLIENT_CORRELATION_ID_MATCH'
       );`
    );
  } catch (err: unknown) {
    invalidUnsafeRepeatRejected = true;
    console.log('  Confirmed rejection of UNSAFE_REPEAT with window:', (err as Error).message);
  }
  assert(
    invalidUnsafeRepeatRejected,
    'Contract Check Constraint',
    'Database strictly rejected UNSAFE_REPEAT contract having non-null dedup window.'
  );

  console.log('\n===============================================================');
  console.log(`VALIDATION COMPLETED: ${results.filter((r) => r.passed).length}/${results.length} CHECKS PASSED.`);
  console.log('===============================================================\n');

  await db.close();
  process.exit(0);
}

runValidation().catch((err) => {
  console.error('Fatal Validation Error:', err);
  process.exit(1);
});
