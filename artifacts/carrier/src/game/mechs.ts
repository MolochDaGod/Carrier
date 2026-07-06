/**
 * Starter mech roster — the hero hull every commander pilots.
 *
 * Three standard frames (light / balanced / heavy), all unlocked from the first
 * hangar visit. The centre showcase and in-match fighter both render these hulls
 * (faction-tinted); `?shipyard` / the hangar cog upload overrides the hull slot
 * per device via IndexedDB — the "mech builder" path.
 *
 * `shipType` on the wire is 0..2 for these mechs. The legacy 0..5 mothership
 * class index still exists server-side for carrier stats; only the fighter hull
 * and hangar presentation use this roster.
 */
import { CLASS_STAT_CARDS, type ShipStatCard } from "@workspace/carrier-net";
import type { ShipModel } from "./factionAssets";

export const STARTER_MECH_COUNT = 3;

export interface MechDef {
  /** 0..2 — sent as `shipType` on join. */
  id: number;
  name: string;
  tagline: string;
  role: string;
  /** Default catalog hull (path under `lib/assets/models/` minus extension). */
  hull: string;
  accent: string;
  /** Showcase + in-world fit multiplier. */
  hullScale: number;
  /** Optional forced Y-rotation (radians); omit for taper auto-orient. */
  yaw?: number;
  stats: ShipStatCard;
  special: string;
  perks: string[];
  flaws: string[];
  description: string;
}

export const STARTER_MECHS: MechDef[] = [
  {
    id: 0,
    name: "Vanguard",
    tagline: "First in, first out",
    role: "Light Mech",
    hull: "vehicles/space/fighters/fighter-player",
    yaw: Math.PI,
    accent: "#88ff00",
    hullScale: 0.88,
    stats: CLASS_STAT_CARDS[1],
    special: "Slipstream — highest speed and turn rate; built to dart in, tag targets, and peel off.",
    perks: [
      "Fastest frame in the starter trio",
      "Tightest turn rate for dogfighting",
      "Low credit cost to replace",
    ],
    flaws: [
      "Light armour — needs escort drones in a brawl",
      "Modest weapon output vs heavy frames",
    ],
    description:
      "The default strike mech. Nimble, readable at range, and the frame most " +
      "commanders learn on. Swap the hull in the Shipyard when you want a custom silhouette.",
  },
  {
    id: 1,
    name: "Lancer",
    tagline: "Hold the middle ground",
    role: "Standard Mech",
    hull: "vehicles/space/fighters/interceptor/interceptor",
    accent: "#00d4ff",
    hullScale: 1.0,
    stats: CLASS_STAT_CARDS[2],
    special: "Balanced battery — trades a little speed for shields and sustained fire.",
    perks: [
      "Even mix of speed, armour, and firepower",
      "Reliable in solo sorties and fleet escort",
      "Good default for new players",
    ],
    flaws: [
      "Not the fastest or the toughest",
      "Jack-of-all-trades profile",
    ],
    description:
      "The workhorse mech. Enough punch to hold a lane, enough hull to survive a " +
      "mistake, and the middle pick when you are not sure what the match needs.",
  },
  {
    id: 2,
    name: "Titan",
    tagline: "Anchor the line",
    role: "Heavy Mech",
    hull: "vehicles/space/bombers/bomber/bomber",
    accent: "#ffd23f",
    hullScale: 1.12,
    stats: CLASS_STAT_CARDS[4],
    special: "Siege frame — heavy cannons and thick plating; slow but decisive.",
    perks: [
      "Strongest shields and armour of the trio",
      "Highest burst damage",
      "Intimidating silhouette at range",
    ],
    flaws: [
      "Slow acceleration and wide turns",
      "Easier target for fast interceptors",
    ],
    description:
      "The siege mech. You feel every tonne in the turn rate, but when you commit " +
      "to a target it stays committed. Pair with scout drones for coverage.",
  },
];

/** Clamp a hangar / wire `shipType` to the starter mech band (0..2). */
export function clampMechType(shipType: number): number {
  const n = shipType | 0;
  if (n < 0) return 0;
  if (n >= STARTER_MECH_COUNT) return STARTER_MECH_COUNT - 1;
  return n;
}

/** Lookup a starter mech by `shipType` (wrapped into 0..2). */
export function mechFor(shipType: number): MechDef {
  return STARTER_MECHS[clampMechType(shipType)];
}

/** Catalog model for the live render path (fighter + hangar showcase). */
export function mechModelFor(shipType: number): ShipModel {
  const m = mechFor(shipType);
  return m.yaw !== undefined ? { id: m.hull, yaw: m.yaw } : { id: m.hull };
}