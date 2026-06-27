/**
 * MothershipSelect — the Carrier hangar / fleet screen.
 *
 * Two-level left rail drill-down:
 *   1. "factions" view  → the five lore factions.  Picking one tints the screen
 *      and drills into that faction's fleet.
 *   2. "ships" view      → the six hulls of the chosen faction (faction-tinted),
 *      with a back row to return to the faction list.
 *
 * Centre: a live WebGL showcase (MothershipShowcase) of the active hull, rim-lit
 * in the faction colour.  Right: faction identity (factions view) or the full
 * hull dossier — stats, special, perks, flaws, turrets (ships view).  Footer:
 * callsign + Launch (ships view only).
 */
import { useEffect, useRef, useState } from "react";
import { FACTIONS, FACTION_ORDER, type FactionId } from "@workspace/carrier-net";
import { FactionEmblem } from "../components/FactionEmblem";
import { HangarAtmosphere } from "../components/HangarAtmosphere";
import { MothershipShowcase, type ShowcaseSlot } from "./MothershipShowcase";
import { FleetRosterPanel } from "./FleetRosterPanel";
import {
  MOTHERSHIPS,
  FACTION_ACCENT,
  TURRET_ROLE_COLOR,
  STAT_META,
  type MothershipDef,
  type ShipStats,
} from "./motherships";

/**
 * The player's current build tier. Starts at 1 (only Tier-1 hulls buildable);
 * later phases raise this as the mothership is upgraded with crystals.
 */
const PLAYER_TIER = 1;

type NavView = "factions" | "ships";

