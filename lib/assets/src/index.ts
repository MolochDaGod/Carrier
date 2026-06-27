/**
 * @workspace/assets
 *
 * A curated, typed catalog of web-friendly 3D models (glTF / FBX / OBJ) shared by
 * the voxel-engine and arcade artifacts, plus loader utilities with caching and
 * batched preloading-with-progress.
 *
 * Typical usage:
 *
 *   import { getByCategory, loadAsset } from "@workspace/assets";
 *
 *   const zombie = await loadAsset("enemies/zombie");
 *   scene.add(zombie.scene.clone());
 *   // zombie.animations -> THREE.AnimationClip[]
 *
 * The catalog is generated from the files actually shipped under `models/`, so it
 * stays in sync automatically. See README.md for the curation pipeline.
 */
export type {
  AssetCategory,
  AssetEntry,
  AssetFormat,
  LoadedModel,
  ModelMetrics,
  PreloadProgress,
  Vec3,
} from "./types.js";

export { measure } from "./metrics.js";

export {
  ASSETS,
  findAsset,
  getAsset,
  getByCategory,
  listCategories,
  listSubgroups,
} from "./catalog.js";

export {
  clearAssetCache,
  loadAsset,
  loadAssetEntry,
} from "./loaders.js";

export {
  cachedAssetUrl,
  releaseCachedUrls,
} from "./byteCache.js";

export {
  preloadAssets,
  type PreloadOptions,
  type PreloadResult,
} from "./preload.js";

export {
  allAssetPaths,
  resolveAssetUrl,
  tryResolveAssetUrl,
} from "./urls.js";
