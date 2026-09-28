/**
 * @file src/recovery/reconciliation.ts
 * Stage 7 Control-Plane Reconciliation Engine.
 *
 * Locked Architectural Principles:
 *  - Reconciliation is an internal CONTROL-PLANE function.
 *  - It MUST NOT manufacture external truth:
 *      DISPATCHED_UNRESOLVED + timeout does NOT mean NON_EXECUTED.
 *  - Reconciliation may:
 *      1. identify stale unresolved attempts;
 *      2. record reconciliation-needed metadata;
 *      3. create a durable internal reconciliation task;
 *      4. make the attempt visible to later resolution.
 *  - Reconciliation MUST NEVER:
 *      1. call the provider;
 *      2. retry the provider;
 *      3. create provider evidence;
 *      4. set executed_fact;
 *      5. clear executed_fact;
 *      6. create a dispatch claim.
 */

import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { loadContractForCapability } from './heartbeat.ts';
import {
  ReconciliationOptions,
  ReconciliationResult,
  ReconciliationTaskRecord,
} from './types.ts';

interface UnresolvedCandidate {
  attempt_id: string;
  effect_key: string;
  cycle_number: number;
  client_correlation_id: string;
  provider_assigned_id: string | null;
  dispatched_at: string | null;
  reserved_at: string;
  fence_version: string | number;
  capability_id: string;
  capability_version: string;
}

/**
 * Scans for stale DISPATCHED_UNRESOLVED attempts and records durable internal reconciliation tasks.
 * STRICT: Does not resolve or modify attempt state; does not manufacture evidence or call providers.
 */
export async function reconcileUnresolvedAttempts(
  db: PGlite,
  options: ReconciliationOptions
): Promise<ReconciliationResult> {
  const limit = options.limit ?? 50;
  const now = options.now ?? new Date();

  // 1. Query DISPATCHED_UNRESOLVED attempts
  const res = await db.query<UnresolvedCandidate>(
    `SELECT a.attempt_id, a.effect_key, a.cycle_number, a.client_correlation_id,
            a.provider_assigned_id, a.dispatched_at, a.reserved_at, a.fence_version,
            eff.capability_id, eff.capability_version
     FROM attempts a
     JOIN effects eff ON a.effect_key = eff.effect_key
     WHERE a.state = 'DISPATCHED_UNRESOLVED'
     ORDER BY a.dispatched_at ASC NULLS LAST
     LIMIT $1;`,
    [limit]
  );

  const candidates = res.rows;
  const createdTasks: ReconciliationTaskRecord[] = [];

  for (const c of candidates) {
    const contract = await loadContractForCapability(
      db,
      c.capability_id,
      c.capability_version
    );

    const maxUnresolvedSeconds =
      options.min_unresolved_seconds ??
      contract.reconciliation.maxUnresolvedDurationSeconds ??
      600;

    const baseTime = c.dispatched_at ? new Date(c.dispatched_at) : new Date(c.reserved_at);
    const unresolvedDurationSeconds = Math.max(
      0,
      Math.floor((now.getTime() - baseTime.getTime()) / 1000)
    );

    // If candidate has exceeded contract maximum unresolved duration
    if (unresolvedDurationSeconds >= maxUnresolvedSeconds) {
      const taskId = `task_rec_${randomUUID()}`;
      const reason = `DISPATCHED_UNRESOLVED exceeded contract max unresolved threshold (${unresolvedDurationSeconds}s >= ${maxUnresolvedSeconds}s)`;

      const taskRowRes = await db.query<ReconciliationTaskRecord>(
        `INSERT INTO reconciliation_tasks (
          task_id, attempt_id, effect_key, client_correlation_id,
          status, reason, unresolved_duration_seconds, metadata, updated_at
        ) VALUES ($1, $2, $3, $4, 'PENDING', $5, $6, $7, NOW())
        ON CONFLICT (attempt_id) DO UPDATE SET
          unresolved_duration_seconds = EXCLUDED.unresolved_duration_seconds,
          reason = EXCLUDED.reason,
          updated_at = NOW()
        RETURNING task_id, attempt_id, effect_key, client_correlation_id,
                  status, reason, unresolved_duration_seconds, metadata,
                  created_at::text, updated_at::text;`,
        [
          taskId,
          c.attempt_id,
          c.effect_key,
          c.client_correlation_id,
          reason,
          unresolvedDurationSeconds,
          JSON.stringify({
            worker_identity: options.worker_identity,
            capability_id: c.capability_id,
            capability_version: c.capability_version,
            dispatched_at: c.dispatched_at,
            threshold_seconds: maxUnresolvedSeconds,
            identified_at: now.toISOString(),
          }),
        ]
      );

      const taskRow = taskRowRes.rows[0];
      createdTasks.push(taskRow);

      // Record internal audit event
      let actorPrincipalId: string | null = null;
      if (options.worker_identity) {
        const pCheck = await db.query<{ principal_id: string }>(
          `SELECT principal_id FROM principals WHERE principal_id = $1;`,
          [options.worker_identity]
        );
        if (pCheck.rows.length > 0) {
          actorPrincipalId = options.worker_identity;
        }
      }

      const auditId = `ev_aud_${randomUUID()}`;
      await db.query(
        `INSERT INTO audit_events (
          event_id, aggregate_type, aggregate_id, event_type, actor_principal_id, payload
        ) VALUES ($1, 'ATTEMPT', $2, 'RECONCILIATION_TASK_RECORDED', $3, $4);`,
        [
          auditId,
          c.attempt_id,
          actorPrincipalId,
          JSON.stringify({
            task_id: taskRow.task_id,
            attempt_id: c.attempt_id,
            effect_key: c.effect_key,
            unresolved_duration_seconds: unresolvedDurationSeconds,
            threshold_seconds: maxUnresolvedSeconds,
          }),
        ]
      );
    }
  }

  return {
    scanned_unresolved_count: candidates.length,
    tasks_created_count: createdTasks.length,
    tasks: createdTasks,
  };
}
