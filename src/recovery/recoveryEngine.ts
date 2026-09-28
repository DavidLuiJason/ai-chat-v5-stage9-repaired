/**
 * @file src/recovery/recoveryEngine.ts
 * Stage 7 Authoritative Recovery Transaction Engine.
 *
 * Locked Architectural Principles:
 *  - Recovery is a CONTROL-PLANE resolution mechanism, NOT execution.
 *  - Internal control-plane facts cannot manufacture external-world facts.
 *  - Recovery MUST NEVER:
 *      1. call a provider;
 *      2. invoke a provider adapter for external execution;
 *      3. create a dispatch claim;
 *      4. transition an attempt to DISPATCHED_UNRESOLVED;
 *      5. retry a provider operation;
 *      6. manufacture execution evidence;
 *      7. manufacture non-execution evidence;
 *      8. set executed_fact = false merely because recovery occurred;
 *      9. convert DISPATCHED_UNRESOLVED into RECOVERY_RELEASED;
 *      10. convert RECOVERY_RELEASED back to RESERVED;
 *      11. become an alternate dispatch path.
 *  - Authoritative Dispatch/Recovery Race:
 *      Uses the EXACT SAME attempt-row serialization boundary (SELECT ... FOR UPDATE).
 *      If dispatch wins: attempt = DISPATCHED_UNRESOLVED -> Recovery MUST NOT release it.
 *      If recovery wins: attempt = RECOVERY_RELEASED -> Dispatch MUST NOT create a claim.
 *      There is never a committed state where dispatch_claim exists AND attempt = RECOVERY_RELEASED.
 */

import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { AttemptState } from '../schema/types.ts';
import { evaluateRecoveryEligibility, loadContractForCapability } from './heartbeat.ts';
import { ExecuteRecoveryResult, RecoveryError, RecoveryParams } from './types.ts';

interface AttemptRowLockResult {
  attempt_id: string;
  effect_key: string;
  cycle_number: number;
  authorization_id: string;
  execution_identity: string;
  client_correlation_id: string;
  provider_dedup_identity: string | null;
  provider_assigned_id: string | null;
  state: AttemptState;
  fence_version: string | number;
  reserved_at: string;
  last_heartbeat_at: string | null;
  heartbeat_deadline_at: string | null;
  recovery_reason: string | null;
  capability_id: string;
  capability_version: string;
}

/**
 * Atomically executes control-plane recovery for a RESERVED attempt under row serialization.
 */
