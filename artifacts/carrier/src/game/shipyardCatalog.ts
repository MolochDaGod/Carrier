/**
 * shipyardCatalog — single source of truth for every Carrier Shipyard slot.
 *
 * Per faction: capital station, six mothership-class hulls (hangar), six deploy
 * fleet hulls, build-system assets, spawn shells, asteroid rocks, and a planned
 * rock-claim structure slot. Each slot carries dossier metadata so the Shipyard
 * can show abilities/stats alongside the 3D preview.
 */
import {
  CELESTIAL,
  FACTIONS,
  MINING,
  MOTHER_SHIP,
  PLATFORM,
  PLATFORM_DEFS,
  PLATFORM_KINDS,
  factionFleetShip,
  fleetRoleDefFor,
  mothershipEntryFor,
  type FactionId,
  type FleetRole,
  type PlatformKind,
} from "@workspace/carrier-net";
import type { ShipSlot } from "./ShipyardInspector";
import {
  DEPLOY_ROLES,
  FACTION_STATIONS,
  FIGHTER_GLB,
  SPAWN_SHELL_SLOTS,
  fleetModelFor,
} from "./factionAssets";
import { SHIP_FIT } from "./constants";


/** In-match platform tile (tethered build ring). */
export const PLATFORM_TILE_ID = "environment/carrier/cyberpunk-platform";
/** Hangar showcase platform (larger variant). */
export const PLATFORM_SHOWCASE_ID = "environment/carrier/cyberpunk-platform-b";
export const TURRET_GUN_ID = "props/carrier/turret-gun";
export const TURRET_CANNON_ID = "props/carrier/turret-cannon";
export const ROCK_IDS = ["props/rock1", "props/rock2"] as const;

/** Override storage key for a faction's planned rock-claim structure (no baked GLB yet). */
export function rockClaimKey(faction: FactionId): string {
  return `carrier/rock-claim/${faction}`;
}

export type ShipyardDossierRef =
  | { type: "station" }
  | { type: "mothership"; shipType: number }
  | { type: "fleet"; role: FleetRole }
  | { type: "spawn"; shell: "player" | "enemy" }
  | { type: "platform-asset" }
  | { type: "platform-kind"; kind: PlatformKind }
  | { type: "turret"; variant: "gun" | "cannon" }
  | { type: "rock"; variant: 0 | 1 }
  | { type: "rock-claim" }
  | { type: "rock-system" }
  | { type: "build-system" };

export type ShipyardSlot = ShipSlot & {
  dossier: ShipyardDossierRef;
};

function mothershipHullFit(hullScale: number): number {
  return SHIP_FIT * (1.2 + hullScale);
}

/**
 * Every preview/import slot for `faction`. Order: station → mothership classes →
 * fleet → build → spawn → rocks → rock claim.
 */
