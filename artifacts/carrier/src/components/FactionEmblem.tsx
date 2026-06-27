/**
 * FactionEmblem — a faction crest rendered as a glowing circular avatar badge.
 *
 * The transparent emblem art (see factionEmblems.ts) is masked into a circle,
 * zoomed slightly so stray edge text is cropped, and framed by a faction-colour
 * ring + radial glow with a glassy rim highlight. Used everywhere a faction
 * needs to read at a glance: landing screen, hangar rail/lore, in-game HUD.
 */
import type { FactionId } from "@workspace/carrier-net";
import { FACTIONS } from "@workspace/carrier-net";
import { FACTION_EMBLEMS } from "../game/factionEmblems";

export function FactionEmblem({
  faction,
  size = 48,
  active = false,
  color,
  glow = true,
  pad = 0,
  className = "",
}: {
  faction: FactionId;
  /** Pixel diameter of the badge. */
  size?: number;
  /** Brighter ring + stronger glow (selected / focused state). */
  active?: boolean;
  /** Override the faction accent colour (defaults to FACTIONS[faction].color). */
  color?: string;
  glow?: boolean;
  /**
   * Inset (px) of the emblem art from the ring. `0` (default) keeps the
   * art edge-to-edge + zoomed (cover) so stray edge text is cropped. A positive
   * value floats the full art inside the ring (contain) so it breathes — used
   * on the larger landing badges.
   */
  pad?: number;
  className?: string;
}) {
  const c = color ?? FACTIONS[faction].color;
  const src = FACTION_EMBLEMS[faction];
  const inner = Math.max(0, size - pad * 2);
  return (
    <span
      className={`relative inline-grid shrink-0 place-items-center overflow-hidden rounded-full ${className}`}
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle at 50% 36%, ${c}26, #05080f 72%)`,
        border: `${Math.max(1.5, size * 0.04)}px solid ${active ? c : `${c}99`}`,
        boxShadow: glow
          ? `0 0 ${active ? size * 0.45 : size * 0.2}px ${c}${active ? "aa" : "55"}, inset 0 0 ${size * 0.28}px #000000aa`
          : `inset 0 0 ${size * 0.28}px #000000aa`,
        transition: "box-shadow .2s ease, border-color .2s ease, transform .2s ease",
      }}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        className="rounded-full"
        style={{
          width: inner,
          height: inner,
          objectFit: pad > 0 ? "contain" : "cover",
          transform: pad > 0 ? "none" : "scale(1.16)",
          objectPosition: "50% 47%",
          filter: `drop-shadow(0 0 ${pad > 0 ? 6 : 3}px ${c}66)`,
        }}
      />
      {/* glassy rim highlight */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{
          background:
            "radial-gradient(circle at 32% 22%, rgba(255,255,255,0.3), transparent 44%)",
          mixBlendMode: "screen",
        }}
      />
    </span>
  );
}
