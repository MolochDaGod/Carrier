/**
 * Persistent byte cache for 3D asset files (production only).
 *
 * The in-memory `loadAsset` cache (loaders.ts) decodes each model once per page
 * session. This layer sits underneath it and persists the *raw bytes* of model
 * and texture files in IndexedDB so a repeat visit skips the network entirely —
 * the second launch of the same game/editor loads its models from disk.
 *
 * Keying is by URL. Vite content-hashes every bundled asset filename, so a URL is
 * a stable, self-invalidating key: when an asset's contents change its hashed URL
 * changes too, producing a fresh cache entry and leaving the stale one orphaned
 * (harmless; pruned opportunistically). Everything is best-effort — any failure
 * (no IndexedDB, quota exceeded, fetch error) falls back to the original URL, so
 * caching can never break a load that would otherwise succeed.
 *
 * Disabled outside production (`import.meta.env.PROD`) so development always hits
 * Vite's live, hot-reloaded asset URLs.
 */

const DB_NAME = "workspace-assets";
const STORE = "files";
const DB_VERSION = 1;

/** Resolves to the opened DB, or null when IndexedDB is unavailable/blocked. */
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function idbGet(db: IDBDatabase, key: string): Promise<Blob | undefined> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as Blob | undefined);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

function idbPut(db: IDBDatabase, key: string, value: Blob): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Object URLs we created from cached blobs, so a caller can release them. */
const objectUrls = new Set<string>();

/**
 * Resolve an asset URL to a (possibly cached) URL safe to hand to a three.js
 * loader. In production, returns a `blob:` URL backed by IndexedDB-cached bytes,
 * fetching and storing them on the first miss. Falls back to the original URL on
 * any error, and for non-production / non-http(s) (data:, blob:) URLs.
 */
export async function cachedAssetUrl(url: string): Promise<string> {
  if (!import.meta.env.PROD) return url;
  if (url.startsWith("data:") || url.startsWith("blob:")) return url;

  try {
    const db = await openDb();
    if (!db) return url;

    const hit = await idbGet(db, url);
    if (hit) {
      const objectUrl = URL.createObjectURL(hit);
      objectUrls.add(objectUrl);
      return objectUrl;
    }

    const res = await fetch(url);
    if (!res.ok) return url;
    const blob = await res.blob();
    await idbPut(db, url, blob);

    const objectUrl = URL.createObjectURL(blob);
    objectUrls.add(objectUrl);
    return objectUrl;
  } catch {
    return url;
  }
}

/** Release every object URL this module created (call on teardown if desired). */
export function releaseCachedUrls(): void {
  for (const u of objectUrls) {
    try {
      URL.revokeObjectURL(u);
    } catch {
      // ignore
    }
  }
  objectUrls.clear();
}
