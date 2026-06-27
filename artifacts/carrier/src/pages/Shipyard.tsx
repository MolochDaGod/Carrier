/**
 * Carrier — Shipyard import/preview page.
 *
 * A no-auth workbench for bringing in custom ship models one at a time. Pick a
 * faction, pick a ship slot on the left (player/enemy fighter, each fleet hull,
 * each faction station), drop in a `.glb`/`.gltf`, and preview it live on a
 * turntable through the EXACT orient/fit/tint path the live game uses — so what
 * you see is what the ship will look like in matches. The fleet slots are
 * faction-aware: switching the faction selector swaps the six fleet hulls to that
 * faction's baked deploy set (their asset ids change with it).
 *
 * Imports here are a per-device LOCAL preview only (IndexedDB, keyed by the
 * slot's asset id); they override the local render but do NOT change what every
 * player deploys. The baked, shipped defaults live in `factionAssets.ts` — that
 * is the real per-faction deploy set.
 *
 * Reachable at `?shipyard` (wired in `main.tsx`), bypassing the Puter gate.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FACTIONS,
  FACTION_ORDER,
  MOTHER_SHIP,
  fleetRoleDef,
  type FactionId,
} from "@workspace/carrier-net";
import { ShipyardInspector, type ShipSlot, type ShipyardState } from "@/game/ShipyardInspector";
import { DEPLOY_ROLES, FACTION_STATIONS, FIGHTER_GLB, fleetModelFor } from "@/game/factionAssets";
import { SHIP_FIT } from "@/game/constants";
import {
  deleteOverride,
  loadOverrides,
  ModelValidationError,
  saveOverride,
  validateModelFile,
} from "@/game/shipModelStore";

const FLEET_ORDER = DEPLOY_ROLES;

/**
 * Build the ship-slot catalog for `faction`, with the same fits the live game
 * uses. Fighters + the station list are faction-independent; the six fleet slots
 * resolve to the selected faction's baked deploy hulls (so their keys/models
 * change when the faction changes).
 */
function buildSlots(faction: FactionId): ShipSlot[] {
  const slots: ShipSlot[] = [];

  for (const key of ["player", "enemy"] as const) {
    const model = FIGHTER_GLB[key];
    slots.push({
      key: model.id,
      label: key === "player" ? "Player Fighter" : "Enemy Fighter",
      group: "Fighters",
      fit: SHIP_FIT,
      kind: "fighter",
      catalogIds: [model.id],
      yaw: model.yaw,
    });
  }

  for (const role of FLEET_ORDER) {
    const model = fleetModelFor(faction, role);
    const def = fleetRoleDef(role);
    slots.push({
      key: model.id,
      label: `${role[0].toUpperCase()}${role.slice(1)}`,
      group: "Fleet Hulls",
      fit: def ? def.scale : 8,
      kind: "fleet",
      catalogIds: [model.id],
      yaw: model.yaw,
    });
  }

  for (const faction of FACTION_ORDER) {
    const def = FACTION_STATIONS[faction];
    slots.push({
      // Stations are multi-part; key the override to the primary part id.
      key: def.parts[0],
      label: FACTIONS[faction].name,
      group: "Faction Stations",
      fit: SHIP_FIT * MOTHER_SHIP.scaleFactor * def.fitMul,
      kind: "station",
      catalogIds: def.parts,
      faction,
    });
  }

  return slots;
}

