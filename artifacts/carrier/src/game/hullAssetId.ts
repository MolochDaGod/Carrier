/**
 * Resolve the catalog asset id used for hull-yaw persistence for a live entity.
 */
import { ENEMY, FACTION_ORDER, type EntityState, type FactionId } from "@workspace/carrier-net";
import { FACTION_STATIONS, fleetModelFor, type DeployRole } from "./factionAssets";
import { spawnShellFor } from "./factionShips";

export function hullAssetIdFor(entity: EntityState): string {
  const faction: FactionId = entity.faction ?? FACTION_ORDER[0];
  if (entity.kind === "mother_ship") {
    return FACTION_STATIONS[faction].parts[0];
  }
  if (entity.kind === "fleet_unit" && entity.role !== "none") {
    return fleetModelFor(faction, entity.role as DeployRole).id;
  }
  const which = entity.team === ENEMY.team ? "enemy" : "player";
  return spawnShellFor(faction, which).id;
}