/**
 * @file src/authorization/canonicalizer.ts
 * Deterministic canonicalization and hashing of effect payloads according to capability contracts.
 */

import { createHash } from 'node:crypto';
import { AuthorizationError } from './types.ts';

export function canonicalizeEffectPayload(
  capabilityId: string,
  canonicalizationVersion: string,
  requiredFields: string[],
  payload: Record<string, unknown>
): {
  canonicalPayload: Record<string, unknown>;
  effectKey: string;
  providerDedupIdentity: string;
} {
  // Validate that all required fields exist
  for (const field of requiredFields) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
      throw new AuthorizationError(
        'INVALID_EFFECT_PAYLOAD',
        `Missing required effect field '${field}' declared by capability '${capabilityId}' contract.`
      );
    }
  }

  // Create clean canonical payload with sorted keys
  const sortedKeys = Object.keys(payload).sort();
  const canonicalPayload: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    canonicalPayload[key] = payload[key];
  }

  // Generate deterministic effect key based on canonical payload
  const payloadJson = JSON.stringify(canonicalPayload);
  const effectKeyHash = createHash('sha256')
    .update(`${capabilityId}:${canonicalizationVersion}:${payloadJson}`)
    .digest('hex');
  const effectKey = `eff_${capabilityId}_${effectKeyHash}`;

  // Provider dedup identity calculation (for mock.send_message)
  const recipient = String(canonicalPayload.recipient ?? '');
  const channel = String(canonicalPayload.channel ?? '');
  const body = String(canonicalPayload.message_body ?? '');
  const providerDedupIdentity = createHash('sha256')
    .update(`${capabilityId}:${canonicalizationVersion}:${recipient}:${channel}:${body}`)
    .digest('hex');

  return {
    canonicalPayload,
    effectKey,
    providerDedupIdentity,
  };
}

export function computePayloadHash(payload: Record<string, unknown>): string {
  const sortedKeys = Object.keys(payload).sort();
  const sortedPayload: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sortedPayload[key] = payload[key];
  }
  return createHash('sha256').update(JSON.stringify(sortedPayload)).digest('hex');
}
