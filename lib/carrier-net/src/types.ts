/**
 * Shared, dependency-free types + tunables for the Carrier game netcode.
 *
 * Carrier-owned copy of the space-shooter netcode so Carrier can evolve
 * independently without touching Skyforge Squadron.  1 world unit = 1 metre.
 *
 * Scale reference (see also client-side scale.ts):
 *   miner   ≈  4 m   → SHIP.arena is 5 000 m radius
 *   attack  ≈ 40 m
 *   mothership ≈ 30× the largest other ship
 */

import { newUuid } from "./uuid";

export const TICK_HZ = 30;
export const SNAPSHOT_HZ = 20;
export const TICK_DT = 1 / TICK_HZ;

export const SHIP = {
  yawRate: 1.6,
  pitchRate: 1.4,
  rollRate: 2.4,
  thrustAccel: 90,
  maxSpeed: 90,
  boostMaxSpeed: 160,
  boostMult: 1.8,
  drag: 0.7,
  arena: 5000,
  maxHp: 100,
  /** Regenerating energy shield that soaks weapon + collision damage first. */
  maxShield: 60,
  respawnDelay: 3000,
} as const;

export const MOTHER_SHIP = {
  yawRate: 0.3,
  pitchRate: 0.2,
  rollRate: 0.4,
  thrustAccel: 20,
  maxSpeed: 20,
  boostMaxSpeed: 35,
  boostMult: 1.4,
  drag: 0.5,
  maxHp: 2000,
  /** Heavy capital shield bank. */
  maxShield: 1200,
  respawnDelay: 10000,
  scaleFactor: 8,
  /**
   * Functional defensive turrets: how many bolts the auto-turret salvo fires at
   * the nearest hostile.  Kept balance-capped — a mothership *displays* far more
   * cosmetic hull mounts (see `motherTurretVisualCount`) than it fires, so it
   * reads as bristling with guns without one salvo deleting everything in range.
   */
  turretSalvoBolts: 6,
  /** Distance (m) within which a mothership turret engages a hostile. */
  turretRange: 900,
  /** Ticks between mothership turret salvos. */
  turretFireCooldownTicks: Math.round(TICK_HZ * 1.1),
  /** Radius (m) of the hull mount circle the turret bolts originate from. */
  turretMountRadius: 90,
} as const;

export const FLEET_UNIT = {
  yawRate: 1.2,
  pitchRate: 1.0,
  rollRate: 1.8,
  thrustAccel: 60,
  maxSpeed: 70,
  boostMaxSpeed: 115,
  boostMult: 1.6,
  drag: 0.65,
  maxHp: 50,
  /** Fallback shield for a fleet unit with no role-specific bank. */
  maxShield: 25,
  respawnDelay: 5000,
} as const;

/**
 * Shield + collision model tunables.  The shield is a regenerating buffer that
 * absorbs incoming damage (weapon or collision grind) BEFORE the hull, then
 * recharges after a quiet period.  Collision grind chews shield/hull while two
 * hostile hulls overlap; `grindDps` is damage-per-second of contact, applied
 * deterministically per fixed tick.  All values are shared by the pure sim
 * (the model) and the server (the authority), so prediction never diverges.
 */
export const SHIELD = {
  /** Shield points regenerated per second once recharge resumes. */
  regenPerSec: 14,
  /** Quiet period (ms after the last damage) before a shield starts recharging. */
  regenDelayMs: 4000,
} as const;

export const COLLISION = {
  /** Hull/shield damage per second of overlap between two HOSTILE hulls. */
  grindDps: 36,
  /** Velocity bounce factor applied along the contact normal (0..1). */
  restitution: 0.35,
  /** Fraction of overlap resolved per tick (positional softness). */
  separation: 0.85,
} as const;

/**
 * Escort/summon command-AI tunables.  A summoned unit flies to a formation slot
 * beside the player's currently-controlled ship and protects it: it peels off to
 * attack a hostile that threatens either itself or the protected ship, then
 * returns to formation.  All consumed by the pure `escortIntent` brain.
 */
export const ESCORT = {
  /** Radius (m) around the protected ship within which threats are engaged. */
  guardRadius: 720,
  /** Distance (m) past which an escort lights its afterburner to catch up. */
  catchUpDist: 380,
  /** Base formation stand-off radius (m) from the protected ship. */
  formationR: 130,
} as const;

export const WEAPON = {
  cooldownMs: 180,
  projectileSpeed: 320,
  projectileLifeMs: 1600,
  damage: 12,
  hitRadius: 9,
  muzzleForward: 6,
} as const;

/** Player-fired homing missiles (RMB / secondary). Slower but heavier + guided. */
export const MISSILE = {
  cooldownMs: 1100,
  projectileSpeed: 195,
  projectileLifeMs: 4200,
  damage: 34,
  hitRadius: 16,
  muzzleForward: 10,
  /** How aggressively velocity steers toward the nearest hostile (1/s). */
  homingStrength: 4.2,
  /** Splash radius on detonation (m) — damages all hostiles in range once. */
  splashRadius: 42,
} as const;

export type ProjectileKind = "bolt" | "missile";

export const SHIP_TYPES = 6;

/**
 * Per-shipType role flags, indexed 0..5 to line up with the mothership roster
 * (Miner, Scout, Corsair, Frigate, Cruiser, Dreadnought).  Resource hulls emit
 * mining cones onto celestial rocks; combat hulls fire offensive lasers.  Kept
 * here (not in the client roster) so the authoritative server and the client
 * agree on which ships mine without the server importing client code.
 */
