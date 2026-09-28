/**
 * @file src/schema/types.ts
 * TypeScript domain model for Stage 1 Orchestration Control Plane.
 *
 * ARCHITECTURAL FACTS LOCKED:
 *  - Effect Identity != Attempt Identity (effect_key vs attempt_id vs execution_identity)
 *  - Execution Identity is unique (G1: UNIQUE(execution_identity))
 *  - Correlation IDs have distinct semantics:
 *      1. client_correlation_id: Generated prior to dispatch, present for every attempt.
 *      2. provider_dedup_identity: Contract-dependent, used for SAFE_REPEAT, stable across retries.
 *      3. provider_assigned_id: Nullable, only populated if provider returns an identifier.
 *  - Attempt state is the dispatch boundary (RESERVED -> DISPATCHED_UNRESOLVED vs RECOVERY_RELEASED).
 *  - RECOVERY_RELEASED is NOT external non-execution evidence.
 *  - Evidence is claim-specific and append-only.
 *  - Executed fact and contradiction incidents are strictly separated (never erase executed fact).
 */

export type PrincipalType = 'AGENT' | 'WORKER' | 'USER' | 'SYSTEM';
export type PrincipalStatus = 'ACTIVE' | 'REVOKED' | 'SUSPENDED';

export interface Principal {
  principal_id: string;
  type: PrincipalType;
  name: string;
  status: PrincipalStatus;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export type RepeatMode = 'SAFE_REPEAT' | 'UNSAFE_REPEAT';
export type ContractStatus = 'DRAFT' | 'ACTIVE' | 'DEPRECATED';

export interface Capability {
  capability_id: string;
  name: string;
  description: string | null;
  created_at: Date;
}

export interface CapabilityContract {
  capability_id: string;
  version: string;
  repeat_mode: RepeatMode;
  effect_key_canonicalization_version: string;
  required_effect_fields: string[];
  provider_dedup_semantics: string;
  provider_dedup_identity_rule: string;
  /** Nullable; required and > 0 if SAFE_REPEAT, must be null if UNSAFE_REPEAT */
  dedup_validity_window_seconds: number | null;
  supported_evidence_types: string[];
  evidence_correlation_method: string;
  reconciliation_characteristics: Record<string, unknown>;
  heartbeat_interval_seconds: number | null;
  max_unresolved_duration_seconds: number;
  contract_status: ContractStatus;
  created_at: Date;
}

export interface PolicyVersion {
  policy_version_id: string;
  policy_name: string;
  version: string;
  rules_definition: Record<string, unknown>;
  is_active: boolean;
  created_at: Date;
}

export type EffectExecutionState =
  | 'PENDING'
  | 'ACTIVE'
  | 'EXECUTED'
  | 'TERMINAL_NON_EXECUTED'
  | 'CONTRADICTED_INCIDENT';

export interface Effect {
  /** Authoritative real-world effect identity */
  effect_key: string;
  capability_id: string;
  capability_version: string;
  canonical_payload: Record<string, unknown>;
  canonicalization_version: string;
  repeat_mode: RepeatMode;
  /**
   * Execution fact: Once established by execution evidence, contradiction handling
   * MUST NOT clear or overwrite this fact.
   */
  executed_fact: boolean;
  execution_state: EffectExecutionState;
  dedup_window_started_at: Date | null;
  dedup_window_expires_at: Date | null;
  executed_at: Date | null;
  first_dispatched_at: Date | null;
  last_dispatched_at: Date | null;
  current_cycle: number;
  active_attempt_id: string | null;
  terminal_attempt_id: string | null;
  /** Optimistic concurrency fencing token */
  fence_version: number;
  owner_principal_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export type IntentStatus =
  | 'SUBMITTED'
  | 'AUTHORIZED'
  | 'CONVERGED'
  | 'REJECTED'
  | 'COMPLETED'
  | 'CANCELLED';

export interface Intent {
  intent_id: string;
  principal_id: string;
  /** Different INTENTs may converge on the same target_effect_key */
  target_effect_key: string;
  policy_version_id: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  status: IntentStatus;
  created_at: Date;
}

export interface PrincipalBudget {
  principal_id: string;
  currency_or_unit: string;
  budget_limit: number;
  reserved_amount: number;
  created_at: Date;
  updated_at: Date;
}

export type BudgetReservationStatus = 'RESERVED' | 'COMMITTED' | 'RELEASED';

export interface BudgetReservation {
  reservation_id: string;
  principal_id: string;
  effect_key: string;
  amount: number;
  currency_or_unit: string;
  status: BudgetReservationStatus;
  reserved_at: Date;
  committed_at: Date | null;
  released_at: Date | null;
}

export type RepeatAuthorizationType =
  | 'INITIAL_ATTEMPT'
  | 'SAFE_REPEAT_ALLOWED'
  | 'UNSAFE_REPEAT_PERMITTED_TERMINAL_VERIFIED';

export type AuthorizationStatus = 'VALID' | 'CONSUMED' | 'EXPIRED' | 'REVOKED';

export interface Authorization {
  authorization_id: string;
  intent_id: string;
  effect_key: string;
  principal_id: string;
  policy_version_id: string;
  budget_reservation_id: string | null;
  authorized_cycle: number;
  scope: string;
  repeat_authorization_type: RepeatAuthorizationType;
  dedup_window_expires_at: Date | null;
  authorization_status: AuthorizationStatus;
  created_at: Date;
}

export type AttemptState =
  | 'RESERVED'
  | 'DISPATCHED_UNRESOLVED'
  | 'RECOVERY_RELEASED'
  | 'COMPLETED_EXECUTED'
  | 'COMPLETED_NON_EXECUTED'
  | 'FAILED_TERMINAL';

export interface Attempt {
  /** Unique ID for this specific control-plane dispatch cycle */
  attempt_id: string;
  /** Linkage to authoritative real-world effect identity */
  effect_key: string;
  cycle_number: number;
  authorization_id: string;
  /**
   * INVARIANT B (G1): An execution_identity may have at most one intentional dispatch attempt.
   * Database enforces UNIQUE(execution_identity).
   */
  execution_identity: string;
  /**
   * INVARIANT C1: Generated by control plane before dispatch. Present for every attempt.
   */
  client_correlation_id: string;
  /**
   * INVARIANT C2: Contract-dependent. Used when SAFE_REPEAT relies on provider-side dedup.
   * May remain stable across multiple cycles of the same logical effect.
   * MUST NOT be treated as identifying a unique attempt.
   */
  provider_dedup_identity: string | null;
  /**
   * INVARIANT C3: Nullable. Populated only if provider returns an identifier.
   */
  provider_assigned_id: string | null;
  /**
   * INVARIANT D: Authoritative dispatch boundary state.
   */
  state: AttemptState;
  fence_version: number;
  reserved_at: Date;
  dispatched_at: Date | null;
  resolved_at: Date | null;
  last_heartbeat_at?: Date | null;
  heartbeat_deadline_at?: Date | null;
  recovery_reason?: string | null;
  created_at: Date;
  updated_at: Date;
}

export type ReconciliationTaskStatus = 'PENDING' | 'IN_PROGRESS' | 'RESOLVED' | 'ABANDONED';

export interface ReconciliationTask {
  task_id: string;
  attempt_id: string;
  effect_key: string;
  client_correlation_id: string;
  status: ReconciliationTaskStatus;
  reason: string;
  unresolved_duration_seconds: number;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface DispatchClaim {
  claim_id: string;
  attempt_id: string;
  client_correlation_id: string;
  execution_identity?: string | null;
  effect_key?: string | null;
  authorization_id?: string | null;
  provider_dedup_identity?: string | null;
  capability_id?: string | null;
  capability_version?: string | null;
  policy_version_id?: string | null;
  dispatcher_identity: string;
  lease_token: string;
  claimed_at: Date;
  lease_expires_at: Date;
  committed_at: Date | null;
}

export type EvidenceType =
  | 'EXECUTION_CONFIRMED'
  | 'NON_EXECUTION_CONFIRMED'
  | 'PROVIDER_ACCEPTED'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_TIMEOUT'
  | 'UNKNOWN_DISPATCH_FAILURE'
  | 'RECONCILIATION_REPORT';

export type ClaimSemantics =
  | 'ACCEPTED'
  | 'EXECUTED'
  | 'CONFIRMED_NEVER_WILL_EXECUTE'
  | 'PROVIDER_REJECTED'
  | 'TIMEOUT'
  | 'UNKNOWN_FAILURE'
  | 'UNCORRELATED';

export interface EvidenceRecord {
  evidence_id: string;
  effect_key: string | null;
  attempt_id: string | null;
  claim_id: string | null;
  evidence_type: EvidenceType;
  claim_semantics?: ClaimSemantics | null;
  correlation_method: string;
  client_correlation_id: string | null;
  provider_assigned_id: string | null;
  provider_dedup_identity: string | null;
  raw_payload: Record<string, unknown>;
  payload_hash?: string | null;
  source_channel?: string | null;
  source_event_id?: string | null;
  capability_id?: string | null;
  capability_version?: string | null;
  recorded_by_principal_id: string | null;
  verified_at: Date;
  recorded_at: Date;
}

export type IncidentSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type IncidentStatus = 'OPEN' | 'INVESTIGATING' | 'ACKNOWLEDGED' | 'RESOLVED' | 'ADJUDICATED';

/**
 * Authoritative set of contradiction incident statuses that represent an active,
 * unresolved safety-relevant contradiction.
 * While an incident is in any of these states, it must block:
 * 1. Authorization of new operations on the affected effect (fail closed).
 * 2. Terminal closure of the affected effect in canonical derivation.
 * 3. Ledger repeat gating.
 */
export const UNRESOLVED_INCIDENT_STATUSES: readonly IncidentStatus[] = [
  'OPEN',
  'INVESTIGATING',
  'ACKNOWLEDGED',
] as const;

export const RESOLVED_INCIDENT_STATUSES: readonly IncidentStatus[] = [
  'RESOLVED',
  'ADJUDICATED',
] as const;

export function isUnresolvedContradictionStatus(status: string): boolean {
  return (UNRESOLVED_INCIDENT_STATUSES as readonly string[]).includes(status);
}

export interface ContradictionIncident {
  incident_id: string;
  effect_key: string;
  attempt_id: string | null;
  primary_evidence_id: string;
  conflicting_evidence_id: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  summary: string;
  details: Record<string, unknown>;
  resolution_notes: string | null;
  fence_version?: number;
  created_at: Date;
  updated_at: Date;
}

export type AdjudicationDecision =
  | 'RESOLVE_FAVOR_EXECUTION'
  | 'RESOLVE_FAVOR_NON_EXECUTION'
  | 'REMAIN_BLOCKED_REQUIRE_EVIDENCE'
  | 'DISMISS_CONTRADICTION';

export interface AdjudicationRecord {
  adjudication_id: string;
  incident_id: string;
  effect_key: string;
  adjudicator_principal_id: string;
  decision: AdjudicationDecision;
  rationale: string;
  policy_version_id: string;
  referenced_evidence_ids: string[];
  prior_incident_status: string;
  resulting_incident_status: string;
  fence_version: number;
  created_at: Date;
}

export type AuditEventAggregateType =
  | 'EFFECT'
  | 'ATTEMPT'
  | 'INTENT'
  | 'AUTHORIZATION'
  | 'EVIDENCE'
  | 'INCIDENT'
  | 'CONTRACT'
  | 'BUDGET'
  | 'ADJUDICATION';

export interface AuditEvent {
  event_id: string;
  sequence_number: number;
  aggregate_type: AuditEventAggregateType;
  aggregate_id: string;
  event_type: string;
  actor_principal_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}
