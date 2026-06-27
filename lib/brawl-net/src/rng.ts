/**
 * Deterministic, dependency-free pseudo-random number generator for the Ruins
 * Brawler.
 *
 * The whole ruins map (obstacles + safe-zone placement) is generated from a
 * single seed so every connected player and the authoritative server produce a
 * byte-for-byte identical world.  NEVER seed this from `Date.now()` / wall-clock
 * — pass an explicit, fixed seed.  Per-tick server randomness (spawn jitter,
 * loot rolls, shotgun spread) also derives from a seeded stream so the
 * simulation stays reproducible.
 */

/** A pure 0..1 random stream. */
export type Rng = () => number;

/**
 * mulberry32 — a tiny, fast, well-distributed 32-bit PRNG.  Pure: the only
 * mutable state is captured in the returned closure, so two generators built
 * from the same seed emit the same sequence forever.
 */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix two integers into a new 32-bit seed (for deriving sub-streams). */
export function mixSeed(a: number, b: number): number {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (b + 0x6d2b79f5), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Uniform float in [lo, hi). */
export function randRange(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

/** Uniform integer in [lo, hi] inclusive. */
export function randInt(rng: Rng, lo: number, hi: number): number {
  return Math.floor(randRange(rng, lo, hi + 1));
}
