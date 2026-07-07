/**
 * Per-faction ship roster — unique name, stats, costs, and abilities for every
 * hull a faction fields. The deterministic sim + server read these tables so
 * dossier numbers match live gameplay.
 */
import type {
  FactionId,
  FleetRole,
  FleetRoleDef,
  PlatformDef,
  PlatformKind,
  ShipStatCard,
} from "./types";

type DeployRole = Exclude<FleetRole, "none">;

/** Baseline class stats (mirrors types.CLASS_STAT_CARDS — kept local to avoid import cycles). */
const BASE_CLASS_STATS: readonly ShipStatCard[] = [
  { speed: 45, defense: 30, attack: 10, shield: 25, explosive: 5, drones: 60 },
  { speed: 95, defense: 20, attack: 45, shield: 25, explosive: 30, drones: 50 },
  { speed: 65, defense: 55, attack: 50, shield: 45, explosive: 40, drones: 55 },
  { speed: 40, defense: 70, attack: 25, shield: 75, explosive: 20, drones: 65 },
  { speed: 60, defense: 75, attack: 80, shield: 70, explosive: 65, drones: 45 },
  { speed: 25, defense: 95, attack: 95, shield: 85, explosive: 90, drones: 40 },
];

const ROLE_INDEX: Record<DeployRole, number> = {
  miner: 0, scout: 1, corsair: 2, frigate: 3, cruiser: 4, dreadnought: 5,
};

/** Baseline fleet role defs (mirrors types.FLEET_ROLES). */
const BASE_FLEET_ROLES: Record<DeployRole, FleetRoleDef> = {
  miner: { role: "miner", label: "Miner", cost: 40, cap: 6, scale: 5, maxHp: 40, maxShield: 18, zoneR: 320, speedMult: 0.75, engageRange: 0, fireRange: 0, armed: false },
  scout: { role: "scout", label: "Scout Drone", cost: 55, cap: 6, scale: 8, maxHp: 45, maxShield: 30, zoneR: 460, speedMult: 1.25, engageRange: 520, fireRange: 240, armed: true },
  corsair: { role: "corsair", label: "Corsair Drone", cost: 80, cap: 5, scale: 12, maxHp: 70, maxShield: 45, zoneR: 500, speedMult: 1.05, engageRange: 580, fireRange: 260, armed: true },
  frigate: { role: "frigate", label: "Frigate", cost: 95, cap: 4, scale: 18, maxHp: 100, maxShield: 70, zoneR: 540, speedMult: 0.9, engageRange: 340, fireRange: 190, armed: true },
  cruiser: { role: "cruiser", label: "Cruiser", cost: 120, cap: 3, scale: 26, maxHp: 140, maxShield: 110, zoneR: 620, speedMult: 0.95, engageRange: 620, fireRange: 240, armed: true },
  dreadnought: { role: "dreadnought", label: "Dreadnought", cost: 165, cap: 2, scale: 42, maxHp: 210, maxShield: 170, zoneR: 720, speedMult: 0.85, engageRange: 780, fireRange: 270, armed: true },
};

const BASE_PLATFORM_DEFS: Record<PlatformKind, PlatformDef> = {
  turret: { kind: "turret", label: "Turret", cost: 90, blurb: "Auto-fires on hostiles in range" },
  production: { kind: "production", label: "Production", cost: 110, blurb: "+6 cr/s while operational" },
  utility: { kind: "utility", label: "Utility", cost: 80, blurb: "Repairs nearby fleet + carrier" },
};

