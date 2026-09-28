-- ============================================================================
-- CONTROL PLANE ORCHESTRATION SCHEMA - STAGE 1
-- Enforces finalized architectural invariants:
--  - G1: UNIQUE(execution_identity)
--  - Distinct: effect_key != attempt_id != execution_identity
--  - Distinct: client_correlation_id != provider_dedup_identity != provider_assigned_id
--  - Attempt states: RESERVED, DISPATCHED_UNRESOLVED, RECOVERY_RELEASED, etc.
--  - Append-only safety records for evidence and audit events
--  - Coexistence of executed_fact and contradiction incidents (no erasure)
--  - Capability contract metadata for SAFE_REPEAT dedup window enforcement
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. PRINCIPALS (Actors / Execution Principals)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS principals (
    principal_id VARCHAR(128) PRIMARY KEY,
    type VARCHAR(32) NOT NULL CHECK (type IN ('AGENT', 'WORKER', 'USER', 'SYSTEM')),
    name VARCHAR(255) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'SUSPENDED')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 2. CAPABILITIES & CAPABILITY CONTRACTS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS capabilities (
    capability_id VARCHAR(128) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS capability_contracts (
    capability_id VARCHAR(128) NOT NULL REFERENCES capabilities(capability_id) ON DELETE RESTRICT,
    version VARCHAR(32) NOT NULL,
    repeat_mode VARCHAR(32) NOT NULL CHECK (repeat_mode IN ('SAFE_REPEAT', 'UNSAFE_REPEAT')),
    effect_key_canonicalization_version VARCHAR(32) NOT NULL,
    required_effect_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
    provider_dedup_semantics VARCHAR(128) NOT NULL,
    provider_dedup_identity_rule TEXT NOT NULL,
    dedup_validity_window_seconds INTEGER NULL,
    supported_evidence_types JSONB NOT NULL DEFAULT '[]'::jsonb,
    evidence_correlation_method VARCHAR(64) NOT NULL,
    reconciliation_characteristics JSONB NOT NULL DEFAULT '{}'::jsonb,
    heartbeat_interval_seconds INTEGER NULL,
    max_unresolved_duration_seconds INTEGER NOT NULL DEFAULT 600,
    contract_status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' CHECK (contract_status IN ('DRAFT', 'ACTIVE', 'DEPRECATED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (capability_id, version),
    CONSTRAINT check_dedup_window CHECK (
        (repeat_mode = 'SAFE_REPEAT' AND dedup_validity_window_seconds IS NOT NULL AND dedup_validity_window_seconds > 0)
        OR (repeat_mode = 'UNSAFE_REPEAT' AND dedup_validity_window_seconds IS NULL)
    )
);

-- ----------------------------------------------------------------------------
-- 3. POLICIES & POLICY VERSIONS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS policy_versions (
    policy_version_id VARCHAR(128) PRIMARY KEY,
    policy_name VARCHAR(255) NOT NULL,
    version VARCHAR(32) NOT NULL,
    rules_definition JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (policy_name, version)
);

-- ----------------------------------------------------------------------------
-- 4. EFFECTS (Authoritative Real-World Effect Identity)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS effects (
    effect_key VARCHAR(255) PRIMARY KEY,
    capability_id VARCHAR(128) NOT NULL,
    capability_version VARCHAR(32) NOT NULL,
    canonical_payload JSONB NOT NULL,
    canonicalization_version VARCHAR(32) NOT NULL DEFAULT 'v1',
    repeat_mode VARCHAR(32) NOT NULL CHECK (repeat_mode IN ('SAFE_REPEAT', 'UNSAFE_REPEAT')),
    executed_fact BOOLEAN NOT NULL DEFAULT FALSE,
    execution_state VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (execution_state IN ('PENDING', 'ACTIVE', 'EXECUTED', 'TERMINAL_NON_EXECUTED', 'CONTRADICTED_INCIDENT')),
    dedup_window_started_at TIMESTAMPTZ NULL,
    dedup_window_expires_at TIMESTAMPTZ NULL,
    executed_at TIMESTAMPTZ NULL,
    first_dispatched_at TIMESTAMPTZ NULL,
    last_dispatched_at TIMESTAMPTZ NULL,
    current_cycle INTEGER NOT NULL DEFAULT 0,
    active_attempt_id VARCHAR(128) NULL,
    terminal_attempt_id VARCHAR(128) NULL,
    fence_version BIGINT NOT NULL DEFAULT 1,
    owner_principal_id VARCHAR(128) NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (capability_id, capability_version) REFERENCES capability_contracts(capability_id, version) ON DELETE RESTRICT
);

-- ----------------------------------------------------------------------------
-- 5. INTENTS (Different intents may converge on the same effect_key)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intents (
    intent_id VARCHAR(128) PRIMARY KEY,
    principal_id VARCHAR(128) NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    target_effect_key VARCHAR(255) NOT NULL REFERENCES effects(effect_key) ON DELETE RESTRICT,
    policy_version_id VARCHAR(128) NOT NULL REFERENCES policy_versions(policy_version_id) ON DELETE RESTRICT,
    idempotency_key VARCHAR(128) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(32) NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED', 'AUTHORIZED', 'CONVERGED', 'REJECTED', 'COMPLETED', 'CANCELLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (principal_id, idempotency_key)
);

-- ----------------------------------------------------------------------------
-- 6. INTERNAL BUDGETS & BUDGET RESERVATIONS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS principal_budgets (
    principal_id VARCHAR(128) NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    currency_or_unit VARCHAR(32) NOT NULL,
    budget_limit NUMERIC(14, 4) NOT NULL,
    reserved_amount NUMERIC(14, 4) NOT NULL DEFAULT 0.0000,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (principal_id, currency_or_unit),
    CONSTRAINT check_reserved_budget CHECK (reserved_amount <= budget_limit)
);

CREATE TABLE IF NOT EXISTS budget_reservations (
    reservation_id VARCHAR(128) PRIMARY KEY,
    principal_id VARCHAR(128) NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    effect_key VARCHAR(255) NOT NULL REFERENCES effects(effect_key) ON DELETE RESTRICT,
    amount NUMERIC(14, 4) NOT NULL,
    currency_or_unit VARCHAR(32) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED', 'COMMITTED', 'RELEASED')),
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    committed_at TIMESTAMPTZ NULL,
    released_at TIMESTAMPTZ NULL
);

-- ----------------------------------------------------------------------------
-- 7. AUTHORIZATIONS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS authorizations (
    authorization_id VARCHAR(128) PRIMARY KEY,
    intent_id VARCHAR(128) NOT NULL REFERENCES intents(intent_id) ON DELETE RESTRICT,
    effect_key VARCHAR(255) NOT NULL REFERENCES effects(effect_key) ON DELETE RESTRICT,
    principal_id VARCHAR(128) NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    policy_version_id VARCHAR(128) NOT NULL REFERENCES policy_versions(policy_version_id) ON DELETE RESTRICT,
    budget_reservation_id VARCHAR(128) NULL REFERENCES budget_reservations(reservation_id) ON DELETE RESTRICT,
    authorized_cycle INTEGER NOT NULL,
    scope VARCHAR(128) NOT NULL DEFAULT 'default',
    repeat_authorization_type VARCHAR(64) NOT NULL CHECK (repeat_authorization_type IN (
        'INITIAL_ATTEMPT',
        'SAFE_REPEAT_ALLOWED',
        'UNSAFE_REPEAT_PERMITTED_TERMINAL_VERIFIED'
    )),
    dedup_window_expires_at TIMESTAMPTZ NULL,
    authorization_status VARCHAR(32) NOT NULL DEFAULT 'VALID' CHECK (authorization_status IN ('VALID', 'CONSUMED', 'EXPIRED', 'REVOKED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 8. ATTEMPTS (Authoritative Control-Plane Dispatch Boundary)
-- Invariants Enforced:
--  - UNIQUE(execution_identity) directly on the table
--  - Distinct: effect_key, cycle_number, execution_identity
--  - Distinct: client_correlation_id, provider_dedup_identity, provider_assigned_id
--  - States: RESERVED, DISPATCHED_UNRESOLVED, RECOVERY_RELEASED,
--            COMPLETED_EXECUTED, COMPLETED_NON_EXECUTED, FAILED_TERMINAL
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attempts (
    attempt_id VARCHAR(128) PRIMARY KEY,
    effect_key VARCHAR(255) NOT NULL REFERENCES effects(effect_key) ON DELETE RESTRICT,
    cycle_number INTEGER NOT NULL,
    authorization_id VARCHAR(128) NOT NULL REFERENCES authorizations(authorization_id) ON DELETE RESTRICT,
    execution_identity VARCHAR(255) NOT NULL UNIQUE,
    client_correlation_id VARCHAR(128) NOT NULL UNIQUE,
    provider_dedup_identity VARCHAR(255) NULL,
    provider_assigned_id VARCHAR(255) NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'RESERVED' CHECK (state IN (
        'RESERVED',
        'DISPATCHED_UNRESOLVED',
        'RECOVERY_RELEASED',
        'COMPLETED_EXECUTED',
        'COMPLETED_NON_EXECUTED',
        'FAILED_TERMINAL'
    )),
    fence_version BIGINT NOT NULL DEFAULT 1,
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    dispatched_at TIMESTAMPTZ NULL,
    resolved_at TIMESTAMPTZ NULL,
    last_heartbeat_at TIMESTAMPTZ NULL,
    heartbeat_deadline_at TIMESTAMPTZ NULL,
    recovery_reason TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (effect_key, cycle_number)
);

-- ----------------------------------------------------------------------------
-- 9. DISPATCH CLAIMS (Audit/Correlation Data)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dispatch_claims (
    claim_id VARCHAR(128) PRIMARY KEY,
    attempt_id VARCHAR(128) NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
    client_correlation_id VARCHAR(128) NOT NULL UNIQUE REFERENCES attempts(client_correlation_id) ON DELETE RESTRICT,
    execution_identity VARCHAR(255) NULL REFERENCES attempts(execution_identity) ON DELETE RESTRICT,
    effect_key VARCHAR(255) NULL REFERENCES effects(effect_key) ON DELETE RESTRICT,
    authorization_id VARCHAR(128) NULL REFERENCES authorizations(authorization_id) ON DELETE RESTRICT,
    provider_dedup_identity VARCHAR(255) NULL,
    capability_id VARCHAR(128) NULL,
    capability_version VARCHAR(32) NULL,
    policy_version_id VARCHAR(128) NULL,
    dispatcher_identity VARCHAR(128) NOT NULL,
    lease_token VARCHAR(128) NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_expires_at TIMESTAMPTZ NOT NULL,
    committed_at TIMESTAMPTZ NULL
);

-- Idempotent column additions for existing databases
ALTER TABLE dispatch_claims ADD COLUMN IF NOT EXISTS execution_identity VARCHAR(255) NULL REFERENCES attempts(execution_identity) ON DELETE RESTRICT;
ALTER TABLE dispatch_claims ADD COLUMN IF NOT EXISTS effect_key VARCHAR(255) NULL REFERENCES effects(effect_key) ON DELETE RESTRICT;
ALTER TABLE dispatch_claims ADD COLUMN IF NOT EXISTS authorization_id VARCHAR(128) NULL REFERENCES authorizations(authorization_id) ON DELETE RESTRICT;
ALTER TABLE dispatch_claims ADD COLUMN IF NOT EXISTS provider_dedup_identity VARCHAR(255) NULL;
ALTER TABLE dispatch_claims ADD COLUMN IF NOT EXISTS capability_id VARCHAR(128) NULL;
ALTER TABLE dispatch_claims ADD COLUMN IF NOT EXISTS capability_version VARCHAR(32) NULL;
ALTER TABLE dispatch_claims ADD COLUMN IF NOT EXISTS policy_version_id VARCHAR(128) NULL;

-- Trigger: Ensure a dispatch claim cannot be inserted for an attempt in RECOVERY_RELEASED state
CREATE OR REPLACE FUNCTION check_dispatch_claim_attempt_state()
RETURNS TRIGGER AS $$
DECLARE
    v_attempt_state VARCHAR(32);
BEGIN
    SELECT state INTO v_attempt_state FROM attempts WHERE attempt_id = NEW.attempt_id;
    IF v_attempt_state = 'RECOVERY_RELEASED' THEN
        RAISE EXCEPTION 'Invariant violation: Cannot create dispatch claim for attempt % in RECOVERY_RELEASED state', NEW.attempt_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_check_dispatch_claim_attempt_state ON dispatch_claims;
CREATE TRIGGER trg_check_dispatch_claim_attempt_state
BEFORE INSERT ON dispatch_claims
FOR EACH ROW
EXECUTE FUNCTION check_dispatch_claim_attempt_state();

-- ----------------------------------------------------------------------------
-- 10. EVIDENCE RECORDS (Append-Only Safety Records)
-- Claim-Specific Attribution; RECOVERY_RELEASED is NOT execution evidence.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evidence_records (
    evidence_id VARCHAR(128) PRIMARY KEY,
    effect_key VARCHAR(255) NULL REFERENCES effects(effect_key) ON DELETE RESTRICT,
    attempt_id VARCHAR(128) NULL REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
    claim_id VARCHAR(128) NULL REFERENCES dispatch_claims(claim_id) ON DELETE RESTRICT,
    evidence_type VARCHAR(64) NOT NULL CHECK (evidence_type IN (
        'EXECUTION_CONFIRMED',
        'NON_EXECUTION_CONFIRMED',
        'PROVIDER_ACCEPTED',
        'PROVIDER_REJECTED',
        'PROVIDER_TIMEOUT',
        'UNKNOWN_DISPATCH_FAILURE',
        'RECONCILIATION_REPORT'
    )),
    claim_semantics VARCHAR(64) NULL,
    correlation_method VARCHAR(64) NOT NULL,
    client_correlation_id VARCHAR(128) NULL,
    provider_assigned_id VARCHAR(255) NULL,
    provider_dedup_identity VARCHAR(255) NULL,
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    payload_hash VARCHAR(128) NULL,
    source_channel VARCHAR(128) NULL,
    source_event_id VARCHAR(255) NULL UNIQUE,
    capability_id VARCHAR(128) NULL,
    capability_version VARCHAR(32) NULL,
    recorded_by_principal_id VARCHAR(128) NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent column additions for existing databases
ALTER TABLE evidence_records ALTER COLUMN attempt_id DROP NOT NULL;
ALTER TABLE evidence_records ALTER COLUMN effect_key DROP NOT NULL;
ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS claim_semantics VARCHAR(64) NULL;
ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS payload_hash VARCHAR(128) NULL;
ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS source_channel VARCHAR(128) NULL;
ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS source_event_id VARCHAR(255) NULL UNIQUE;
ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS capability_id VARCHAR(128) NULL;
ALTER TABLE evidence_records ADD COLUMN IF NOT EXISTS capability_version VARCHAR(32) NULL;

-- Trigger: Append-only enforcement on evidence_records
CREATE OR REPLACE FUNCTION enforce_evidence_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Invariant violation: evidence_records is an append-only safety log and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_evidence_append_only ON evidence_records;
CREATE TRIGGER trg_evidence_append_only
BEFORE UPDATE OR DELETE ON evidence_records
FOR EACH ROW
EXECUTE FUNCTION enforce_evidence_append_only();

-- ----------------------------------------------------------------------------
-- 11. CONTRADICTIONS & INCIDENTS
-- Must coexist with executed_fact = TRUE (never overwrites history).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contradiction_incidents (
    incident_id VARCHAR(128) PRIMARY KEY,
    effect_key VARCHAR(255) NOT NULL REFERENCES effects(effect_key) ON DELETE RESTRICT,
    attempt_id VARCHAR(128) NULL REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
    primary_evidence_id VARCHAR(128) NOT NULL REFERENCES evidence_records(evidence_id) ON DELETE RESTRICT,
    conflicting_evidence_id VARCHAR(128) NOT NULL REFERENCES evidence_records(evidence_id) ON DELETE RESTRICT,
    severity VARCHAR(32) NOT NULL DEFAULT 'HIGH' CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    status VARCHAR(32) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'INVESTIGATING', 'ACKNOWLEDGED', 'RESOLVED', 'ADJUDICATED')),
    summary TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    resolution_notes TEXT NULL,
    fence_version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE contradiction_incidents ADD COLUMN IF NOT EXISTS fence_version BIGINT NOT NULL DEFAULT 1;

-- ----------------------------------------------------------------------------
-- 12. AUDIT EVENTS (Append-Only Event Store)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
    event_id VARCHAR(128) PRIMARY KEY,
    sequence_number BIGSERIAL,
    aggregate_type VARCHAR(32) NOT NULL CHECK (aggregate_type IN (
        'EFFECT', 'ATTEMPT', 'INTENT', 'AUTHORIZATION', 'EVIDENCE', 'INCIDENT', 'CONTRACT', 'BUDGET', 'ADJUDICATION'
    )),
    aggregate_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    actor_principal_id VARCHAR(128) NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger: Append-only enforcement on audit_events
CREATE OR REPLACE FUNCTION enforce_audit_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Invariant violation: audit_events is an append-only log and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_append_only ON audit_events;
CREATE TRIGGER trg_audit_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW
EXECUTE FUNCTION enforce_audit_append_only();

-- ----------------------------------------------------------------------------
-- 16. ADJUDICATION RECORDS (Stage 8 Control-Plane Safety & Decision Audit Log)
-- Adjudication belongs to control-plane decisions, NEVER rewrites external-world facts.
-- Append-only audit record.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS adjudication_records (
    adjudication_id VARCHAR(128) PRIMARY KEY,
    incident_id VARCHAR(128) NOT NULL REFERENCES contradiction_incidents(incident_id) ON DELETE RESTRICT,
    effect_key VARCHAR(255) NOT NULL REFERENCES effects(effect_key) ON DELETE RESTRICT,
    adjudicator_principal_id VARCHAR(128) NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
    decision VARCHAR(64) NOT NULL CHECK (decision IN (
        'RESOLVE_FAVOR_EXECUTION',
        'RESOLVE_FAVOR_NON_EXECUTION',
        'REMAIN_BLOCKED_REQUIRE_EVIDENCE',
        'DISMISS_CONTRADICTION'
    )),
    rationale TEXT NOT NULL,
    policy_version_id VARCHAR(128) NOT NULL REFERENCES policy_versions(policy_version_id) ON DELETE RESTRICT,
    referenced_evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    prior_incident_status VARCHAR(32) NOT NULL,
    resulting_incident_status VARCHAR(32) NOT NULL,
    fence_version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger: Append-only enforcement on adjudication_records
CREATE OR REPLACE FUNCTION enforce_adjudication_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Invariant violation: adjudication_records is an append-only log and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_adjudication_append_only ON adjudication_records;
CREATE TRIGGER trg_adjudication_append_only
BEFORE UPDATE OR DELETE ON adjudication_records
FOR EACH ROW
EXECUTE FUNCTION enforce_adjudication_append_only();

CREATE INDEX IF NOT EXISTS idx_adjudications_incident ON adjudication_records(incident_id);
CREATE INDEX IF NOT EXISTS idx_adjudications_effect ON adjudication_records(effect_key);

-- ----------------------------------------------------------------------------
-- INDEXES FOR HIGH-THROUGHPUT CONTROL PLANE LOOKUPS
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_attempts_effect_cycle ON attempts(effect_key, cycle_number);
CREATE INDEX IF NOT EXISTS idx_attempts_state ON attempts(state);
CREATE INDEX IF NOT EXISTS idx_attempts_correlation ON attempts(client_correlation_id);
CREATE INDEX IF NOT EXISTS idx_evidence_attempt ON evidence_records(attempt_id);
CREATE INDEX IF NOT EXISTS idx_evidence_effect ON evidence_records(effect_key);
CREATE INDEX IF NOT EXISTS idx_incidents_effect ON contradiction_incidents(effect_key);
CREATE INDEX IF NOT EXISTS idx_intents_effect ON intents(target_effect_key);
CREATE INDEX IF NOT EXISTS idx_authorizations_effect ON authorizations(effect_key);

-- ----------------------------------------------------------------------------
-- 13. STAGE 6 INVARIANTS: EXECUTION MONOTONICITY & STATE INTEGRITY
-- ----------------------------------------------------------------------------
-- Trigger: executed_fact on effects is strictly monotonic (cannot be cleared once TRUE)
CREATE OR REPLACE FUNCTION enforce_effect_executed_fact_monotonic()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.executed_fact = TRUE AND NEW.executed_fact = FALSE THEN
        RAISE EXCEPTION 'Invariant violation: executed_fact on effects is monotonic and cannot be cleared once true';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_effect_executed_monotonic ON effects;
CREATE TRIGGER trg_effect_executed_monotonic
BEFORE UPDATE ON effects
FOR EACH ROW
EXECUTE FUNCTION enforce_effect_executed_fact_monotonic();

-- Trigger: COMPLETED_EXECUTED on attempts is strictly monotonic
CREATE OR REPLACE FUNCTION enforce_attempt_state_invariants()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.state = 'COMPLETED_EXECUTED' AND NEW.state != 'COMPLETED_EXECUTED' THEN
        RAISE EXCEPTION 'Invariant violation: attempt state COMPLETED_EXECUTED is monotonic and cannot be altered';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_attempt_state_invariants ON attempts;
CREATE TRIGGER trg_attempt_state_invariants
BEFORE UPDATE ON attempts
FOR EACH ROW
EXECUTE FUNCTION enforce_attempt_state_invariants();

-- ----------------------------------------------------------------------------
-- 14. PROJECT STAGE STATUS TRACKER (Persistent Progress Tracking)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_stage_status (
    stage_number INTEGER PRIMARY KEY,
    stage_name VARCHAR(255) NOT NULL,
    status VARCHAR(32) NOT NULL CHECK (status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETE')),
    completed_at TIMESTAMPTZ NULL,
    notes TEXT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 15. RECONCILIATION TASKS (Stage 7 Control-Plane Task Tracking)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reconciliation_tasks (
    task_id VARCHAR(128) PRIMARY KEY,
    attempt_id VARCHAR(128) NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE RESTRICT,
    effect_key VARCHAR(255) NOT NULL REFERENCES effects(effect_key) ON DELETE RESTRICT,
    client_correlation_id VARCHAR(128) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'IN_PROGRESS', 'RESOLVED', 'ABANDONED')),
    reason TEXT NOT NULL,
    unresolved_duration_seconds INTEGER NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE attempts ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ NULL;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS heartbeat_deadline_at TIMESTAMPTZ NULL;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS recovery_reason TEXT NULL;



