/**
 * Faction + class → render-asset mapping for the carrier client.
 *
 * Pure presentation data: the shared `@workspace/carrier-net` layer owns the
 * faction identities (id/name/colour/blurb) and the deployable class list; this
 * module is the *client-only* bridge from those ids to concrete GLB/OBJ asset
 * ids in `@workspace/assets`.  Kept separate from `constants.ts` so the asset
 * wiring (the part most likely to be re-pointed after a visual pass) lives in
 * one obvious place.
 *
 * Asset ids are the path under `lib/assets/models/` minus the file extension.
 */
import type { FactionId } from "@workspace/carrier-net";

export type DeployRole = "miner" | "scout" | "corsair" | "frigate" | "cruiser" | "dreadnought";

/** Deployable class order (small → large): miner … dreadnought. */
export const DEPLOY_ROLES: DeployRole[] = [
  "miner",
  "scout",
  "corsair",
  "frigate",
  "cruiser",
  "dreadnought",
];

/**
 * Per-class fleet hull GLB.
 *
 * Nose orientation: when `yaw` is omitted the loader auto-orients the hull so its
 * nose faces local +Z (the engine's canonical nose) by taper-detecting the
 * pointier end — this is the default for every hull so models from mixed sources
 * all fly nose-forward without per-model tuning. Set `yaw` only to force a fixed
 * Y-rotation (radians) when the auto-detection guesses wrong for a given model.
 */
export interface ShipModel {
  id: string;
  /** Optional manual Y-rotation (radians); omit to auto-orient nose → local +Z. */
  yaw?: number;
}

/**
 * Per-faction deployable fleet hulls — each faction fields a VISUALLY DISTINCT
 * set of six class hulls (no hull is shared across factions), so a player can
 * tell at a glance which faction deployed a unit. This is the baked-in deploy
 * default for every match; the Shipyard's per-device imports only override the
 * preview/local render keyed by these ids.
 *
 * Roster shape per faction (small → large): two small fleet hulls (miner/scout),
 * two mid raiders (corsair/frigate), then two capital-class hulls
 * (cruiser/dreadnought). `scavengers` keeps the original proven mixed set
 * (skimmer/obj/fbx); the other four draw distinct GLBs from the verified pool.
 *
 * Orientation: only the skimmer needs a forced half-turn (authored nose-toward
 * local -Z); every other hull relies on the loader's taper auto-orientation.
 */
export const FLEET_BY_FACTION: Record<FactionId, Record<DeployRole, ShipModel>> = {
  scavengers: {
    miner: { id: "vehicles/space/fleet/skimmer", yaw: Math.PI },
    scout: { id: "vehicles/space/fleet/camo-jet/camo-jet" },
    corsair: { id: "vehicles/space/fighters/interceptor/interceptor" },
    frigate: { id: "vehicles/space/fleet/transtellar/transtellar" },
    cruiser: { id: "vehicles/space/raiders/spaceship-concept" },
    dreadnought: { id: "vehicles/space/bombers/bomber/bomber" },
  },
  hollow: {
    miner: { id: "vehicles/space/fleet/beamer" },
    scout: { id: "vehicles/space/fleet/v-shooter" },
    corsair: { id: "vehicles/space/raiders/raider-01" },
    frigate: { id: "vehicles/space/raiders/raider-02" },
    cruiser: { id: "vehicles/space/capital/cruiser-01" },
    dreadnought: { id: "vehicles/space/capital/destroyer-01" },
  },
  network: {
    miner: { id: "vehicles/space/fleet/cutter" },
    scout: { id: "vehicles/space/fleet/tri-shot" },
    corsair: { id: "vehicles/space/raiders/raider-03" },
    frigate: { id: "vehicles/space/raiders/raider-04" },
    cruiser: { id: "vehicles/space/capital/cruiser-02" },
    dreadnought: { id: "vehicles/space/capital/destroyer-02" },
  },
  // The Brood fields a fully LIVING fleet — organic hive-creatures grown for
  // war, not built. Six bespoke hulls (small → large): a deployed worm-drone, a
  // recon core, a void-core raider, the bloodvein frigate, the hytri cruiser,
  // and the leviathan war-vessel. The Hive Queen (FACTION_STATIONS.brood) births
  // them. All auto-orient by taper; none carry a forced yaw.
  brood: {
    miner: { id: "vehicles/space/brood/flesh-hive-worm" },
    scout: { id: "vehicles/space/brood/delphi-recon-station" },
    corsair: { id: "vehicles/space/brood/void-core" },
    frigate: { id: "vehicles/space/brood/bloodvein-frigate" },
    cruiser: { id: "vehicles/space/brood/hytri-cruiser" },
    dreadnought: { id: "vehicles/space/brood/leviathan" },
  },
  prospector: {
    miner: { id: "vehicles/space/fleet/twin-engine" },
    scout: { id: "vehicles/space/fleet/the-ram" },
    corsair: { id: "vehicles/space/fleet/scout" },
    frigate: { id: "vehicles/space/raiders/simple-ship" },
    cruiser: { id: "vehicles/space/raiders/spaceship-01" },
    dreadnought: { id: "vehicles/space/raiders/spaceship" },
  },
};

