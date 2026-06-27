import type { AnimationClip, Group } from "three";

/**
 * Web-friendly model container formats curated into this library.
 * - `gltf`: self-contained glTF (embedded geometry, textures and animations).
 * - `fbx`:  FBX, used here for skinned characters and standalone animation clips.
 * - `obj`:  Wavefront OBJ, used for static voxel meshes (textured via an atlas).
 */
export type AssetFormat = "gltf" | "fbx" | "obj";

/** Top-level content buckets, derived from the on-disk folder layout. */
export type AssetCategory =
  | "enemies"
  | "characters"
  | "creatures"
  | "props"
  | "weapons"
  | "blocks"
  | "animations"
  | "vehicles"
  | "environment";

/**
 * A single curated asset. Entries are generated from the bundled model files at
 * module-evaluation time (see `catalog.ts`), so the catalog can never drift from
 * what is actually shipped in `lib/assets/models/`.
 */
export interface AssetEntry {
  /** Stable, unique id (the model's path under `models/` without extension), e.g. `enemies/zombie`. */
  id: string;
  /** Top-level bucket the asset belongs to. */
  category: AssetCategory;
  /** Optional sub-grouping below the category, e.g. `humanoid`, `guns`, `dungeon`. */
  subgroup?: string;
  /** Human-friendly display name, e.g. `Zombie`, `Tpose Character01`. */
  name: string;
  /** Container format of the primary model file. */
  format: AssetFormat;
  /** Bundler-resolved URL of the primary model file (hashed and served by Vite). */
  url: string;
  /**
   * Companion texture URLs to apply after load for formats that reference
   * external maps (FBX/OBJ). Empty for self-contained glTF.
   */
  textureUrls: string[];
  /**
   * Best-effort hint that the asset carries skeletal animation. The authoritative
   * source is always the `animations` array returned by the loader.
   */
  animated: boolean;
}

/** A 3-component vector as plain data (so metrics stay serialisable / THREE-free). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Dimensional "self-awareness" for a model, measured once from its world-space
 * axis-aligned bounding box. Every game needs these numbers to place, scale and
 * frame a model (spawn radius, deck-clamping, camera framing, hit spheres,
 * grounding), and they were previously recomputed ad-hoc in each artifact. They
 * are stored as plain data so they can be cloned, cached and reasoned about
 * without a THREE dependency.
 */
export interface ModelMetrics {
  /** Axis-aligned bounding-box dimensions (width, height, depth) in model units. */
  size: Vec3;
  /** Centre of the bounding box (in the space the object was measured in). */
  center: Vec3;
  /** Minimum corner of the bounding box. */
  min: Vec3;
  /** Maximum corner of the bounding box. */
  max: Vec3;
  /** Half-extents of the horizontal (x,z) footprint — useful for deck/ground clamping. */
  footprint: { x: number; z: number };
  /** Largest horizontal extent, `max(size.x, size.z)`. */
  longestHorizontal: number;
  /** Largest extent across all three axes. */
  longest: number;
  /** Bounding-sphere radius about the box centre (good for hit spheres / culling). */
  radius: number;
  /** Y offset to add so the model's base rests on `y = 0`, i.e. `-min.y`. */
  feetOffset: number;
}

/** Result of loading a model: a scene graph, bundled clips, and measured metrics. */
export interface LoadedModel {
  /**
   * Root object ready to add to a scene. Treat this as shared/cached: clone it
   * (e.g. `SkeletonUtils.clone` for skinned meshes, `.clone()` otherwise) before
   * mutating, so multiple consumers can reuse one decoded model.
   */
  scene: Group;
  /** Animation clips bundled with the model. Empty for static assets. */
  animations: AnimationClip[];
  /**
   * Dimensional metrics measured from the freshly-loaded `scene` (its rest pose).
   * Re-measure a clone with `measure()` after you scale or pose it.
   */
  metrics: ModelMetrics;
}

/** Progress payload reported while preloading a batch of assets. */
export interface PreloadProgress {
  /** Number of assets finished (succeeded or failed) so far. */
  loaded: number;
  /** Total number of assets in the batch. */
  total: number;
  /** Fraction in the range [0, 1]. */
  fraction: number;
  /** Id of the most recently completed asset. */
  current: string;
}
