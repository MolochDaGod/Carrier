# @workspace/assets

A shared, curated catalog of web-friendly 3D models (glTF / FBX / OBJ) used by both
the `voxel-engine` and `arcade` artifacts, with typed lookup helpers and loader
utilities (caching + batched preload-with-progress).

## Using it

```ts
import { getByCategory, loadAsset, preloadAssets } from "@workspace/assets";

// Browse the catalog
const enemies = getByCategory("enemies"); // AssetEntry[]

// Load one model (cached; clone the scene before mutating it)
const zombie = await loadAsset("enemies/zombie");
scene.add(zombie.scene.clone());
mixer.clipAction(zombie.animations[0]); // glTF enemies ship animation clips

// Preload a batch with progress
await preloadAssets(["enemies/zombie", "weapons/tools/sword-diamond"], {
  onProgress: (p) => console.log(`${Math.round(p.fraction * 100)}%`),
});
```

- `three` is a **peer dependency** — the consuming app provides it (and should keep
  `three` in its Vite `resolve.dedupe`).
- URLs are resolved with `import.meta.glob(..., { query: "?url" })`, so the library
  works regardless of the base path the host app is mounted under. Loading happens
  lazily; nothing is fetched until a loader runs.

## Catalog shape

Entries are generated from the files under `models/` at module load, so the catalog
can never drift from what ships. Each `AssetEntry` has a stable `id`
(`category/sub/file`), `category`, optional `subgroup`, `name`, `format`, resolved
`url`, companion `textureUrls`, and an `animated` hint.

Categories: `enemies`, `characters`, `creatures`, `props`, `weapons`, `blocks`,
`animations`, `vehicles`, `environment`.

## Texture handling

glTF assets are self-contained (embedded geometry, atlas, and animation). For FBX
and OBJ, the original files reference textures by their authoring paths, which do not
exist among the bundler's hashed output; the loaders redirect those requests to a
blank pixel (avoiding 404s) and then apply the bundled companion textures from the
catalog entry instead.

## Curation pipeline

`models/` is generated, not hand-edited. The curation tool
`scripts/extract.py` reads the source asset zips from the repo-root
`attached_assets/` folder, copies only the chosen web-format files, normalizes
their names, and downsamples any texture larger than 1024px on its long edge
(requires Pillow). Re-run from the repo root:

```bash
python3 lib/assets/scripts/extract.py
```

Excluded from curation: executables, PSD UI packs, `.blend`/`.ply`/`.vox`/`.gif`
source files, and 4K texture variants (downsampled on import).
