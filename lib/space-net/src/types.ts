/**
 * Shared, dependency-free types + tunables for the space-shooter netcode.
 *
 * This module is imported by BOTH the authoritative server (api-server) and the
 * browser client (arcade), so it must stay free of any runtime dependency
 * (no three.js, no ws, no node APIs). Geometry is plain numbers; the client maps
 * yaw/pitch/roll onto a Three.js object, the server never touches a renderer.
 */

/** Simulation tick rate of the authoritative server (Hz). */
export const TICK_HZ = 30;
/** Rate at which the server broadcasts world snapshots to clients (Hz). */
export const SNAPSHOT_HZ = 20;
/** Fixed timestep, seconds, derived from TICK_HZ. */
export const TICK_DT = 1 / TICK_HZ;

/** Flight tunables — shared so prediction matches the server exactly. */
export const SHIP = {
  /** Angular rates (rad/s) at full input. */
  yawRate: 1.6,
  pitchRate: 1.4,
  rollRate: 2.4,
  /** Forward/back acceleration (units/s^2) at full thrust. */
  thrustAccel: 90,
  /** Cruise speed cap and boosted cap (units/s). */
  maxSpeed: 70,
  boostMaxSpeed: 120,
  boostMult: 1.8,
  /** Velocity retained per second (exponential drag); 1 = none. */
  drag: 0.7,
  /** Half-extent of the cubic play arena; ships clamp inside. */
  arena: 600,
  maxHp: 100,
  /** ms a destroyed ship waits before respawning. */
  respawnDelay: 3000,
} as const;

/**
 * Mother ship tunables — larger, slower, and much tougher than a fighter.
 * Per-class maxHp is defined in MOTHER_SHIP_CLASSES; this object holds the
 * shared movement tunables that apply to all mother ship classes.
 * Visual scale is 30× the longest fighter dimension so it dwarfs everything else.
 */
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
  respawnDelay: 10000,
  /** Visual scale relative to a fighter's SHIP_FIT dimension. */
  scaleFactor: 30,
} as const;

/**
 * Carrier strategy tunables — course-following, economy, and turret defence.
 * Shared so the client can predict credit accrual without waiting for the server.
 */
export const CARRIER = {
  /** Units/s cap while following a course. */
  courseMaxSpeed: 15,
  /** rad/s the mothership turns toward its destination. */
  courseTurnRate: 0.4,
  /** Thrust acceleration (units/s²) used during course following. */
  thrustAccel: 8,
  /** Velocity fraction retained per second (exponential drag). */
  drag: 0.6,
  /** Stop (declare arrival) when within this distance of the destination. */
  arrivalRadius: 60,
  /** Credits earned per second while speed exceeds creditMoveThreshold. */
  creditRatePerSec: 5,
  /** Minimum speed (units/s) that counts as "moving" for credit accrual. */
  creditMoveThreshold: 1.0,
  /** Auto-turret engagement range (units). */
  turretRange: 280,
  /** Minimum ms between turret shots. */
  turretCooldownMs: 600,
  /** Damage applied per turret hit. */
  turretDamage: 15,
  /** Speed of turret projectiles (units/s). */
  turretProjectileSpeed: 200,
  /** How long turret projectiles live before expiring (ms). */
  turretProjectileLifeMs: 2000,
  /** Number of turret mounts on the mothership hull. */
  numTurrets: 4,
} as const;

/**
 * Fleet unit tunables (stub — values will be tuned in the fleet-build task).
 * Lighter and faster than a mother ship but weaker than a fighter.
 */
export const FLEET_UNIT = {
  yawRate: 1.2,
  pitchRate: 1.0,
  rollRate: 1.8,
  thrustAccel: 60,
  maxSpeed: 55,
  boostMaxSpeed: 90,
  boostMult: 1.6,
  drag: 0.65,
  maxHp: 50,
  respawnDelay: 5000,
} as const;

/** Weapon tunables. */
export const WEAPON = {
  cooldownMs: 180,
  projectileSpeed: 320,
  /** Inherit shooter velocity so bolts feel attached to the ship. */
  projectileLifeMs: 1600,
  damage: 12,
  /** Hit radius around a ship centre (units). */
  hitRadius: 9,
  /** Muzzle offset forward of ship centre. */
  muzzleForward: 6,
} as const;

