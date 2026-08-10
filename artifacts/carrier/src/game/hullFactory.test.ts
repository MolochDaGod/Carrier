import { describe, it, expect } from "vitest";
import { SKINNED_HULL_IDS } from "./hullFactory";
import { FLEET_BY_FACTION } from "./factionAssets";

describe("hullFactory skinned hull registry", () => {
  it("pins brood void-core and leviathan as rigged hulls", () => {
    expect(SKINNED_HULL_IDS.has("vehicles/space/brood/void-core")).toBe(true);
    expect(SKINNED_HULL_IDS.has("vehicles/space/brood/leviathan")).toBe(true);
    expect(FLEET_BY_FACTION.brood.corsair.id).toBe("vehicles/space/brood/void-core");
    expect(FLEET_BY_FACTION.brood.dreadnought.id).toBe("vehicles/space/brood/leviathan");
  });
});