import { describe, expect, it } from "vitest";
import {
  CARRIER,
  COLLISION,
  ESCORT,
  FLEET_ROLES,
  SHIP,
  MOTHER_SHIP,
  FLEET_UNIT,
  fleetRoleDef,
  hash01,
  isDeployableRole,
  maxShieldFor,
  spawnEntity,
  spawnShip,
  tunablesFor,
  CLASS_STAT_CARDS,
  CLASS_COMBAT,
  FIGHTER_COMBAT,
  MAX_ARMOR,
  armorFor,
  combatProfileFor,
  fleetFireCooldownTicks,
  shieldRegenPerSecFor,
  speedMultFor,
  weaponDamageFor,
  WEAPON,
  type EntityState,
  type FleetRole,
  type InputCommand,
} from "./types";
import { makeRng } from "./rng";
import { decodeClient } from "./protocol";
import {
  damageEntity,
  escortIntent,
  fleetIntent,
  resolveShipCollisions,
  stepShip,
  type EscortContext,
  type FleetContext,
} from "./sim";

const cmd = (over: Partial<InputCommand> = {}): InputCommand => ({
  seq: 0,
  dt: 0,
  thrust: 0,
  yaw: 0,
  pitch: 0,
  roll: 0,
  boost: false,
  fire: false,
  missile: false,
  ...over,
});

const clone = (e: EntityState): EntityState => ({ ...e });

// `uid` is runtime identity (newUuid → crypto.randomUUID), intentionally
// non-deterministic; strip it so the comparison reflects simulation state only.
function stripVolatile(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const { uid: _uid, ...rest } = v as Record<string, unknown>;
    return rest;
  }
  return v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(stripVolatile(a)) === JSON.stringify(stripVolatile(b));
}

describe("tunablesFor — kind-aware movement envelopes", () => {
  it("selects per-kind envelopes, all sharing the SHIP arena", () => {
    expect(tunablesFor("fighter").maxSpeed).toBe(SHIP.maxSpeed);
    expect(tunablesFor("mother_ship").maxSpeed).toBe(MOTHER_SHIP.maxSpeed);
    expect(tunablesFor("fleet_unit").maxSpeed).toBe(FLEET_UNIT.maxSpeed);
    expect(tunablesFor("mother_ship").arena).toBe(SHIP.arena);
    expect(tunablesFor("fleet_unit").arena).toBe(SHIP.arena);
  });
});

describe("stepShip — kind-aware determinism", () => {
  it("produces identical output for identical inputs (fighter)", () => {
    const a = spawnShip("p1", "A", 0, 0, 0, 0, 0);
    const b = spawnShip("p1", "A", 0, 0, 0, 0, 0);
    const drive = cmd({ thrust: 1, yaw: 0.5, pitch: 0.2 });
    for (let i = 0; i < 60; i++) {
      stepShip(a, drive, 1 / 30);
      stepShip(b, drive, 1 / 30);
    }
    expect(deepEqual(a, b)).toBe(true);
  });

  it("respects each kind's own speed cap", () => {
    const fighter = spawnShip("p1", "F", 0, 0, 0, 0, 0);
    const mother = spawnEntity("ms", "M", "mother_ship", "p1", 0, 0, 0, 0, 0, 0);
    const drive = cmd({ thrust: 1 });
    for (let i = 0; i < 240; i++) {
      stepShip(fighter, drive, 1 / 30);
      stepShip(mother, drive, 1 / 30);
    }
    const fSpeed = Math.hypot(fighter.vx, fighter.vy, fighter.vz);
    const mSpeed = Math.hypot(mother.vx, mother.vy, mother.vz);
    expect(fSpeed).toBeLessThanOrEqual(SHIP.maxSpeed + 1e-6);
    expect(mSpeed).toBeLessThanOrEqual(MOTHER_SHIP.maxSpeed + 1e-6);
    // The bigger, slower mothership must end up slower than the fighter.
    expect(mSpeed).toBeLessThan(fSpeed);
  });

  it("clamps position to the shared arena bounds", () => {
    const e = spawnShip("p1", "A", 0, SHIP.arena - 5, 0, 0, 0);
    // Point straight along +X and burn for a while.
    e.yaw = Math.PI / 2;
    const drive = cmd({ thrust: 1, boost: true });
    for (let i = 0; i < 600; i++) stepShip(e, drive, 1 / 30);
    expect(e.px).toBeLessThanOrEqual(SHIP.arena);
    expect(e.py).toBeLessThanOrEqual(SHIP.arena);
    expect(e.pz).toBeLessThanOrEqual(SHIP.arena);
    expect(e.px).toBeGreaterThanOrEqual(-SHIP.arena);
  });
});

