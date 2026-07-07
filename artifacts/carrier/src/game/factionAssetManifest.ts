/**
 * Per-faction live asset manifest — what Carrier must have hot before/during a match.
 *
 * Tier 0 (critical): station + spawn shells — needed at match start.
 * Tier 1 (fleet): six deploy hulls — warmed in hangar, required on deploy.
 * Tier 2 (shared): platforms/turrets/rocks — loaded lazily on first use.
 */
import type { FactionId } from "@workspace/carrier-net";
import {
  DEPLOY_ROLES,
  FACTION_STATIONS,
  FIGHTER_GLB,
  fleetModelFor,
} from "./factionAssets";

export const MATCH_SHARED_ASSETS = [
  "environment/carrier/cyberpunk-platform",
  "props/carrier/turret-gun",
  "props/carrier/turret-cannon",
  "props/carrier/missile",
  "props/carrier/auryn-rockets/rocket1",
  "props/carrier/auryn-rockets/rocket3",
  "props/carrier/auryn-rockets/rocket5",
  "props/rock1",
  "props/rock2",
] as const;

export interface FactionAssetManifest {
  faction: FactionId;
  /** Station parts + fighter spawn shells. */
  critical: string[];
  /** Six deployable fleet GLBs for this faction. */
  fleet: string[];
  /** Match-wide props loaded on demand. */
  shared: readonly string[];
}

/** All asset ids a faction needs for a full live match. */
export function factionAssetManifest(faction: FactionId): FactionAssetManifest {
  const station = FACTION_STATIONS[faction].parts;
  const fleet = DEPLOY_ROLES.map((role) => fleetModelFor(faction, role).id);
  return {
    faction,
    critical: [
      ...station,
      FIGHTER_GLB.player.id,
      FIGHTER_GLB.enemy.id,
    ],
    fleet,
    shared: MATCH_SHARED_ASSETS,
  };
}

/** Deduplicated preload list: critical first, then fleet. */
export function factionWarmupIds(faction: FactionId): string[] {
  const m = factionAssetManifest(faction);
  return [...new Set([...m.critical, ...m.fleet])];
}