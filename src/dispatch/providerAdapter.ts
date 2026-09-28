/**
 * @file src/dispatch/providerAdapter.ts
 * Narrow provider adapter interface.
 *
 * Boundary Rules:
 *  - Adapter receives ALREADY-AUTHORIZED dispatch information only.
 *  - Adapter MUST NOT authorize operations.
 *  - Adapter MUST NOT evaluate or decide whether SAFE_REPEAT is permitted.
 *  - Adapter MUST NOT mutate control-plane authorization or attempt state.
 *  - Adapter responsibility is solely to submit the operation to the external provider.
 */

export interface ProviderDispatchPayload {
  readonly execution_identity: string;
  readonly client_correlation_id: string;
  readonly provider_dedup_identity: string | null;
  readonly effect_key: string;
  readonly capability_id: string;
  readonly capability_version: string;
  readonly canonical_payload: Record<string, unknown>;
}

export type ProviderResponseStatus =
  | 'ACCEPTED'
  | 'PROVIDER_REJECTED'
  | 'NETWORK_ERROR'
  | 'TIMEOUT';

export interface ProviderDispatchResponse {
  readonly status: ProviderResponseStatus;
  readonly provider_assigned_id?: string | null;
  readonly error_message?: string | null;
  readonly raw_response?: Record<string, unknown>;
}

export interface ProviderAdapter {
  readonly capability_id: string;
  submit(payload: ProviderDispatchPayload): Promise<ProviderDispatchResponse>;
}
