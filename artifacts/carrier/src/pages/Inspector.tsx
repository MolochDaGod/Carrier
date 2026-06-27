/**
 * Carrier — dev-only model inspector page.
 *
 * Lists every fleet hull, fighter and faction station asset and renders the
 * selected one live on a turntable with a grid + axes for orientation reference,
 * bypassing the Puter gate entirely. Reachable only in development via
 * `?inspect` (wired in `main.tsx` behind `import.meta.env.DEV`), so it never
 * ships to production.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FACTIONS,
  FACTION_ORDER,
  MOTHER_SHIP,
  fleetRoleDef,
  type FactionId,
} from "@workspace/carrier-net";
import { ModelInspector, type InspectItem, type InspectorState } from "@/game/ModelInspector";
import { DEPLOY_ROLES, FACTION_STATIONS, FIGHTER_GLB, fleetModelFor } from "@/game/factionAssets";
import { SHIP_FIT } from "@/game/constants";

const FLEET_ORDER = DEPLOY_ROLES;

/** Build the inspectable asset list; fleet hulls reflect `faction` (deploy set). */
function buildItems(faction: FactionId): InspectItem[] {
  const items: InspectItem[] = [];

  // Player + enemy fighters (entry hull). Fit = SHIP_FIT, same as makeFighter.
  for (const key of ["player", "enemy"] as const) {
    const model = FIGHTER_GLB[key];
    items.push({
      kind: "fighter",
      id: model.id,
      label: key === "player" ? "Player Fighter" : "Enemy Fighter",
      group: "Fighters",
      fit: SHIP_FIT,
      model,
    });
  }

  // Deployable fleet hulls for this faction. Fit = role scale, same as makeFleetUnit.
  for (const role of FLEET_ORDER) {
    const model = fleetModelFor(faction, role);
    const def = fleetRoleDef(role);
    items.push({
      kind: "fleet",
      id: model.id,
      label: `${role[0].toUpperCase()}${role.slice(1)}`,
      group: "Fleet Hulls",
      fit: def ? def.scale : 8,
      model,
    });
  }

  // Faction mothership stations. Fit = SHIP_FIT * scaleFactor * fitMul, same as
  // requestStationModel.
  for (const faction of FACTION_ORDER) {
    const def = FACTION_STATIONS[faction];
    items.push({
      kind: "station",
      id: def.parts.join(" + "),
      label: FACTIONS[faction].name,
      group: "Faction Stations",
      fit: SHIP_FIT * MOTHER_SHIP.scaleFactor * def.fitMul,
      faction,
      def,
    });
  }

  return items;
}

/**
 * The lineup for one faction, in class order: player fighter → all six fleet
 * hulls (miner … dreadnought) → that faction's station. Picks straight out of
 * `buildItems()` so the fits match the per-asset single view exactly.
 */
function lineupFor(items: InspectItem[], faction: FactionId): InspectItem[] {
  const fighter = items.find((it) => it.kind === "fighter" && it.label === "Player Fighter");
  const fleet = FLEET_ORDER.map((role) =>
    items.find((it) => it.kind === "fleet" && it.label.toLowerCase() === role),
  );
  const station = items.find((it) => it.kind === "station" && it.faction === faction);
  return [fighter, ...fleet, station].filter((x): x is InspectItem => !!x);
}

