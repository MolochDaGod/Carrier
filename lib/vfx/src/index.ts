/**
 * @workspace/vfx
 *
 * A reusable, three.quarks-based combat VFX layer shared by both games. One
 * {@link VfxManager} wraps a quarks `BatchedRenderer` for a single Three.js
 * scene: load effect prototypes once, `play(key, position, opts)` to spawn a
 * one-shot, drive it from a per-frame `update(dt)`, and `dispose()` on teardown.
 *
 * The nine supplied effect exports are mapped to semantic {@link EffectKey}s
 * (muzzleFlash, projectileTrail, bloodImpact, explosion, …) so call sites read
 * as intent and an effect can be swapped or retuned in one place.
 *
 *   import { VfxManager } from "@workspace/vfx";
 *
 *   const vfx = new VfxManager(scene);
 *   await vfx.load(["muzzleFlash", "bloodImpact", "explosion"]);
 *   // per frame:
 *   vfx.update(dt);
 *   // on a hit:
 *   vfx.play("bloodImpact", hitPoint, { scale: 1.5 });
 *   // on teardown:
 *   vfx.dispose();
 */
export { VfxManager, type PlayOptions, type VfxHandle } from "./VfxManager.js";
export {
  ALL_EFFECT_KEYS,
  EFFECT_FILES,
  EFFECTS,
  type EffectKey,
} from "./effects.js";
export type {
  BeamHandle,
  BeamOptions,
  LiveMesh,
  ShockwaveOptions,
  TrailHandle,
  TrailOptions,
} from "./primitives.js";
export type { TextureName } from "./textures.js";
