/**
 * @file src/stage9/prng.ts
 * Deterministic Pseudo-Random Number Generator (Mulberry32).
 * Enables 100% reproducible randomized property-based testing and sequence shrinking.
 */

export class DeterministicPRNG {
  private state: number;
  public readonly initialSeed: number;

  constructor(seed: number) {
    this.initialSeed = Math.floor(seed) >>> 0;
    this.state = this.initialSeed;
  }

  /**
   * Generates a pseudo-random floating-point number in [0, 1).
   */
  public next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Returns a pseudo-random integer in [min, max] inclusive.
   */
  public nextInt(min: number, max: number): number {
    if (min > max) {
      const tmp = min;
      min = max;
      max = tmp;
    }
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /**
   * Returns a pseudo-random boolean with given probability of true.
   */
  public nextBoolean(probability = 0.5): boolean {
    return this.next() < probability;
  }

  /**
   * Returns a random element from an array.
   */
  public choice<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('Cannot select choice from empty array.');
    }
    const idx = this.nextInt(0, items.length - 1);
    return items[idx];
  }

  /**
   * Shuffles an array deterministically in place.
   */
  public shuffle<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i);
      const temp = array[i];
      array[i] = array[j];
      array[j] = temp;
    }
    return array;
  }
}
