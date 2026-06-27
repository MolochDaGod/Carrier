import {
  type AnimationClip,
  type Group,
  LoadingManager,
  type Material,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  SRGBColorSpace,
  Texture,
  TextureLoader,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";

import { getAsset } from "./catalog.js";
import { resolveAssetUrl } from "./urls.js";
import { cachedAssetUrl } from "./byteCache.js";
import { measure } from "./metrics.js";
import type { AssetEntry, LoadedModel } from "./types.js";

/**
 * 1x1 transparent PNG. FBX/OBJ files reference their textures by the original
 * authoring path; those bare names do not exist among the hashed bundle output,
 * so we redirect every such request to this blank pixel to avoid 404s in the
 * console, then apply the real (bundled) maps ourselves in `applyTextures`.
 */
const BLANK_PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * A loading manager that lets the primary model file (and any embedded data/blob
 * URIs, such as glTF's inlined buffers and textures) through untouched, while
 * neutralising any other relative sub-resource request to the blank pixel.
 */
function makeManager(mainUrl: string): LoadingManager {
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    if (url === mainUrl || url.startsWith("data:") || url.startsWith("blob:")) {
      return url;
    }
    return BLANK_PIXEL;
  });
  return manager;
}

/** True for low-resolution voxel/pixel atlases that should not be smoothed. */
function isPixelArt(entry: AssetEntry): boolean {
  return (
    entry.subgroup === "voxel" ||
    entry.category === "blocks" ||
    entry.category === "vehicles"
  );
}

async function loadTexture(
  url: string,
  pixelated: boolean,
  flipY: boolean,
): Promise<Texture> {
  // Await full fetch + decode so that a resolved load (and a 100% preload
  // progress report) means every companion texture is genuinely ready.
  // `url` here is a catalog-relative path; resolve it to a served URL lazily.
  const resolved = await cachedAssetUrl(await resolveAssetUrl(url));
  const tex = await new TextureLoader().loadAsync(resolved);
  tex.colorSpace = SRGBColorSpace;
  // FBX (3ds Max / Synty) UVs assume the classic top-left origin → flipY=true,
  // otherwise the shared atlas samples vertically-mirrored regions and props
  // come out miscoloured. OBJ/glTF UVs are authored for flipY=false.
  tex.flipY = flipY;
  if (pixelated) {
    tex.magFilter = NearestFilter;
    tex.minFilter = NearestFilter;
    tex.generateMipmaps = false;
  }
  return tex;
}

function materialsOf(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/** Filename keywords that mark a non-base-colour map (so it is never used as `.map`). */
const AUX_MAP_RE =
  /(emissive|normal|metal|rough|specular|gloss|ambientocclusion|(?:^|[^a-z0-9])ao(?:[^a-z0-9]|$)|orm|height|bump|displace|opacity|mask)/i;

/**
 * Apply the entry's companion textures to an FBX/OBJ scene graph.
 *
 * These packs share a handful of atlases across many models (e.g. Synty's
 * `T_PropsA` / `T_Boat`), so the hard part is choosing the *right* atlas per
 * material. FBX/OBJ loaders preserve the material's intended texture name on
 * `material.map.name` even though we redirected the image fetch to the blank
 * pixel, so we match on that first - falling back to the material name and then
 * the mesh name - instead of guessing from the mesh name alone (which left every
 * tropical prop wearing the boat atlas).
 *
 * - 0 textures: nothing to do (animation clips or untextured meshes).
 * - 1 colour texture: applied to every material (single-atlas models).
 * - N textures: matched per material by name key, first texture as a last resort
 *   so a model is never left untextured.
 */
async function applyTextures(
  root: Group,
  entry: AssetEntry,
  flipY: boolean,
): Promise<void> {
  if (entry.textureUrls.length === 0) return;

  const pixelated = isPixelArt(entry);
  const all = await Promise.all(
    entry.textureUrls.map(async (url) => ({
      url,
      key: nameKey(url),
      tex: await loadTexture(url, pixelated, flipY),
    })),
  );

  // Prefer base-colour atlases for `.map`; ignore emissive/normal/etc. unless
  // they are all we have (then we still show something rather than nothing).
  const colour = all.filter((t) => !AUX_MAP_RE.test(fileBase(t.url)));
  const candidates = colour.length > 0 ? colour : all;

  const pick = (...hints: (string | undefined)[]) => {
    if (candidates.length === 1) return candidates[0];
    for (const hint of hints) {
      const h = hint ? nameKey(hint) : "";
      if (!h) continue;
      // Prefer an exact key match before falling back to substring containment,
      // so a specific hint never gets snagged by a broader atlas key.
      const exact = candidates.find((t) => t.key.length > 0 && t.key === h);
      if (exact) return exact;
      const partial = candidates.find(
        (t) => t.key.length > 0 && (h.includes(t.key) || t.key.includes(h)),
      );
      if (partial) return partial;
    }
    return candidates[0];
  };

  root.traverse((node) => {
    if (!(node instanceof Mesh)) return;

    const replaced = materialsOf(node).map((existing) => {
      const intended = (existing as MeshStandardMaterial).map?.name;
      const picked = pick(intended, existing.name, node.name);

      const next = new MeshStandardMaterial({
        map: picked.tex,
        roughness: 0.85,
        metalness: 0.0,
      });
      existing.dispose();
      return next;
    });

    node.material = replaced.length === 1 ? replaced[0] : replaced;
  });
}

/** The bare filename (no directory, no query) of a URL. */
function fileBase(url: string): string {
  return (url.split("/").pop() ?? url).split("?")[0];
}

/**
 * Collapse a texture/material/mesh name to a short comparison key: drop the
 * extension, the Synty `T_` atlas prefix and every non-alphanumeric, then strip
 * boilerplate words. So both `T_PropsA_diffuse` and the bundled
 * `t-propsa-diffuse.png` reduce to `propsa`, and a mesh called `PalmTree`
 * reduces to `palmtree` (no false stripping of a leading "t").
 */
function nameKey(raw: string): string {
  return fileBase(raw)
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/^t[_-]/, "")
    .replace(/[^a-z0-9]+/g, "")
    .replace(/(diffuse|albedo|basecolor|complete|emissive|normalmap|normal|color|colour|4k|2k|1k|bake)/g, "");
}