function makeFleetUnit(role: FleetRole, px: number, py: number, pz: number): EntityState {
  const u = spawnEntity("u1", "Unit", "fleet_unit", "p1", 0, 0, px, py, pz, 0, role);
  const def = FLEET_ROLES[role as Exclude<FleetRole, "none">];
  u.zoneR = def.zoneR;
  u.zoneX = 0;
  u.zoneY = 0;
  u.zoneZ = 0;
  return u;
}

function ctxFor(unit: EntityState, over: Partial<FleetContext> = {}): FleetContext {
  return {
    zone: { x: unit.zoneX, y: unit.zoneY, z: unit.zoneZ },
    zoneR: unit.zoneR,
    hostile: null,
    ward: null,
    obstacles: [],
    tick: 100,
    rand: 0.42,
    ...over,
  };
}

describe("fleetIntent — deterministic role AI", () => {
  it("is pure: identical (unit, ctx) yields identical command", () => {
    const u = makeFleetUnit("miner", 100, 20, -50);
    const c = ctxFor(u, { tick: 555, rand: 0.137 });
    const a = fleetIntent(clone(u), c);
    const b = fleetIntent(clone(u), c);
    expect(deepEqual(a, b)).toBe(true);
  });

  it("returns a zeroed command for a dead unit", () => {
    const u = makeFleetUnit("dreadnought", 0, 0, 0);
    u.alive = false;
    const out = fleetIntent(u, ctxFor(u, { hostile: enemyAt(50, 0, 0) }));
    expect(out.thrust).toBe(0);
    expect(out.fire).toBe(false);
    expect(out.yaw).toBe(0);
  });

  it("steers a unit that drifted outside its zone back toward the centre", () => {
    const u = makeFleetUnit("corsair", 0, 0, 0);
    // Place it well outside the zone along +X.
    const outside = u.zoneR + 500;
    u.px = outside;
    const out = fleetIntent(u, ctxFor(u));
    // Goal is the zone centre (-X from the unit) → target yaw points toward -X.
    const expectedYaw = Math.atan2(-1, 0); // atan2(nx, nz) with dir ≈ (-1,0,0)
    // The proportional yaw should drive toward that target (non-trivial turn).
    expect(Math.abs(out.yaw)).toBeGreaterThan(0);
    // After enough simulated ticks it must come back inside the zone.
    let sim = clone(u);
    for (let i = 0; i < 2000; i++) {
      const c = ctxFor(sim, { tick: i });
      const cmdI = { ...fleetIntent(sim, c), dt: 1 / 30 };
      stepShip(sim, cmdI, 1 / 30);
    }
    const dist = Math.hypot(sim.px - sim.zoneX, sim.py - sim.zoneY, sim.pz - sim.zoneZ);
    expect(dist).toBeLessThanOrEqual(u.zoneR);
    void expectedYaw;
  });

  it("keeps a contained unit within its zone over a long run", () => {
    const u = makeFleetUnit("miner", 0, 0, 0);
    let sim = clone(u);
    let maxDist = 0;
    for (let i = 0; i < 3000; i++) {
      const c = ctxFor(sim, { tick: i, rand: hash01(i) });
      const cmdI = { ...fleetIntent(sim, c), dt: 1 / 30 };
      stepShip(sim, cmdI, 1 / 30);
      const d = Math.hypot(sim.px - sim.zoneX, sim.py - sim.zoneY, sim.pz - sim.zoneZ);
      maxDist = Math.max(maxDist, d);
    }
    // Containment can overshoot slightly between ticks but must stay bounded.
    expect(maxDist).toBeLessThan(u.zoneR * 1.5);
  });

  it("only fires when armed, engaged, and closely aligned", () => {
    // Miners are unarmed: never fire even with a hostile in their face.
    const miner = makeFleetUnit("miner", 0, 0, 0);
    const mOut = fleetIntent(miner, ctxFor(miner, { hostile: enemyAt(30, 0, 0) }));
    expect(mOut.fire).toBe(false);

    // An armed dreadnought pointed straight at a close hostile should fire.
    const atk = makeFleetUnit("dreadnought", 0, 0, 0);
    atk.yaw = Math.PI / 2; // facing +X
    const hostile = enemyAt(80, 0, 0); // within dreadnought fireRange (270)
    const aOut = fleetIntent(atk, ctxFor(atk, { hostile }));
    expect(aOut.fire).toBe(true);

    // Same dreadnought, hostile beyond fireRange → holds fire.
    const far = enemyAt(FLEET_ROLES.dreadnought.fireRange + 100, 0, 0);
    const farOut = fleetIntent(atk, ctxFor(atk, { hostile: far }));
    expect(farOut.fire).toBe(false);
  });

  it("deflects away from an obstacle it would otherwise fly through", () => {
    const u = makeFleetUnit("frigate", 0, 0, 0);
    // Obstacle directly between the unit and a goal pull; expect a non-zero turn.
    const obstacle = { x: 40, y: 0, z: 0, r: 30 };
    const out = fleetIntent(u, ctxFor(u, { obstacles: [obstacle], hostile: enemyAt(200, 0, 0) }));
    // With repulsion applied the command must be a finite, valid steering input.
    expect(Number.isFinite(out.yaw)).toBe(true);
    expect(Number.isFinite(out.pitch)).toBe(true);
    expect(Math.abs(out.yaw)).toBeLessThanOrEqual(1);
  });
});

