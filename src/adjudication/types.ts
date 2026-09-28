/**
 * @file src/adjudication/types.ts
 * Stage 8: Adjudication & Contradiction Blocking Domain Types.
 *
 * Core Principle:
 * Internal control-plane facts cannot manufacture external-world facts.
 * Adjudication is a control-plane safety decision, NOT execution, and NOT evidence.
 */

import { AdjudicationDecision, IncidentStatus } from '../schema/types.ts';

export type { AdjudicationDecision };

export interface AdjudicateContradictionRequest {
  incident_id: string;
  adjudicator_principal_id: string;
  decision: AdjudicationDecision;
  rationale: string;
  policy_version_id: string;
  referenced_evidence_ids?: string[];
  expected_fence_version?: number;
  expected_effect_fence_version?: number;
  /** Test hook for pre-commit atomic rollback verification */
  _forceFailureBeforeCommit?: boolean;
}

export interface AdjudicateContradictionResult {
  adjudication_id: string;
  incident_id: string;
  effect_key: string;
  adjudicator_principal_id: string;
  decision: AdjudicationDecision;
  rationale: string;
  prior_incident_status: IncidentStatus;
  resulting_incident_status: IncidentStatus;
  incident_fence_version: number;
  effect_fence_version: number;
  audit_event_id: string;
  adjudicated_at: string;
  canonical_execution_state: string;
  executed_fact: boolean;
}

export type AdjudicationErrorCode =
  | 'INCIDENT_NOT_FOUND'
  | 'UNAUTHORIZED_ADJUDICATOR'
  | 'PRINCIPAL_NOT_ACTIVE'
  | 'CONTRADICTION_ALREADY_ADJUDICATED'
  | 'STALE_FENCE_VERSION'
  | 'POLICY_VERSION_NOT_FOUND'
  | 'POLICY_VERSION_INACTIVE'
  | 'INVALID_DECISION_NO_EXECUTION_EVIDENCE'
  | 'INVALID_DECISION_EXECUTED_FACT_MONOTONIC'
  | 'INVALID_DECISION_NO_NON_EXECUTION_EVIDENCE'
  | 'CONCURRENT_UPDATE_CONFLICT';

export class AdjudicationError extends Error {
  constructor(
    public readonly code: AdjudicationErrorCode,
    message: string
  ) {
    super(`[${code}] ${message}`);
    this.name = 'AdjudicationError';
  }
}