/**
 * Player-fired weapon catalogue (shared by client + server).
 *
 * Unlike the auto-`WEAPON` turrets, these are the five hand-fired guns a captain
 * can select (UI / keys 1-5) and trigger with the spacebar. The server is
 * authoritative: it owns cooldowns, spawns projectiles forward along the ship's
 * heading, and applies per-weapon damage; the client only renders + sends intent.
 */
export interface WeaponDef {
  /** Stable id. */
  id: string;
  /** Display name for the selector. */
  name: string;
  /** One-line tagline shown in the UI. */
  description: string;
  /** Minimum ms between shots (before the reload upgrade). */
  cooldownMs: number;
  /** Projectile speed, units/s (before the range upgrade). */
  projectileSpeed: number;
  /** Projectile lifetime, ms (before the range upgrade). */
  lifeMs: number;
  /** Damage per projectile that connects (before the damage upgrade). */
  damage: number;
  /** Number of projectiles per trigger pull (>1 = spread). */
  pellets: number;
  /** Total fan angle (radians) across the pellets when pellets > 1. */
  spread: number;
  /** Hit radius around a target centre (units). */
  hitRadius: number;
  /** Hex colour used for the rendered bolt / UI accent. */
  color: string;
}

/** The five selectable player weapons (index = selection slot, key 1-5). */
export const WEAPONS: readonly WeaponDef[] = [
  {
    id: "cannon",
    name: "Cannon",
    description: "Balanced single shot. Reliable at any range.",
    cooldownMs: 480,
    projectileSpeed: 280,
    lifeMs: 2200,
    damage: 32,
    pellets: 1,
    spread: 0,
    hitRadius: 12,
    color: "#ffd27a",
  },
  {
    id: "gatling",
    name: "Gatling",
    description: "Rapid-fire stream. Low damage, high pressure.",
    cooldownMs: 120,
    projectileSpeed: 360,
    lifeMs: 1500,
    damage: 9,
    pellets: 1,
    spread: 0,
    hitRadius: 9,
    color: "#7affd2",
  },
  {
    id: "grapeshot",
    name: "Grapeshot",
    description: "Five-pellet broadside fan. Brutal up close.",
    cooldownMs: 780,
    projectileSpeed: 230,
    lifeMs: 1100,
    damage: 14,
    pellets: 5,
    spread: 0.5,
    hitRadius: 10,
    color: "#ffae5a",
  },
  {
    id: "mortar",
    name: "Mortar",
    description: "Slow, heavy shell with a wide blast radius.",
    cooldownMs: 1400,
    projectileSpeed: 185,
    lifeMs: 2600,
    damage: 82,
    pellets: 1,
    spread: 0,
    hitRadius: 22,
    color: "#ff5a5a",
  },
  {
    id: "railgun",
    name: "Railgun",
    description: "Hyper-velocity slug. Devastating, long reload.",
    cooldownMs: 1750,
    projectileSpeed: 720,
    lifeMs: 1400,
    damage: 135,
    pellets: 1,
    spread: 0,
    hitRadius: 8,
    color: "#b58aff",
  },
] as const;

/** Clamp + look up a weapon by selection slot (out-of-range falls back to 0). */
export function getWeapon(slot: number): WeaponDef {
  const i = Math.max(0, Math.min(WEAPONS.length - 1, slot | 0));
  return WEAPONS[i];
}

/** The four functional upgrades a captain can buy with credits. */
export type UpgradeId = "hull" | "damage" | "reload" | "range";

export interface UpgradeDef {
  id: UpgradeId;
  /** Display name. */
  name: string;
  /** One-line description of the effect. */
  description: string;
  /** Maximum purchasable level. */
  maxLevel: number;
  /** Cost of the first level; each level multiplies by `costMult`. */
  baseCost: number;
  /** Per-level cost multiplier. */
  costMult: number;
  /** Per-level effect step (see `upgradeMultiplier`). */
  step: number;
}

