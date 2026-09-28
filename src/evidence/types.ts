/**
 * @file src/evidence/types.ts
 * Type definitions for Stage 5: Immutable Evidence Ingestion & Claim-Specific Correlation.
 */

import { EvidenceType, ClaimSemantics } from '../schema/types.ts';

export type CorrelationMethod =
  | 'CLIENT_CORRELATION_ID_MATCH'
  | 'PROVIDER_ASSIGNED_ID_LOOKUP'
  | 'UNCORRELATED';

export type EvidenceErrorCode =
  | 'UNSUPPORTED_EVIDENCE_TYPE'
  | 'INVALID_CLAIM_SEMANTICS'
  | 'RECOVERY_RELEASED_NOT_EVIDENCE'
  | 'PROVENANCE_MISSING'
  | 'CAPABILITY_CONTRACT_NOT_FOUND'
  | 'DATABASE_IMMUTABILITY_VIOLATION';

export class EvidenceError extends Error {
  constructor(
    public readonly code: EvidenceErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(`[${code}] ${message}`);
    this.name = 'EvidenceError';
  }
}

export interface IngestEvidenceRequest {
  /** Capability identity to which the evidence applies */
  capability_id: string;
  /** Capability contract version */
  capability_version: string;
  /** Explicit contract-defined evidence type */
  evidence_type: EvidenceType;
  /** Specific claim established by this evidence */
  claim_semantics: ClaimSemantics;
  /** Provenance: who/what channel produced this evidence */
  source_channel: string;
  /** Stable external source event ID for duplicate tolerance (optional) */
  source_event_id?: string | null;
  /** Control plane correlation identifier for exact attempt matching (preferred) */
  client_correlation_id?: string | null;
  /** Downstream provider assigned identifier for exact attempt matching */
  provider_assigned_id?: string | null;
  /** Provider deduplication identity (NOT an attempt identifier; cannot correlate alone) */
  provider_dedup_identity?: string | null;
  /** Logical effect key (if known by source) */
  effect_key?: string | null;
  /** Raw evidence payload received from source */
  raw_payload: Record<string, unknown>;
  /** Recording principal (e.g. webhook receiver or reconciler) */
  recorded_by_principal_id?: string | null;
  /** Time of evidence verification */
  verified_at?: Date;
}

export interface CorrelationResolution {
  correlated: boolean;
  correlation_method: CorrelationMethod;
  attempt_id: string | null;
  effect_key: string | null;
  claim_id: string | null;
  cycle_number?: number | null;
}

export interface IngestEvidenceResult {
  evidence_id: string;
  is_duplicate: boolean;
  correlated: boolean;
  correlation_method: CorrelationMethod;
  effect_key: string | null;
  attempt_id: string | null;
  claim_id: string | null;
  evidence_type: EvidenceType;
  claim_semantics: ClaimSemantics;
  source_event_id: string | null;
  payload_hash: string;
  contradiction_detected: boolean;
  contradiction_incident_id: string | null;
  recorded_at: string;
}
