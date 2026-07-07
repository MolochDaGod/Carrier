/**
 * fleetDebug — wired diagnostics for deployable fleet hull loading.
 *
 * Tracks every hull load (match entities, hangar roster, shipyard) so GLB
 * failures are visible instead of silently keeping the procedural cone.
 *
 * Enable:
 *   - URL: `?fleetDebug` or `?fleetDebug=1`
 *   - localStorage: `carrier:fleetDebug` = `"1"`
 *   - In-match toggle: backtick (`) key
 *
 * Console: `window.carrierFleetDebug.snapshot()`
 */
import type { FactionId, FleetRole } from "@workspace/carrier-net";
import { SKINNED_HULL_IDS } from "./hullFactory";

export type FleetHullPhase = "pending" | "glb" | "fallback" | "error";
export type FleetDebugSource = "match" | "roster" | "shipyard" | "hangar";

export interface FleetHullLoadCtx {
  /** Stable key — entity id in-match, or preview slot id elsewhere. */
  key: string;
  assetId: string;
  faction: FactionId;
  role?: FleetRole;
  source: FleetDebugSource;
  label?: string;
}

export interface FleetDebugEntry {
  key: string;
  assetId: string;
  faction: FactionId;
  role?: FleetRole;
  source: FleetDebugSource;
  label: string;
  phase: FleetHullPhase;
  attempts: number;
  skinned: boolean;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  error?: string;
}

export interface FleetDebugSnapshot {
  enabled: boolean;
  entries: FleetDebugEntry[];
  summary: {
    pending: number;
    glb: number;
    fallback: number;
    error: number;
  };
}

function readEnabledFromEnv(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.has("fleetDebug")) return true;
    return localStorage.getItem("carrier:fleetDebug") === "1";
  } catch {
    return false;
  }
}

class FleetDebugBus {
  private records = new Map<string, FleetDebugEntry>();
  private listeners = new Set<() => void>();
  private _enabled = readEnabledFromEnv();

  get enabled(): boolean {
    return this._enabled;
  }

  setEnabled(on: boolean): void {
    this._enabled = on;
    try {
      if (on) localStorage.setItem("carrier:fleetDebug", "1");
      else localStorage.removeItem("carrier:fleetDebug");
    } catch { /* private mode */ }
    this.emit();
    this.log("panel", on ? "enabled" : "disabled");
  }

  toggle(): void {
    this.setEnabled(!this._enabled);
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  /** Begin tracking a hull load. */
  start(ctx: FleetHullLoadCtx): void {
    const label = ctx.label ?? ctx.role ?? ctx.assetId.split("/").pop() ?? ctx.key;
    const entry: FleetDebugEntry = {
      key: ctx.key,
      assetId: ctx.assetId,
      faction: ctx.faction,
      role: ctx.role,
      source: ctx.source,
      label,
      phase: "pending",
      attempts: 0,
      skinned: SKINNED_HULL_IDS.has(ctx.assetId),
      startedAt: Date.now(),
    };
    this.records.set(ctx.key, entry);
    this.log("start", `${label} ← ${ctx.assetId}`, entry);
    this.emit();
  }

  attempt(key: string): void {
    const e = this.records.get(key);
    if (!e) return;
    e.attempts += 1;
    this.log("attempt", `${e.label} #${e.attempts}`);
    this.emit();
  }

  success(key: string): void {
    const e = this.records.get(key);
    if (!e) return;
    e.phase = "glb";
    e.finishedAt = Date.now();
    e.durationMs = e.finishedAt - e.startedAt;
    e.error = undefined;
    this.log("ok", `${e.label} GLB (${e.durationMs}ms)`, e);
    this.emit();
  }

  fallback(key: string, reason?: string): void {
    const e = this.records.get(key);
    if (!e) return;
    e.phase = "fallback";
    e.finishedAt = Date.now();
    e.durationMs = e.finishedAt - e.startedAt;
    e.error = reason;
    this.log("fallback", `${e.label} procedural cone`, reason ?? e);
    this.emit();
  }

  error(key: string, err: unknown): void {
    const e = this.records.get(key);
    const msg = err instanceof Error ? err.message : String(err);
    if (e) {
      e.phase = "error";
      e.finishedAt = Date.now();
      e.durationMs = e.finishedAt - e.startedAt;
      e.error = msg;
    }
    this.log("error", msg, e);
    this.emit();
  }

  remove(key: string): void {
    if (this.records.delete(key)) this.emit();
  }

  get(key: string): FleetDebugEntry | undefined {
    return this.records.get(key);
  }

  phaseFor(key: string): FleetHullPhase {
    return this.records.get(key)?.phase ?? "fallback";
  }

  snapshot(): FleetDebugSnapshot {
    const entries = [...this.records.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
    let pending = 0, glb = 0, fallback = 0, error = 0;
    for (const e of entries) {
      if (e.phase === "pending") pending++;
      else if (e.phase === "glb") glb++;
      else if (e.phase === "error") error++;
      else fallback++;
    }
    return { enabled: this._enabled, entries, summary: { pending, glb, fallback, error } };
  }

  private log(kind: string, msg: string, detail?: unknown): void {
    if (!this._enabled && kind !== "error" && kind !== "fallback") return;
    const tag = `[carrier:fleet:${kind}]`;
    if (detail !== undefined) console.log(tag, msg, detail);
    else console.log(tag, msg);
  }
}

export const fleetDebug = new FleetDebugBus();

/** Phase dot colour for HUD chips. */
export function hullPhaseColor(phase: FleetHullPhase): string {
  switch (phase) {
    case "glb": return "#5dff9b";
    case "pending": return "#ffd23f";
    case "error": return "#ff4d4d";
    default: return "#ff9d3f";
  }
}

if (typeof window !== "undefined") {
  (window as unknown as { carrierFleetDebug: FleetDebugBus }).carrierFleetDebug = fleetDebug;
}