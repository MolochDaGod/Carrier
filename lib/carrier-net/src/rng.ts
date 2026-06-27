/**
 * Deterministic, dependency-free pseudo-random number generator for Carrier.
 *
 * The whole celestial / reward / enemy-pocket world is generated from a single
 * seed so the server (and any future replay/verification) produces byte-for-byte
 * identical layouts.  NEVER seed this from `Date.now()` / wall-clock — pass an
 * explicit, fixed seed.  Both the server world-gen and any per-tick randomness
 * derive from one of these streams so the simulation stays reproducible.
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

/** Random unit-ish vector scaled to `r` (NOT perfectly spherical, fine for placement). */
export function randSphere(rng: Rng, r: number): [number, number, number] {
  const u = rng() * 2 - 1;
  const t = rng() * Math.PI * 2;
  const s = Math.sqrt(Math.max(0, 1 - u * u));
  return [r * s * Math.cos(t), r * u, r * s * Math.sin(t)];
}
