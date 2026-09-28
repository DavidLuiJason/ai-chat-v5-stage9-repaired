/**
 * @file src/derivation/deriveCanonicalState.ts
 * Stage 6: Authoritative Canonical Execution & Terminal-State Derivation Engine.
 *
 * Locked Architectural Principles:
 *  1. Single Authoritative Path: Canonical factual execution is derived SOLELY through
 *     this derivation path from immutable evidence.
 *  2. Non-Derivation Boundary: Provider adapters, dispatch claims, and evidence ingestion
 *     NEVER establish canonical execution or terminal closure directly.
 *  3. Exact Claim-Specific Correlation: Only evidence correlated to the EXACT attempt
 *     (via client_correlation_id or contract-authorized provider_assigned_id) affects that attempt.
 *     provider_dedup_identity alone MUST NEVER identify an attempt or merge attempts across SAFE_REPEAT.
 *  4. Monotonicity of Execution Fact: executed_fact (FALSE -> TRUE) can NEVER be cleared,
 *     reverted, or overwritten by later contradictory evidence, timeouts, or recovery.
 *  5. Contradiction Preservation: Contradictory evidence coexists in DB without rewriting history.
 *     Contradiction incident remains OPEN, preventing terminal closure, but does NOT clear executed_fact.
 *  6. Evidence Semantics Discipline: ACCEPTED != EXECUTED, TIMEOUT != CONFIRMED_NEVER_WILL_EXECUTE,
 *     RECOVERY_RELEASED != CONFIRMED_NEVER_WILL_EXECUTE.
 *  7. Terminal Closure Completeness: An effect is terminally closed ONLY when ALL attempts are resolved
 *     and NO open contradictions exist.
 *  8. Idempotency & Fencing: Derivation is strictly idempotent and concurrency-safe via row locks
 *     and fence version validation.
 */

import { randomUUID } from 'node:crypto';
import { PGlite, Transaction } from '@electric-sql/pglite';
import {
  Attempt,
  AttemptState,
  ClaimSemantics,
  Effect,
  EffectExecutionState,
  EvidenceRecord,
  EvidenceType,
  UNRESOLVED_INCIDENT_STATUSES,
} from '../schema/types.ts';
import { CapabilityContractDefinition } from '../contracts/types.ts';
import { mockSendMessageContract, mockSendMessageUnsafeContract } from '../contracts/mockSendMessageContract.ts';
import {
  AttemptDerivationResult,
  CanonicalDerivationResult,
  DerivationError,
  DerivationOptions,
  EffectDerivationResult,
} from './types.ts';

interface AttemptEvaluationOutcome {
  targetState: AttemptState;
  executedFact: boolean;
  isTerminal: boolean;
  qualifyingEvidenceId: string | null;
  qualifyingEvidenceType: EvidenceType | null;
  appliedSemantics: ClaimSemantics | null;
  contradictionDetected: boolean;
  contradictionEvidencePair?: {
    primaryEvidenceId: string;
    conflictingEvidenceId: string;
    summary: string;
  };
}

/**
 * Pure evaluation function for attempt-level facts based on exact correlated evidence.
 * Strict evidence semantics:
 *  - EXECUTION_CONFIRMED (or EXECUTED claim): establishes execution.
 *  - NON_EXECUTION_CONFIRMED (or CONFIRMED_NEVER_WILL_EXECUTE claim): establishes terminal non-execution.
 *  - PROVIDER_ACCEPTED: does NOT establish EXECUTED unless contract explicitly guarantees it.
 *  - PROVIDER_REJECTED: does NOT establish CONFIRMED_NEVER_WILL_EXECUTE unless contract explicitly guarantees it.
 *  - PROVIDER_TIMEOUT / UNKNOWN_DISPATCH_FAILURE: NEVER establishes CONFIRMED_NEVER_WILL_EXECUTE.
 *  - RECOVERY_RELEASED: internal state, NEVER establishes external execution or non-execution.
 */
