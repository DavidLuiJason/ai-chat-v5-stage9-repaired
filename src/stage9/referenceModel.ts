/**
 * @file src/stage9/referenceModel.ts
 * Independent Executable Reference Model for Control-Plane Invariant Testing.
 *
 * Implements pure state-machine semantics WITHOUT calling production code.
 * Used for differential oracle testing in Stage 9.
 */

export type RefAttemptState = 'RESERVED' | 'DISPATCHED_UNRESOLVED' | 'RECOVERY_RELEASED';
export type RefExecutionState = 'ACTIVE' | 'EXECUTED' | 'TERMINAL_NON_EXECUTION' | 'CONTRADICTED_INCIDENT';
export type RefIncidentStatus = 'OPEN' | 'INVESTIGATING' | 'ACKNOWLEDGED' | 'RESOLVED' | 'ADJUDICATED';
export type RefRepeatMode = 'SAFE_REPEAT' | 'UNSAFE_REPEAT';

export interface RefAttempt {
  attempt_id: string;
  cycle: number;
  state: RefAttemptState;
  reserved_at: number;
  lease_expires_at: number;
  dispatcher_identity: string | null;
  client_correlation_id: string;
  has_dispatch_claim: boolean;
  provider_tx_id: string | null;
}

export interface RefEvidence {
  evidence_id: string;
  evidence_type: 'EXECUTION_CONFIRMED' | 'NON_EXECUTION_CONFIRMED' | 'TIMEOUT_CONFIRMED';
  claim_semantics: 'EXECUTED' | 'CONFIRMED_NEVER_WILL_EXECUTE' | 'TIMEOUT_NEVER_EXECUTED';
  client_correlation_id: string;
  timestamp: number;
}

export interface RefIncident {
  incident_id: string;
  status: RefIncidentStatus;
  primary_evidence_id: string;
  conflicting_evidence_id: string;
  fence_version: number;
}

export interface RefAdjudicationRecord {
  adjudication_id: string;
  incident_id: string;
  decision: 'REMAIN_BLOCKED_REQUIRE_EVIDENCE' | 'RESOLVE_FAVOR_EXECUTION' | 'RESOLVE_FAVOR_NON_EXECUTION' | 'DISMISS_CONTRADICTION';
  rationale: string;
  resulting_fence_version: number;
}

export interface RefEffect {
  effect_key: string;
  repeat_mode: RefRepeatMode;
  dedup_window_ms: number;
  current_cycle: number;
  fence_version: number;
  executed_fact: boolean;
  execution_state: RefExecutionState;
  is_terminally_closed: boolean;
  open_contradiction_count: number;
  attempts: Map<string, RefAttempt>;
  evidence: RefEvidence[];
  incidents: Map<string, RefIncident>;
  adjudications: RefAdjudicationRecord[];
  intents: Map<string, { idempotency_key: string; cycle: number; status: 'AUTHORIZED' | 'REJECTED' }>;
  last_authorized_at: number | null;
}

export interface RefAuthorizationResult {
  permitted: boolean;
  reject_reason?: string;
  attempt_id?: string;
  cycle?: number;
}

export class ControlPlaneReferenceModel {
  public effects = new Map<string, RefEffect>();
  public currentTime = 1000000;

  public getOrCreateEffect(
    effect_key: string,
    repeat_mode: RefRepeatMode = 'SAFE_REPEAT',
    dedup_window_ms = 86400000
  ): RefEffect {
    let eff = this.effects.get(effect_key);
    if (!eff) {
      eff = {
        effect_key,
        repeat_mode,
        dedup_window_ms,
        current_cycle: 0,
        fence_version: 1,
        executed_fact: false,
        execution_state: 'ACTIVE',
        is_terminally_closed: false,
        open_contradiction_count: 0,
        attempts: new Map(),
        evidence: [],
        incidents: new Map(),
        adjudications: [],
        intents: new Map(),
        last_authorized_at: null,
      };
      this.effects.set(effect_key, eff);
    }
    return eff;
  }