async function loadGLTF(entry: AssetEntry): Promise<LoadedModel> {
  const url = await cachedAssetUrl(await resolveAssetUrl(entry.url));
  const loader = new GLTFLoader(makeManager(url));
  const gltf = await loader.loadAsync(url);
  const scene = gltf.scene as unknown as Group;
  return { scene, animations: gltf.animations, metrics: measure(scene) };
}

async function loadFBX(entry: AssetEntry): Promise<LoadedModel> {
  const url = await cachedAssetUrl(await resolveAssetUrl(entry.url));
  const loader = new FBXLoader(makeManager(url));
  const group = (await loader.loadAsync(url)) as unknown as Group;
  const animations = (group as Group & { animations?: AnimationClip[] }).animations ?? [];
  await applyTextures(group, entry, true);
  return { scene: group, animations, metrics: measure(group) };
}

async function loadOBJ(entry: AssetEntry): Promise<LoadedModel> {
  const url = await cachedAssetUrl(await resolveAssetUrl(entry.url));
  const loader = new OBJLoader(makeManager(url));
  const group = (await loader.loadAsync(url)) as unknown as Group;
  await applyTextures(group, entry, false);
  return { scene: group, animations: [], metrics: measure(group) };
}

/** In-flight / completed loads, keyed by asset id, so each model decodes once. */
const cache = new Map<string, Promise<LoadedModel>>();

function loadByFormat(entry: AssetEntry): Promise<LoadedModel> {
  switch (entry.format) {
    case "gltf":
      return loadGLTF(entry);
    case "fbx":
      return loadFBX(entry);
    case "obj":
      return loadOBJ(entry);
  }
}

/**
 * Load (and cache) a single asset by id.
 *
 * The returned `LoadedModel` is shared across callers — clone `scene` before
 * adding it to a scene you intend to mutate (use `SkeletonUtils.clone` for
 * skinned/animated models so the skeleton is duplicated correctly).
 */
export function loadAsset(id: string): Promise<LoadedModel> {
  const cached = cache.get(id);
  if (cached) return cached;

  const entry = getAsset(id);
  const promise = loadByFormat(entry).catch((err) => {
    // Do not cache failures, so a transient error can be retried.
    cache.delete(id);
    throw err;
  });
  cache.set(id, promise);
  return promise;
}

/** Convenience wrapper that accepts an entry instead of an id. */
export function loadAssetEntry(entry: AssetEntry): Promise<LoadedModel> {
  return loadAsset(entry.id);
}

/** Drop a single asset (or the whole catalog) from the in-memory cache. */
export function clearAssetCache(id?: string): void {
  if (id) cache.delete(id);
  else cache.clear();
}
