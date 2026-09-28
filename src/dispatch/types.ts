/**
 * @file src/dispatch/types.ts
 * Types and interfaces for Stage 4: Atomic Dispatch Claim & Provider Dispatch Boundary.
 */

import { AttemptState } from '../schema/types.ts';
import { ProviderDispatchResponse } from './providerAdapter.ts';

export type DispatchErrorCode =
  | 'ATTEMPT_NOT_FOUND'
  | 'INVALID_ATTEMPT_STATE'
  | 'STALE_ATTEMPT_VERSION'
  | 'AUTHORIZATION_NOT_FOUND'
  | 'AUTHORIZATION_INVALID'
  | 'CAPABILITY_MISMATCH'
  | 'EXECUTION_IDENTITY_REUSED'
  | 'RECOVERY_RELEASED_BLOCKED'
  | 'CONCURRENT_DISPATCH_CONFLICT';

export class DispatchError extends Error {
  constructor(
    public readonly code: DispatchErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(`[${code}] ${message}`);
    this.name = 'DispatchError';
  }
}

export interface DispatchParams {
  /** Target effect key */
  effect_key: string;
  /** Cycle number to dispatch (optional if attempt_id is provided) */
  cycle_number?: number;
  /** Specific attempt ID to dispatch (optional if effect_key and cycle_number provided) */
  attempt_id?: string;
  /** Optimistic concurrency fencing token for the attempt row */
  expected_fence_version: number;
  /** Identity of the worker node or control-plane process initiating dispatch */
  dispatcher_identity: string;
  /** Unique lease token for the claim (auto-generated if omitted) */
  lease_token?: string;
  /** Duration of lease in milliseconds (default: 300,000ms / 5 minutes) */
  lease_duration_ms?: number;
  /** Testing hook: forces transaction rollback prior to commit */
  _forceFailureBeforeCommit?: boolean;
}

export interface CommittedDispatch {
  claim_id: string;
  attempt_id: string;
  effect_key: string;
  cycle_number: number;
  authorization_id: string;
  execution_identity: string;
  client_correlation_id: string;
  provider_dedup_identity: string | null;
  capability_id: string;
  capability_version: string;
  canonical_payload: Record<string, unknown>;
  policy_version_id: string;
  new_fence_version: number;
  dispatched_at: Date;
  lease_token: string;
  lease_expires_at: Date;
}

export interface DispatchExecutionHooks {
  /** Simulates process crash immediately after atomic commit but before provider invocation */
  _simulateCrashBeforeProviderCall?: boolean;
  /** Simulates process crash after provider call returns but before recording provider response */
  _simulateCrashBeforeRecordingResponse?: boolean;
}

export interface ExecuteDispatchResult {
  /** True if provider invocation succeeded or accepted; false if rejected or network failed */
  success: boolean;
  /** Durable dispatch claim ID committed in DB */
  dispatch_claim_id: string;
  /** Durable attempt ID */
  attempt_id: string;
  /** Guaranteed unique intentional dispatch token */
  execution_identity: string;
  /** Control plane correlation ID */
  client_correlation_id: string;
  /** Provider deduplication identity (if SAFE_REPEAT) */
  provider_dedup_identity: string | null;
  /** Authoritative attempt state in DB (always DISPATCHED_UNRESOLVED in Stage 4) */
  attempt_state: AttemptState;
  /** Advanced fence version after atomic transition */
  fence_version: number;
  /** Provider-assigned ID if returned by provider, otherwise null */
  provider_assigned_id: string | null;
  /** Provider dispatch response (if provider was invoked) */
  provider_response: ProviderDispatchResponse | null;
  /** Provider call error message if provider threw network/timeout error */
  provider_call_error: string | null;
  /** ISO timestamp of dispatch commitment */
  dispatched_at: string;
  /** Flag indicating simulated crash prior to provider invocation */
  simulated_pre_provider_crash?: boolean;
  /** Flag indicating simulated crash after provider invocation prior to persistence */
  simulated_post_provider_crash?: boolean;
}
