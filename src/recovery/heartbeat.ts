/**
 * @file src/recovery/heartbeat.ts
 * Stage 7 Heartbeat & Deadline Evaluation & Renewal Engine.
 *
 * Locked Architectural Principles:
 *  - Heartbeat/deadline behavior is based strictly on durable data (survives restart).
 *  - Do not rely on process-memory timers as the authoritative mechanism.
 *  - If the capability contract provides a usable heartbeat/deadline estimate: use it.
 *  - If no usable heartbeat capability exists: DO NOT invent a global timeout.
 *    Represent this as an explicit degraded liveness/recovery condition.
 *  - If the configuration is malformed or invalid: fail safely and do not invent fallback semantics.
 */

import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { CapabilityContractDefinition } from '../contracts/types.ts';
import { mockSendMessageContract, mockSendMessageUnsafeContract } from '../contracts/mockSendMessageContract.ts';
import {
  HeartbeatParams,
  HeartbeatResult,
  RecoveryEligibility,
  RecoveryError,
} from './types.ts';

export interface AttemptHeartbeatData {
  state: string;
  reserved_at: Date | string;
  last_heartbeat_at?: Date | string | null;
  heartbeat_deadline_at?: Date | string | null;
}

/**
 * Loads the capability contract from the database or in-memory definitions.
 */
export async function loadContractForCapability(
  db: PGlite,
  capabilityId: string,
  capabilityVersion: string
): Promise<CapabilityContractDefinition> {
  if (capabilityId === 'mock.send_message') {
    return mockSendMessageContract;
  }
  if (capabilityId === 'mock.send_message_unsafe') {
    return mockSendMessageUnsafeContract;
  }

  const res = await db.query<{
    capability_id: string;
    version: string;
    repeat_mode: string;
    heartbeat_interval_seconds: number | null;
    max_unresolved_duration_seconds: number;
    supported_evidence_types: string | string[];
    evidence_correlation_method: string;
    reconciliation_characteristics: string | Record<string, unknown>;
  }>(
    `SELECT capability_id, version, repeat_mode, heartbeat_interval_seconds,
            max_unresolved_duration_seconds, supported_evidence_types,
            evidence_correlation_method, reconciliation_characteristics
     FROM capability_contracts
     WHERE capability_id = $1 AND version = $2;`,
    [capabilityId, capabilityVersion]
  );

  if (res.rows.length === 0) {
    throw new RecoveryError(
      'CONTRACT_NOT_FOUND',
      `Capability contract for '${capabilityId}' (${capabilityVersion}) not found.`
    );
  }

  const row = res.rows[0];
  const supportedEvidence =
    typeof row.supported_evidence_types === 'string'
      ? JSON.parse(row.supported_evidence_types)
      : row.supported_evidence_types;

  const reconciliation =
    typeof row.reconciliation_characteristics === 'string'
      ? JSON.parse(row.reconciliation_characteristics)
      : row.reconciliation_characteristics;

  return {
    capabilityId: row.capability_id,
    version: row.version,
    name: row.capability_id,
    description: '',
    repeatMode: row.repeat_mode as CapabilityContractDefinition['repeatMode'],
    operationSemantics: '',
    effectKeyCanonicalizationVersion: 'v1',
    requiredEffectFields: [],
    providerDedup: {
      semantics: row.repeat_mode === 'SAFE_REPEAT' ? 'PROVIDER_IDEMPOTENCY_KEY' : 'NONE',
      identityRule: '',
      validityWindowSeconds: row.repeat_mode === 'SAFE_REPEAT' ? 86400 : null,
    },
    supportedEvidenceTypes: supportedEvidence,
    evidenceCorrelationMethod: row.evidence_correlation_method as CapabilityContractDefinition['evidenceCorrelationMethod'],
    heartbeatIntervalSeconds: row.heartbeat_interval_seconds,
    reconciliation: reconciliation ?? {
      pollIntervalSeconds: 300,
      maxUnresolvedDurationSeconds: row.max_unresolved_duration_seconds || 600,
      reconciliationEndpointOrMethod: '',
      supportsStatusQueryByCorrelationId: true,
      supportsStatusQueryByProviderAssignedId: true,
    },
    correlationRules: {
      effectVsAttemptExplanation: '',
      clientCorrelationExplanation: '',
      providerDedupExplanation: '',
      providerAssignedIdExplanation: '',
    },
  };
}

/**
 * Pure evaluation function for heartbeat deadlines & recovery eligibility.
 */
