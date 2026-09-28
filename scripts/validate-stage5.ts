/**
 * @file scripts/validate-stage5.ts
 * Validation suite for Stage 5: Immutable Evidence Ingestion & Claim-Specific Correlation.
 *
 * Verifies all 17 required Stage 5 invariants and behaviors:
 *  1. Valid evidence is persisted cleanly in evidence_records.
 *  2. Evidence is immutable: database trigger strictly rejects UPDATE on evidence_records.
 *  3. Evidence is immutable: database trigger strictly rejects DELETE on evidence_records.
 *  4. Duplicate evidence with same stable source_event_id is idempotent (no duplicate rows, is_duplicate: true).
 *  5. client_correlation_id correctly correlates to the exact attempt.
 *  6. provider_assigned_id correctly correlates to the exact attempt when contract-authorized.
 *  7. provider_dedup_identity alone CANNOT identify an attempt (yields UNCORRELATED, attempt_id: null).
 *  8. Mandatory SAFE_REPEAT test: Shared provider_dedup_identity does NOT attach evidence to wrong cycle.
 *  9. Uncorrelatable evidence is NOT guessed onto an attempt (never attaches to "latest attempt").
 * 10. ACCEPTED evidence does not automatically establish EXECUTED.
 * 11. Provider timeout cannot establish CONFIRMED_NEVER_WILL_EXECUTE.
 * 12. Provider failure cannot establish CONFIRMED_NEVER_WILL_EXECUTE.
 * 13. RECOVERY_RELEASED cannot create evidence (fails closed).
 * 14. Evidence ingestion cannot modify authorizations or budget reservations.
 * 15. Evidence ingestion cannot dispatch anything (0 provider calls, 0 dispatch claims).
 * 16. Contradictory evidence is preserved in evidence_records rather than overwritten, logging an incident.
 * 17. Execution evidence cannot subsequently be erased by conflicting evidence.
 */

import { PGlite } from '@electric-sql/pglite';
import { createFreshDb, applySchema, seedMockCapabilityContract } from '../src/db/database.ts';
import { authorizeOperation } from '../src/authorization/authorizeOperation.ts';
import { executeDispatch } from '../src/dispatch/executeDispatch.ts';
import { MockSendMessageProvider } from '../src/dispatch/mockProvider.ts';
import { ingestEvidence } from '../src/evidence/ingestEvidence.ts';
import { EvidenceError } from '../src/evidence/types.ts';

function assert(condition: boolean, testName: string, detail?: string): void {
  if (!condition) {
    console.error(`  [FAIL] ${testName}: ${detail ?? 'Assertion failed'}`);
    process.exit(1);
  }
  console.log(`  [PASS] ${testName}: ${detail ?? 'Verified'}`);
}

