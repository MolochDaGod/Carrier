/**
 * CarrierIntroOverlay — the faction "load screen" shown over the launching game.
 *
 * Mounts the disposable {@link CarrierIntro} cinematic (hyperspace arrival → slow
 * orbit of the chosen mothership) as a full-screen, opaque overlay while the real
 * CarrierGame mounts and connects underneath. It dismisses itself once the
 * cinematic has run its minimum length AND the game reports connected (or a hard
 * max cap elapses so it can never hang), fading out before calling `onDone`. A
 * Skip control dismisses it immediately.
 */
import { useEffect, useRef, useState } from "react";
import { CarrierIntro } from "./CarrierIntro";

/** Minimum cinematic runtime before we'll hand off, even if already connected. */
const MIN_MS = 6500;
/** Hard cap — hand off regardless of connection state so the intro never hangs. */
const MAX_MS = 13000;
/** Fade-out duration before onDone fires. */
const FADE_MS = 700;

export function CarrierIntroOverlay({
  shipType,
  factionColor,
  factionName,
  shipName,
  tagline,
  ready,
  onDone,
}: {
  shipType: number;
  factionColor: string;
  factionName: string;
  shipName: string;
  tagline: string;
  ready: boolean;
  onDone: () => void;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const readyRef = useRef(ready);
  const doneRef = useRef(false);
  const [fading, setFading] = useState(false);

  // Keep the latest connection state visible to the polling timer below.
  readyRef.current = ready;

  // Build the cinematic once.
  useEffect(() => {
    const container = canvasRef.current;
    if (!container) return;
    let intro: CarrierIntro | null = null;
    try {
      intro = new CarrierIntro(container, { shipType, factionColor });
      intro.start();
      intro.init().catch(() => {});
    } catch {
      // WebGL unavailable — don't block the player behind a broken load screen.
      onDone();
      return;
    }
    return () => intro?.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Decide when to dismiss: min runtime + connected, or the hard max cap.
  useEffect(() => {
    const startedAt = performance.now();
    const finish = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      setFading(true);
      window.setTimeout(onDone, FADE_MS);
    };
    const id = window.setInterval(() => {
      const el = performance.now() - startedAt;
      if ((el >= MIN_MS && readyRef.current) || el >= MAX_MS) {
        window.clearInterval(id);
        finish();
      }
    }, 120);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const skip = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setFading(true);
    window.setTimeout(onDone, FADE_MS);
  };

  return (
    <div
      className="absolute inset-0 z-20 overflow-hidden bg-[#02030a] transition-opacity"
      style={{ opacity: fading ? 0 : 1, transitionDuration: `${FADE_MS}ms` }}
    >
      <div ref={canvasRef} className="absolute inset-0" />

      {/* Faction-tinted vignette wash. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(ellipse at 50% 45%, transparent 45%, ${factionColor}10 75%, #02030acc 100%)`,
        }}
      />

      {/* Top: faction banner + arrival status. */}
      <div className="pointer-events-none absolute left-0 right-0 top-0 flex items-start justify-between p-8">
        <div>
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.5em]"
            style={{ color: factionColor }}
          >
            {factionName}
          </div>
          <div className="mt-1 text-[10px] uppercase tracking-[0.35em] text-white/45">
            Arriving from hyperspace
          </div>
        </div>
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.3em] text-white/55">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{
              background: ready ? "#5dff9b" : factionColor,
              boxShadow: `0 0 8px ${ready ? "#5dff9b" : factionColor}`,
            }}
          />
          {ready ? "Uplink established" : "Establishing uplink…"}
        </div>
      </div>

      {/* Bottom: hull identity + skip. */}
      <div className="absolute bottom-0 left-0 right-0 flex items-end justify-between p-8">
        <div className="pointer-events-none">
          <div
            className="text-5xl font-bold uppercase tracking-[0.18em]"
            style={{ color: factionColor, textShadow: `0 0 26px ${factionColor}66` }}
          >
            {shipName}
          </div>
          <div className="mt-1 text-sm italic text-white/55">{tagline}</div>
        </div>
        <button
          onClick={skip}
          className="rounded-md border px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-white/70 transition-colors hover:text-white"
          style={{ borderColor: `${factionColor}66` }}
        >
          Skip ▶
        </button>
      </div>
    </div>
  );
}
