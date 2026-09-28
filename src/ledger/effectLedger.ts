/**
 * @file src/ledger/effectLedger.ts
 * Stage 3 Effect Ledger Queries & Factual Gating Evaluation.
 *
 * Invariant: The Effect Ledger is factual. It does NOT encode a synthetic "BLOCKED" state.
 * Blocking is an authorization decision derived dynamically from:
 *  - factual attempt states (RESERVED, DISPATCHED_UNRESOLVED, RECOVERY_RELEASED, etc.)
 *  - terminal evidence (NON_EXECUTION_CONFIRMED)
 *  - capability repeat semantics (SAFE_REPEAT vs UNSAFE_REPEAT)
 *  - deduplication validity window expiration
 */

import { PGlite } from '@electric-sql/pglite';
import { Attempt, Effect, EvidenceRecord, RepeatMode, UNRESOLVED_INCIDENT_STATUSES } from '../schema/types.ts';

export interface EffectSummary {
  effect: Effect | null;
  attempts: Attempt[];
  evidence: EvidenceRecord[];
  unresolvedAttempts: Attempt[];
  hasExecutedFact: boolean;
  dedupWindow: {
    startedAt: Date | null;
    expiresAt: Date | null;
    isExpired: boolean;
  };
  isAuthorizationPermitted: boolean;
  authorizationGatingReason: string;
}

/**
 * Loads the durable effect record from the database.
 */
export async function getEffectRecord(db: PGlite, effectKey: string): Promise<Effect | null> {
  const res = await db.query<Effect>(
    `SELECT effect_key, capability_id, capability_version, canonical_payload,
            canonicalization_version, repeat_mode, executed_fact, execution_state,
            dedup_window_started_at, dedup_window_expires_at, executed_at,
            first_dispatched_at, last_dispatched_at, current_cycle,
            active_attempt_id, terminal_attempt_id, fence_version,
            owner_principal_id, created_at, updated_at
     FROM effects
     WHERE effect_key = $1;`,
    [effectKey]
  );
  return res.rows[0] ?? null;
}

/**
 * Loads all factual attempts for a given effect in cycle order.
 */
export async function getEffectAttempts(db: PGlite, effectKey: string): Promise<Attempt[]> {
  const res = await db.query<Attempt>(
    `SELECT attempt_id, effect_key, cycle_number, authorization_id,
            execution_identity, client_correlation_id, provider_dedup_identity,
            provider_assigned_id, state, fence_version, reserved_at,
            dispatched_at, resolved_at, created_at, updated_at
     FROM attempts
     WHERE effect_key = $1
     ORDER BY cycle_number ASC;`,
    [effectKey]
  );
  return res.rows;
}

/**
 * Loads all linked evidence records for a given effect.
 */
export async function getEffectEvidence(db: PGlite, effectKey: string): Promise<EvidenceRecord[]> {
  const res = await db.query<EvidenceRecord>(
    `SELECT evidence_id, effect_key, attempt_id, claim_id, evidence_type,
            correlation_method, client_correlation_id, provider_assigned_id,
            provider_dedup_identity, raw_payload, recorded_by_principal_id,
            verified_at, recorded_at
     FROM evidence_records
     WHERE effect_key = $1
     ORDER BY recorded_at ASC;`,
    [effectKey]
  );
  return res.rows;
}

/**
 * Factual evaluation of whether another authorization/attempt reservation is permitted
 * on the specified effect, according to capability repeat semantics and ledger state.
 */
