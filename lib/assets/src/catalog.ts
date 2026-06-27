import type { AssetCategory, AssetEntry, AssetFormat } from "./types.js";
import { allAssetPaths } from "./urls.js";

/** Extensions that represent a loadable primary model (not a texture / material). */
const MODEL_EXTS: Record<string, AssetFormat> = {
  gltf: "gltf",
  glb: "gltf",
  fbx: "fbx",
  obj: "obj",
};

const TEXTURE_EXTS = new Set(["png", "jpg", "jpeg"]);

const CATEGORIES: AssetCategory[] = [
  "enemies",
  "characters",
  "creatures",
  "props",
  "weapons",
  "blocks",
  "animations",
  "vehicles",
  "environment",
];

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

function baseOf(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  return dot >= 0 ? file.slice(0, dot) : file;
}

/** Turn `tpose-character01` / `block_grass` into `Tpose Character01` / `Block Grass`. */
function titleize(base: string): string {
  return base
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Choose the companion textures for an FBX/OBJ model.
 * - If a texture shares the model's base name, only those are used (1:1 pairing).
 * - Otherwise every texture in the same folder plus a sibling `textures/` folder
 *   is offered as a candidate atlas, and the loader matches them by name.
 */
function texturesFor(modelPath: string, texturePaths: string[]): string[] {
  const dir = dirOf(modelPath);
  const base = baseOf(modelPath).toLowerCase();

  const sameBase: string[] = [];
  const folderAtlases: string[] = [];
  for (const tex of texturePaths) {
    const tdir = dirOf(tex);
    if (tdir === dir && baseOf(tex).toLowerCase() === base) {
      sameBase.push(tex);
    } else if (tdir === dir || tdir === `${dir}/textures`) {
      folderAtlases.push(tex);
    }
  }
  const chosen = sameBase.length > 0 ? sameBase : folderAtlases;
  return chosen;
}

/** glTF in these buckets ships skeletal animation in the source packs. */
const ANIMATED_GLTF_CATEGORIES = new Set<AssetCategory>([
  "enemies",
  "characters",
  "creatures",
]);

function buildCatalog(): AssetEntry[] {
  const paths = allAssetPaths();
  const texturePaths = paths.filter((p) => TEXTURE_EXTS.has(extOf(p)));
  const entries: AssetEntry[] = [];

  for (const path of paths) {
    const format = MODEL_EXTS[extOf(path)];
    if (!format) continue; // skip textures, .mtl, etc.

    const parts = path.split("/");
    const category = parts[0] as AssetCategory;
    if (!CATEGORIES.includes(category)) continue;

    const subgroupParts = parts.slice(1, -1);
    const subgroup = subgroupParts.length > 0 ? subgroupParts.join("/") : undefined;
    const id = path.replace(/\.[^.]+$/, "");

    const textureUrls = format === "gltf" ? [] : texturesFor(path, texturePaths);
    const animated =
      category === "animations" ||
      (format === "gltf" && ANIMATED_GLTF_CATEGORIES.has(category));

    entries.push({
      id,
      category,
      subgroup,
      name: titleize(baseOf(path)),
      format,
      url: path,
      textureUrls,
      animated,
    });
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries;
}

/** The complete, immutable list of curated assets. */
export const ASSETS: readonly AssetEntry[] = Object.freeze(buildCatalog());

const BY_ID = new Map(ASSETS.map((e) => [e.id, e]));

/** All category names that contain at least one asset. */
export function listCategories(): AssetCategory[] {
  return CATEGORIES.filter((c) => ASSETS.some((e) => e.category === c));
}

/** Look up a single asset by its stable id, or throw if it does not exist. */
export function getAsset(id: string): AssetEntry {
  const entry = BY_ID.get(id);
  if (!entry) {
    throw new Error(`[@workspace/assets] unknown asset id: ${id}`);
  }
  return entry;
}

/** Look up a single asset by id without throwing. */
export function findAsset(id: string): AssetEntry | undefined {
  return BY_ID.get(id);
}

/** All assets in a category, optionally narrowed to one subgroup. */
export function getByCategory(
  category: AssetCategory,
  subgroup?: string,
): AssetEntry[] {
  return ASSETS.filter(
    (e) => e.category === category && (subgroup === undefined || e.subgroup === subgroup),
  );
}

/** Distinct subgroups present in a category, in alphabetical order. */
export function listSubgroups(category: AssetCategory): string[] {
  const set = new Set<string>();
  for (const e of ASSETS) {
    if (e.category === category && e.subgroup) set.add(e.subgroup);
  }
  return [...set].sort();
}
