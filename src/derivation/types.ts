/**
 * @file src/derivation/types.ts
 * Type definitions for Stage 6: Canonical Execution & Terminal-State Derivation.
 *
 * Invariants:
 *  - Monotonicity: executed_fact (FALSE -> TRUE) can never be cleared or reverted.
 *  - Claim-Specific: Only qualifying evidence correlated to the exact attempt establishes state.
 *  - Separation: Execution fact is distinct from contradiction status.
 *  - Terminal Completeness: Closure requires all attempts to be resolved and no open contradictions.
 */

import {
  AttemptState,
  ClaimSemantics,
  EffectExecutionState,
  EvidenceType,
} from '../schema/types.ts';

export type DerivationErrorCode =
  | 'ATTEMPT_NOT_FOUND'
  | 'EFFECT_NOT_FOUND'
  | 'CONTRACT_NOT_FOUND'
  | 'STALE_FENCE_VERSION'
  | 'MONOTONICITY_VIOLATION'
  | 'INVALID_DERIVATION_TARGET'
  | 'DERIVATION_TRANSACTION_FAILED';

export class DerivationError extends Error {
  constructor(
    public readonly code: DerivationErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(`[${code}] ${message}`);
    this.name = 'DerivationError';
  }
}

export interface DerivationOptions {
  /** Optional optimistic concurrency fence version check for attempt */
  expected_attempt_fence_version?: number;
  /** Optional optimistic concurrency fence version check for effect */
  expected_effect_fence_version?: number;
  /** Principal or worker invoking derivation */
  caller_identity?: string;
  /** Hook to simulate crash immediately after transaction commits (for testing) */
  _simulateCrashAfterCommit?: boolean;
}

export interface AttemptDerivationResult {
  attempt_id: string;
  effect_key: string;
  cycle_number: number;
  prior_state: AttemptState;
  canonical_state: AttemptState;
  executed_fact: boolean;
  is_terminal: boolean;
  qualifying_evidence_id: string | null;
  qualifying_evidence_type: EvidenceType | null;
  claim_semantics_applied: ClaimSemantics | null;
  fence_version: number;
  resolved_at: string | null;
}

export interface EffectDerivationResult {
  effect_key: string;
  prior_execution_state: EffectExecutionState;
  canonical_execution_state: EffectExecutionState;
  executed_fact: boolean;
  is_terminally_closed: boolean;
  terminal_attempt_id: string | null;
  active_attempt_id: string | null;
  open_contradiction_count: number;
  unresolved_attempt_count: number;
  total_attempts_count: number;
  fence_version: number;
  attempts: AttemptDerivationResult[];
}

export interface CanonicalDerivationResult {
  effect: EffectDerivationResult;
  target_attempt?: AttemptDerivationResult;
  audit_event_ids: string[];
}