export const SHIP_IS_MINER: readonly boolean[] = [true, false, true, true, false, false];

export function isMinerShipType(shipType: number): boolean {
  return SHIP_IS_MINER[shipType] === true;
}

/**
 * Cosmetic hull-turret count a mothership of `shipType` bristles with (20–30).
 * Deterministic and purely visual — heavier capital classes carry more mounts.
 * The authoritative salvo always fires `MOTHER_SHIP.turretSalvoBolts`; this only
 * drives how many turret models the client studs across the hull.
 */
export function motherTurretVisualCount(shipType: number): number {
  const t = (((shipType | 0) % SHIP_TYPES) + SHIP_TYPES) % SHIP_TYPES;
  return 20 + Math.round((t / (SHIP_TYPES - 1)) * 10);
}

/** Collision radius (m) used when ships/enemies hit solid celestial bodies. */
export const SHIP_COLLIDE_RADIUS = 8;

/**
 * Fixed seed for the deterministic world (celestial bodies, reward boxes, enemy
 * pockets).  Generation NEVER reads wall-clock time — change this constant to
 * roll a different but still-reproducible layout.
 */
export const WORLD_SEED = 0x10b4c0de;

/** Tunables for physical celestial bodies (planets, comets, asteroids). */
export const CELESTIAL = {
  /** How many large planets to scatter through the arena. */
  planetCount: 5,
  /** Drifting comets (small, fast, long force tail). */
  cometCount: 6,
  /** Tumbling asteroids (medium, collide within their region). */
  asteroidCount: 20,
  /** Planet visual + collision radius range (m). */
  planetMinR: 200,
  planetMaxR: 1700,
  /** A planet at/under this radius counts as a "small planet" for enemy pockets. */
  smallPlanetR: 480,
  cometMinR: 14,
  cometMaxR: 42,
  asteroidMinR: 22,
  asteroidMaxR: 95,
  /** Gravity constant: accel = G * mass / dist^2 (mass ~ radius). */
  gravityG: 26,
  /** Push (repulsor) bodies shove ships outward at this base accel. */
  pushAccel: 70,
  /** Force reach as a multiple of body radius. */
  forceReachMult: 6,
  /** Half-extent (m) of the cubic region a moving body is confined to. */
  regionHalf: 2200,
  /** Speed range (m/s) for moving bodies. */
  moveSpeedMin: 8,
  moveSpeedMax: 30,
} as const;

/** Tunables for fly-through reward boxes. */
export const REWARD = {
  count: 12,
  /** Fly-through pickup radius (m). */
  radius: 34,
  /** Credits granted per pickup. */
  amount: 25,
  /** Ticks before a collected box reappears (tick-based, NOT wall-clock). */
  respawnTicks: TICK_HZ * 18,
} as const;

/** Tunables for pirate-fleet defenders garrisoning AI mining outposts. */
export const ENEMY = {
  /** Distance (m) within which a pirate will chase a target. */
  engageRange: 1100,
  /** Distance (m) within which an enemy opens fire. */
  fireRange: 520,
  /** Alignment (dot of forward·toTarget) required before firing. */
  fireAim: 0.95,
  /** Ticks between enemy shots (tick-based cooldown). */
  fireCooldownTicks: Math.round(TICK_HZ * 0.6),
  /** Ticks before a downed pocket enemy respawns at its home. */
  respawnTicks: TICK_HZ * 8,
  /** Enemy team id (players default to team 0). */
  team: 2,
  /**
   * Startup safe-window: ticks after a commander enters during which enemies
   * will not select or approach them (so nothing menaces a fresh mothership for
   * roughly the first minute). ~60s at TICK_HZ.
   */
  graceTicks: TICK_HZ * 60,
} as const;

/**
 * The "Pirate Dreadlord" world boss — a single oversized pirate capital ship
 * that loiters near the centre of the zone (0,0,0) as an always-on PvE event in
 * the never-ending PvP arena.  Any commander can attack it; when it is downed
 * every joined commander is paid a bounty and it respawns after a cooldown, so
 * the event never ends.  All timers are tick-based for determinism and the boss
 * is fully server-authoritative.
 */
export const BOSS = {
  /** Stable entity id for the world boss. */
  id: "boss_pirate",
  /** Hull type it flies (5 = Dreadnought, the largest combat hull). */
  shipType: 5,
  /** Visual + collision scale multiplier vs a normal hull (it reads as "larger"). */
  scale: 3,
  /** Boss hit points — a sustained group fight. */
  maxHp: 4000,
  /** Centre of the zone it loiters around. */
  cx: 0,
  cy: 0,
  cz: 0,
  /** Never strays further than this (m) from the centre. */
  leashRadius: 700,
  /** Distance (m) within which it selects + chases a target. */
  engageRange: 1700,
  /** Distance (m) within which it opens fire. */
  fireRange: 950,
  /** Alignment (dot of forward·toTarget) required before firing. */
  fireAim: 0.9,
  /** Ticks between boss shots (tick-based cooldown). */
  fireCooldownTicks: Math.round(TICK_HZ * 0.4),
  /** Ticks before the boss respawns after being downed (the event re-arms). */
  respawnTicks: TICK_HZ * 60,
  /** Bounty paid to EVERY joined commander when the boss is destroyed. */
  bounty: 600,
} as const;