export function Shipyard() {
  const [faction, setFaction] = useState<FactionId>("scavengers");
  const slots = useMemo(() => buildSlots(faction), [faction]);
  const groups = useMemo(() => {
    const map = new Map<string, ShipSlot[]>();
    for (const s of slots) {
      const arr = map.get(s.group) ?? [];
      arr.push(s);
      map.set(s.group, arr);
    }
    return [...map.entries()];
  }, [slots]);

  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ShipyardInspector | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selected, setSelected] = useState(0);
  const [spin, setSpin] = useState(true);
  const [state, setState] = useState<ShipyardState | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);

  // Session-staged imports per slot key (seeded from saved overrides on mount).
  const [staged, setStaged] = useState<Map<string, File>>(new Map());
  // Slot keys with an override persisted in IndexedDB (drives the "Saved" badge).
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  // Slot keys whose staged import hasn't been persisted yet (drives "New" badge +
  // enables Save even when the slot already has an older saved override).
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());

  const active = slots[selected];
  const activeFile = staged.get(active.key) ?? null;

  // Boot the WebGL engine once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let engine: ShipyardInspector | null = null;
    try {
      engine = new ShipyardInspector(container, setState);
      engineRef.current = engine;
    } catch (err) {
      console.error("[carrier-shipyard] engine failed to start", err);
      setFatal("Could not create a WebGL context. Open this page in a real browser with hardware acceleration.");
      return;
    }
    return () => {
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  // Seed staged imports + saved badges from any persisted overrides.
  useEffect(() => {
    let cancelled = false;
    void loadOverrides().then((records) => {
      if (cancelled) return;
      const keys = new Set<string>();
      const files = new Map<string, File>();
      for (const rec of records) {
        keys.add(rec.id);
        files.set(rec.id, new File([rec.blob], rec.name, { type: rec.type }));
      }
      setSavedKeys(keys);
      setStaged(files);
    });
    return () => { cancelled = true; };
  }, []);

  // Keep the engine tint in sync (it re-issues the current view itself).
  useEffect(() => {
    engineRef.current?.setFaction(faction);
  }, [faction]);

  useEffect(() => {
    engineRef.current?.setSpin(spin);
  }, [spin]);

  // Drive the viewport: an imported model if one is staged for this slot, else
  // the in-game default. Re-runs when the slot or its staged file changes.
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    setError(null);
    if (activeFile) {
      void eng.showImported(activeFile, active).catch(() => { /* state already set to error */ });
    } else {
      eng.showDefault(active);
    }
    // active is derived from selected; activeFile from staged+selected.
  }, [active, activeFile]);

  const handleFiles = useCallback(
    (list: FileList | null) => {
      const file = list?.[0];
      if (!file) return;
      try {
        validateModelFile(file);
      } catch (err) {
        setError(err instanceof ModelValidationError ? err.message : "That file couldn't be read.");
        return;
      }
      setError(null);
      setStaged((prev) => new Map(prev).set(active.key, file));
      setDirtyKeys((prev) => new Set(prev).add(active.key));
    },
    [active.key],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  const save = useCallback(async () => {
    if (!activeFile) return;
    setBusy(true);
    setError(null);
    try {
      await saveOverride(active.key, activeFile);
      setSavedKeys((prev) => new Set(prev).add(active.key));
      setDirtyKeys((prev) => {
        const next = new Set(prev);
        next.delete(active.key);
        return next;
      });
    } catch {
      setError("Could not save this model on your device.");
    } finally {
      setBusy(false);
    }
  }, [active.key, activeFile]);

  const reset = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteOverride(active.key);
    } catch {
      /* best-effort */
    }
    setSavedKeys((prev) => {
      const next = new Set(prev);
      next.delete(active.key);
      return next;
    });
    setStaged((prev) => {
      const next = new Map(prev);
      next.delete(active.key);
      return next;
    });
    setDirtyKeys((prev) => {
      const next = new Set(prev);
      next.delete(active.key);
      return next;
    });
    setBusy(false);
  }, [active.key]);

  const stats = state?.status === "ready" ? state.stats : null;

  return (
    <div className="fixed inset-0 flex bg-[#05070f] text-white">
      {/* Sidebar — ship by ship */}
      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-white/10 bg-[#070a14]">
        <header className="border-b border-white/10 px-4 py-3">
          <button
            type="button"
            onClick={() => { window.location.href = window.location.pathname; }}
            className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/60 transition hover:text-[#00d4ff]"
          >
            <span aria-hidden>←</span> Back to game
          </button>
          <div className="text-[10px] uppercase tracking-[0.4em] text-[#00d4ff]/70">Carrier</div>
          <div className="mt-1 text-lg font-bold uppercase tracking-[0.2em] text-[#00d4ff]">Shipyard</div>
          <p className="mt-1 text-[11px] leading-relaxed text-white/40">
            Import your own ship models, one at a time. Saved on this device.
          </p>
        </header>

        {groups.map(([group, groupSlots]) => (
          <div key={group} className="px-2 py-2">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-white/40">
              {group}
            </div>
            {groupSlots.map((s) => {
              const idx = slots.indexOf(s);
              const isActive = idx === selected;
              const isDirty = dirtyKeys.has(s.key);
              const isSaved = !isDirty && savedKeys.has(s.key);
              return (
                <button
                  key={s.key}
                  onClick={() => setSelected(idx)}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition ${
                    isActive
                      ? "bg-[#00d4ff]/15 text-[#00d4ff]"
                      : "text-white/70 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <span className="truncate">{s.label}</span>
                  {isSaved && (
                    <span className="flex-none rounded-sm bg-emerald-400/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-300">
                      Saved
                    </span>
                  )}
                  {isDirty && (
                    <span className="flex-none rounded-sm bg-amber-400/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-300">
                      New
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </aside>

      {/* Viewport */}
      <main
        className="relative flex-1"
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div ref={containerRef} className="absolute inset-0" />

        {fatal && (
          <div className="absolute inset-0 grid place-items-center p-8 text-center">
            <div className="max-w-md rounded-lg border border-red-500/40 bg-red-950/30 px-6 py-5 text-sm text-red-200">
              {fatal}
            </div>
          </div>
        )}

        {/* Drag-over highlight */}
        {dragOver && (
          <div className="pointer-events-none absolute inset-4 grid place-items-center rounded-2xl border-2 border-dashed border-[#00d4ff]/70 bg-[#00d4ff]/10 text-sm font-semibold uppercase tracking-[0.25em] text-[#00d4ff]">
            Drop .glb / .gltf to preview
          </div>
        )}

        {/* Top-left: active slot + measured stats */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-4">
          <div className="pointer-events-auto rounded-md border border-white/10 bg-black/50 px-3 py-2 text-xs backdrop-blur">
            <div className="font-semibold text-white">
              {active.label}{" "}
              <span className="text-white/40">
                · {activeFile ? "imported" : "default"}
              </span>
            </div>
            <div className="mt-1 font-mono text-[11px] text-white/50">{active.key}</div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-white/50">
              <span>fit {Math.round(active.fit)}m</span>
              {active.kind !== "station" && (
                <span>{active.yaw === undefined ? "auto-orient" : `yaw ${(active.yaw / Math.PI).toFixed(2)}π`}</span>
              )}
              {active.kind === "station" && (
                <span>{active.catalogIds.length} part{active.catalogIds.length > 1 ? "s" : ""}</span>
              )}
              {stats && <span>{stats.triangles.toLocaleString()} tris</span>}
            </div>
          </div>

          <div className="pointer-events-auto flex flex-col items-end gap-2">
            <label className="flex items-center gap-2 rounded-md border border-white/10 bg-black/50 px-3 py-2 text-xs backdrop-blur">
              <span className="text-white/60">Tint</span>
              <select
                value={faction}
                onChange={(e) => setFaction(e.target.value as FactionId)}
                className="rounded bg-white/10 px-2 py-1 text-white outline-none"
              >
                {FACTION_ORDER.map((f) => (
                  <option key={f} value={f} className="bg-[#070a14]">
                    {FACTIONS[f].name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setSpin((v) => !v)}
                className="rounded-md border border-white/10 bg-black/50 px-3 py-2 text-xs text-white/80 backdrop-blur hover:bg-white/10"
              >
                {spin ? "Pause spin" : "Spin"}
              </button>
              <button
                onClick={() => engineRef.current?.resetView()}
                className="rounded-md border border-white/10 bg-black/50 px-3 py-2 text-xs text-white/80 backdrop-blur hover:bg-white/10"
              >
                Reset view
              </button>
            </div>
          </div>
        </div>

        {/* Bottom: import controls + status */}
        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 p-4">
          <div className="flex flex-col gap-2">
            <div className="pointer-events-none rounded-md border border-white/10 bg-black/40 px-3 py-1.5 text-[11px] text-white/40 backdrop-blur">
              Drag to orbit · scroll to zoom · blue axis = nose (local +Z) · drop a file anywhere
            </div>
            {error && (
              <div className="rounded-md border border-red-500/40 bg-red-950/40 px-3 py-1.5 text-[11px] text-red-300 backdrop-blur">
                {error}
              </div>
            )}
            {state?.status === "loading" && (
              <div className="rounded-md border border-white/10 bg-black/40 px-3 py-1.5 text-[11px] text-white/50 backdrop-blur">
                Loading…
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
              className="hidden"
              onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="rounded-md border-2 border-[#00d4ff] bg-[#00d4ff]/15 px-4 py-2 text-xs font-bold uppercase tracking-[0.2em] text-[#00d4ff] hover:bg-[#00d4ff]/25"
            >
              Import model
            </button>
            <button
              onClick={save}
              disabled={!activeFile || busy || !dirtyKeys.has(active.key)}
              className="rounded-md border border-emerald-400/60 bg-emerald-400/15 px-4 py-2 text-xs font-bold uppercase tracking-[0.2em] text-emerald-200 hover:bg-emerald-400/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {dirtyKeys.has(active.key)
                ? savedKeys.has(active.key)
                  ? "Update ship"
                  : "Save to ship"
                : "Saved"}
            </button>
            <button
              onClick={reset}
              disabled={busy || (!activeFile && !savedKeys.has(active.key))}
              className="rounded-md border border-white/15 bg-black/50 px-4 py-2 text-xs font-bold uppercase tracking-[0.2em] text-white/70 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Reset
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
