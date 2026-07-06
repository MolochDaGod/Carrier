import { describe, expect, it } from "vitest";
import { STARTER_MECHS, STARTER_MECH_COUNT, clampMechType, mechFor, mechModelFor } from "./mechs";

describe("starter mechs", () => {
  it("exposes exactly three unlocked starter frames", () => {
    expect(STARTER_MECH_COUNT).toBe(3);
    expect(STARTER_MECHS).toHaveLength(3);
    expect(STARTER_MECHS.map((m) => m.id)).toEqual([0, 1, 2]);
  });

  it("pins default hull ids for the mech builder path", () => {
    expect(Object.fromEntries(STARTER_MECHS.map((m) => [m.name, m.hull]))).toEqual({
      Vanguard: "vehicles/space/fighters/fighter-player",
      Lancer: "vehicles/space/fighters/interceptor/interceptor",
      Titan: "vehicles/space/bombers/bomber/bomber",
    });
  });

  it("clamps wire shipType into 0..2", () => {
    expect(clampMechType(-1)).toBe(0);
    expect(clampMechType(0)).toBe(0);
    expect(clampMechType(2)).toBe(2);
    expect(clampMechType(5)).toBe(2);
  });

  it("mechModelFor forwards optional yaw on the vanguard frame", () => {
    expect(mechModelFor(0)).toEqual({
      id: "vehicles/space/fighters/fighter-player",
      yaw: Math.PI,
    });
    expect(mechFor(99).name).toBe("Titan");
  });
});