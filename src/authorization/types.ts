/**
 * @file src/authorization/types.ts
 * Types and Error definitions for Stage 2 Atomic Control Plane Authorization.
 */

import { RepeatAuthorizationType } from '../schema/types.ts';

export type AuthorizationErrorCode =
  | 'PRINCIPAL_NOT_FOUND'
  | 'PRINCIPAL_NOT_ACTIVE'
  | 'UNAUTHORIZED_SCOPE'
  | 'CAPABILITY_NOT_FOUND'
  | 'CAPABILITY_CONTRACT_INACTIVE'
  | 'INVALID_EFFECT_PAYLOAD'
  | 'POLICY_VERSION_NOT_FOUND'
  | 'POLICY_VERSION_INACTIVE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'STALE_STATE_ERROR'
  | 'OWNERSHIP_CONFLICT'
  | 'UNSAFE_REPEAT_ALREADY_EXECUTED'
  | 'UNSAFE_REPEAT_BLOCKED_UNRESOLVED'
  | 'DEDUP_WINDOW_EXPIRED'
  | 'BLOCKED_BY_OPEN_CONTRADICTION'
  | 'NO_BUDGET_CONFIGURED'
  | 'INSUFFICIENT_BUDGET'
  | 'TRANSACTION_FAILED';

export class AuthorizationError extends Error {
  public readonly code: AuthorizationErrorCode;
  public readonly details?: unknown;

  constructor(code: AuthorizationErrorCode, message: string, details?: unknown) {
    super(`[${code}] ${message}`);
    this.name = 'AuthorizationError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, AuthorizationError.prototype);
  }
}

export interface AuthorizeOperationRequest {
  actor_principal_id: string;
  capability_id: string;
  capability_version: string;
  operation_payload: Record<string, unknown>;
  requested_scope: string;
  policy_version_id: string;
  idempotency_key: string;
  budget_amount: number;
  budget_currency: string;
  expected_fence_version?: number;
  owner_principal_id?: string;
  /** For testing forced rollback */
  _forceFailureBeforeCommit?: boolean;
}

export interface AuthorizeOperationResult {
  authorized: true;
  authorization_id: string;
  intent_id: string;
  effect_key: string;
  attempt_id: string;
  cycle_number: number;
  execution_identity: string;
  client_correlation_id: string;
  provider_dedup_identity: string | null;
  attempt_state: 'RESERVED' | 'DISPATCHED_UNRESOLVED' | 'RECOVERY_RELEASED' | 'COMPLETED_EXECUTED' | 'COMPLETED_NON_EXECUTED' | 'FAILED_TERMINAL';
  authorized_cycle: number;
  repeat_authorization_type: RepeatAuthorizationType;
  budget_reservation_id: string;
  dedup_window_expires_at: Date | null;
  is_idempotent_replay: boolean;
  fence_version: number;
  scope: string;
  policy_version_id: string;
  owner_principal_id: string | null;
}
