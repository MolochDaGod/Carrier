/**
 * MothershipInspectorView — React mount for the DEV-ONLY ship bay.
 *
 * Rendered straight from App.tsx when the hidden `?inspect` URL flag is present,
 * BEFORE the Puter auth gate, so hull sizing/silhouettes can be confirmed by eye
 * without an account or a live multiplayer session. Not exposed to normal
 * players.
 *
 * Beyond the live-render line-up it drives a selection UI: pick a ship from the
 * grouped rail (or click it in 3D) to glide the camera onto it and read its
 * dossier — tier/role, faction tint, measured scale, stat bars + perks/flaws for
 * motherships, and the rated combat stats for the fleet anchors.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MothershipInspector,
  type InspectorEntry,
  type InspectorKind,
} from "./MothershipInspector";
import { STAT_META } from "./motherships";

const KIND_GROUPS: { kind: InspectorKind; title: string }[] = [
  { kind: "fighter", title: "Fighter" },
  { kind: "fleet", title: "Fleet (scale anchors)" },
  { kind: "mothership", title: "Motherships" },
  { kind: "station", title: "Faction stations" },
];

export function MothershipInspectorView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<MothershipInspector | null>(null);
  const [entries, setEntries] = useState<InspectorEntry[]>([]);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const inspector = new MothershipInspector(
      container,
      (next) => setEntries(next),
      (index) => setSelected(index),
    );
    inspectorRef.current = inspector;
    inspector.start();
    void inspector.init();
    return () => {
      inspector.dispose();
      inspectorRef.current = null;
    };
  }, []);

  // Auto-select the first mothership once the line-up has loaded.
  useEffect(() => {
    if (selected !== null || entries.length === 0) return;
    const first = entries.find((e) => e.kind === "mothership") ?? entries[0];
    setSelected(first.index);
  }, [entries, selected]);

  // Drive the 3D camera focus from the selected index (list OR 3D click).
  useEffect(() => {
    if (selected !== null) inspectorRef.current?.focus(selected);
  }, [selected]);

  const grouped = useMemo(
    () =>
      KIND_GROUPS.map((g) => ({
        ...g,
        items: entries.filter((e) => e.kind === g.kind),
      })).filter((g) => g.items.length > 0),
    [entries],
  );

  const active = selected !== null ? entries.find((e) => e.index === selected) : undefined;

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#05070f] text-white">
      <div ref={containerRef} className="absolute inset-0 cursor-grab" />

      {/* Dev banner — makes it unmistakable this is a non-shipping view. */}
      <div className="pointer-events-none absolute left-4 top-4 flex flex-col gap-2">
        <div className="inline-flex w-fit items-center gap-2 rounded-md border border-amber-400/60 bg-amber-400/15 px-3 py-1 text-xs font-bold uppercase tracking-[0.25em] text-amber-300">
          Dev · Ship Bay
        </div>
        <p className="max-w-xs text-[11px] leading-relaxed text-white/55">
          True relative scale via the live render path. Click a ship or pick one
          from the list to inspect it · drag to orbit · scroll to zoom. Remove{" "}
          <code className="text-white/80">?inspect</code> from the URL to return
          to the game.
        </p>
      </div>

      {/* Left rail: every placed hull, grouped, click to select. */}
      {grouped.length > 0 && (
        <div className="absolute bottom-4 left-4 top-28 flex w-60 flex-col overflow-y-auto rounded-md border border-white/10 bg-black/45 p-3 backdrop-blur">
          {grouped.map((group) => (
            <div key={group.kind} className="mb-3 last:mb-0">
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.25em] text-white/45">
                {group.title}
              </div>
              <ul className="flex flex-col gap-1">
                {group.items.map((e) => {
                  const isActive = e.index === selected;
                  return (
                    <li key={e.index}>
                      <button
                        onClick={() => setSelected(e.index)}
                        className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition ${
                          isActive
                            ? "bg-white/15 text-white"
                            : "text-white/70 hover:bg-white/5"
                        }`}
                      >
                        <span
                          className="h-2.5 w-2.5 flex-none rounded-full"
                          style={{ backgroundColor: e.color }}
                        />
                        <span className="flex-1 truncate">{e.label}</span>
                        <span className="tabular-nums text-white/45">
                          {Math.round(e.size)} m
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* Right dossier: details for the selected hull. */}
      {active && (
        <div className="absolute bottom-4 right-4 top-4 w-80 overflow-y-auto rounded-md border border-white/10 bg-black/55 p-4 backdrop-blur">
          <Dossier entry={active} />
        </div>
      )}
    </div>
  );
}

function Dossier({ entry }: { entry: InspectorEntry }) {
  const { ship, fleet } = entry;
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="flex items-center gap-2">
          <span
            className="h-3 w-3 flex-none rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <h2 className="text-lg font-bold tracking-wide">{entry.label}</h2>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] uppercase tracking-[0.15em] text-white/50">
          {ship && <span>Tier {ship.tier}</span>}
          {ship && <span className="text-white/30">·</span>}
          <span>{ship ? ship.role : fleet ? "Fleet unit" : entry.kind}</span>
          <span className="text-white/30">·</span>
          <span>{Math.round(entry.size)} m</span>
        </div>
        {ship?.tagline && (
          <p className="mt-1 text-xs italic text-white/55">“{ship.tagline}”</p>
        )}
      </div>

      {/* Mothership headline stat bars (0..100). */}
      {ship && (
        <div className="flex flex-col gap-1.5">
          {STAT_META.map((s) => {
            const v = ship.stats[s.key];
            return (
              <div key={s.key} className="flex items-center gap-2 text-[11px]">
                <span className="w-16 flex-none text-white/55">{s.label}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${v}%`, backgroundColor: s.color }}
                  />
                </span>
                <span className="w-7 flex-none text-right tabular-nums text-white/45">
                  {v}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Fleet-role rated stats. */}
      {fleet && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
          <Stat label="Hull HP" value={fleet.maxHp} />
          <Stat label="Shield" value={fleet.maxShield} />
          <Stat label="Cost" value={fleet.cost} />
          <Stat label="Per-player cap" value={fleet.cap} />
          <Stat label="Zone radius" value={`${fleet.zoneR} m`} />
          <Stat label="Speed ×" value={fleet.speedMult} />
          <Stat label="Engage" value={`${fleet.engageRange} m`} />
          <Stat label="Armed" value={fleet.armed ? "Yes" : "No"} />
        </dl>
      )}

      {ship?.special && (
        <div className="rounded border border-white/10 bg-white/5 p-2 text-[11px] leading-relaxed text-white/75">
          <span className="font-bold text-white/90">Signature — </span>
          {ship.special}
        </div>
      )}

      {ship && ship.perks.length > 0 && (
        <Bullets title="Perks" items={ship.perks} dot="#5dff9b" />
      )}
      {ship && ship.flaws.length > 0 && (
        <Bullets title="Flaws" items={ship.flaws} dot="#ff5d5d" />
      )}

      {ship?.description && (
        <p className="text-[11px] leading-relaxed text-white/55">{ship.description}</p>
      )}

      {!ship && !fleet && (
        <p className="text-[11px] leading-relaxed text-white/55">
          Shown at true relative scale as a sizing anchor. No design dossier for
          this hull yet.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col">
      <dt className="text-white/45">{label}</dt>
      <dd className="tabular-nums text-white/85">{value}</dd>
    </div>
  );
}

function Bullets({ title, items, dot }: { title: string; items: string[]; dot: string }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.25em] text-white/45">
        {title}
      </div>
      <ul className="flex flex-col gap-1">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2 text-[11px] text-white/70">
            <span
              className="mt-1 h-1.5 w-1.5 flex-none rounded-full"
              style={{ backgroundColor: dot }}
            />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