/** Upgrade catalogue. Effects are applied server-side at the relevant moment. */
export const UPGRADES: readonly UpgradeDef[] = [
  {
    id: "hull",
    name: "Hull Plating",
    description: "+15% max hull per level.",
    maxLevel: 5,
    baseCost: 60,
    costMult: 1.7,
    step: 0.15,
  },
  {
    id: "damage",
    name: "Gunpowder",
    description: "+12% weapon damage per level.",
    maxLevel: 5,
    baseCost: 70,
    costMult: 1.7,
    step: 0.12,
  },
  {
    id: "reload",
    name: "Auto-Loader",
    description: "-8% weapon cooldown per level.",
    maxLevel: 5,
    baseCost: 70,
    costMult: 1.7,
    step: 0.08,
  },
  {
    id: "range",
    name: "Long Barrels",
    description: "+12% projectile speed & range per level.",
    maxLevel: 5,
    baseCost: 50,
    costMult: 1.6,
    step: 0.12,
  },
] as const;

/** Per-player upgrade levels (0 = unbought). */
export type UpgradeLevels = Record<UpgradeId, number>;

/** A fresh, all-zero upgrade record. */
export function emptyUpgrades(): UpgradeLevels {
  return { hull: 0, damage: 0, reload: 0, range: 0 };
}

/** Look up an upgrade definition by id. */
export function getUpgrade(id: UpgradeId): UpgradeDef | undefined {
  return UPGRADES.find((u) => u.id === id);
}

/**
 * Credit cost to buy the NEXT level given the current level.
 * Returns `Infinity` when already at max so callers can simply compare.
 */
export function upgradeCost(id: UpgradeId, currentLevel: number): number {
  const def = getUpgrade(id);
  if (!def || currentLevel >= def.maxLevel) return Infinity;
  return Math.round(def.baseCost * Math.pow(def.costMult, currentLevel));
}

/**
 * The multiplier an upgrade contributes at a given level.
 * - hull / damage / range scale UP   → `1 + step*level`
 * - reload scales DOWN (faster)      → `max(0.4, 1 - step*level)`
 */
export function upgradeMultiplier(id: UpgradeId, level: number): number {
  const def = getUpgrade(id);
  if (!def) return 1;
  const lvl = Math.max(0, level | 0);
  if (id === "reload") return Math.max(0.4, 1 - def.step * lvl);
  return 1 + def.step * lvl;
}

/** Number of distinct ship models available (spaceship1..6). */
export const SHIP_TYPES = 6;

/**
 * The kind of an entity in the simulation.
 *
 * - `"fighter"` — a player-piloted ship (the current default).
 * - `"mother_ship"` — large capital ship, typically one per team.
 * - `"fleet_unit"` — small AI-commanded escort / attack unit.
 * - `"mine"` — stationary hazard (thrust always 0; used via health/alive).
 */
export type EntityKind = "fighter" | "mother_ship" | "fleet_unit" | "mine";

// ─── Mother Ship Classes ─────────────────────────────────────────────────────

/** Turret hardpoint descriptor shown in the lobby and used by the combat layer. */
export interface TurretLoadout {
  count: number;
  type: "laser" | "missile" | "plasma" | "railgun" | "flak" | "beam";
  /** Qualitative fire rate label. */
  fireRate: "slow" | "medium" | "fast" | "rapid";
  /** Damage per shot relative to WEAPON.damage (1 = identical). */
  damageMult: number;
}

/** One stage of a class's upgrade tree (displayed in the lobby; applied in a later task). */
export interface UpgradeStage {
  /** Short stage title shown in the UI. */
  name: string;
  /** One-line description of what this stage unlocks. */
  description: string;
}

/**
 * Full definition of a Mother Ship class.
 *
 * Lives in `@workspace/space-net` so the server and the client share the same
 * source of truth — the server reads `maxHp` from here when it spawns the
 * entity, the client reads the same value for its HUD.
 */
