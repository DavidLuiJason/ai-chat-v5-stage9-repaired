/**
 * @file src/recovery/types.ts
 * Stage 7 Domain types and interfaces for Recovery, Heartbeat Deadlines, and Reconciliation.
 *
 * Locked Architectural Principles:
 *  - Recovery is a CONTROL-PLANE resolution mechanism, NOT execution.
 *  - Internal control-plane facts cannot manufacture external-world facts.
 *  - RECOVERY_RELEASED is NOT external evidence and does not set executed_fact = false.
 *  - Recovery MUST NEVER call a provider, invoke a provider adapter, create a dispatch claim,
 *    or transition an attempt to DISPATCHED_UNRESOLVED.
 *  - Authoritative attempt-row serialization: Exactly one winner between dispatch and recovery.
 */

import { AttemptState } from '../schema/types.ts';

export class RecoveryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(`[RecoveryError:${code}] ${message}`);
    this.name = 'RecoveryError';
  }
}

export interface RecoveryEligibility {
  eligible: boolean;
  reason: string;
  deadline: Date | null;
  isDegradedLiveness: boolean;
}

export interface RecoveryParams {
  attempt_id?: string;
  effect_key?: string;
  cycle_number?: number;
  expected_fence_version?: number;
  recovery_worker_identity: string;
  reason?: string;
  force_recovery?: boolean;
  _forceFailureBeforeCommit?: boolean;
}

export interface ExecuteRecoveryResult {
  success: boolean;
  attempt_id: string;
  effect_key: string;
  prior_state: AttemptState;
  resulting_state: AttemptState;
  prior_fence_version: number;
  resulting_fence_version: number;
  recovery_event_id: string;
  recovered_at: string;
  recovery_reason: string;
  worker_identity: string;
  already_released?: boolean;
}

export interface HeartbeatParams {
  attempt_id: string;
  worker_identity: string;
  expected_fence_version?: number;
  lease_extension_seconds?: number;
}

export interface HeartbeatResult {
  success: boolean;
  attempt_id: string;
  last_heartbeat_at: string;
  heartbeat_deadline_at: string;
  fence_version: number;
}

export interface RestartScanOptions {
  limit?: number;
  recovery_worker_identity: string;
  now?: Date;
}

export interface RestartScanResult {
  scanned_count: number;
  recovered_count: number;
  skipped_count: number;
  recovered_attempts: ExecuteRecoveryResult[];
  skipped_reasons: Record<string, string>;
}

export interface ReconciliationOptions {
  limit?: number;
  worker_identity: string;
  now?: Date;
  min_unresolved_seconds?: number;
}

export interface ReconciliationTaskRecord {
  task_id: string;
  attempt_id: string;
  effect_key: string;
  client_correlation_id: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'RESOLVED' | 'ABANDONED';
  reason: string;
  unresolved_duration_seconds: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ReconciliationResult {
  scanned_unresolved_count: number;
  tasks_created_count: number;
  tasks: ReconciliationTaskRecord[];
}
