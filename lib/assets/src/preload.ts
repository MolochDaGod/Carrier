import { loadAsset } from "./loaders.js";
import type { LoadedModel, PreloadProgress } from "./types.js";

export interface PreloadOptions {
  /** Called after each asset settles (success or failure). */
  onProgress?: (progress: PreloadProgress) => void;
  /** Maximum number of assets to decode at once. Defaults to 4. */
  concurrency?: number;
  /**
   * When true (default), a single asset failure does not reject the batch; the
   * id is recorded in `failures` instead. Set false to fail fast.
   */
  continueOnError?: boolean;
}

export interface PreloadResult {
  /** Successfully loaded models, keyed by asset id. */
  models: Map<string, LoadedModel>;
  /** Ids that failed to load, mapped to their error. */
  failures: Map<string, unknown>;
}

/**
 * Decode a batch of assets ahead of time with a bounded concurrency pool,
 * reporting progress as each one settles. Results reuse the loader cache, so
 * later `loadAsset` calls for the same ids resolve instantly.
 */
export async function preloadAssets(
  ids: string[],
  options: PreloadOptions = {},
): Promise<PreloadResult> {
  const { onProgress, concurrency = 4, continueOnError = true } = options;

  const total = ids.length;
  const models = new Map<string, LoadedModel>();
  const failures = new Map<string, unknown>();
  let loaded = 0;
  let cursor = 0;

  function report(current: string): void {
    loaded += 1;
    onProgress?.({
      loaded,
      total,
      fraction: total === 0 ? 1 : loaded / total,
      current,
    });
  }

  async function worker(): Promise<void> {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      try {
        models.set(id, await loadAsset(id));
      } catch (err) {
        failures.set(id, err);
        if (!continueOnError) throw err;
      } finally {
        report(id);
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, ids.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { models, failures };
}