export interface MotherShipClassDef {
  /** Unique slug used in saved game state. */
  id: string;
  /** Display name. */
  name: string;
  /** Short role subtitle. */
  subtitle: string;
  /** Flavour description for the selection screen. */
  description: string;
  /** Visual model index 0-5, maps to CAPITAL_SHIP_IDS in assets.ts. */
  shipType: number;
  /** Hex accent colour used in the UI and HUD. */
  color: string;
  /** Stage-1 hull hit-points. */
  maxHp: number;
  /** Sphere-of-influence radius (world units). */
  sphereRadius: number;
  /** Fleet production speed multiplier (1 = baseline). */
  productionSpeed: number;
  /** Resource harvest multiplier. */
  harvestBonus: number;
  /** Defensive turret hardpoints on the hull. */
  turrets: TurretLoadout;
  /** Fleet unit types unlocked at stage 1. */
  startingUnlocks: string[];
  /** Three-stage upgrade path (shown in the lobby; applied in a later task). */
  upgradeTree: [UpgradeStage, UpgradeStage, UpgradeStage];
}

/**
 * The 6 selectable Mother Ship classes.
 *
 * Index matches `shipType` 0-5 on the wire so `MOTHER_SHIP_CLASSES[shipType]`
 * is always the canonical lookup. Any downstream code that needs a class
 * definition should call `getMotherShipClass(shipType)` rather than indexing
 * the array directly so out-of-range values are handled gracefully.
 */
