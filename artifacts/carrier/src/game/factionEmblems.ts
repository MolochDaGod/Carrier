/**
 * Faction emblem artwork — the five hand-drawn faction crests (backgrounds
 * removed → transparent PNGs) keyed by FactionId.  Rendered as circular
 * avatar badges via <FactionEmblem/> across the landing screen, hangar, HUD
 * and lore panels so every faction reads with one consistent insignia.
 */
import type { FactionId } from "@workspace/carrier-net";
import scavengers from "@/assets/factions/scavengers.png";
import hollow from "@/assets/factions/hollow.png";
import network from "@/assets/factions/network.png";
import brood from "@/assets/factions/brood.png";
import prospector from "@/assets/factions/prospector.png";

export const FACTION_EMBLEMS: Record<FactionId, string> = {
  scavengers,
  hollow,
  network,
  brood,
  prospector,
};
