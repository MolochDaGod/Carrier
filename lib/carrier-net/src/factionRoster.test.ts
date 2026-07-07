import { describe, expect, it } from "vitest";
import {
  DEPLOYABLE_ROLES,
  FACTION_ORDER,
  FLEET_ROLES,
  type FactionId,
} from "./types";
import {
  FACTION_BUILD,
  FACTION_FLEET,
  FACTION_MINING,
  FACTION_MOTHERSHIP,
  fleetRoleDefFor,
  factionFleetShip,
  miningFor,
  mothershipEntryFor,
  platformDefFor,
} from "./factionRoster";

describe("factionRoster — complete ship tables", () => {
  for (const faction of FACTION_ORDER) {
    describe(faction, () => {
      for (const role of DEPLOYABLE_ROLES) {
        it(`${role} has unique codename, cost, and gameplay def`, () => {
          const ship = FACTION_FLEET[faction][role];
          const def = fleetRoleDefFor(faction, role);
          expect(ship.codename).toBeTruthy();
          expect(ship.special).toBeTruthy();
          expect(def).not.toBeNull();
          expect(def!.label).toBe(ship.codename);
          expect(def!.cost).toBeGreaterThan(0);
          expect(def!.cap).toBeGreaterThan(0);
          expect(def!.role).toBe(role);

          // Costs stay in a sane band vs global baseline.
          const base = FLEET_ROLES[role];
          expect(def!.cost).toBeGreaterThanOrEqual(Math.floor(base.cost * 0.75));
          expect(def!.cost).toBeLessThanOrEqual(Math.ceil(base.cost * 1.25));
        });
      }

      it("has six capital classes", () => {
        expect(FACTION_MOTHERSHIP[faction]).toHaveLength(6);
        for (let i = 0; i < 6; i++) {
          const cap = mothershipEntryFor(faction, i);
          expect(cap.codename).toBeTruthy();
          expect(cap.stats.speed).toBeGreaterThanOrEqual(0);
        }
      });

      it("build + mining profiles", () => {
        expect(FACTION_BUILD[faction].productionBonusPerSec).toBeGreaterThan(0);
        expect(miningFor(faction).creditPerSec).toBeGreaterThan(0);
      });
    });
  }

  it("brood corsair (Void Core) is present with raid tuning", () => {
    const ship = factionFleetShip("brood", "corsair");
    const def = fleetRoleDefFor("brood", "corsair");
    expect(ship?.codename).toBe("Void Core");
    expect(def?.armed).toBe(true);
    expect(def?.cost).toBe(76);
    expect(def?.maxHp).toBe(74);
    expect(ship?.special).toContain("Spine Raid");
  });

  it("no duplicate codenames within a faction fleet", () => {
    for (const faction of FACTION_ORDER) {
      const names = DEPLOYABLE_ROLES.map((r) => FACTION_FLEET[faction][r].codename);
      expect(new Set(names).size, `${faction} duplicate codenames`).toBe(names.length);
    }
  });

  it("miner < dreadnought cost ordering per faction", () => {
    for (const faction of FACTION_ORDER) {
      const miner = fleetRoleDefFor(faction, "miner")!.cost;
      const dread = fleetRoleDefFor(faction, "dreadnought")!.cost;
      expect(miner).toBeLessThan(dread);
    }
  });

  it("platform costs vary by faction", () => {
    const scav = platformDefFor("scavengers", "production").cost;
    const pros = platformDefFor("prospector", "production").cost;
    expect(scav).not.toBe(pros);
  });

  it("mining yield varies by faction", () => {
    const pros = FACTION_MINING.prospector.creditPerSec;
    const hollow = FACTION_MINING.hollow.creditPerSec;
    expect(pros).toBeGreaterThan(hollow);
  });
});