export async function executeRecovery(
  db: PGlite,
  params: RecoveryParams
): Promise<ExecuteRecoveryResult> {
  const recoveryEventId = `rec_ev_${randomUUID()}`;

  return await db.transaction<ExecuteRecoveryResult>(async (tx) => {
    // ------------------------------------------------------------------------
    // 1. ACQUIRE ATTEMPT ROW LOCK (Authoritative Serialization Boundary)
    // ------------------------------------------------------------------------
    let query: string;
    let queryParams: unknown[];

    if (params.attempt_id) {
      query = `
        SELECT a.attempt_id, a.effect_key, a.cycle_number, a.authorization_id,
               a.execution_identity, a.client_correlation_id, a.provider_dedup_identity,
               a.provider_assigned_id, a.state, a.fence_version, a.reserved_at,
               a.last_heartbeat_at, a.heartbeat_deadline_at, a.recovery_reason,
               eff.capability_id, eff.capability_version
        FROM attempts a
        JOIN effects eff ON a.effect_key = eff.effect_key
        WHERE a.attempt_id = $1
        FOR UPDATE OF a;
      `;
      queryParams = [params.attempt_id];
    } else {
      if (!params.effect_key || params.cycle_number === undefined) {
        throw new RecoveryError(
          'INVALID_RECOVERY_PARAMS',
          'Either attempt_id or (effect_key and cycle_number) must be provided for recovery.'
        );
      }
      query = `
        SELECT a.attempt_id, a.effect_key, a.cycle_number, a.authorization_id,
               a.execution_identity, a.client_correlation_id, a.provider_dedup_identity,
               a.provider_assigned_id, a.state, a.fence_version, a.reserved_at,
               a.last_heartbeat_at, a.heartbeat_deadline_at, a.recovery_reason,
               eff.capability_id, eff.capability_version
        FROM attempts a
        JOIN effects eff ON a.effect_key = eff.effect_key
        WHERE a.effect_key = $1 AND a.cycle_number = $2
        FOR UPDATE OF a;
      `;
      queryParams = [params.effect_key, params.cycle_number];
    }

    const res = await tx.query<AttemptRowLockResult>(query, queryParams);

    if (res.rows.length === 0) {
      throw new RecoveryError(
        'ATTEMPT_NOT_FOUND',
        `Attempt not found for recovery (attempt_id: ${params.attempt_id}, effect_key: ${params.effect_key}).`
      );
    }

    const row = res.rows[0];
    const currentFence = Number(row.fence_version);

    // ------------------------------------------------------------------------
    // 2. IDEMPOTENCY: ALREADY RECOVERY_RELEASED
    // ------------------------------------------------------------------------
    if (row.state === 'RECOVERY_RELEASED') {
      return {
        success: true,
        attempt_id: row.attempt_id,
        effect_key: row.effect_key,
        prior_state: 'RECOVERY_RELEASED',
        resulting_state: 'RECOVERY_RELEASED',
        prior_fence_version: currentFence,
        resulting_fence_version: currentFence,
        recovery_event_id: recoveryEventId,
        recovered_at: new Date().toISOString(),
        recovery_reason: row.recovery_reason ?? 'ALREADY_RELEASED',
        worker_identity: params.recovery_worker_identity,
        already_released: true,
      };
    }

    // ------------------------------------------------------------------------
    // 3. HARD NON-NEGOTIABLE RECOVERY INVARIANTS
    // ------------------------------------------------------------------------
    // NON-NEGOTIABLE RULE 9: Recovery MUST NEVER convert DISPATCHED_UNRESOLVED into RECOVERY_RELEASED!
    if (row.state === 'DISPATCHED_UNRESOLVED') {
      throw new RecoveryError(
        'DISPATCHED_UNRESOLVED_CANNOT_BE_RECOVERED',
        `Cannot recover attempt '${row.attempt_id}': attempt is DISPATCHED_UNRESOLVED and has crossed the external dispatch boundary. It must be resolved through evidence and canonical derivation.`
      );
    }

    // Terminal states cannot be reopened or released
    if (
      row.state === 'COMPLETED_EXECUTED' ||
      row.state === 'COMPLETED_NON_EXECUTED' ||
      row.state === 'FAILED_TERMINAL'
    ) {
      throw new RecoveryError(
        'TERMINAL_ATTEMPT_CANNOT_BE_RECOVERED',
        `Cannot recover attempt '${row.attempt_id}': attempt is already terminal ('${row.state}').`
      );
    }

    // Must be in RESERVED state
    if (row.state !== 'RESERVED') {
      throw new RecoveryError(
        'INVALID_ATTEMPT_STATE',
        `Cannot recover attempt '${row.attempt_id}': attempt is in '${row.state}', expected 'RESERVED'.`
      );
    }

    // ------------------------------------------------------------------------
    // 4. VERSIONED COMPARE-AND-COMMIT / FENCING VERIFICATION
    // ------------------------------------------------------------------------
    if (
      params.expected_fence_version !== undefined &&
      params.expected_fence_version !== currentFence
    ) {
      throw new RecoveryError(
        'STALE_ATTEMPT_VERSION',
        `Stale version conflict on attempt '${row.attempt_id}': expected fence version ${params.expected_fence_version}, but found ${currentFence}.`
      );
    }

    // ------------------------------------------------------------------------
    // 5. HEARTBEAT DEADLINE / ELIGIBILITY VERIFICATION
    // ------------------------------------------------------------------------
    let finalReason = params.reason ?? 'MANUAL_OR_ADMIN_RECOVERY';

    if (!params.force_recovery) {
      const contract = await loadContractForCapability(
        tx as unknown as PGlite,
        row.capability_id,
        row.capability_version
      );

      const eligibility = evaluateRecoveryEligibility(
        {
          state: row.state,
          reserved_at: row.reserved_at,
          last_heartbeat_at: row.last_heartbeat_at,
          heartbeat_deadline_at: row.heartbeat_deadline_at,
        },
        contract,
        new Date()
      );

      if (!eligibility.eligible) {
        if (eligibility.isDegradedLiveness) {
          throw new RecoveryError(
            'DEGRADED_LIVENESS_NO_HEARTBEAT_CAPABILITY',
            eligibility.reason
          );
        }
        if (eligibility.reason.startsWith('MALFORMED_HEARTBEAT_CONFIG')) {
          throw new RecoveryError('MALFORMED_HEARTBEAT_CONFIG', eligibility.reason);
        }
        throw new RecoveryError('ATTEMPT_NOT_STALE', eligibility.reason);
      }

      finalReason = eligibility.reason;
    }

    // ------------------------------------------------------------------------
    // 6. ATOMICALLY ADVANCE ATTEMPT: RESERVED -> RECOVERY_RELEASED
    // ------------------------------------------------------------------------
    const nextFence = currentFence + 1;
    const nowIso = new Date().toISOString();

    const updateRes = await tx.query(
      `UPDATE attempts
       SET state = 'RECOVERY_RELEASED',
           fence_version = $1,
           recovery_reason = $2,
           resolved_at = NOW(),
           updated_at = NOW()
       WHERE attempt_id = $3 AND fence_version = $4;`,
      [nextFence, finalReason, row.attempt_id, currentFence]
    );

    if (updateRes.rowCount === 0) {
      throw new RecoveryError(
        'CONCURRENT_UPDATE_CONFLICT',
        `Concurrent update conflict while releasing attempt '${row.attempt_id}'.`
      );
    }

    // ------------------------------------------------------------------------
    // 7. RECORD APPEND-ONLY AUDIT EVENT (INTERNAL CONTROL-PLANE FACT ONLY)
    // Invariant: This is an internal fact, NOT external evidence.
    // ------------------------------------------------------------------------
    let actorPrincipalId: string | null = null;
    if (params.recovery_worker_identity) {
      const pCheck = await tx.query<{ principal_id: string }>(
        `SELECT principal_id FROM principals WHERE principal_id = $1;`,
        [params.recovery_worker_identity]
      );
      if (pCheck.rows.length > 0) {
        actorPrincipalId = params.recovery_worker_identity;
      }
    }

    const auditEventId = `ev_aud_${randomUUID()}`;
    await tx.query(
      `INSERT INTO audit_events (
        event_id, aggregate_type, aggregate_id, event_type, actor_principal_id, payload
      ) VALUES ($1, 'ATTEMPT', $2, 'ATTEMPT_RECOVERY_RELEASED', $3, $4);`,
      [
        auditEventId,
        row.attempt_id,
        actorPrincipalId,
        JSON.stringify({
          recovery_event_id: recoveryEventId,
          attempt_id: row.attempt_id,
          effect_key: row.effect_key,
          worker_identity: params.recovery_worker_identity,
          observed_state: 'RESERVED',
          resulting_state: 'RECOVERY_RELEASED',
          observed_fence_version: currentFence,
          resulting_fence_version: nextFence,
          reason: finalReason,
          timestamp: nowIso,
        }),
      ]
    );

    // Pre-commit crash simulation hook
    if (params._forceFailureBeforeCommit) {
      throw new Error(
        'Forced failure before commit for recovery transaction rollback verification.'
      );
    }

    return {
      success: true,
      attempt_id: row.attempt_id,
      effect_key: row.effect_key,
      prior_state: 'RESERVED',
      resulting_state: 'RECOVERY_RELEASED',
      prior_fence_version: currentFence,
      resulting_fence_version: nextFence,
      recovery_event_id: recoveryEventId,
      recovered_at: nowIso,
      recovery_reason: finalReason,
      worker_identity: params.recovery_worker_identity,
      already_released: false,
    };
  });
}
