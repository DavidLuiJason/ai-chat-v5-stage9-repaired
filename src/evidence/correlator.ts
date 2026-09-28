/**
 * @file src/evidence/correlator.ts
 * Deterministic Contract-Defined Evidence Correlation Engine.
 *
 * Locked Correlation Principles:
 *  - Preference 1: Exact client_correlation_id match (attempt-level identifier).
 *  - Preference 2: Exact provider_assigned_id lookup if contract declares it reliable.
 *  - STRICTLY FORBIDDEN:
 *      * Correlating using provider_dedup_identity alone (shared across SAFE_REPEAT cycles).
 *      * Correlating using effect_key alone.
 *      * Correlating to "latest attempt".
 *      * Heuristic similarity or fuzzy matching.
 *  - If no reliable exact correlation path exists:
 *      * Mark as UNCORRELATED; do NOT guess.
 */

import { PGlite } from '@electric-sql/pglite';
import { CorrelationResolution, IngestEvidenceRequest } from './types.ts';
import { CapabilityContractDefinition } from '../contracts/types.ts';

interface AttemptLookupRow {
  attempt_id: string;
  effect_key: string;
  cycle_number: number;
  claim_id: string | null;
}

/**
 * Resolves attempt and effect correlation for an incoming evidence payload
 * according to contract-declared rules.
 */
export async function resolveEvidenceCorrelation(
  db: PGlite,
  request: IngestEvidenceRequest,
  contract: CapabilityContractDefinition
): Promise<CorrelationResolution> {
  // --------------------------------------------------------------------------
  // RULE 1: EXACT client_correlation_id MATCH (Highest Authority)
  // --------------------------------------------------------------------------
  if (request.client_correlation_id && request.client_correlation_id.trim().length > 0) {
    const res = await db.query<AttemptLookupRow>(
      `SELECT a.attempt_id, a.effect_key, a.cycle_number, c.claim_id
       FROM attempts a
       LEFT JOIN dispatch_claims c ON a.attempt_id = c.attempt_id
       WHERE a.client_correlation_id = $1;`,
      [request.client_correlation_id.trim()]
    );

    if (res.rows.length > 0) {
      const match = res.rows[0];
      return {
        correlated: true,
        correlation_method: 'CLIENT_CORRELATION_ID_MATCH',
        attempt_id: match.attempt_id,
        effect_key: match.effect_key,
        claim_id: match.claim_id,
        cycle_number: match.cycle_number,
      };
    }

    // Client correlation ID provided but no matching attempt found in DB
    return {
      correlated: false,
      correlation_method: 'UNCORRELATED',
      attempt_id: null,
      effect_key: null,
      claim_id: null,
      cycle_number: null,
    };
  }

  // --------------------------------------------------------------------------
  // RULE 2: EXACT provider_assigned_id LOOKUP (When Contract Authorizes)
  // --------------------------------------------------------------------------
  const supportsProviderAssignedId =
    contract.reconciliation?.supportsStatusQueryByProviderAssignedId ?? false;

  if (
    supportsProviderAssignedId &&
    request.provider_assigned_id &&
    request.provider_assigned_id.trim().length > 0
  ) {
    const res = await db.query<AttemptLookupRow>(
      `SELECT a.attempt_id, a.effect_key, a.cycle_number, c.claim_id
       FROM attempts a
       LEFT JOIN dispatch_claims c ON a.attempt_id = c.attempt_id
       WHERE a.provider_assigned_id = $1;`,
      [request.provider_assigned_id.trim()]
    );

    if (res.rows.length > 0) {
      const match = res.rows[0];
      return {
        correlated: true,
        correlation_method: 'PROVIDER_ASSIGNED_ID_LOOKUP',
        attempt_id: match.attempt_id,
        effect_key: match.effect_key,
        claim_id: match.claim_id,
        cycle_number: match.cycle_number,
      };
    }

    // Provider assigned ID provided but not found
    return {
      correlated: false,
      correlation_method: 'UNCORRELATED',
      attempt_id: null,
      effect_key: null,
      claim_id: null,
      cycle_number: null,
    };
  }

  // --------------------------------------------------------------------------
  // RULE 3: PROHIBITED CORRELATION PATHS (provider_dedup_identity, effect_key alone)
  // DO NOT GUESS. Never attach to "latest attempt".
  // --------------------------------------------------------------------------
  return {
    correlated: false,
    correlation_method: 'UNCORRELATED',
    attempt_id: null,
    effect_key: request.effect_key ?? null,
    claim_id: null,
    cycle_number: null,
  };
}