export async function evaluateAuthorizationGating(
  db: PGlite,
  effectKey: string,
  repeatMode: RepeatMode,
  dedupValidityWindowSeconds?: number | null
): Promise<{
  permitted: boolean;
  reason: string;
  nextCycle: number;
  repeatAuthorizationType: 'INITIAL_ATTEMPT' | 'SAFE_REPEAT_ALLOWED' | 'UNSAFE_REPEAT_PERMITTED_TERMINAL_VERIFIED';
}> {
  const effect = await getEffectRecord(db, effectKey);

  // If effect does not exist yet, initial attempt is permitted
  if (!effect) {
    return {
      permitted: true,
      reason: 'No prior effect exists; initial attempt reservation is permitted.',
      nextCycle: 1,
      repeatAuthorizationType: 'INITIAL_ATTEMPT',
    };
  }

  const attempts = await getEffectAttempts(db, effectKey);
  const nextCycle = effect.current_cycle + 1;

  // --------------------------------------------------------------------------
  // STAGE 8 CONTRADICTION GATING: UNRESOLVED CONTRADICTION BLOCKS REPEAT AUTHORIZATION
  // --------------------------------------------------------------------------
  const openIncidents = await db.query<{ incident_id: string; status: string }>(
    `SELECT incident_id, status FROM contradiction_incidents WHERE effect_key = $1 AND status = ANY($2::varchar[]);`,
    [effectKey, UNRESOLVED_INCIDENT_STATUSES]
  );
  if (openIncidents.rows.length > 0) {
    return {
      permitted: false,
      reason: `Effect '${effectKey}' is blocked by unresolved contradiction incident '${openIncidents.rows[0].incident_id}' (status: ${openIncidents.rows[0].status}). Adjudication required before authorization.`,
      nextCycle,
      repeatAuthorizationType: repeatMode === 'SAFE_REPEAT' ? 'SAFE_REPEAT_ALLOWED' : 'UNSAFE_REPEAT_PERMITTED_TERMINAL_VERIFIED',
    };
  }

  if (attempts.length === 0) {
    return {
      permitted: true,
      reason: 'Effect exists with zero prior attempts; initial attempt reservation permitted.',
      nextCycle: 1,
      repeatAuthorizationType: 'INITIAL_ATTEMPT',
    };
  }

  const latestAttempt = attempts[attempts.length - 1];

  // --------------------------------------------------------------------------
  // UNSAFE_REPEAT GATING EVALUATION
  // --------------------------------------------------------------------------
  if (repeatMode === 'UNSAFE_REPEAT') {
    // 1. If executed_fact is true, UNSAFE_REPEAT can NEVER be repeated!
    if (effect.executed_fact) {
      return {
        permitted: false,
        reason: `UNSAFE_REPEAT effect '${effectKey}' has already been executed. Repeat authorization blocked.`,
        nextCycle,
        repeatAuthorizationType: 'UNSAFE_REPEAT_PERMITTED_TERMINAL_VERIFIED',
      };
    }

    // 2. Check if the prior attempt is in an unresolved state
    if (latestAttempt.state === 'RESERVED' || latestAttempt.state === 'DISPATCHED_UNRESOLVED') {
      return {
        permitted: false,
        reason: `UNSAFE_REPEAT effect '${effectKey}' has prior attempt '${latestAttempt.attempt_id}' in unresolved state '${latestAttempt.state}'. Repeat authorization blocked.`,
        nextCycle,
        repeatAuthorizationType: 'UNSAFE_REPEAT_PERMITTED_TERMINAL_VERIFIED',
      };
    }

    // 3. RECOVERY_RELEASED is NOT external non-execution!
    // A RECOVERY_RELEASED attempt requires explicit terminal non-execution evidence to permit retry.
    if (latestAttempt.state === 'RECOVERY_RELEASED') {
      const nonExecEvidence = await db.query(
        `SELECT evidence_id FROM evidence_records
         WHERE attempt_id = $1 AND evidence_type = 'NON_EXECUTION_CONFIRMED';`,
        [latestAttempt.attempt_id]
      );

      if (nonExecEvidence.rows.length === 0) {
        return {
          permitted: false,
          reason: `UNSAFE_REPEAT attempt '${latestAttempt.attempt_id}' is in RECOVERY_RELEASED state without verified external non-execution evidence. RECOVERY_RELEASED is not proof of non-execution. Repeat authorization blocked.`,
          nextCycle,
          repeatAuthorizationType: 'UNSAFE_REPEAT_PERMITTED_TERMINAL_VERIFIED',
        };
      }
    }

    // 4. If latest attempt reached COMPLETED_NON_EXECUTED or FAILED_TERMINAL
    if (
      latestAttempt.state === 'COMPLETED_NON_EXECUTED' ||
      latestAttempt.state === 'FAILED_TERMINAL' ||
      latestAttempt.state === 'RECOVERY_RELEASED' // verified with evidence above
    ) {
      return {
        permitted: true,
        reason: `Prior attempt '${latestAttempt.attempt_id}' reached verified terminal non-execution condition (${latestAttempt.state}). New attempt permitted.`,
        nextCycle,
        repeatAuthorizationType: 'UNSAFE_REPEAT_PERMITTED_TERMINAL_VERIFIED',
      };
    }

    return {
      permitted: false,
      reason: `UNSAFE_REPEAT prior attempt '${latestAttempt.attempt_id}' is in state '${latestAttempt.state}'. Repeat blocked.`,
      nextCycle,
      repeatAuthorizationType: 'UNSAFE_REPEAT_PERMITTED_TERMINAL_VERIFIED',
    };
  }

  // --------------------------------------------------------------------------
  // SAFE_REPEAT GATING EVALUATION
  // --------------------------------------------------------------------------
  if (repeatMode === 'SAFE_REPEAT') {
    // Check if the deduplication window has expired
    if (effect.dedup_window_expires_at) {
      const expiresAtMs = new Date(effect.dedup_window_expires_at).getTime();
      const nowMs = Date.now();
      if (nowMs > expiresAtMs) {
        return {
          permitted: false,
          reason: `SAFE_REPEAT deduplication validity window expired at ${new Date(
            expiresAtMs
          ).toISOString()} (current: ${new Date(
            nowMs
          ).toISOString()}). Repeat under provider dedup identity is no longer safe.`,
          nextCycle,
          repeatAuthorizationType: 'SAFE_REPEAT_ALLOWED',
        };
      }
    }

    return {
      permitted: true,
      reason: 'SAFE_REPEAT deduplication guarantee is valid. Next control-plane cycle permitted.',
      nextCycle,
      repeatAuthorizationType: 'SAFE_REPEAT_ALLOWED',
    };
  }

  return {
    permitted: false,
    reason: `Unrecognized repeat mode '${repeatMode}'.`,
    nextCycle,
    repeatAuthorizationType: 'INITIAL_ATTEMPT',
  };
}