export function buildShipyardSlots(faction: FactionId): ShipyardSlot[] {
  const slots: ShipyardSlot[] = [];

  const stationDef = FACTION_STATIONS[faction];
  slots.push({
    key: stationDef.parts[0],
    label: `${FACTIONS[faction].name} Station`,
    hint: "Capital hull in matches",
    group: "Capital Station",
    fit: SHIP_FIT * MOTHER_SHIP.scaleFactor * stationDef.fitMul,
    kind: "station",
    catalogIds: stationDef.parts,
    faction,
    dossier: { type: "station" },
  });

  DEPLOY_ROLES.forEach((role, shipType) => {
    const cap = mothershipEntryFor(faction, shipType);
    const hull = fleetModelFor(faction, role).id;
    slots.push({
      key: `carrier/${faction}/mothership/${shipType}`,
      label: cap.codename,
      hint: cap.roleLabel,
      group: "Mothership Classes",
      fit: mothershipHullFit(0.9 + shipType * 0.12),
      kind: "mothership",
      catalogIds: [hull],
      dossier: { type: "mothership", shipType },
    });
  });

  for (const role of DEPLOY_ROLES) {
    const model = fleetModelFor(faction, role);
    const authored = factionFleetShip(faction, role);
    const roleDef = fleetRoleDefFor(faction, role);
    slots.push({
      key: `carrier/${faction}/fleet/${role}`,
      label: authored?.codename ?? roleDef?.label ?? role,
      hint: `${roleDef?.cost ?? "?"} cr · ${authored?.special ?? roleDef?.label ?? ""}`,
      group: "Deployed Fleet",
      fit: roleDef ? roleDef.scale : 8,
      kind: "fleet",
      catalogIds: [model.id],
      yaw: model.yaw,
      dossier: { type: "fleet", role },
    });
  }

  slots.push({
    key: PLATFORM_TILE_ID,
    label: "Platform Tile",
    hint: "Tethered build ring in matches",
    group: "Build System",
    fit: SHIP_FIT * 0.2,
    kind: "platform",
    catalogIds: [PLATFORM_TILE_ID],
    dossier: { type: "platform-asset" },
  });

  for (const kind of PLATFORM_KINDS) {
    const def = PLATFORM_DEFS[kind];
    slots.push({
      key: `carrier/platform-kind/${kind}`,
      label: def.label,
      hint: `${def.cost} cr · ${def.blurb}`,
      group: "Build System",
      fit: SHIP_FIT * 0.2,
      kind: "platform",
      catalogIds: [PLATFORM_TILE_ID],
      dossier: { type: "platform-kind", kind },
    });
  }

  slots.push({
    key: TURRET_GUN_ID,
    label: "Pulse Turret",
    hint: "Hangar + hull mount",
    group: "Build System",
    fit: 3,
    kind: "turret",
    catalogIds: [TURRET_GUN_ID],
    dossier: { type: "turret", variant: "gun" },
  });

  slots.push({
    key: TURRET_CANNON_ID,
    label: "Heavy Cannon",
    hint: "Capital battery",
    group: "Build System",
    fit: 3.6,
    kind: "turret",
    catalogIds: [TURRET_CANNON_ID],
    dossier: { type: "turret", variant: "cannon" },
  });

  slots.push({
    key: "carrier/build-system-overview",
    label: "Build Overview",
    hint: "Platforms + cooldowns",
    group: "Build System",
    fit: SHIP_FIT * 0.2,
    kind: "platform",
    catalogIds: [PLATFORM_TILE_ID],
    dossier: { type: "build-system" },
  });

  for (const shell of SPAWN_SHELL_SLOTS) {
    const model = FIGHTER_GLB[shell.key];
    slots.push({
      key: model.id,
      label: shell.label,
      hint: shell.hint,
      group: "Spawn Shells",
      fit: SHIP_FIT,
      kind: "fighter",
      catalogIds: [model.id],
      yaw: model.yaw,
      dossier: { type: "spawn", shell: shell.key },
    });
  }

  ROCK_IDS.forEach((id, i) => {
    slots.push({
      key: id,
      label: `Asteroid ${i + 1}`,
      hint: "Celestial harvest rock",
      group: "Rock System",
      fit: (CELESTIAL.asteroidMinR + CELESTIAL.asteroidMaxR),
      kind: "rock",
      catalogIds: [id],
      dossier: { type: "rock", variant: i as 0 | 1 },
    });
  });

  slots.push({
    key: rockClaimKey(faction),
    label: `${FACTIONS[faction].name} Rock Claim`,
    hint: "Planned · import your structure",
    group: "Rock System",
    fit: SHIP_FIT * 1.4,
    kind: "rock",
    catalogIds: [],
    dossier: { type: "rock-claim" },
  });

  slots.push({
    key: `carrier/rock-system/${faction}`,
    label: "Mining & Outposts",
    hint: "Asteroids + contest pings",
    group: "Rock System",
    fit: (CELESTIAL.asteroidMinR + CELESTIAL.asteroidMaxR) * 0.5,
    kind: "rock",
    catalogIds: ROCK_IDS.slice(),
    dossier: { type: "rock-system" },
  });

  return slots;
}

/** Human-readable mining + celestial summary for the rock-system dossier. */
export const ROCK_SYSTEM_FACTS = [
  { label: "Asteroids in arena", value: String(CELESTIAL.asteroidCount) },
  { label: "Asteroid radius", value: `${CELESTIAL.asteroidMinR}–${CELESTIAL.asteroidMaxR} m` },
  { label: "Miner harvest range", value: `${MINING.range} m` },
  { label: "Credits while mining", value: `${MINING.creditPerSec} cr/s` },
  { label: "Outpost tiers", value: "Skirmish · Raid Camp · Stronghold" },
  { label: "Rock claim building", value: "Per-faction structure (import slot)" },
] as const;

export const BUILD_SYSTEM_FACTS = [
  { label: "Max platforms", value: String(PLATFORM.maxPerPlayer) },
  { label: "Cable length", value: `${PLATFORM.cableLength} m` },
  { label: "Build cooldown", value: `${PLATFORM.buildCooldownMs} ms` },
  { label: "Platform HP", value: String(PLATFORM.maxHp) },
] as const;