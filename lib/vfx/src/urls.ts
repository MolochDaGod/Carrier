/**
 * Bundler-resolved loaders for every effect JSON under `lib/vfx/effects/`.
 *
 * Vite statically analyses this `import.meta.glob` call and code-splits each
 * effect into its own chunk (the JSONs carry base64 textures and can be large),
 * so nothing is fetched until a game actually loads that effect. Resolution is
 * anchored to this module, so the library works under any app's base path.
 */
const loaders = import.meta.glob("../effects/*.json", {
  import: "default",
}) as Record<string, () => Promise<unknown>>;

/** Map of bare filename (e.g. `muzzleFlash.json`) -> lazy loader. */
const byFile = new Map<string, () => Promise<unknown>>();
for (const [key, loader] of Object.entries(loaders)) {
  const file = key.slice(key.lastIndexOf("/") + 1);
  byFile.set(file, loader);
}

/** Load and return the parsed three.quarks JSON for an effect file. */
export async function loadEffectJson(file: string): Promise<unknown> {
  const loader = byFile.get(file);
  if (!loader) {
    throw new Error(`[@workspace/vfx] unknown effect file: ${file}`);
  }
  return loader();
}
