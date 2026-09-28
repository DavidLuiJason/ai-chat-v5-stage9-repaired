/**
 * @file src/adjudication/adjudicateContradiction.ts
 * Stage 8: Authoritative Adjudication Transaction Engine.
 *
 * Locked Architectural Principles:
 *  1. Control-Plane Decision vs External-World Fact:
 *     Adjudication belongs to control-plane safety decisions, NOT external execution.
 *     INTERNAL CONTROL-PLANE FACTS CANNOT MANUFACTURE EXTERNAL-WORLD FACTS.
 *  2. No Factual State Corruption:
 *     Adjudication MUST NEVER:
 *       - clear executed_fact (executed_fact is strictly monotonic);
 *       - fabricate execution evidence;
 *       - fabricate non-execution evidence;
 *       - modify, delete, or move historical evidence;
 *       - rewrite provider correlation, execution identity, or effect identity.
 *  3. Adjudication Does Not Authorize:
 *     An adjudication decision does NOT itself authorize a new operation, dispatch attempts,
 *     or create dispatch claims.
 *  4. Fencing & Serialized Concurrency:
 *     Adjudication uses row-level locking (FOR UPDATE) on both the incident and effect.
 *     Stale adjudicators fail safely via fence version verification.
 *     Concurrent adjudications cannot produce conflicting final decisions.
 */

import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { IncidentStatus } from '../schema/types.ts';
import { deriveCanonicalState } from '../derivation/deriveCanonicalState.ts';
import {
  AdjudicateContradictionRequest,
  AdjudicateContradictionResult,
  AdjudicationError,
} from './types.ts';

