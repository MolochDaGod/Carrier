/**
 * hullOverrides — make user-uploaded ship models show up in the LIVE game.
 *
 * The Shipyard ({@link ../pages/Shipyard}) lets the player replace any ship slot
 * (player/enemy fighter, every fleet hull, every faction station) with their own
 * `.glb`/`.gltf`, persisted per-device in IndexedDB (keyed by the slot's catalog
 * asset id) via {@link ./shipModelStore}. But until those overrides are read back
 * at render time, a "saved" replacement only ever showed up in the Shipyard
 * preview, never in an actual match.
 *
 * This module is that missing read-back: it primes the saved overrides once
 * (parsing each stored blob into an OWNED THREE template), and `hullFactory`
 * resolves an override template ahead of the catalog `loadAsset` for any slot
 * that has one — so replacements appear in gameplay through the exact same
 * orient/fit/tint path as the default.
 *
 * Lifecycle:
 *  - `ensureOverridesPrimed()` is awaited by every `hullFactory` load and primes
 *    lazily, exactly once (memoised). It is best-effort: any storage/parse error
 *    leaves the catalog default in place.
 *  - `disposeHullOverrides()` frees the owned templates AND resets the memo, so
 *    the next game launch re-primes — automatically picking up anything the
 *    player saved in the Shipyard between matches.
 *
 * Ownership: parsed templates own their geometry + materials + textures (parsed
 * fresh, NOT from the shared `loadAsset` cache). Their per-instance clones share
 * that geometry, so `tintMetalHull` flags clone meshes `sharedGeo` and
 * `disposeGroup` frees only the clone's owned materials — the template geometry
 * is freed once, here, on teardown.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { loadOverrides } from "./shipModelStore";

/** Owned, parsed replacement scenes keyed by the catalog asset id they replace. */
const templates = new Map<string, THREE.Object3D>();

/** Memoised one-shot prime promise; cleared by {@link disposeHullOverrides}. */
let primePromise: Promise<void> | null = null;

/**
 * Monotonic teardown token. {@link disposeHullOverrides} bumps it; an in-flight
 * {@link prime} captures the value at start and aborts any write once it no
 * longer matches — so a dispose that lands MID-prime can't resurrect freed
 * templates after teardown (rapid dispose → relaunch cycles).
 */
let generation = 0;

/** Texture-bearing material slots we might own on a parsed override. */
const TEXTURE_SLOTS = [
  "map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap",
  "bumpMap", "displacementMap", "alphaMap", "lightMap", "specularMap",
  "clearcoatMap", "clearcoatNormalMap", "clearcoatRoughnessMap",
  "sheenColorMap", "sheenRoughnessMap", "transmissionMap", "thicknessMap",
  "iridescenceMap", "iridescenceThicknessMap", "anisotropyMap",
] as const;

/**
 * Load every persisted override blob and parse it into an owned template. Safe
 * no-op if storage is unavailable or nothing is saved; individual corrupt blobs
 * are skipped so they can't wedge the whole prime.
 */
async function prime(gen: number): Promise<void> {
  let records: Awaited<ReturnType<typeof loadOverrides>>;
  try {
    records = await loadOverrides();
  } catch {
    return; // storage unavailable — every slot keeps its catalog default
  }
  if (gen !== generation || records.length === 0) return; // disposed mid-read

  const loader = new GLTFLoader();
  for (const rec of records) {
    const url = URL.createObjectURL(rec.blob);
    try {
      const gltf = await loader.loadAsync(url);
      // A dispose landed while this blob was parsing: drop the just-parsed scene
      // and abort so we never resurrect templates after teardown.
      if (gen !== generation) {
        disposeTemplate(gltf.scene);
        return;
      }
      const prev = templates.get(rec.id);
      if (prev) disposeTemplate(prev);
      templates.set(rec.id, gltf.scene);
    } catch {
      // Corrupt/unsupported stored blob — leave the catalog default in place.
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * Prime saved overrides once. Awaited at the top of every `hullFactory` load so
 * the override map is ready before any slot is resolved, regardless of call
 * timing. Memoised — subsequent calls return the same in-flight/resolved promise.
 */
export function ensureOverridesPrimed(): Promise<void> {
  if (!primePromise) primePromise = prime(generation);
  return primePromise;
}

/** The parsed override template for a catalog asset id, or null if none saved. */
export function getOverrideTemplate(id: string): THREE.Object3D | null {
  return templates.get(id) ?? null;
}

/**
 * Free all owned override templates (geometry + materials + textures) and reset
 * the prime memo. Call on game teardown. The next {@link ensureOverridesPrimed}
 * re-primes from storage, so a Shipyard save made between matches is picked up.
 */
export function disposeHullOverrides(): void {
  // Bump first so any in-flight prime() sees a stale generation and aborts its
  // next write instead of repopulating the map after we clear it.
  generation++;
  for (const t of templates.values()) disposeTemplate(t);
  templates.clear();
  primePromise = null;
}

/** Fully dispose an OWNED template scene — geometry, materials, and textures. */
function disposeTemplate(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    (o.geometry as THREE.BufferGeometry)?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      const any = m as unknown as Record<string, unknown>;
      for (const slot of TEXTURE_SLOTS) {
        const tex = any[slot];
        if (tex instanceof THREE.Texture) tex.dispose();
      }
      (m as THREE.Material)?.dispose?.();
    }
  });
}