/**
 * Tunables for AI mining outposts — the contestable objective "pings" players
 * fly to and fight for.  Each outpost is guarded by a small pirate fleet
 * (`garrison`) that is LEASHED to the outpost: pirates only wake when a player
 * comes within `alertRadius` of the outpost and never chase past `leashRadius`
 * of it, so there are no arena-wide random attacks.  Clearing the garrison
 * unlocks the outpost's reward cache; the outpost re-arms after
 * `contestRespawnTicks` so it can be contested again.  All seeded from
 * `WORLD_SEED`; all timers are tick-based.
 */
export const OUTPOST = {
  /** How many mining outposts to seed near asteroids. */
  count: 8,
  /** Default garrison size (tier overrides this per outpost). */
  garrison: 3,
  /** A player within this distance (m) of the outpost wakes its pirates. */
  alertRadius: 1300,
  /** Pirates never stray further than this (m) from their outpost centre. */
  leashRadius: 950,
  /** Ticks after a clear before the garrison respawns + the reward re-locks. */
  contestRespawnTicks: TICK_HZ * 45,
  /** Default reward (tier overrides this per outpost). */
  rewardAmount: 120,
  /** Default structure + collision radius (m) (tier overrides this). */
  radius: 70,
  /**
   * Difficulty tiers seeded across the map so missions are a spread of
   * easy→hard rather than identical pings.  Tougher tiers field larger pirate
   * garrisons, richer reward caches, and a bigger structure.  `weight` biases
   * the seeded mix (more skirmishes than strongholds).  Deterministic: the
   * server picks a tier per outpost from `WORLD_SEED`.
   */
  tiers: [
    { id: "skirmish", label: "Skirmish", garrison: 2, rewardAmount: 90, radius: 60, weight: 3 },
    { id: "raid", label: "Raid Camp", garrison: 4, rewardAmount: 180, radius: 78, weight: 2 },
    { id: "stronghold", label: "Stronghold", garrison: 6, rewardAmount: 320, radius: 96, weight: 1 },
  ],
} as const;

export type CelestialKind = "planet" | "comet" | "asteroid";
export type ForceKind = "gravity" | "push";

/**
 * A physical celestial body in the play space.  Planets are static anchors;
 * comets and asteroids drift and bounce within a cubic region and collide with
 * one another.  Every body exerts a gravity (pull) or push (repulsor) force on
 * ships inside `forceRadius`, and is a hard collision sphere of `radius`.  These
 * are server-authoritative and double as obstacles for future fleet pathfinding.
 */
export interface CelestialBody {
  id: string;
  kind: CelestialKind;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  /** Hard collision + visual radius (m). */
  radius: number;
  /** Force mass (gravity scales with this; ~radius). */
  mass: number;
  force: ForceKind;
  /** Outer reach of the body's force field (m). */
  forceRadius: number;
  /** Center of the cubic region a moving body is confined to. */
  rcx: number;
  rcy: number;
  rcz: number;
  /** Half-extent of that region (m). */
  rhalf: number;
  /** Stable per-body seed for client-side visual variety. */
  seed: number;
}

/** A glowing pickup box that grants bonus resources on fly-through. */
export interface RewardBox {
  id: string;
  px: number;
  py: number;
  pz: number;
  radius: number;
  amount: number;
  /** Inactive boxes are hidden + non-collectible until they respawn. */
  active: boolean;
}

/**
 * An AI mining outpost: a contestable objective ("ping") guarded by a small
 * pirate fleet.  Players fly to it, clear the garrison, and collect the reward
 * cache it protects.  Server-authoritative; sent every snapshot so clients can
 * render the beacon + HUD ping with live status.
 */
export interface Outpost {
  id: string;
  px: number;
  py: number;
  pz: number;
  /** Structure + collision radius (m). */
  radius: number;
  /** Distance (m) at which it counts as an active threat / wakes its pirates. */
  alertRadius: number;
  /** Pirate ships still alive defending it. */
  garrisonAlive: number;
  /** Total garrison size (for the HUD "alive / total" readout). */
  garrisonTotal: number;
  /** True once the garrison is wiped — its reward cache is unlocked. */
  cleared: boolean;
  /** Credits held in the reward cache this outpost guards. */
  rewardAmount: number;
  /** Stable per-outpost seed for client-side visual variety. */
  seed: number;
}

// ─── Build platforms ─────────────────────────────────────────────────────────

/**
 * The capability a build platform grants once tethered to a mothership.
 *  - `turret`     — an auto-firing weapon mount that engages nearby hostiles.
 *  - `production` — passive bonus to the commander's credit accrual rate.
 *  - `utility`    — a repair field that mends nearby owned units + the carrier.
 */
export type PlatformKind = "turret" | "production" | "utility";

/** Every buildable platform kind, in UI order. */
export const PLATFORM_KINDS: PlatformKind[] = ["turret", "production", "utility"];

/** Static definition of one buildable platform kind. */
export interface PlatformDef {
  kind: PlatformKind;
  label: string;
  /** Credit cost to build one. */
  cost: number;
  /** Short capability blurb for the build UI. */
  blurb: string;
}

export const PLATFORM_DEFS: Record<PlatformKind, PlatformDef> = {
  turret: {
    kind: "turret",
    label: "Turret",
    cost: 90,
    blurb: "Auto-fires on hostiles in range",
  },
  production: {
    kind: "production",
    label: "Production",
    cost: 110,
    blurb: "+6 cr/s while operational",
  },
  utility: {
    kind: "utility",
    label: "Utility",
    cost: 80,
    blurb: "Repairs nearby fleet + carrier",
  },
};

