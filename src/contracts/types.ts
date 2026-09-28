/**
 * @file src/contracts/types.ts
 * Capability Contract definition interfaces for the orchestration system.
 */

import { EvidenceType, RepeatMode } from '../schema/types.ts';

export interface ProviderDeduplicationSpec {
  semantics: 'PROVIDER_IDEMPOTENCY_KEY' | 'NONE';
  identityRule: string;
  /** Validity window in seconds. Required for SAFE_REPEAT, null for UNSAFE_REPEAT */
  validityWindowSeconds: number | null;
}

export interface ReconciliationSpec {
  pollIntervalSeconds: number;
  maxUnresolvedDurationSeconds: number;
  reconciliationEndpointOrMethod: string;
  supportsStatusQueryByCorrelationId: boolean;
  supportsStatusQueryByProviderAssignedId: boolean;
}

export interface CorrelationDisambiguationRules {
  /** Explains why effect_key != attempt_id != execution_identity */
  effectVsAttemptExplanation: string;
  /** Explains how client_correlation_id is used */
  clientCorrelationExplanation: string;
  /** Explains how provider_dedup_identity is used */
  providerDedupExplanation: string;
  /** Explains how provider_assigned_id is populated */
  providerAssignedIdExplanation: string;
}

export interface CapabilityContractDefinition {
  capabilityId: string;
  version: string;
  name: string;
  description: string;
  repeatMode: RepeatMode;
  operationSemantics: string;
  effectKeyCanonicalizationVersion: string;
  requiredEffectFields: string[];
  providerDedup: ProviderDeduplicationSpec;
  supportedEvidenceTypes: EvidenceType[];
  evidenceCorrelationMethod: 'CLIENT_CORRELATION_ID_MATCH' | 'PROVIDER_ASSIGNED_ID_LOOKUP';
  heartbeatIntervalSeconds: number | null;
  reconciliation: ReconciliationSpec;
  correlationRules: CorrelationDisambiguationRules;
  /** Whether the contract explicitly guarantees that provider acceptance implies execution (default: false) */
  acceptanceImpliesExecution?: boolean;
  /** Whether the contract explicitly guarantees that provider rejection implies permanent non-execution (default: false) */
  rejectionImpliesPermanentNonExecution?: boolean;
}

