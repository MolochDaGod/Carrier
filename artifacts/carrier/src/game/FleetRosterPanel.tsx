/**
 * FleetRosterPanel — mounts a `FleetRosterShowcase` and overlays per-class
 * labels in a CSS grid that mirrors the showcase's row-major scissor layout, so
 * the deployable fleet classes read as real 3D previews instead of a text list.
 */
import { useEffect, useRef } from "react";
import { factionFleetShip, type FactionId } from "@workspace/carrier-net";
import {
  FleetRosterShowcase,
  ROSTER_COLS,
  ROSTER_ROWS,
  ROSTER_ROLES,
} from "./FleetRosterShowcase";

function fleetLabel(faction: FactionId, role: string): string {
  const authored = factionFleetShip(faction, role as (typeof ROSTER_ROLES)[number]);
  return authored?.codename ?? role.charAt(0).toUpperCase() + role.slice(1);
}

export function FleetRosterPanel({
  faction,
  color,
}: {
  faction: FactionId;
  color: string;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const showcaseRef = useRef<FleetRosterShowcase | null>(null);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const showcase = new FleetRosterShowcase(el);
    showcaseRef.current = showcase;
    showcase.start();
    return () => {
      showcase.dispose();
      showcaseRef.current = null;
    };
  }, []);

  useEffect(() => {
    void showcaseRef.current?.setFaction(faction);
  }, [faction]);

  return (
    <div
      className="relative w-full overflow-hidden rounded-md border border-white/10 bg-black/30"
      style={{ aspectRatio: "2 / 2.4" }}
    >
      <div ref={mountRef} className="absolute inset-0" />
      <div
        className="pointer-events-none absolute inset-0 grid"
        style={{
          gridTemplateColumns: `repeat(${ROSTER_COLS}, 1fr)`,
          gridTemplateRows: `repeat(${ROSTER_ROWS}, 1fr)`,
        }}
      >
        {ROSTER_ROLES.map((role) => (
          <div
            key={role}
            className="relative flex flex-col items-center justify-end gap-0.5 border border-white/5 pb-1.5"
          >
            <span
              className="rounded-sm bg-black/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]"
              style={{ color }}
            >
              {fleetLabel(faction, role)}
            </span>
            <span className="text-[8px] uppercase tracking-[0.22em] text-white/30">{role}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