export function evaluateAttemptQualifyingEvidence(
  attempt: Attempt,
  allEvidence: EvidenceRecord[],
  contract: CapabilityContractDefinition
): AttemptEvaluationOutcome {
  // 1. Filter evidence STRICTLY correlated to THIS exact attempt
  // Do NOT match on effect_key alone, provider_dedup_identity, or heuristics!
  const attemptEvidence = allEvidence.filter((ev) => ev.attempt_id === attempt.attempt_id);

  // 2. Identify qualifying execution evidence
  const executionEvidence = attemptEvidence.filter((ev) => {
    if (ev.evidence_type === 'EXECUTION_CONFIRMED' || ev.claim_semantics === 'EXECUTED') {
      return true;
    }
    if (
      contract.acceptanceImpliesExecution === true &&
      (ev.evidence_type === 'PROVIDER_ACCEPTED' || ev.claim_semantics === 'ACCEPTED')
    ) {
      return true;
    }
    return false;
  });

  // 3. Identify qualifying confirmed non-execution evidence
  const nonExecutionEvidence = attemptEvidence.filter((ev) => {
    if (
      ev.evidence_type === 'NON_EXECUTION_CONFIRMED' ||
      ev.claim_semantics === 'CONFIRMED_NEVER_WILL_EXECUTE'
    ) {
      return true;
    }
    if (
      contract.rejectionImpliesPermanentNonExecution === true &&
      (ev.evidence_type === 'PROVIDER_REJECTED' || ev.claim_semantics === 'PROVIDER_REJECTED')
    ) {
      return true;
    }
    return false;
  });

  // 4. Case: Attempt was ALREADY COMPLETED_EXECUTED
  // Invariant: Execution fact is monotonic! Cannot be cleared or reverted.
  if (attempt.state === 'COMPLETED_EXECUTED') {
    const contradiction = nonExecutionEvidence.length > 0;
    return {
      targetState: 'COMPLETED_EXECUTED',
      executedFact: true,
      isTerminal: true,
      qualifyingEvidenceId: executionEvidence[0]?.evidence_id ?? null,
      qualifyingEvidenceType: executionEvidence[0]?.evidence_type ?? null,
      appliedSemantics: 'EXECUTED',
      contradictionDetected: contradiction,
      contradictionEvidencePair: contradiction
        ? {
            primaryEvidenceId: executionEvidence[0]?.evidence_id ?? attempt.attempt_id,
            conflictingEvidenceId: nonExecutionEvidence[0].evidence_id,
            summary: `Contradiction detected: Attempt '${attempt.attempt_id}' is already COMPLETED_EXECUTED, but subsequent evidence claims permanent non-execution.`,
          }
        : undefined,
    };
  }

  // 5. Case: Contradictory evidence (both execution and non-execution exist for this attempt)
  if (executionEvidence.length > 0 && nonExecutionEvidence.length > 0) {
    const execEv = executionEvidence[0];
    const nonExecEv = nonExecutionEvidence[0];
    return {
      targetState: 'COMPLETED_EXECUTED',
      executedFact: true, // Monotonic: factual execution cannot be erased by contradiction
      isTerminal: true,
      qualifyingEvidenceId: execEv.evidence_id,
      qualifyingEvidenceType: execEv.evidence_type,
      appliedSemantics: 'EXECUTED',
      contradictionDetected: true,
      contradictionEvidencePair: {
        primaryEvidenceId: execEv.evidence_id,
        conflictingEvidenceId: nonExecEv.evidence_id,
        summary: `Contradiction detected for attempt '${attempt.attempt_id}': Execution evidence ${execEv.evidence_id} conflicts with non-execution evidence ${nonExecEv.evidence_id}.`,
      },
    };
  }

  // 6. Case: Qualifying execution evidence exists
  if (executionEvidence.length > 0) {
    const ev = executionEvidence[0];
    return {
      targetState: 'COMPLETED_EXECUTED',
      executedFact: true,
      isTerminal: true,
      qualifyingEvidenceId: ev.evidence_id,
      qualifyingEvidenceType: ev.evidence_type,
      appliedSemantics: 'EXECUTED',
      contradictionDetected: false,
    };
  }

  // 7. Case: Qualifying non-execution evidence exists
  if (nonExecutionEvidence.length > 0) {
    const ev = nonExecutionEvidence[0];
    return {
      targetState: 'COMPLETED_NON_EXECUTED',
      executedFact: false,
      isTerminal: true,
      qualifyingEvidenceId: ev.evidence_id,
      qualifyingEvidenceType: ev.evidence_type,
      appliedSemantics: 'CONFIRMED_NEVER_WILL_EXECUTE',
      contradictionDetected: false,
    };
  }

  // 8. Case: No qualifying execution or confirmed non-execution evidence
  // Examples: PROVIDER_ACCEPTED, PROVIDER_REJECTED, PROVIDER_TIMEOUT, UNKNOWN_DISPATCH_FAILURE,
  // RECOVERY_RELEASED, or absent evidence.
  // The attempt remains in its non-terminal state.
  return {
    targetState: attempt.state,
    executedFact: false,
    isTerminal: attempt.state === 'COMPLETED_NON_EXECUTED' || attempt.state === 'FAILED_TERMINAL',
    qualifyingEvidenceId: null,
    qualifyingEvidenceType: null,
    appliedSemantics: null,
    contradictionDetected: false,
  };
}

