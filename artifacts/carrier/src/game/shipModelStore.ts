/**
 * shipModelStore — durable, device-local persistence for user-uploaded mothership
 * GLBs so custom ship models survive a page refresh.
 *
 * Uploaded models are multi-megabyte binary GLB/glTF files. localStorage is the
 * wrong tool (string-only, ~5MB cap, base64 inflates size ~33%), so we use
 * IndexedDB, which stores Blobs natively with a large quota. The Carrier app is
 * frontend-only — its Puter auth is unused boilerplate and the api-server only
 * carries live match traffic — so there is no per-user backend to key against;
 * overrides persist per-device, keyed by the catalog ASSET ID they replace (so a
 * custom hull only shows on that hull, while a custom platform/turret applies
 * fleet-wide, exactly mirroring the in-memory override semantics).
 *
 * All operations fail soft: if IndexedDB is unavailable (private mode, blocked,
 * quota), reads resolve empty and writes resolve without throwing, so the hangar
 * keeps working with session-only overrides.
 */

const DB_NAME = "carrier-ship-models";
const DB_VERSION = 1;
const STORE = "overrides";

/** Max accepted upload size. GLBs above this are rejected before any work. */
export const MAX_MODEL_BYTES = 30 * 1024 * 1024; // 30 MB
const ALLOWED_EXTENSIONS = [".glb", ".gltf"] as const;
const ALLOWED_MIME = [
  "model/gltf-binary",
  "model/gltf+json",
  "application/octet-stream",
  "",
] as const;

/** A stored override: the raw file blob plus light metadata. */
export interface StoredModel {
  id: string;
  name: string;
  type: string;
  size: number;
  blob: Blob;
  updatedAt: number;
}

/** Thrown by {@link validateModelFile} with a user-facing `message`. */
export class ModelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelValidationError";
  }
}

/**
 * Validate an upload BEFORE any expensive work (object URL, GLB parse, storage).
 * Throws {@link ModelValidationError} with a friendly message on rejection.
 */
export function validateModelFile(file: File): void {
  const lower = file.name.toLowerCase();
  const extOk = ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
  const mimeOk = ALLOWED_MIME.includes(file.type as (typeof ALLOWED_MIME)[number]);
  if (!extOk && !mimeOk) {
    throw new ModelValidationError("Unsupported file — upload a .glb or .gltf model.");
  }
  if (file.size <= 0) {
    throw new ModelValidationError("That file is empty.");
  }
  if (file.size > MAX_MODEL_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    const cap = Math.round(MAX_MODEL_BYTES / (1024 * 1024));
    throw new ModelValidationError(`Model is too large (${mb} MB). Max is ${cap} MB.`);
  }
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

/** Persist (or replace) the override for an asset id. Fails soft. */
export async function saveOverride(id: string, file: File): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const record: StoredModel = {
        id,
        name: file.name,
        type: file.type,
        size: file.size,
        blob: file,
        updatedAt: Date.now(),
      };
      const req = tx(db, "readwrite").put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } finally {
    db.close();
  }
}

/** Load every stored override. Returns an empty record on any failure. */
export async function loadOverrides(): Promise<StoredModel[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    return await new Promise<StoredModel[]>((resolve) => {
      const req = tx(db, "readonly").getAll();
      req.onsuccess = () => resolve((req.result as StoredModel[]) ?? []);
      req.onerror = () => resolve([]);
    });
  } finally {
    db.close();
  }
}

/** Delete the persisted override for one asset id. Fails soft. */
export async function deleteOverride(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const req = tx(db, "readwrite").delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } finally {
    db.close();
  }
}

/** Delete all persisted overrides. Fails soft. */
export async function clearOverrides(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const req = tx(db, "readwrite").clear();
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } finally {
    db.close();
  }
}