async function runStage5Validation() {
  console.log('===============================================================');
  console.log('STARTING STAGE 5 IMMUTABLE EVIDENCE INGESTION VALIDATION');
  console.log('===============================================================');

  const db = await createFreshDb();
  await applySchema(db);
  await seedMockCapabilityContract(db);

  // Setup testing principals, budgets, and policies
  await db.exec(`
    INSERT INTO principals (principal_id, type, name, status, metadata)
    VALUES ('agent-evidence-1', 'AGENT', 'Evidence Agent 1', 'ACTIVE', '{"scopes": ["*"]}'::jsonb),
           ('agent-evidence-2', 'AGENT', 'Evidence Agent 2', 'ACTIVE', '{"scopes": ["*"]}'::jsonb)
    ON CONFLICT (principal_id) DO NOTHING;

    INSERT INTO principal_budgets (principal_id, currency_or_unit, budget_limit, reserved_amount)
    VALUES ('agent-evidence-1', 'USD', 1000.0, 0.0),
           ('agent-evidence-2', 'USD', 1000.0, 0.0)
    ON CONFLICT (principal_id, currency_or_unit) DO NOTHING;

    INSERT INTO policy_versions (policy_version_id, policy_name, version, is_active, rules_definition)
    VALUES ('pol_stage5_v1', 'stage5_policy', '1.0.0', true, '{"max_retries": 3}'::jsonb)
    ON CONFLICT (policy_version_id) DO NOTHING;
  `);

  const mockProvider = new MockSendMessageProvider('mock.send_message');

  // Setup Attempt 1
  const auth1 = await authorizeOperation(db, {
    actor_principal_id: 'agent-evidence-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage5_v1',
    idempotency_key: 'idem-st5-test-1',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15551112222',
      message_body: 'Evidence test message 1',
      channel: 'sms',
    },
  });

  const dispatch1 = await executeDispatch(
    db,
    {
      effect_key: auth1.effect_key,
      cycle_number: auth1.cycle_number,
      attempt_id: auth1.attempt_id,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-evidence-1',
    },
    mockProvider
  );

  // --------------------------------------------------------------------------
  // TEST 1: Valid Evidence is Persisted
  // --------------------------------------------------------------------------
  console.log('\n[1/17] Testing: Valid evidence is persisted in evidence_records...');
  const ev1 = await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'PROVIDER_ACCEPTED',
    claim_semantics: 'ACCEPTED',
    source_channel: 'MOCK_PROVIDER_CALLBACK',
    client_correlation_id: auth1.client_correlation_id,
    raw_payload: { delivery_status: 'QUEUED', queue_latency_ms: 12 },
  });

  assert(ev1.correlated === true, 'Evidence Correlated', 'Correlated via client_correlation_id.');
  assert(ev1.attempt_id === auth1.attempt_id, 'Attempt Matched', `Matched attempt '${auth1.attempt_id}'.`);
  assert(ev1.claim_semantics === 'ACCEPTED', 'Claim Semantics Recorded', "Claim semantics is 'ACCEPTED'.");

  const evDb1 = await db.query<{ count: string }>(
    `SELECT count(*) FROM evidence_records WHERE evidence_id = $1;`,
    [ev1.evidence_id]
  );
  assert(parseInt(evDb1.rows[0].count) === 1, 'Persisted in Database', 'Evidence record found in database.');

  // --------------------------------------------------------------------------
  // TEST 2: Evidence is Immutable (Database Trigger Rejects UPDATE)
  // --------------------------------------------------------------------------
  console.log('\n[2/17] Testing: Database trigger rejects UPDATE on evidence_records...');
  let updateRejected = false;
  try {
    await db.query(
      `UPDATE evidence_records SET claim_semantics = 'EXECUTED' WHERE evidence_id = $1;`,
      [ev1.evidence_id]
    );
  } catch (err: unknown) {
    updateRejected = true;
    console.log('  Confirmed rejection of UPDATE on evidence_records:', (err as Error).message);
  }
  assert(
    updateRejected,
    'Database Immutability (UPDATE Rejected)',
    'Trigger trg_evidence_append_only strictly rejected UPDATE.'
  );

  // --------------------------------------------------------------------------
  // TEST 3: Evidence is Immutable (Database Trigger Rejects DELETE)
  // --------------------------------------------------------------------------
  console.log('\n[3/17] Testing: Database trigger rejects DELETE on evidence_records...');
  let deleteRejected = false;
  try {
    await db.query(
      `DELETE FROM evidence_records WHERE evidence_id = $1;`,
      [ev1.evidence_id]
    );
  } catch (err: unknown) {
    deleteRejected = true;
    console.log('  Confirmed rejection of DELETE on evidence_records:', (err as Error).message);
  }
  assert(
    deleteRejected,
    'Database Immutability (DELETE Rejected)',
    'Trigger trg_evidence_append_only strictly rejected DELETE.'
  );

  // --------------------------------------------------------------------------
  // TEST 4: Duplicate Evidence Handling (Idempotent via source_event_id)
  // --------------------------------------------------------------------------
  console.log('\n[4/17] Testing: Duplicate delivery with same source_event_id is idempotent...');
  const countBefore = await db.query<{ count: string }>(`SELECT count(*) FROM evidence_records;`);

  const ev4a = await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'PROVIDER_ACCEPTED',
    claim_semantics: 'ACCEPTED',
    source_channel: 'WEBHOOK',
    source_event_id: 'evt_unique_webhook_123',
    client_correlation_id: auth1.client_correlation_id,
    raw_payload: { event: 'delivery_queued' },
  });
  assert(ev4a.is_duplicate === false, 'First Delivery', 'First ingestion returned is_duplicate = false.');

  // Ingest identical evidence with same source_event_id
  const ev4b = await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'PROVIDER_ACCEPTED',
    claim_semantics: 'ACCEPTED',
    source_channel: 'WEBHOOK',
    source_event_id: 'evt_unique_webhook_123',
    client_correlation_id: auth1.client_correlation_id,
    raw_payload: { event: 'delivery_queued' },
  });
  assert(ev4b.is_duplicate === true, 'Duplicate Detected', 'Second ingestion returned is_duplicate = true.');
  assert(ev4b.evidence_id === ev4a.evidence_id, 'Same Logical Evidence', 'Returned identical evidence ID.');

  const countAfter = await db.query<{ count: string }>(`SELECT count(*) FROM evidence_records;`);
  assert(
    parseInt(countAfter.rows[0].count) === parseInt(countBefore.rows[0].count) + 1,
    'Zero Duplicate Rows',
    'Exactly 1 row was inserted for the idempotent source_event_id.'
  );

  // --------------------------------------------------------------------------
  // TEST 5: client_correlation_id Correctly Correlates to Exact Attempt
  // --------------------------------------------------------------------------
  console.log('\n[5/17] Testing: client_correlation_id correlates to exact attempt...');
  const ev5 = await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'EXECUTION_CONFIRMED',
    claim_semantics: 'EXECUTED',
    source_channel: 'STATUS_POLL',
    client_correlation_id: auth1.client_correlation_id,
    raw_payload: { delivered_at: new Date().toISOString() },
  });
  assert(
    ev5.correlation_method === 'CLIENT_CORRELATION_ID_MATCH',
    'Correlation Method Match',
    "correlation_method is 'CLIENT_CORRELATION_ID_MATCH'."
  );
  assert(
    ev5.attempt_id === auth1.attempt_id,
    'Exact Attempt Bound',
    `Bound to attempt '${auth1.attempt_id}'.`
  );

  // --------------------------------------------------------------------------
  // TEST 6: provider_assigned_id Correlates When Contract-Authorized
  // --------------------------------------------------------------------------
  console.log('\n[6/17] Testing: provider_assigned_id correlates when contract-authorized...');
  const assignedId = dispatch1.provider_assigned_id;
  assert(assignedId !== null, 'Assigned ID Present', `Dispatch 1 generated assigned ID '${assignedId}'.`);

  const ev6 = await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'EXECUTION_CONFIRMED',
    claim_semantics: 'EXECUTED',
    source_channel: 'STATUS_POLL',
    provider_assigned_id: assignedId,
    raw_payload: { status: 'DELIVERED', receipt: assignedId },
  });
  assert(
    ev6.correlation_method === 'PROVIDER_ASSIGNED_ID_LOOKUP',
    'Provider Assigned ID Lookup',
    "correlation_method is 'PROVIDER_ASSIGNED_ID_LOOKUP'."
  );
  assert(
    ev6.attempt_id === auth1.attempt_id,
    'Exact Attempt Matched via Provider ID',
    `Resolved attempt '${auth1.attempt_id}' via provider assigned ID.`
  );

  // --------------------------------------------------------------------------
  // TEST 7: provider_dedup_identity Alone CANNOT Identify An Attempt
  // --------------------------------------------------------------------------
  console.log('\n[7/17] Testing: provider_dedup_identity alone CANNOT identify an attempt...');
  const ev7 = await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'EXECUTION_CONFIRMED',
    claim_semantics: 'EXECUTED',
    source_channel: 'GENERIC_LOG',
    provider_dedup_identity: auth1.provider_dedup_identity, // ONLY dedup ID supplied
    raw_payload: { note: 'Dedup token observed' },
  });
  assert(
    ev7.correlated === false,
    'Uncorrelated Dedup Identity',
    'provider_dedup_identity alone cannot correlate to an attempt.'
  );
  assert(
    ev7.correlation_method === 'UNCORRELATED',
    'Uncorrelated Method',
    "correlation_method is 'UNCORRELATED'."
  );
  assert(
    ev7.attempt_id === null,
    'Null Attempt ID',
    'attempt_id is NULL; system refused to guess an attempt from dedup identity.'
  );

  // --------------------------------------------------------------------------
  // TEST 8: MANDATORY TEST — SAFE_REPEAT Shared Dedup Identity Cannot Conflate Cycles
  // --------------------------------------------------------------------------
  console.log('\n[8/17] Testing: MANDATORY SAFE_REPEAT test (Attempt A vs B with shared dedup identity)...');
  // Attempt A was cycle 1 above (auth1).
  // Now authorize cycle 2 (Attempt B) for the exact same effect under SAFE_REPEAT.
  const auth8b = await authorizeOperation(db, {
    actor_principal_id: 'agent-evidence-1',
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    requested_scope: 'default',
    policy_version_id: 'pol_stage5_v1',
    idempotency_key: 'idem-st5-test-8-cycle2',
    budget_amount: 1.0,
    budget_currency: 'USD',
    operation_payload: {
      recipient: '+15551112222',
      message_body: 'Evidence test message 1',
      channel: 'sms',
    },
  });

  const dispatch8b = await executeDispatch(
    db,
    {
      effect_key: auth8b.effect_key,
      cycle_number: auth8b.cycle_number,
      attempt_id: auth8b.attempt_id,
      expected_fence_version: 1,
      dispatcher_identity: 'worker-evidence-2',
    },
    mockProvider
  );

  // Confirm Attempt A and Attempt B share provider_dedup_identity, but have distinct client_correlation_ids
  assert(
    auth1.provider_dedup_identity === auth8b.provider_dedup_identity,
    'Shared Dedup Identity',
    'Attempt A and Attempt B share the identical provider_dedup_identity.'
  );
  assert(
    auth1.client_correlation_id !== auth8b.client_correlation_id,
    'Distinct Client Correlation IDs',
    'Attempt A and Attempt B have distinct client_correlation_ids.'
  );

  // Now receive evidence specifically specifying client_correlation_id for Attempt A
  const ev8 = await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'EXECUTION_CONFIRMED',
    claim_semantics: 'EXECUTED',
    source_channel: 'CARRIER_DLR',
    client_correlation_id: auth1.client_correlation_id,
    raw_payload: { carrier_status: 'DELIVRD', cycle: 1 },
  });

  // Verify: MUST attach strictly to Attempt A; MUST NOT attach to Attempt B
  assert(
    ev8.attempt_id === auth1.attempt_id,
    'Strict Attempt A Attribution',
    `Evidence correlated strictly to Attempt A ('${auth1.attempt_id}').`
  );
  assert(
    ev8.attempt_id !== auth8b.attempt_id,
    'Not Conflated With Attempt B',
    `Evidence was NOT attached to Attempt B ('${auth8b.attempt_id}') despite sharing provider_dedup_identity.`
  );

  // --------------------------------------------------------------------------
  // TEST 9: Uncorrelatable Evidence Is NOT Guessed Onto An Attempt
  // --------------------------------------------------------------------------
  console.log('\n[9/17] Testing: Uncorrelatable evidence is stored as UNCORRELATED without guessing...');
  const ev9 = await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'EXECUTION_CONFIRMED',
    claim_semantics: 'EXECUTED',
    source_channel: 'ANONYMOUS_WEBHOOK',
    client_correlation_id: 'corr_does_not_exist_9999',
    raw_payload: { msg: 'Random uncorrelatable carrier receipt' },
  });
  assert(ev9.correlated === false, 'Not Correlated', 'Flagged as correlated = false.');
  assert(ev9.correlation_method === 'UNCORRELATED', 'Uncorrelated Method', "correlation_method is 'UNCORRELATED'.");
  assert(ev9.attempt_id === null, 'No Attempt Guessed', 'attempt_id is NULL. Did not guess most recent attempt.');

  // --------------------------------------------------------------------------
  // TEST 10: ACCEPTED Evidence Does Not Automatically Become EXECUTED
  // --------------------------------------------------------------------------
  console.log('\n[10/17] Testing: ACCEPTED evidence cannot claim EXECUTED semantics...');
  let acceptedAsExecutedRejected = false;
  try {
    await ingestEvidence(db, {
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      evidence_type: 'PROVIDER_ACCEPTED',
      claim_semantics: 'EXECUTED', // Illegal promotion!
      source_channel: 'PROVIDER_CALLBACK',
      client_correlation_id: auth1.client_correlation_id,
      raw_payload: { status: 'ACCEPTED' },
    });
  } catch (err: unknown) {
    if (err instanceof EvidenceError && err.code === 'INVALID_CLAIM_SEMANTICS') {
      acceptedAsExecutedRejected = true;
    }
  }
  assert(
    acceptedAsExecutedRejected,
    'Accepted != Executed',
    'System rejected attempt to claim EXECUTED semantics on PROVIDER_ACCEPTED evidence.'
  );

  // --------------------------------------------------------------------------
  // TEST 11: Provider Timeout Cannot Establish CONFIRMED_NEVER_WILL_EXECUTE
  // --------------------------------------------------------------------------
  console.log('\n[11/17] Testing: Provider timeout cannot establish CONFIRMED_NEVER_WILL_EXECUTE...');
  let timeoutAsNeverExecutedRejected = false;
  try {
    await ingestEvidence(db, {
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      evidence_type: 'PROVIDER_TIMEOUT',
      claim_semantics: 'CONFIRMED_NEVER_WILL_EXECUTE', // Illegal derivation!
      source_channel: 'TIMEOUT_MONITOR',
      client_correlation_id: auth1.client_correlation_id,
      raw_payload: { error: 'Gateway timeout' },
    });
  } catch (err: unknown) {
    if (err instanceof EvidenceError && err.code === 'INVALID_CLAIM_SEMANTICS') {
      timeoutAsNeverExecutedRejected = true;
    }
  }
  assert(
    timeoutAsNeverExecutedRejected,
    'Timeout != Never Execute',
    'System rejected deriving CONFIRMED_NEVER_WILL_EXECUTE from PROVIDER_TIMEOUT.'
  );

  // --------------------------------------------------------------------------
  // TEST 12: Provider Failure Cannot Establish CONFIRMED_NEVER_WILL_EXECUTE
  // --------------------------------------------------------------------------
  console.log('\n[12/17] Testing: Provider transport failure cannot establish CONFIRMED_NEVER_WILL_EXECUTE...');
  let failureAsNeverExecutedRejected = false;
  try {
    await ingestEvidence(db, {
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      evidence_type: 'UNKNOWN_DISPATCH_FAILURE',
      claim_semantics: 'CONFIRMED_NEVER_WILL_EXECUTE', // Illegal derivation!
      source_channel: 'TRANSPORT_MONITOR',
      client_correlation_id: auth1.client_correlation_id,
      raw_payload: { error: 'Connection reset by peer' },
    });
  } catch (err: unknown) {
    if (err instanceof EvidenceError && err.code === 'INVALID_CLAIM_SEMANTICS') {
      failureAsNeverExecutedRejected = true;
    }
  }
  assert(
    failureAsNeverExecutedRejected,
    'Failure != Never Execute',
    'System rejected deriving CONFIRMED_NEVER_WILL_EXECUTE from UNKNOWN_DISPATCH_FAILURE.'
  );

  // --------------------------------------------------------------------------
  // TEST 13: RECOVERY_RELEASED Cannot Create Evidence
  // --------------------------------------------------------------------------
  console.log('\n[13/17] Testing: RECOVERY_RELEASED cannot create evidence...');
  let recoveryEvidenceRejected = false;
  try {
    await ingestEvidence(db, {
      capability_id: 'mock.send_message',
      capability_version: '1.0.0',
      evidence_type: 'NON_EXECUTION_CONFIRMED',
      claim_semantics: 'CONFIRMED_NEVER_WILL_EXECUTE',
      source_channel: 'RECOVERY_RELEASED', // Prohibited source!
      client_correlation_id: auth1.client_correlation_id,
      raw_payload: { reason: 'Recovery released the attempt' },
    });
  } catch (err: unknown) {
    if (err instanceof EvidenceError && err.code === 'RECOVERY_RELEASED_NOT_EVIDENCE') {
      recoveryEvidenceRejected = true;
    }
  }
  assert(
    recoveryEvidenceRejected,
    'Recovery Released Boundary Enforced',
    'System rejected creating evidence citing RECOVERY_RELEASED as source.'
  );

  // --------------------------------------------------------------------------
  // TEST 14: Evidence Ingestion Cannot Modify Authorizations or Budgets
  // --------------------------------------------------------------------------
  console.log('\n[14/17] Testing: Evidence ingestion cannot modify authorizations or budgets...');
  const authBefore = await db.query<{ authorization_status: string }>(
    `SELECT authorization_status FROM authorizations WHERE authorization_id = $1;`,
    [auth1.authorization_id]
  );
  const budgetBefore = await db.query<{ reserved_amount: string }>(
    `SELECT reserved_amount FROM principal_budgets WHERE principal_id = $1;`,
    ['agent-evidence-1']
  );

  // Ingest confirmation evidence
  await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'EXECUTION_CONFIRMED',
    claim_semantics: 'EXECUTED',
    source_channel: 'STATUS_POLL',
    client_correlation_id: auth1.client_correlation_id,
    raw_payload: { status: 'DELIVERED' },
  });

  const authAfter = await db.query<{ authorization_status: string }>(
    `SELECT authorization_status FROM authorizations WHERE authorization_id = $1;`,
    [auth1.authorization_id]
  );
  const budgetAfter = await db.query<{ reserved_amount: string }>(
    `SELECT reserved_amount FROM principal_budgets WHERE principal_id = $1;`,
    ['agent-evidence-1']
  );

  assert(
    authBefore.rows[0].authorization_status === authAfter.rows[0].authorization_status,
    'Authorization Untouched',
    `Authorization status remained '${authAfter.rows[0].authorization_status}'.`
  );
  assert(
    budgetBefore.rows[0].reserved_amount === budgetAfter.rows[0].reserved_amount,
    'Budget Untouched',
    `Budget reserved_amount remained '${budgetAfter.rows[0].reserved_amount}'.`
  );

  // --------------------------------------------------------------------------
  // TEST 15: Evidence Ingestion Cannot Dispatch Anything
  // --------------------------------------------------------------------------
  console.log('\n[15/17] Testing: Evidence ingestion cannot dispatch anything...');
  mockProvider.resetCalls();
  const claimsBefore = await db.query<{ count: string }>(`SELECT count(*) FROM dispatch_claims;`);

  await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'RECONCILIATION_REPORT',
    claim_semantics: 'ACCEPTED',
    source_channel: 'RECONCILIATION_SCAN',
    client_correlation_id: auth1.client_correlation_id,
    raw_payload: { scan_id: 'scan_001', match: true },
  });

  const claimsAfter = await db.query<{ count: string }>(`SELECT count(*) FROM dispatch_claims;`);

  assert(mockProvider.getCallCount() === 0, 'Zero Provider Calls', 'Provider adapter was NOT called.');
  assert(
    claimsBefore.rows[0].count === claimsAfter.rows[0].count,
    'Zero Dispatch Claims Created',
    'No dispatch claims created by evidence ingestion.'
  );

  // --------------------------------------------------------------------------
  // TEST 16: Contradictory Evidence is Preserved Rather Than Overwritten
  // --------------------------------------------------------------------------
  console.log('\n[16/17] Testing: Contradictory evidence is preserved and logged as incident...');
  // Effect already has EXECUTED evidence from tests above.
  // Now ingest a contradictory evidence claiming NON_EXECUTION_CONFIRMED.
  const evConflict = await ingestEvidence(db, {
    capability_id: 'mock.send_message',
    capability_version: '1.0.0',
    evidence_type: 'NON_EXECUTION_CONFIRMED',
    claim_semantics: 'CONFIRMED_NEVER_WILL_EXECUTE',
    source_channel: 'AUDIT_INVESTIGATION',
    client_correlation_id: auth1.client_correlation_id,
    raw_payload: { investigation: 'Audit log states message bounced permanently before delivery' },
  });

  assert(
    evConflict.contradiction_detected === true,
    'Contradiction Detected',
    'Contradiction with prior EXECUTED evidence was detected.'
  );
  assert(
    evConflict.contradiction_incident_id !== null,
    'Incident Logged',
    `Created contradiction incident '${evConflict.contradiction_incident_id}'.`
  );

  // Verify BOTH evidence records coexist in the database!
  const allEvidenceForAuth1 = await db.query<{ evidence_id: string; evidence_type: string; claim_semantics: string }>(
    `SELECT evidence_id, evidence_type, claim_semantics FROM evidence_records WHERE attempt_id = $1 ORDER BY recorded_at ASC;`,
    [auth1.attempt_id]
  );
  const typesRecorded = allEvidenceForAuth1.rows.map((r) => r.claim_semantics);
  assert(
    typesRecorded.includes('EXECUTED') && typesRecorded.includes('CONFIRMED_NEVER_WILL_EXECUTE'),
    'Both Records Coexist',
    `Found both 'EXECUTED' and 'CONFIRMED_NEVER_WILL_EXECUTE' in evidence_records (${typesRecorded.length} total records).`
  );

  // --------------------------------------------------------------------------
  // TEST 17: Execution Evidence Cannot Be Erased By Conflicting Evidence
  // --------------------------------------------------------------------------
  console.log('\n[17/17] Testing: Execution evidence cannot be erased or overwritten...');
  const executedRecords = await db.query<{ count: string }>(
    `SELECT count(*) FROM evidence_records WHERE attempt_id = $1 AND claim_semantics = 'EXECUTED';`,
    [auth1.attempt_id]
  );
  assert(
    parseInt(executedRecords.rows[0].count) >= 1,
    'Historical Execution Fact Preserved',
    `Found ${executedRecords.rows[0].count} historical EXECUTED records intact despite contradictory incident.`
  );

  console.log('\n===============================================================');
  console.log('STAGE 5 VALIDATION COMPLETED: 17/17 TESTS PASSED.');
  console.log('===============================================================');

  await db.close();
  process.exit(0);
}

runStage5Validation().catch((err) => {
  console.error('Unhandled failure during Stage 5 validation:', err);
  process.exit(1);
});