export async function adjudicateContradiction(
  db: PGlite,
  request: AdjudicateContradictionRequest
): Promise<AdjudicateContradictionResult> {
  // Validate request arguments
  if (!request.incident_id) {
    throw new AdjudicationError('INCIDENT_NOT_FOUND', 'Incident ID is required.');
  }
  if (!request.adjudicator_principal_id) {
    throw new AdjudicationError('UNAUTHORIZED_ADJUDICATOR', 'Adjudicator principal ID is required.');
  }
  if (!request.decision) {
    throw new AdjudicationError('INCIDENT_NOT_FOUND', 'Adjudication decision is required.');
  }
  if (!request.rationale || request.rationale.trim() === '') {
    throw new AdjudicationError('INCIDENT_NOT_FOUND', 'Adjudication rationale is required.');
  }
  if (!request.policy_version_id) {
    throw new AdjudicationError('POLICY_VERSION_NOT_FOUND', 'Policy version ID is required.');
  }

  return await db.transaction(async (tx) => {
    // ------------------------------------------------------------------------
    // 1. VALIDATE ADJUDICATION AUTHORITY (FOR SHARE)
    // ------------------------------------------------------------------------
    const principalRes = await tx.query<{
      principal_id: string;
      type: string;
      status: string;
      metadata: Record<string, unknown> | string;
    }>(
      `SELECT principal_id, type, status, metadata FROM principals WHERE principal_id = $1 FOR SHARE;`,
      [request.adjudicator_principal_id]
    );

    if (principalRes.rows.length === 0) {
      throw new AdjudicationError(
        'UNAUTHORIZED_ADJUDICATOR',
        `Principal '${request.adjudicator_principal_id}' does not exist.`
      );
    }

    const principal = principalRes.rows[0];
    if (principal.status !== 'ACTIVE') {
      throw new AdjudicationError(
        'PRINCIPAL_NOT_ACTIVE',
        `Adjudicator principal '${request.adjudicator_principal_id}' is not ACTIVE (status: ${principal.status}).`
      );
    }

    const rawMeta = principal.metadata;
    const metadata = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta || {};
    const roles: string[] = Array.isArray(metadata?.roles)
      ? metadata.roles
      : metadata?.role
      ? [metadata.role]
      : [];
    const scopes: string[] = Array.isArray(metadata?.scopes)
      ? metadata.scopes
      : metadata?.scope
      ? [metadata.scope]
      : [];

    const isAuthorized =
      roles.includes('ADJUDICATOR') ||
      roles.includes('ADMIN') ||
      scopes.includes('adjudication') ||
      scopes.includes('*');

    if (!isAuthorized) {
      throw new AdjudicationError(
        'UNAUTHORIZED_ADJUDICATOR',
        `Principal '${request.adjudicator_principal_id}' lacks adjudication authority. Configured roles: [${roles.join(
          ', '
        )}], scopes: [${scopes.join(', ')}].`
      );
    }

    // ------------------------------------------------------------------------
    // 2. VALIDATE POLICY VERSION (FOR SHARE)
    // ------------------------------------------------------------------------
    const policyRes = await tx.query<{
      policy_version_id: string;
      is_active: boolean;
    }>(
      `SELECT policy_version_id, is_active FROM policy_versions WHERE policy_version_id = $1 FOR SHARE;`,
      [request.policy_version_id]
    );

    if (policyRes.rows.length === 0) {
      throw new AdjudicationError(
        'POLICY_VERSION_NOT_FOUND',
        `Policy version '${request.policy_version_id}' does not exist.`
      );
    }

    if (!policyRes.rows[0].is_active) {
      throw new AdjudicationError(
        'POLICY_VERSION_INACTIVE',
        `Policy version '${request.policy_version_id}' is inactive.`
      );
    }

    // ------------------------------------------------------------------------
    // 3. LOOKUP INCIDENT EFFECT KEY (Pre-lock lookup)
    // ------------------------------------------------------------------------
    const incidentLookup = await tx.query<{ effect_key: string }>(
      `SELECT effect_key FROM contradiction_incidents WHERE incident_id = $1;`,
      [request.incident_id]
    );

    if (incidentLookup.rows.length === 0) {
      throw new AdjudicationError(
        'INCIDENT_NOT_FOUND',
        `Contradiction incident '${request.incident_id}' not found.`
      );
    }

    const effectKey = incidentLookup.rows[0].effect_key;

    // ------------------------------------------------------------------------
    // 4. ROW LOCK ON EFFECT (FOR UPDATE)
    // Strict Global Lock Order: effects -> contradiction_incidents
    // Both authorizeOperation and adjudicateContradiction lock effects first,
    // eliminating AB-BA lock inversion and preventing PostgreSQL deadlocks.
    // ------------------------------------------------------------------------
    const effectRes = await tx.query<{
      effect_key: string;
      executed_fact: boolean;
      execution_state: string;
      fence_version: string | number;
    }>(
      `SELECT effect_key, executed_fact, execution_state, fence_version
       FROM effects
       WHERE effect_key = $1
       FOR UPDATE;`,
      [effectKey]
    );

    if (effectRes.rows.length === 0) {
      throw new AdjudicationError(
        'INCIDENT_NOT_FOUND',
        `Associated effect '${effectKey}' not found.`
      );
    }

    const effect = effectRes.rows[0];
    const currentEffectFence = Number(effect.fence_version);

    if (
      request.expected_effect_fence_version !== undefined &&
      request.expected_effect_fence_version !== currentEffectFence
    ) {
      throw new AdjudicationError(
        'STALE_FENCE_VERSION',
        `Stale effect fence version: expected ${request.expected_effect_fence_version}, found ${currentEffectFence}.`
      );
    }

    // ------------------------------------------------------------------------
    // 5. ROW LOCK ON CONTRADICTION INCIDENT (FOR UPDATE)
    // Strict Global Lock Order: effects -> contradiction_incidents
    // ------------------------------------------------------------------------
    const incidentRes = await tx.query<{
      incident_id: string;
      effect_key: string;
      attempt_id: string | null;
      primary_evidence_id: string;
      conflicting_evidence_id: string;
      severity: string;
      status: IncidentStatus;
      fence_version: string | number;
    }>(
      `SELECT incident_id, effect_key, attempt_id, primary_evidence_id, conflicting_evidence_id,
              severity, status, fence_version
       FROM contradiction_incidents
       WHERE incident_id = $1
       FOR UPDATE;`,
      [request.incident_id]
    );

    const incident = incidentRes.rows[0];
    const currentIncidentFence = Number(incident.fence_version ?? 1);

    if (incident.status === 'ADJUDICATED' || incident.status === 'RESOLVED') {
      throw new AdjudicationError(
        'CONTRADICTION_ALREADY_ADJUDICATED',
        `Contradiction incident '${request.incident_id}' has already been adjudicated (current status: ${incident.status}).`
      );
    }

    if (
      request.expected_fence_version !== undefined &&
      request.expected_fence_version !== currentIncidentFence
    ) {
      throw new AdjudicationError(
        'STALE_FENCE_VERSION',
        `Stale incident fence version: expected ${request.expected_fence_version}, found ${currentIncidentFence}.`
      );
    }

    // ------------------------------------------------------------------------
    // 5. FACTUAL GROUNDING: DECISION CANNOT MANUFACTURE FACTS
    // ------------------------------------------------------------------------
    let resultingStatus: IncidentStatus = 'ADJUDICATED';

    if (request.decision === 'RESOLVE_FAVOR_EXECUTION') {
      // Must be supported by existing qualifying execution evidence
      const execEvidenceRes = await tx.query<{ evidence_id: string }>(
        `SELECT evidence_id FROM evidence_records
         WHERE (effect_key = $1 OR attempt_id = $2)
           AND (evidence_type = 'EXECUTION_CONFIRMED' OR claim_semantics = 'EXECUTED');`,
        [incident.effect_key, incident.attempt_id]
      );

      if (execEvidenceRes.rows.length === 0 && !effect.executed_fact) {
        throw new AdjudicationError(
          'INVALID_DECISION_NO_EXECUTION_EVIDENCE',
          `Cannot adjudicate in favor of execution: no qualifying execution evidence exists in the evidence store for effect '${incident.effect_key}'. Adjudication cannot manufacture external execution facts.`
        );
      }
      resultingStatus = 'ADJUDICATED';
    } else if (request.decision === 'RESOLVE_FAVOR_NON_EXECUTION') {
      // MONOTONICITY INVARIANT: executed_fact can NEVER be cleared once true!
      if (effect.executed_fact) {
        throw new AdjudicationError(
          'INVALID_DECISION_EXECUTED_FACT_MONOTONIC',
          `Cannot adjudicate in favor of non-execution: executed_fact is already true on effect '${incident.effect_key}' and is strictly monotonic. Adjudication cannot erase execution history.`
        );
      }

      // Must be supported by qualifying non-execution evidence
      const nonExecEvidenceRes = await tx.query<{ evidence_id: string }>(
        `SELECT evidence_id FROM evidence_records
         WHERE (effect_key = $1 OR attempt_id = $2)
           AND (evidence_type = 'NON_EXECUTION_CONFIRMED' OR claim_semantics = 'CONFIRMED_NEVER_WILL_EXECUTE');`,
        [incident.effect_key, incident.attempt_id]
      );

      if (nonExecEvidenceRes.rows.length === 0) {
        throw new AdjudicationError(
          'INVALID_DECISION_NO_NON_EXECUTION_EVIDENCE',
          `Cannot adjudicate in favor of non-execution: no qualifying non-execution evidence exists for effect '${incident.effect_key}'. Adjudication cannot manufacture non-execution facts.`
        );
      }
      resultingStatus = 'ADJUDICATED';
    } else if (request.decision === 'REMAIN_BLOCKED_REQUIRE_EVIDENCE') {
      // Incident remains active/blocking while under investigation
      resultingStatus = 'INVESTIGATING';
    } else if (request.decision === 'DISMISS_CONTRADICTION') {
      resultingStatus = 'ADJUDICATED';
    }

    // ------------------------------------------------------------------------
    // 6. ATOMICALLY ADVANCE CONTRADICTION INCIDENT
    // ------------------------------------------------------------------------
    const nextIncidentFence = currentIncidentFence + 1;
    const nowIso = new Date().toISOString();

    const updateRes = await tx.query(
      `UPDATE contradiction_incidents
       SET status = $1,
           fence_version = $2,
           resolution_notes = $3,
           updated_at = NOW()
       WHERE incident_id = $4 AND fence_version = $5;`,
      [resultingStatus, nextIncidentFence, request.rationale, incident.incident_id, currentIncidentFence]
    );

    if (updateRes.rowCount === 0) {
      throw new AdjudicationError(
        'CONCURRENT_UPDATE_CONFLICT',
        `Concurrent update conflict while adjudicating incident '${incident.incident_id}'.`
      );
    }

    // ------------------------------------------------------------------------
    // 7. PERSIST DURABLE ADJUDICATION RECORD (APPEND-ONLY)
    // ------------------------------------------------------------------------
    const adjudicationId = `adj_${randomUUID()}`;
    const referencedEvidenceIds = request.referenced_evidence_ids ?? [
      incident.primary_evidence_id,
      incident.conflicting_evidence_id,
    ];

    await tx.query(
      `INSERT INTO adjudication_records (
        adjudication_id, incident_id, effect_key, adjudicator_principal_id,
        decision, rationale, policy_version_id, referenced_evidence_ids,
        prior_incident_status, resulting_incident_status, fence_version, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW());`,
      [
        adjudicationId,
        incident.incident_id,
        incident.effect_key,
        request.adjudicator_principal_id,
        request.decision,
        request.rationale,
        request.policy_version_id,
        JSON.stringify(referencedEvidenceIds),
        incident.status,
        resultingStatus,
        nextIncidentFence,
      ]
    );

    // ------------------------------------------------------------------------
    // 8. RECORD APPEND-ONLY AUDIT EVENT
    // ------------------------------------------------------------------------
    const auditEventId = `ev_aud_${randomUUID()}`;
    await tx.query(
      `INSERT INTO audit_events (
        event_id, aggregate_type, aggregate_id, event_type, actor_principal_id, payload
      ) VALUES ($1, 'ADJUDICATION', $2, 'CONTRADICTION_ADJUDICATED', $3, $4);`,
      [
        auditEventId,
        adjudicationId,
        request.adjudicator_principal_id,
        JSON.stringify({
          adjudication_id: adjudicationId,
          incident_id: incident.incident_id,
          effect_key: incident.effect_key,
          decision: request.decision,
          rationale: request.rationale,
          policy_version_id: request.policy_version_id,
          prior_status: incident.status,
          resulting_status: resultingStatus,
          incident_fence_version: nextIncidentFence,
          timestamp: nowIso,
        }),
      ]
    );

    // ------------------------------------------------------------------------
    // 9. CANONICALLY DERIVE EFFECT FACTUAL STATE
    // If the incident transitioned from OPEN to ADJUDICATED, canonical derivation
    // re-evaluates openContradictionsCount and resolves terminal closure cleanly.
    // ------------------------------------------------------------------------
    const derivationResult = await deriveCanonicalState(
      tx as unknown as PGlite,
      { effect_key: incident.effect_key }
    );

    // Pre-commit failure simulation hook
    if (request._forceFailureBeforeCommit) {
      throw new Error('Forced failure before commit for adjudication rollback verification.');
    }

    return {
      adjudication_id: adjudicationId,
      incident_id: incident.incident_id,
      effect_key: incident.effect_key,
      adjudicator_principal_id: request.adjudicator_principal_id,
      decision: request.decision,
      rationale: request.rationale,
      prior_incident_status: incident.status,
      resulting_incident_status: resultingStatus,
      incident_fence_version: nextIncidentFence,
      effect_fence_version: derivationResult.effect.fence_version,
      audit_event_id: auditEventId,
      adjudicated_at: nowIso,
      canonical_execution_state: derivationResult.effect.canonical_execution_state,
      executed_fact: derivationResult.effect.executed_fact,
    };
  });
}