export function MothershipSelect({
  name,
  setName,
  shipType,
  setShipType,
  faction,
  setFaction,
  onLaunch,
  onBack,
}: {
  name: string;
  setName: (v: string) => void;
  shipType: number;
  setShipType: (v: number) => void;
  faction: FactionId;
  setFaction: (v: FactionId) => void;
  onLaunch: () => void;
  onBack: () => void;
}) {
  const factionDef = FACTIONS[faction] ?? FACTIONS[FACTION_ORDER[0]];
  const accent = FACTION_ACCENT[faction] ?? factionDef.color;
  const canvasRef = useRef<HTMLDivElement>(null);
  const showcaseRef = useRef<MothershipShowcase | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingSlotRef = useRef<ShowcaseSlot | null>(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<NavView>("factions");
  const [reviewing, setReviewing] = useState(false);
  const [cogOpen, setCogOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Bumped after any override change so the cog menu re-reads `hasOverride`.
  const [overrideTick, setOverrideTick] = useState(0);

  const def = MOTHERSHIPS[shipType] ?? MOTHERSHIPS[0];
  const locked = def.tier > PLAYER_TIER;

  // Latest shipType for the auto-review interval (which only mounts once).
  const shipTypeRef = useRef(shipType);
  shipTypeRef.current = shipType;

  // Create the showcase engine once.
  useEffect(() => {
    const container = canvasRef.current;
    if (!container) return;
    let cancelled = false;
    const showcase = new MothershipShowcase(container);
    showcaseRef.current = showcase;
    showcase.start();
    showcase
      .init()
      .then(async () => {
        if (cancelled) return;
        setReady(true);
        showcase.select(
          MOTHERSHIPS[shipTypeRef.current] ?? MOTHERSHIPS[0],
          FACTION_ACCENT[faction] ?? factionDef.color,
        );
        // Reapply any custom models saved on a previous visit.
        await showcase.loadPersistedOverrides();
        if (!cancelled) setOverrideTick((t) => t + 1);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
      showcase.dispose();
      showcaseRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap the displayed hull when the hull OR the faction tint changes.
  useEffect(() => {
    if (ready) showcaseRef.current?.select(def, accent);
  }, [ready, def, accent]);

  // Review mode: auto-advance through all six hulls so the player can cycle the
  // whole roster hands-free; any manual pick keeps the latest in shipTypeRef.
  useEffect(() => {
    if (!reviewing) return;
    const t = setInterval(() => {
      const n = MOTHERSHIPS.length;
      setShipType((shipTypeRef.current + 1) % n);
    }, 3200);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewing]);

  const cycle = (dir: number) => {
    const n = MOTHERSHIPS.length;
    setShipType((shipType + dir + n) % n);
  };

  const openUpload = (slot: ShowcaseSlot) => {
    pendingSlotRef.current = slot;
    setCogOpen(false);
    fileInputRef.current?.click();
  };

  const onUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const slot = pendingSlotRef.current;
    e.target.value = ""; // allow re-selecting the same file later
    if (!file || !slot || !showcaseRef.current) return;
    setUploading(true);
    setUploadError(null);
    try {
      await showcaseRef.current.replaceSlot(slot, file);
      setOverrideTick((t) => t + 1);
    } catch (err) {
      // Validation / parse failure — show the reason instead of failing silently.
      setUploadError(err instanceof Error ? err.message : "Couldn't load that model.");
    } finally {
      setUploading(false);
    }
  };

  const resetSlot = async (slot: ShowcaseSlot) => {
    if (!showcaseRef.current) return;
    setUploadError(null);
    await showcaseRef.current.resetSlot(slot);
    setOverrideTick((t) => t + 1);
  };

  const pickFaction = (id: FactionId) => {
    setFaction(id);
    // Picking a faction only re-tints the centre showcase + refreshes the right
    // dossier; it stays on the faction list (no tab switch). The right-side
    // "View Fleet →" button is what advances to the ships view. Keep the
    // selection on a buildable (Tier-1) hull so the fleet never opens on a
    // locked/stale selection with Launch already disabled.
    if (def.tier > PLAYER_TIER) {
      const firstUnlocked = MOTHERSHIPS.find((m) => m.tier <= PLAYER_TIER);
      if (firstUnlocked) setShipType(firstUnlocked.id);
    }
  };

  return (
    <div className="fixed inset-0 flex flex-col bg-[#04060f] text-white">
      {/* Inside-the-station viewport: looping feed + space particle follower */}
      <HangarAtmosphere color={factionDef.color} />

      {/* Header */}
      <header className="relative z-10 flex items-center justify-between border-b border-[#0e1b34] bg-[#04060f]/40 px-8 py-4 backdrop-blur-sm">
        <div className="flex items-center gap-5">
          <button
            onClick={onBack}
            className="rounded-md border border-white/15 px-3 py-1.5 text-[11px] uppercase tracking-widest text-white/55 transition-colors hover:border-white/35 hover:text-white"
          >
            ← Title
          </button>
          <div>
            <div className="text-[10px] uppercase tracking-[0.45em] text-[#00d4ff]/70">
              Online space combat
            </div>
            <h1 className="text-2xl font-bold uppercase tracking-[0.3em] text-[#00d4ff] drop-shadow-[0_0_18px_rgba(0,212,255,0.45)]">
              Carrier
            </h1>
          </div>
        </div>

        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest">
          <span className="text-white/35">Hangar Bay</span>
          <span className="text-white/20">/</span>
          <button
            onClick={() => setView("factions")}
            className="transition-colors hover:opacity-80"
            style={{ color: view === "factions" ? factionDef.color : "rgba(255,255,255,0.4)" }}
          >
            {factionDef.name}
          </button>
          {view === "ships" && (
            <>
              <span className="text-white/20">/</span>
              <span style={{ color: def.accent }}>{def.name}</span>
            </>
          )}
        </div>
      </header>

      <div className="relative z-10 flex min-h-0 flex-1">
        {/* Left rail: faction list OR ship list */}
        <nav className="flex w-64 flex-col border-r border-[#0e1b34] bg-[#060a16]/70 backdrop-blur-sm">
          {view === "factions" ? (
            <FactionList faction={faction} onPick={pickFaction} />
          ) : (
            <ShipList
              faction={factionDef}
              shipType={shipType}
              setShipType={setShipType}
              onBack={() => setView("factions")}
            />
          )}
        </nav>

        {/* Centre: live WebGL showcase */}
        <div className="relative min-w-0 flex-1">
          <div ref={canvasRef} className="absolute inset-0" />
          {/* Faction-tinted wash */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background: `radial-gradient(ellipse at 50% 40%, ${factionDef.color}14, transparent 60%)`,
            }}
          />
          {/* Faction insignia flanking the hull (hangar-bay crest) */}
          <div className="pointer-events-none absolute inset-y-0 left-6 hidden flex-col justify-center md:flex">
            <FactionEmblem faction={faction} size={88} />
          </div>
          <div className="pointer-events-none absolute right-6 top-6 flex items-center gap-3">
            <span className="text-right text-[10px] uppercase tracking-[0.3em] text-white/45">
              {factionDef.name}
            </span>
            <FactionEmblem faction={faction} size={56} active />
          </div>
          {!ready && (
            <div className="absolute inset-0 grid place-items-center text-xs uppercase tracking-[0.4em] text-white/40">
              Spinning up reactor…
            </div>
          )}

          {/* Review controls — cycle/auto-cycle through all six hulls */}
          <button
            onClick={() => cycle(-1)}
            aria-label="Previous hull"
            className="absolute left-3 top-1/2 z-10 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-white/15 bg-black/40 text-xl text-white/70 backdrop-blur-sm transition-colors hover:border-white/40 hover:text-white"
          >
            ‹
          </button>
          <button
            onClick={() => cycle(1)}
            aria-label="Next hull"
            className="absolute right-3 top-1/2 z-10 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-white/15 bg-black/40 text-xl text-white/70 backdrop-blur-sm transition-colors hover:border-white/40 hover:text-white"
          >
            ›
          </button>
          <div className="absolute left-1/2 top-4 z-10 flex -translate-x-1/2 items-center gap-3">
            <button
              onClick={() => setReviewing((v) => !v)}
              className="rounded-full border px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[0.3em] backdrop-blur-sm transition-colors"
              style={{
                borderColor: reviewing ? accent : "rgba(255,255,255,0.18)",
                background: reviewing ? `${accent}22` : "rgba(0,0,0,0.35)",
                color: reviewing ? accent : "rgba(255,255,255,0.6)",
              }}
            >
              {reviewing ? "■ Reviewing All" : "▶ Review All"}
            </button>
            <div className="flex items-center gap-1">
              {MOTHERSHIPS.map((m) => (
                <span
                  key={m.id}
                  className="h-1.5 w-1.5 rounded-full transition-all"
                  style={{
                    background: m.id === shipType ? accent : "rgba(255,255,255,0.25)",
                    boxShadow: m.id === shipType ? `0 0 8px ${accent}` : "none",
                  }}
                />
              ))}
            </div>
          </div>

          {/* Per-asset cog: upload a replacement GLB and live-swap it */}
          <div className="absolute bottom-5 right-5 z-20">
            {cogOpen && (
              <div className="absolute bottom-12 right-0 w-56 overflow-hidden rounded-md border border-white/15 bg-[#0a1322]/95 backdrop-blur-sm">
                <div className="border-b border-white/10 px-3 py-2 text-[9px] uppercase tracking-[0.3em] text-white/40">
                  Replace Asset
                </div>
                {(
                  [
                    ["hull", "Hull"],
                    ["platform", "Platform"],
                    ["turret-gun", "Turret · Gun"],
                    ["turret-cannon", "Turret · Cannon"],
                  ] as [ShowcaseSlot, string][]
                ).map(([slot, label]) => {
                  const custom = showcaseRef.current?.hasOverride(slot) ?? false;
                  return (
                    <div
                      key={`${slot}-${overrideTick}`}
                      className="flex items-center transition-colors hover:bg-white/10"
                    >
                      <button
                        onClick={() => openUpload(slot)}
                        className="flex flex-1 items-center gap-2 px-3 py-2 text-left text-xs text-white/75"
                      >
                        <span>{label}</span>
                        {custom && (
                          <span className="rounded bg-[#00d4ff]/20 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-[#00d4ff]">
                            Custom
                          </span>
                        )}
                      </button>
                      {custom && (
                        <button
                          onClick={() => resetSlot(slot)}
                          title="Remove custom model — revert to default"
                          aria-label={`Reset ${label} to default`}
                          className="px-2.5 py-2 text-sm text-white/40 transition-colors hover:text-[#ff7a7a]"
                        >
                          ↺
                        </button>
                      )}
                    </div>
                  );
                })}
                {uploadError && (
                  <div className="border-t border-white/10 px-3 py-2 text-[10px] leading-snug text-[#ff7a7a]">
                    {uploadError}
                  </div>
                )}
              </div>
            )}
            <button
              onClick={() => setCogOpen((v) => !v)}
              disabled={!ready}
              aria-label="Replace a showcase asset with your own GLB"
              title="Upload a replacement GLB"
              className="grid h-10 w-10 place-items-center rounded-full border border-white/15 bg-black/45 text-lg text-white/70 backdrop-blur-sm transition-colors hover:border-white/40 hover:text-white disabled:opacity-40"
            >
              {uploading ? "…" : "⚙"}
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
            className="hidden"
            onChange={onUploadFile}
          />

          {/* Name overlay */}
          <div className="pointer-events-none absolute bottom-6 left-8">
            <div
              className="text-5xl font-bold uppercase tracking-[0.18em]"
              style={{ color: def.accent, textShadow: `0 0 24px ${def.accent}66` }}
            >
              {def.name}
            </div>
            <div className="mt-1 text-sm italic text-white/50">{def.tagline}</div>
          </div>
        </div>

        {/* Right: faction identity OR hull dossier */}
        <aside className="flex w-[22rem] flex-col gap-5 overflow-y-auto border-l border-[#0e1b34] bg-[#060a16]/70 p-6 backdrop-blur-sm">
          {view === "factions" ? (
            <FactionDossier faction={factionDef} onEnter={() => setView("ships")} />
          ) : (
            <ShipDossier def={def} />
          )}
        </aside>
      </div>

      {/* Footer: callsign + launch (ships view) or a prompt (factions view) */}
      <footer className="relative z-10 flex items-center justify-between gap-4 border-t border-[#0e1b34] bg-[#060a16]/80 px-8 py-4 backdrop-blur-sm">
        {view === "ships" ? (
          <>
            <div className="flex items-center gap-3">
              <label className="text-[11px] uppercase tracking-widest text-white/40">
                Callsign
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={16}
                placeholder={def.name}
                className="w-56 rounded-md border border-white/15 bg-black/40 px-4 py-2 font-mono text-white outline-none focus:border-[#00d4ff]"
              />
            </div>
            <div className="flex items-center gap-4">
              {locked && (
                <span className="text-[11px] uppercase tracking-widest text-[#ff7a7a]/80">
                  🔒 {def.name} is Tier {def.tier} — unlock via mothership upgrades
                </span>
              )}
              <button
                onClick={onLaunch}
                disabled={locked}
                className="rounded-md border-2 px-10 py-2.5 text-sm font-bold uppercase tracking-[0.25em] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  borderColor: factionDef.color,
                  background: `${factionDef.color}1f`,
                  color: factionDef.color,
                }}
              >
                Launch {factionDef.name}
              </button>
            </div>
          </>
        ) : (
          <div className="flex w-full items-center justify-center text-[11px] uppercase tracking-[0.3em] text-white/35">
            Select a faction to view its fleet
          </div>
        )}
      </footer>
    </div>
  );
}

/* ── Left rail: factions ─────────────────────────────────────────────────── */

function FactionList({
  faction,
  onPick,
}: {
  faction: FactionId;
  onPick: (id: FactionId) => void;
}) {
  return (
    <div className="flex flex-col gap-1 p-3">
      <div className="px-2 pb-2 text-[10px] uppercase tracking-[0.35em] text-white/35">
        Choose Faction
      </div>
      {FACTION_ORDER.map((id) => {
        const f = FACTIONS[id];
        const active = id === faction;
        return (
          <button
            key={id}
            onClick={() => onPick(id)}
            className="group flex items-center gap-3 rounded-md border px-3 py-3 text-left transition-all"
            style={{
              borderColor: active ? f.color : "transparent",
              background: active ? `${f.color}14` : "transparent",
            }}
          >
            <FactionEmblem faction={id} size={40} active={active} />
            <span className="flex-1">
              <span
                className="block text-sm font-semibold tracking-wide"
                style={{ color: active ? f.color : "#cdd8ee" }}
              >
                {f.name}
              </span>
              <span className="block text-[10px] uppercase tracking-widest text-white/35">
                6 Hulls
              </span>
            </span>
            <span className="shrink-0 text-white/25 transition-transform group-hover:translate-x-0.5">
              →
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ── Left rail: ships of the chosen faction ──────────────────────────────── */

function ShipList({
  faction,
  shipType,
  setShipType,
  onBack,
}: {
  faction: { name: string; color: string };
  shipType: number;
  setShipType: (v: number) => void;
  onBack: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button
        onClick={onBack}
        className="flex items-center gap-2 border-b border-[#0e1b34] px-4 py-3 text-left transition-colors hover:bg-white/5"
      >
        <span className="text-white/45">←</span>
        <span
          className="text-xs font-semibold uppercase tracking-widest"
          style={{ color: faction.color }}
        >
          {faction.name}
        </span>
        <span className="ml-auto text-[10px] uppercase tracking-widest text-white/30">
          Fleet
        </span>
      </button>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3">
        {MOTHERSHIPS.map((m) => {
          const active = m.id === shipType;
          const mLocked = m.tier > PLAYER_TIER;
          return (
            <button
              key={m.id}
              onClick={() => setShipType(m.id)}
              className="group flex items-center gap-3 rounded-md border px-3 py-3 text-left transition-all"
              style={{
                borderColor: active ? m.accent : "transparent",
                background: active ? `${m.accent}14` : "transparent",
                opacity: mLocked && !active ? 0.55 : 1,
              }}
            >
              <span
                className="h-9 w-1.5 rounded-full transition-all"
                style={{
                  background: m.accent,
                  boxShadow: active ? `0 0 12px ${m.accent}` : "none",
                  opacity: active ? 1 : 0.4,
                }}
              />
              <span className="flex-1">
                <span
                  className="block text-sm font-semibold tracking-wide"
                  style={{ color: active ? m.accent : "#cdd8ee" }}
                >
                  {m.name}
                </span>
                <span className="block text-[10px] uppercase tracking-widest text-white/35">
                  {m.role}
                </span>
              </span>
              <span
                className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
                style={{
                  color: mLocked ? "#8a93a8" : m.accent,
                  background: mLocked ? "rgba(255,255,255,0.06)" : `${m.accent}1f`,
                }}
                title={mLocked ? `Tier ${m.tier} — unlock via mothership upgrades` : `Tier ${m.tier}`}
              >
                {mLocked ? `🔒 T${m.tier}` : `T${m.tier}`}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Right panel: faction identity ───────────────────────────────────────── */

function FactionDossier({
  faction,
  onEnter,
}: {
  faction: { id: FactionId; name: string; color: string; blurb: string };
  onEnter: () => void;
}) {
  return (
    <>
      <div>
        <div className="flex items-center gap-4">
          <FactionEmblem faction={faction.id} size={72} active />
          <h2
            className="text-2xl font-bold uppercase tracking-[0.18em]"
            style={{ color: faction.color }}
          >
            {faction.name}
          </h2>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-white/70">{faction.blurb}</p>
      </div>

      <div>
        <h3 className="mb-2 text-[11px] uppercase tracking-[0.3em] text-white/40">
          Deployable Fleet
        </h3>
        <FleetRosterPanel faction={faction.id} color={faction.color} />
      </div>

      <button
        onClick={onEnter}
        className="mt-1 rounded-md border-2 py-2.5 text-sm font-bold uppercase tracking-[0.25em] transition-colors"
        style={{
          borderColor: faction.color,
          background: `${faction.color}1f`,
          color: faction.color,
        }}
      >
        View Fleet →
      </button>
    </>
  );
}

/* ── Right panel: hull dossier ───────────────────────────────────────────── */

function ShipDossier({ def }: { def: MothershipDef }) {
  return (
    <>
      <p className="text-sm leading-relaxed text-white/70">{def.description}</p>

      <StatBlock stats={def.stats} />

      <div>
        <h3 className="mb-2 text-[11px] uppercase tracking-[0.3em] text-[#ffd23f]">
          Special
        </h3>
        <p className="text-sm leading-relaxed text-white/75">{def.special}</p>
      </div>

      <Section title="Perks" color="#5dff9b">
        {def.perks.map((p, i) => (
          <li key={i} className="flex gap-2 text-sm text-white/75">
            <span className="text-[#5dff9b]">+</span>
            <span>{p}</span>
          </li>
        ))}
      </Section>

      <Section title="Flaws" color="#ff7a7a">
        {def.flaws.map((f, i) => (
          <li key={i} className="flex gap-2 text-sm text-white/75">
            <span className="text-[#ff7a7a]">−</span>
            <span>{f}</span>
          </li>
        ))}
      </Section>

      <div>
        <h3 className="mb-2 text-[11px] uppercase tracking-[0.3em] text-white/40">
          Turret Systems
        </h3>
        <div className="flex flex-col gap-2">
          {def.turrets.map((t, i) => (
            <div
              key={i}
              className="flex items-center justify-between rounded-md border border-white/10 bg-black/30 px-3 py-2"
            >
              <span className="text-sm text-white/80">{t.label}</span>
              <span
                className="rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest"
                style={{
                  color: TURRET_ROLE_COLOR[t.role],
                  background: `${TURRET_ROLE_COLOR[t.role]}1f`,
                }}
              >
                {t.role}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-white/35">
          Every mothership carries the platform + turret framework; only the
          loadout differs.
        </p>
      </div>
    </>
  );
}

function StatBlock({ stats }: { stats: ShipStats }) {
  return (
    <div>
      <h3 className="mb-2 text-[11px] uppercase tracking-[0.3em] text-white/40">
        Combat Stats
      </h3>
      <div className="flex flex-col gap-2">
        {STAT_META.map((s) => (
          <div key={s.key} className="flex items-center gap-3">
            <span className="w-16 text-[11px] uppercase tracking-wider text-white/55">
              {s.label}
            </span>
            <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="absolute inset-y-0 left-0 rounded-full"
                style={{
                  width: `${stats[s.key]}%`,
                  background: s.color,
                  boxShadow: `0 0 8px ${s.color}`,
                }}
              />
            </div>
            <span className="w-6 text-right text-[11px] tabular-nums text-white/45">
              {stats[s.key]}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Section({
  title,
  color,
  children,
}: {
  title: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="mb-2 text-[11px] uppercase tracking-[0.3em]" style={{ color }}>
        {title}
      </h3>
      <ul className="flex flex-col gap-1.5">{children}</ul>
    </div>
  );
}
