/**
 * @file src/evidence/ingestEvidence.ts
 * Stage 5: Immutable Evidence Ingestion & Claim-Specific Correlation Boundary.
 *
 * Locked Architectural Invariants:
 *  - Evidence is Append-Only: Stored durably in `evidence_records`. Never modified or deleted.
 *  - Evidence is Claim-Specific: Explicit semantics (ACCEPTED != EXECUTED != CONFIRMED_NEVER_WILL_EXECUTE).
 *  - Contract-Defined Correlation: Correlates via exact client_correlation_id or provider_assigned_id.
 *    provider_dedup_identity alone CANNOT identify an attempt.
 *  - RECOVERY_RELEASED is NOT Evidence: Internal control-plane fact; never inserted or derived as evidence.
 *  - Contradiction Preservation: Conflicting evidence coexists in DB and logs an incident in
 *    `contradiction_incidents`. Historical evidence is never erased or overwritten.
 *  - Ingestion Boundary: Ingestion NEVER modifies attempt state to terminal, never modifies authorizations,
 *    never releases budget reservations, and never dispatches anything.
 */

import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import {
  EvidenceError,
  IngestEvidenceRequest,
  IngestEvidenceResult,
} from './types.ts';
import { resolveEvidenceCorrelation } from './correlator.ts';
import { mockSendMessageContract, mockSendMessageUnsafeContract } from '../contracts/mockSendMessageContract.ts';
import { CapabilityContractDefinition } from '../contracts/types.ts';

function computePayloadHash(payload: Record<string, unknown>): string {
  const jsonStr = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash('sha256').update(jsonStr).digest('hex');
}

/**
 * Ingests external or internal evidence into the append-only evidence log.
 */