/** Tunables for build platforms tethered to the mothership. */
export const PLATFORM = {
  /** Hard cap on simultaneously-built platforms per commander. */
  maxPerPlayer: 6,
  /** Long-cable tether length (m) — the ring radius platforms sit at. */
  cableLength: 280,
  /** Vertical drop (m) below the mothership the platform ring hangs at. */
  offsetY: -36,
  /** Minimum ms a commander must wait between two builds. */
  buildCooldownMs: 700,
  /** Platform hull hit-points. */
  maxHp: 200,
  /** Turret engagement range (m). */
  turretRange: 760,
  /** Turret alignment is irrelevant (it auto-aims); cadence in ticks. */
  turretFireCooldownTicks: Math.round(TICK_HZ * 0.7),
  /** Extra credits/sec granted per production platform. */
  productionBonusPerSec: 6,
  /** HP/sec a utility platform restores to each owned unit in range. */
  utilityRepairPerSec: 5,
  /** Utility repair-field radius (m). */
  utilityRange: 540,
} as const;

/** Runtime guard for a buildable platform kind (own-properties only). */
export function isPlatformKind(kind: unknown): kind is PlatformKind {
  return typeof kind === "string" && Object.hasOwn(PLATFORM_DEFS, kind);
}

/** Resolve a platform definition; `null` for unknown input. */
export function platformDef(kind: unknown): PlatformDef | null {
  return isPlatformKind(kind) ? PLATFORM_DEFS[kind] : null;
}

/**
 * Whether a unit of this kind/role may be connected by a structural cable.
 * Cables are the structural link for PLATFORMS, mechs, and miner landing/docking
 * ONLY — never for combat ships.  The server consults this before accepting any
 * tether so a combat unit can never be cabled.  Motherships are anchors (cables
 * attach TO them), not tethered cargo, so they return false here.
 */
export function isTetherableKind(kind: EntityKind, role: FleetRole = "none"): boolean {
  if (kind === "fleet_unit") return role === "miner"; // miner docking only
  return false; // fighters / combat units / motherships are not tethered cargo
}

/**
 * An authoritative build platform tethered to a mothership by a long cable.
 * Server-owned; clients only ever render + interpolate it.  Its world position
 * is recomputed each tick as the mothership position plus a fixed slot offset,
 * so it rides along with the carrier and the cable stays taut.
 */
export interface PlatformState {
  /** Stable UUID identity (runtime, not world-seed derived). */
  id: string;
  /** Player id that built + owns this platform. */
  owner: string;
  /** Mothership entity id this platform is cabled to. */
  motherShipId: string;
  kind: PlatformKind;
  /** Slot index 0..maxPerPlayer-1 (drives the ring angle). */
  slot: number;
  /** World position (mother position + slot offset). */
  px: number;
  py: number;
  pz: number;
  hp: number;
  maxHp: number;
}

/**
 * Carrier strategy tunables — the deployable-fleet economy.
 *
 * Lives here (shared) so the client can preview credit accrual and gate the
 * deploy UI with the same numbers the server enforces.  Credits accrue on the
 * server only; the wire carries the authoritative balance each snapshot.
 */
export const CARRIER = {
  /** Credits each player starts with on join. */
  startCredits: 120,
  /** Passive credits earned per second by every commander. */
  creditRatePerSec: 6,
  /** Hard cap on simultaneously-deployed fleet units per player. */
  maxFleetPerPlayer: 12,
  /** Distance (m) below the mothership hull that units launch from. */
  launchOffset: 40,
  /** Minimum ms a player must wait between two deploys. */
  deployCooldownMs: 600,
} as const;

// ─── Fleet roles ─────────────────────────────────────────────────────────────

/**
 * The role classes a deployed fleet unit can take.  `"none"` is used by every
 * non-fleet entity (fighters / motherships) so the field is always defined.
 */
export type FleetRole =
  | "miner"
  | "scout"
  | "corsair"
  | "frigate"
  | "cruiser"
  | "dreadnought"
  | "none";

/**
 * The six deployable unit classes, in UI / size order (lightest → heaviest).
 * This order is also the canonical class index used by `roleShipType` so a
 * deployed unit's `shipType` matches its class hull (0=miner … 5=dreadnought),
 * lining up with `SHIP_IS_MINER`.
 */
export const DEPLOYABLE_ROLES: Exclude<FleetRole, "none">[] = [
  "miner",
  "scout",
  "corsair",
  "frigate",
  "cruiser",
  "dreadnought",
];

/** Static definition of one deployable fleet role. */
export interface FleetRoleDef {
  role: FleetRole;
  /** Display label. */
  label: string;
  /** Credit cost to deploy one. */
  cost: number;
  /** Per-player cap for this specific role. */
  cap: number;
  /** Visual length in metres (miner ~4 m → battleship attacker ~40 m). */
  scale: number;
  /** Hull hit-points. */
  maxHp: number;
  /** Regenerating shield bank for this class (soaked before hull). */
  maxShield: number;
  /** Radius (m) of the rated XYZ operation zone for this class. */
  zoneR: number;
  /** Speed multiplier applied to the base FLEET_UNIT tunables. */
  speedMult: number;
  /** Range (m) at which the unit engages / reacts to a hostile. */
  engageRange: number;
  /** Range (m) within which the unit will open fire. */
  fireRange: number;
  /** Whether this role fires weapons at all (miners do not). */
  armed: boolean;
}