export function Inspector() {
  const [faction, setFaction] = useState<FactionId>("scavengers");
  const items = useMemo(() => buildItems(faction), [faction]);
  const groups = useMemo(() => {
    const map = new Map<string, InspectItem[]>();
    for (const it of items) {
      const arr = map.get(it.group) ?? [];
      arr.push(it);
      map.set(it.group, arr);
    }
    return [...map.entries()];
  }, [items]);

  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ModelInspector | null>(null);

  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<"single" | "lineup">("single");
  const [spin, setSpin] = useState(true);
  const [state, setState] = useState<InspectorState | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const lineup = useMemo(() => lineupFor(items, faction), [items, faction]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let engine: ModelInspector | null = null;
    try {
      engine = new ModelInspector(container, setState);
      engineRef.current = engine;
    } catch (err) {
      // Most likely no WebGL context (e.g. a headless browser). Degrade to a
      // message rather than crashing the whole page.
      console.error("[carrier-inspector] engine failed to start", err);
      setFatal("Could not create a WebGL context. Open this page in a real browser with hardware acceleration.");
      return;
    }
    return () => {
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  // Keep the engine's tint in sync first, then re-issue the right view below.
  useEffect(() => {
    engineRef.current?.setFaction(faction);
  }, [faction]);

  // Drive the viewport: single asset on a turntable, or the whole faction
  // lineup at true relative size. Re-runs on faction so the tint/station refresh.
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    if (mode === "lineup") eng.showLineup(lineup);
    else eng.show(items[selected]);
  }, [mode, items, selected, faction, lineup]);

  useEffect(() => {
    engineRef.current?.setSpin(spin);
  }, [spin]);

  const active = items[selected];

  return (
    <div className="fixed inset-0 flex bg-[#05070f] text-white">
      {/* Sidebar */}
      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-white/10 bg-[#070a14]">
        <header className="border-b border-white/10 px-4 py-3">
          <div className="text-[10px] uppercase tracking-[0.4em] text-[#00d4ff]/70">Carrier · Dev</div>
          <div className="mt-1 text-lg font-bold uppercase tracking-[0.2em] text-[#00d4ff]">Model Inspector</div>
          <p className="mt-1 text-[11px] leading-relaxed text-white/40">
            Live render of every ship + station asset. No auth gate.
          </p>
        </header>

        {/* View mode: single asset vs. full faction lineup at true scale. */}
        <div className="px-3 py-2">
          <button
            onClick={() => setMode((m) => (m === "lineup" ? "single" : "lineup"))}
            className={`block w-full rounded-md px-3 py-2 text-left text-sm font-semibold transition ${
              mode === "lineup"
                ? "bg-[#00d4ff]/20 text-[#00d4ff] ring-1 ring-[#00d4ff]/40"
                : "bg-white/5 text-white/80 hover:bg-white/10 hover:text-white"
            }`}
          >
            ⛶ Fleet Lineup
            <span className="mt-0.5 block text-[10px] font-normal text-white/40">
              All hulls + station at relative scale
            </span>
          </button>
        </div>

        {groups.map(([group, groupItems]) => (
          <div key={group} className="px-2 py-2">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-white/40">
              {group}
            </div>
            {groupItems.map((it) => {
              const idx = items.indexOf(it);
              const isActive = mode === "single" && idx === selected;
              return (
                <button
                  key={it.label}
                  onClick={() => { setSelected(idx); setMode("single"); }}
                  className={`block w-full rounded-md px-3 py-2 text-left text-sm transition ${
                    isActive
                      ? "bg-[#00d4ff]/15 text-[#00d4ff]"
                      : "text-white/70 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  {it.label}
                </button>
              );
            })}
          </div>
        ))}
      </aside>

      {/* Viewport */}
      <main className="relative flex-1">
        <div ref={containerRef} className="absolute inset-0" />

        {fatal && (
          <div className="absolute inset-0 grid place-items-center p-8 text-center">
            <div className="max-w-md rounded-lg border border-red-500/40 bg-red-950/30 px-6 py-5 text-sm text-red-200">
              {fatal}
            </div>
          </div>
        )}

        {/* Top controls */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-4">
          <div className="pointer-events-auto rounded-md border border-white/10 bg-black/50 px-3 py-2 text-xs backdrop-blur">
            {mode === "lineup" ? (
              <>
                <div className="font-semibold text-white">{FACTIONS[faction].name} · Fleet Lineup</div>
                <div className="mt-1 text-[11px] text-white/50">
                  {lineup.length} hulls at true relative scale
                </div>
                <div className="mt-1 text-[11px] leading-relaxed text-white/40">
                  Fighter · Miner · Scout · Corsair · Frigate · Cruiser · Dreadnought · Station
                </div>
              </>
            ) : (
              <>
                <div className="font-semibold text-white">{active.label}</div>
                <div className="mt-1 font-mono text-[11px] text-white/50">{active.id}</div>
                <div className="mt-1 flex gap-3 text-[11px] text-white/50">
                  <span>fit {Math.round(active.fit)}m</span>
                  {active.kind !== "station" && (
                    <span>{active.model.yaw === undefined ? "auto-orient" : `yaw ${(active.model.yaw / Math.PI).toFixed(2)}π`}</span>
                  )}
                  {active.kind === "station" && <span>{active.def.parts.length} part{active.def.parts.length > 1 ? "s" : ""}</span>}
                </div>
              </>
            )}
          </div>

          <div className="pointer-events-auto flex flex-col items-end gap-2">
            {(mode === "lineup" || active.kind !== "station") && (
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
            )}
            <div className="flex gap-2">
              <button
                onClick={() => setSpin((s) => !s)}
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

        {/* Bottom hint + status */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between p-4 text-[11px] text-white/40">
          <div className="rounded-md border border-white/10 bg-black/40 px-3 py-1.5 backdrop-blur">
            {mode === "lineup"
              ? "Drag to orbit · scroll to zoom · hulls shown at true relative size"
              : "Drag to orbit · scroll to zoom · blue axis = nose (local +Z)"}
          </div>
          {state?.status === "loading" && (
            <div className="rounded-md border border-white/10 bg-black/40 px-3 py-1.5 backdrop-blur">Loading…</div>
          )}
          {state?.status === "error" && (
            <div className="rounded-md border border-red-500/40 bg-red-950/40 px-3 py-1.5 text-red-300 backdrop-blur">
              Failed to load: {state.message}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