  /**
   * Evaluates if any contradiction incident is currently active and safety-blocking.
   */
  public hasUnresolvedContradiction(effect: RefEffect): boolean {
    for (const inc of effect.incidents.values()) {
      if (inc.status === 'OPEN' || inc.status === 'INVESTIGATING' || inc.status === 'ACKNOWLEDGED') {
        return true;
      }
    }
    return false;
  }

  /**
   * Reference Authorization Rule.
   */
  public authorize(
    effect_key: string,
    idempotency_key: string,
    repeat_mode: RefRepeatMode = 'SAFE_REPEAT'
  ): RefAuthorizationResult {
    const effect = this.getOrCreateEffect(effect_key, repeat_mode);

    // 1. Idempotency Check
    const existingIntent = effect.intents.get(idempotency_key);
    if (existingIntent) {
      if (existingIntent.status === 'AUTHORIZED') {
        const existingAttempt = Array.from(effect.attempts.values()).find(
          (a) => a.cycle === existingIntent.cycle
        );
        return {
          permitted: true,
          attempt_id: existingAttempt?.attempt_id,
          cycle: existingIntent.cycle,
        };
      } else {
        return { permitted: false, reject_reason: 'PREVIOUS_IDEMPOTENT_REJECTION' };
      }
    }

    // 2. Contradiction Blocking (Safety invariant: OPEN, INVESTIGATING, ACKNOWLEDGED block authorization)
    if (this.hasUnresolvedContradiction(effect)) {
      return { permitted: false, reject_reason: 'BLOCKED_BY_OPEN_CONTRADICTION' };
    }

    // 3. Repeat Semantics
    if (effect.current_cycle > 0) {
      if (effect.repeat_mode === 'UNSAFE_REPEAT') {
        // UNSAFE_REPEAT: Once executed_fact is true, NEVER permitted to repeat!
        if (effect.executed_fact) {
          return { permitted: false, reject_reason: 'UNSAFE_REPEAT_ALREADY_EXECUTED' };
        }
        // If still active / unresolved, cannot repeat
        if (!effect.is_terminally_closed) {
          return { permitted: false, reject_reason: 'UNSAFE_REPEAT_UNRESOLVED' };
        }
      } else {
        // SAFE_REPEAT: Must be outside or within valid dedup window
        const activeAttempt = Array.from(effect.attempts.values()).find(
          (a) => a.state === 'RESERVED' || a.state === 'DISPATCHED_UNRESOLVED'
        );
        if (activeAttempt) {
          return { permitted: false, reject_reason: 'CONCURRENT_ATTEMPT_ACTIVE' };
        }
      }
    }

    // Authorization Granted
    const nextCycle = effect.current_cycle + 1;
    effect.current_cycle = nextCycle;
    effect.fence_version += 1;
    effect.last_authorized_at = this.currentTime;

    const attempt_id = `att_ref_${effect_key}_c${nextCycle}`;
    const newAttempt: RefAttempt = {
      attempt_id,
      cycle: nextCycle,
      state: 'RESERVED',
      reserved_at: this.currentTime,
      lease_expires_at: this.currentTime + 60000,
      dispatcher_identity: null,
      client_correlation_id: `corr_${attempt_id}`,
      has_dispatch_claim: false,
      provider_tx_id: null,
    };

    effect.attempts.set(attempt_id, newAttempt);
    effect.intents.set(idempotency_key, {
      idempotency_key,
      cycle: nextCycle,
      status: 'AUTHORIZED',
    });

    return { permitted: true, attempt_id, cycle: nextCycle };
  }