/** The deployable fleet hull a faction fields for a class. */
export function fleetModelFor(faction: FactionId, role: DeployRole): ShipModel {
  return FLEET_BY_FACTION[faction][role];
}

/** Player / enemy fighter hulls (the entry hull before becoming a fleet unit). */
export const FIGHTER_GLB: { player: ShipModel; enemy: ShipModel } = {
  // fighter-player is authored nose-toward local -Z; force the half-turn so the
  // player ship doesn't fly tail-first. The enemy hull auto-orients fine.
  player: { id: "vehicles/space/fighters/fighter-player", yaw: Math.PI },
  enemy: { id: "vehicles/space/fighters/interceptor-red/interceptor-red" },
};

/**
 * Per-faction mothership station.  Each station is one or more OBJ parts that
 * share an authoring origin/scale, so they are assembled into a single group at
 * their *native* transforms and the whole assembly is fit ONCE (fitting parts
 * individually would break the assembly).  `fitMul` scales the assembled station
 * relative to the base mothership size.
 *
 * `fitObject` normalises each assembly's LONGEST axis to the base mothership fit
 * (≈8× the fighter), so hulls with extreme aspect ratios read with far less bulk
 * than near-cubic ones at the same fitMul: a long-thin spine or a flat disc lands
 * a much smaller median/short axis and looks under-sized next to the fleet. The
 * cubic hulls (scavengers pyramid, network cube) read appropriately massive at
 * ~1.0–1.1, while the elongated hollow spire, the long-thin prospector shipyard,
 * and the flat broodmother disc are bumped up so their perceived bulk
 * (geometric-mean of the three axes) lands in a tighter band with the rest.
 */
export interface StationModel {
  /** OBJ part asset ids, assembled at native transforms. */
  parts: string[];
  /** Size multiplier applied to the base mothership fit length. */
  fitMul: number;
}

export const FACTION_STATIONS: Record<FactionId, StationModel> = {
  // Near-cubic pyramid — full bulk at the base size; leave as-is.
  scavengers: {
    parts: ["environment/stations/techscavenger-pyramid/PyramidShips"],
    fitMul: 1.1,
  },
  // Elongated spire (median ≈ 0.53 of its length) read small; bumped for presence.
  hollow: {
    parts: [
      "environment/stations/hollowlords-station02/base/station02_base",
      "environment/stations/hollowlords-station02/ring/station02_ring",
    ],
    fitMul: 1.25,
  },
  // Near-cubic — the bulkiest silhouette at the base size; leave as-is.
  network: {
    parts: [
      "environment/stations/network-station03/base/station03_base",
      "environment/stations/network-station03/dock/station03_dock",
      "environment/stations/network-station03/ring/station03_ring",
    ],
    fitMul: 1.0,
  },
  // The Hive Queen — a full-bodied organic hull (axis ratios ≈ 1 : 0.54 : 0.35),
  // baked in as the Brood mothership. Healthy median/short axes give it real
  // bulk, so a slightly larger fitMul lands it imposingly without distortion.
  brood: {
    parts: ["environment/stations/broodmother-hive-queen/hive_queen"],
    fitMul: 1.2,
  },
  // Long-and-thin shipyard (median ≈ 0.46 of its length) read smallest of all;
  // bumped most so the capital spine reads massive across its breadth too.
  prospector: {
    parts: [
      "environment/stations/prospector-station05/base/station05",
      "environment/stations/prospector-station05/ring/station05_ring",
    ],
    fitMul: 1.3,
  },
};
