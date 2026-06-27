/**
 * Tunables, constants, and entity/wire types for the Ruins Brawler — a top-down,
 * twin-stick co-op PvE survival game.
 *
 * The simulation runs in a 2D ground plane: positions/velocities are `(x, z)`
 * (the client maps them onto the XZ plane under a stabilized ortho camera, with
 * `y` = up).  All gameplay numbers live here so the shared sim, the
 * authoritative server room, and the client HUD agree on one source of truth.
 */

export const TICK_HZ = 30;
export const SNAPSHOT_HZ = 20;
export const TICK_DT = 1 / TICK_HZ;

/** Convert seconds to a whole tick count (min 1). */
export const secTicks = (s: number): number => Math.max(1, Math.round(s * TICK_HZ));

/** World bounds + the canonical map seed (same layout for everyone). */
export const WORLD = {
  /** Half-extent of the square arena (units). Full map is `2*half` per side. */
  half: 180,
  seed: 0x5ed1ec75,
} as const;

export const WORLD_SEED = WORLD.seed;

export const PLAYER = {
  radius: 1.2,
  speed: 14,
  maxHp: 100,
  maxArmor: 50,
  /** +armour per shop "armor" purchase, capped at `armorCap`. */
  armorStep: 25,
  armorCap: 125,
  respawnTicks: secTicks(3),
  startAmmo: 80,
  startCredits: 0,
  creditPerKill: 5,
  // Dash attack (RMB): a short, fast lunge along the aim that gores zombies.
  dashSpeed: 55,
  dashTicks: secTicks(0.22),
  dashCooldownTicks: secTicks(1.1),
  dashDamage: 42,
  dashRadius: 3.2,
  // Loot magnet (client + server agree on collection radii).
  pickupRadius: 1.7,
  magnetRadius: 7,
} as const;

export const ZOMBIE = {
  radius: 1.0,
  speed: 6,
  maxHp: 34,
  touchDamage: 9,
  attackRange: 2.2,
  attackCooldownTicks: secTicks(0.8),
  /** Chance a kill spawns a loot pickup. */
  lootChance: 0.55,
  /** 0..1 strength of pairwise crowd separation. */
  separation: 0.5,
} as const;

export const SPAWN = {
  /** Cap = baseMax + perPlayer * (alive players). */
  baseMax: 12,
  perPlayer: 8,
  hardMax: 90,
  intervalTicks: secTicks(0.5),
  perWave: 2,
  /** Spawn ring around a random living player, outside their view. */
  minDist: 34,
  maxDist: 60,
} as const;

export const LOOT = {
  ammoAmount: 20,
  creditAmount: 15,
} as const;

export const PROJECTILE = {
  radius: 0.45,
} as const;

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

export interface WeaponDef {
  id: number;
  name: string;
  cooldownTicks: number;
  /** Bolt speed in units/sec. */
  projectileSpeed: number;
  projectileLifeTicks: number;
  damage: number;
  /** Half-spread in radians applied per pellet. */
  spread: number;
  /** Pellets fired per shot. */
  count: number;
  /** Ammo spent per shot (0 = free, the starter pistol). */
  ammoCost: number;
  /** Bolt colour for the client renderer. */
  color: number;
}

export const WEAPONS: readonly WeaponDef[] = [
  {
    id: 0, name: "Pistol",
    cooldownTicks: secTicks(0.40), projectileSpeed: 60, projectileLifeTicks: secTicks(1.4),
    damage: 15, spread: 0, count: 1, ammoCost: 0, color: 0xffcc44,
  },
  {
    id: 1, name: "Shotgun",
    cooldownTicks: secTicks(0.85), projectileSpeed: 50, projectileLifeTicks: secTicks(0.6),
    damage: 9, spread: 0.30, count: 6, ammoCost: 2, color: 0xff5500,
  },
  {
    id: 2, name: "SMG",
    cooldownTicks: secTicks(0.12), projectileSpeed: 72, projectileLifeTicks: secTicks(1.2),
    damage: 7, spread: 0.14, count: 1, ammoCost: 1, color: 0x00ccff,
  },
  {
    id: 3, name: "Plasma",
    cooldownTicks: secTicks(0.40), projectileSpeed: 88, projectileLifeTicks: secTicks(1.6),
    damage: 32, spread: 0, count: 1, ammoCost: 3, color: 0xcc00ff,
  },
];

export const PISTOL_INDEX = 0;

/** Weapon-ownership bitmask helpers (bit i = weapon i unlocked). */
export function hasWeapon(unlocked: number, idx: number): boolean {
  return (unlocked & (1 << idx)) !== 0;
}

// ---------------------------------------------------------------------------
// Safe-zone shop
// ---------------------------------------------------------------------------

export type ShopItemId = "shotgun" | "smg" | "plasma" | "armor" | "ammo" | "heal";

export interface ShopDef {
  id: ShopItemId;
  label: string;
  cost: number;
  /** Weapon index unlocked, when this item is a weapon. */
  weapon?: number;
  blurb: string;
}

export const SHOP_AMMO_AMOUNT = 50;

