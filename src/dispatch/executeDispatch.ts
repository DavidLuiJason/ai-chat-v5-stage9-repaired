/**
 * @file src/dispatch/executeDispatch.ts
 * Stage 4: Controlled Dispatch Boundary & Atomic Dispatch Claim.
 *
 * Locked Architectural Invariants:
 *  - Atomicity: Claim creation and RESERVED -> DISPATCHED_UNRESOLVED transition
 *    occur in the EXACT SAME database transaction under attempt-row serialization.
 *  - Provider Boundary: The provider adapter is invoked ONLY AFTER the atomic
 *    transaction commits.
 *  - Pre-dispatch Validation: Attempt must be RESERVED, expected fence version must match,
 *    authorization must be VALID, and execution_identity must not be reused.
 *  - Post-Commit Failure Invariant: If provider invocation fails after commit,
 *    the attempt remains DISPATCHED_UNRESOLVED. It is never reverted to RESERVED.
 *  - Evidence Invariant: Provider response does NOT transition attempt to COMPLETED_EXECUTED
 *    or declare execution truth. The attempt remains DISPATCHED_UNRESOLVED.
 */

import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import {
  CommittedDispatch,
  DispatchError,
  DispatchExecutionHooks,
  DispatchParams,
  ExecuteDispatchResult,
} from './types.ts';
import { ProviderAdapter, ProviderDispatchPayload, ProviderDispatchResponse } from './providerAdapter.ts';

interface AttemptRowLockResult {
  attempt_id: string;
  effect_key: string;
  cycle_number: number;
  authorization_id: string;
  execution_identity: string;
  client_correlation_id: string;
  provider_dedup_identity: string | null;
  provider_assigned_id: string | null;
  state: string;
  fence_version: string | number;
  authorization_status: string;
  principal_id: string;
  scope: string;
  policy_version_id: string;
  capability_id: string;
  capability_version: string;
  canonical_payload: Record<string, unknown> | string;
}

/**
 * Performs the atomic dispatch transaction under attempt-row serialization.
 * Enforces:
 *  1. SELECT attempt ... FOR UPDATE
 *  2. Verification: state == RESERVED, fence_version == expected, authorization == VALID
 *  3. INSERT INTO dispatch_claims
 *  4. UPDATE attempts SET state = 'DISPATCHED_UNRESOLVED', fence_version = fence_version + 1
 *  5. COMMIT
 */
