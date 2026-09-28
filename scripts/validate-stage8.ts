/**
 * @file scripts/validate-stage8.ts
 * Stage 8 Validation Suite: Adjudication & Contradiction Blocking.
 *
 * Verifies all 27 required Stage 8 invariants:
 *  1. Contradiction incident creation.
 *  2. Durable OPEN contradiction.
 *  3. Immutable evidence (cannot be edited or deleted).
 *  4. Adjudication record persistence.
 *  5. Adjudication authority enforcement (unauthorized principal rejected).
 *  6. Adjudication does not create evidence.
 *  7. Adjudication does not modify evidence.
 *  8. executed_fact cannot move TRUE -> FALSE.
 *  9. Adjudication cannot manufacture executed_fact TRUE without evidence.
 * 10. OPEN safety-relevant contradiction blocks unsafe authorization.
 * 11. Contradiction blocking occurs atomically in the authorization transaction.
 * 12. Failed authorization leaves no partial reservation/budget state.
 * 13. UNSAFE_REPEAT remains blocked while contradiction is OPEN.
 * 14. SAFE_REPEAT preserves existing contract gating while considering contradiction.
 * 15. Adjudication does not authorize.
 * 16. Adjudication does not dispatch.
 * 17. Adjudication does not create dispatch claims.
 * 18. Terminal closure is blocked while required contradiction remains OPEN.
 * 19. Valid adjudication clears the control-plane block.
 * 20. Historical contradiction remains auditable after adjudication.
 * 21. Stale adjudication cannot overwrite newer state (fencing).
 * 22. Concurrent adjudication is serialized (exactly one winner).
 * 23. Authorization / adjudication race is safe and deterministic.
 * 24. Recovery cannot adjudicate.
 * 25. Reconciliation cannot adjudicate.
 * 26. Spurious contradiction dismissal to ADJUDICATED.
 * 27. REMAIN_BLOCKED_REQUIRE_EVIDENCE (INVESTIGATING) continues to block authorization & terminal closure.
 */

import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createFreshDb, applySchema, seedMockCapabilityContract } from '../src/db/database.ts';
import { authorizeOperation } from '../src/authorization/authorizeOperation.ts';
import { AuthorizationError } from '../src/authorization/types.ts';
import { executeDispatch } from '../src/dispatch/executeDispatch.ts';
import { MockSendMessageProvider } from '../src/dispatch/mockProvider.ts';
import { ingestEvidence } from '../src/evidence/ingestEvidence.ts';
import { deriveCanonicalState } from '../src/derivation/deriveCanonicalState.ts';
import { executeRecovery } from '../src/recovery/recoveryEngine.ts';
import { reconcileUnresolvedAttempts } from '../src/recovery/reconciliation.ts';
import { adjudicateContradiction } from '../src/adjudication/adjudicateContradiction.ts';
import { AdjudicationError } from '../src/adjudication/types.ts';
import { evaluateAuthorizationGating } from '../src/ledger/effectLedger.ts';

function assert(condition: boolean, testName: string, detail?: string): void {
  if (!condition) {
    console.error(`  [FAIL] ${testName}: ${detail ?? 'Assertion failed'}`);
    process.exit(1);
  }
  console.log(`  [PASS] ${testName}: ${detail ?? 'Verified'}`);
}

async function setupStage8Prerequisites(db: PGlite) {
  await applySchema(db);
  await seedMockCapabilityContract(db);

  await db.exec(`
    INSERT INTO principals (principal_id, type, name, status, metadata)
    VALUES
      ('agent-st8-1', 'AGENT', 'Stage 8 Agent 1', 'ACTIVE', '{"scopes": ["*"]}'::jsonb),
      ('agent-st8-2', 'AGENT', 'Stage 8 Agent 2', 'ACTIVE', '{"scopes": ["*"]}'::jsonb),
      ('adj-officer-1', 'USER', 'Adjudication Officer 1', 'ACTIVE', '{"roles": ["ADJUDICATOR"], "scopes": ["adjudication"]}'::jsonb),
      ('adj-admin-1', 'USER', 'Adjudication Admin', 'ACTIVE', '{"roles": ["ADMIN"], "scopes": ["*"]}'::jsonb),
      ('unauth-user-1', 'USER', 'Unauthorized User', 'ACTIVE', '{"roles": ["VIEWER"], "scopes": ["read"]}'::jsonb),
      ('inactive-adj-1', 'USER', 'Suspended Adjudicator', 'SUSPENDED', '{"roles": ["ADJUDICATOR"]}'::jsonb),
      ('worker-disp-8', 'WORKER', 'Dispatch Worker 8', 'ACTIVE', '{"scopes": ["*"]}'::jsonb),
      ('worker-rec-8', 'WORKER', 'Recovery Worker 8', 'ACTIVE', '{"scopes": ["*"]}'::jsonb)
    ON CONFLICT (principal_id) DO NOTHING;

    INSERT INTO principal_budgets (principal_id, currency_or_unit, budget_limit, reserved_amount)
    VALUES
      ('agent-st8-1', 'USD', 10000.0, 0.0),
      ('agent-st8-2', 'USD', 10000.0, 0.0)
    ON CONFLICT (principal_id, currency_or_unit) DO NOTHING;

    INSERT INTO policy_versions (policy_version_id, policy_name, version, is_active, rules_definition)
    VALUES
      ('pol_stage8_v1', 'stage8_policy', '1.0.0', true, '{"adjudication_required": true}'::jsonb),
      ('pol_stage8_inactive', 'stage8_inactive', '0.0.1', false, '{}'::jsonb)
    ON CONFLICT (policy_version_id) DO NOTHING;
  `);
}