export async function ingestEvidence(
  db: PGlite,
  request: IngestEvidenceRequest
): Promise<IngestEvidenceResult> {
  // --------------------------------------------------------------------------
  // 1. PROVENANCE & PRECONDITION VALIDATION
  // --------------------------------------------------------------------------
  if (!request.capability_id || !request.source_channel) {
    throw new EvidenceError(
      'PROVENANCE_MISSING',
      'Evidence provenance missing: capability_id and source_channel are strictly required.'
    );
  }

  // RECOVERY_RELEASED Boundary (Invariant 8):
  // RECOVERY_RELEASED is purely an internal state; cannot be ingested as evidence.
  if (
    request.source_channel === 'RECOVERY_RELEASED' ||
    (request.raw_payload && request.raw_payload.state === 'RECOVERY_RELEASED')
  ) {
    throw new EvidenceError(
      'RECOVERY_RELEASED_NOT_EVIDENCE',
      'Invariant violation: RECOVERY_RELEASED is an internal attempt state, not external evidence. Cannot create evidence from recovery release.'
    );
  }

  // Provider Timeout & Failure Cannot Create CONFIRMED_NEVER_WILL_EXECUTE or EXECUTED (Invariant 7 & 17)
  if (
    request.evidence_type === 'PROVIDER_TIMEOUT' ||
    request.evidence_type === 'UNKNOWN_DISPATCH_FAILURE'
  ) {
    if (
      request.claim_semantics === 'CONFIRMED_NEVER_WILL_EXECUTE' ||
      request.claim_semantics === 'EXECUTED'
    ) {
      throw new EvidenceError(
        'INVALID_CLAIM_SEMANTICS',
        `Evidence type '${request.evidence_type}' represents transport failure or timeout, which cannot establish '${request.claim_semantics}'.`
      );
    }
  }

  // ACCEPTED does not automatically establish EXECUTED (Invariant 6)
  if (
    request.evidence_type === 'PROVIDER_ACCEPTED' &&
    request.claim_semantics === 'EXECUTED'
  ) {
    throw new EvidenceError(
      'INVALID_CLAIM_SEMANTICS',
      "Provider acceptance establishes 'ACCEPTED', but cannot claim 'EXECUTED' unless authoritative completion receipt is verified."
    );
  }

  // --------------------------------------------------------------------------
  // 2. DUPLICATE EVIDENCE HANDLING (Idempotency via source_event_id)
  // --------------------------------------------------------------------------
  if (request.source_event_id && request.source_event_id.trim().length > 0) {
    const existing = await db.query<{
      evidence_id: string;
      effect_key: string | null;
      attempt_id: string | null;
      claim_id: string | null;
      evidence_type: string;
      claim_semantics: string;
      correlation_method: string;
      payload_hash: string;
      recorded_at: Date;
    }>(
      `SELECT evidence_id, effect_key, attempt_id, claim_id, evidence_type,
              claim_semantics, correlation_method, payload_hash, recorded_at
       FROM evidence_records
       WHERE source_event_id = $1;`,
      [request.source_event_id.trim()]
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      return {
        evidence_id: row.evidence_id,
        is_duplicate: true,
        correlated: row.attempt_id !== null,
        correlation_method: row.correlation_method as IngestEvidenceResult['correlation_method'],
        effect_key: row.effect_key,
        attempt_id: row.attempt_id,
        claim_id: row.claim_id,
        evidence_type: row.evidence_type as IngestEvidenceResult['evidence_type'],
        claim_semantics: row.claim_semantics as IngestEvidenceResult['claim_semantics'],
        source_event_id: request.source_event_id.trim(),
        payload_hash: row.payload_hash ?? '',
        contradiction_detected: false,
        contradiction_incident_id: null,
        recorded_at: new Date(row.recorded_at).toISOString(),
      };
    }
  }

  // --------------------------------------------------------------------------
  // 3. CAPABILITY CONTRACT LOOKUP
  // --------------------------------------------------------------------------
  let contract: CapabilityContractDefinition;
  if (request.capability_id === 'mock.send_message') {
    contract = mockSendMessageContract;
  } else if (request.capability_id === 'mock.send_message_unsafe') {
    contract = mockSendMessageUnsafeContract;
  } else {
    // Database lookup for contract
    const contractDbRes = await db.query<{
      capability_id: string;
      version: string;
      repeat_mode: string;
    }>(
      `SELECT capability_id, version, repeat_mode FROM capability_contracts
       WHERE capability_id = $1 AND version = $2;`,
      [request.capability_id, request.capability_version]
    );

    if (contractDbRes.rows.length === 0) {
      throw new EvidenceError(
        'CAPABILITY_CONTRACT_NOT_FOUND',
        `Contract for capability '${request.capability_id}' version '${request.capability_version}' not found.`
      );
    }
    contract = mockSendMessageContract; // Default fallback to standard contract structure
  }

  // --------------------------------------------------------------------------
  // 4. DETERMINISTIC CONTRACT-DEFINED CORRELATION
  // --------------------------------------------------------------------------
  const correlation = await resolveEvidenceCorrelation(db, request, contract);

  // If correlation resolved an attempt, ensure effect_key is populated
  const resolvedEffectKey = correlation.effect_key ?? request.effect_key ?? null;

  // --------------------------------------------------------------------------
  // 5. ATOMIC APPEND-ONLY INSERT INTO evidence_records
  // --------------------------------------------------------------------------
  const evidenceId = `ev_${randomUUID()}`;
  const payloadHash = computePayloadHash(request.raw_payload);
  const sourceEventId = request.source_event_id?.trim() || null;
  const verifiedAt = request.verified_at ? request.verified_at.toISOString() : new Date().toISOString();

  await db.query(
    `INSERT INTO evidence_records (
      evidence_id, effect_key, attempt_id, claim_id, evidence_type,
      claim_semantics, correlation_method, client_correlation_id,
      provider_assigned_id, provider_dedup_identity, raw_payload,
      payload_hash, source_channel, source_event_id, capability_id,
      capability_version, recorded_by_principal_id, verified_at, recorded_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW());`,
    [
      evidenceId,
      resolvedEffectKey,
      correlation.attempt_id,
      correlation.claim_id,
      request.evidence_type,
      request.claim_semantics,
      correlation.correlation_method,
      request.client_correlation_id?.trim() || null,
      request.provider_assigned_id?.trim() || null,
      request.provider_dedup_identity?.trim() || null,
      JSON.stringify(request.raw_payload),
      payloadHash,
      request.source_channel,
      sourceEventId,
      request.capability_id,
      request.capability_version,
      request.recorded_by_principal_id || null,
      verifiedAt,
    ]
  );

  // --------------------------------------------------------------------------
  // 6. CONTRADICTION DETECTION & PRESERVATION (Invariant 10)
  // Contradiction does NOT erase history. Both records coexist.
  // --------------------------------------------------------------------------
  let contradictionDetected = false;
  let contradictionIncidentId: string | null = null;

  if (resolvedEffectKey) {
    // Check for conflicting evidence for the same effect/attempt:
    // e.g. New evidence claims EXECUTED while an existing record claims CONFIRMED_NEVER_WILL_EXECUTE,
    // or new evidence claims CONFIRMED_NEVER_WILL_EXECUTE while an existing record claims EXECUTED.
    const isExecutionClaim =
      request.claim_semantics === 'EXECUTED' || request.evidence_type === 'EXECUTION_CONFIRMED';
    const isNonExecutionClaim =
      request.claim_semantics === 'CONFIRMED_NEVER_WILL_EXECUTE' ||
      request.evidence_type === 'NON_EXECUTION_CONFIRMED';

    if (isExecutionClaim || isNonExecutionClaim) {
      const opposingType = isExecutionClaim ? 'NON_EXECUTION_CONFIRMED' : 'EXECUTION_CONFIRMED';
      const opposingClaim = isExecutionClaim ? 'CONFIRMED_NEVER_WILL_EXECUTE' : 'EXECUTED';

      const conflictRes = await db.query<{ evidence_id: string }>(
        `SELECT evidence_id FROM evidence_records
         WHERE effect_key = $1
           AND evidence_id != $2
           AND (evidence_type = $3 OR claim_semantics = $4)
         ORDER BY recorded_at ASC
         LIMIT 1;`,
        [resolvedEffectKey, evidenceId, opposingType, opposingClaim]
      );

      if (conflictRes.rows.length > 0) {
        contradictionDetected = true;
        const priorEvidenceId = conflictRes.rows[0].evidence_id;
        contradictionIncidentId = `inc_${randomUUID()}`;

        await db.query(
          `INSERT INTO contradiction_incidents (
            incident_id, effect_key, attempt_id, primary_evidence_id,
            conflicting_evidence_id, severity, status, summary, details
          ) VALUES ($1, $2, $3, $4, $5, 'CRITICAL', 'OPEN', $6, $7);`,
          [
            contradictionIncidentId,
            resolvedEffectKey,
            correlation.attempt_id,
            priorEvidenceId,
            evidenceId,
            `Contradiction detected: Evidence ${evidenceId} (${request.claim_semantics}) conflicts with prior evidence ${priorEvidenceId} (${opposingClaim})`,
            JSON.stringify({
              effect_key: resolvedEffectKey,
              attempt_id: correlation.attempt_id,
              primary_evidence_id: priorEvidenceId,
              conflicting_evidence_id: evidenceId,
              detected_at: new Date().toISOString(),
            }),
          ]
        );
      }
    }
  }

  return {
    evidence_id: evidenceId,
    is_duplicate: false,
    correlated: correlation.correlated,
    correlation_method: correlation.correlation_method,
    effect_key: resolvedEffectKey,
    attempt_id: correlation.attempt_id,
    claim_id: correlation.claim_id,
    evidence_type: request.evidence_type,
    claim_semantics: request.claim_semantics,
    source_event_id: sourceEventId,
    payload_hash: payloadHash,
    contradiction_detected: contradictionDetected,
    contradiction_incident_id: contradictionIncidentId,
    recorded_at: new Date().toISOString(),
  };
}