/**
 * Pure evaluation function for effect-level facts based on attempts and contradiction status.
 * Evaluates:
 *  - Monotonic executed_fact
 *  - Open contradiction preventing closure -> CONTRADICTED_INCIDENT
 *  - Unresolved attempts preventing closure -> ACTIVE
 *  - Complete resolution -> EXECUTED or TERMINAL_NON_EXECUTED
 */
export function evaluateEffectFacts(
  effect: Effect,
  attempts: Attempt[],
  attemptOutcomes: AttemptEvaluationOutcome[],
  openContradictionsCount: number
): {
  nextExecutionState: EffectExecutionState;
  executedFact: boolean;
  isTerminallyClosed: boolean;
  terminalAttemptId: string | null;
  activeAttemptId: string | null;
} {
  // 1. Monotonicity: once TRUE, executed_fact is NEVER cleared
  const hasExecutedFact =
    effect.executed_fact ||
    attemptOutcomes.some((o) => o.executedFact) ||
    attempts.some((a) => a.state === 'COMPLETED_EXECUTED');

  // Find active attempt (e.g. latest unresolved attempt)
  const unresolvedAttempts = attempts.filter(
    (a, i) =>
      attemptOutcomes[i]?.targetState === 'RESERVED' ||
      attemptOutcomes[i]?.targetState === 'DISPATCHED_UNRESOLVED'
  );
  const activeAttemptId = unresolvedAttempts.length > 0
    ? unresolvedAttempts[unresolvedAttempts.length - 1].attempt_id
    : null;

  // 2. Open Contradiction Invariant: Open contradiction blocks terminal closure!
  // Execution state becomes CONTRADICTED_INCIDENT. Historical executed_fact remains TRUE if established.
  if (openContradictionsCount > 0) {
    return {
      nextExecutionState: 'CONTRADICTED_INCIDENT',
      executedFact: hasExecutedFact,
      isTerminallyClosed: false,
      terminalAttemptId: null,
      activeAttemptId,
    };
  }

  // 3. Unresolved Attempts Invariant: Terminal closure must not hide unresolved work!
  // If ANY attempt is unresolved (RESERVED or DISPATCHED_UNRESOLVED), effect remains ACTIVE.
  if (unresolvedAttempts.length > 0) {
    return {
      nextExecutionState: 'ACTIVE',
      executedFact: hasExecutedFact,
      isTerminallyClosed: false,
      terminalAttemptId: null,
      activeAttemptId,
    };
  }

  // 4. No attempts yet
  if (attempts.length === 0) {
    return {
      nextExecutionState: 'PENDING',
      executedFact: hasExecutedFact,
      isTerminallyClosed: false,
      terminalAttemptId: null,
      activeAttemptId: null,
    };
  }

  // 5. All attempts are resolved and no open contradictions exist:
  // Case A: Execution Fact Established
  if (hasExecutedFact) {
    // Find the attempt that established execution
    const executedAttempt = attempts.find(
      (a, i) =>
        attemptOutcomes[i]?.targetState === 'COMPLETED_EXECUTED' ||
        a.state === 'COMPLETED_EXECUTED'
    );
    const terminalAttemptId = executedAttempt?.attempt_id ?? attempts[attempts.length - 1].attempt_id;

    return {
      nextExecutionState: 'EXECUTED',
      executedFact: true,
      isTerminallyClosed: true,
      terminalAttemptId,
      activeAttemptId: null,
    };
  }

  // Case B: Terminal Non-Execution (all attempts resolved, none executed)
  const allNonExecuted = attempts.every(
    (a, i) =>
      attemptOutcomes[i]?.targetState === 'COMPLETED_NON_EXECUTED' ||
      attemptOutcomes[i]?.targetState === 'FAILED_TERMINAL' ||
      a.state === 'COMPLETED_NON_EXECUTED' ||
      a.state === 'FAILED_TERMINAL'
  );

  if (allNonExecuted) {
    return {
      nextExecutionState: 'TERMINAL_NON_EXECUTED',
      executedFact: false,
      isTerminallyClosed: true,
      terminalAttemptId: attempts[attempts.length - 1].attempt_id,
      activeAttemptId: null,
    };
  }

  // Fallback: If some attempts are in non-terminal states (e.g. RECOVERY_RELEASED without evidence)
  return {
    nextExecutionState: 'ACTIVE',
    executedFact: false,
    isTerminallyClosed: false,
    terminalAttemptId: null,
    activeAttemptId,
  };
}