  /**
   * Reference Dispatch Claim & State Transition.
   */
  public dispatch(
    effect_key: string,
    attempt_id: string,
    dispatcher_identity: string,
    provider_tx_id = `ptx_${attempt_id}`
  ): { success: boolean; reason?: string } {
    const effect = this.effects.get(effect_key);
    if (!effect) return { success: false, reason: 'EFFECT_NOT_FOUND' };

    const attempt = effect.attempts.get(attempt_id);
    if (!attempt) return { success: false, reason: 'ATTEMPT_NOT_FOUND' };

    // Atomic claim check
    if (attempt.has_dispatch_claim) {
      return { success: false, reason: 'ALREADY_DISPATCHED' };
    }
    if (attempt.state !== 'RESERVED') {
      return { success: false, reason: `INVALID_STATE_${attempt.state}` };
    }

    attempt.has_dispatch_claim = true;
    attempt.provider_tx_id = provider_tx_id;
    attempt.state = 'DISPATCHED_UNRESOLVED';
    attempt.dispatcher_identity = dispatcher_identity;

    return { success: true };
  }

  /**
   * Ingest Evidence and trigger canonical derivation.
   */
  public ingestEvidence(
    effect_key: string,
    evidence_type: 'EXECUTION_CONFIRMED' | 'NON_EXECUTION_CONFIRMED' | 'TIMEOUT_CONFIRMED',
    client_correlation_id: string
  ): { evidence_id: string } {
    const effect = this.getOrCreateEffect(effect_key);
    const evidence_id = `ev_ref_${effect.evidence.length + 1}`;

    const claim_semantics =
      evidence_type === 'EXECUTION_CONFIRMED'
        ? 'EXECUTED'
        : evidence_type === 'NON_EXECUTION_CONFIRMED'
        ? 'CONFIRMED_NEVER_WILL_EXECUTE'
        : 'TIMEOUT_NEVER_EXECUTED';

    const ev: RefEvidence = {
      evidence_id,
      evidence_type,
      claim_semantics,
      client_correlation_id,
      timestamp: this.currentTime,
    };
    effect.evidence.push(ev);

    this.deriveCanonicalState(effect_key);
    return { evidence_id };
  }

  /**
   * Independent Canonical Execution & Terminal State Derivation.
   */
  public deriveCanonicalState(effect_key: string): RefEffect {
    const effect = this.getOrCreateEffect(effect_key);

    let hasExecutedEvidence = false;
    let hasConfirmedNeverEvidence = false;

    for (const ev of effect.evidence) {
      if (ev.claim_semantics === 'EXECUTED') {
        hasExecutedEvidence = true;
        // Monotonic executed_fact: once true, never reverts to false!
        effect.executed_fact = true;
      }
      if (ev.claim_semantics === 'CONFIRMED_NEVER_WILL_EXECUTE') {
        hasConfirmedNeverEvidence = true;
      }
    }

    // Contradiction Detection: Conflicting evidence for the same effect
    if (hasExecutedEvidence && hasConfirmedNeverEvidence) {
      // Find or create incident
      let incident = Array.from(effect.incidents.values())[0];
      if (!incident) {
        incident = {
          incident_id: `inc_ref_${effect_key}`,
          status: 'OPEN',
          primary_evidence_id: effect.evidence[0].evidence_id,
          conflicting_evidence_id: effect.evidence[1].evidence_id,
          fence_version: 1,
        };
        effect.incidents.set(incident.incident_id, incident);
      }
    }

    // Count open/unresolved contradictions
    let openCount = 0;
    for (const inc of effect.incidents.values()) {
      if (inc.status === 'OPEN' || inc.status === 'INVESTIGATING' || inc.status === 'ACKNOWLEDGED') {
        openCount++;
      }
    }
    effect.open_contradiction_count = openCount;

    // Terminal state evaluation
    if (openCount > 0) {
      effect.execution_state = 'CONTRADICTED_INCIDENT';
      effect.is_terminally_closed = false;
    } else if (effect.executed_fact) {
      effect.execution_state = 'EXECUTED';
      effect.is_terminally_closed = true;
    } else if (hasConfirmedNeverEvidence) {
      effect.execution_state = 'TERMINAL_NON_EXECUTION';
      effect.is_terminally_closed = true;
    } else {
      effect.execution_state = 'ACTIVE';
      effect.is_terminally_closed = false;
    }

    return effect;
  }

