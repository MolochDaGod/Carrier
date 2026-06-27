/**
 * HangarAtmosphere — the "inside a space station" backdrop for the hangar.
 *
 * Three stacked, pointer-events-free layers that sit BEHIND the hangar UI
 * (the WebGL ship showcase renders with alpha:true, so this shows through):
 *   1. a looping screen-recording played at 0.9x as the view "out the viewport";
 *   2. a viewport frame — vignette, scanlines, corner brackets, glass glare and
 *      a faction-tinted edge glow — so it reads like a reinforced station window;
 *   3. a cursor-following "space particle" canvas (an endless-space restyle of
 *      the C4RL05/Lights cursor-light idea): a comet head eases toward the
 *      pointer trailing glowing motes, over a slow drifting starfield with the
 *      odd shooting star.
 *
 * `color` is the active faction accent, used to tint the glow + particle hues.
 */
import { useEffect, useRef } from "react";
import viewportClip from "@assets/Screen_Recording_2026-06-11_174733_1781222553965.mp4";
import { CursorParticles } from "./CursorParticles";

export function HangarAtmosphere({ color = "#00d4ff" }: { color?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Lock the loop to 0.9x — browsers occasionally reset rate on (re)play.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const apply = () => {
      v.playbackRate = 0.9;
    };
    apply();
    v.addEventListener("play", apply);
    v.addEventListener("loadedmetadata", apply);
    // Autoplay can be rejected until the SDK settles; retry quietly.
    void v.play().catch(() => {});
    return () => {
      v.removeEventListener("play", apply);
      v.removeEventListener("loadedmetadata", apply);
    };
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* 1. Viewport feed */}
      <video
        ref={videoRef}
        src={viewportClip}
        muted
        loop
        autoPlay
        playsInline
        className="absolute inset-0 h-full w-full object-cover opacity-55"
        style={{ filter: "saturate(1.1) contrast(1.05) brightness(0.85)" }}
      />

      {/* 2. Depth + readability washes */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(4,6,15,0.55) 0%, rgba(4,6,15,0.15) 35%, rgba(4,6,15,0.25) 65%, rgba(4,6,15,0.78) 100%)",
        }}
      />
      <div
        className="absolute inset-0"
        style={{ background: `radial-gradient(ellipse at 50% 42%, ${color}1a, transparent 62%)` }}
      />

      {/* 3. Space particle follower */}
      <CursorParticles color={color} trailMode="dark" className="absolute inset-0 h-full w-full" />

      {/* 4. Viewport frame — scanlines, vignette, glass glare, brackets */}
      <div
        className="absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(255,255,255,0.6) 0px, rgba(255,255,255,0.6) 1px, transparent 1px, transparent 3px)",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(115deg, rgba(255,255,255,0.10) 0%, transparent 22%, transparent 78%, rgba(255,255,255,0.05) 100%)",
          mixBlendMode: "screen",
        }}
      />
      <div className="absolute inset-0 shadow-[inset_0_0_180px_60px_rgba(2,4,10,0.92)]" />
      <div
        className="absolute inset-3 rounded-2xl border"
        style={{ borderColor: `${color}26`, boxShadow: `inset 0 0 60px ${color}14` }}
      />
      <ViewportBrackets color={color} />
    </div>
  );
}

function ViewportBrackets({ color }: { color: string }) {
  const common = "absolute h-10 w-10 opacity-60";
  const b = `2px solid ${color}80`;
  return (
    <>
      <span className={`${common} left-4 top-4`} style={{ borderLeft: b, borderTop: b, borderTopLeftRadius: 10 }} />
      <span className={`${common} right-4 top-4`} style={{ borderRight: b, borderTop: b, borderTopRightRadius: 10 }} />
      <span className={`${common} left-4 bottom-4`} style={{ borderLeft: b, borderBottom: b, borderBottomLeftRadius: 10 }} />
      <span className={`${common} right-4 bottom-4`} style={{ borderRight: b, borderBottom: b, borderBottomRightRadius: 10 }} />
    </>
  );
}
