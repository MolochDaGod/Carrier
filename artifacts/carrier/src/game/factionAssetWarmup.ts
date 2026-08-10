/**
 * Hangar + match asset warmup — industry-standard staged preload.
 *
 * Uses @workspace/assets preloadAssets (bounded concurrency + decode cache) so
 * fleet deploys hit memory cache instead of cold network+parse.
 */
import {
  isCdnPreferred,
  preloadAssets,
  resetLoadQueueStats,
  setLoadConcurrency,
  type PreloadProgress,
} from "@workspace/assets";
import type { FactionId } from "@workspace/carrier-net";
import { factionAssetManifest, factionWarmupIds } from "./factionAssetManifest";

export type WarmupPhase = "idle" | "critical" | "fleet" | "done" | "error";

export interface WarmupState {
  faction: FactionId | null;
  phase: WarmupPhase;
  fraction: number;
  loaded: number;
  total: number;
  failures: string[];
  cdn: boolean;
}

type Listener = (s: WarmupState) => void;

let state: WarmupState = {
  faction: null,
  phase: "idle",
  fraction: 0,
  loaded: 0,
  total: 0,
  failures: [],
  cdn: isCdnPreferred(),
};

/** Stable snapshot for useSyncExternalStore — must keep referential equality until state changes. */
let snapshot: WarmupState = {
  ...state,
  failures: [...state.failures],
};

let runToken = 0;
const listeners = new Set<Listener>();

function freezeSnapshot(): WarmupState {
  return {
    ...state,
    failures: [...state.failures],
  };
}

function emit(): void {
  snapshot = freezeSnapshot();
  for (const cb of listeners) cb(snapshot);
}

function setState(patch: Partial<WarmupState>): void {
  state = {
    ...state,
    ...patch,
    failures: patch.failures ?? state.failures,
  };
  emit();
}

export function getWarmupState(): WarmupState {
  return snapshot;
}

/** True once staged preload finished (including partial CDN failures). */
export function isWarmupReady(): boolean {
  return state.phase === "done" || state.phase === "error";
}

export function subscribeWarmup(cb: Listener): () => void {
  listeners.add(cb);
  cb(snapshot);
  return () => listeners.delete(cb);
}

/**
 * Warm faction assets for live play. Safe to call on every faction switch —
 * in-flight work for a stale faction is ignored via run token.
 */
export async function warmupFactionAssets(faction: FactionId): Promise<void> {
  const token = ++runToken;
  resetLoadQueueStats();
  // Mobile-safe default; desktop can raise via ?assetConcurrency=6
  const q = typeof window !== "undefined"
    ? Number(new URLSearchParams(window.location.search).get("assetConcurrency")) || 4
    : 4;
  setLoadConcurrency(q);

  const manifest = factionAssetManifest(faction);
  setState({
    faction,
    phase: "critical",
    fraction: 0,
    loaded: 0,
    total: manifest.critical.length + manifest.fleet.length,
    failures: [],
    cdn: isCdnPreferred(),
  });

  const onProgress = (p: PreloadProgress) => {
    if (token !== runToken) return;
    setState({
      loaded: p.loaded,
      total: p.total,
      fraction: p.fraction,
      phase: p.loaded <= manifest.critical.length ? "critical" : "fleet",
    });
  };

  try {
    const crit = await preloadAssets(manifest.critical, {
      concurrency: Math.min(3, q),
      continueOnError: true,
      onProgress,
    });
    if (token !== runToken) return;

    const fleet = await preloadAssets(manifest.fleet, {
      concurrency: q,
      continueOnError: true,
      onProgress: (p) => {
        if (token !== runToken) return;
        const base = manifest.critical.length;
        setState({
          loaded: base + p.loaded,
          total: base + p.total,
          fraction: (base + p.loaded) / (base + p.total),
          phase: "fleet",
        });
      },
    });

    if (token !== runToken) return;
    const failures = [
      ...[...crit.failures.keys()],
      ...[...fleet.failures.keys()],
    ];
    setState({
      phase: failures.length > 0 ? "error" : "done",
      fraction: 1,
      failures,
    });

    if (failures.length > 0) {
      console.warn("[carrier:assets] warmup partial failure", { faction, failures });
    }
  } catch (err) {
    if (token !== runToken) return;
    setState({ phase: "error", failures: [String(err)] });
    console.error("[carrier:assets] warmup failed", faction, err);
  }
}

if (typeof window !== "undefined") {
  (window as unknown as { carrierAssetWarmup: typeof warmupFactionAssets }).carrierAssetWarmup =
    warmupFactionAssets;
}