/**
 * Returns a comprehensive factual ledger summary of an effect.
 */
export async function getEffectSummary(db: PGlite, effectKey: string): Promise<EffectSummary> {
  const effect = await getEffectRecord(db, effectKey);
  const attempts = await getEffectAttempts(db, effectKey);
  const evidence = await getEffectEvidence(db, effectKey);

  const unresolvedAttempts = attempts.filter(
    (a) => a.state === 'RESERVED' || a.state === 'DISPATCHED_UNRESOLVED'
  );

  let isExpired = false;
  if (effect?.dedup_window_expires_at) {
    isExpired = Date.now() > new Date(effect.dedup_window_expires_at).getTime();
  }

  let isAuthorizationPermitted = false;
  let authorizationGatingReason = 'No effect';

  if (effect) {
    const gating = await evaluateAuthorizationGating(db, effectKey, effect.repeat_mode);
    isAuthorizationPermitted = gating.permitted;
    authorizationGatingReason = gating.reason;
  }

  return {
    effect,
    attempts,
    evidence,
    unresolvedAttempts,
    hasExecutedFact: effect?.executed_fact ?? false,
    dedupWindow: {
      startedAt: effect?.dedup_window_started_at ? new Date(effect.dedup_window_started_at) : null,
      expiresAt: effect?.dedup_window_expires_at ? new Date(effect.dedup_window_expires_at) : null,
      isExpired,
    },
    isAuthorizationPermitted,
    authorizationGatingReason,
  };
}
