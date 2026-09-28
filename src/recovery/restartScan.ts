/**
 * @file src/recovery/restartScan.ts
 * Stage 7 Restart-Safe Recovery Scan Engine.
 *
 * Locked Architectural Principles:
 *  - Discoverability through durable state: does not depend on an in-memory queue surviving process death.
 *  - Supports restart scanning, deadline/heartbeat expiry detection, repeated scans, concurrent scans.
 *  - Scan must be: repeatable, bounded, idempotent, safe under concurrent execution.
 *  - Running the scan repeatedly must not cause duplicate recovery transitions.
 */

import { PGlite } from '@electric-sql/pglite';
import { executeRecovery } from './recoveryEngine.ts';
import { evaluateRecoveryEligibility, loadContractForCapability } from './heartbeat.ts';
import { ExecuteRecoveryResult, RestartScanOptions, RestartScanResult } from './types.ts';

interface CandidateRow {
  attempt_id: string;
  effect_key: string;
  state: string;
  fence_version: string | number;
  reserved_at: string;
  last_heartbeat_at: string | null;
  heartbeat_deadline_at: string | null;
  capability_id: string;
  capability_version: string;
}

/**
 * Executes a bounded, restart-safe recovery scan across durable storage.
 */
export async function scanAndRecoverStaleReservedAttempts(
  db: PGlite,
  options: RestartScanOptions
): Promise<RestartScanResult> {
  const limit = options.limit ?? 50;
  const now = options.now ?? new Date();

  // 1. Query durable candidate rows in RESERVED state
  const candidatesRes = await db.query<CandidateRow>(
    `SELECT a.attempt_id, a.effect_key, a.state, a.fence_version, a.reserved_at,
            a.last_heartbeat_at, a.heartbeat_deadline_at,
            eff.capability_id, eff.capability_version
     FROM attempts a
     JOIN effects eff ON a.effect_key = eff.effect_key
     WHERE a.state = 'RESERVED'
     ORDER BY a.reserved_at ASC
     LIMIT $1;`,
    [limit]
  );

  const candidates = candidatesRes.rows;
  const recoveredAttempts: ExecuteRecoveryResult[] = [];
  const skippedReasons: Record<string, string> = {};
  let skippedCount = 0;

  // 2. Evaluate each candidate using durable contract definitions and execute recovery
  for (const candidate of candidates) {
    try {
      const contract = await loadContractForCapability(
        db,
        candidate.capability_id,
        candidate.capability_version
      );

      const eligibility = evaluateRecoveryEligibility(
        {
          state: candidate.state,
          reserved_at: candidate.reserved_at,
          last_heartbeat_at: candidate.last_heartbeat_at,
          heartbeat_deadline_at: candidate.heartbeat_deadline_at,
        },
        contract,
        now
      );

      if (!eligibility.eligible) {
        skippedReasons[candidate.attempt_id] = eligibility.reason;
        skippedCount++;
        continue;
      }

      // Execute atomic recovery with optimistic version fencing
      const recResult = await executeRecovery(db, {
        attempt_id: candidate.attempt_id,
        recovery_worker_identity: options.recovery_worker_identity,
        expected_fence_version: Number(candidate.fence_version),
        reason: eligibility.reason,
      });

      recoveredAttempts.push(recResult);
    } catch (err: unknown) {
      // If concurrent worker already claimed, recovered, or updated fence, record and continue gracefully
      skippedReasons[candidate.attempt_id] = (err as Error).message ?? 'Concurrent conflict';
      skippedCount++;
    }
  }

  return {
    scanned_count: candidates.length,
    recovered_count: recoveredAttempts.length,
    skipped_count: skippedCount,
    recovered_attempts: recoveredAttempts,
    skipped_reasons: skippedReasons,
  };
}