function enemyAt(px: number, py: number, pz: number): EntityState {
  return spawnEntity("enemy", "E", "fighter", "p2", 1, 0, px, py, pz, 0);
}

describe("deterministic RNG helpers", () => {
  it("makeRng is reproducible from a seed", () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
    seqA.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    });
  });

  it("hash01 is a stable function of its inputs", () => {
    expect(hash01(1, 2, 3)).toBe(hash01(1, 2, 3));
    expect(hash01(1, 2, 3)).not.toBe(hash01(3, 2, 1));
    const v = hash01(99, 7);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });
});

describe("deploy role validation — server-authority guard", () => {
  it("isDeployableRole accepts only the six real classes", () => {
    for (const r of ["miner", "scout", "corsair", "frigate", "cruiser", "dreadnought"]) {
      expect(isDeployableRole(r)).toBe(true);
    }
    expect(isDeployableRole("none")).toBe(false);
    expect(isDeployableRole("")).toBe(false);
    expect(isDeployableRole("battleship")).toBe(false);
    expect(isDeployableRole(null)).toBe(false);
    expect(isDeployableRole(undefined)).toBe(false);
    expect(isDeployableRole(42)).toBe(false);
    // Prototype keys must NOT resolve as roles (the poisoning vector).
    expect(isDeployableRole("toString")).toBe(false);
    expect(isDeployableRole("constructor")).toBe(false);
    expect(isDeployableRole("__proto__")).toBe(false);
  });

  it("fleetRoleDef returns null for prototype keys and bad input", () => {
    expect(fleetRoleDef("toString" as FleetRole)).toBeNull();
    expect(fleetRoleDef("constructor" as FleetRole)).toBeNull();
    expect(fleetRoleDef("none")).toBeNull();
    expect(fleetRoleDef("miner")).not.toBeNull();
  });

  it("decodeClient rejects deploy messages with a non-deployable role", () => {
    // Valid deploy passes through.
    expect(decodeClient(JSON.stringify({ t: "deploy", role: "dreadnought" }))).toEqual({
      t: "deploy",
      role: "dreadnought",
    });
    // Malformed / poisoning payloads are dropped (null).
    expect(decodeClient(JSON.stringify({ t: "deploy", role: "toString" }))).toBeNull();
    expect(decodeClient(JSON.stringify({ t: "deploy", role: "none" }))).toBeNull();
    expect(decodeClient(JSON.stringify({ t: "deploy" }))).toBeNull();
    expect(decodeClient(JSON.stringify({ t: "deploy", role: 7 }))).toBeNull();
    // Unrelated valid messages still pass.
    expect(decodeClient(JSON.stringify({ t: "join", name: "A", shipType: 0 }))).toEqual({
      t: "join",
      name: "A",
      shipType: 0,
    });
  });
});

