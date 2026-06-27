import { describe, it, expect } from "vitest";
import {
  collideWorld,
  generateWorld,
  inSafeZone,
  keepOutOfSafe,
  stepPlayer,
  stepZombie,
} from "./sim";
import {
  PLAYER,
  TICK_DT,
  WORLD,
  WORLD_SEED,
  spawnPlayer,
  spawnZombie,
  type PlayerInput,
} from "./types";

function input(p: Partial<PlayerInput> = {}): PlayerInput {
  return {
    seq: 0,
    dt: TICK_DT,
    moveX: 0,
    moveZ: 0,
    aimX: 0,
    aimZ: 1,
    fire: false,
    dash: false,
    weapon: 0,
    ...p,
  };
}

describe("generateWorld determinism", () => {
  it("produces an identical world for the same seed", () => {
    const a = generateWorld(WORLD_SEED);
    const b = generateWorld(WORLD_SEED);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("produces a different world for a different seed", () => {
    const a = generateWorld(WORLD_SEED);
    const b = generateWorld(WORLD_SEED + 1);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("keeps obstacles clear of every safe zone", () => {
    const w = generateWorld(WORLD_SEED);
    expect(w.safeZones.length).toBeGreaterThan(0);
    for (const o of w.obstacles) {
      for (const z of w.safeZones) {
        const d = Math.hypot(o.px - z.px, o.pz - z.pz);
        expect(d).toBeGreaterThan(z.radius);
      }
    }
  });
});

describe("stepPlayer determinism", () => {
  it("two players with identical inputs end at the same place", () => {
    const w = generateWorld(WORLD_SEED);
    const a = spawnPlayer("a", "A", 0, 0);
    const b = spawnPlayer("b", "B", 0, 0);
    for (let t = 0; t < 120; t++) {
      const cmd = input({ moveX: 1, moveZ: 0.3, aimX: 1, aimZ: 0 });
      stepPlayer(a, cmd, w, TICK_DT, t);
      stepPlayer(b, cmd, w, TICK_DT, t);
    }
    expect(a.px).toBe(b.px);
    expect(a.pz).toBe(b.pz);
  });

  it("clamps the player inside the arena", () => {
    const w = { obstacles: [], safeZones: [] };
    const p = spawnPlayer("a", "A", 0, 0);
    for (let t = 0; t < 2000; t++) {
      stepPlayer(p, input({ moveX: 1, moveZ: 1 }), w, TICK_DT, t);
    }
    expect(p.px).toBeLessThanOrEqual(WORLD.half);
    expect(p.pz).toBeLessThanOrEqual(WORLD.half);
  });

  it("dash moves the player further than a normal step", () => {
    const w = { obstacles: [], safeZones: [] };
    const walk = spawnPlayer("w", "W", 0, 0);
    const dash = spawnPlayer("d", "D", 0, 0);
    stepPlayer(walk, input({ moveX: 1, aimX: 1, aimZ: 0 }), w, TICK_DT, 0);
    stepPlayer(dash, input({ dash: true, aimX: 1, aimZ: 0 }), w, TICK_DT, 0);
    expect(dash.px).toBeGreaterThan(walk.px);
    expect(dash.dashReadyTick).toBeGreaterThan(0);
  });
});

describe("collision + safe zones", () => {
  it("pushes a circle out of an obstacle", () => {
    const w = {
      obstacles: [{ id: "o", px: 0, pz: 0, hw: 5, hd: 5, height: 5, seed: 1 }],
      safeZones: [],
    };
    const [x, z] = collideWorld(0, 0, PLAYER.radius, w);
    expect(Math.abs(x) > 5 || Math.abs(z) > 5).toBe(true);
  });

  it("keeps zombies out of safe zones", () => {
    const zones = [{ id: "s", px: 0, pz: 0, radius: 10 }];
    const w = { obstacles: [], safeZones: zones };
    const z = spawnZombie("z", 0, 0);
    stepZombie(z, { px: 0, pz: 0 }, w, TICK_DT);
    const [x, zz] = keepOutOfSafe(z.px, z.pz, 1, zones);
    expect(inSafeZone(x, zz, zones)).toBe(false);
  });
});