/**
 * Loads the contract for a given capability_id and version.
 */
async function loadContract(
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
    supported_evidence_types: string | string[];
    evidence_correlation_method: string;
    reconciliation_characteristics: string | Record<string, unknown>;
  }>(
    `SELECT capability_id, version, repeat_mode, supported_evidence_types,
            evidence_correlation_method, reconciliation_characteristics
     FROM capability_contracts
     WHERE capability_id = $1 AND version = $2;`,
    [capabilityId, capabilityVersion]
  );

  if (res.rows.length === 0) {
    throw new DerivationError(
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
    heartbeatIntervalSeconds: null,
    reconciliation: reconciliation ?? {
      pollIntervalSeconds: 300,
      maxUnresolvedDurationSeconds: 600,
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
    acceptanceImpliesExecution: Boolean((reconciliation as Record<string, unknown>)?.acceptance_implies_execution),
    rejectionImpliesPermanentNonExecution: Boolean((reconciliation as Record<string, unknown>)?.rejection_implies_permanent_non_execution),
  };
}

/**
 * THE SOLE AUTHORITATIVE CANONICAL DERIVATION PATH (Stage 6).
 *
 * Atomically derives canonical factual execution and terminal closure state from immutable evidence.
 * Executes within a serialized database transaction with row locks on effects and attempts.
 */
export async function deriveCanonicalState(
  db: PGlite,
  target: { attempt_id?: string; effect_key?: string },
  options?: DerivationOptions
): Promise<CanonicalDerivationResult> {
  if (!target.attempt_id && !target.effect_key) {
    throw new DerivationError(
      'INVALID_DERIVATION_TARGET',
      'Either attempt_id or effect_key must be specified for canonical derivation.'
    );
  }

  const runTransaction = typeof db.transaction === 'function'
    ? (fn: (tx: Transaction) => Promise<CanonicalDerivationResult>) => db.transaction(fn)
    : (fn: (tx: PGlite) => Promise<CanonicalDerivationResult>) => fn(db);

  return await runTransaction(async (tx: Transaction | PGlite) => {
    // ------------------------------------------------------------------------
    // 1. RESOLVE TARGET EFFECT KEY
    // ------------------------------------------------------------------------
    let resolvedEffectKey = target.effect_key;

    if (!resolvedEffectKey && target.attempt_id) {
      const attLookup = await tx.query<{ effect_key: string }>(
        `SELECT effect_key FROM attempts WHERE attempt_id = $1;`,
        [target.attempt_id]
      );
      if (attLookup.rows.length === 0) {
        throw new DerivationError(
          'ATTEMPT_NOT_FOUND',
          `Attempt '${target.attempt_id}' was not found in the control plane.`
        );
      }
      resolvedEffectKey = attLookup.rows[0].effect_key;
    }

    if (!resolvedEffectKey) {
      throw new DerivationError('EFFECT_NOT_FOUND', 'Could not resolve target effect key.');
    }

    // ------------------------------------------------------------------------
    // 2. ACQUIRE SERIALIZATION ROW LOCK ON EFFECT
    // ------------------------------------------------------------------------
    const effectRes = await tx.query<Effect>(
      `SELECT effect_key, capability_id, capability_version, canonical_payload,
              canonicalization_version, repeat_mode, executed_fact, execution_state,
              dedup_window_started_at, dedup_window_expires_at, executed_at,
              first_dispatched_at, last_dispatched_at, current_cycle,
              active_attempt_id, terminal_attempt_id, fence_version,
              owner_principal_id, created_at, updated_at
       FROM effects
       WHERE effect_key = $1
       FOR UPDATE;`,
      [resolvedEffectKey]
    );

    if (effectRes.rows.length === 0) {
      throw new DerivationError(
        'EFFECT_NOT_FOUND',
        `Effect '${resolvedEffectKey}' was not found in the control plane.`
      );
    }

    const effect = effectRes.rows[0];
    const currentEffectFence = Number(effect.fence_version);

    if (
      options?.expected_effect_fence_version !== undefined &&
      options.expected_effect_fence_version !== currentEffectFence
    ) {
      throw new DerivationError(
        'STALE_FENCE_VERSION',
        `Stale effect fence version: expected ${options.expected_effect_fence_version}, found ${currentEffectFence}.`
      );
    }

    // ------------------------------------------------------------------------
    // 3. ACQUIRE SERIALIZATION ROW LOCKS ON ALL ATTEMPTS FOR THIS EFFECT
    // ------------------------------------------------------------------------
    const attemptsRes = await tx.query<Attempt>(
      `SELECT attempt_id, effect_key, cycle_number, authorization_id,
              execution_identity, client_correlation_id, provider_dedup_identity,
              provider_assigned_id, state, fence_version, reserved_at,
              dispatched_at, resolved_at, created_at, updated_at
       FROM attempts
       WHERE effect_key = $1
       ORDER BY cycle_number ASC
       FOR UPDATE;`,
      [resolvedEffectKey]
    );

    const attempts = attemptsRes.rows;

    // Check target attempt fence version if specified
    if (target.attempt_id && options?.expected_attempt_fence_version !== undefined) {
      const tgt = attempts.find((a) => a.attempt_id === target.attempt_id);
      if (tgt && Number(tgt.fence_version) !== options.expected_attempt_fence_version) {
        throw new DerivationError(
          'STALE_FENCE_VERSION',
          `Stale attempt fence version on '${target.attempt_id}': expected ${options.expected_attempt_fence_version}, found ${tgt.fence_version}.`
        );
      }
    }

    // ------------------------------------------------------------------------
    // 4. LOAD CAPABILITY CONTRACT
    // ------------------------------------------------------------------------
    const contract = await loadContract(tx as unknown as PGlite, effect.capability_id, effect.capability_version);

    // ------------------------------------------------------------------------
    // 5. LOAD ALL LINKED EVIDENCE & OPEN CONTRADICTION INCIDENTS
    // ------------------------------------------------------------------------
    const evidenceRes = await tx.query<EvidenceRecord>(
      `SELECT evidence_id, effect_key, attempt_id, claim_id, evidence_type,
              claim_semantics, correlation_method, client_correlation_id,
              provider_assigned_id, provider_dedup_identity, raw_payload,
              payload_hash, source_channel, source_event_id, capability_id,
              capability_version, recorded_by_principal_id, verified_at, recorded_at
       FROM evidence_records
       WHERE effect_key = $1 OR attempt_id = ANY($2::varchar[])
       ORDER BY recorded_at ASC;`,
      [resolvedEffectKey, attempts.map((a) => a.attempt_id)]
    );

    const evidenceList = evidenceRes.rows;

    // Check unresolved contradiction incidents for this effect (OPEN, INVESTIGATING, etc.)
    const openIncidentsRes = await tx.query<{ incident_id: string }>(
      `SELECT incident_id FROM contradiction_incidents
       WHERE effect_key = $1 AND status = ANY($2::varchar[]);`,
      [resolvedEffectKey, UNRESOLVED_INCIDENT_STATUSES]
    );

    let openContradictionCount = openIncidentsRes.rows.length;

    // ------------------------------------------------------------------------
    // 6. DERIVE ATTEMPT FACTS (FOR EACH ATTEMPT)
    // ------------------------------------------------------------------------
    let actorPrincipalId: string | null = null;
    if (options?.caller_identity) {
      const pCheck = await tx.query<{ principal_id: string }>(
        `SELECT principal_id FROM principals WHERE principal_id = $1;`,
        [options.caller_identity]
      );
      if (pCheck.rows.length > 0) {
        actorPrincipalId = options.caller_identity;
      }
    }

    const attemptResults: AttemptDerivationResult[] = [];
    const attemptOutcomes: AttemptEvaluationOutcome[] = [];
    const auditEventIds: string[] = [];

    for (const attempt of attempts) {
      const outcome = evaluateAttemptQualifyingEvidence(attempt, evidenceList, contract);
      attemptOutcomes.push(outcome);

      // Handle newly detected contradiction: record incident idempotently
      if (outcome.contradictionDetected && outcome.contradictionEvidencePair) {
        const pair = outcome.contradictionEvidencePair;
        const existingInc = await tx.query<{ incident_id: string }>(
          `SELECT incident_id FROM contradiction_incidents
           WHERE effect_key = $1 AND primary_evidence_id = $2 AND conflicting_evidence_id = $3;`,
          [resolvedEffectKey, pair.primaryEvidenceId, pair.conflictingEvidenceId]
        );

        if (existingInc.rows.length === 0) {
          const incId = `inc_${randomUUID()}`;
          await tx.query(
            `INSERT INTO contradiction_incidents (
              incident_id, effect_key, attempt_id, primary_evidence_id,
              conflicting_evidence_id, severity, status, summary, details
            ) VALUES ($1, $2, $3, $4, $5, 'CRITICAL', 'OPEN', $6, $7);`,
            [
              incId,
              resolvedEffectKey,
              attempt.attempt_id,
              pair.primaryEvidenceId,
              pair.conflictingEvidenceId,
              pair.summary,
              JSON.stringify({
                detected_by: 'canonical_derivation',
                attempt_id: attempt.attempt_id,
                cycle_number: attempt.cycle_number,
                timestamp: new Date().toISOString(),
              }),
            ]
          );
          openContradictionCount++;
        }
      }

      // Check if attempt state needs transition
      let nextFenceVersion = Number(attempt.fence_version);
      let updatedResolvedAt = attempt.resolved_at ? new Date(attempt.resolved_at).toISOString() : null;

      if (attempt.state !== outcome.targetState) {
        // Enforce Monotonicity Invariant: COMPLETED_EXECUTED can never be altered
        if (attempt.state === 'COMPLETED_EXECUTED' && outcome.targetState !== 'COMPLETED_EXECUTED') {
          throw new DerivationError(
            'MONOTONICITY_VIOLATION',
            `Invariant violation: attempt '${attempt.attempt_id}' is already COMPLETED_EXECUTED and cannot transition to '${outcome.targetState}'.`
          );
        }

        nextFenceVersion = Number(attempt.fence_version) + 1;
        updatedResolvedAt = new Date().toISOString();

        await tx.query(
          `UPDATE attempts
           SET state = $1,
               resolved_at = COALESCE(resolved_at, NOW()),
               fence_version = $2,
               updated_at = NOW()
           WHERE attempt_id = $3;`,
          [outcome.targetState, nextFenceVersion, attempt.attempt_id]
        );

        // Record Append-Only Audit Event
        const auditEventId = `ev_aud_${randomUUID()}`;
        await tx.query(
          `INSERT INTO audit_events (
            event_id, aggregate_type, aggregate_id, event_type, actor_principal_id, payload
          ) VALUES ($1, 'ATTEMPT', $2, 'CANONICAL_ATTEMPT_FACT_DERIVED', $3, $4);`,
          [
            auditEventId,
            attempt.attempt_id,
            actorPrincipalId,
            JSON.stringify({
              attempt_id: attempt.attempt_id,
              effect_key: resolvedEffectKey,
              caller_identity: options?.caller_identity ?? null,
              prior_state: attempt.state,
              canonical_state: outcome.targetState,
              executed_fact: outcome.executedFact,
              qualifying_evidence_id: outcome.qualifyingEvidenceId,
              qualifying_evidence_type: outcome.qualifyingEvidenceType,
              fence_version: nextFenceVersion,
            }),
          ]
        );
        auditEventIds.push(auditEventId);
      }

      attemptResults.push({
        attempt_id: attempt.attempt_id,
        effect_key: resolvedEffectKey,
        cycle_number: attempt.cycle_number,
        prior_state: attempt.state,
        canonical_state: outcome.targetState,
        executed_fact: outcome.executedFact,
        is_terminal: outcome.isTerminal,
        qualifying_evidence_id: outcome.qualifyingEvidenceId,
        qualifying_evidence_type: outcome.qualifyingEvidenceType,
        claim_semantics_applied: outcome.appliedSemantics,
        fence_version: nextFenceVersion,
        resolved_at: updatedResolvedAt,
      });
    }

    // ------------------------------------------------------------------------
    // 7. DERIVE EFFECT FACTS
    // ------------------------------------------------------------------------
    const effectOutcome = evaluateEffectFacts(
      effect,
      attempts,
      attemptOutcomes,
      openContradictionCount
    );

    // Monotonicity Invariant: executed_fact on effect cannot transition TRUE -> FALSE
    if (effect.executed_fact && !effectOutcome.executedFact) {
      throw new DerivationError(
        'MONOTONICITY_VIOLATION',
        `Invariant violation: effect '${resolvedEffectKey}' executed_fact cannot be cleared once TRUE.`
      );
    }

    let nextEffectFence = currentEffectFence;
    const effectNeedsUpdate =
      effect.executed_fact !== effectOutcome.executedFact ||
      effect.execution_state !== effectOutcome.nextExecutionState ||
      effect.terminal_attempt_id !== effectOutcome.terminalAttemptId ||
      effect.active_attempt_id !== effectOutcome.activeAttemptId;

    if (effectNeedsUpdate) {
      nextEffectFence = currentEffectFence + 1;
      await tx.query(
        `UPDATE effects
         SET executed_fact = $1,
             execution_state = $2,
             executed_at = COALESCE(executed_at, CASE WHEN $1 = TRUE THEN NOW() ELSE NULL END),
             terminal_attempt_id = $3,
             active_attempt_id = $4,
             fence_version = $5,
             updated_at = NOW()
         WHERE effect_key = $6;`,
        [
          effectOutcome.executedFact,
          effectOutcome.nextExecutionState,
          effectOutcome.terminalAttemptId,
          effectOutcome.activeAttemptId,
          nextEffectFence,
          resolvedEffectKey,
        ]
      );

      // Record Append-Only Audit Event
      const auditEventId = `ev_aud_${randomUUID()}`;
      await tx.query(
        `INSERT INTO audit_events (
          event_id, aggregate_type, aggregate_id, event_type, actor_principal_id, payload
        ) VALUES ($1, 'EFFECT', $2, 'CANONICAL_EFFECT_FACT_DERIVED', $3, $4);`,
        [
          auditEventId,
          resolvedEffectKey,
          actorPrincipalId,
          JSON.stringify({
            effect_key: resolvedEffectKey,
            caller_identity: options?.caller_identity ?? null,
            prior_execution_state: effect.execution_state,
            canonical_execution_state: effectOutcome.nextExecutionState,
            executed_fact: effectOutcome.executedFact,
            is_terminally_closed: effectOutcome.isTerminallyClosed,
            terminal_attempt_id: effectOutcome.terminalAttemptId,
            open_contradiction_count: openContradictionCount,
            fence_version: nextEffectFence,
          }),
        ]
      );
      auditEventIds.push(auditEventId);
    }

    // Testing hook for crash after commit simulation
    if (options?._simulateCrashAfterCommit) {
      // Transaction will commit, but caller can test immediate restart/replay
    }

    const targetAttemptResult = target.attempt_id
      ? attemptResults.find((a) => a.attempt_id === target.attempt_id)
      : undefined;

    const unresolvedCount = attemptResults.filter(
      (a) => a.canonical_state === 'RESERVED' || a.canonical_state === 'DISPATCHED_UNRESOLVED'
    ).length;

    const effectResult: EffectDerivationResult = {
      effect_key: resolvedEffectKey,
      prior_execution_state: effect.execution_state,
      canonical_execution_state: effectOutcome.nextExecutionState,
      executed_fact: effectOutcome.executedFact,
      is_terminally_closed: effectOutcome.isTerminallyClosed,
      terminal_attempt_id: effectOutcome.terminalAttemptId,
      active_attempt_id: effectOutcome.activeAttemptId,
      open_contradiction_count: openContradictionCount,
      unresolved_attempt_count: unresolvedCount,
      total_attempts_count: attempts.length,
      fence_version: nextEffectFence,
      attempts: attemptResults,
    };

    return {
      effect: effectResult,
      target_attempt: targetAttemptResult,
      audit_event_ids: auditEventIds,
    };
  });
}

/**
 * Convenience helper to derive canonical facts for a single attempt.
 */
export async function deriveCanonicalAttempt(
  db: PGlite,
  attemptId: string,
  options?: DerivationOptions
): Promise<AttemptDerivationResult> {
  const result = await deriveCanonicalState(db, { attempt_id: attemptId }, options);
  if (!result.target_attempt) {
    throw new DerivationError('ATTEMPT_NOT_FOUND', `Attempt '${attemptId}' was not found in derivation result.`);
  }
  return result.target_attempt;
}

/**
 * Convenience helper to derive canonical facts for an entire effect.
 */
export async function deriveCanonicalEffect(
  db: PGlite,
  effectKey: string,
  options?: DerivationOptions
): Promise<EffectDerivationResult> {
  const result = await deriveCanonicalState(db, { effect_key: effectKey }, options);
  return result.effect;
}