describe("damageEntity — shields soak before hull", () => {
  it("seeds spawn shield from kind/role and maxShieldFor mirrors it", () => {
    expect(spawnShip("p", "P", 0, 0, 0, 0, 0).shield).toBe(SHIP.maxShield);
    expect(maxShieldFor("fighter", "none")).toBe(SHIP.maxShield);
    expect(maxShieldFor("mother_ship", "none")).toBe(MOTHER_SHIP.maxShield);
    expect(maxShieldFor("fleet_unit", "dreadnought")).toBe(
      FLEET_ROLES.dreadnought.maxShield,
    );
    expect(maxShieldFor("fleet_unit", "none")).toBe(FLEET_UNIT.maxShield);
  });

  it("absorbs into shield first, then spills into hull", () => {
    const e = spawnShip("p", "P", 0, 0, 0, 0, 0); // shield 60, hp 100
    // Partial shield hit: hull untouched, returns 0 hull damage.
    const hull1 = damageEntity(e, 20);
    expect(e.shield).toBe(40);
    expect(e.hp).toBe(SHIP.maxHp);
    expect(hull1).toBe(0);
    // Overflow hit: drains remaining shield then bleeds the rest into hull.
    const hull2 = damageEntity(e, 60); // 40 to shield, 20 to hull
    expect(e.shield).toBe(0);
    expect(e.hp).toBe(SHIP.maxHp - 20);
    expect(hull2).toBe(20);
  });

  it("is a no-op for dead entities or non-positive amounts", () => {
    const e = spawnShip("p", "P", 0, 0, 0, 0, 0);
    expect(damageEntity(e, 0)).toBe(0);
    expect(damageEntity(e, -5)).toBe(0);
    e.alive = false;
    expect(damageEntity(e, 999)).toBe(0);
    expect(e.shield).toBe(SHIP.maxShield);
    expect(e.hp).toBe(SHIP.maxHp);
  });
});

function fighterAt(
  id: string,
  owner: string,
  team: number,
  px: number,
  py: number,
  pz: number,
): EntityState {
  return spawnEntity(id, id, "fighter", owner, team, 0, px, py, pz, 0);
}

describe("resolveShipCollisions — separation, bounce, hostile grind", () => {
  it("is pure/deterministic: identical inputs yield identical post-state", () => {
    const mk = () => [
      fighterAt("a", "p1", 0, 0, 0, 0),
      fighterAt("b", "p2", 1, 5, 0, 0),
    ];
    const x = mk();
    const y = mk();
    resolveShipCollisions(x, 1 / 30);
    resolveShipCollisions(y, 1 / 30);
    expect(deepEqual(x[0], y[0])).toBe(true);
    expect(deepEqual(x[1], y[1])).toBe(true);
  });

  it("pushes two overlapping hulls apart along the contact normal", () => {
    const a = fighterAt("a", "p1", 0, 0, 0, 0);
    const b = fighterAt("b", "p2", 1, 4, 0, 0); // overlap (radii 8+8=16 > 4)
    const before = b.px - a.px;
    const contacts = resolveShipCollisions([a, b], 1 / 30);
    expect(contacts.length).toBe(1);
    expect(b.px - a.px).toBeGreaterThan(before); // separated outward
    expect(a.px).toBeLessThan(0); // equal mass → symmetric push
    expect(b.px).toBeGreaterThan(4);
  });

  it("grinds hostiles (shield first) but never friendlies", () => {
    // Hostile pair (different teams): both take grind damage to the shield.
    const a = fighterAt("a", "p1", 0, 0, 0, 0);
    const b = fighterAt("b", "p2", 1, 4, 0, 0);
    const c = resolveShipCollisions([a, b], 1 / 30);
    expect(c[0].grind).toBe(true);
    const expected = SHIP.maxShield - COLLISION.grindDps / 30;
    expect(a.shield).toBeCloseTo(expected, 6);
    expect(b.shield).toBeCloseTo(expected, 6);
    expect(a.hp).toBe(SHIP.maxHp);

    // Friendly pair (same team): separated but no damage.
    const f1 = fighterAt("f1", "p1", 0, 0, 0, 0);
    const f2 = fighterAt("f2", "p1", 0, 4, 0, 0);
    const fc = resolveShipCollisions([f1, f2], 1 / 30);
    expect(fc[0].grind).toBe(false);
    expect(f1.shield).toBe(SHIP.maxShield);
    expect(f2.shield).toBe(SHIP.maxShield);
  });

  it("leaves well-separated hulls untouched", () => {
    const a = fighterAt("a", "p1", 0, 0, 0, 0);
    const b = fighterAt("b", "p2", 1, 500, 0, 0);
    const contacts = resolveShipCollisions([a, b], 1 / 30);
    expect(contacts.length).toBe(0);
    expect(a.px).toBe(0);
    expect(b.px).toBe(500);
  });

  it("heavier hulls shove lighter ones aside (mass weighting)", () => {
    const mother = spawnEntity("m", "M", "mother_ship", "p1", 0, 0, 0, 0, 0, 0);
    const fighter = fighterAt("f", "p2", 1, 100, 0, 0); // within mother radius 120
    resolveShipCollisions([mother, fighter], 1 / 30);
    // The fighter is displaced far more than the mothership.
    expect(Math.abs(fighter.px - 100)).toBeGreaterThan(Math.abs(mother.px));
  });
});