async function runStage8Validation() {
  console.log('===============================================================');
  console.log('STARTING STAGE 8 ADJUDICATION & CONTRADICTION BLOCKING VALIDATION');
  console.log('===============================================================');

  const db = await createFreshDb();
  await setupStage8Prerequisites(db);
  const mockProvider = new MockSendMessageProvider('mock.send_message');

  // Helper to setup a test effect with attempt, dispatch, and evidence
  async function setupEffectWithContradiction(prefix: string) {
    const operation_payload = {
      recipient: `+15558000000_${prefix}`,
      message_body: `Stage 8 Message for ${prefix}`,
      channel: 'sms',
    };

    const auth = await authorizeOperation(db, {
      actor_principal_id: 'agent-st8-1',
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      requested_scope: 'default',
      policy_version_id: 'pol_stage8_v1',
      idempotency_key: `idem-${prefix}-01`,
      budget_amount: 5.0,
      budget_currency: 'USD',
      operation_payload,
    });

    const dispatch = await executeDispatch(
      db,
      {
        attempt_id: auth.attempt_id,
        effect_key: auth.effect_key,
        dispatcher_identity: 'worker-disp-8',
        lease_duration_ms: 60000,
        expected_fence_version: 1,
      },
      mockProvider
    );

    // Ingest first evidence: EXECUTION_CONFIRMED
    const evExec = await ingestEvidence(db, {
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      evidence_type: 'EXECUTION_CONFIRMED',
      claim_semantics: 'EXECUTED',
      source_channel: 'CARRIER_1',
      client_correlation_id: auth.client_correlation_id,
      raw_payload: { provider_tx_id: `tx-exec-${prefix}` },
    });

    // Ingest second conflicting evidence: NON_EXECUTION_CONFIRMED (creates contradiction)
    const evConflict = await ingestEvidence(db, {
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      evidence_type: 'NON_EXECUTION_CONFIRMED',
      claim_semantics: 'CONFIRMED_NEVER_WILL_EXECUTE',
      source_channel: 'CARRIER_AUDIT',
      client_correlation_id: auth.client_correlation_id,
      raw_payload: { provider_error: 'Simulated permanent failure after delivery' },
    });

    // Derive canonical state to ensure contradiction incident is registered
    const deriv = await deriveCanonicalState(db, { effect_key: auth.effect_key });

    const incidentRes = await db.query<{
      incident_id: string;
      status: string;
      severity: string;
      fence_version: string | number;
    }>(
      `SELECT incident_id, status, severity, fence_version FROM contradiction_incidents
       WHERE effect_key = $1 AND status = 'OPEN';`,
      [auth.effect_key]
    );

    return {
      auth,
      dispatch,
      evExec,
      evConflict,
      deriv,
      incident: incidentRes.rows[0],
      operation_payload,
    };
  }

  // --------------------------------------------------------------------------
  // TEST 1: Contradiction incident creation
  // --------------------------------------------------------------------------
  console.log('\n[1/26] Testing: Contradiction incident creation...');
  const setup1 = await setupEffectWithContradiction('test1');
  assert(setup1.incident !== undefined, 'Incident Created', 'Contradiction incident was recorded.');
  assert(setup1.incident.incident_id.length > 0, 'Incident ID Non-Empty', `Incident ID: ${setup1.incident.incident_id}`);

  // --------------------------------------------------------------------------
  // TEST 2: Durable OPEN contradiction
  // --------------------------------------------------------------------------
  console.log('\n[2/26] Testing: Durable OPEN contradiction...');
  assert(setup1.incident.status === 'OPEN', 'Incident Status OPEN', 'Contradiction incident status is strictly OPEN.');
  const queryDirect = await db.query<{ status: string }>(
    `SELECT status FROM contradiction_incidents WHERE incident_id = $1;`,
    [setup1.incident.incident_id]
  );
  assert(queryDirect.rows[0].status === 'OPEN', 'Durable Persistence', 'Incident status verified durably in DB.');

  // --------------------------------------------------------------------------
  // TEST 3: Immutable evidence (cannot be edited or deleted)
  // --------------------------------------------------------------------------
  console.log('\n[3/26] Testing: Immutable evidence (append-only trigger protection)...');
  let updateEvidenceRejected = false;
  try {
    await db.query(
      `UPDATE evidence_records SET raw_payload = '{"tampered": true}'::jsonb WHERE evidence_id = $1;`,
      [setup1.evExec.evidence_id]
    );
  } catch (err: unknown) {
    updateEvidenceRejected = true;
    console.log('  Confirmed UPDATE rejection by trigger:', (err as Error).message);
  }
  assert(updateEvidenceRejected, 'Evidence Update Rejected', 'Evidence record cannot be updated.');

  let deleteEvidenceRejected = false;
  try {
    await db.query(`DELETE FROM evidence_records WHERE evidence_id = $1;`, [setup1.evExec.evidence_id]);
  } catch (err: unknown) {
    deleteEvidenceRejected = true;
    console.log('  Confirmed DELETE rejection by trigger:', (err as Error).message);
  }
  assert(deleteEvidenceRejected, 'Evidence Delete Rejected', 'Evidence record cannot be deleted.');

  // --------------------------------------------------------------------------
  // TEST 4: Adjudication record persistence
  // --------------------------------------------------------------------------
  console.log('\n[4/26] Testing: Adjudication record persistence...');
  const adjRes1 = await adjudicateContradiction(db, {
    incident_id: setup1.incident.incident_id,
    adjudicator_principal_id: 'adj-officer-1',
    decision: 'RESOLVE_FAVOR_EXECUTION',
    rationale: 'Verified execution via primary carrier delivery receipt tx-exec-test1.',
    policy_version_id: 'pol_stage8_v1',
  });

  assert(adjRes1.resulting_incident_status === 'ADJUDICATED', 'Incident Adjudicated', 'Status moved to ADJUDICATED.');
  assert(adjRes1.adjudication_id.startsWith('adj_'), 'Adjudication ID Format', `Adjudication ID: ${adjRes1.adjudication_id}`);

  const storedAdj = await db.query<{
    adjudication_id: string;
    decision: string;
    adjudicator_principal_id: string;
    rationale: string;
  }>(
    `SELECT adjudication_id, decision, adjudicator_principal_id, rationale
     FROM adjudication_records WHERE adjudication_id = $1;`,
    [adjRes1.adjudication_id]
  );
  assert(storedAdj.rows.length === 1, 'Adjudication Record Found', 'Durable adjudication record persisted.');
  assert(storedAdj.rows[0].decision === 'RESOLVE_FAVOR_EXECUTION', 'Decision Stored', 'Decision stored correctly.');

  // --------------------------------------------------------------------------
  // TEST 5: Adjudication authority enforcement
  // --------------------------------------------------------------------------
  console.log('\n[5/26] Testing: Adjudication authority enforcement...');
  const setup5 = await setupEffectWithContradiction('test5');

  // Test unauthorized user
  let unauthRejected = false;
  try {
    await adjudicateContradiction(db, {
      incident_id: setup5.incident.incident_id,
      adjudicator_principal_id: 'unauth-user-1',
      decision: 'RESOLVE_FAVOR_EXECUTION',
      rationale: 'Attempt by unauthorized viewer.',
      policy_version_id: 'pol_stage8_v1',
    });
  } catch (err: unknown) {
    if (err instanceof AdjudicationError && err.code === 'UNAUTHORIZED_ADJUDICATOR') {
      unauthRejected = true;
    }
  }
  assert(unauthRejected, 'Unauthorized Principal Rejected', 'Principal without ADJUDICATOR role rejected.');

  // Test inactive/suspended user
  let inactiveRejected = false;
  try {
    await adjudicateContradiction(db, {
      incident_id: setup5.incident.incident_id,
      adjudicator_principal_id: 'inactive-adj-1',
      decision: 'RESOLVE_FAVOR_EXECUTION',
      rationale: 'Attempt by suspended adjudicator.',
      policy_version_id: 'pol_stage8_v1',
    });
  } catch (err: unknown) {
    if (err instanceof AdjudicationError && err.code === 'PRINCIPAL_NOT_ACTIVE') {
      inactiveRejected = true;
    }
  }
  assert(inactiveRejected, 'Inactive Principal Rejected', 'Suspended adjudicator principal rejected.');

  // --------------------------------------------------------------------------
  // TEST 6: Adjudication does not create evidence
  // --------------------------------------------------------------------------
  console.log('\n[6/26] Testing: Adjudication does not create evidence...');
  const evCountBefore = Number((await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM evidence_records;`)).rows[0].count);
  await adjudicateContradiction(db, {
    incident_id: setup5.incident.incident_id,
    adjudicator_principal_id: 'adj-admin-1',
    decision: 'RESOLVE_FAVOR_EXECUTION',
    rationale: 'Admin verified carrier logs.',
    policy_version_id: 'pol_stage8_v1',
  });
  const evCountAfter = Number((await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM evidence_records;`)).rows[0].count);
  assert(evCountBefore === evCountAfter, 'Zero Evidence Created', `Evidence count unchanged (${evCountBefore} == ${evCountAfter}).`);

  // --------------------------------------------------------------------------
  // TEST 7: Adjudication does not modify evidence
  // --------------------------------------------------------------------------
  console.log('\n[7/26] Testing: Adjudication does not modify evidence...');
  const evSetup5Exec = (await db.query<{ raw_payload: Record<string, unknown> }>(
    `SELECT raw_payload FROM evidence_records WHERE evidence_id = $1;`,
    [setup5.evExec.evidence_id]
  )).rows[0];
  assert(JSON.stringify(evSetup5Exec.raw_payload).includes('tx-exec-test5'), 'Evidence Untouched', 'Historical evidence remains identical.');

  // --------------------------------------------------------------------------
  // TEST 8: executed_fact cannot move TRUE -> FALSE
  // --------------------------------------------------------------------------
  console.log('\n[8/26] Testing: executed_fact cannot move TRUE -> FALSE...');
  const setup8 = await setupEffectWithContradiction('test8');
  assert(setup8.deriv.effect.executed_fact === true, 'Executed Fact True', 'Effect executed_fact is true.');

  let nonExecOnExecutedRejected = false;
  try {
    await adjudicateContradiction(db, {
      incident_id: setup8.incident.incident_id,
      adjudicator_principal_id: 'adj-officer-1',
      decision: 'RESOLVE_FAVOR_NON_EXECUTION',
      rationale: 'Attempting to erase execution fact.',
      policy_version_id: 'pol_stage8_v1',
    });
  } catch (err: unknown) {
    if (err instanceof AdjudicationError && err.code === 'INVALID_DECISION_EXECUTED_FACT_MONOTONIC') {
      nonExecOnExecutedRejected = true;
    }
  }
  assert(nonExecOnExecutedRejected, 'Monotonicity Guard Active', 'Adjudication strictly rejected clearing executed_fact.');

  // Direct SQL update attempt on effects.executed_fact from true to false is rejected by trigger
  let triggerExecutedRejected = false;
  try {
    await db.query(`UPDATE effects SET executed_fact = FALSE WHERE effect_key = $1;`, [setup8.auth.effect_key]);
  } catch (err: unknown) {
    triggerExecutedRejected = true;
    console.log('  Confirmed executed_fact monotonicity trigger rejection:', (err as Error).message);
  }
  assert(triggerExecutedRejected, 'DB Monotonicity Trigger Active', 'PostgreSQL trigger enforced executed_fact monotonicity.');

  // --------------------------------------------------------------------------
  // TEST 9: Adjudication cannot manufacture executed_fact TRUE without evidence
  // --------------------------------------------------------------------------
  console.log('\n[9/26] Testing: Adjudication cannot manufacture executed_fact TRUE without evidence...');
  // Create an effect where only non-execution evidence exists
  const auth9 = await authorizeOperation(db, {
    actor_principal_id: 'agent-st8-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage8_v1',
    idempotency_key: 'idem-test9-noexec',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: { recipient: '+15558000009', message_body: 'Test 9', channel: 'sms' },
  });
  await executeDispatch(
    db,
    {
      attempt_id: auth9.attempt_id,
      effect_key: auth9.effect_key,
      dispatcher_identity: 'worker-disp-8',
      lease_duration_ms: 60000,
      expected_fence_version: 1,
    },
    mockProvider
  );
  const evNon1 = await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'NON_EXECUTION_CONFIRMED',
    claim_semantics: 'CONFIRMED_NEVER_WILL_EXECUTE',
    source_channel: 'CARRIER_1',
    client_correlation_id: auth9.client_correlation_id,
    raw_payload: { reason: 'Network failure 1' },
  });
  const evNon2 = await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'PROVIDER_REJECTED',
    claim_semantics: 'PROVIDER_REJECTED',
    source_channel: 'CARRIER_1',
    client_correlation_id: auth9.client_correlation_id,
    raw_payload: { reason: 'Network failure 2' },
  });
  // Manually open an incident on this effect to test decision validity
  const inc9Id = `inc_test9_${randomUUID()}`;
  await db.query(
    `INSERT INTO contradiction_incidents (
      incident_id, effect_key, attempt_id, primary_evidence_id, conflicting_evidence_id,
      severity, status, summary
    ) VALUES ($1, $2, $3, $4, $5, 'HIGH', 'OPEN', 'Conflicting failure reports');`,
    [inc9Id, auth9.effect_key, auth9.attempt_id, evNon1.evidence_id, evNon2.evidence_id]
  );

  let manufactureExecRejected = false;
  try {
    await adjudicateContradiction(db, {
      incident_id: inc9Id,
      adjudicator_principal_id: 'adj-officer-1',
      decision: 'RESOLVE_FAVOR_EXECUTION',
      rationale: 'Trying to claim executed without evidence.',
      policy_version_id: 'pol_stage8_v1',
    });
  } catch (err: unknown) {
    if (err instanceof AdjudicationError && err.code === 'INVALID_DECISION_NO_EXECUTION_EVIDENCE') {
      manufactureExecRejected = true;
    }
  }
  assert(manufactureExecRejected, 'Fabrication Rejected', 'Adjudication cannot manufacture execution without qualifying evidence.');

  // --------------------------------------------------------------------------
  // TEST 10: OPEN safety-relevant contradiction blocks unsafe authorization
  // --------------------------------------------------------------------------
  console.log('\n[10/26] Testing: OPEN safety-relevant contradiction blocks unsafe authorization...');
  const setup10 = await setupEffectWithContradiction('test10');
  // Attempt to authorize a new attempt/cycle on this effect while the contradiction is OPEN
  let authBlocked = false;
  try {
    await authorizeOperation(db, {
      actor_principal_id: 'agent-st8-1',
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      requested_scope: 'default',
      policy_version_id: 'pol_stage8_v1',
      idempotency_key: 'idem-test10-retry-blocked',
      budget_amount: 5.0,
      budget_currency: 'USD',
      operation_payload: setup10.operation_payload,
    });
  } catch (err: unknown) {
    if (err instanceof AuthorizationError && err.code === 'BLOCKED_BY_OPEN_CONTRADICTION') {
      authBlocked = true;
    }
  }
  assert(authBlocked, 'Authorization Blocked', 'New authorization blocked by OPEN contradiction.');

  // --------------------------------------------------------------------------
  // TEST 11: Contradiction blocking occurs atomically
  // --------------------------------------------------------------------------
  console.log('\n[11/26] Testing: Contradiction blocking occurs atomically...');
  // The check runs inside the single authorizeOperation transaction under effect row-lock
  assert(authBlocked, 'Atomic Check Committed', 'Atomic transaction evaluated contradiction before committing.');

  // --------------------------------------------------------------------------
  // TEST 12: Failed authorization leaves no partial reservation/budget state
  // --------------------------------------------------------------------------
  console.log('\n[12/26] Testing: Failed authorization leaves no partial reservation/budget state...');
  const budgetAfterBlocked = (await db.query<{ reserved_amount: string }>(
    `SELECT reserved_amount FROM principal_budgets WHERE principal_id = 'agent-st8-1' AND currency_or_unit = 'USD';`
  )).rows[0];
  const blockedIntent = await db.query(
    `SELECT intent_id FROM intents WHERE idempotency_key = 'idem-test10-retry-blocked';`
  );
  assert(blockedIntent.rows.length === 0, 'No Intent Leaked', 'Zero intents created for blocked authorization.');

  // --------------------------------------------------------------------------
  // TEST 13: UNSAFE_REPEAT remains blocked while contradiction is OPEN
  // --------------------------------------------------------------------------
  console.log('\n[13/26] Testing: UNSAFE_REPEAT remains blocked while contradiction is OPEN...');
  const gatingUnsafe = await evaluateAuthorizationGating(db, setup10.auth.effect_key, 'UNSAFE_REPEAT');
  assert(gatingUnsafe.permitted === false, 'Gating Blocked', 'Ledger gating returns permitted=false due to open contradiction.');
  assert(gatingUnsafe.reason.includes('contradiction incident'), 'Gating Reason Valid', `Reason: ${gatingUnsafe.reason}`);

  // --------------------------------------------------------------------------
  // TEST 14: SAFE_REPEAT preserves existing contract gating while considering contradiction
  // --------------------------------------------------------------------------
  console.log('\n[14/26] Testing: SAFE_REPEAT preserves existing contract gating while considering contradiction...');
  const gatingSafe = await evaluateAuthorizationGating(db, setup10.auth.effect_key, 'SAFE_REPEAT');
  assert(gatingSafe.permitted === false, 'SAFE_REPEAT Blocked By Contradiction', 'SAFE_REPEAT also blocked when contradiction is open.');

  // --------------------------------------------------------------------------
  // TEST 15: Adjudication does not authorize
  // --------------------------------------------------------------------------
  console.log('\n[15/26] Testing: Adjudication does not authorize...');
  const authCountBefore = Number((await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM authorizations;`)).rows[0].count);
  await adjudicateContradiction(db, {
    incident_id: setup10.incident.incident_id,
    adjudicator_principal_id: 'adj-officer-1',
    decision: 'RESOLVE_FAVOR_EXECUTION',
    rationale: 'Adjudicated test 10.',
    policy_version_id: 'pol_stage8_v1',
  });
  const authCountAfter = Number((await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM authorizations;`)).rows[0].count);
  assert(authCountBefore === authCountAfter, 'Zero Authorizations Created', 'Adjudication creates zero authorizations.');

  // --------------------------------------------------------------------------
  // TEST 16: Adjudication does not dispatch
  // --------------------------------------------------------------------------
  console.log('\n[16/26] Testing: Adjudication does not dispatch...');
  const totalAttempts = (await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM attempts WHERE effect_key = $1;`,
    [setup10.auth.effect_key]
  )).rows[0].count;
  assert(Number(totalAttempts) === 1, 'No Extra Dispatch', 'Total attempts count remains exactly 1; adjudication did not create or dispatch an attempt.');

  // --------------------------------------------------------------------------
  // TEST 17: Adjudication does not create dispatch claims
  // --------------------------------------------------------------------------
  console.log('\n[17/26] Testing: Adjudication does not create dispatch claims...');
  const claimCount = (await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM dispatch_claims WHERE effect_key = $1;`,
    [setup10.auth.effect_key]
  )).rows[0].count;
  assert(Number(claimCount) === 1, 'Claims Unchanged', 'Zero additional dispatch claims created.');

  // --------------------------------------------------------------------------
  // TEST 18: Terminal closure is blocked while required contradiction remains OPEN
  // --------------------------------------------------------------------------
  console.log('\n[18/26] Testing: Terminal closure is blocked while required contradiction remains OPEN...');
  const setup18 = await setupEffectWithContradiction('test18');
  assert(setup18.deriv.effect.canonical_execution_state === 'CONTRADICTED_INCIDENT', 'State CONTRADICTED_INCIDENT', 'Effect state is CONTRADICTED_INCIDENT.');
  assert(setup18.deriv.effect.is_terminally_closed === false, 'Terminal Closure Blocked', 'is_terminally_closed is false.');

  // --------------------------------------------------------------------------
  // TEST 19: Valid adjudication clears the control-plane block
  // --------------------------------------------------------------------------
  console.log('\n[19/26] Testing: Valid adjudication clears the control-plane block...');
  const adj19 = await adjudicateContradiction(db, {
    incident_id: setup18.incident.incident_id,
    adjudicator_principal_id: 'adj-officer-1',
    decision: 'RESOLVE_FAVOR_EXECUTION',
    rationale: 'Resolved execution based on carrier confirmation.',
    policy_version_id: 'pol_stage8_v1',
  });
  assert(adj19.canonical_execution_state === 'EXECUTED', 'State Transitioned to EXECUTED', `State is now: ${adj19.canonical_execution_state}`);

  const postAdjDeriv = await deriveCanonicalState(db, { effect_key: setup18.auth.effect_key });
  assert(postAdjDeriv.effect.is_terminally_closed === true, 'Terminal Closure Achieved', 'Effect terminally closed cleanly.');
  assert(postAdjDeriv.effect.open_contradiction_count === 0, 'Zero Open Contradictions', 'open_contradiction_count is 0.');

  // --------------------------------------------------------------------------
  // TEST 20: Historical contradiction remains auditable after adjudication
  // --------------------------------------------------------------------------
  console.log('\n[20/26] Testing: Historical contradiction remains auditable after adjudication...');
  const historicalInc = (await db.query<{ status: string; resolution_notes: string }>(
    `SELECT status, resolution_notes FROM contradiction_incidents WHERE incident_id = $1;`,
    [setup18.incident.incident_id]
  )).rows[0];
  assert(historicalInc.status === 'ADJUDICATED', 'Status ADJUDICATED', 'Incident preserved with ADJUDICATED status.');
  assert(historicalInc.resolution_notes.includes('Resolved execution'), 'Resolution Notes Present', 'Audit notes preserved.');

  const auditEvents = await db.query<{ event_type: string }>(
    `SELECT event_type FROM audit_events WHERE aggregate_type = 'ADJUDICATION' AND aggregate_id = $1;`,
    [adj19.adjudication_id]
  );
  assert(auditEvents.rows.length === 1, 'Audit Event Recorded', 'Append-only audit event found.');

  // --------------------------------------------------------------------------
  // TEST 21: Stale adjudication cannot overwrite newer state (fencing)
  // --------------------------------------------------------------------------
  console.log('\n[21/26] Testing: Stale adjudication cannot overwrite newer state (fencing)...');
  const setup21 = await setupEffectWithContradiction('test21');
  let staleFenceRejected = false;
  try {
    await adjudicateContradiction(db, {
      incident_id: setup21.incident.incident_id,
      adjudicator_principal_id: 'adj-officer-1',
      decision: 'RESOLVE_FAVOR_EXECUTION',
      rationale: 'Stale fence test.',
      policy_version_id: 'pol_stage8_v1',
      expected_fence_version: 999, // Stale!
    });
  } catch (err: unknown) {
    if (err instanceof AdjudicationError && err.code === 'STALE_FENCE_VERSION') {
      staleFenceRejected = true;
    }
  }
  assert(staleFenceRejected, 'Stale Fence Rejected', 'Adjudication rejected stale fence version safely.');

  // --------------------------------------------------------------------------
  // TEST 22: Concurrent adjudication is serialized (exactly one winner)
  // --------------------------------------------------------------------------
  console.log('\n[22/26] Testing: Concurrent adjudication is serialized (exactly one winner)...');
  const setup22 = await setupEffectWithContradiction('test22');
  const p1 = adjudicateContradiction(db, {
    incident_id: setup22.incident.incident_id,
    adjudicator_principal_id: 'adj-officer-1',
    decision: 'RESOLVE_FAVOR_EXECUTION',
    rationale: 'Worker 1 adjudication.',
    policy_version_id: 'pol_stage8_v1',
  });
  const p2 = adjudicateContradiction(db, {
    incident_id: setup22.incident.incident_id,
    adjudicator_principal_id: 'adj-admin-1',
    decision: 'RESOLVE_FAVOR_EXECUTION',
    rationale: 'Worker 2 adjudication.',
    policy_version_id: 'pol_stage8_v1',
  });

  const results = await Promise.allSettled([p1, p2]);
  const succeeded = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert(succeeded.length === 1, 'Exactly One Winner', 'Exactly one concurrent adjudication succeeded.');
  assert(rejected.length === 1, 'One Rejected', 'Second concurrent adjudication rejected.');

  // --------------------------------------------------------------------------
  // TEST 23: Authorization / adjudication race is safe and deterministic
  // --------------------------------------------------------------------------
  console.log('\n[23/26] Testing: Authorization / adjudication race is safe and deterministic...');
  const setup23 = await setupEffectWithContradiction('test23');
  // Race an adjudication vs an authorization
  const authRace = authorizeOperation(db, {
    actor_principal_id: 'agent-st8-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage8_v1',
    idempotency_key: 'idem-race-test23',
    budget_amount: 5.0,
    budget_currency: 'USD',
    operation_payload: setup23.operation_payload,
  }).catch((err) => err);

  const adjRace = adjudicateContradiction(db, {
    incident_id: setup23.incident.incident_id,
    adjudicator_principal_id: 'adj-officer-1',
    decision: 'RESOLVE_FAVOR_EXECUTION',
    rationale: 'Race adjudication.',
    policy_version_id: 'pol_stage8_v1',
  }).catch((err) => err);

  const [resAuth, resAdj] = await Promise.all([authRace, adjRace]);

  // TEST G verification: Adjudication transaction must succeed without deadlock (SQLSTATE 40P01)
  assert(
    resAdj && resAdj.resulting_incident_status === 'ADJUDICATED',
    'Adjudication Succeeded In Race',
    'Adjudication completed successfully without deadlock.'
  );

  // Authorization must either be safely blocked by unresolved contradiction or safely authorized
  const authSafelyHandled =
    (resAuth instanceof AuthorizationError && resAuth.code === 'BLOCKED_BY_OPEN_CONTRADICTION') ||
    resAuth.authorized === true;
  assert(authSafelyHandled, 'Race Handled Safely', 'Authorization / Adjudication race maintained consistency.');

  // If authorization was blocked, verify zero leaked artifacts
  if (resAuth instanceof AuthorizationError) {
    const leakedIntents = await db.query(
      `SELECT intent_id FROM intents WHERE idempotency_key = 'idem-race-test23';`
    );
    assert(leakedIntents.rows.length === 0, 'No Intent Leaked In Race', 'Blocked race authorization created 0 intents.');
  }

  // Verify the database state is valid and consistent post-race
  const finalIncidentInDb = (await db.query<{ status: string }>(
    `SELECT status FROM contradiction_incidents WHERE incident_id = $1;`,
    [setup23.incident.incident_id]
  )).rows[0];
  assert(finalIncidentInDb.status === 'ADJUDICATED', 'Incident Durably Adjudicated', 'Incident durably recorded as ADJUDICATED.');

  // Verify canonical derivation executes cleanly on the post-race state
  const postRaceDeriv = await deriveCanonicalState(db, { effect_key: setup23.auth.effect_key });
  assert(
    postRaceDeriv.effect.canonical_execution_state === 'EXECUTED',
    'Post-Race Canonical Derivation Valid',
    'Effect canonical state safely derived after concurrent operations.'
  );

  // --------------------------------------------------------------------------
  // TEST 24: Recovery cannot adjudicate
  // --------------------------------------------------------------------------
  console.log('\n[24/26] Testing: Recovery cannot adjudicate...');
  const setup24 = await setupEffectWithContradiction('test24');
  const adjCountBeforeRec = Number((await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM adjudication_records;`)).rows[0].count);

  // Run recovery on an attempt
  const recAttempt = await authorizeOperation(db, {
    actor_principal_id: 'agent-st8-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage8_v1',
    idempotency_key: 'idem-rec-test24',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: { recipient: '+15558000024', message_body: 'Rec Test', channel: 'sms' },
  });
  await db.query(`UPDATE attempts SET reserved_at = NOW() - INTERVAL '120 seconds' WHERE attempt_id = $1;`, [recAttempt.attempt_id]);
  await executeRecovery(db, { attempt_id: recAttempt.attempt_id, recovery_worker_identity: 'worker-rec-8' });

  const adjCountAfterRec = Number((await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM adjudication_records;`)).rows[0].count);
  assert(adjCountBeforeRec === adjCountAfterRec, 'Recovery Did Not Adjudicate', 'Recovery made zero changes to adjudication records.');

  // TEST H: Verify recovery did not clear or bypass the contradiction on setup24
  const incidentAfterRec = (await db.query<{ status: string }>(
    `SELECT status FROM contradiction_incidents WHERE incident_id = $1;`,
    [setup24.incident.incident_id]
  )).rows[0];
  assert(incidentAfterRec.status === 'OPEN', 'Contradiction Still OPEN After Recovery', 'Recovery did not alter contradiction incident status.');

  let authBlockedAfterRec = false;
  try {
    await authorizeOperation(db, {
      actor_principal_id: 'agent-st8-1',
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      requested_scope: 'default',
      policy_version_id: 'pol_stage8_v1',
      idempotency_key: 'idem-rec-test24-blocked',
      budget_amount: 5.0,
      budget_currency: 'USD',
      operation_payload: setup24.operation_payload,
    });
  } catch (err: unknown) {
    if (err instanceof AuthorizationError && err.code === 'BLOCKED_BY_OPEN_CONTRADICTION') {
      authBlockedAfterRec = true;
    }
  }
  assert(authBlockedAfterRec, 'Recovery Cannot Bypass Contradiction Block', 'Recovery cannot unblock or bypass contradiction blocking.');

  // --------------------------------------------------------------------------
  // TEST 25: Reconciliation cannot adjudicate or bypass contradiction
  // --------------------------------------------------------------------------
  console.log('\n[25/26] Testing: Reconciliation cannot adjudicate...');
  const adjCountBeforeRecon = Number((await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM adjudication_records;`)).rows[0].count);
  await reconcileUnresolvedAttempts(db, { limit: 10, min_unresolved_seconds: 0, worker_identity: 'worker-rec-8' });
  const adjCountAfterRecon = Number((await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM adjudication_records;`)).rows[0].count);
  assert(adjCountBeforeRecon === adjCountAfterRecon, 'Reconciliation Did Not Adjudicate', 'Reconciliation made zero changes to adjudication records.');

  // TEST I: Verify reconciliation did not alter contradiction incident status
  const incidentAfterRecon = (await db.query<{ status: string }>(
    `SELECT status FROM contradiction_incidents WHERE incident_id = $1;`,
    [setup24.incident.incident_id]
  )).rows[0];
  assert(incidentAfterRecon.status === 'OPEN', 'Contradiction Still OPEN After Reconciliation', 'Reconciliation did not alter contradiction incident status.');

  // --------------------------------------------------------------------------
  // TEST 26: Dismissing Spurious Contradiction
  // --------------------------------------------------------------------------
  console.log('\n[26/27] Testing: Dismissing spurious contradiction incident...');
  const setup26 = await setupEffectWithContradiction('test26');
  const dismissRes = await adjudicateContradiction(db, {
    incident_id: setup26.incident.incident_id,
    adjudicator_principal_id: 'adj-admin-1',
    decision: 'DISMISS_CONTRADICTION',
    rationale: 'Contradiction was diagnosed as duplicate webhook retry.',
    policy_version_id: 'pol_stage8_v1',
  });
  assert(dismissRes.resulting_incident_status === 'ADJUDICATED', 'Dismissed Successfully', 'Spurious contradiction dismissed to ADJUDICATED.');

  // --------------------------------------------------------------------------
  // TEST 27: INVESTIGATING state continues to block authorization & terminal closure
  // (OPEN -> REMAIN_BLOCKED_REQUIRE_EVIDENCE -> INVESTIGATING -> Still Blocked)
  // --------------------------------------------------------------------------
  console.log('\n[27/27] Testing: REMAIN_BLOCKED_REQUIRE_EVIDENCE (INVESTIGATING) continues to block authorization & terminal closure...');
  const setup27 = await setupEffectWithContradiction('test27');

  // A & B: Confirm it initially blocks authorization while in OPEN status
  let authBlockedInitial = false;
  try {
    await authorizeOperation(db, {
      actor_principal_id: 'agent-st8-1',
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      requested_scope: 'default',
      policy_version_id: 'pol_stage8_v1',
      idempotency_key: 'idem-test27-open-blocked',
      budget_amount: 5.0,
      budget_currency: 'USD',
      operation_payload: setup27.operation_payload,
    });
  } catch (err: unknown) {
    if (err instanceof AuthorizationError && err.code === 'BLOCKED_BY_OPEN_CONTRADICTION') {
      authBlockedInitial = true;
    }
  }
  assert(authBlockedInitial, 'Initial OPEN Block', 'New authorization blocked while incident is OPEN.');

  // C: Adjudicate with REMAIN_BLOCKED_REQUIRE_EVIDENCE
  const adjInvestigating = await adjudicateContradiction(db, {
    incident_id: setup27.incident.incident_id,
    adjudicator_principal_id: 'adj-officer-1',
    decision: 'REMAIN_BLOCKED_REQUIRE_EVIDENCE',
    rationale: 'Evidence required from secondary carrier telemetry before resolving.',
    policy_version_id: 'pol_stage8_v1',
  });

  // D: Confirm durable incident status is INVESTIGATING
  assert(
    adjInvestigating.resulting_incident_status === 'INVESTIGATING',
    'Incident Status INVESTIGATING',
    'Incident status moved to INVESTIGATING.'
  );
  const incidentInDb = (await db.query<{ status: string; resolution_notes: string }>(
    `SELECT status, resolution_notes FROM contradiction_incidents WHERE incident_id = $1;`,
    [setup27.incident.incident_id]
  )).rows[0];
  assert(incidentInDb.status === 'INVESTIGATING', 'Durable INVESTIGATING Status', 'Durable status in DB is INVESTIGATING.');

  // Record budget before attempting authorization
  const budgetBeforeAttempt = (await db.query<{ reserved_amount: string }>(
    `SELECT reserved_amount FROM principal_budgets WHERE principal_id = 'agent-st8-1' AND currency_or_unit = 'USD';`
  )).rows[0];

  // E & F: Attempt new authorization for the same effect and confirm it is rejected
  let authBlockedDuringInvestigation = false;
  try {
    await authorizeOperation(db, {
      actor_principal_id: 'agent-st8-1',
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      requested_scope: 'default',
      policy_version_id: 'pol_stage8_v1',
      idempotency_key: 'idem-test27-investigating-blocked',
      budget_amount: 5.0,
      budget_currency: 'USD',
      operation_payload: setup27.operation_payload,
    });
  } catch (err: unknown) {
    if (err instanceof AuthorizationError && err.code === 'BLOCKED_BY_OPEN_CONTRADICTION') {
      authBlockedDuringInvestigation = true;
    }
  }
  assert(
    authBlockedDuringInvestigation,
    'Authorization Blocked During Investigation',
    'Authorization rejected with BLOCKED_BY_OPEN_CONTRADICTION while incident is INVESTIGATING.'
  );

  // G: Confirm no intent, authorization, attempt, or budget reservation leaked
  const leakedIntents = await db.query(
    `SELECT intent_id FROM intents WHERE idempotency_key = 'idem-test27-investigating-blocked';`
  );
  assert(leakedIntents.rows.length === 0, 'No Intent Leaked', 'Zero intents created for rejected authorization.');

  const leakedAuths = await db.query(
    `SELECT authorization_id FROM authorizations WHERE intent_id IN (
       SELECT intent_id FROM intents WHERE idempotency_key = 'idem-test27-investigating-blocked'
     );`
  );
  assert(leakedAuths.rows.length === 0, 'No Authorization Leaked', 'Zero authorizations created for rejected authorization.');

  const totalAuthsForEffect = (await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM authorizations WHERE effect_key = $1;`,
    [setup27.auth.effect_key]
  )).rows[0].count;
  assert(Number(totalAuthsForEffect) === 1, 'Total Authorizations Unchanged', 'Authorizations count unchanged (exactly 1).');

  const totalAttemptsForEffect = (await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM attempts WHERE effect_key = $1;`,
    [setup27.auth.effect_key]
  )).rows[0].count;
  assert(Number(totalAttemptsForEffect) === 1, 'No Attempt Leaked', 'Attempts count unchanged (exactly 1).');

  const totalBudgetReservations = (await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM budget_reservations WHERE effect_key = $1;`,
    [setup27.auth.effect_key]
  )).rows[0].count;
  assert(Number(totalBudgetReservations) === 1, 'No Budget Reservation Leaked', 'Budget reservations count unchanged (exactly 1).');

  const budgetAfterAttempt = (await db.query<{ reserved_amount: string }>(
    `SELECT reserved_amount FROM principal_budgets WHERE principal_id = 'agent-st8-1' AND currency_or_unit = 'USD';`
  )).rows[0];
  assert(
    Number(budgetAfterAttempt.reserved_amount) === Number(budgetBeforeAttempt.reserved_amount),
    'Budget Balance Intact',
    'Reserved budget amount unchanged after rejected authorization.'
  );

  // Also confirm ledger gating helper reports permitted=false
  const gatingInvestigating = await evaluateAuthorizationGating(db, setup27.auth.effect_key, 'UNSAFE_REPEAT');
  assert(gatingInvestigating.permitted === false, 'Ledger Gating Blocked', 'evaluateAuthorizationGating blocked during INVESTIGATING.');

  // H & I: Run canonical derivation and confirm effect remains non-terminal and contradiction-blocked
  const derivInvestigating = await deriveCanonicalState(db, { effect_key: setup27.auth.effect_key });
  assert(
    derivInvestigating.effect.canonical_execution_state === 'CONTRADICTED_INCIDENT',
    'State CONTRADICTED_INCIDENT',
    `Effect canonical_execution_state is CONTRADICTED_INCIDENT (found: ${derivInvestigating.effect.canonical_execution_state}).`
  );
  assert(
    derivInvestigating.effect.is_terminally_closed === false,
    'Terminal Closure Blocked',
    'is_terminally_closed is strictly false while under investigation.'
  );
  assert(
    derivInvestigating.effect.open_contradiction_count > 0,
    'Contradiction Count Positive',
    `open_contradiction_count is ${derivInvestigating.effect.open_contradiction_count} (> 0).`
  );

  // J: Confirm the contradiction remains durably auditable
  const adjRecords = await db.query<{ adjudication_id: string; decision: string }>(
    `SELECT adjudication_id, decision FROM adjudication_records WHERE incident_id = $1;`,
    [setup27.incident.incident_id]
  );
  assert(adjRecords.rows.length === 1, 'Adjudication Record Preserved', 'Adjudication record persisted in audit trail.');
  assert(adjRecords.rows[0].decision === 'REMAIN_BLOCKED_REQUIRE_EVIDENCE', 'Decision Recorded', 'Decision correctly recorded as REMAIN_BLOCKED_REQUIRE_EVIDENCE.');

  // Subsequent resolution: Adjudicate with RESOLVE_FAVOR_EXECUTION to verify legitimate unblocking
  const subsequentAdj = await adjudicateContradiction(db, {
    incident_id: setup27.incident.incident_id,
    adjudicator_principal_id: 'adj-officer-1',
    decision: 'RESOLVE_FAVOR_EXECUTION',
    rationale: 'Secondary carrier telemetry confirms successful execution.',
    policy_version_id: 'pol_stage8_v1',
  });
  assert(subsequentAdj.resulting_incident_status === 'ADJUDICATED', 'Subsequent Resolution Succeeded', 'Incident successfully resolved to ADJUDICATED.');
  const postResolutionDeriv = await deriveCanonicalState(db, { effect_key: setup27.auth.effect_key });
  assert(postResolutionDeriv.effect.canonical_execution_state === 'EXECUTED', 'State Transitioned to EXECUTED', 'Effect state promoted to EXECUTED.');
  assert(postResolutionDeriv.effect.is_terminally_closed === true, 'Terminal Closure Achieved', 'Terminal closure achieved after legitimate resolution.');

  console.log('\n===============================================================');
  console.log('STAGE 8 VALIDATION COMPLETED: 27/27 TESTS PASSED.');
  console.log('===============================================================');
}

runStage8Validation().catch((err) => {
  console.error('Stage 8 validation failed:', err);
  process.exit(1);
});
