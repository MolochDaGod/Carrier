/**
 * Bundler-resolved URLs for every curated asset file.
 *
 * Vite statically analyses this `import.meta.glob` call and rewrites each matched
 * file under `lib/assets/models/` to a hashed, served URL (the `?url` query asks
 * for the URL string rather than the file contents). The glob is intentionally
 * **lazy** (no `eager`): each entry is a `() => Promise<url>` loader, so the URL
 * for a given file is only requested when something actually needs it.
 *
 * Why lazy matters: with `eager: true`, Vite emits one static `?url` import per
 * matched file, and in dev each of those is a separate HTTP request fired the
 * instant any app imports this module. Across the whole `models/` tree (and every
 * artifact iframe loading it at once) that floods the browser with hundreds of
 * concurrent requests — `net::ERR_INSUFFICIENT_RESOURCES`. Lazy resolution keeps
 * the synchronous catalog (which only needs the file *paths*) cheap, and defers
 * the actual URL request to load time, behind the loader cache.
 */
const urlLoaders = import.meta.glob(
  "../models/**/*.{gltf,glb,fbx,obj,mtl,png,jpg,jpeg}",
  { query: "?url", import: "default" },
) as Record<string, () => Promise<string>>;

const MODELS_PREFIX = "../models/";

/** Map of `category/sub/file.ext` -> lazy URL loader. */
const loaderByRelPath = new Map<string, () => Promise<string>>();
for (const [key, loader] of Object.entries(urlLoaders)) {
  const rel = key.startsWith(MODELS_PREFIX)
    ? key.slice(MODELS_PREFIX.length)
    : key.replace(/^.*\/models\//, "");
  loaderByRelPath.set(rel, loader);
}

/** Resolved URLs, cached after the first request so each file is fetched once. */
const urlCache = new Map<string, string>();

/** Every curated file's relative path (e.g. `enemies/zombie.gltf`), sorted. */
export function allAssetPaths(): string[] {
  return [...loaderByRelPath.keys()].sort();
}

/** True if the catalog knows this relative path. */
export function hasAssetPath(relPath: string): boolean {
  return loaderByRelPath.has(relPath);
}

/** Resolve a relative model path to its bundled URL, or throw if unknown. */
export async function resolveAssetUrl(relPath: string): Promise<string> {
  const cached = urlCache.get(relPath);
  if (cached !== undefined) return cached;
  const loader = loaderByRelPath.get(relPath);
  if (!loader) {
    throw new Error(`[@workspace/assets] unknown asset path: ${relPath}`);
  }
  const url = await loader();
  urlCache.set(relPath, url);
  return url;
}

/** Already-resolved URL for a path, or undefined if it has not been loaded yet. */
export function tryResolveAssetUrl(relPath: string): string | undefined {
  return urlCache.get(relPath);
}
