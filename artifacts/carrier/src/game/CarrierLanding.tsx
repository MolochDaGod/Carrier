/**
 * CarrierLanding — the opener / title screen.
 *
 * A pure-DOM (no WebGL) hero shown before the hangar so the cabinet has a real
 * front door: a warp-speed starfield on a 2D canvas, nebula glows, the CARRIER
 * wordmark, the five faction colours, and a single ENTER HANGAR call to action.
 * Kept WebGL-free so the title always renders even where a GL context is
 * unavailable; the 3D ship showcase lives one screen deeper in MothershipSelect.
 */
import { useEffect, useRef, useState } from "react";
import { FACTIONS, FACTION_ORDER, type FactionId } from "@workspace/carrier-net";
import { FactionEmblem } from "../components/FactionEmblem";
import { CursorParticles } from "../components/CursorParticles";
import { MothershipWireframe } from "./MothershipWireframe";
import { MOTHERSHIPS, FACTION_ACCENT } from "./motherships";

const DEFAULT_ACCENT = "#00d4ff";

/** Each faction's representative hull for the landing wireframe preview. */
function defForFaction(id: FactionId) {
  const i = FACTION_ORDER.indexOf(id);
  return MOTHERSHIPS[i] ?? MOTHERSHIPS[0];
}

/** Lightweight 2D warp-star field — drifting stars pulled toward the camera. */
function Starfield() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const COUNT = 340;
    let w = 0;
    let h = 0;
    let raf = 0;

    type Star = { x: number; y: number; z: number };
    let stars: Star[] = [];

    const seed = (s: Star) => {
      s.x = (Math.random() - 0.5) * w;
      s.y = (Math.random() - 0.5) * h;
      s.z = Math.random() * w;
    };

    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = Array.from({ length: COUNT }, () => {
        const s = { x: 0, y: 0, z: 0 };
        seed(s);
        return s;
      });
    };

    resize();
    window.addEventListener("resize", resize);

    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      // Skip transient 0x0 layout states (canvas not yet measured).
      if (!w || !h) {
        raf = requestAnimationFrame(tick);
        return;
      }

      // Trailing fade for a soft motion blur instead of a hard clear.
      ctx.fillStyle = "rgba(2,4,10,0.4)";
      ctx.fillRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      for (const s of stars) {
        s.z -= 70 * dt;
        if (s.z <= 1) {
          seed(s);
          s.z = w;
        }
        const k = 140 / s.z;
        const x = cx + s.x * k;
        const y = cy + s.y * k;
        if (x < 0 || x > w || y < 0 || y > h) continue;
        const depth = 1 - s.z / w;
        ctx.beginPath();
        ctx.fillStyle = `rgba(150,200,255,${Math.max(0.05, depth)})`;
        ctx.arc(x, y, Math.max(0.3, depth * 2.2), 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={ref} className="absolute inset-0 h-full w-full" />;
}

export function CarrierLanding({ onPlay }: { onPlay: () => void }) {
  const [hovered, setHovered] = useState<FactionId | null>(null);
  const accent = hovered ? FACTIONS[hovered].color : DEFAULT_ACCENT;

  // Disposable WebGL wireframe preview, mounted once over the wordmark.
  const wireHost = useRef<HTMLDivElement>(null);
  const wireRef = useRef<MothershipWireframe | null>(null);
  useEffect(() => {
    const el = wireHost.current;
    if (!el) return;
    let engine: MothershipWireframe | null = null;
    try {
      engine = new MothershipWireframe(el);
      engine.start();
    } catch {
      engine = null; // No GL context — landing degrades to the wordmark only.
    }
    wireRef.current = engine;
    return () => {
      engine?.dispose();
      wireRef.current = null;
    };
  }, []);

  // Rebuild the wireframe for whichever faction is hovered.
  useEffect(() => {
    if (!hovered) return;
    void wireRef.current?.select(defForFaction(hovered), FACTION_ACCENT[hovered]);
  }, [hovered]);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#02040a] text-white">
      <Starfield />

      {/* Faction-tinted cursor comet that lives behind the content. */}
      <CursorParticles
        color={accent}
        stars={false}
        className="absolute inset-0 z-0 h-full w-full"
      />

      {/* Nebula glows */}
      <div className="pointer-events-none absolute -left-40 top-0 h-[42rem] w-[42rem] rounded-full bg-[#00d4ff]/10 blur-[140px]" />
      <div className="pointer-events-none absolute -right-32 bottom-[-6rem] h-[38rem] w-[38rem] rounded-full bg-[#7c4dff]/12 blur-[140px]" />

      {/* Grid horizon */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 opacity-30"
        style={{
          backgroundImage:
            "linear-gradient(rgba(0,212,255,0.18) 1px, transparent 1px), linear-gradient(90deg, rgba(0,212,255,0.12) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
          maskImage: "linear-gradient(to top, black, transparent)",
          WebkitMaskImage: "linear-gradient(to top, black, transparent)",
          transform: "perspective(420px) rotateX(62deg)",
          transformOrigin: "bottom",
        }}
      />

      {/* Vignette */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(2,4,10,0.85)_100%)]" />

      {/* Content */}
      <div className="relative z-10 flex h-full flex-col items-center justify-center px-6 text-center">
        <div className="text-[11px] uppercase tracking-[0.6em] text-[#00d4ff]/70">
          Online · Never-Ending · PvP
        </div>

        {/* Title stage — the CARRIER wordmark cross-fades into an animated
            wireframe build of the hovered faction's mothership. */}
        <div className="relative mt-5 h-64 w-full max-w-2xl sm:h-72">
          {/* Wordmark + tagline */}
          <div
            className="absolute inset-0 flex flex-col items-center justify-center transition-opacity duration-300"
            style={{ opacity: hovered ? 0 : 1 }}
          >
            <h1
              className="text-7xl font-black uppercase tracking-[0.32em] text-white sm:text-8xl"
              style={{ textShadow: "0 0 40px rgba(0,212,255,0.55), 0 0 90px rgba(0,212,255,0.25)" }}
            >
              Carrier
            </h1>
            <p className="mt-5 max-w-xl text-sm leading-relaxed text-white/55 sm:text-base">
              Command a base-building mothership, choose your faction, and fight
              for the galaxy in a persistent, always-on war among the stars.
            </p>
          </div>

          {/* Wireframe construction preview */}
          <div
            className="absolute inset-0 flex flex-col items-center justify-center transition-opacity duration-300"
            style={{ opacity: hovered ? 1 : 0 }}
            aria-hidden={!hovered}
          >
            <div ref={wireHost} className="h-44 w-full sm:h-52" />
            <div
              className="mt-2 text-xs font-bold uppercase tracking-[0.4em] transition-colors"
              style={{ color: accent, textShadow: `0 0 24px ${accent}88` }}
            >
              {hovered ? FACTIONS[hovered].name : ""}
            </div>
            <div className="mt-1 text-[10px] uppercase tracking-[0.3em] text-white/45">
              {hovered ? `${defForFaction(hovered).name} · Constructing` : ""}
            </div>
          </div>
        </div>

        {/* Faction emblem signature */}
        <div className="mt-9 flex items-end justify-center gap-7">
          {FACTION_ORDER.map((id) => {
            const f = FACTIONS[id];
            return (
              <button
                key={id}
                type="button"
                onMouseEnter={() => setHovered(id)}
                onMouseLeave={() => setHovered((cur) => (cur === id ? null : cur))}
                onFocus={() => setHovered(id)}
                onBlur={() => setHovered((cur) => (cur === id ? null : cur))}
                onClick={onPlay}
                aria-label={`${f.name} — enter hangar`}
                className="group flex flex-col items-center gap-2.5 outline-none"
              >
                <FactionEmblem
                  faction={id}
                  size={96}
                  pad={16}
                  active={hovered === id}
                  color={f.color}
                  className="transition-transform duration-200 group-hover:-translate-y-1 group-hover:scale-105 group-focus-visible:-translate-y-1"
                />
                <span
                  className="text-[10px] uppercase tracking-widest transition-colors"
                  style={{ color: hovered === id ? f.color : "rgba(255,255,255,0.4)" }}
                >
                  {f.name}
                </span>
              </button>
            );
          })}
        </div>

        <button
          onClick={onPlay}
          className="group mt-11 rounded-md border-2 border-[#00d4ff] bg-[#00d4ff]/10 px-12 py-3.5 text-sm font-bold uppercase tracking-[0.32em] text-[#00d4ff] transition-all hover:bg-[#00d4ff]/25 hover:shadow-[0_0_30px_rgba(0,212,255,0.4)]"
        >
          Enter Hangar
          <span className="ml-3 inline-block transition-transform group-hover:translate-x-1">
            →
          </span>
        </button>

        {/* Workbench: import / preview your own ship models, slot by slot. */}
        <button
          onClick={() => { window.location.search = "?shipyard"; }}
          className="mt-4 text-[11px] font-semibold uppercase tracking-[0.3em] text-white/45 transition-colors hover:text-[#00d4ff]"
        >
          Shipyard — replace ships
        </button>
      </div>

      <footer className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-between px-8 py-4 text-[10px] uppercase tracking-widest text-white/25">
        <span>Carrier Command</span>
        <span>Authoritative · Deterministic Netcode</span>
      </footer>
    </div>
  );
}