/**
 * The deployable fleet roles.  Bigger / stronger classes cost more and get a
 * proportionally larger operation zone — the rated-zone scaling the task calls
 * for.  Scale runs from a 4 m miner up to a 40 m battleship-class attacker.
 */
export const FLEET_ROLES: Record<Exclude<FleetRole, "none">, FleetRoleDef> = {
  miner: {
    role: "miner",
    label: "Miner",
    cost: 40,
    cap: 6,
    scale: 5,
    maxHp: 40,
    maxShield: 18,
    zoneR: 320,
    speedMult: 0.75,
    engageRange: 0,
    fireRange: 0,
    armed: false,
  },
  scout: {
    role: "scout",
    label: "Scout Drone",
    cost: 55,
    cap: 6,
    scale: 8,
    maxHp: 45,
    maxShield: 30,
    zoneR: 460,
    speedMult: 1.25,
    engageRange: 520,
    fireRange: 240,
    armed: true,
  },
  corsair: {
    role: "corsair",
    label: "Corsair Drone",
    cost: 80,
    cap: 5,
    scale: 12,
    maxHp: 70,
    maxShield: 45,
    zoneR: 500,
    speedMult: 1.05,
    engageRange: 580,
    fireRange: 260,
    armed: true,
  },
  frigate: {
    role: "frigate",
    label: "Frigate",
    cost: 95,
    cap: 4,
    scale: 18,
    maxHp: 100,
    maxShield: 70,
    zoneR: 540,
    speedMult: 0.9,
    engageRange: 340,
    fireRange: 190,
    armed: true,
  },
  cruiser: {
    role: "cruiser",
    label: "Cruiser",
    cost: 120,
    cap: 3,
    scale: 26,
    maxHp: 140,
    maxShield: 110,
    zoneR: 620,
    speedMult: 0.95,
    engageRange: 620,
    fireRange: 240,
    armed: true,
  },
  dreadnought: {
    role: "dreadnought",
    label: "Dreadnought",
    cost: 165,
    cap: 2,
    scale: 42,
    maxHp: 210,
    maxShield: 170,
    zoneR: 720,
    speedMult: 0.85,
    engageRange: 780,
    fireRange: 270,
    armed: true,
  },
};

// ─── Per-class stats system ──────────────────────────────────────────────────

/**
 * The six headline stats every hull / drone class is rated on, each on a 0..100
 * scale.  This is the SINGLE design source of truth for class balance: the client
 * hangar dossier renders these as bars AND the deterministic sim derives its real
 * combat numbers (armour, weapon damage, shield regen, fire cadence) from them —
 * so what a player reads on a card is what that ship actually does in a match.
 * Indexed 0..5 by class (0=miner … 5=dreadnought), lining up with `shipType` and
 * `DEPLOYABLE_ROLES`.
 */
export interface ShipStatCard {
  /** Movement performance (flight envelope + fire cadence). */
  speed: number;
  /** Incoming-damage resistance. */
  defense: number;
  /** Outgoing weapon power. */
  attack: number;
  /** Shield bank + recharge rate. */
  shield: number;
  /** Splash / burst flavour (presentation only). */
  explosive: number;
  /** Drone-fielding capacity (presentation only). */
  drones: number;
}

/** The canonical per-class stat cards, indexed 0..5 (miner … dreadnought). */
export const CLASS_STAT_CARDS: readonly ShipStatCard[] = [
  { speed: 45, defense: 30, attack: 10, shield: 25, explosive: 5, drones: 60 }, // miner
  { speed: 95, defense: 20, attack: 45, shield: 25, explosive: 30, drones: 50 }, // scout
  { speed: 65, defense: 55, attack: 50, shield: 45, explosive: 40, drones: 55 }, // corsair
  { speed: 40, defense: 70, attack: 25, shield: 75, explosive: 20, drones: 65 }, // frigate
  { speed: 60, defense: 75, attack: 80, shield: 70, explosive: 65, drones: 45 }, // cruiser
  { speed: 25, defense: 95, attack: 95, shield: 85, explosive: 90, drones: 40 }, // dreadnought
];

/** Stat card for a class / `shipType` index (0..5), wrapped into range. */
export function statCardForShipType(shipType: number): ShipStatCard {
  const i = (((shipType | 0) % SHIP_TYPES) + SHIP_TYPES) % SHIP_TYPES;
  return CLASS_STAT_CARDS[i];
}

/** Stat card for a deployable role, or `null` for `"none"` / invalid. */
export function statCardForRole(role: FleetRole): ShipStatCard | null {
  const i = DEPLOYABLE_ROLES.indexOf(role as Exclude<FleetRole, "none">);
  return i >= 0 ? CLASS_STAT_CARDS[i] : null;
}

/**
 * Derived, sim-facing combat numbers for one ship / drone class.  Every field is
 * a PURE function of a `ShipStatCard` (plus the authored flight envelope), so the
 * authoritative server and the predicting client compute identical values — the
 * stats system never desyncs.  Values are rounded to fixed decimals so they stay
 * stable, readable constants.
 */
export interface CombatProfile {
  /** Incoming-damage reduction fraction (0..`MAX_ARMOR`), from DEFENSE. */
  armor: number;
  /** Outgoing weapon-damage multiplier vs `WEAPON.damage`, from ATTACK. */
  damageMult: number;
  /** Shield regen (points/sec), from SHIELD. */
  shieldRegenPerSec: number;
  /** Flight-envelope speed multiplier, from SPEED. */
  speedMult: number;
  /** Fire-cooldown multiplier (1 = baseline, <1 = faster), from SPEED. */
  fireCooldownMult: number;
}