export const MOTHER_SHIP_CLASSES: MotherShipClassDef[] = [
  // ── 0: Vanguard ─────────────────────────────────────────────────────────────
  {
    id: "vanguard",
    name: "Vanguard",
    subtitle: "Assault Carrier",
    description:
      "The front-line warship of the fleet. Thick armour, rapid laser batteries, and veteran fighter wings make it the most feared command vessel in a direct engagement.",
    shipType: 0,
    color: "#ff4444",
    maxHp: 2400,
    sphereRadius: 220,
    productionSpeed: 0.9,
    harvestBonus: 0.8,
    turrets: { count: 8, type: "laser", fireRate: "rapid", damageMult: 1.0 },
    startingUnlocks: ["fighter", "heavy_fighter"],
    upgradeTree: [
      { name: "Battle Hardened", description: "+20% hull, autorepair between engagements" },
      { name: "Weapon Arrays",   description: "Turret count ×2, unlock bomber wing" },
      { name: "Titan Protocol",  description: "Activates a ship-wide energy shield and heavy railgun broadside" },
    ],
  },

  // ── 1: Prospector ───────────────────────────────────────────────────────────
  {
    id: "prospector",
    name: "Prospector",
    subtitle: "Economy Carrier",
    description:
      "Built for deep-field resource extraction. Its colossal refineries process ore at twice the standard rate, powering the fastest fleet buildout in the sector.",
    shipType: 1,
    color: "#44ff88",
    maxHp: 1400,
    sphereRadius: 280,
    productionSpeed: 1.8,
    harvestBonus: 2.4,
    turrets: { count: 4, type: "flak", fireRate: "medium", damageMult: 0.7 },
    startingUnlocks: ["scout", "harvester_drone"],
    upgradeTree: [
      { name: "Efficient Routes",  description: "+40% harvest, sphere expands by 30 units" },
      { name: "Mega Silos",        description: "Resource cap ×3, unlock cargo hauler wing" },
      { name: "Infinite Engine",   description: "Passive credit trickle even in empty sectors; production speed ×3" },
    ],
  },

  // ── 2: Citadel ──────────────────────────────────────────────────────────────
  {
    id: "citadel",
    name: "Citadel",
    subtitle: "Bastion Carrier",
    description:
      "An armoured fortress in space. Point-defence batteries shred incoming ordnance and fighter swarms, while layered hulls absorb punishment no other carrier could survive.",
    shipType: 2,
    color: "#4488ff",
    maxHp: 4000,
    sphereRadius: 300,
    productionSpeed: 0.6,
    harvestBonus: 1.0,
    turrets: { count: 12, type: "flak", fireRate: "fast", damageMult: 0.8 },
    startingUnlocks: ["mine_layer", "shield_drone"],
    upgradeTree: [
      { name: "Ablative Plating", description: "+40% hull; incoming fighter damage reduced 25%" },
      { name: "Void Shields",     description: "Regenerating energy shield; unlock EMP mine" },
      { name: "Indestructible",   description: "Emergency bulk-heads restore 30% hull once per battle" },
    ],
  },

  // ── 3: Phantom ──────────────────────────────────────────────────────────────
  {
    id: "phantom",
    name: "Phantom",
    subtitle: "Scout Carrier",
    description:
      "Minimal profile, maximum velocity. The Phantom reaches any flashpoint before the enemy knows it is coming, deploying its cloaked interceptors from the shadows.",
    shipType: 3,
    color: "#ffcc00",
    maxHp: 1200,
    sphereRadius: 160,
    productionSpeed: 1.2,
    harvestBonus: 0.9,
    turrets: { count: 3, type: "plasma", fireRate: "fast", damageMult: 1.2 },
    startingUnlocks: ["scout", "interceptor"],
    upgradeTree: [
      { name: "Ghost Drive",      description: "Temporary cloak; +50% boost speed" },
      { name: "Stealth Network",  description: "Scouts reveal enemy build queues; spawn behind enemy sphere" },
      { name: "Shadow Fleet",     description: "All launched units inherit a short cloak window on departure" },
    ],
  },

  // ── 4: Brood Mother ─────────────────────────────────────────────────────────
  {
    id: "brood_mother",
    name: "Brood Mother",
    subtitle: "Swarm Carrier",
    description:
      "A living factory that never stops producing. Hundreds of drones pour from its bays in seconds, overwhelming enemy defences through sheer weight of numbers.",
    shipType: 4,
    color: "#cc44ff",
    maxHp: 1600,
    sphereRadius: 240,
    productionSpeed: 2.5,
    harvestBonus: 1.1,
    turrets: { count: 6, type: "laser", fireRate: "medium", damageMult: 0.9 },
    startingUnlocks: ["drone_swarm", "drone_swarm", "beamer"],
    upgradeTree: [
      { name: "Mass Production",  description: "Drone build time halved; launch 3 per tick instead of 1" },
      { name: "Evolution Vats",   description: "Drones gain self-repair; unlock veteran swarm tier" },
      { name: "Living Armada",    description: "Destroyed drones respawn automatically inside the sphere" },
    ],
  },

  // ── 5: Siege King ───────────────────────────────────────────────────────────
  {
    id: "siege_king",
    name: "Siege King",
    subtitle: "Artillery Carrier",
    description:
      "The longest gun in the fleet. Its spinal railcannons can crack a station in a single broadside from outside fighter range, ending battles before they begin.",
    shipType: 5,
    color: "#ff8800",
    maxHp: 2800,
    sphereRadius: 200,
    productionSpeed: 0.7,
    harvestBonus: 0.9,
    turrets: { count: 4, type: "railgun", fireRate: "slow", damageMult: 4.0 },
    startingUnlocks: ["artillery_unit", "the_ram"],
    upgradeTree: [
      { name: "Long Sight",           description: "Railgun range +50%; unlock targeting drone" },
      { name: "Orbital Bombardment",  description: "Charge shot pierces multiple targets in a line" },
      { name: "World Ender",          description: "Cooldown resets on each kill; unlock tactical nuke unit" },
    ],
  },
];

/**
 * Safely look up a Mother Ship class by its shipType index.
 * Returns `MOTHER_SHIP_CLASSES[0]` (Vanguard) for out-of-range values so
 * callers never receive `undefined`.
 */
export function getMotherShipClass(shipType: number): MotherShipClassDef {
  const i = Math.max(0, Math.min(MOTHER_SHIP_CLASSES.length - 1, shipType | 0));
  return MOTHER_SHIP_CLASSES[i];
}

// ─── Entity state ─────────────────────────────────────────────────────────────

