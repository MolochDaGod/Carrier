/**
 * Mothership roster for the Carrier landing showcase.
 *
 * Six motherships, indexed 0..5 to line up with the netcode `shipType`.  Every
 * mothership shares the same hull platform + turret-system architecture, but the
 * turret LOADOUT differs by role:
 *   - Scout / Cruiser / Dreadnought  → combat turrets (offensive line).
 *   - Miner / Corsair / Frigate      → resource + defensive-healing turrets.
 *
 * This is presentation + design data only (perks, flaws, turret mounts, accent).
 * Flight physics live in @workspace/carrier-net.
 */

import { CLASS_STAT_CARDS, type FactionId, type ShipStatCard } from "@workspace/carrier-net";

/**
 * Client-only MUTED faction accent palette for the 3D preview screens (hangar
 * showcase + landing wireframe).
 *
 * The shared `@workspace/carrier-net` `FACTIONS[id].color` values are bright neon
 * hues tuned for in-match HUD/intro readability and MUST NOT change (they drive
 * netcode-facing UI). Here we keep a separate, desaturated + slightly darkened
 * derivation of each so the lit GLB hulls read like real painted metal with a
 * subtle faction trim instead of a glowing neon wash. These are hand-derived from
 * the neon hues (no image-decode lib is available to sample the texture atlases
 * offline); each tone keeps the faction's hue family but pulls saturation and
 * value toward a muted, gunmetal-friendly accent.
 */
export const FACTION_ACCENT: Record<FactionId, string> = {
  scavengers: "#b85c4e", // neon #ff4d4d → rusted red
  hollow: "#5d7fa6", // neon #4488ff → steel blue
  network: "#bfa052", // neon #ffd23f → brass gold
  brood: "#9479ad", // neon #c084fc → dusk violet
  prospector: "#6caa86", // neon #5dff9b → patina green
};

/** What a single turret mount on the platform is for. */
export type TurretRole = "combat" | "resource" | "healing";

/**
 * The six headline stats shown on every ship in the hangar, each on a 0..100
 * scale.  This is now a re-export of the shared `ShipStatCard` from
 * `@workspace/carrier-net`: the SAME numbers the deterministic sim derives its
 * real combat behaviour from (armour, weapon damage, shield regen, fire cadence),
 * so the dossier the player reads is exactly what the ship does in a match.
 */
export type ShipStats = ShipStatCard;

export interface StatMeta {
  key: keyof ShipStats;
  label: string;
  color: string;
}

/** Display order + accent colour for the stat bars. */
export const STAT_META: StatMeta[] = [
  { key: "speed", label: "Speed", color: "#88ff00" },
  { key: "defense", label: "Defense", color: "#c084fc" },
  { key: "attack", label: "Attack", color: "#ff5d5d" },
  { key: "shield", label: "Shield", color: "#00d4ff" },
  { key: "explosive", label: "Explosive", color: "#ff9d3f" },
  { key: "drones", label: "Drones", color: "#5dff9b" },
];

export interface TurretMount {
  /** Catalog id of the turret GLB to mount. */
  model: "props/carrier/turret-gun" | "props/carrier/turret-cannon";
  role: TurretRole;
  label: string;
}

/** Build tier — higher hulls unlock as the mothership is upgraded. */
export type ShipTier = 1 | 2 | 3;

export interface MothershipDef {
  /** 0..5 — matches the netcode shipType. */
  id: number;
  /** Build tier (1 = buildable from the start). */
  tier: ShipTier;
  name: string;
  tagline: string;
  /** Short role label, e.g. "Resource Harvester". */
  role: string;
  /**
   * Catalog id of this class's OWN hull GLB (path under `lib/assets/models/`
   * minus extension). Each mothership class points at a visually distinct hull
   * so the showcase silhouette changes between classes — the faction tint, hull
   * scale, and turret loadout are layered on top of this base hull. Pinned by
   * `factionAssets.test.ts`; a wrong id silently degrades to the procedural
   * fallback, so keep it resolvable.
   */
  hull: string;
  accent: string;
  /** Relative hull scale for the showcase (visual only). */
  hullScale: number;
  perks: string[];
  flaws: string[];
  /** Headline 0..100 stat bars for the hangar. */
  stats: ShipStats;
  /** One-line signature ability shown in the dossier. */
  special: string;
  turrets: TurretMount[];
  description: string;
}

const COMBAT_GUN: TurretMount = {
  model: "props/carrier/turret-gun",
  role: "combat",
  label: "Rapid Pulse Turret",
};
const COMBAT_CANNON: TurretMount = {
  model: "props/carrier/turret-cannon",
  role: "combat",
  label: "Heavy Cannon",
};
const RESOURCE_TURRET: TurretMount = {
  model: "props/carrier/turret-gun",
  role: "resource",
  label: "Extraction Beam",
};
const HEALING_TURRET: TurretMount = {
  model: "props/carrier/turret-gun",
  role: "healing",
  label: "Repair Projector",
};

