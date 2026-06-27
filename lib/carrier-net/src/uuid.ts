/**
 * Runtime unique-id helper for Carrier entities and beams.
 *
 * IMPORTANT: this is the NON-deterministic counterpart to `rng.ts`.  Use it ONLY
 * for runtime identity (ship/turret/beam `uid`s) — never for world generation,
 * which must stay seed-deterministic.  Mixing a uuid into world-gen would break
 * reproducibility.
 */

let counter = 0;

/**
 * Return a globally-unique string id.  Prefers the platform `crypto.randomUUID`
 * (available in Node 18+ and modern browsers) and falls back to a timestamp +
 * counter + random suffix so the lib stays dependency-free and usable anywhere.
 */
export function newUuid(prefix = ""): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const base =
    c && typeof c.randomUUID === "function"
      ? c.randomUUID()
      : `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 10)}`;
  return prefix ? `${prefix}_${base}` : base;
}
