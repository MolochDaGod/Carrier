/**
 * End-to-end roster audit — every faction ship must have:
 * - resolvable GLB on disk + in catalog
 * - authored stats/cost/cap in factionRoster
 * - valid AI tunables (engage/fire ranges, armed flag)
 * - unique shipyard slot keys (no UI collisions)
 */
import { describe, it, expect } from "vitest";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  DEPLOYABLE_ROLES,
  FACTION_ORDER,
  fleetRoleDefFor,
  factionFleetShip,
  mothershipEntryFor,
  platformDefFor,
  miningFor,
  FACTION_BUILD,
  type FactionId,
} from "@workspace/carrier-net";
import { findAsset } from "@workspace/assets";
import { DEPLOY_ROLES, FLEET_BY_FACTION, FACTION_STATIONS, fleetModelFor } from "./factionAssets";
import { SKINNED_HULL_IDS } from "./hullFactory";
import { buildShipyardSlots } from "./shipyardCatalog";

const MODELS_DIR = path.resolve(import.meta.dirname, "../../../../lib/assets/models");
const MODEL_EXTS = ["glb", "gltf", "fbx", "obj"] as const;

function diskPathFor(id: string): string | undefined {
  for (const ext of MODEL_EXTS) {
    const p = path.join(MODELS_DIR, `${id}.${ext}`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

describe("ship roster audit — all factions", () => {
  for (const faction of FACTION_ORDER) {
    describe(FACTIONS_NAME(faction), () => {
      for (const role of DEPLOYABLE_ROLES) {
        it(`fleet ${role}: asset + gameplay + AI tunables`, () => {
          const model = fleetModelFor(faction, role as (typeof DEPLOY_ROLES)[number]);
          const disk = diskPathFor(model.id);
          expect(findAsset(model.id), `${model.id} missing from catalog`).toBeDefined();
          expect(disk, `${model.id} missing on disk`).toBeDefined();
          expect(statSync(disk!).size, `${model.id} empty file`).toBeGreaterThan(0);

          const authored = factionFleetShip(faction, role);
          const def = fleetRoleDefFor(faction, role);
          expect(authored, `no roster entry for ${faction}.${role}`).not.toBeNull();
          expect(def, `no role def for ${faction}.${role}`).not.toBeNull();
          expect(authored!.codename.length).toBeGreaterThan(0);
          expect(authored!.special.length).toBeGreaterThan(0);
          expect(def!.cost).toBeGreaterThan(0);
          expect(def!.cap).toBeGreaterThan(0);
          expect(def!.maxHp).toBeGreaterThan(0);
          expect(def!.zoneR).toBeGreaterThan(0);

          if (def!.armed) {
            expect(def!.engageRange).toBeGreaterThan(0);
            expect(def!.fireRange).toBeGreaterThan(0);
            expect(def!.fireRange).toBeLessThanOrEqual(def!.engageRange);
          } else {
            expect(def!.engageRange).toBe(0);
            expect(def!.fireRange).toBe(0);
          }

          for (const v of Object.values(authored!.stats)) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(100);
          }
        });
      }

      for (let shipType = 0; shipType < 6; shipType++) {
        it(`capital class ${shipType}: dossier + hull asset`, () => {
          const cap = mothershipEntryFor(faction, shipType);
          const role = DEPLOY_ROLES[shipType];
          const hull = fleetModelFor(faction, role).id;
          expect(cap.codename.length).toBeGreaterThan(0);
          expect(cap.perks.length).toBeGreaterThan(0);
          expect(diskPathFor(hull), `capital hull ${hull}`).toBeDefined();
        });
      }

      it("build + mining profiles exist", () => {
        expect(FACTION_BUILD[faction].blurb.length).toBeGreaterThan(0);
        expect(miningFor(faction).creditPerSec).toBeGreaterThan(0);
        expect(miningFor(faction).range).toBeGreaterThan(0);
        for (const kind of ["turret", "production", "utility"] as const) {
          expect(platformDefFor(faction, kind).cost).toBeGreaterThan(0);
        }
      });

      it("station parts resolve", () => {
        for (const part of FACTION_STATIONS[faction].parts) {
          expect(findAsset(part)).toBeDefined();
          expect(diskPathFor(part)).toBeDefined();
        }
      });
    });
  }

  it("brood corsair (Void Core) is explicitly wired", () => {
    expect(FLEET_BY_FACTION.brood.corsair.id).toBe("vehicles/space/brood/void-core");
    expect(factionFleetShip("brood", "corsair")!.codename).toBe("Void Core");
    expect(fleetRoleDefFor("brood", "corsair")!.cost).toBe(76);
    expect(SKINNED_HULL_IDS.has("vehicles/space/brood/void-core")).toBe(true);
  });

  it("shipyard slots have unique keys per faction", () => {
    for (const faction of FACTION_ORDER) {
      const slots = buildShipyardSlots(faction);
      const keys = slots.map((s) => s.key);
      expect(new Set(keys).size, `${faction} duplicate slot keys`).toBe(keys.length);

      const fleetSlots = slots.filter((s) => s.dossier.type === "fleet");
      expect(fleetSlots).toHaveLength(6);
      const corsair = fleetSlots.find((s) => s.dossier.type === "fleet" && s.dossier.role === "corsair");
      expect(corsair, `${faction} corsair fleet slot`).toBeDefined();
      if (faction === "brood") {
        expect(corsair!.label).toBe("Void Core");
        expect(corsair!.catalogIds[0]).toBe("vehicles/space/brood/void-core");
      }
    }
  });
});

function FACTIONS_NAME(id: FactionId): string {
  const names: Record<FactionId, string> = {
    scavengers: "Scavengers",
    hollow: "Hollow Lords",
    network: "Network",
    brood: "Brood Mother",
    prospector: "Prospector",
  };
  return names[id];
}