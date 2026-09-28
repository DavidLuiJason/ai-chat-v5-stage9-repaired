/**
 * @file src/authorization/authorizeOperation.ts
 * Stage 2 Atomic Control Plane Authorization Transaction.
 *
 * Implements the atomic authorization transaction closed against TOCTOU races:
 *  1. Exclusive Ownership & Compare-and-Commit (Invariants 1 & 3)
 *  2. Hard Internal Budget Reservation under row-lock serialization (Invariant 2)
 *  3. Idempotency: exact replay reuse vs conflict detection (Invariant 4)
 *  4. Operation-bound authorization linearized at commit (Invariant 5)
 *  5. Fail closed: zero durable side effects on any precondition failure (Invariant 6)
 */

import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { canonicalizeEffectPayload, computePayloadHash } from './canonicalizer.ts';
import {
  AuthorizationError,
  AuthorizeOperationRequest,
  AuthorizeOperationResult,
} from './types.ts';
import { RepeatAuthorizationType, UNRESOLVED_INCIDENT_STATUSES } from '../schema/types.ts';

export async function authorizeOperation(
  db: PGlite,
  request: AuthorizeOperationRequest
): Promise<AuthorizeOperationResult> {
  // Validate request inputs before acquiring transaction locks
  if (!request.actor_principal_id) {
    throw new AuthorizationError('PRINCIPAL_NOT_FOUND', 'Actor principal ID is required.');
  }
  if (!request.capability_id || !request.capability_version) {
    throw new AuthorizationError('CAPABILITY_NOT_FOUND', 'Capability ID and version are required.');
  }
  if (!request.requested_scope) {
    throw new AuthorizationError('UNAUTHORIZED_SCOPE', 'Requested scope is required.');
  }
  if (!request.policy_version_id) {
    throw new AuthorizationError('POLICY_VERSION_NOT_FOUND', 'Policy version ID is required.');
  }
  if (!request.idempotency_key) {
    throw new AuthorizationError('IDEMPOTENCY_CONFLICT', 'Idempotency key is required.');
  }
  if (request.budget_amount === undefined || request.budget_amount <= 0) {
    throw new AuthorizationError('INSUFFICIENT_BUDGET', 'Budget reservation amount must be positive.');
  }

  // Execute entire authorization procedure within ONE atomic database transaction
  return await db.transaction(async (tx) => {
    // ------------------------------------------------------------------------
    // 1. VALIDATE ACTOR / PRINCIPAL (FOR SHARE)
    // ------------------------------------------------------------------------
    const principalRes = await tx.query<{
      principal_id: string;
      status: string;
      metadata: { scopes?: string[]; roles?: string[] } | string;
    }>(
      `SELECT principal_id, status, metadata FROM principals WHERE principal_id = $1 FOR SHARE;`,
      [request.actor_principal_id]
    );

    if (principalRes.rows.length === 0) {
      throw new AuthorizationError(
        'PRINCIPAL_NOT_FOUND',
        `Principal '${request.actor_principal_id}' does not exist.`
      );
    }

    const principal = principalRes.rows[0];
    if (principal.status !== 'ACTIVE') {
      throw new AuthorizationError(
        'PRINCIPAL_NOT_ACTIVE',
        `Principal '${request.actor_principal_id}' is not ACTIVE (status: ${principal.status}).`
      );
    }

    // Validate scope permissions
    const rawMetadata = principal.metadata;
    const metadata =
      typeof rawMetadata === 'string' ? JSON.parse(rawMetadata) : rawMetadata || {};
    const allowedScopes = metadata?.scopes;
    if (allowedScopes && Array.isArray(allowedScopes)) {
      const hasWildcard = allowedScopes.includes('*');
      const hasExactScope = allowedScopes.includes(request.requested_scope);
      if (!hasWildcard && !hasExactScope) {
        throw new AuthorizationError(
          'UNAUTHORIZED_SCOPE',
          `Principal '${request.actor_principal_id}' lacks requested scope '${request.requested_scope}'. Allowed: ${allowedScopes.join(', ')}`
        );
      }
    }

    // ------------------------------------------------------------------------
    // 2. VALIDATE CAPABILITY & VERSION (FOR SHARE)
    // ------------------------------------------------------------------------
    const contractRes = await tx.query<{
      capability_id: string;
      version: string;
      repeat_mode: 'SAFE_REPEAT' | 'UNSAFE_REPEAT';
      effect_key_canonicalization_version: string;
      required_effect_fields: string[] | string;
      dedup_validity_window_seconds: number | null;
      contract_status: string;
    }>(
      `SELECT c.capability_id, cv.version, cv.repeat_mode, cv.effect_key_canonicalization_version,
              cv.required_effect_fields, cv.dedup_validity_window_seconds, cv.contract_status
       FROM capabilities c
       JOIN capability_contracts cv ON c.capability_id = cv.capability_id
       WHERE c.capability_id = $1 AND cv.version = $2
       FOR SHARE;`,
      [request.capability_id, request.capability_version]
    );

    if (contractRes.rows.length === 0) {
      throw new AuthorizationError(
        'CAPABILITY_NOT_FOUND',
        `Capability contract for '${request.capability_id}' version '${request.capability_version}' not found.`
      );
    }

    const contract = contractRes.rows[0];
    if (contract.contract_status !== 'ACTIVE') {
      throw new AuthorizationError(
        'CAPABILITY_CONTRACT_INACTIVE',
        `Capability contract for '${request.capability_id}' is not ACTIVE (status: ${contract.contract_status}).`
      );
    }

    const requiredFields = Array.isArray(contract.required_effect_fields)
      ? contract.required_effect_fields
      : JSON.parse(contract.required_effect_fields as string);

    // Canonicalize effect payload & derive authoritative effect_key
    const { canonicalPayload, effectKey, providerDedupIdentity } = canonicalizeEffectPayload(
      contract.capability_id,
      contract.effect_key_canonicalization_version,
      requiredFields,
      request.operation_payload
    );

    // ------------------------------------------------------------------------
    // 3. VALIDATE POLICY VERSION (FOR SHARE)
    // ------------------------------------------------------------------------
    const policyRes = await tx.query<{
      policy_version_id: string;
      is_active: boolean;
    }>(
      `SELECT policy_version_id, is_active FROM policy_versions WHERE policy_version_id = $1 FOR SHARE;`,
      [request.policy_version_id]
    );

    if (policyRes.rows.length === 0) {
      throw new AuthorizationError(
        'POLICY_VERSION_NOT_FOUND',
        `Policy version '${request.policy_version_id}' does not exist.`
      );
    }

    if (!policyRes.rows[0].is_active) {
      throw new AuthorizationError(
        'POLICY_VERSION_INACTIVE',
        `Policy version '${request.policy_version_id}' is not active.`
      );
    }

    // ------------------------------------------------------------------------
    // 4. TRANSACTIONAL IDEMPOTENCY CHECK (FOR UPDATE)
    // ------------------------------------------------------------------------
    const existingIntentRes = await tx.query<{
      intent_id: string;
      principal_id: string;
      target_effect_key: string;
      policy_version_id: string;
      idempotency_key: string;
      payload: Record<string, unknown> | string;
      status: string;
    }>(
      `SELECT intent_id, principal_id, target_effect_key, policy_version_id, idempotency_key, payload, status
       FROM intents
       WHERE principal_id = $1 AND idempotency_key = $2
       FOR UPDATE;`,
      [request.actor_principal_id, request.idempotency_key]
    );

    if (existingIntentRes.rows.length > 0) {
      const existingIntent = existingIntentRes.rows[0];
      const existingPayload =
        typeof existingIntent.payload === 'string'
          ? JSON.parse(existingIntent.payload)
          : existingIntent.payload;

      const existingHash = computePayloadHash(existingPayload);
      const incomingHash = computePayloadHash(canonicalPayload);

      // Check if this is the exact same operation semantics
      const isSameOperation =
        existingHash === incomingHash &&
        existingIntent.target_effect_key === effectKey &&
        existingIntent.policy_version_id === request.policy_version_id;

      if (!isSameOperation) {
        throw new AuthorizationError(
          'IDEMPOTENCY_CONFLICT',
          `Idempotency key '${request.idempotency_key}' was previously used for a materially different operation.`
        );
      }

      // CASE A: Same key + same operation -> Return/reuse existing logical authorization
      const existingAuthRes = await tx.query<{
        authorization_id: string;
        intent_id: string;
        effect_key: string;
        authorized_cycle: number;
        scope: string;
        repeat_authorization_type: RepeatAuthorizationType;
        budget_reservation_id: string;
        dedup_window_expires_at: string | null;
        fence_version: string;
        owner_principal_id: string | null;
      }>(
        `SELECT a.authorization_id, a.intent_id, a.effect_key, a.authorized_cycle, a.scope,
                a.repeat_authorization_type, a.budget_reservation_id, a.dedup_window_expires_at,
                e.fence_version, e.owner_principal_id
         FROM authorizations a
         JOIN effects e ON a.effect_key = e.effect_key
         WHERE a.intent_id = $1 AND a.authorization_status = 'VALID'
         ORDER BY a.created_at DESC
         LIMIT 1;`,
        [existingIntent.intent_id]
      );

      if (existingAuthRes.rows.length > 0) {
        const auth = existingAuthRes.rows[0];

        // Query attempt associated with this authorization
        const attemptRes = await tx.query<{
          attempt_id: string;
          cycle_number: number;
          execution_identity: string;
          client_correlation_id: string;
          provider_dedup_identity: string | null;
          state: 'RESERVED' | 'DISPATCHED_UNRESOLVED' | 'RECOVERY_RELEASED' | 'COMPLETED_EXECUTED' | 'COMPLETED_NON_EXECUTED' | 'FAILED_TERMINAL';
        }>(
          `SELECT attempt_id, cycle_number, execution_identity, client_correlation_id,
                  provider_dedup_identity, state
           FROM attempts
           WHERE authorization_id = $1;`,
          [auth.authorization_id]
        );

        const attemptRow = attemptRes.rows[0];

        return {
          authorized: true,
          authorization_id: auth.authorization_id,
          intent_id: auth.intent_id,
          effect_key: auth.effect_key,
          attempt_id: attemptRow?.attempt_id ?? '',
          cycle_number: attemptRow ? Number(attemptRow.cycle_number) : auth.authorized_cycle,
          execution_identity: attemptRow?.execution_identity ?? '',
          client_correlation_id: attemptRow?.client_correlation_id ?? '',
          provider_dedup_identity: attemptRow?.provider_dedup_identity ?? null,
          attempt_state: attemptRow?.state ?? 'RESERVED',
          authorized_cycle: auth.authorized_cycle,
          repeat_authorization_type: auth.repeat_authorization_type,
          budget_reservation_id: auth.budget_reservation_id,
          dedup_window_expires_at: auth.dedup_window_expires_at
            ? new Date(auth.dedup_window_expires_at)
            : null,
          is_idempotent_replay: true,
          fence_version: Number(auth.fence_version),
          scope: auth.scope,
          policy_version_id: existingIntent.policy_version_id,
          owner_principal_id: auth.owner_principal_id,
        };
      }
    }

    // ------------------------------------------------------------------------
    // 5. EFFECT STATE, STALE-STATE, GATING & OWNERSHIP (FOR UPDATE)
    // ------------------------------------------------------------------------
    const effectRes = await tx.query<{
      effect_key: string;
      repeat_mode: 'SAFE_REPEAT' | 'UNSAFE_REPEAT';
      executed_fact: boolean;
      execution_state: string;
      current_cycle: number;
      fence_version: string;
      owner_principal_id: string | null;
      dedup_window_started_at: string | null;
      dedup_window_expires_at: string | null;
    }>(
      `SELECT effect_key, repeat_mode, executed_fact, execution_state,
              current_cycle, fence_version, owner_principal_id,
              dedup_window_started_at, dedup_window_expires_at
       FROM effects
       WHERE effect_key = $1
       FOR UPDATE;`,
      [effectKey]
    );

    let authorizedCycle: number;
    let repeatAuthorizationType: RepeatAuthorizationType;
    let committedFenceVersion: number;
    let committedOwnerPrincipalId: string | null;
    let dedupWindowExpiresAt: Date | null = null;

    if (effectRes.rows.length > 0) {
      const existingEffect = effectRes.rows[0];
      const currentFence = Number(existingEffect.fence_version);

      // INVARIANT 3: Stale-state protection
      if (
        request.expected_fence_version !== undefined &&
        request.expected_fence_version !== currentFence
      ) {
        throw new AuthorizationError(
          'STALE_STATE_ERROR',
          `Stale state detected: expected effect fence version ${request.expected_fence_version}, but current version is ${currentFence}.`
        );
      }

      // INVARIANT 1: Exclusive ownership check
      if (
        existingEffect.owner_principal_id &&
        request.owner_principal_id &&
        existingEffect.owner_principal_id !== request.owner_principal_id
      ) {
        throw new AuthorizationError(
          'OWNERSHIP_CONFLICT',
          `Effect is owned by '${existingEffect.owner_principal_id}', cannot be authorized by '${request.owner_principal_id}'.`
        );
      }

      // ----------------------------------------------------------------------
      // STAGE 8 CONTRADICTION GATING: UNRESOLVED CONTRADICTION BLOCKS AUTHORIZATION
      // Fail closed: Any unresolved safety-relevant contradiction (OPEN, INVESTIGATING, etc.)
      // atomically blocks new authorization until legitimately resolved.
      // ----------------------------------------------------------------------
      const openIncidentRes = await tx.query<{
        incident_id: string;
        status: string;
        severity: string;
        summary: string;
      }>(
        `SELECT incident_id, status, severity, summary FROM contradiction_incidents
         WHERE effect_key = $1 AND status = ANY($2::varchar[])
         FOR SHARE;`,
        [effectKey, UNRESOLVED_INCIDENT_STATUSES]
      );

      if (openIncidentRes.rows.length > 0) {
        const inc = openIncidentRes.rows[0];
        throw new AuthorizationError(
          'BLOCKED_BY_OPEN_CONTRADICTION',
          `Cannot authorize operation for effect '${effectKey}': unresolved safety-relevant contradiction incident '${inc.incident_id}' (status: ${inc.status}) exists and must be adjudicated first.`
        );
      }

      // ----------------------------------------------------------------------
      // STAGE 3 EFFECT GATING: UNSAFE_REPEAT vs SAFE_REPEAT
      // ----------------------------------------------------------------------
      if (contract.repeat_mode === 'UNSAFE_REPEAT') {
        // Gating 1: If executed_fact is true, UNSAFE_REPEAT can NEVER be repeated!
        if (existingEffect.executed_fact) {
          throw new AuthorizationError(
            'UNSAFE_REPEAT_ALREADY_EXECUTED',
            `Effect '${effectKey}' is UNSAFE_REPEAT and has already been executed.`
          );
        }

        // Gating 2: Check prior attempt status
        const priorAttemptsRes = await tx.query<{
          attempt_id: string;
          cycle_number: number;
          state: string;
        }>(
          `SELECT attempt_id, cycle_number, state FROM attempts
           WHERE effect_key = $1 ORDER BY cycle_number DESC LIMIT 1;`,
          [effectKey]
        );

        if (priorAttemptsRes.rows.length > 0) {
          const latestAttempt = priorAttemptsRes.rows[0];

          // Unresolved states block UNSAFE_REPEAT retry
          if (latestAttempt.state === 'RESERVED' || latestAttempt.state === 'DISPATCHED_UNRESOLVED') {
            throw new AuthorizationError(
              'UNSAFE_REPEAT_BLOCKED_UNRESOLVED',
              `Cannot authorize new attempt for UNSAFE_REPEAT effect '${effectKey}': prior attempt '${latestAttempt.attempt_id}' is unresolved (state: ${latestAttempt.state}).`
            );
          }

          // RECOVERY_RELEASED is NOT proof of non-execution
          if (latestAttempt.state === 'RECOVERY_RELEASED') {
            const nonExecEvidence = await tx.query(
              `SELECT evidence_id FROM evidence_records
               WHERE attempt_id = $1 AND evidence_type = 'NON_EXECUTION_CONFIRMED';`,
              [latestAttempt.attempt_id]
            );

            if (nonExecEvidence.rows.length === 0) {
              throw new AuthorizationError(
                'UNSAFE_REPEAT_BLOCKED_UNRESOLVED',
                `Cannot authorize new attempt for UNSAFE_REPEAT effect '${effectKey}': prior attempt '${latestAttempt.attempt_id}' is in RECOVERY_RELEASED state without verified external non-execution evidence. RECOVERY_RELEASED is not proof of non-execution.`
              );
            }
          }

          repeatAuthorizationType = 'UNSAFE_REPEAT_PERMITTED_TERMINAL_VERIFIED';
        } else {
          repeatAuthorizationType = 'INITIAL_ATTEMPT';
        }
      } else {
        // SAFE_REPEAT Gating: Deduplication Validity Window
        if (existingEffect.dedup_window_expires_at) {
          const expiresAtMs = new Date(existingEffect.dedup_window_expires_at).getTime();
          if (Date.now() > expiresAtMs) {
            throw new AuthorizationError(
              'DEDUP_WINDOW_EXPIRED',
              `Cannot authorize new attempt for SAFE_REPEAT effect '${effectKey}': provider deduplication validity window expired at ${new Date(
                expiresAtMs
              ).toISOString()}. Provider deduplication is no longer guaranteed.`
            );
          }
          dedupWindowExpiresAt = new Date(expiresAtMs);
        }
        repeatAuthorizationType =
          existingEffect.current_cycle > 0 ? 'SAFE_REPEAT_ALLOWED' : 'INITIAL_ATTEMPT';
      }

      authorizedCycle = Number(existingEffect.current_cycle) + 1;
      committedFenceVersion = currentFence + 1;
      committedOwnerPrincipalId =
        request.owner_principal_id ?? existingEffect.owner_principal_id ?? request.actor_principal_id;

      // Optimistic compare-and-commit update on effects
      const updateEffectRes = await tx.query(
        `UPDATE effects
         SET current_cycle = $1, fence_version = $2, owner_principal_id = $3, updated_at = NOW()
         WHERE effect_key = $4 AND fence_version = $5;`,
        [authorizedCycle, committedFenceVersion, committedOwnerPrincipalId, effectKey, currentFence]
      );

      if (updateEffectRes.rowCount === 0) {
        throw new AuthorizationError(
          'STALE_STATE_ERROR',
          `Concurrent update conflict while advancing effect '${effectKey}'.`
        );
      }
    } else {
      // New Effect initialization
      if (
        request.expected_fence_version !== undefined &&
        request.expected_fence_version !== 1
      ) {
        throw new AuthorizationError(
          'STALE_STATE_ERROR',
          `Effect '${effectKey}' does not exist, but expected fence version was ${request.expected_fence_version}.`
        );
      }

      authorizedCycle = 1;
      repeatAuthorizationType = 'INITIAL_ATTEMPT';
      committedFenceVersion = 1;
      committedOwnerPrincipalId = request.owner_principal_id ?? request.actor_principal_id;

      const dedupWindowStartedAt = new Date();
      dedupWindowExpiresAt =
        contract.repeat_mode === 'SAFE_REPEAT' && contract.dedup_validity_window_seconds
          ? new Date(dedupWindowStartedAt.getTime() + contract.dedup_validity_window_seconds * 1000)
          : null;

      await tx.query(
        `INSERT INTO effects (
          effect_key, capability_id, capability_version, canonical_payload,
          canonicalization_version, repeat_mode, execution_state,
          dedup_window_started_at, dedup_window_expires_at,
          current_cycle, fence_version, owner_principal_id
        ) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, 1, 1, $9);`,
        [
          effectKey,
          contract.capability_id,
          contract.version,
          JSON.stringify(canonicalPayload),
          contract.effect_key_canonicalization_version,
          contract.repeat_mode,
          dedupWindowStartedAt.toISOString(),
          dedupWindowExpiresAt ? dedupWindowExpiresAt.toISOString() : null,
          committedOwnerPrincipalId,
        ]
      );
    }

    // ------------------------------------------------------------------------
    // 6. HARD INTERNAL BUDGET RESERVATION (FOR UPDATE)
    // ------------------------------------------------------------------------
    const budgetRes = await tx.query<{
      principal_id: string;
      currency_or_unit: string;
      budget_limit: string;
      reserved_amount: string;
    }>(
      `SELECT principal_id, currency_or_unit, budget_limit, reserved_amount
       FROM principal_budgets
       WHERE principal_id = $1 AND currency_or_unit = $2
       FOR UPDATE;`,
      [request.actor_principal_id, request.budget_currency]
    );

    if (budgetRes.rows.length === 0) {
      throw new AuthorizationError(
        'NO_BUDGET_CONFIGURED',
        `No budget configured for principal '${request.actor_principal_id}' in '${request.budget_currency}'.`
      );
    }

    const budget = budgetRes.rows[0];
    const limit = Number(budget.budget_limit);
    const currentlyReserved = Number(budget.reserved_amount);
    const available = limit - currentlyReserved;

    if (request.budget_amount > available) {
      throw new AuthorizationError(
        'INSUFFICIENT_BUDGET',
        `Requested budget reservation ${request.budget_amount} exceeds available ${available.toFixed(
          4
        )} (limit: ${limit.toFixed(4)}, currently reserved: ${currentlyReserved.toFixed(4)}).`
      );
    }

    // Increment reserved budget atomically
    await tx.query(
      `UPDATE principal_budgets
       SET reserved_amount = reserved_amount + $1, updated_at = NOW()
       WHERE principal_id = $2 AND currency_or_unit = $3;`,
      [request.budget_amount, request.actor_principal_id, request.budget_currency]
    );

    // Create durable budget reservation record
    const reservationId = `bres_${randomUUID()}`;
    await tx.query(
      `INSERT INTO budget_reservations (
        reservation_id, principal_id, effect_key, amount, currency_or_unit, status
      ) VALUES ($1, $2, $3, $4, $5, 'RESERVED');`,
      [
        reservationId,
        request.actor_principal_id,
        effectKey,
        request.budget_amount,
        request.budget_currency,
      ]
    );

    // ------------------------------------------------------------------------
    // 7. CREATE / BIND AUTHORIZED INTENT RECORD
    // ------------------------------------------------------------------------
    const intentId = `intent_${randomUUID()}`;
    await tx.query(
      `INSERT INTO intents (
        intent_id, principal_id, target_effect_key, policy_version_id,
        idempotency_key, payload, status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'AUTHORIZED');`,
      [
        intentId,
        request.actor_principal_id,
        effectKey,
        request.policy_version_id,
        request.idempotency_key,
        JSON.stringify(canonicalPayload),
      ]
    );

    // ------------------------------------------------------------------------
    // 8. PERSIST OPERATION-BOUND AUTHORIZATION RECORD
    // ------------------------------------------------------------------------
    const authorizationId = `auth_${randomUUID()}`;
    if (!dedupWindowExpiresAt && contract.repeat_mode === 'SAFE_REPEAT' && contract.dedup_validity_window_seconds) {
      dedupWindowExpiresAt = new Date(Date.now() + contract.dedup_validity_window_seconds * 1000);
    }

    await tx.query(
      `INSERT INTO authorizations (
        authorization_id, intent_id, effect_key, principal_id, policy_version_id,
        budget_reservation_id, authorized_cycle, scope, repeat_authorization_type,
        dedup_window_expires_at, authorization_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'VALID');`,
      [
        authorizationId,
        intentId,
        effectKey,
        request.actor_principal_id,
        request.policy_version_id,
        reservationId,
        authorizedCycle,
        request.requested_scope,
        repeatAuthorizationType,
        dedupWindowExpiresAt ? dedupWindowExpiresAt.toISOString() : null,
      ]
    );

    // ------------------------------------------------------------------------
    // 9. ATOMIC ATTEMPT RESERVATION (PRE-DISPATCH: STATE = 'RESERVED')
    // ------------------------------------------------------------------------
    const attemptId = `att_${randomUUID()}`;
    const executionIdentity = `exec_${randomUUID()}`;
    const clientCorrelationId = `corr_${randomUUID()}`;
    const storedProviderDedupIdentity =
      contract.repeat_mode === 'SAFE_REPEAT' ? providerDedupIdentity : null;

    await tx.query(
      `INSERT INTO attempts (
        attempt_id, effect_key, cycle_number, authorization_id,
        execution_identity, client_correlation_id, provider_dedup_identity,
        provider_assigned_id, state, fence_version, reserved_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 'RESERVED', 1, NOW());`,
      [
        attemptId,
        effectKey,
        authorizedCycle,
        authorizationId,
        executionIdentity,
        clientCorrelationId,
        storedProviderDedupIdentity,
      ]
    );

    // Update active attempt ID on effects table
    await tx.query(
      `UPDATE effects SET active_attempt_id = $1 WHERE effect_key = $2;`,
      [attemptId, effectKey]
    );

    // ------------------------------------------------------------------------
    // 10. RECORD APPEND-ONLY AUDIT EVENT
    // ------------------------------------------------------------------------
    const auditEventId = `ev_aud_${randomUUID()}`;
    await tx.query(
      `INSERT INTO audit_events (
        event_id, aggregate_type, aggregate_id, event_type, actor_principal_id, payload
      ) VALUES ($1, 'AUTHORIZATION', $2, 'OPERATION_AUTHORIZED', $3, $4);`,
      [
        auditEventId,
        authorizationId,
        request.actor_principal_id,
        JSON.stringify({
          intent_id: intentId,
          effect_key: effectKey,
          attempt_id: attemptId,
          cycle_number: authorizedCycle,
          execution_identity: executionIdentity,
          client_correlation_id: clientCorrelationId,
          policy_version_id: request.policy_version_id,
          budget_reservation_id: reservationId,
          amount: request.budget_amount,
          scope: request.requested_scope,
          fence_version: committedFenceVersion,
          provider_dedup_identity: storedProviderDedupIdentity,
        }),
      ]
    );

    // Testing hook for fail closed atomic rollback verification
    if (request._forceFailureBeforeCommit) {
      throw new Error('Forced failure before commit for atomic rollback verification.');
    }

    return {
      authorized: true,
      authorization_id: authorizationId,
      intent_id: intentId,
      effect_key: effectKey,
      attempt_id: attemptId,
      cycle_number: authorizedCycle,
      execution_identity: executionIdentity,
      client_correlation_id: clientCorrelationId,
      provider_dedup_identity: storedProviderDedupIdentity,
      attempt_state: 'RESERVED',
      authorized_cycle: authorizedCycle,
      repeat_authorization_type: repeatAuthorizationType,
      budget_reservation_id: reservationId,
      dedup_window_expires_at: dedupWindowExpiresAt,
      is_idempotent_replay: false,
      fence_version: committedFenceVersion,
      scope: request.requested_scope,
      policy_version_id: request.policy_version_id,
      owner_principal_id: committedOwnerPrincipalId,
    };
  });
}
