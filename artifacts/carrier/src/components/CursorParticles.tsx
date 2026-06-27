/**
 * CursorParticles — a pointer-following "space comet" canvas.
 *
 * An endless-space restyle of the C4RL05/Lights cursor-light idea: a comet head
 * eases toward the pointer, trailing glowing motes, with an optional drifting
 * starfield + the odd shooting star.  Pure 2D canvas, pointer-events-free, and
 * fully self-contained so it can sit BEHIND any UI.
 *
 * `color` is the accent hue and may change at any time (e.g. the hovered
 * faction colour) — it is read from a ref each frame so the comet recolours
 * live without tearing down the animation loop.
 *
 * `trailMode`:
 *   - "transparent" (default): fades prior frames via destination-out so the
 *     canvas stays see-through (whatever is behind shows between the motes).
 *   - "dark": paints a translucent space-wash each frame, for use as an opaque
 *     backdrop layer (the hangar viewport).
 *
 * `stars` toggles the ambient starfield + shooting stars (off when something
 * else already owns the star bed, leaving only the mouse animation).
 */
import { useEffect, useRef } from "react";

export function CursorParticles({
  color = "#00d4ff",
  className = "",
  trailMode = "transparent",
  stars = true,
}: {
  color?: string;
  className?: string;
  trailMode?: "transparent" | "dark";
  stars?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const colorRef = useRef(color);
  const trailRef = useRef(trailMode);
  const starsRef = useRef(stars);

  useEffect(() => {
    colorRef.current = color;
  }, [color]);
  useEffect(() => {
    trailRef.current = trailMode;
  }, [trailMode]);
  useEffect(() => {
    starsRef.current = stars;
  }, [stars]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = 0;
    let h = 0;
    let dpr = 1;

    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Drifting background stars for the "endless space" bed.
    type Star = { x: number; y: number; z: number; tw: number };
    const starField: Star[] = Array.from({ length: 90 }, () => ({
      x: Math.random(),
      y: Math.random(),
      z: 0.3 + Math.random() * 0.7,
      tw: Math.random() * Math.PI * 2,
    }));

    // Cursor-trailing motes.
    type Mote = {
      x: number;
      y: number;
      vx: number;
      vy: number;
      life: number;
      max: number;
      size: number;
      hot: number; // 0 = faction hue, 1 = white-hot core
    };
    const motes: Mote[] = [];
    const MAX_MOTES = 260;

    // Eased comet head that chases the pointer.
    let mx = -9999;
    let my = -9999;
    let hx = -9999;
    let hy = -9999;
    let seenPointer = false;

    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      mx = e.clientX - r.left;
      my = e.clientY - r.top;
      if (!seenPointer) {
        hx = mx;
        hy = my;
        seenPointer = true;
      }
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    const spawn = (x: number, y: number, n: number, speed: number) => {
      for (let i = 0; i < n; i++) {
        if (motes.length >= MAX_MOTES) break;
        const a = Math.random() * Math.PI * 2;
        const sp = speed * (0.2 + Math.random() * 0.9);
        const max = 50 + Math.random() * 60;
        motes.push({
          x: x + (Math.random() - 0.5) * 6,
          y: y + (Math.random() - 0.5) * 6,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: 0,
          max,
          size: 0.8 + Math.random() * 2.4,
          hot: Math.random(),
        });
      }
    };

    let shootT = 120 + Math.random() * 300;
    let raf = 0;
    let last = performance.now();

    const frame = (now: number) => {
      const dt = Math.min(2.5, (now - last) / 16.67);
      last = now;

      const rgb = hexToRgb(colorRef.current);
      const tint = `${rgb.r},${rgb.g},${rgb.b}`;

      // Fade the previous frame for soft trails.
      if (trailRef.current === "dark") {
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = "rgba(4,6,15,0.30)";
        ctx.fillRect(0, 0, w, h);
      } else {
        // Erase prior pixels' alpha so the canvas stays transparent.
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = "rgba(0,0,0,0.16)";
        ctx.fillRect(0, 0, w, h);
      }

      ctx.globalCompositeOperation = "lighter";

      // Drifting starfield.
      if (starsRef.current) {
        for (const s of starField) {
          s.x -= 0.00018 * s.z * dt;
          if (s.x < -0.02) s.x = 1.02;
          s.tw += 0.03 * dt;
          const px = s.x * w;
          const py = s.y * h;
          const tw = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(s.tw));
          const r = s.z * 1.3;
          ctx.fillStyle = `rgba(150,200,255,${0.25 * tw * s.z})`;
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fill();
        }

        // Occasional shooting star streaking across the void.
        shootT -= dt;
        if (shootT <= 0) {
          shootT = 260 + Math.random() * 520;
          const sx = Math.random() * w * 0.6;
          const sy = Math.random() * h * 0.5;
          const ang = Math.PI * (0.12 + Math.random() * 0.12);
          for (let i = 0; i < 14; i++) {
            motes.push({
              x: sx + Math.cos(ang) * i * 9,
              y: sy + Math.sin(ang) * i * 9,
              vx: Math.cos(ang) * 6,
              vy: Math.sin(ang) * 6,
              life: 0,
              max: 26 + i,
              size: 1.6,
              hot: 0.9,
            });
          }
        }
      }

      // Comet head eases toward the pointer; emit motes along its travel.
      if (seenPointer) {
        const ex = mx - hx;
        const ey = my - hy;
        hx += ex * 0.18 * dt;
        hy += ey * 0.18 * dt;
        const moved = Math.hypot(ex, ey);
        const emit = Math.min(10, 1 + Math.floor(moved * 0.25));
        spawn(hx, hy, emit, Math.min(3.5, 0.6 + moved * 0.05));

        // Bright core glow at the head.
        const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, 26);
        g.addColorStop(0, `rgba(255,255,255,0.55)`);
        g.addColorStop(0.3, `rgba(${tint},0.45)`);
        g.addColorStop(1, `rgba(${tint},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(hx, hy, 26, 0, Math.PI * 2);
        ctx.fill();
      }

      // Update + draw motes.
      for (let i = motes.length - 1; i >= 0; i--) {
        const m = motes[i];
        m.life += dt;
        if (m.life >= m.max) {
          motes.splice(i, 1);
          continue;
        }
        m.x += m.vx * dt;
        m.y += m.vy * dt;
        m.vx *= 0.96;
        m.vy *= 0.96;
        const t = 1 - m.life / m.max;
        const a = t * t;
        const r = m.size * (0.5 + t);
        const cr = Math.round(255 * (0.5 + 0.5 * m.hot) + rgb.r * (0.5 - 0.5 * m.hot));
        const cg = Math.round(255 * (0.5 + 0.5 * m.hot) + rgb.g * (0.5 - 0.5 * m.hot));
        const cb = Math.round(255 * (0.5 + 0.5 * m.hot) + rgb.b * (0.5 - 0.5 * m.hot));
        ctx.fillStyle = `rgba(${Math.min(255, cr)},${Math.min(255, cg)},${Math.min(255, cb)},${0.6 * a})`;
        ctx.beginPath();
        ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  return <canvas ref={canvasRef} className={`pointer-events-none ${className}`} />;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace("#", "");
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  const n = parseInt(h, 16);
  if (Number.isNaN(n) || h.length !== 6) return { r: 0, g: 212, b: 255 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