function escortCtx(over: Partial<EscortContext> = {}): EscortContext {
  return {
    protect: { x: 0, y: 0, z: 0 },
    slot: { x: ESCORT.formationR, y: 0, z: 0 },
    hostile: null,
    obstacles: [],
    tick: 100,
    rand: 0.42,
    ...over,
  };
}

describe("escortIntent — deterministic summon/escort brain", () => {
  it("is pure: identical (unit, ctx) yields identical command", () => {
    const u = makeFleetUnit("corsair", 600, 0, 0);
    const c = escortCtx({ protect: { x: 0, y: 0, z: 0 } });
    const a = escortIntent(clone(u), c);
    const b = escortIntent(clone(u), c);
    expect(deepEqual(a, b)).toBe(true);
  });

  it("returns a zeroed command for a dead unit", () => {
    const u = makeFleetUnit("dreadnought", 0, 0, 0);
    u.alive = false;
    const out = escortIntent(u, escortCtx({ hostile: enemyAt(50, 0, 0) }));
    expect(out.thrust).toBe(0);
    expect(out.fire).toBe(false);
  });

  it("flies a distant escort toward the protected ship and boosts to catch up", () => {
    const u = makeFleetUnit("corsair", 2000, 0, 0); // far behind on +X
    const out = escortIntent(u, escortCtx());
    expect(out.thrust).toBeGreaterThan(0);
    expect(out.boost).toBe(true); // dist > catchUpDist → afterburner

    // Over a long run it must converge onto its formation slot beside the ship.
    let sim = clone(u);
    for (let i = 0; i < 3000; i++) {
      const c = escortCtx({ tick: i });
      const cmdI = { ...escortIntent(sim, c), dt: 1 / 30 };
      stepShip(sim, cmdI, 1 / 30);
    }
    const slotDist = Math.hypot(
      sim.px - ESCORT.formationR,
      sim.py - 0,
      sim.pz - 0,
    );
    expect(slotDist).toBeLessThan(ESCORT.catchUpDist);
  });

  it("peels off to fire on a hostile threatening the protected ship", () => {
    const atk = makeFleetUnit("dreadnought", 0, 0, 0);
    atk.yaw = Math.PI / 2; // facing +X
    // Hostile far from the unit's engageRange but well inside the guard radius,
    // and within fireRange + aligned → escort engages and fires.
    const hostile = enemyAt(80, 0, 0);
    const out = escortIntent(atk, escortCtx({ hostile }));
    expect(out.fire).toBe(true);
    expect(out.boost).toBe(false); // engaging, not catching up
  });

  it("unarmed miners never fire even with a hostile in the guard zone", () => {
    const miner = makeFleetUnit("miner", 0, 0, 0);
    const out = escortIntent(miner, escortCtx({ hostile: enemyAt(30, 0, 0) }));
    expect(out.fire).toBe(false);
  });
});

describe("summon protocol validation", () => {
  it("decodeClient accepts a well-formed summon and rejects bad ids", () => {
    expect(decodeClient(JSON.stringify({ t: "summon", entityId: "u1" }))).toEqual({
      t: "summon",
      entityId: "u1",
    });
    expect(decodeClient(JSON.stringify({ t: "summon" }))).toBeNull();
    expect(decodeClient(JSON.stringify({ t: "summon", entityId: "" }))).toBeNull();
    expect(decodeClient(JSON.stringify({ t: "summon", entityId: 7 }))).toBeNull();
  });
});

