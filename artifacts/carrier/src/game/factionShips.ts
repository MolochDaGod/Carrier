/**
 * Client bridge: faction-authored ships from carrier-net + per-faction hull ids.
 */
import {
  DEPLOYABLE_ROLES,
  mothershipEntryFor,
  factionFleetShip,
  type FactionId,
  type FleetRole,
} from "@workspace/carrier-net";
import { fleetModelFor, type DeployRole, type ShipModel } from "./factionAssets";
import { FACTION_ACCENT, MOTHERSHIPS, type MothershipDef } from "./motherships";

/** Spawn-shell hulls tinted per faction (scout = yours, corsair = hostile). */
export function spawnShellFor(
  faction: FactionId,
  which: "player" | "enemy",
): ShipModel {
  const role: DeployRole = which === "player" ? "scout" : "corsair";
  return fleetModelFor(faction, role);
}

/** Full hangar mothership def for a faction + capital class index. */
export function mothershipFor(faction: FactionId, shipType: number): MothershipDef {
  const base = MOTHERSHIPS[shipType] ?? MOTHERSHIPS[0];
  const authored = mothershipEntryFor(faction, shipType);
  const role = DEPLOYABLE_ROLES[shipType] ?? "miner";
  const hull = fleetModelFor(faction, role as DeployRole).id;
  return {
    ...base,
    id: shipType,
    name: authored.codename,
    tagline: authored.tagline,
    role: authored.roleLabel,
    special: authored.special,
    perks: authored.perks,
    flaws: authored.flaws,
    stats: authored.stats,
    description: authored.description,
    hull,
    accent: FACTION_ACCENT[faction],
    turrets: base.turrets,
  };
}

/** Fleet deploy ship lore + gameplay for HUD / shipyard. */
export function fleetShipFor(faction: FactionId, role: FleetRole) {
  return factionFleetShip(faction, role);
}