  /**
   * Reference Adjudication Engine.
   */
  public adjudicate(
    effect_key: string,
    incident_id: string,
    decision: 'REMAIN_BLOCKED_REQUIRE_EVIDENCE' | 'RESOLVE_FAVOR_EXECUTION' | 'RESOLVE_FAVOR_NON_EXECUTION' | 'DISMISS_CONTRADICTION',
    rationale: string
  ): { success: boolean; reason?: string } {
    const effect = this.effects.get(effect_key);
    if (!effect) return { success: false, reason: 'EFFECT_NOT_FOUND' };

    const incident = effect.incidents.get(incident_id);
    if (!incident) return { success: false, reason: 'INCIDENT_NOT_FOUND' };

    if (incident.status === 'ADJUDICATED' || incident.status === 'RESOLVED') {
      return { success: false, reason: 'ALREADY_ADJUDICATED' };
    }

    // Factual grounding checks
    if (decision === 'RESOLVE_FAVOR_EXECUTION') {
      const hasExecEv = effect.evidence.some((e) => e.claim_semantics === 'EXECUTED');
      if (!hasExecEv) {
        return { success: false, reason: 'INVALID_DECISION_NO_EXECUTION_EVIDENCE' };
      }
      incident.status = 'ADJUDICATED';
    } else if (decision === 'RESOLVE_FAVOR_NON_EXECUTION') {
      // Monotonicity: cannot resolve favor non-execution if executed_fact is true!
      if (effect.executed_fact) {
        return { success: false, reason: 'INVALID_DECISION_EXECUTED_FACT_MONOTONIC' };
      }
      incident.status = 'ADJUDICATED';
    } else if (decision === 'DISMISS_CONTRADICTION') {
      incident.status = 'ADJUDICATED';
    } else if (decision === 'REMAIN_BLOCKED_REQUIRE_EVIDENCE') {
      // Moves to INVESTIGATING: REMAINS BLOCKING!
      incident.status = 'INVESTIGATING';
    }

    incident.fence_version += 1;
    effect.fence_version += 1;

    effect.adjudications.push({
      adjudication_id: `adj_ref_${effect.adjudications.length + 1}`,
      incident_id,
      decision,
      rationale,
      resulting_fence_version: incident.fence_version,
    });

    this.deriveCanonicalState(effect_key);
    return { success: true };
  }

  /**
   * Reference Recovery: Releases expired leases on RESERVED attempts.
   * Never dispatches, never adjudicates, never manufactures facts.
   */
  public recover(effect_key: string, attempt_id: string): { success: boolean; reason?: string } {
    const effect = this.effects.get(effect_key);
    if (!effect) return { success: false, reason: 'EFFECT_NOT_FOUND' };

    const attempt = effect.attempts.get(attempt_id);
    if (!attempt) return { success: false, reason: 'ATTEMPT_NOT_FOUND' };

    if (attempt.state === 'RESERVED') {
      // Must have expired lease
      if (this.currentTime >= attempt.lease_expires_at) {
        attempt.state = 'RECOVERY_RELEASED';
        this.deriveCanonicalState(effect_key);
        return { success: true };
      }
      return { success: false, reason: 'LEASE_NOT_EXPIRED' };
    }

    return { success: false, reason: `ATTEMPT_NOT_RECOVERABLE_IN_STATE_${attempt.state}` };
  }

  /**
   * Reference Reconciliation: Scans for stalled DISPATCHED_UNRESOLVED attempts.
   */
  public reconcile(effect_key: string): { unresolved_attempts_found: number } {
    const effect = this.effects.get(effect_key);
    if (!effect) return { unresolved_attempts_found: 0 };

    let count = 0;
    for (const a of effect.attempts.values()) {
      if (a.state === 'DISPATCHED_UNRESOLVED') {
        count++;
      }
    }
    return { unresolved_attempts_found: count };
  }
}
