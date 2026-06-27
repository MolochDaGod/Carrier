/**
 * Carrier scale system — 1 world unit = 1 metre.
 *
 * All ship sizes, orbit distances, and environmental radii are expressed in
 * real-world metres so the scene always reads as physically plausible.
 *
 * Reference sizes
 * ────────────────
 *   Miner / small scout   ≈   4 m  (SCALE.ship.miner)
 *   Attack vessel         ≈  40 m  (SCALE.ship.attack)
 *   Mothership            ≈ 30× the largest other ship  (~1 200 m)
 *
 * Celestial bodies (NOT physical objects in the play space — used for
 * billboard/visual-only representations)
 *   Small rocky planet    ≈ 200 m visual radius
 *   Gas giant             ≈ 1 700 m visual radius
 *
 * The sun is a distant LIGHT SOURCE + far billboard.  It is placed at
 * SUN_DISTANCE (well outside SHIP.arena) and is never a collideable body.
 */

/** All reference lengths in metres. */
export const SCALE = {
  ship: {
    /** Smallest playable vessel — miner / scout. */
    miner: 4,
    /** Standard attack vessel / player fighter. */
    attack: 40,
    /** Mothership = 30× the attack vessel length. */
    get mothership() { return this.attack * 30; },
  },
  planet: {
    /** Small rocky planet visual radius. */
    small: 200,
    /** Gas giant visual radius. */
    large: 1700,
  },
  /** Visual fit target: render fighters at this length (m). */
  fighterRenderLength: 40,
} as const;

/**
 * Sun representation constants.
 *
 * The sun is a distant directional light + a far-away billboard sprite.
 * It is positioned well outside the arena and never enters the play space.
 * The direction from origin to SUN_POSITION is the shadow/light direction.
 */
export const SUN = {
  /** Distance from origin (m) — comfortably beyond arena radius of 5 000 m. */
  distance: 120_000,
  /** Billboard sprite diameter in world units (appears star-sized from arena). */
  billboardSize: 6_000,
  /** Elevation angle above the horizon (radians). */
  elevation: 0.35,
  /** Azimuth (radians, from +Z). */
  azimuth: 0.6,
  /** Directional light colour (warm white). */
  color: 0xfff5e0 as number,
  /** Directional light intensity. */
  intensity: 1.6,
  /** Glow tint for the billboard sprite. */
  glowColor: 0xffe8a0 as number,
} as const;

/** Derive the sun world position from its spherical coords. */
export function sunPosition(): [number, number, number] {
  const el = SUN.elevation;
  const az = SUN.azimuth;
  const r = SUN.distance;
  return [
    r * Math.cos(el) * Math.sin(az),
    r * Math.sin(el),
    r * Math.cos(el) * Math.cos(az),
  ];
}