/** Hardest hull caps incoming-damage reduction at this fraction. */
export const MAX_ARMOR = 0.4;

const round1 = (v: number): number => Math.round(v * 10) / 10;
const round2 = (v: number): number => Math.round(v * 100) / 100;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Derive a class's sim-facing combat profile from its 0..100 stat card.
 * `speedMult` is taken from the authored flight envelope (`FLEET_ROLES`), kept as
 * the movement balance rather than re-derived, so activating it never re-tunes
 * existing handling.
 */
function deriveCombat(card: ShipStatCard, speedMult: number): CombatProfile {
  return {
    armor: round3((card.defense / 100) * MAX_ARMOR),
    damageMult: round3(0.5 + card.attack / 100),
    shieldRegenPerSec: round1(SHIELD.regenPerSec * (0.5 + card.shield / 100)),
    speedMult,
    fireCooldownMult: round2(1.4 - 0.8 * (card.speed / 100)),
  };
}

/** Per-role derived combat profiles (the six deployable drone classes). */
export const CLASS_COMBAT: Record<Exclude<FleetRole, "none">, CombatProfile> =
  (() => {
    const out = {} as Record<Exclude<FleetRole, "none">, CombatProfile>;
    for (let i = 0; i < DEPLOYABLE_ROLES.length; i++) {
      const role = DEPLOYABLE_ROLES[i];
      out[role] = deriveCombat(CLASS_STAT_CARDS[i], FLEET_ROLES[role].speedMult);
    }
    return out;
  })();

/**
 * Fixed BASELINE profile for the player-piloted fighter: a nimble interceptor
 * with no armour and reference damage / regen / speed.  Keeping it the 1.0
 * baseline is deliberate — it anchors the whole balance curve and keeps the
 * deterministic `damageEntity` and speed-cap behaviour exact.
 */
export const FIGHTER_COMBAT: CombatProfile = {
  armor: 0,
  damageMult: 1,
  shieldRegenPerSec: SHIELD.regenPerSec,
  speedMult: 1,
  fireCooldownMult: 1,
};

/** Capital-ship profile for a mothership: armoured, hard-hitting turrets. */
export const MOTHER_COMBAT: CombatProfile = {
  armor: 0.35,
  damageMult: 1.5,
  shieldRegenPerSec: round1(SHIELD.regenPerSec * 1.6),
  speedMult: 1,
  fireCooldownMult: 1,
};

/** Fallback profile for a roleless (`"none"`) fleet unit — baseline drone. */
export const BASE_FLEET_COMBAT: CombatProfile = { ...FIGHTER_COMBAT };

/** Resolve the combat profile for an entity by kind + role.  Pure. */
export function combatProfileFor(kind: EntityKind, role: FleetRole): CombatProfile {
  if (kind === "mother_ship") return MOTHER_COMBAT;
  if (kind === "fleet_unit") {
    const i = DEPLOYABLE_ROLES.indexOf(role as Exclude<FleetRole, "none">);
    return i >= 0 ? CLASS_COMBAT[DEPLOYABLE_ROLES[i]] : BASE_FLEET_COMBAT;
  }
  // fighter + mine (and anything else) fall back to the agile baseline.
  return FIGHTER_COMBAT;
}

/** Incoming-damage reduction fraction for this entity (DEFENSE stat). */
export function armorFor(e: Pick<EntityState, "kind" | "role">): number {
  return combatProfileFor(e.kind, e.role).armor;
}

/** Outgoing weapon damage (per bolt) for this entity (ATTACK stat). */
export function weaponDamageFor(e: Pick<EntityState, "kind" | "role">): number {
  return WEAPON.damage * combatProfileFor(e.kind, e.role).damageMult;
}

/** Shield regen (points/sec) for this entity (SHIELD stat). */
export function shieldRegenPerSecFor(e: Pick<EntityState, "kind" | "role">): number {
  return combatProfileFor(e.kind, e.role).shieldRegenPerSec;
}

/** Flight-envelope speed multiplier for this entity (SPEED stat). */
export function speedMultFor(e: Pick<EntityState, "kind" | "role">): number {
  return combatProfileFor(e.kind, e.role).speedMult;
}

/**
 * Whole-tick fire cooldown for a fleet unit, scaling a baseline cadence by the
 * class's SPEED-derived `fireCooldownMult` (faster classes fire more often).
 * Clamped to a sane minimum so no class can machine-gun.
 */
export function fleetFireCooldownTicks(role: FleetRole, baselineTicks: number): number {
  const mult = combatProfileFor("fleet_unit", role).fireCooldownMult;
  return Math.max(3, Math.round(baselineTicks * mult));
}

/**
 * Runtime type guard for a deployable role.  Checks own-properties only so an
 * untrusted client cannot smuggle a prototype key (e.g. `"toString"`) through
 * the wire and have it resolve to a truthy non-role value.
 */
export function isDeployableRole(role: unknown): role is Exclude<FleetRole, "none"> {
  return typeof role === "string" && Object.hasOwn(FLEET_ROLES, role);
}

/** Resolve a role definition; `null` for non-deployable / `"none"` / bad input. */
export function fleetRoleDef(role: FleetRole): FleetRoleDef | null {
  if (!isDeployableRole(role)) return null;
  return FLEET_ROLES[role];
}

