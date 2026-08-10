/**
 * Pure React HUD overlay for Carrier. Driven entirely by CarrierHudState
 * snapshots the engine pushes — never touches Three.js or the socket.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  AFTERBURNER,
  HULL_ALERT,
  PLATFORM_COLORS,
  ROLE_COLORS,
  type CarrierHudState,
  type FleetHullPhase,
  type MapBlip,
} from "./constants";
import { fleetDebug, hullPhaseColor } from "./fleetDebug";
import type { FleetRole, PlatformKind } from "@workspace/carrier-net";
import { FactionEmblem } from "../components/FactionEmblem";
import {
  getAudioPrefs,
  playBoostReadyChirp,
  playHitCue,
  playLowHealthWarning,
  playOverheatAlarm,
  setAudioMuted,
  setAudioVolume,
  subscribeAudio,
} from "./audio";

const STATUS_LABEL: Record<CarrierHudState["status"], string> = {
  connecting: "Connecting…",
  connected: "Online",
  error: "Connection error",
  disconnected: "Disconnected",
};

const ROSTER_ICON: Record<string, string> = {
  mother_ship: "▣",
  fighter: "▲",
  fleet_unit: "◆",
};

const CAM_LABEL: Record<CarrierHudState["camMode"], string> = {
  follow: "Follow",
  orbit: "Survey",
  free: "Free",
  intro: "Cinematic",
};

export function CarrierHud({
  state,
  onExit,
  onDeploy,
  onBecome,
  onSummon,
  onBuild,
  onNavigate,
  onProduce,
  onSkipIntro,
}: {
  state: CarrierHudState;
  onExit: () => void;
  onDeploy: (role: FleetRole) => void;
  onBecome: (entityId: string) => void;
  onSummon: (entityId: string) => void;
  onBuild: (kind: PlatformKind) => void;
  onNavigate: (blip: MapBlip) => void;
  onProduce: () => void;
  onSkipIntro: () => void;
}) {
  const [tab, setTab] = useState<"fleet" | "build">("fleet");
  const [mapOpen, setMapOpen] = useState(false);

  // Backtick (`) toggles wired fleet hull diagnostics.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Backquote" || e.repeat) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      fleetDebug.toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const hpPct = Math.max(0, Math.min(1, state.hp / state.maxHp)) * 100;
  const online = state.status === "connected";
  const factionColor = state.faction?.color ?? "#00d4ff";
  const fleetDebugOn = useSyncExternalStore(
    (cb) => fleetDebug.subscribe(cb),
    () => fleetDebug.enabled,
  );
  const showFleetDebug = fleetDebugOn || state.fleetDebug.enabled;

  // M toggles the strategic map (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyM" || e.repeat) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      setMapOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Afterburner overheat feedback: a one-shot klaxon + red screen-edge vignette
  // on the lockout edge, and a softer chirp when boost cools back and re-engages.
  const [flashId, setFlashId] = useState(0);
  const [flashOpacity, setFlashOpacity] = useState(0);
  const lastOverheat = useRef(state.overheatPulse);
  const lastReady = useRef(state.boostReadyPulse);
  useEffect(() => {
    if (state.overheatPulse !== lastOverheat.current) {
      lastOverheat.current = state.overheatPulse;
      playOverheatAlarm();
      setFlashId((n) => n + 1);
    }
  }, [state.overheatPulse]);
  useEffect(() => {
    if (state.boostReadyPulse !== lastReady.current) {
      lastReady.current = state.boostReadyPulse;
      playBoostReadyChirp();
    }
  }, [state.boostReadyPulse]);
  // Drive the vignette fade-out in one rAF loop keyed on the lockout event id.
  useEffect(() => {
    if (flashId === 0) return;
    let raf = 0;
    const start = performance.now();
    setFlashOpacity(1);
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / AFTERBURNER.overheatFlashMs);
      setFlashOpacity(1 - k);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [flashId]);

  // Hull-hit feedback: a throttled "thunk" cue + a quick red edge flash each
  // time the engine reports the controlled unit's hp dropped (damagePulse).
  const [hitFlashId, setHitFlashId] = useState(0);
  const [hitOpacity, setHitOpacity] = useState(0);
  const lastDamage = useRef(state.damagePulse);
  const lastHitSound = useRef(0);
  useEffect(() => {
    if (state.damagePulse === lastDamage.current) return;
    lastDamage.current = state.damagePulse;
    const now = performance.now();
    if (now - lastHitSound.current > HULL_ALERT.hitSoundThrottleMs) {
      playHitCue();
      lastHitSound.current = now;
    }
    setHitFlashId((n) => n + 1);
  }, [state.damagePulse]);
  useEffect(() => {
    if (hitFlashId === 0) return;
    let raf = 0;
    const start = performance.now();
    setHitOpacity(1);
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / HULL_ALERT.hitFlashMs);
      setHitOpacity(1 - k);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hitFlashId]);

  // Critical-hull warning: persistent pulsing red edge + a repeating klaxon
  // while alive and below the danger threshold, clearing the moment hp recovers.
  const lowHealth =
    state.alive &&
    online &&
    state.hp > 0 &&
    state.hp / state.maxHp <= HULL_ALERT.lowHpFrac;
  const [lowPulse, setLowPulse] = useState(0);
  useEffect(() => {
    if (!lowHealth) {
      setLowPulse(0);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      // 0..1 sine pulse (~1.3 Hz) drives the breathing edge glow.
      setLowPulse((Math.sin((t - start) / 380) + 1) / 2);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [lowHealth]);
  useEffect(() => {
    if (!lowHealth) return;
    playLowHealthWarning();
    const id = window.setInterval(playLowHealthWarning, HULL_ALERT.warnIntervalMs);
    return () => window.clearInterval(id);
  }, [lowHealth]);

  // Opening fly-around: letterboxed, gameplay HUD suppressed, skippable.
  // Placed after all hooks so the rules-of-hooks aren't violated.
  if (state.cinematic) {
    return (
      <div className="pointer-events-none absolute inset-0 select-none font-mono text-white">
        <div className="absolute inset-x-0 top-0 h-[11vh] bg-black" />
        <div className="absolute inset-x-0 bottom-0 h-[11vh] bg-black" />
        <div className="absolute inset-x-0 bottom-[11vh] flex flex-col items-center gap-1 pb-7">
          <span className="text-[10px] uppercase tracking-[0.5em] text-white/45">
            Now entering the sector
          </span>
          <span
            className="text-2xl font-bold uppercase tracking-[0.35em]"
            style={{ color: factionColor }}
          >
            {state.faction?.name ?? "Your Fleet"}
          </span>
        </div>
        <button
          onClick={onSkipIntro}
          className="pointer-events-auto absolute bottom-[13vh] right-6 rounded border border-white/30 bg-black/50 px-4 py-1.5 text-[11px] uppercase tracking-[0.25em] text-white/75 hover:bg-white/10"
        >
          Skip ▸ Space
        </button>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 select-none font-mono text-white">
      {/* Afterburner overheat flash — red screen-edge vignette pulse, fades out */}
      {flashOpacity > 0 && (
        <div
          className="pointer-events-none absolute inset-0 z-50"
          style={{
            opacity: flashOpacity,
            background:
              "radial-gradient(ellipse at center, rgba(255,40,40,0) 45%, rgba(255,20,20,0.65) 100%)",
          }}
        />
      )}

      {/* Critical-hull warning — persistent breathing red edge while hp is low */}
      {lowHealth && (
        <div
          className="pointer-events-none absolute inset-0 z-40"
          style={{
            opacity: 0.3 + lowPulse * 0.4,
            background:
              "radial-gradient(ellipse at center, rgba(255,30,30,0) 52%, rgba(220,10,10,0.7) 100%)",
          }}
        />
      )}

      {/* Hull-hit flash — quick red edge pulse on each point of damage taken */}
      {hitOpacity > 0 && (
        <div
          className="pointer-events-none absolute inset-0 z-50"
          style={{
            opacity: hitOpacity * 0.8,
            background:
              "radial-gradient(ellipse at center, rgba(255,60,60,0) 40%, rgba(255,30,30,0.6) 100%)",
          }}
        />
      )}

      {/* Top bar */}
      <div className="absolute left-0 right-0 top-0 flex items-center justify-between px-5 py-3">
        <div className="flex items-center gap-3">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              online ? "bg-[#00d4ff]" : "bg-red-500"
            }`}
          />
          <span className="text-xs uppercase tracking-[0.3em] text-white/80">
            {STATUS_LABEL[state.status]}
          </span>
          <span className="text-xs text-white/50">{state.players} in sector</span>
          <span className="text-xs uppercase tracking-widest text-[#ffd23f]">
            ◈ {state.credits} cr
          </span>
          {state.faction && (
            <span
              className="flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs font-semibold uppercase tracking-widest"
              style={{
                color: factionColor,
                borderColor: `${factionColor}80`,
                background: `${factionColor}1f`,
              }}
              title="Your faction"
            >
              <FactionEmblem faction={state.faction.id} size={20} glow={false} />
              {state.faction.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <AudioControl />
          {state.controllingMother && (
            <span
              className="rounded border border-[#c084fc]/50 bg-[#c084fc]/15 px-3 py-1 text-xs uppercase tracking-widest text-[#c084fc]"
              title="Mothership camera — press V to cycle (Survey: B vantage / wheel zoom; Free: WASD+QE)"
            >
              CAM: {CAM_LABEL[state.camMode]} [V]
            </span>
          )}
          <button
            onClick={() => setMapOpen((v) => !v)}
            className={`pointer-events-auto rounded border px-3 py-1 text-xs uppercase tracking-widest hover:bg-white/10 ${
              mapOpen
                ? "border-[#00d4ff] bg-[#00d4ff]/15 text-[#00d4ff]"
                : "border-white/30 bg-black/40 text-white/80"
            }`}
            title="Toggle strategic map (M)"
          >
            Map
          </button>
          <button
            onClick={onExit}
            className="pointer-events-auto rounded border border-white/30 bg-black/40 px-3 py-1 text-xs uppercase tracking-widest text-white/80 hover:bg-white/10"
          >
            Leave
          </button>
        </div>
      </div>

      {/* Scoreboard */}
      <div className="absolute right-5 top-14 w-52 rounded-md border border-white/15 bg-black/45 p-3 text-xs">
        <div className="mb-2 flex justify-between uppercase tracking-widest text-white/50">
          <span>Pilot</span>
          <span>K / D</span>
        </div>
        {state.scoreboard.length === 0 && (
          <div className="text-white/40">Awaiting crew…</div>
        )}
        {state.scoreboard.map((r) => (
          <div
            key={r.id}
            className={`flex justify-between py-0.5 ${
              r.you ? "text-[#00d4ff]" : "text-white/85"
            }`}
          >
            <span className="truncate pr-2">{r.name}</span>
            <span className="tabular-nums">
              {r.kills} / {r.deaths}
            </span>
          </div>
        ))}
      </div>

      {/* Outpost pings — fly out, clear the garrison, take the cache */}
      {online && state.outposts.length > 0 && (
        <div className="absolute right-5 top-44 w-52 rounded-md border border-white/15 bg-black/45 p-3 text-xs">
          <div className="mb-2 flex items-center justify-between uppercase tracking-widest text-white/50">
            <span>Pings</span>
            <span className="text-white/30">Outposts</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {state.outposts.slice(0, 4).map((o) => {
              const km = (o.distance / 1000).toFixed(1);
              return (
                <div key={o.id} className="flex items-center gap-2">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: o.cleared ? "#2bd96b" : "#ff3b30" }}
                  />
                  <span className="flex-1 tabular-nums text-white/80">{km} km</span>
                  {o.cleared ? (
                    <span className="text-[10px] uppercase tracking-wider text-[#2bd96b]">
                      ◈ {o.rewardAmount}
                    </span>
                  ) : (
                    <span className="tabular-nums text-[#ff8d85]">
                      {o.garrisonAlive}/{o.garrisonTotal} ✦
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Fleet Log — LMB select/fly any owned hull; RMB follow/join */}
      {online && state.roster.length > 0 && (
        <div className="pointer-events-auto absolute left-5 top-14 w-60 rounded-md border border-white/15 bg-black/50 p-3 text-xs backdrop-blur-sm">
          <div className="mb-1 flex items-center justify-between uppercase tracking-widest text-white/50">
            <span>Your Fleet</span>
            <span className="text-white/30">Tab ⇄</span>
          </div>
          <div className="mb-2 text-[9px] leading-tight text-white/35">
            LMB: select &amp; fly · RMB: follow / join you · Tab: carrier ↔ last ship
          </div>
          <div className="flex flex-col gap-1.5">
            {state.roster.map((u) => {
              const active = u.id === state.controlledEntityId;
              const accent =
                u.kind === "mother_ship"
                  ? "#00d4ff"
                  : u.kind === "fleet_unit"
                    ? "#88aaff"
                    : "#88ff00";
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => onBecome(u.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (u.summonable) onSummon(u.id);
                  }}
                  className={`flex items-start gap-2 rounded border px-2 py-1.5 text-left transition-colors ${
                    active
                      ? "cursor-default border-[#00d4ff] bg-[#00d4ff]/15"
                      : u.escorting
                        ? "border-[#66ccff]/60 bg-[#66ccff]/10 hover:bg-[#66ccff]/15"
                        : "border-white/15 bg-white/5 hover:bg-white/10"
                  }`}
                  title={
                    active
                      ? "You are flying this ship"
                      : u.summonable
                        ? `Select ${u.label} (LMB) · ${u.escorting ? "Dismiss from formation" : "Follow / join you"} (RMB)`
                        : u.isMother
                          ? `Select carrier (LMB) · Tab also toggles here`
                          : `Select ${u.label} (LMB)`
                  }
                >
                  <span className="mt-0.5" style={{ color: accent }}>{ROSTER_ICON[u.kind] ?? "●"}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[11px] font-medium text-white/90">
                        {u.label}
                      </span>
                      {u.escorting && (
                        <span className="text-[8px] uppercase tracking-wider text-[#66ccff]">
                          ESC
                        </span>
                      )}
                      {active && (
                        <span className="text-[8px] uppercase tracking-wider text-[#00d4ff]">
                          ●
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-white/15">
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width: `${u.hpPct * 100}%`,
                          background: u.hpPct > 0.4 ? "#00d4ff" : "#ff4444",
                        }}
                      />
                    </span>
                    <span className="mt-0.5 block h-1 w-full overflow-hidden rounded-full bg-white/10">
                      <span
                        className="block h-full rounded-full bg-[#66ccff]"
                        style={{ width: `${Math.max(u.shieldPct, 0.04) * 100}%`, opacity: u.shieldPct > 0 ? 1 : 0.25 }}
                      />
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Bottom-left: hull + throttle */}
      <div className="absolute bottom-5 left-5 w-64">
        <div className="mb-1 flex justify-between text-[10px] uppercase tracking-widest text-white/60">
          <span>Hull</span>
          <span>
            {Math.ceil(state.hp)} / {state.maxHp}
          </span>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full border border-white/25 bg-white/10">
          <div
            className="h-full rounded-full transition-[width] duration-150"
            style={{
              width: `${hpPct}%`,
              background: hpPct > 50 ? "#00d4ff" : hpPct > 25 ? "#ffd23f" : "#ff4444",
            }}
          />
        </div>
        {state.maxShield > 0 && (
          <>
            <div className="mt-2 mb-1 flex justify-between text-[10px] uppercase tracking-widest text-white/60">
              <span>Shield</span>
              <span>
                {Math.ceil(state.shield)} / {state.maxShield}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full border border-[#66ccff]/40 bg-white/10">
              <div
                className="h-full rounded-full bg-[#66ccff] transition-[width] duration-150"
                style={{
                  width: `${Math.max(0, Math.min(1, state.shield / state.maxShield)) * 100}%`,
                }}
              />
            </div>
          </>
        )}
        <div className="mt-2 mb-1 flex justify-between text-[10px] uppercase tracking-widest text-white/60">
          <span>Throttle</span>
          {state.boost && <span className="text-[#00d4ff]">BOOST</span>}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full border border-white/25 bg-white/10">
          <div
            className="h-full rounded-full bg-[#00d4ff]"
            style={{ width: `${state.speed * 100}%` }}
          />
        </div>

        {/* Afterburner heat gauge — fills with sustained boost, bleeds when idle */}
        {(() => {
          const heatPct = Math.max(0, Math.min(1, state.boostHeat)) * 100;
          const locked = state.boostLocked;
          const overheating = locked || state.boostHeat >= 0.85;
          const heatColor = overheating
            ? "#ff4444"
            : state.boostHeat > 0.55
              ? "#ff8d3f"
              : "#ffd23f";
          return (
            <>
              <div className="mt-2 mb-1 flex justify-between text-[10px] uppercase tracking-widest text-white/60">
                <span>Afterburner</span>
                {locked ? (
                  <span className="animate-pulse text-[#ff4444]">OVERHEAT — LOCKED</span>
                ) : state.boost ? (
                  <span
                    className={overheating ? "animate-pulse text-[#ff4444]" : "text-[#ff8d3f]"}
                  >
                    {overheating ? "OVERHEAT" : "FIRING"}
                  </span>
                ) : (
                  state.boostHeat > 0.02 && <span className="text-white/45">COOLING</span>
                )}
              </div>
              <div className="h-1.5 overflow-hidden rounded-full border border-white/25 bg-white/10">
                <div
                  className="h-full rounded-full transition-[width] duration-100"
                  style={{
                    width: `${heatPct}%`,
                    background: heatColor,
                    boxShadow: state.boost || locked ? `0 0 6px ${heatColor}` : "none",
                  }}
                />
              </div>
            </>
          );
        })()}
      </div>

      {/* Combat crosshair — brackets + centre pip; orange when RMB missiles armed */}
      {state.alive && online && state.aiming && (
        <CombatCrosshair
          color={factionColor}
          missile={state.firingMissile}
          firing={state.firingPrimary}
          aim={state.aimScreen}
        />
      )}

      {/* Flight-training prompt (top-center, dismisses itself as you fly) */}
      {online && state.alive && state.hint && (
        <div className="absolute left-1/2 top-20 w-[min(92vw,440px)] -translate-x-1/2">
          <div
            className="rounded-lg border bg-black/70 px-5 py-3 text-center backdrop-blur-sm"
            style={{ borderColor: `${factionColor}66` }}
          >
            <div className="mb-1 flex items-center justify-center gap-2">
              <span
                className="text-[11px] font-bold uppercase tracking-[0.3em]"
                style={{ color: factionColor }}
              >
                {state.hint.title}
              </span>
              <span className="text-[10px] text-white/40">
                {state.hint.step}/{state.hint.total}
              </span>
            </div>
            <div className="text-[13px] leading-snug text-white/85">{state.hint.body}</div>
          </div>
        </div>
      )}

      {/* Respawn overlay */}
      {!state.alive && online && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50">
          <div className="text-3xl font-bold uppercase tracking-[0.3em] text-red-400">
            Hull Breached
          </div>
          <div className="text-sm text-white/70">
            Respawning in {Math.ceil(state.respawnIn)}…
          </div>
        </div>
      )}

      {/* Command console — Fleet / Build tabs */}
      {online && (
        <div className="pointer-events-auto absolute bottom-16 left-1/2 w-[32rem] max-w-[92vw] -translate-x-1/2 rounded-lg border border-white/15 bg-black/55 p-3 backdrop-blur-sm">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex gap-1">
              {(["fleet", "build"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`rounded px-3 py-1 text-[10px] uppercase tracking-[0.25em] transition-colors ${
                    tab === t
                      ? "bg-white/15 text-white"
                      : "text-white/45 hover:text-white/75"
                  }`}
                >
                  {t === "fleet" ? "Deploy" : "Build"}
                </button>
              ))}
            </div>
            <span className="font-mono text-sm text-[#ffd23f]">
              ◈ {state.credits} cr
            </span>
          </div>

          {tab === "fleet" ? (
            <>
              <div className="grid grid-cols-4 gap-2">
                {state.deployOptions.map((opt) => {
                  const accent = ROLE_COLORS[opt.role];
                  return (
                    <button
                      key={opt.role}
                      onClick={() => onDeploy(opt.role)}
                      disabled={!opt.available}
                      className="rounded-md border px-2 py-2 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-35"
                      style={{
                        borderColor: opt.available ? accent : "rgba(255,255,255,0.15)",
                        background: opt.available ? `${accent}1f` : "rgba(0,0,0,0.3)",
                      }}
                      title={`Deploy a ${opt.label} for ${opt.cost} credits`}
                    >
                      <div className="mx-auto mb-1 h-2.5 w-2.5 rounded-full" style={{ background: accent }} />
                      <div className="text-[11px] font-semibold leading-tight">{opt.label}</div>
                      <div className="text-[9px] tabular-nums text-white/55">{opt.cost} cr</div>
                    </button>
                  );
                })}
              </div>
              {state.fleet.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {state.fleet.map((u) => (
                    <div
                      key={u.id}
                      className="flex items-center gap-1 rounded border border-white/10 bg-white/5 px-1.5 py-0.5"
                      title={fleetChipTitle(u)}
                    >
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: ROLE_COLORS[u.role] }} />
                      {(showFleetDebug || u.hullPhase !== "glb") && (
                        <span
                          className="h-1.5 w-1.5 rounded-full ring-1 ring-black/40"
                          style={{ background: hullPhaseColor(u.hullPhase) }}
                          title={`Hull: ${u.hullPhase}`}
                        />
                      )}
                      <span className="text-[9px] text-white/70">{u.label}</span>
                      <span className="h-1 w-6 overflow-hidden rounded-full bg-white/15">
                        <span className="block h-full rounded-full" style={{ width: `${u.hpPct * 100}%`, background: ROLE_COLORS[u.role] }} />
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-1.5 text-center text-[9px] text-white/35">
                {state.fleet.length} unit{state.fleet.length === 1 ? "" : "s"} deployed · launches from beneath your carrier
              </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                {state.buildOptions.map((opt) => {
                  const accent = PLATFORM_COLORS[opt.kind];
                  return (
                    <button
                      key={opt.kind}
                      onClick={() => onBuild(opt.kind)}
                      disabled={!opt.available}
                      className="rounded-md border px-2 py-2 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-35"
                      style={{
                        borderColor: opt.available ? accent : "rgba(255,255,255,0.15)",
                        background: opt.available ? `${accent}1f` : "rgba(0,0,0,0.3)",
                      }}
                      title={`${opt.blurb} — ${opt.cost} credits`}
                    >
                      <div className="mx-auto mb-1 h-2.5 w-2.5 rounded-sm" style={{ background: accent }} />
                      <div className="text-[11px] font-semibold leading-tight">{opt.label}</div>
                      <div className="text-[8px] leading-tight text-white/45">{opt.blurb}</div>
                      <div className="text-[9px] tabular-nums text-white/55">{opt.cost} cr</div>
                    </button>
                  );
                })}
              </div>
              {state.platforms.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {state.platforms.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center gap-1 rounded border border-white/10 bg-white/5 px-1.5 py-0.5"
                      title={`${p.label} platform · ${Math.round(p.hpPct * 100)}% hull`}
                    >
                      <span className="h-1.5 w-1.5 rounded-sm" style={{ background: PLATFORM_COLORS[p.kind] }} />
                      <span className="text-[9px] text-white/70">{p.label}</span>
                      <span className="h-1 w-6 overflow-hidden rounded-full bg-white/15">
                        <span className="block h-full rounded-full" style={{ width: `${p.hpPct * 100}%`, background: PLATFORM_COLORS[p.kind] }} />
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-1.5 text-center text-[9px] text-white/35">
                {state.platforms.length} platform{state.platforms.length === 1 ? "" : "s"} tethered · cabled to your carrier
              </div>
            </>
          )}
        </div>
      )}

      {/* Server universe event */}
      {online && state.universeEvent && (
        <div className="pointer-events-none absolute left-1/2 top-24 w-[min(92vw,32rem)] -translate-x-1/2 rounded-md border border-[#9b59ff]/45 bg-black/70 px-3 py-2 text-center text-xs backdrop-blur-sm">
          <div className="text-[10px] uppercase tracking-[0.25em] text-[#9b59ff]/80">
            Universe event · {state.universeEvent.kind.replace(/_/g, " ")}
          </div>
          <div className="mt-1 text-white/85">{state.universeEvent.msg}</div>
        </div>
      )}

      {/* Friendly mothership forcefield (aegis) — 5× hull radius, 3× shields */}
      {online && state.aegis?.active && (
        <div className="pointer-events-none absolute left-1/2 top-[4.5rem] w-[min(92vw,22rem)] -translate-x-1/2 rounded-md border border-[#44ccff]/40 bg-[#0a2030]/75 px-3 py-2 text-xs backdrop-blur-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="uppercase tracking-[0.2em] text-[#66ddff]">
              Carrier forcefield
            </span>
            <span className="tabular-nums text-[#88eeff]/80">
              {Math.round(state.aegis.radius)} m
            </span>
          </div>
          <div className="mt-1 text-[10px] text-white/65">
            3× shield bank · fast regen after 10s out of combat (5s full fill)
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/15">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#2288ff] to-[#66eeff]"
              style={{
                width: `${Math.max(0, Math.min(100, (state.shield / Math.max(1, state.aegis.effMaxShield || state.maxShield)) * 100))}%`,
              }}
            />
          </div>
          <div className="mt-0.5 flex justify-between text-[9px] text-white/45">
            <span>Shield</span>
            <span className="tabular-nums">
              {Math.round(state.shield)} / {Math.round(state.aegis.effMaxShield || state.maxShield)}
            </span>
          </div>
        </div>
      )}

      {/* Hostile capital assault strip — enemy carrier blips on strategic map */}
      {online && state.mapBlips?.some((b) => b.kind === "carrier" && b.mission && b.label !== "Your capital") && (
        <div className="pointer-events-none absolute right-5 top-28 w-52 rounded-md border border-[#ff5533]/35 bg-black/55 px-2.5 py-2 text-[10px] backdrop-blur-sm">
          <div className="uppercase tracking-widest text-[#ff7755]">Capital assault</div>
          <div className="mt-1 text-white/70">
            Hostile capital in sector. Forcefield is 5× hull radius — chip from outside the bubble or
            push under fire with fire-laser (LMB/F) + missiles (RMB).
          </div>
          <div className="mt-1.5 text-white/45">
            Open map · M · target capital blips · stay mobile
          </div>
        </div>
      )}

      {/* Mothership mission strip */}
      {online && (state.motherMission.navActive || state.motherMission.atRockNode) && (
        <div className="pointer-events-auto absolute left-1/2 top-14 w-[min(92vw,28rem)] -translate-x-1/2 rounded-md border border-[#00d4ff]/35 bg-black/60 px-3 py-2 text-xs backdrop-blur-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="uppercase tracking-widest text-[#00d4ff]/80">
              {state.motherMission.navActive ? "Carrier en route" : "Rock node active"}
            </span>
            {state.motherMission.atRockNode && (
              <button
                onClick={onProduce}
                className="rounded border border-[#ffd23f]/50 px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#ffd23f] hover:bg-[#ffd23f]/10"
              >
                Build fleet hull
              </button>
            )}
          </div>
          {state.motherMission.navActive && state.motherMission.navLabel && (
            <div className="mt-0.5 text-white/70">Mission: {state.motherMission.navLabel}</div>
          )}
          {state.motherMission.atRockNode && state.motherMission.produceProgress > 0 && (
            <div className="mt-1.5">
              <div className="mb-0.5 flex justify-between text-[10px] text-white/50">
                <span>Fabricating faction ship</span>
                <span>{Math.round(state.motherMission.produceProgress * 100)}%</span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-white/15">
                <div
                  className="h-full rounded-full bg-[#ffd23f]"
                  style={{ width: `${state.motherMission.produceProgress * 100}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Strategic map overlay */}
      {online && mapOpen && (
        <StrategicMap
          blips={state.mapBlips}
          onClose={() => setMapOpen(false)}
          onNavigate={(blip) => {
            onNavigate(blip);
            setMapOpen(false);
          }}
        />
      )}

      {online && showFleetDebug && (
        <FleetDebugPanel panel={state.fleetDebug} />
      )}

      {/* Hull yaw tune feedback (numpad 4 / 6 / 5) */}
      {online && (state.hullTuneDeg !== null || state.hullTuneSaved) && (
        <div className="pointer-events-none absolute bottom-24 right-5 max-w-xs rounded-md border border-[#ffd23f]/40 bg-black/70 px-3 py-2 text-right text-[10px] backdrop-blur-sm">
          {state.hullTuneSaved ? (
            <div className="text-[#2bd96b]">{state.hullTuneSaved}</div>
          ) : state.hullTuneDeg !== null ? (
            <>
              <div className="uppercase tracking-widest text-[#ffd23f]/80">Hull yaw tune</div>
              <div className="tabular-nums text-white/85">{state.hullTuneDeg.toFixed(1)}°</div>
              <div className="text-white/45">Num4 ← · Num6 → · Num5 save</div>
            </>
          ) : null}
        </div>
      )}

      {/* Controls hint */}
      <div className="absolute bottom-5 right-5 text-right text-[10px] leading-relaxed text-white/40">
        <div>W/S throttle · A/D yaw · ↑/↓ pitch · Q/E roll</div>
        <div>Mouse aim (click to lock) · LMB/Space fire · RMB missiles · Shift boost · Tab carrier↔ship</div>
        <div>Num4/6 hull yaw · Num5 save orientation</div>
        {showFleetDebug && (
          <div className="mt-1 text-[#ffd23f]/70">` fleet debug · green=GLB · amber=pending · orange=fallback</div>
        )}
      </div>
    </div>
  );
}

function fleetChipTitle(u: {
  label: string;
  hpPct: number;
  hullPhase: FleetHullPhase;
  hullAssetId: string;
  hullError?: string;
}): string {
  const lines = [
    `${u.label} · ${Math.round(u.hpPct * 100)}% hull`,
    `Hull: ${u.hullPhase} · ${u.hullAssetId}`,
  ];
  if (u.hullError) lines.push(u.hullError);
  return lines.join("\n");
}

function FleetDebugPanel({ panel }: { panel: CarrierHudState["fleetDebug"] }) {
  const phaseLabel: Record<FleetHullPhase, string> = {
    glb: "GLB",
    pending: "…",
    fallback: "CONE",
    error: "ERR",
  };
  return (
    <div className="pointer-events-auto absolute right-5 top-14 z-20 w-72 max-h-[50vh] overflow-hidden rounded-md border border-[#ffd23f]/30 bg-black/75 text-[10px] backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-white/10 px-2.5 py-2">
        <span className="font-semibold uppercase tracking-[0.2em] text-[#ffd23f]">Fleet Debug</span>
        <span className="tabular-nums text-white/45">
          {panel.glb}✓ {panel.pending}… {panel.fallback}△ {panel.error}✕
        </span>
      </div>
      <div className="border-b border-white/10 px-2.5 py-1.5 text-[9px] text-white/40">
        <div className="flex justify-between gap-2">
          <span>
            Queue {panel.loadQueue.inFlight}/{panel.loadQueue.maxConcurrency}
            {panel.loadQueue.queued > 0 ? ` · ${panel.loadQueue.queued} wait` : ""}
          </span>
          <span className="tabular-nums">
            {panel.loadQueue.completed}↓ {panel.loadQueue.failed > 0 ? `${panel.loadQueue.failed}✕` : ""}
          </span>
        </div>
        <div>
          Warmup {panel.warmupPhase}
          {panel.cdn ? " · CDN" : " · bundle"}
        </div>
      </div>
      <div className="max-h-[40vh] overflow-y-auto px-2 py-1.5 font-mono">
        {panel.rows.length === 0 ? (
          <div className="py-3 text-center text-white/35">Deploy a unit to trace hull loads</div>
        ) : (
          panel.rows.map((r) => (
            <div
              key={r.key}
              className="border-b border-white/5 py-1.5 last:border-0"
              title={r.error ?? r.assetId}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="rounded px-1 py-0.5 text-[8px] font-bold uppercase"
                  style={{ background: `${hullPhaseColor(r.phase)}33`, color: hullPhaseColor(r.phase) }}
                >
                  {phaseLabel[r.phase]}
                </span>
                <span className="truncate text-white/80">{r.label}</span>
                {r.skinned && <span className="text-[8px] text-[#c084fc]">rig</span>}
                {r.durationMs != null && (
                  <span className="ml-auto tabular-nums text-white/35">{r.durationMs}ms</span>
                )}
              </div>
              <div className="truncate pl-1 text-[9px] text-white/35">{r.assetId}</div>
              {r.error && <div className="truncate pl-1 text-[9px] text-[#ff9d3f]">{r.error}</div>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Master mute/volume control. Reads the shared, localStorage-backed audio prefs
 * via useSyncExternalStore so the toggle and slider stay in sync with every cue.
 */
function AudioControl() {
  const prefs = useSyncExternalStore(subscribeAudio, getAudioPrefs, getAudioPrefs);
  const [open, setOpen] = useState(false);
  const muted = prefs.muted || prefs.volume <= 0;
  const pct = Math.round(prefs.volume * 100);
  return (
    <div
      className="pointer-events-auto relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        onClick={() => setAudioMuted(!prefs.muted)}
        className={`rounded border px-3 py-1 text-xs uppercase tracking-widest hover:bg-white/10 ${
          muted
            ? "border-white/25 bg-black/40 text-white/45"
            : "border-[#00d4ff]/50 bg-[#00d4ff]/10 text-[#00d4ff]"
        }`}
        title={muted ? "Unmute game sound" : "Mute game sound"}
      >
        {muted ? "♪ Off" : `♪ ${pct}`}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-md border border-white/15 bg-black/85 p-3 backdrop-blur-sm">
          <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-widest text-white/55">
            <span>Volume</span>
            <span className="tabular-nums text-white/75">{muted ? "Muted" : `${pct}%`}</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={muted ? 0 : pct}
            onChange={(e) => {
              const v = Number(e.target.value) / 100;
              setAudioVolume(v);
              if (v > 0 && prefs.muted) setAudioMuted(false);
            }}
            className="w-full accent-[#00d4ff]"
            aria-label="Master volume"
          />
          <button
            onClick={() => setAudioMuted(!prefs.muted)}
            className="mt-2 w-full rounded border border-white/20 px-2 py-1 text-[10px] uppercase tracking-widest text-white/70 hover:bg-white/10"
          >
            {prefs.muted ? "Unmute" : "Mute"}
          </button>
        </div>
      )}
    </div>
  );
}

/** Top-down strategic map — blips are pre-normalised to [-1,1] per axis. */
function StrategicMap({
  blips,
  onClose,
  onNavigate,
}: {
  blips: MapBlip[];
  onClose: () => void;
  onNavigate: (blip: MapBlip) => void;
}) {
  const SIZE = 460;
  const toPx = (v: number) => ((v + 1) / 2) * SIZE;
  return (
    <div className="pointer-events-auto absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-white/20 bg-black/80 p-4 backdrop-blur-md">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.3em] text-white/60">
          Strategic Map
        </span>
        <button
          onClick={onClose}
          className="rounded border border-white/25 px-2 py-0.5 text-[10px] uppercase tracking-widest text-white/70 hover:bg-white/10"
        >
          Close
        </button>
      </div>
      <svg
        width={SIZE}
        height={SIZE}
        className="max-w-[80vw] rounded border border-white/10 bg-[#05080f]"
      >
        {/* grid rings */}
        {[0.25, 0.5, 0.75, 1].map((r) => (
          <circle
            key={r}
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={(r * SIZE) / 2}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
          />
        ))}
        <line x1={SIZE / 2} y1={0} x2={SIZE / 2} y2={SIZE} stroke="rgba(255,255,255,0.06)" />
        <line x1={0} y1={SIZE / 2} x2={SIZE} y2={SIZE / 2} stroke="rgba(255,255,255,0.06)" />
        {blips.map((b, i) => {
          const big = b.kind === "self" || b.kind === "carrier";
          const outpost = b.kind === "outpost";
          const rock = b.kind === "rock";
          const system = b.kind === "system";
          const clickable = b.mission || b.kind === "rock" || b.kind === "outpost" || system;
          return (
            <circle
              key={b.id ?? i}
              cx={toPx(b.x)}
              cy={toPx(b.y)}
              r={big ? 5 : system ? 5.5 : outpost ? 4.5 : rock ? (b.mission ? 4 : 3) : b.kind === "enemy" ? 3.5 : 2.5}
              fill={outpost ? "none" : b.color}
              stroke={b.mission ? "#ffd23f" : b.kind === "self" ? "#ffffff" : outpost || rock ? b.color : "none"}
              strokeWidth={b.mission ? 2 : b.kind === "self" ? 1.5 : outpost || rock ? 1.2 : 0}
              opacity={rock ? 0.85 : 1}
              className={clickable ? "cursor-pointer hover:opacity-100" : undefined}
              onClick={() => {
                if (clickable) onNavigate(b);
              }}
            >
              {b.mission && (
                <title>{`Take ${b.label ?? "rock"} — click to order carrier`}</title>
              )}
            </circle>
          );
        })}
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-white/55">
        <Legend color="#ffffff" label="You" />
        <Legend color="#00d4ff" label="Carrier" />
        <Legend color="#88ff00" label="Fleet" />
        <Legend color="#ff6b35" label="Platform" />
        <Legend color="#ff3b30" label="Enemy" />
        <Legend color="#ffd23f" label="Reward" />
        <Legend color="#5a9fd4" label="Solar system" />
        <Legend color="#8a7f72" label="Asteroid" />
        <Legend color="#ffd23f" label="Mission target" />
        <Legend color="#2bd96b" label="Claimed" />
        <Legend color="#2bd96b" label="Outpost" />
      </div>
      <div className="mt-1 text-center text-[9px] text-white/40">
        Click an asteroid to order the carrier · M to close
      </div>
    </div>
  );
}

/** Tactical reticle: corner brackets, centre dot, spread kick on fire. */
function CombatCrosshair({
  color,
  missile,
  firing,
  aim,
}: {
  color: string;
  missile: boolean;
  firing: boolean;
  aim: { x: number; y: number } | null;
}) {
  const accent = missile ? "#ff8844" : color;
  const spread = firing ? 6 : missile ? 4 : 0;
  const sz = 22 + spread;
  const arm = 9;
  const gap = 5;
  const style = { borderColor: accent, boxShadow: `0 0 8px ${accent}55` };
  const posStyle = aim
    ? { left: `${aim.x * 100}%`, top: `${aim.y * 100}%`, transform: "translate(-50%, -50%)" }
    : { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
  return (
    <div className="pointer-events-none absolute" style={posStyle}>
      <div className="relative" style={{ width: sz * 2, height: sz * 2 }}>
        <span className="absolute border-l-2 border-t-2" style={{ ...style, left: 0, top: 0, width: arm, height: arm }} />
        <span className="absolute border-r-2 border-t-2" style={{ ...style, right: 0, top: 0, width: arm, height: arm }} />
        <span className="absolute border-l-2 border-b-2" style={{ ...style, left: 0, bottom: 0, width: arm, height: arm }} />
        <span className="absolute border-r-2 border-b-2" style={{ ...style, right: 0, bottom: 0, width: arm, height: arm }} />
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            width: missile ? 6 : 4,
            height: missile ? 6 : 4,
            background: accent,
            boxShadow: `0 0 ${missile ? 10 : 6}px ${accent}`,
          }}
        />
        {missile && (
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed opacity-60"
            style={{ width: gap * 5, height: gap * 5, borderColor: accent }}
          />
        )}
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
