/**
 * Texture loading for code-built effects.
 *
 * The reusable bitmap textures harvested from the source VFX packs live in
 * `lib/vfx/textures/`. Vite statically analyses this `import.meta.glob` (anchored
 * to this module, so it resolves under any app base path) and serves each PNG as
 * a hashed URL. `loadTexture` resolves a name to a configured `THREE.Texture`,
 * falling back to a procedural radial sprite if the real asset can't be fetched
 * (e.g. under vitest/node) — so nothing ever throws and effects always render.
 */
import * as THREE from "three";

/** Curated texture names bundled with the library. */
export type TextureName =
  | "muzzle_front"
  | "streak"
  | "glow"
  | "sparkle"
  | "spark_sheet";

const urlLoaders = import.meta.glob("../textures/*.png", {
  query: "?url",
  import: "default",
}) as Record<string, () => Promise<string>>;

const byFile = new Map<string, () => Promise<string>>();
for (const [key, loader] of Object.entries(urlLoaders)) {
  const file = key.slice(key.lastIndexOf("/") + 1);
  byFile.set(file, loader);
}

let fallback: THREE.Texture | null = null;
const cache = new Map<TextureName, THREE.Texture>();

/**
 * A small radial-gradient sprite generated purely in JS (no canvas/DOM), used
 * whenever a real texture can't be loaded so effects still show in headless
 * environments and during the brief async window before a PNG arrives.
 */
function makeFallback(): THREE.Texture {
  if (fallback) return fallback;
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c;
      const dy = (y - c) / c;
      const d = Math.sqrt(dx * dx + dy * dy);
      const a = Math.max(0, 1 - d);
      const v = Math.round(255 * a * a);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = v;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  fallback = tex;
  return tex;
}

/** Shared fallback sprite (radial soft dot). Never null. */
export function fallbackTexture(): THREE.Texture {
  return makeFallback();
}

/**
 * Load (and cache) a bundled texture by name. Resolves immediately to a fallback
 * sprite if the asset is unavailable; never rejects. The returned texture is a
 * SHARED, module-cached instance reused across every {@link VfxManager} for the
 * page lifetime, so callers must NOT dispose it — a manager that frees a borrowed
 * texture on teardown would invalidate it for every other (and future) manager
 * holding the same instance. The cache itself is never freed (a small, bounded
 * set of textures), which is intentional.
 */
export async function loadTexture(name: TextureName): Promise<THREE.Texture> {
  const cached = cache.get(name);
  if (cached) return cached;

  const loader = byFile.get(`${name}.png`);
  const fb = makeFallback();
  if (!loader) {
    cache.set(name, fb);
    return fb;
  }
  try {
    const url = await loader();
    const tex = await new THREE.TextureLoader().loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    cache.set(name, tex);
    return tex;
  } catch {
    cache.set(name, fb);
    return fb;
  }
}
