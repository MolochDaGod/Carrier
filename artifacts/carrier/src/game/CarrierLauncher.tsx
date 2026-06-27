/**
 * Carrier launcher.
 *
 * Owns the full cabinet lifecycle: a setup screen (callsign + ship pick)
 * → mount the disposable CarrierGame.  Because the game is online and
 * self-respawning there is no local restart; "Leave" returns to the home screen.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { FACTIONS, FACTION_ORDER, type FactionId } from "@workspace/carrier-net";
import { CarrierGame } from "./CarrierGame";
import { CarrierHud } from "./CarrierHud";
import { type CarrierHudState } from "./constants";
import { CarrierLanding } from "./CarrierLanding";
import { CarrierIntroOverlay } from "./CarrierIntroOverlay";
import { MothershipSelect } from "./MothershipSelect";
import { MOTHERSHIPS } from "./motherships";

type Phase = "landing" | "setup" | "playing" | "error";

const SHIP_NAMES = MOTHERSHIPS.map((m) => m.name);

export function CarrierLauncher({ onExit }: { onExit: () => void }) {
  const [phase, setPhase] = useState<Phase>("landing");
  const [name, setName] = useState("");
  const [shipType, setShipType] = useState(0);
  const [faction, setFaction] = useState<FactionId>(FACTION_ORDER[0]);
  const [hud, setHud] = useState<CarrierHudState | null>(null);
  const [intro, setIntro] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<CarrierGame | null>(null);
  const launchOpts = useRef<{ name: string; shipType: number; faction: FactionId } | null>(null);

  const handleLaunch = useCallback(() => {
    launchOpts.current = { name: name.trim() || SHIP_NAMES[shipType], shipType, faction };
    setIntro(true);
    setPhase("playing");
  }, [name, shipType, faction]);

  useEffect(() => {
    if (phase !== "playing") return;
    const container = containerRef.current;
    const opts = launchOpts.current;
    if (!container || !opts) return;

    let engine: CarrierGame | null = null;
    try {
      engine = new CarrierGame(container, (s) => setHud(s), opts);
      engineRef.current = engine;
      engine.start();
    } catch (err) {
      console.error("[carrier] engine failed to start", err);
      engine?.dispose();
      engineRef.current = null;
      setPhase("error");
    }
    return () => {
      engine?.dispose();
      engineRef.current = null;
    };
  }, [phase]);

  if (phase === "landing") {
    return <CarrierLanding onPlay={() => setPhase("setup")} />;
  }

  if (phase === "setup") {
    return (
      <MothershipSelect
        name={name}
        setName={setName}
        shipType={shipType}
        setShipType={setShipType}
        faction={faction}
        setFaction={setFaction}
        onLaunch={handleLaunch}
        onBack={() => setPhase("landing")}
      />
    );
  }

  if (phase === "error") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#010208] px-6 text-center text-white">
        <h1 className="text-3xl font-bold">Could not launch</h1>
        <p className="max-w-md text-white/60">The Carrier engine failed to start. Please try again.</p>
        <button
          onClick={onExit}
          className="rounded-md border border-[#00d4ff] bg-[#00d4ff]/15 px-5 py-2 font-semibold uppercase tracking-widest text-[#00d4ff] hover:bg-[#00d4ff]/25"
        >
          Back
        </button>
      </div>
    );
  }

  const factionDef = FACTIONS[faction] ?? FACTIONS[FACTION_ORDER[0]];
  const introDef = MOTHERSHIPS[shipType] ?? MOTHERSHIPS[0];

  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      <div ref={containerRef} className="absolute inset-0 cursor-crosshair" />
      {hud && !intro && (
        <CarrierHud
          state={hud}
          onExit={onExit}
          onDeploy={(role) => engineRef.current?.deploy(role)}
          onBecome={(id) => engineRef.current?.become(id)}
          onSummon={(id) => engineRef.current?.summon(id)}
          onBuild={(kind) => engineRef.current?.build(kind)}
          onSkipIntro={() => engineRef.current?.skipCinematic()}
        />
      )}
      {intro && (
        <CarrierIntroOverlay
          shipType={shipType}
          factionColor={factionDef.color}
          factionName={factionDef.name}
          shipName={introDef.name}
          tagline={introDef.tagline}
          ready={hud?.status === "connected"}
          onDone={() => {
            // Hand off from the hyperspace overlay to the in-engine fly-around,
            // then the flight-training prompts.
            engineRef.current?.beginCinematic();
            setIntro(false);
          }}
        />
      )}
    </div>
  );
}
