/**
 * @file src/dispatch/mockProvider.ts
 * Deterministic Mock Provider for capability dispatch testing.
 *
 * Implements deterministic provider behavior:
 *  - ACCEPTED with provider-assigned ID
 *  - ACCEPTED without provider-assigned ID (nullable ID)
 *  - PROVIDER_REJECTED (e.g. invalid recipient or policy failure)
 *  - NETWORK_FAILURE (simulated transport drop)
 *  - TIMEOUT (simulated gateway timeout)
 *
 * Maintains a strict call audit log to verify dispatch boundary crossings.
 */

import { randomUUID } from 'node:crypto';
import {
  ProviderAdapter,
  ProviderDispatchPayload,
  ProviderDispatchResponse,
} from './providerAdapter.ts';

export type MockProviderBehavior =
  | 'ACCEPTED_WITH_ASSIGNED_ID'
  | 'ACCEPTED_WITHOUT_ASSIGNED_ID'
  | 'PROVIDER_REJECTED'
  | 'NETWORK_FAILURE'
  | 'TIMEOUT'
  | 'CUSTOM';

export interface MockProviderConfig {
  behavior?: MockProviderBehavior;
  assignedIdPrefix?: string;
  rejectReason?: string;
  customHandler?: (payload: ProviderDispatchPayload) => Promise<ProviderDispatchResponse>;
}

export class MockSendMessageProvider implements ProviderAdapter {
  public readonly capability_id: string;
  private config: MockProviderConfig;
  public readonly calls: ProviderDispatchPayload[] = [];

  constructor(capabilityId: string = 'mock.send_message', config: MockProviderConfig = {}) {
    this.capability_id = capabilityId;
    this.config = { behavior: 'ACCEPTED_WITH_ASSIGNED_ID', ...config };
  }

  setBehavior(behavior: MockProviderBehavior): void {
    this.config.behavior = behavior;
  }

  setConfig(config: Partial<MockProviderConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getCallCount(): number {
    return this.calls.length;
  }

  resetCalls(): void {
    this.calls.length = 0;
  }

  async submit(payload: ProviderDispatchPayload): Promise<ProviderDispatchResponse> {
    this.calls.push(payload);

    if (this.config.customHandler) {
      return this.config.customHandler(payload);
    }

    switch (this.config.behavior) {
      case 'ACCEPTED_WITH_ASSIGNED_ID':
        return {
          status: 'ACCEPTED',
          provider_assigned_id: `${this.config.assignedIdPrefix ?? 'prov_msg_'}${randomUUID()}`,
          raw_response: {
            delivery_state: 'QUEUED',
            dispatched_at: new Date().toISOString(),
          },
        };

      case 'ACCEPTED_WITHOUT_ASSIGNED_ID':
        return {
          status: 'ACCEPTED',
          provider_assigned_id: null,
          raw_response: {
            delivery_state: 'QUEUED',
            note: 'External provider does not issue upstream IDs for this endpoint',
          },
        };

      case 'PROVIDER_REJECTED':
        return {
          status: 'PROVIDER_REJECTED',
          provider_assigned_id: null,
          error_message:
            this.config.rejectReason ?? 'Provider rejection: destination recipient unreachable or unroutable',
          raw_response: { error_code: 'DESTINATION_UNROUTABLE' },
        };

      case 'NETWORK_FAILURE':
        throw new Error('Simulated network transport drop: connection reset by peer');

      case 'TIMEOUT':
        throw new Error('Simulated provider gateway timeout: no response within 5000ms');

      default:
        return {
          status: 'ACCEPTED',
          provider_assigned_id: `prov_msg_${randomUUID()}`,
        };
    }
  }
}