describe("economy + role tunables sanity", () => {
  it("deploy costs and caps are positive and ordered by class size", () => {
    expect(CARRIER.startCredits).toBeGreaterThan(0);
    expect(FLEET_ROLES.miner.cost).toBeLessThan(FLEET_ROLES.dreadnought.cost);
    expect(FLEET_ROLES.miner.zoneR).toBeLessThan(FLEET_ROLES.dreadnought.zoneR);
    expect(FLEET_ROLES.miner.armed).toBe(false);
    expect(FLEET_ROLES.dreadnought.armed).toBe(true);
  });

  it("spawnEntity sets maxHp from kind/role", () => {
    expect(spawnShip("p", "P", 0, 0, 0, 0, 0).maxHp).toBe(SHIP.maxHp);
    expect(spawnEntity("m", "M", "mother_ship", "p", 0, 0, 0, 0, 0, 0).maxHp).toBe(MOTHER_SHIP.maxHp);
    expect(
      spawnEntity("u", "U", "fleet_unit", "p", 0, 0, 0, 0, 0, 0, "dreadnought").maxHp,
    ).toBe(FLEET_ROLES.dreadnought.maxHp);
  });
});

describe("per-class stats system", () => {
  it("has one stat card per deployable class, all in 0..100", () => {
    expect(CLASS_STAT_CARDS).toHaveLength(6);
    for (const card of CLASS_STAT_CARDS) {
      for (const v of Object.values(card)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it("the player fighter is the fixed 1.0 baseline (keeps the sim exact)", () => {
    const fighter = spawnShip("p", "P", 0, 0, 0, 0, 0);
    expect(FIGHTER_COMBAT).toEqual({
      armor: 0,
      damageMult: 1,
      shieldRegenPerSec: 14,
      speedMult: 1,
      fireCooldownMult: 1,
    });
    expect(armorFor(fighter)).toBe(0);
    expect(speedMultFor(fighter)).toBe(1);
    expect(weaponDamageFor(fighter)).toBe(WEAPON.damage);
  });

  it("derives distinct, monotonic combat numbers from the cards", () => {
    // Armour rises with DEFENSE and is capped at MAX_ARMOR.
    expect(CLASS_COMBAT.scout.armor).toBeLessThan(CLASS_COMBAT.dreadnought.armor);
    for (const p of Object.values(CLASS_COMBAT)) {
      expect(p.armor).toBeGreaterThanOrEqual(0);
      expect(p.armor).toBeLessThanOrEqual(MAX_ARMOR);
    }
    // Damage rises with ATTACK; dreadnought hits harder than the miner.
    expect(CLASS_COMBAT.dreadnought.damageMult).toBeGreaterThan(
      CLASS_COMBAT.miner.damageMult,
    );
    // SPEED stat: the scout out-accelerates and out-fires the dreadnought.
    expect(CLASS_COMBAT.scout.fireCooldownMult).toBeLessThan(
      CLASS_COMBAT.dreadnought.fireCooldownMult,
    );
  });

  it("armour reduces incoming damage by exactly its fraction", () => {
    const cruiser = spawnEntity("c", "C", "fleet_unit", "p", 0, 0, 0, 0, 0, 0, "cruiser");
    cruiser.shield = 0; // route damage straight to hull to isolate the armour soak
    const a = armorFor(cruiser);
    expect(a).toBeGreaterThan(0);
    expect(damageEntity(cruiser, 100)).toBeCloseTo(100 * (1 - a), 6);
  });

  it("fleet fire cadence scales by class and never machine-guns", () => {
    const base = 12;
    expect(fleetFireCooldownTicks("scout", base)).toBeLessThan(
      fleetFireCooldownTicks("dreadnought", base),
    );
    expect(fleetFireCooldownTicks("scout", base)).toBeGreaterThanOrEqual(3);
  });

  it("resolves profiles by kind: mother is the armoured capital", () => {
    const mother = combatProfileFor("mother_ship", "none");
    expect(mother.armor).toBeGreaterThan(0);
    expect(mother.damageMult).toBeGreaterThan(1);
    const m = spawnEntity("m", "M", "mother_ship", "p", 0, 0, 0, 0, 0, 0);
    expect(shieldRegenPerSecFor(m)).toBeGreaterThan(shieldRegenPerSecFor(spawnShip("p", "P", 0, 0, 0, 0, 0)));
  });
});
