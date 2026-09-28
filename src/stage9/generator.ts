/**
 * @file src/stage9/generator.ts
 * Randomized Operation Generator & Sequence Minimizer for Stage 9 Property Testing.
 */

import { DeterministicPRNG } from './prng.ts';

export type Stage9ActionType =
  | 'AUTHORIZE'
  | 'REPLAY_AUTHORIZE'
  | 'DISPATCH'
  | 'DUPLICATE_DISPATCH'
  | 'INGEST_EVIDENCE'
  | 'DERIVE_STATE'
  | 'ADJUDICATE'
  | 'RECOVER'
  | 'RECONCILE';

export interface Stage9Action {
  type: Stage9ActionType;
  effect_index: number;
  params: Record<string, any>;
}

export interface GeneratedSequence {
  seed: number;
  actions: Stage9Action[];
}

export class Stage9Generator {
  public static generateSequence(
    seed: number,
    numActions: number,
    numEffects = 3
  ): GeneratedSequence {
    const prng = new DeterministicPRNG(seed);
    const actions: Stage9Action[] = [];

    const actionTypes: Stage9ActionType[] = [
      'AUTHORIZE',
      'REPLAY_AUTHORIZE',
      'DISPATCH',
      'DUPLICATE_DISPATCH',
      'INGEST_EVIDENCE',
      'DERIVE_STATE',
      'ADJUDICATE',
      'RECOVER',
      'RECONCILE',
    ];

    for (let i = 0; i < numActions; i++) {
      const type = prng.choice(actionTypes);
      const effect_index = prng.nextInt(0, numEffects - 1);
      const action: Stage9Action = {
        type,
        effect_index,
        params: {},
      };

      switch (type) {
        case 'AUTHORIZE':
          action.params = {
            idempotency_key: `idem-s9-${prng.nextInt(1, 1000)}`,
            budget: prng.choice([1.0, 5.0, 10.0]),
            repeat_mode: prng.choice(['SAFE_REPEAT', 'UNSAFE_REPEAT']),
          };
          break;

        case 'REPLAY_AUTHORIZE':
          action.params = {
            // Replays a key that likely was used before
            idempotency_key: `idem-s9-${prng.nextInt(1, 5)}`,
            budget: 5.0,
          };
          break;

        case 'DISPATCH':
          action.params = {
            dispatcher_identity: `worker-s9-${prng.nextInt(1, 3)}`,
            stale_fence: prng.nextBoolean(0.15),
          };
          break;

        case 'DUPLICATE_DISPATCH':
          action.params = {
            dispatcher_identity: `worker-s9-dup`,
          };
          break;

        case 'INGEST_EVIDENCE':
          action.params = {
            evidence_type: prng.choice([
              'EXECUTION_CONFIRMED',
              'NON_EXECUTION_CONFIRMED',
              'TIMEOUT_CONFIRMED',
            ]),
            claim_semantics: prng.choice([
              'EXECUTED',
              'CONFIRMED_NEVER_WILL_EXECUTE',
              'TIMEOUT_NEVER_EXECUTED',
            ]),
            is_duplicate: prng.nextBoolean(0.2),
          };
          break;

        case 'DERIVE_STATE':
          action.params = {};
          break;

        case 'ADJUDICATE':
          action.params = {
            decision: prng.choice([
              'REMAIN_BLOCKED_REQUIRE_EVIDENCE',
              'RESOLVE_FAVOR_EXECUTION',
              'RESOLVE_FAVOR_NON_EXECUTION',
              'DISMISS_CONTRADICTION',
            ]),
            stale_fence: prng.nextBoolean(0.15),
          };
          break;

        case 'RECOVER':
          action.params = {
            expire_lease_first: prng.nextBoolean(0.5),
            recovery_worker: 'worker-rec-s9',
          };
          break;

        case 'RECONCILE':
          action.params = {
            limit: 10,
          };
          break;
      }

      actions.push(action);
    }

    return { seed, actions };
  }

  /**
   * Minimizes a failing sequence by removing actions from the end, then testing sub-sequences.
   */
  public static async minimizeSequence(
    failingSequence: Stage9Action[],
    testFn: (actions: Stage9Action[]) => Promise<boolean>
  ): Promise<Stage9Action[]> {
    let current = [...failingSequence];

    // 1. Prefix reduction (find minimal failing prefix)
    for (let len = 1; len <= current.length; len++) {
      const prefix = current.slice(0, len);
      const failed = await testFn(prefix);
      if (failed) {
        current = prefix;
        break;
      }
    }

    // 2. Individual action deletion (shrink non-essential intermediary actions)
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < current.length; i++) {
        const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
        if (candidate.length === 0) continue;
        const failed = await testFn(candidate);
        if (failed) {
          current = candidate;
          changed = true;
          break;
        }
      }
    }

    return current;
  }
}