/**
 * Authoritative state of a single ship/entity.
 *
 * `ShipState` is kept as an alias so existing callsites that name `ShipState`
 * continue to compile. All new code should use `EntityState` directly.
 *
 * `id`    — unique entity id (for fighters: same as the owning player id).
 * `owner` — player id that owns / commands this entity.
 * `team`  — team index (0-based; 0 = unaffiliated; future team-battle use).
 * `kind`  — entity type, drives movement tunables and rendering.
 * `maxHp` — maximum hit points for this entity (class-dependent for mother ships).
 *
 * Course fields (`hasCourse`, `courseTx`, `courseTz`):
 *   When `hasCourse` is true the server drives this entity toward (courseTx, 0, courseTz)
 *   using the `CARRIER` integrator. The client reflects these fields so the HUD
 *   can show the active destination without a separate channel.
 */
export interface EntityState {
  id: string;
  name: string;
  shipType: number;
  kind: EntityKind;
  /** Player id that owns and commands this entity. */
  owner: string;
  /** Team index (0 = unaffiliated). */
  team: number;
  /** Position. */
  px: number;
  py: number;
  pz: number;
  /** Orientation, radians. */
  yaw: number;
  pitch: number;
  roll: number;
  /** Velocity. */
  vx: number;
  vy: number;
  vz: number;
  hp: number;
  /** Maximum HP for this entity (used by respawn and HUD). */
  maxHp: number;
  alive: boolean;
  /** Server epoch ms when a dead entity respawns (0 if alive). */
  respawnAt: number;
  kills: number;
  deaths: number;
  /** Whether this entity is currently following a course destination. */
  hasCourse: boolean;
  /** Course destination X (world units). */
  courseTx: number;
  /** Course destination Z (world units). */
  courseTz: number;
}

/** Legacy alias — `EntityState` is the canonical type going forward. */
export type ShipState = EntityState;

/** A single sampled-input command from a client for one step. */
export interface InputCommand {
  /** Monotonic per-client sequence number (drives reconciliation). */
  seq: number;
  /** Duration this input covers, seconds (clamped server-side). */
  dt: number;
  /** -1..1 forward/back. */
  thrust: number;
  /** -1..1 turn. */
  yaw: number;
  /** -1..1 nose up/down. */
  pitch: number;
  /** -1..1 bank. */
  roll: number;
  boost: boolean;
  fire: boolean;
}

/** A live projectile (server-authoritative, rendered by all clients). */
export interface ProjectileState {
  id: number;
  /** Entity id of the firing entity. */
  owner: string;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
}

/** Transient, fire-and-forget event for client VFX/sound. */
export type GameEvent =
  | { k: "fire"; px: number; py: number; pz: number }
  | { k: "explode"; px: number; py: number; pz: number }
  | { k: "hit"; px: number; py: number; pz: number };

/**
 * Per-player economy and ownership record sent in every snapshot.
 *
 * Tells each client which entity it controls plus economy data for the
 * strategic layer (credits, etc.).
 */
export interface PlayerEconomy {
  /** Player connection id. */
  playerId: string;
  /** Id of the entity this player is currently piloting/commanding. */
  controlledEntityId: string;
  /** Spendable credits accumulated while the mothership is underway. */
  credits: number;
  /** Currently selected player weapon (index into `WEAPONS`). */
  weapon: number;
  /** Purchased upgrade levels for this player. */
  upgrades: UpgradeLevels;
}

/** Make a fresh, alive entity at a spawn point. */
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
): EntityState {
  const maxHp =
    kind === "mother_ship"
      ? getMotherShipClass(shipType).maxHp
      : kind === "fleet_unit"
        ? FLEET_UNIT.maxHp
        : SHIP.maxHp;
  return {
    id,
    name,
    kind,
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
    alive: true,
    respawnAt: 0,
    kills: 0,
    deaths: 0,
    hasCourse: false,
    courseTx: 0,
    courseTz: 0,
  };
}

/**
 * Make a fresh fighter entity for a player.
 *
 * Preserved for existing callsites; delegates to `spawnEntity` with
 * `kind:"fighter"` and `owner/team` defaulting to `id` / 0.
 */
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

/** Unit forward vector implied by an entity's yaw/pitch (shared convention). */
export function forwardVec(yaw: number, pitch: number): [number, number, number] {
  const cp = Math.cos(pitch);
  return [Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp];
}