export async function performDispatchTransaction(
  db: PGlite,
  params: DispatchParams
): Promise<CommittedDispatch> {
  const leaseToken = params.lease_token ?? `lease_${randomUUID()}`;
  const leaseDurationMs = params.lease_duration_ms ?? 300_000; // 5 minutes default
  const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);

  return await db.transaction<CommittedDispatch>(async (tx) => {
    // ------------------------------------------------------------------------
    // 1. ACQUIRE ROW LOCK ON ATTEMPT (Serialization Point)
    // ------------------------------------------------------------------------
    let query: string;
    let queryParams: unknown[];

    if (params.attempt_id) {
      query = `
        SELECT a.attempt_id, a.effect_key, a.cycle_number, a.authorization_id,
               a.execution_identity, a.client_correlation_id, a.provider_dedup_identity,
               a.provider_assigned_id, a.state, a.fence_version,
               auth.authorization_status, auth.principal_id, auth.scope, auth.policy_version_id,
               eff.capability_id, eff.capability_version, eff.canonical_payload
        FROM attempts a
        JOIN authorizations auth ON a.authorization_id = auth.authorization_id
        JOIN effects eff ON a.effect_key = eff.effect_key
        WHERE a.attempt_id = $1
        FOR UPDATE OF a;
      `;
      queryParams = [params.attempt_id];
    } else {
      if (params.cycle_number === undefined) {
        throw new DispatchError(
          'ATTEMPT_NOT_FOUND',
          'Either attempt_id or cycle_number must be specified for dispatch.'
        );
      }
      query = `
        SELECT a.attempt_id, a.effect_key, a.cycle_number, a.authorization_id,
               a.execution_identity, a.client_correlation_id, a.provider_dedup_identity,
               a.provider_assigned_id, a.state, a.fence_version,
               auth.authorization_status, auth.principal_id, auth.scope, auth.policy_version_id,
               eff.capability_id, eff.capability_version, eff.canonical_payload
        FROM attempts a
        JOIN authorizations auth ON a.authorization_id = auth.authorization_id
        JOIN effects eff ON a.effect_key = eff.effect_key
        WHERE a.effect_key = $1 AND a.cycle_number = $2
        FOR UPDATE OF a;
      `;
      queryParams = [params.effect_key, params.cycle_number];
    }

    const res = await tx.query<AttemptRowLockResult>(query, queryParams);

    if (res.rows.length === 0) {
      throw new DispatchError(
        'ATTEMPT_NOT_FOUND',
        `Attempt not found for effect_key '${params.effect_key}' (cycle: ${params.cycle_number}, attempt_id: ${params.attempt_id}).`
      );
    }

    const row = res.rows[0];

    // If caller specified both attempt_id and effect_key, verify consistency
    if (params.attempt_id && row.effect_key !== params.effect_key) {
      throw new DispatchError(
        'ATTEMPT_NOT_FOUND',
        `Attempt '${params.attempt_id}' belongs to effect '${row.effect_key}', not '${params.effect_key}'.`
      );
    }

    // ------------------------------------------------------------------------
    // 2. PRE-DISPATCH VALIDATION
    // ------------------------------------------------------------------------
    // Check Attempt State
    if (row.state === 'RECOVERY_RELEASED') {
      throw new DispatchError(
        'RECOVERY_RELEASED_BLOCKED',
        `Cannot dispatch attempt '${row.attempt_id}': attempt is in RECOVERY_RELEASED state.`
      );
    }

    if (row.state !== 'RESERVED') {
      throw new DispatchError(
        'INVALID_ATTEMPT_STATE',
        `Attempt '${row.attempt_id}' is in state '${row.state}', expected 'RESERVED'. Only RESERVED attempts may be dispatched.`
      );
    }

    // Check Fence Version (Stale Version Protection)
    const currentFenceVersion = Number(row.fence_version);
    if (currentFenceVersion !== params.expected_fence_version) {
      throw new DispatchError(
        'STALE_ATTEMPT_VERSION',
        `Stale version conflict on attempt '${row.attempt_id}': expected fence version ${params.expected_fence_version}, but database fence version is ${currentFenceVersion}.`
      );
    }

    // Check Authorization Status
    if (row.authorization_status !== 'VALID') {
      throw new DispatchError(
        'AUTHORIZATION_INVALID',
        `Associated authorization '${row.authorization_id}' is not VALID (current status: '${row.authorization_status}').`
      );
    }

    // Check Execution Identity & Claim Uniqueness
    const claimCheck = await tx.query<{ claim_id: string }>(
      `SELECT claim_id FROM dispatch_claims
       WHERE attempt_id = $1 OR client_correlation_id = $2 OR execution_identity = $3;`,
      [row.attempt_id, row.client_correlation_id, row.execution_identity]
    );

    if (claimCheck.rows.length > 0) {
      throw new DispatchError(
        'EXECUTION_IDENTITY_REUSED',
        `Dispatch claim already exists for attempt '${row.attempt_id}' or execution_identity '${row.execution_identity}'.`
      );
    }

    // ------------------------------------------------------------------------
    // 3. ATOMICALLY CREATE DISPATCH CLAIM
    // ------------------------------------------------------------------------
    const claimId = `claim_${randomUUID()}`;
    await tx.query(
      `INSERT INTO dispatch_claims (
        claim_id,
        attempt_id,
        client_correlation_id,
        execution_identity,
        effect_key,
        authorization_id,
        provider_dedup_identity,
        capability_id,
        capability_version,
        policy_version_id,
        dispatcher_identity,
        lease_token,
        claimed_at,
        lease_expires_at,
        committed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13, NOW());`,
      [
        claimId,
        row.attempt_id,
        row.client_correlation_id,
        row.execution_identity,
        row.effect_key,
        row.authorization_id,
        row.provider_dedup_identity,
        row.capability_id,
        row.capability_version,
        row.policy_version_id,
        params.dispatcher_identity,
        leaseToken,
        leaseExpiresAt.toISOString(),
      ]
    );

    // ------------------------------------------------------------------------
    // 4. ATOMICALLY ADVANCE ATTEMPT STATE (RESERVED -> DISPATCHED_UNRESOLVED)
    // ------------------------------------------------------------------------
    const nextFenceVersion = currentFenceVersion + 1;
    const updateAttemptRes = await tx.query(
      `UPDATE attempts
       SET state = 'DISPATCHED_UNRESOLVED',
           fence_version = $1,
           dispatched_at = NOW(),
           updated_at = NOW()
       WHERE attempt_id = $2 AND fence_version = $3;`,
      [nextFenceVersion, row.attempt_id, currentFenceVersion]
    );

    if (updateAttemptRes.rowCount === 0) {
      throw new DispatchError(
        'STALE_ATTEMPT_VERSION',
        `Concurrent update conflict while advancing attempt '${row.attempt_id}'.`
      );
    }

    // ------------------------------------------------------------------------
    // 5. UPDATE EFFECT DISPATCH TIMESTAMPS
    // ------------------------------------------------------------------------
    await tx.query(
      `UPDATE effects
       SET last_dispatched_at = NOW(),
           first_dispatched_at = COALESCE(first_dispatched_at, NOW()),
           updated_at = NOW()
       WHERE effect_key = $1;`,
      [row.effect_key]
    );

    // ------------------------------------------------------------------------
    // 6. RECORD APPEND-ONLY AUDIT EVENT
    // ------------------------------------------------------------------------
    const auditEventId = `ev_aud_${randomUUID()}`;
    await tx.query(
      `INSERT INTO audit_events (
        event_id, aggregate_type, aggregate_id, event_type, actor_principal_id, payload
      ) VALUES ($1, 'ATTEMPT', $2, 'DISPATCH_COMMITTED', $3, $4);`,
      [
        auditEventId,
        row.attempt_id,
        row.principal_id,
        JSON.stringify({
          claim_id: claimId,
          attempt_id: row.attempt_id,
          effect_key: row.effect_key,
          cycle_number: row.cycle_number,
          execution_identity: row.execution_identity,
          client_correlation_id: row.client_correlation_id,
          provider_dedup_identity: row.provider_dedup_identity,
          dispatcher_identity: params.dispatcher_identity,
          lease_token: leaseToken,
          fence_version: nextFenceVersion,
        }),
      ]
    );

    // Testing hook for pre-commit failure verification
    if (params._forceFailureBeforeCommit) {
      throw new Error('Forced failure before commit for atomic dispatch rollback verification.');
    }

    const canonicalPayload =
      typeof row.canonical_payload === 'string'
        ? JSON.parse(row.canonical_payload)
        : row.canonical_payload;

    return {
      claim_id: claimId,
      attempt_id: row.attempt_id,
      effect_key: row.effect_key,
      cycle_number: row.cycle_number,
      authorization_id: row.authorization_id,
      execution_identity: row.execution_identity,
      client_correlation_id: row.client_correlation_id,
      provider_dedup_identity: row.provider_dedup_identity,
      capability_id: row.capability_id,
      capability_version: row.capability_version,
      canonical_payload: canonicalPayload,
      policy_version_id: row.policy_version_id,
      new_fence_version: nextFenceVersion,
      dispatched_at: new Date(),
      lease_token: leaseToken,
      lease_expires_at: leaseExpiresAt,
    };
  });
}