export const SHOP: Record<ShopItemId, ShopDef> = {
  shotgun: { id: "shotgun", label: "Shotgun", cost: 120, weapon: 1, blurb: "6-pellet close-range blast" },
  smg: { id: "smg", label: "SMG", cost: 220, weapon: 2, blurb: "Rapid-fire bullet hose" },
  plasma: { id: "plasma", label: "Plasma Lance", cost: 400, weapon: 3, blurb: "High-damage energy bolt" },
  armor: { id: "armor", label: "Armor +25", cost: 60, blurb: "Raise max armour & fully repair" },
  ammo: { id: "ammo", label: "Ammo x50", cost: 30, blurb: "Refill 50 rounds" },
  heal: { id: "heal", label: "Med-Kit", cost: 40, blurb: "Restore full health" },
};

export const SHOP_ORDER: ShopItemId[] = ["shotgun", "smg", "plasma", "armor", "ammo", "heal"];

export function isShopItemId(v: unknown): v is ShopItemId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(SHOP, v);
}

// ---------------------------------------------------------------------------
// World geometry (static, deterministic from the seed)
// ---------------------------------------------------------------------------

/** An axis-aligned ruins block: collision is circle-vs-AABB on (hw, hd). */
export interface Obstacle {
  id: string;
  px: number;
  pz: number;
  /** Half-extent on X. */
  hw: number;
  /** Half-extent on Z. */
  hd: number;
  /** Visual height (renderer only, no collision use). */
  height: number;
  /** Per-block seed for cosmetic client variation. */
  seed: number;
}

export interface SafeZone {
  id: string;
  px: number;
  pz: number;
  radius: number;
}

export interface BrawlWorld {
  obstacles: Obstacle[];
  safeZones: SafeZone[];
}

// ---------------------------------------------------------------------------
// Entities (wire-serialisable)
// ---------------------------------------------------------------------------

export interface PlayerState {
  id: string;
  name: string;
  px: number;
  pz: number;
  vx: number;
  vz: number;
  /** Aim / facing unit direction. */
  ax: number;
  az: number;
  hp: number;
  maxHp: number;
  armor: number;
  maxArmor: number;
  alive: boolean;
  /** Tick at which a dead player respawns. */
  respawnTick: number;
  /** Selected weapon index. */
  weapon: number;
  /** Bitmask of unlocked weapons. */
  unlocked: number;
  credits: number;
  ammo: number;
  kills: number;
  /** Tick until which the player is mid-dash (<= current tick = not dashing). */
  dashTick: number;
  /** Earliest tick a new dash may start. */
  dashReadyTick: number;
  /** Dash direction unit (valid while dashing). */
  dashX: number;
  dashZ: number;
  /** Server-computed: standing in a safe zone (drives client shop + safety). */
  safe: boolean;
}

export interface ZombieState {
  id: string;
  px: number;
  pz: number;
  vx: number;
  vz: number;
  hp: number;
  maxHp: number;
  /** Facing angle (radians, atan2(dx, dz)) for client orientation. */
  facing: number;
  tier: number;
}

export interface ProjectileState {
  id: string;
  px: number;
  pz: number;
  vx: number;
  vz: number;
  /** Owning weapon index (for client bolt colour/size). */
  weapon: number;
}

/** 0 = ammo pickup, 1 = credit pickup. */
export type LootKind = 0 | 1;

export interface LootState {
  id: string;
  px: number;
  pz: number;
  kind: LootKind;
}

export type GameEventKind =
  | "shoot"
  | "hit"
  | "kill"
  | "dash"
  | "purchase"
  | "hurt"
  | "death"
  | "respawn"
  | "pickup";

/** Lightweight transient event for client-side FX (muzzle, sparks, etc). */
export interface GameEvent {
  k: GameEventKind;
  px: number;
  pz: number;
  /** Optional subject id. */
  id?: string;
  /** Optional scalar payload (weapon idx, amount, kind...). */
  n?: number;
}

// ---------------------------------------------------------------------------
// Player input command (folded move + aim + actions; shared client/server)
// ---------------------------------------------------------------------------

export interface PlayerInput {
  /** Monotonic client sequence number (echoed back as `ack`). */
  seq: number;
  /** Intended frame dt in seconds (server clamps to its own fixed step). */
  dt: number;
  /** Desired move direction, each axis -1..1. */
  moveX: number;
  moveZ: number;
  /** Aim direction (world delta from player to cursor; not necessarily unit). */
  aimX: number;
  aimZ: number;
  fire: boolean;
  dash: boolean;
  /** Currently-selected weapon index. */
  weapon: number;
}

// ---------------------------------------------------------------------------
// Spawners
// ---------------------------------------------------------------------------

export function spawnPlayer(id: string, name: string, px: number, pz: number): PlayerState {
  return {
    id,
    name,
    px,
    pz,
    vx: 0,
    vz: 0,
    ax: 0,
    az: 1,
    hp: PLAYER.maxHp,
    maxHp: PLAYER.maxHp,
    armor: PLAYER.maxArmor,
    maxArmor: PLAYER.maxArmor,
    alive: true,
    respawnTick: 0,
    weapon: PISTOL_INDEX,
    unlocked: 1 << PISTOL_INDEX,
    credits: PLAYER.startCredits,
    ammo: PLAYER.startAmmo,
    kills: 0,
    dashTick: 0,
    dashReadyTick: 0,
    dashX: 0,
    dashZ: 1,
    safe: true,
  };
}

export function spawnZombie(id: string, px: number, pz: number, tier = 0): ZombieState {
  const hp = Math.round(ZOMBIE.maxHp * (1 + tier * 0.5));
  return { id, px, pz, vx: 0, vz: 0, hp, maxHp: hp, facing: 0, tier };
}