function isDeployRole(role: FleetRole): role is DeployRole {
  return typeof role === "string" && Object.hasOwn(BASE_FLEET_ROLES, role);
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

function stat(base: ShipStatCard, d: Partial<ShipStatCard>): ShipStatCard {
  return {
    speed: clamp(base.speed + (d.speed ?? 0)),
    defense: clamp(base.defense + (d.defense ?? 0)),
    attack: clamp(base.attack + (d.attack ?? 0)),
    shield: clamp(base.shield + (d.shield ?? 0)),
    explosive: clamp(base.explosive + (d.explosive ?? 0)),
    drones: clamp(base.drones + (d.drones ?? 0)),
  };
}

function role(
  base: FleetRoleDef,
  patch: Partial<FleetRoleDef> & { label: string },
): FleetRoleDef {
  return { ...base, ...patch, role: base.role };
}

/** One deployable fleet hull authored for a specific faction. */
export interface FactionFleetShip {
  codename: string;
  special: string;
  stats: ShipStatCard;
  role: FleetRoleDef;
}

/** Capital class (shipType 0..5) authored per faction. */
export interface FactionMothershipShip {
  codename: string;
  tagline: string;
  roleLabel: string;
  special: string;
  description: string;
  perks: string[];
  flaws: string[];
  stats: ShipStatCard;
}

/** Faction build-ring tuning. */
export interface FactionBuildProfile {
  platformCostMult: Record<PlatformKind, number>;
  productionBonusPerSec: number;
  utilityRepairPerSec: number;
  blurb: string;
}

/** Faction asteroid harvest tuning. */
export interface FactionMiningProfile {
  creditPerSec: number;
  range: number;
  blurb: string;
}

function fleetShip(
  factionRole: DeployRole,
  codename: string,
  special: string,
  statDelta: Partial<ShipStatCard>,
  patch: Partial<FleetRoleDef> & { label: string },
): FactionFleetShip {
  const i = ROLE_INDEX[factionRole];
  const baseRole = BASE_FLEET_ROLES[factionRole];
  const baseStats = BASE_CLASS_STATS[i];
  return {
    codename,
    special,
    stats: stat(baseStats, statDelta),
    role: role(baseRole, patch),
  };
}

function capitalShip(
  shipType: number,
  codename: string,
  tagline: string,
  roleLabel: string,
  special: string,
  description: string,
  perks: string[],
  flaws: string[],
  statDelta: Partial<ShipStatCard>,
): FactionMothershipShip {
  const base = BASE_CLASS_STATS[shipType] ?? BASE_CLASS_STATS[0];
  return {
    codename,
    tagline,
    roleLabel,
    special,
    description,
    perks,
    flaws,
    stats: stat(base, statDelta),
  };
}

/** 5 factions × 6 deploy roles — unique codenames, costs, and stat spreads. */
export const FACTION_FLEET: Record<FactionId, Record<DeployRole, FactionFleetShip>> = {
  scavengers: {
    miner: fleetShip("miner", "Rust Skimmer", "Salvage Siphon — strips claim rocks 15% faster.", { drones: 12, defense: -5 }, { label: "Rust Skimmer", cost: 34, cap: 7, maxHp: 38 }),
    scout: fleetShip("scout", "Camo Ghost", "Ghost Sweep — +range on first contact.", { speed: 8, defense: -8 }, { label: "Camo Ghost", cost: 48, engageRange: 560, fireRange: 250 }),
    corsair: fleetShip("corsair", "Red Fang", "Fang Salvage — bonus credits on outpost clears.", { attack: 8, explosive: 10 }, { label: "Red Fang", cost: 72 }),
    frigate: fleetShip("frigate", "Transtellar Mule", "Mule Tow — hauls extra reward cache.", { defense: 5, shield: 8 }, { label: "Transtellar Mule", cost: 88, maxShield: 78 }),
    cruiser: fleetShip("cruiser", "Salvage Cruiser", "Scrap Barrage — wider engage arc.", { attack: 6, explosive: 12 }, { label: "Salvage Cruiser", cost: 112, engageRange: 660 }),
    dreadnought: fleetShip("dreadnought", "Pyramid Bomber", "Pyramid Siege — heavy burst on capitals.", { attack: 10, explosive: 15 }, { label: "Pyramid Bomber", cost: 152, maxHp: 200 }),
  },
  hollow: {
    miner: fleetShip("miner", "Void Siphon", "Cold Siphon — steadier shield while mining.", { shield: 10, speed: -8 }, { label: "Void Siphon", cost: 42, maxShield: 24 }),
    scout: fleetShip("scout", "V-Shooter", "Frost Recon — spots hostiles through nebula.", { defense: 6, speed: 4 }, { label: "V-Shooter", cost: 58, maxHp: 50 }),
    corsair: fleetShip("corsair", "Hollow Raider", "Ring Raid — peels to wounded allies.", { defense: 12, attack: 4 }, { label: "Hollow Raider", cost: 82, maxHp: 78 }),
    frigate: fleetShip("frigate", "Ring Warden", "Aegis Ring — repairs nearby fleet.", { shield: 15, defense: 10 }, { label: "Ring Warden", cost: 98, maxShield: 82 }),
    cruiser: fleetShip("cruiser", "Spire Cruiser", "Cathedral Lance — sustained shield pressure.", { defense: 14, shield: 12 }, { label: "Spire Cruiser", cost: 125, maxShield: 125 }),
    dreadnought: fleetShip("dreadnought", "Lord's Destroyer", "Hollow Judgment — armoured line anchor.", { defense: 18, speed: -10 }, { label: "Lord's Destroyer", cost: 172, maxHp: 230, maxShield: 190 }),
  },
  network: {
    miner: fleetShip("miner", "Data Cutter", "Packet Mine — relays ore credits to carrier.", { drones: 15, speed: 5 }, { label: "Data Cutter", cost: 40 }),
    scout: fleetShip("scout", "Tri-Shot Node", "Mesh Scan — shares target data fleet-wide.", { drones: 12, speed: 6 }, { label: "Tri-Shot Node", cost: 54, engageRange: 600 }),
    corsair: fleetShip("corsair", "Relay Raider", "Burst Route — hit-and-run data spikes.", { speed: 8, attack: 6 }, { label: "Relay Raider", cost: 78 }),
    frigate: fleetShip("frigate", "Hub Escort", "Hub Guard — production platforms +1 cr/s.", { shield: 8, drones: 10 }, { label: "Hub Escort", cost: 92 }),
    cruiser: fleetShip("cruiser", "Cube Cruiser", "Cube Barrage — all-range relay fire.", { attack: 8, defense: 6 }, { label: "Cube Cruiser", cost: 118 }),
    dreadnought: fleetShip("dreadnought", "Network Dread", "Hive Barrage — drone-saturated salvos.", { drones: 18, attack: 8 }, { label: "Network Dread", cost: 160, maxHp: 205 }),
  },
  brood: {
    miner: fleetShip("miner", "Hive Worm", "Bore Worm — organic regen while latched.", { defense: 8, shield: 6 }, { label: "Hive Worm", cost: 38, maxHp: 48 }),
    scout: fleetShip("scout", "Delphi Eye", "Spore Scout — reveals cloaked pockets.", { drones: 14, speed: 10 }, { label: "Delphi Eye", cost: 52 }),
    corsair: fleetShip("corsair", "Void Core", "Spine Raid — bleeds hull on contact.", { attack: 10, explosive: 8 }, { label: "Void Core", cost: 76, maxHp: 74 }),
    frigate: fleetShip("frigate", "Bloodvein", "Vein Mend — heals organic allies.", { shield: 12, defense: 6 }, { label: "Bloodvein", cost: 90, maxShield: 82 }),
    cruiser: fleetShip("cruiser", "Hytri Cruiser", "Spore Cruiser — area denial blooms.", { explosive: 14, attack: 6 }, { label: "Hytri Cruiser", cost: 115 }),
    dreadnought: fleetShip("dreadnought", "Leviathan", "Brood Wake — capstone bio-battery.", { defense: 12, attack: 12 }, { label: "Leviathan", cost: 158, maxHp: 225 }),
  },
  prospector: {
    miner: fleetShip("miner", "Twin Rig", "Twin Beam — highest yield on asteroids.", { drones: 8, speed: -5 }, { label: "Twin Rig", cost: 36, cap: 8 }),
    scout: fleetShip("scout", "The Ram", "Ram Probe — fast belt prospecting.", { speed: 12 }, { label: "The Ram", cost: 50, engageRange: 500 }),
    corsair: fleetShip("corsair", "Belt Scout", "Claim Raider — bonus on rock captures.", { attack: 5, drones: 8 }, { label: "Belt Scout", cost: 74 }),
    frigate: fleetShip("frigate", "Ore Hauler", "Hauler Escort — extends miner range.", { defense: 8, shield: 6 }, { label: "Ore Hauler", cost: 88 }),
    cruiser: fleetShip("cruiser", "Claim Cruiser", "Strip Cruiser — cracks fortified rocks.", { attack: 7, explosive: 6 }, { label: "Claim Cruiser", cost: 114 }),
    dreadnought: fleetShip("dreadnought", "Spine Dread", "Spine Breaker — industrial siege platform.", { defense: 10, speed: -8 }, { label: "Spine Dread", cost: 150, scale: 44 }),
  },
};

/** 5 factions × 6 capital classes (shipType 0..5). */
export const FACTION_MOTHERSHIP: Record<FactionId, FactionMothershipShip[]> = {
  scavengers: [
    capitalShip(0, "Pyramid Miner", "Strip a system to bedrock", "Salvage Harvester", "Ore Siphon — twin beams on belt rocks.", "The pyramid-ark drinks belts dry.", ["Largest cargo", "Cheapest replace"], ["No real guns"], { drones: 15 }),
    capitalShip(1, "Ghost Runner", "First in, first to loot", "Recon Skirmisher", "Wide Sweep — finds claims early.", "Camo ghost hull for hit-and-run.", ["Fastest turn rate"], ["Paper thin"], { speed: 10, defense: -10 }),
    capitalShip(2, "Fang Raider", "Take it, weld it, sell it", "Salvage Raider", "Salvage Cutter — patches in combat.", "Self-sufficient scrap raider.", ["Salvage bonus"], ["Jack of trades"], { attack: 6, explosive: 8 }),
    capitalShip(3, "Mule Tender", "Keep the fleet flying", "Support Hauler", "Tow Line — feeds the supply chain.", "Fleet medic and ore mule.", ["Repair aura"], ["Slow"], { shield: 12, defense: 8 }),
    capitalShip(4, "Scrap Cruiser", "The line that holds", "Battle Salvager", "All-Range Scrap — sustained fire.", "Workhorse gun-deck.", ["Strong shields"], ["Expensive"], { attack: 8, defense: 6 }),
    capitalShip(5, "Pyramid Dread", "Bring a fleet or nothing", "Salvage Dreadnought", "Pyramid Barrage — siege salvos.", "Apex scrap battleship.", ["Heaviest fire"], ["Ponderous"], { attack: 12, defense: 10, speed: -12 }),
  ],
  hollow: [
    capitalShip(0, "Spire Miner", "Cold extraction", "Void Harvester", "Void Siphon — shielded mining.", "Cathedral spire drinks ore.", ["Shielded mine"], ["Slow"], { shield: 12, defense: 6 }),
    capitalShip(1, "Phantom Skiff", "Silent recon", "Ghost Skirmisher", "Frost Sweep — long sensor reach.", "Lean phantom scout.", ["Sensor range"], ["Fragile"], { speed: 8, defense: -6 }),
    capitalShip(2, "Ring Raider", "Raid the weak", "Hollow Raider", "Ring Cutter — bleeds on pass.", "Noble raider with repair.", ["Self repair"], ["Light guns"], { defense: 10 }),
    capitalShip(3, "Cathedral Tender", "Hold the line", "Ring Medic", "Aegis Projector — dual repair.", "Fleet medic of the rings.", ["Dual repair"], ["Modest speed"], { shield: 18, defense: 10 }),
    capitalShip(4, "Spire Cruiser", "Break their wall", "Battle Spire", "Lance Battery — shield pressure.", "All-range spire battery.", ["Armoured"], ["Costly"], { defense: 12, attack: 6 }),
    capitalShip(5, "Hollow Dread", "Judgment in the void", "Lord's Capital", "Judgment Lance — anchor line.", "Apex hollow warship.", ["Max armour"], ["Very slow"], { defense: 18, attack: 8, speed: -15 }),
  ],
  network: [
    capitalShip(0, "Cube Miner", "Packet ore home", "Data Harvester", "Mesh Siphon — relays credits.", "Hub miner feeds the mesh.", ["Relay bonus"], ["Soft hull"], { drones: 12, speed: 4 }),
    capitalShip(1, "Node Skiff", "Ping everything", "Mesh Scout", "Wide Mesh — early intel.", "Fast relay scout.", ["Best sensors"], ["Thin"], { speed: 12, drones: 10 }),
    capitalShip(2, "Relay Raider", "Burst and fade", "Data Raider", "Burst Route — spike damage.", "Raider with mesh backup.", ["Balanced"], ["No repair"], { attack: 6, speed: 4 }),
    capitalShip(3, "Hub Tender", "Keep nodes alive", "Network Medic", "Hub Guard — repairs mesh.", "Medic for the mesh fleet.", ["Repair field"], ["Slow"], { shield: 14 }),
    capitalShip(4, "Cube Cruiser", "Synchronized fire", "Battle Hub", "Cube Barrage — linked salvos.", "Synchronized gun deck.", ["All-range"], ["Pricey"], { attack: 10 }),
    capitalShip(5, "Mesh Dread", "The hive decides", "Network Capital", "Hive Barrage — drone storm.", "Apex mesh battleship.", ["Drone swarm"], ["Huge"], { drones: 20, attack: 10 }),
  ],
  brood: [
    capitalShip(0, "Hive Miner", "Grow your claim", "Organic Harvester", "Bore Worm — regen while mining.", "Living miner worm.", ["Regen mine"], ["Weak"], { defense: 8, shield: 8 }),
    capitalShip(1, "Delphi Skiff", "The hive sees", "Spore Scout", "Spore Sweep — reveals pockets.", "Organic recon eye.", ["Vision"], ["Fragile"], { drones: 16, speed: 6 }),
    capitalShip(2, "Void Raider", "Rip and feed", "Bio Raider", "Spine Raid — bleed contact.", "Void-core raider.", ["Self sustain"], ["Mid damage"], { attack: 8, explosive: 6 }),
    capitalShip(3, "Vein Tender", "Mend the brood", "Hive Medic", "Vein Mend — heals bio allies.", "Bloodvein medic ship.", ["Heal aura"], ["Slow"], { shield: 16 }),
    capitalShip(4, "Hytri Cruiser", "Bloom denial", "Spore Cruiser", "Bloom Barrage — area spores.", "Organic cruiser.", ["AoE"], ["Costly"], { explosive: 14 }),
    capitalShip(5, "Brood Leviathan", "The hive awakens", "Hive Capital", "Brood Wake — bio siege.", "Apex living dread.", ["Max HP"], ["Slowest"], { defense: 14, attack: 10, speed: -18 }),
  ],
  prospector: [
    capitalShip(0, "Twin Rig", "Strip belts bare", "Industrial Miner", "Twin Beam — top yield.", "Industrial twin miner.", ["Top yield"], ["Defenceless"], { drones: 10, speed: -6 }),
    capitalShip(1, "Ram Skiff", "First to the claim", "Belt Scout", "Ram Sweep — fast prospect.", "Fast belt scout.", ["Speed"], ["Light"], { speed: 14 }),
    capitalShip(2, "Claim Raider", "Take the rock", "Salvage Raider", "Claim Cutter — capture bonus.", "Raider for rock claims.", ["Claim bonus"], ["Mid armour"], { attack: 5 }),
    capitalShip(3, "Hauler Tender", "Feed the rigs", "Industrial Medic", "Hauler Line — extends miners.", "Ore hauler support.", ["Range boost"], ["Slow"], { shield: 10, drones: 8 }),
    capitalShip(4, "Strip Cruiser", "Crack fortifications", "Claim Cruiser", "Strip Battery — rock siege.", "Cracks fortified claims.", ["Siege"], ["Expensive"], { attack: 8 }),
    capitalShip(5, "Spine Dread", "Own the belt", "Industrial Capital", "Spine Breaker — belt dominator.", "Apex mining dread.", ["Heavy"], ["Wide turn"], { defense: 12, speed: -10 }),
  ],
};

export const FACTION_BUILD: Record<FactionId, FactionBuildProfile> = {
  scavengers: {
    platformCostMult: { turret: 0.9, production: 0.85, utility: 0.95 },
    productionBonusPerSec: 7,
    utilityRepairPerSec: 5,
    blurb: "Scrap rigs — cheap platforms welded from salvage.",
  },
  hollow: {
    platformCostMult: { turret: 1.05, production: 1.0, utility: 0.9 },
    productionBonusPerSec: 6,
    utilityRepairPerSec: 7,
    blurb: "Ring forges — defensive utility focus.",
  },
  network: {
    platformCostMult: { turret: 1.0, production: 0.9, utility: 1.0 },
    productionBonusPerSec: 8,
    utilityRepairPerSec: 5,
    blurb: "Mesh hubs — production relay bonus.",
  },
  brood: {
    platformCostMult: { turret: 1.1, production: 1.05, utility: 0.88 },
    productionBonusPerSec: 5,
    utilityRepairPerSec: 8,
    blurb: "Organic pylons — strong repair fields.",
  },
  prospector: {
    platformCostMult: { turret: 1.0, production: 0.8, utility: 1.0 },
    productionBonusPerSec: 9,
    utilityRepairPerSec: 5,
    blurb: "Industrial rigs — cheapest production lines.",
  },
};

export const FACTION_MINING: Record<FactionId, FactionMiningProfile> = {
  scavengers: { creditPerSec: 15, range: 480, blurb: "Salvage beams — fast on picked-over rocks." },
  hollow: { creditPerSec: 12, range: 440, blurb: "Cold siphons — shorter reach, steady shield." },
  network: { creditPerSec: 14, range: 500, blurb: "Mesh harvest — relays credits to carrier." },
  brood: { creditPerSec: 13, range: 450, blurb: "Organic bore — regen while latched." },
  prospector: { creditPerSec: 18, range: 520, blurb: "Twin beams — highest belt yield." },
};

/** Resolve the fleet gameplay def for a faction + role. */
export function fleetRoleDefFor(faction: FactionId, role: FleetRole): FleetRoleDef | null {
  if (!isDeployRole(role)) return null;
  return FACTION_FLEET[faction][role].role;
}

/** Full authored fleet entry (lore + stats + gameplay). */
export function factionFleetShip(faction: FactionId, role: FleetRole): FactionFleetShip | null {
  if (!isDeployRole(role)) return null;
  return FACTION_FLEET[faction][role];
}

/** Stat card for a faction's deployable role. */
export function statCardForFactionRole(faction: FactionId, role: FleetRole): ShipStatCard | null {
  const ship = factionFleetShip(faction, role);
  return ship?.stats ?? null;
}

/** Stat card for a faction's capital class (shipType 0..5). */
export function statCardForFactionMothership(faction: FactionId, shipType: number): ShipStatCard {
  const i = Math.max(0, Math.min(5, shipType | 0));
  return FACTION_MOTHERSHIP[faction][i].stats;
}

/** Capital ship dossier for hangar / shipyard. */
export function mothershipEntryFor(faction: FactionId, shipType: number): FactionMothershipShip {
  const i = Math.max(0, Math.min(5, shipType | 0));
  return FACTION_MOTHERSHIP[faction][i];
}

/** Platform def with faction-adjusted cost label. */
export function platformDefFor(faction: FactionId, kind: PlatformKind): PlatformDef {
  const base = BASE_PLATFORM_DEFS[kind];
  const mult = FACTION_BUILD[faction].platformCostMult[kind];
  return {
    ...base,
    cost: Math.round(base.cost * mult),
    blurb: `${base.blurb} · ${FACTION_BUILD[faction].blurb}`,
  };
}

/** Mining tunables for a faction's harvesters. */
export function miningFor(faction: FactionId): FactionMiningProfile {
  return FACTION_MINING[faction];
}