export function evaluateRecoveryEligibility(
  attempt: AttemptHeartbeatData,
  contract: CapabilityContractDefinition,
  now: Date = new Date()
): RecoveryEligibility {
  // Only RESERVED attempts can be evaluated for control-plane recovery release
  if (attempt.state !== 'RESERVED') {
    return {
      eligible: false,
      reason: `Attempt state is '${attempt.state}', not 'RESERVED'. Only RESERVED attempts may be recovered.`,
      deadline: null,
      isDegradedLiveness: false,
    };
  }

  // Check heartbeat capability contract specification
  const heartbeatSec = contract.heartbeatIntervalSeconds;

  if (heartbeatSec === null || heartbeatSec === undefined) {
    // Non-negotiable: DO NOT invent a global timeout! Explicitly represent degraded liveness.
    return {
      eligible: false,
      reason: 'DEGRADED_LIVENESS_NO_HEARTBEAT_CAPABILITY: Contract does not define heartbeat capability; cannot safely determine liveness without contract-defined heartbeat.',
      deadline: null,
      isDegradedLiveness: true,
    };
  }

  if (typeof heartbeatSec !== 'number' || Number.isNaN(heartbeatSec) || heartbeatSec <= 0) {
    // Malformed configuration: fail safely and do not invent fallback semantics
    return {
      eligible: false,
      reason: `MALFORMED_HEARTBEAT_CONFIG: heartbeatIntervalSeconds (${heartbeatSec}) is invalid or non-positive.`,
      deadline: null,
      isDegradedLiveness: false,
    };
  }

  // Calculate authoritative deadline
  let deadline: Date;
  if (attempt.heartbeat_deadline_at) {
    deadline = new Date(attempt.heartbeat_deadline_at);
  } else {
    const baseTime = attempt.last_heartbeat_at
      ? new Date(attempt.last_heartbeat_at)
      : new Date(attempt.reserved_at);
    deadline = new Date(baseTime.getTime() + heartbeatSec * 1000);
  }

  if (now.getTime() >= deadline.getTime()) {
    return {
      eligible: true,
      reason: `HEARTBEAT_EXPIRED: Attempt heartbeat deadline (${deadline.toISOString()}) elapsed prior to current time (${now.toISOString()}).`,
      deadline,
      isDegradedLiveness: false,
    };
  }

  return {
    eligible: false,
    reason: `ATTEMPT_NOT_STALE: Attempt is within active heartbeat validity window until ${deadline.toISOString()}.`,
    deadline,
    isDegradedLiveness: false,
  };
}

/**
 * Durably records a heartbeat renewal for a RESERVED attempt in the database.
 */
export async function recordAttemptHeartbeat(
  db: PGlite,
  params: HeartbeatParams
): Promise<HeartbeatResult> {
  return await db.transaction(async (tx) => {
    // Acquire row lock under attempt-row serialization
    const res = await tx.query<{
      attempt_id: string;
      effect_key: string;
      state: string;
      fence_version: string | number;
      reserved_at: string;
      last_heartbeat_at: string | null;
      heartbeat_deadline_at: string | null;
      capability_id: string;
      capability_version: string;
    }>(
      `SELECT a.attempt_id, a.effect_key, a.state, a.fence_version, a.reserved_at,
              a.last_heartbeat_at, a.heartbeat_deadline_at,
              eff.capability_id, eff.capability_version
       FROM attempts a
       JOIN effects eff ON a.effect_key = eff.effect_key
       WHERE a.attempt_id = $1
       FOR UPDATE OF a;`,
      [params.attempt_id]
    );

    if (res.rows.length === 0) {
      throw new RecoveryError('ATTEMPT_NOT_FOUND', `Attempt '${params.attempt_id}' not found.`);
    }

    const row = res.rows[0];

    if (row.state !== 'RESERVED') {
      throw new RecoveryError(
        'INVALID_ATTEMPT_STATE',
        `Cannot record heartbeat for attempt '${row.attempt_id}' in state '${row.state}'. Only RESERVED attempts have active dispatch ownership heartbeats.`
      );
    }

    const currentFence = Number(row.fence_version);
    if (
      params.expected_fence_version !== undefined &&
      params.expected_fence_version !== currentFence
    ) {
      throw new RecoveryError(
        'STALE_ATTEMPT_VERSION',
        `Stale version conflict on attempt '${row.attempt_id}': expected fence version ${params.expected_fence_version}, but found ${currentFence}.`
      );
    }

    // Load capability contract to determine validity window
    const contract = await loadContractForCapability(
      tx as unknown as PGlite,
      row.capability_id,
      row.capability_version
    );

    const intervalSec = params.lease_extension_seconds ?? contract.heartbeatIntervalSeconds;
    if (intervalSec === null || intervalSec === undefined || intervalSec <= 0) {
      throw new RecoveryError(
        'DEGRADED_LIVENESS_NO_HEARTBEAT_CAPABILITY',
        `Capability '${row.capability_id}' does not support heartbeat renewal.`
      );
    }

    const now = new Date();
    const newDeadline = new Date(now.getTime() + intervalSec * 1000);

    await tx.query(
      `UPDATE attempts
       SET last_heartbeat_at = $1,
           heartbeat_deadline_at = $2,
           updated_at = NOW()
       WHERE attempt_id = $3;`,
      [now.toISOString(), newDeadline.toISOString(), row.attempt_id]
    );

    // Record append-only audit event
    let actorPrincipalId: string | null = null;
    if (params.worker_identity) {
      const pCheck = await tx.query<{ principal_id: string }>(
        `SELECT principal_id FROM principals WHERE principal_id = $1;`,
        [params.worker_identity]
      );
      if (pCheck.rows.length > 0) {
        actorPrincipalId = params.worker_identity;
      }
    }

    const auditId = `ev_aud_${randomUUID()}`;
    await tx.query(
      `INSERT INTO audit_events (
        event_id, aggregate_type, aggregate_id, event_type, actor_principal_id, payload
      ) VALUES ($1, 'ATTEMPT', $2, 'HEARTBEAT_RECORDED', $3, $4);`,
      [
        auditId,
        row.attempt_id,
        actorPrincipalId,
        JSON.stringify({
          attempt_id: row.attempt_id,
          worker_identity: params.worker_identity,
          last_heartbeat_at: now.toISOString(),
          heartbeat_deadline_at: newDeadline.toISOString(),
          fence_version: currentFence,
        }),
      ]
    );

    return {
      success: true,
      attempt_id: row.attempt_id,
      last_heartbeat_at: now.toISOString(),
      heartbeat_deadline_at: newDeadline.toISOString(),
      fence_version: currentFence,
    };
  });
}