export const MOTHERSHIPS: MothershipDef[] = [
  {
    id: 0,
    tier: 1,
    name: "Miner",
    tagline: "Strip a system to the bedrock",
    role: "Resource Harvester",
    hull: "vehicles/space/capital/destroyer-02",
    accent: "#00d4ff",
    hullScale: 0.9,
    perks: [
      "Twin extraction beams absorb asteroid ore at range",
      "Largest cargo hold in the fleet",
      "Cheapest to field and replace",
    ],
    flaws: [
      "Almost no offensive punch",
      "Sluggish — easy prey without an escort",
    ],
    stats: CLASS_STAT_CARDS[0],
    special:
      "Ore Siphon — twin extraction beams strip asteroids at long range and " +
      "feed the fleet's largest cargo hold.",
    turrets: [RESOURCE_TURRET, RESOURCE_TURRET, HEALING_TURRET],
    description:
      "The backbone of any operation. The Miner extends cones of light onto " +
      "nearby rocks and drinks them dry, feeding ore back to the fleet. Bring " +
      "friends — it cannot defend itself.",
  },
  {
    id: 1,
    tier: 1,
    name: "Scout",
    tagline: "First in, first to know",
    role: "Recon Skirmisher",
    hull: "vehicles/space/raiders/swordfish",
    accent: "#88ff00",
    hullScale: 0.8,
    perks: [
      "Fastest hull and tightest turn rate",
      "Rapid-pulse combat turret for hit-and-run",
      "Widest sensor sweep — spots enemy pockets early",
    ],
    flaws: [
      "Paper-thin armour",
      "No resource or repair systems",
    ],
    stats: CLASS_STAT_CARDS[1],
    special:
      "Wide Sweep — the broadest sensor range in the fleet reveals enemy " +
      "pockets early, paired with the tightest turn rate for hit-and-run.",
    turrets: [COMBAT_GUN],
    description:
      "A lean recon hull built to find trouble before it finds you. Shares the " +
      "fleet's standard combat turret with the Cruiser and Dreadnought, but " +
      "trades all armour and utility for raw speed.",
  },
  {
    id: 2,
    tier: 2,
    name: "Corsair",
    tagline: "Take what you need, mend what you can",
    role: "Raider / Salvager",
    hull: "vehicles/space/capital/cruiser-03",
    accent: "#ff6b35",
    hullScale: 1.0,
    perks: [
      "Extraction beam doubles as a salvage cutter",
      "Defensive repair projector keeps it in the fight",
      "Balanced speed and durability",
    ],
    flaws: [
      "Jack of all trades, master of none",
      "Light combat output against true warships",
    ],
    stats: CLASS_STAT_CARDS[2],
    special:
      "Salvage Cutter — loots reward caches and patches its own hull in the " +
      "middle of an engagement.",
    turrets: [RESOURCE_TURRET, HEALING_TURRET],
    description:
      "A self-sufficient raider that loots reward caches and patches its own " +
      "hull mid-engagement. Carries resource and defensive-healing turrets " +
      "rather than the heavy combat line.",
  },
  {
    id: 3,
    tier: 2,
    name: "Frigate",
    tagline: "Keep the fleet alive",
    role: "Support / Repair",
    hull: "vehicles/space/capital/destroyer-01",
    accent: "#c084fc",
    hullScale: 1.15,
    perks: [
      "Dual repair projectors mend nearby allies",
      "Sturdy hull holds the line",
      "Extraction beam tops up the supply chain",
    ],
    flaws: [
      "Modest top speed",
      "Relies on escorts for offence",
    ],
    stats: CLASS_STAT_CARDS[3],
    special:
      "Aegis Projector — dual repair beams mend nearby allies and top up the " +
      "fleet's supply chain.",
    turrets: [HEALING_TURRET, HEALING_TURRET, RESOURCE_TURRET],
    description:
      "The fleet medic. The Frigate projects repair beams across allied ships " +
      "and feeds the supply line, fielding defensive-healing and resource " +
      "turrets instead of the combat loadout.",
  },
  {
    id: 4,
    tier: 2,
    name: "Cruiser",
    tagline: "The line that does not break",
    role: "Battle Cruiser",
    hull: "vehicles/space/capital/cruiser-01",
    accent: "#ffd23f",
    hullScale: 1.3,
    perks: [
      "Mixed combat battery: pulse turrets and a heavy cannon",
      "Strong armour and shields",
      "Effective at every engagement range",
    ],
    flaws: [
      "Expensive to field",
      "No resource or repair utility",
    ],
    stats: CLASS_STAT_CARDS[4],
    special:
      "All-Range Battery — mixed pulse turrets and a heavy cannon stay " +
      "effective at every engagement range.",
    turrets: [COMBAT_GUN, COMBAT_CANNON, COMBAT_GUN],
    description:
      "The workhorse warship. The Cruiser fields the shared combat turret line " +
      "alongside a heavy cannon, trading all utility for a balanced, " +
      "all-range battle platform.",
  },
  {
    id: 5,
    tier: 3,
    name: "Dreadnought",
    tagline: "Bring a fleet, or bring nothing",
    role: "Capital Warship",
    hull: "vehicles/space/capital/cruiser-02",
    accent: "#ff5d8f",
    hullScale: 1.6,
    perks: [
      "Quad heavy cannons — the heaviest firepower in the game",
      "Capital-grade armour soaks enormous damage",
      "Anchors a battle line single-handed",
    ],
    flaws: [
      "Ponderously slow and wide turning",
      "No resource or repair systems — pure war machine",
    ],
    stats: CLASS_STAT_CARDS[5],
    special:
      "Capital Barrage — quad heavy cannons deliver the heaviest firepower in " +
      "the game behind capital-grade armour.",
    turrets: [COMBAT_CANNON, COMBAT_CANNON, COMBAT_CANNON, COMBAT_GUN],
    description:
      "The apex of the combat line, sharing its turret family with the Scout " +
      "and Cruiser but scaled to capital class. Slow, colossal, and built to " +
      "end engagements before they start.",
  },
];

/** Short role badge colour by turret role. */
export const TURRET_ROLE_COLOR: Record<TurretRole, string> = {
  combat: "#ff5d5d",
  resource: "#00d4ff",
  healing: "#5dff9b",
};