/**
 * Executes controlled dispatch:
 *  1. Atomically commits dispatch claim + state transition (RESERVED -> DISPATCHED_UNRESOLVED).
 *  2. ONLY AFTER COMMIT invokes the capability provider adapter.
 *  3. Invariant: If provider fails after commit, attempt remains DISPATCHED_UNRESOLVED.
 *  4. Invariant: Provider response does NOT resolve attempt to COMPLETED_EXECUTED.
 */
export async function executeDispatch(
  db: PGlite,
  params: DispatchParams,
  adapter: ProviderAdapter,
  hooks?: DispatchExecutionHooks
): Promise<ExecuteDispatchResult> {
  // --------------------------------------------------------------------------
  // STEP 1: ATOMIC DISPATCH TRANSACTION (Pre-provider boundary)
  // If this throws, NO provider call will ever be made.
  // --------------------------------------------------------------------------
  const committed = await performDispatchTransaction(db, params);

  // --------------------------------------------------------------------------
  // STEP 2: SIMULATED CRASH WINDOW: COMMIT -> PROCESS CRASHES BEFORE PROVIDER CALL
  // Attempt is durably DISPATCHED_UNRESOLVED, provider call never happens.
  // --------------------------------------------------------------------------
  if (hooks?._simulateCrashBeforeProviderCall) {
    return {
      success: true,
      dispatch_claim_id: committed.claim_id,
      attempt_id: committed.attempt_id,
      execution_identity: committed.execution_identity,
      client_correlation_id: committed.client_correlation_id,
      provider_dedup_identity: committed.provider_dedup_identity,
      attempt_state: 'DISPATCHED_UNRESOLVED',
      fence_version: committed.new_fence_version,
      provider_assigned_id: null,
      provider_response: null,
      provider_call_error: null,
      dispatched_at: committed.dispatched_at.toISOString(),
      simulated_pre_provider_crash: true,
    };
  }

  // --------------------------------------------------------------------------
  // STEP 3: PROVIDER BOUNDARY INVOCATION (Post-commit)
  // Adapter receives ALREADY-AUTHORIZED dispatch payload.
  // --------------------------------------------------------------------------
  const dispatchPayload: ProviderDispatchPayload = {
    execution_identity: committed.execution_identity,
    client_correlation_id: committed.client_correlation_id,
    provider_dedup_identity: committed.provider_dedup_identity,
    effect_key: committed.effect_key,
    capability_id: committed.capability_id,
    capability_version: committed.capability_version,
    canonical_payload: committed.canonical_payload,
  };

  let providerResponse: ProviderDispatchResponse | null = null;
  let providerCallError: string | null = null;

  try {
    providerResponse = await adapter.submit(dispatchPayload);
  } catch (err: unknown) {
    providerCallError = (err as Error).message ?? 'Unknown provider error';
  }

  // --------------------------------------------------------------------------
  // STEP 4: FAILURE POST-COMMIT
  // Invariant 14B: The control-plane transaction COMMITTED, then provider invocation fails.
  // Result: Attempt REMAINS DISPATCHED_UNRESOLVED.
  // Do NOT roll back to RESERVED. Do NOT automatically retry. Do NOT create non-execution evidence.
  // --------------------------------------------------------------------------
  if (providerCallError !== null) {
    return {
      success: false,
      dispatch_claim_id: committed.claim_id,
      attempt_id: committed.attempt_id,
      execution_identity: committed.execution_identity,
      client_correlation_id: committed.client_correlation_id,
      provider_dedup_identity: committed.provider_dedup_identity,
      attempt_state: 'DISPATCHED_UNRESOLVED',
      fence_version: committed.new_fence_version,
      provider_assigned_id: null,
      provider_response: null,
      provider_call_error: providerCallError,
      dispatched_at: committed.dispatched_at.toISOString(),
    };
  }

  // --------------------------------------------------------------------------
  // STEP 5: SIMULATED CRASH WINDOW: PROVIDER CALL HAPPENS -> CRASH BEFORE RECORDING
  // --------------------------------------------------------------------------
  if (hooks?._simulateCrashBeforeRecordingResponse) {
    return {
      success: providerResponse?.status === 'ACCEPTED',
      dispatch_claim_id: committed.claim_id,
      attempt_id: committed.attempt_id,
      execution_identity: committed.execution_identity,
      client_correlation_id: committed.client_correlation_id,
      provider_dedup_identity: committed.provider_dedup_identity,
      attempt_state: 'DISPATCHED_UNRESOLVED',
      fence_version: committed.new_fence_version,
      provider_assigned_id: null,
      provider_response: providerResponse,
      provider_call_error: null,
      dispatched_at: committed.dispatched_at.toISOString(),
      simulated_post_provider_crash: true,
    };
  }

  // --------------------------------------------------------------------------
  // STEP 6: RECORD PROVIDER-ASSIGNED ID (IF RETURNED)
  // Invariant 12: provider_assigned_id is distinct from execution_identity and client_correlation_id.
  // Invariant 11: Attempt state remains DISPATCHED_UNRESOLVED.
  // --------------------------------------------------------------------------
  let storedProviderAssignedId: string | null = null;
  if (providerResponse?.provider_assigned_id) {
    storedProviderAssignedId = providerResponse.provider_assigned_id;
    await db.query(
      `UPDATE attempts
       SET provider_assigned_id = $1, updated_at = NOW()
       WHERE attempt_id = $2;`,
      [storedProviderAssignedId, committed.attempt_id]
    );
  }

  return {
    success: providerResponse?.status === 'ACCEPTED',
    dispatch_claim_id: committed.claim_id,
    attempt_id: committed.attempt_id,
    execution_identity: committed.execution_identity,
    client_correlation_id: committed.client_correlation_id,
    provider_dedup_identity: committed.provider_dedup_identity,
    attempt_state: 'DISPATCHED_UNRESOLVED',
    fence_version: committed.new_fence_version,
    provider_assigned_id: storedProviderAssignedId,
    provider_response: providerResponse,
    provider_call_error: null,
    dispatched_at: committed.dispatched_at.toISOString(),
  };
}