/**
 * Canonical class order — the index a deployed unit's `shipType` should take so
 * its rendered hull matches its class (0=miner … 5=dreadnought).  Identical to
 * `DEPLOYABLE_ROLES` but typed as the source of truth for `roleShipType`.
 */
export const CLASS_ORDER: Exclude<FleetRole, "none">[] = DEPLOYABLE_ROLES;

/** Map a fleet role to its canonical hull `shipType` (miner=0 … dreadnought=5). */
export function roleShipType(role: FleetRole): number {
  const i = CLASS_ORDER.indexOf(role as Exclude<FleetRole, "none">);
  return i < 0 ? 0 : i;
}

// ─── Factions ────────────────────────────────────────────────────────────────

/**
 * The five lore factions.  Pure presentation/identity data — deterministic and
 * dependency-free (no render/asset imports), so both the server and the shared
 * sim can reference a commander's faction.  The client maps each id to its
 * mothership station asset(s) and ship tint in its own constants.
 */
export type FactionId = "scavengers" | "hollow" | "network" | "brood" | "prospector";

export interface FactionDef {
  id: FactionId;
  /** Display name. */
  name: string;
  /** Accent / hull-tint colour (hex). */
  color: string;
  /** Short lore blurb for the faction picker. */
  blurb: string;
}

/** Stable selection / fallback order. `FACTION_ORDER[0]` is the default faction. */
export const FACTION_ORDER: FactionId[] = [
  "scavengers",
  "hollow",
  "network",
  "brood",
  "prospector",
];

export const FACTIONS: Record<FactionId, FactionDef> = {
  scavengers: {
    id: "scavengers",
    name: "Tech-Scavengers",
    color: "#ff4d4d",
    blurb: "Salvage-born raiders who weld ancient hulls into a wandering pyramid-ark.",
  },
  hollow: {
    id: "hollow",
    name: "Hollow Lords",
    color: "#4488ff",
    blurb: "Cold ring-station nobility ruling the void from hollowed cathedral-rings.",
  },
  network: {
    id: "network",
    name: "The Network",
    color: "#ffd23f",
    blurb: "A hive-mind relay swarm; their docking hubs route an endless data-tide.",
  },
  brood: {
    id: "brood",
    name: "Brood Mother",
    color: "#c084fc",
    blurb: "A living colossus-station birthing organic fleets from a single dark womb.",
  },
  prospector: {
    id: "prospector",
    name: "Prospector",
    color: "#5dff9b",
    blurb: "Industrial miners whose ring-rigs strip whole belts for ore and fuel.",
  },
};

/** Deterministic team → faction mapping (round-robins through `FACTION_ORDER`). */
export function factionForTeam(team: number): FactionId {
  const n = FACTION_ORDER.length;
  return FACTION_ORDER[(((team | 0) % n) + n) % n];
}

/** Runtime type guard for a faction id (rejects smuggled prototype keys). */
export function isFactionId(v: unknown): v is FactionId {
  return typeof v === "string" && Object.hasOwn(FACTIONS, v);
}

// ─── Movement tunables by kind ───────────────────────────────────────────────

export interface FlightTunables {
  yawRate: number;
  pitchRate: number;
  rollRate: number;
  thrustAccel: number;
  maxSpeed: number;
  boostMaxSpeed: number;
  boostMult: number;
  drag: number;
  arena: number;
}

/**
 * Movement tunables for an entity kind.  The single, shared, deterministic
 * integrator (`stepShip`) reads these so fighters, motherships, and fleet units
 * all advance with the same maths but their own performance envelopes.
 */
export function tunablesFor(kind: EntityKind): FlightTunables {
  if (kind === "mother_ship") {
    return { ...MOTHER_SHIP, arena: SHIP.arena };
  }
  if (kind === "fleet_unit") {
    return { ...FLEET_UNIT, arena: SHIP.arena };
  }
  return { ...SHIP };
}

// ─── Entities ────────────────────────────────────────────────────────────────

export type EntityKind = "fighter" | "mother_ship" | "fleet_unit" | "mine";

export interface EntityState {
  /** Short routing id (player slot / `ai_N`) used for ownership + reconciliation. */
  id: string;
  /**
   * Globally-unique, stable identity for this entity for the lifetime of the
   * match.  Beams (mining cones, lasers) target by `uid` so a fired beam keeps
   * pointing at the right ship/turret even as the short `id` list reshuffles.
   * Assigned once at spawn — NOT derived from the world seed (runtime identity,
   * not world generation).
   */
  uid: string;
  name: string;
  shipType: number;
  kind: EntityKind;
  /** Lore faction of this entity's owner (drives mothership model + hull tint). */
  faction: FactionId;
  /** Player id that owns and commands this entity. */
  owner: string;
  team: number;
  px: number;
  py: number;
  pz: number;
  yaw: number;
  pitch: number;
  roll: number;
  vx: number;
  vy: number;
  vz: number;
  hp: number;
  /** Maximum HP for this entity (kind/role dependent). */
  maxHp: number;
  /**
   * Current regenerating shield (soaks weapon + collision damage before hull).
   * Server-authoritative — clients only render it.
   */
  shield: number;
  /** Maximum shield for this entity (kind/role dependent). */
  maxShield: number;
  alive: boolean;
  respawnAt: number;
  kills: number;
  deaths: number;
  /** Fleet role (`"none"` for fighters / motherships). */
  role: FleetRole;
  /** Live world centre of this unit's rated operation zone. */
  zoneX: number;
  zoneY: number;
  zoneZ: number;
  /** Radius (m) of the rated operation zone (0 when not a fleet unit). */
  zoneR: number;
  /**
   * Authoritative afterburner flag — true on the tick a ship is boosting (set by
   * the sim from its `InputCommand.boost`).  Carried on the wire so remote/AI
   * plumes flare exactly when the ship is actually boosting, instead of being
   * inferred from over-cap speed (which lingers after boost is released).
   */
  boost: boolean;
}

