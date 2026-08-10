/**
 * Device-local Y-axis hull tuning offsets (radians), keyed by catalog asset id.
 * Adjust in-match with numpad 4 / 6 / 5; applied on every hull load.
 */
const STORAGE_KEY = "carrier-hull-yaw-v1";

function readMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Saved tune offset (radians) for an asset slot, or 0. */
export function getHullYawTune(assetId: string): number {
  return readMap()[assetId] ?? 0;
}

/** Persist a tune offset; near-zero clears the entry. */
export function saveHullYawTune(assetId: string, yawRad: number): boolean {
  try {
    const map = readMap();
    if (Math.abs(yawRad) < 1e-5) delete map[assetId];
    else map[assetId] = yawRad;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}