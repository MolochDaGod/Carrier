/**
 * Semantic effect catalog.
 *
 * Two kinds of effect live behind one stable, gameplay-meaningful key space so
 * call sites read as intent ("bloodImpact", "muzzleFlashHeavy") rather than
 * asset names, and an effect can be retuned in this one file:
 *
 *  - `json`  — a self-contained three.quarks export bundled under `../effects`
 *    (emitters, behaviors and base64 textures all inline).
 *  - `built` — re-authored programmatically with the quarks API + harvested
 *    bitmap textures (the source packs were Godot and couldn't be imported).
 *
 * Built effects load their builder + textures lazily via dynamic `import()`, so
 * a consumer that only loads JSON keys never pulls in the builder/texture
 * modules (and the unit tests, which mock quarks, never touch them).
 */
import type * as THREE from "three";
import type { TextureName } from "./textures.js";

/** Semantic names both games trigger combat VFX by. */
export type EffectKey =
  // JSON exports
  | "muzzleFlash"
  | "projectileTrail"
  | "bloodImpact"
  | "bloodBurst"
  | "explosion"
  | "gasExplosion"
  | "flamethrower"
  | "fireSparks"
  | "bubbleExplosion"
  // Code-built (from harvested textures)
  | "muzzleFlashHeavy"
  | "arrowTrail"
  | "arrowImpact"
  | "magicBolt"
  | "skillCast"
  | "hitImpact"
  | "hitSlash"
  | "boneDebris"
  | "statusAura"
  // Elemental Magic FX (fire family)
  | "fireCast"
  | "fireball"
  | "fireArea"
  // Dark Magic FX (evil/void family)
  | "darkOrb"
  | "darkProjectile"
  | "darkArea"
  | "darkVortex";

/** A resolved code-built prototype: textures to load + a factory over them. */
export interface BuiltSpec {
  textures: TextureName[];
  build: (textures: THREE.Texture[]) => THREE.Object3D;
}

/** Registry entry: either a bundled JSON file or a lazily-loaded code builder. */
export type EffectDef =
  | { kind: "json"; file: string }
  | { kind: "built"; load: () => Promise<BuiltSpec> };

/** Sugar for declaring a built effect whose builder is dynamically imported. */
function built(load: () => Promise<BuiltSpec>): EffectDef {
  return { kind: "built", load };
}

/** The full catalog: every semantic key mapped to its source. */
export const EFFECTS: Record<EffectKey, EffectDef> = {
  // ---- JSON exports (Cartoon FX pack) ----
  muzzleFlash: { kind: "json", file: "muzzleFlash.json" },
  projectileTrail: { kind: "json", file: "blueFlare.json" },
  bloodImpact: { kind: "json", file: "bloodSplash.json" },
  bloodBurst: { kind: "json", file: "bloodExplosion.json" },
  explosion: { kind: "json", file: "fireballExplosion.json" },
  gasExplosion: { kind: "json", file: "gasExplosion.json" },
  flamethrower: { kind: "json", file: "flamethrower.json" },
  fireSparks: { kind: "json", file: "fireSparks.json" },
  bubbleExplosion: { kind: "json", file: "bubbleExplosion.json" },

  // ---- Code-built (harvested PNG textures + quarks API) ----
  muzzleFlashHeavy: built(async () => {
    const B = await import("./builders.js");
    return { textures: ["muzzle_front", "sparkle"], build: (t) => B.buildMuzzle(t[0], t[1]) };
  }),
  hitImpact: built(async () => {
    const B = await import("./builders.js");
    return { textures: ["muzzle_front", "sparkle"], build: (t) => B.buildHitImpact(t[0], t[1]) };
  }),
  hitSlash: built(async () => {
    const B = await import("./builders.js");
    return { textures: ["streak"], build: (t) => B.buildHitSlash(t[0]) };
  }),
  arrowImpact: built(async () => {
    const B = await import("./builders.js");
    return { textures: ["sparkle"], build: (t) => B.buildArrowImpact(t[0]) };
  }),
  arrowTrail: built(async () => {
    const B = await import("./builders.js");
    return { textures: ["streak"], build: (t) => B.buildArrowTrail(t[0]) };
  }),
  magicBolt: built(async () => {
    const B = await import("./builders.js");
    return { textures: ["glow", "sparkle"], build: (t) => B.buildMagicBolt(t[0], t[1]) };
  }),
  skillCast: built(async () => {
    const B = await import("./builders.js");
    return { textures: ["spark_sheet"], build: (t) => B.buildSparkBurst(t[0]) };
  }),
  statusAura: built(async () => {
    const B = await import("./builders.js");
    return { textures: ["sparkle"], build: (t) => B.buildStatusAura(t[0]) };
  }),
  boneDebris: built(async () => {
    const B = await import("./builders.js");
    return { textures: [], build: () => B.buildBoneDebris() };
  }),

  // ---- Elemental Magic FX (fire family) ----
  fireCast: built(async () => {
    const B = await import("./builders.js");
    return { textures: ["glow", "sparkle"], build: (t) => B.buildFireCast(t[0], t[1]) };
  }),
  fireball: built(async () => {
    const B = await import("./builders.js");
    return {
      textures: ["glow", "sparkle", "streak"],
      build: (t) => B.buildFireball(t[0], t[1], t[2]),
    };
  }),
  fireArea: built(async () => {
    const B = await import("./builders.js");
    return { textures: ["glow", "sparkle"], build: (t) => B.buildFireArea(t[0], t[1]) };
  }),

  // ---- Dark Magic FX (evil/void family) ----
  darkOrb: built(async () => {
    const B = await import("./builders.js");
    return { textures: ["glow", "sparkle"], build: (t) => B.buildDarkOrb(t[0], t[1]) };
  }),
  darkProjectile: built(async () => {
    const B = await import("./builders.js");
    return {
      textures: ["glow", "sparkle", "streak"],
      build: (t) => B.buildDarkProjectile(t[0], t[1], t[2]),
    };
  }),
  darkArea: built(async () => {
    const B = await import("./builders.js");
    return {
      textures: ["glow", "sparkle", "streak"],
      build: (t) => B.buildDarkArea(t[0], t[1], t[2]),
    };
  }),
  darkVortex: built(async () => {
    const B = await import("./builders.js");
    return { textures: ["glow", "streak"], build: (t) => B.buildDarkVortex(t[0], t[1]) };
  }),
};

/**
 * Back-compat map of the JSON-backed keys to their bundled file. Code-built keys
 * are intentionally absent (they have no file).
 */
export const EFFECT_FILES: Partial<Record<EffectKey, string>> = Object.fromEntries(
  Object.entries(EFFECTS)
    .filter(([, d]) => d.kind === "json")
    .map(([k, d]) => [k, (d as { file: string }).file]),
) as Partial<Record<EffectKey, string>>;

/** Every available effect key (stable order). */
export const ALL_EFFECT_KEYS = Object.keys(EFFECTS) as EffectKey[];