export type ShipState = EntityState;

export interface InputCommand {
  seq: number;
  dt: number;
  thrust: number;
  yaw: number;
  pitch: number;
  roll: number;
  boost: boolean;
  /** Primary weapons (LMB / Space / F). */
  fire: boolean;
  /** Homing missile salvo (RMB). */
  missile: boolean;
}

export interface ProjectileState {
  id: number;
  owner: string;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  /** Omitted or `"bolt"` for standard lasers; `"missile"` for guided rockets. */
  kind?: ProjectileKind;
}

export type GameEvent =
  | { k: "fire"; px: number; py: number; pz: number }
  | { k: "explode"; px: number; py: number; pz: number }
  | { k: "hit"; px: number; py: number; pz: number }
  | { k: "reward"; px: number; py: number; pz: number }
  | { k: "impact"; px: number; py: number; pz: number };

/**
 * A continuous beam rendered between a source and a target during live play.
 * `mining` = a miner's absorption cone of light onto a celestial rock; `laser`
 * = an offensive bolt-beam from a ship/turret.  Both reference their endpoints
 * by stable id (`sourceUid` is an entity `uid`; `targetUid` is an entity `uid`
 * OR a celestial `id`), with a resolved world point so the client can draw it
 * even before it has interpolated the target.  Server-authoritative + present
 * only while the beam is active.
 */
export type BeamKind = "mining" | "laser";

export interface BeamState {
  id: string;
  kind: BeamKind;
  /** Entity `uid` of the emitter (ship or turret host). */
  sourceUid: string;
  /** Resolved emitter muzzle point. */
  sx: number;
  sy: number;
  sz: number;
  /** Target entity `uid` or celestial `id` (empty when aimed at a free point). */
  targetUid: string;
  /** Resolved target point. */
  tx: number;
  ty: number;
  tz: number;
  /** Team that owns the beam (for colour). */
  team: number;
}

export interface PlayerEconomy {
  playerId: string;
  controlledEntityId: string;
  /** Id of this player's mothership (the deploy + zone anchor). */
  motherShipId: string;
  credits: number;
}

/**
 * A spherical obstacle the fleet steering avoids.  Empty today; the world-content
 * task feeds celestial bodies in here so pathfinding composes with them.
 */
export interface Obstacle {
  x: number;
  y: number;
  z: number;
  r: number;
}

function maxHpFor(kind: EntityKind, role: FleetRole): number {
  if (kind === "mother_ship") return MOTHER_SHIP.maxHp;
  if (kind === "fleet_unit") {
    const def = fleetRoleDef(role);
    return def ? def.maxHp : FLEET_UNIT.maxHp;
  }
  return SHIP.maxHp;
}

/** Maximum shield for an entity kind/role (mirrors `maxHpFor`). */
export function maxShieldFor(kind: EntityKind, role: FleetRole): number {
  if (kind === "mother_ship") return MOTHER_SHIP.maxShield;
  if (kind === "fleet_unit") {
    const def = fleetRoleDef(role);
    return def ? def.maxShield : FLEET_UNIT.maxShield;
  }
  return SHIP.maxShield;
}

export function spawnEntity(
  id: string,
  name: string,
  kind: EntityKind,
  owner: string,
  team: number,
  shipType: number,
  px: number,
  py: number,
  pz: number,
  yaw: number,
  role: FleetRole = "none",
  faction: FactionId = FACTION_ORDER[0],
): EntityState {
  const maxHp = maxHpFor(kind, role);
  const maxShield = maxShieldFor(kind, role);
  return {
    id,
    uid: newUuid("ent"),
    name,
    kind,
    faction,
    owner,
    team,
    shipType,
    px,
    py,
    pz,
    yaw,
    pitch: 0,
    roll: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    hp: maxHp,
    maxHp,
    shield: maxShield,
    maxShield,
    alive: true,
    respawnAt: 0,
    kills: 0,
    deaths: 0,
    role,
    zoneX: px,
    zoneY: py,
    zoneZ: pz,
    zoneR: 0,
    boost: false,
  };
}

export function spawnShip(
  id: string,
  name: string,
  shipType: number,
  px: number,
  py: number,
  pz: number,
  yaw: number,
): EntityState {
  return spawnEntity(id, name, "fighter", id, 0, shipType, px, py, pz, yaw);
}

export function forwardVec(yaw: number, pitch: number): [number, number, number] {
  const cp = Math.cos(pitch);
  return [Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp];
}

// ─── Deterministic RNG ───────────────────────────────────────────────────────

/** Deterministic hash of up to three integers → [0,1). */
export function hash01(a: number, b = 0, c = 0): number {
  let h = (a | 0) * 0x27d4eb2d;
  h = (h ^ (b | 0)) * 0x165667b1;
  h = (h ^ (c | 0)) * 0x9e3779b1;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
