/**
 * Single fixed-step ship integrator for Carrier, plus the deterministic fleet AI
 * intent producer.
 *
 * Carrier-owned copy so the physics can diverge from Skyforge Squadron when
 * the carrier scale system (1 wu = 1 m) requires different tuning.
 *
 * `stepShip` is run verbatim by BOTH the authoritative server and the predicting
 * client.  `fleetIntent` runs SERVER-ONLY (clients only interpolate fleet units)
 * but is kept pure + deterministic so the simulation is reproducible.
 */
import {
  CELESTIAL,
  COLLISION,
  ESCORT,
  SHIP,
  SHIP_COLLIDE_RADIUS,
  armorFor,
  fleetRoleDef,
  forwardVec,
  speedMultFor,
  tunablesFor,
  type CelestialBody,
  type EntityState,
  type FleetRole,
  type InputCommand,
  type Obstacle,
  type ShipState,
} from "./types";

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;
const clamp1 = (v: number) => clamp(v, -1, 1);

/**
 * Advance one entity by a single input command.  Kind-aware: the movement
 * envelope (turn rates, accel, speed caps, drag) is selected from the entity's
 * `kind`, so fighters, motherships, and fleet units share one deterministic
 * integrator but fly with their own performance.  Mutates and returns `s`.
 */
export function stepShip(s: ShipState, cmd: InputCommand, dt: number): ShipState {
  if (!s.alive) {
    s.boost = false;
    return s;
  }
  if (dt <= 0) return s;

  // Authoritative afterburner flag carried on the wire so remote/AI plumes flare
  // exactly when the ship is boosting (no over-cap-speed inference lag).
  s.boost = cmd.boost;

  const T = tunablesFor(s.kind);

  s.yaw += clamp1(cmd.yaw) * T.yawRate * dt;
  s.pitch += clamp1(cmd.pitch) * T.pitchRate * dt;
  s.pitch = clamp(s.pitch, -1.3, 1.3);
  s.roll += clamp1(cmd.roll) * T.rollRate * dt;
  s.roll += (0 - s.roll) * Math.min(1, 2 * dt) * (cmd.roll === 0 ? 1 : 0.15);
  if (s.yaw > Math.PI) s.yaw -= 2 * Math.PI;
  else if (s.yaw < -Math.PI) s.yaw += 2 * Math.PI;

  // SPEED stat scales the whole flight envelope (accel + caps).  Fighters,
  // motherships and roleless units are baseline (1.0), so this is identity for
  // them and only the deployable drone classes feel their authored speedMult.
  const sm = speedMultFor(s);
  const [fx, fy, fz] = forwardVec(s.yaw, s.pitch);
  const thrust = clamp1(cmd.thrust);
  const accel = T.thrustAccel * sm * (cmd.boost ? T.boostMult : 1);
  s.vx += fx * thrust * accel * dt;
  s.vy += fy * thrust * accel * dt;
  s.vz += fz * thrust * accel * dt;

  const keep = Math.pow(T.drag, dt);
  s.vx *= keep;
  s.vy *= keep;
  s.vz *= keep;

  const cap = (cmd.boost ? T.boostMaxSpeed : T.maxSpeed) * sm;
  const sp = Math.hypot(s.vx, s.vy, s.vz);
  if (sp > cap) {
    const k = cap / sp;
    s.vx *= k;
    s.vy *= k;
    s.vz *= k;
  }

  s.px += s.vx * dt;
  s.py += s.vy * dt;
  s.pz += s.vz * dt;

  const a = T.arena;
  if (s.px > a) { s.px = a; if (s.vx > 0) s.vx = 0; }
  else if (s.px < -a) { s.px = -a; if (s.vx < 0) s.vx = 0; }
  if (s.py > a) { s.py = a; if (s.vy > 0) s.vy = 0; }
  else if (s.py < -a) { s.py = -a; if (s.vy < 0) s.vy = 0; }
  if (s.pz > a) { s.pz = a; if (s.vz > 0) s.vz = 0; }
  else if (s.pz < -a) { s.pz = -a; if (s.vz < 0) s.vz = 0; }

  return s;
}

// ---------------------------------------------------------------------------
// Celestial physics — all pure + deterministic (no globals, no randomness, no
// wall-clock).  The authoritative server runs these every tick; the client may
// run the SAME functions during prediction so gravity wells feel responsive.
// ---------------------------------------------------------------------------

/**
 * Integrate one moving celestial body (comet/asteroid) and bounce it off the
 * walls of its cubic confinement region.  Planets (zero region/velocity by
 * convention) are static anchors and are left untouched.
 */
export function stepCelestial(b: CelestialBody, dt: number): void {
  if (b.kind === "planet") return;
  if (dt <= 0) return;

  b.px += b.vx * dt;
  b.py += b.vy * dt;
  b.pz += b.vz * dt;

  const h = Math.max(0, b.rhalf - b.radius);
  bounceAxis(b, "px", "vx", b.rcx, h);
  bounceAxis(b, "py", "vy", b.rcy, h);
  bounceAxis(b, "pz", "vz", b.rcz, h);
}

function bounceAxis(
  b: CelestialBody,
  p: "px" | "py" | "pz",
  v: "vx" | "vy" | "vz",
  center: number,
  half: number,
): void {
  const lo = center - half;
  const hi = center + half;
  if (b[p] > hi) { b[p] = hi; if (b[v] > 0) b[v] = -b[v]; }
  else if (b[p] < lo) { b[p] = lo; if (b[v] < 0) b[v] = -b[v]; }
}

/**
 * Resolve pairwise collisions between moving celestial bodies (comets/
 * asteroids).  Simple symmetric position separation + velocity swap along the
 * contact normal.  Deterministic given a stable iteration order, so callers
 * MUST pass the bodies in the same order every tick.  Returns the list of
 * contact midpoints so the server can emit impact FX.
 */
export function resolveCelestialCollisions(
  bodies: CelestialBody[],
): { px: number; py: number; pz: number }[] {
  const hits: { px: number; py: number; pz: number }[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    if (a.kind === "planet") continue;
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      if (b.kind === "planet") continue;
      const dx = b.px - a.px, dy = b.py - a.py, dz = b.pz - a.pz;
      const minD = a.radius + b.radius;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= minD * minD || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d, ny = dy / d, nz = dz / d;
      const overlap = (minD - d) * 0.5;
      a.px -= nx * overlap; a.py -= ny * overlap; a.pz -= nz * overlap;
      b.px += nx * overlap; b.py += ny * overlap; b.pz += nz * overlap;
      // Swap the normal component of velocity (equal-mass elastic).
      const av = a.vx * nx + a.vy * ny + a.vz * nz;
      const bv = b.vx * nx + b.vy * ny + b.vz * nz;
      const dvn = bv - av;
      a.vx += nx * dvn; a.vy += ny * dvn; a.vz += nz * dvn;
      b.vx -= nx * dvn; b.vy -= ny * dvn; b.vz -= nz * dvn;
      hits.push({
        px: a.px + nx * a.radius,
        py: a.py + ny * a.radius,
        pz: a.pz + nz * a.radius,
      });
    }
  }
  return hits;
}

/**
 * Apply every body's gravity/push force to a ship's velocity for this step.
 * Gravity pulls toward the body (inverse-square, clamped near the surface);
 * push shoves outward with a linear falloff.  Pure: only `s` velocity mutates.
 */
export function applyCelestialForces(
  s: ShipState,
  bodies: CelestialBody[],
  dt: number,
): void {
  if (!s.alive || dt <= 0) return;
  for (const b of bodies) {
    const dx = b.px - s.px, dy = b.py - s.py, dz = b.pz - s.pz;
    const d2 = dx * dx + dy * dy + dz * dz;
    const reach = b.forceRadius;
    if (d2 >= reach * reach || d2 < 1e-6) continue;
    const d = Math.sqrt(d2);
    const nx = dx / d, ny = dy / d, nz = dz / d;
    if (b.force === "gravity") {
      const safe = Math.max(d, b.radius);
      const accel = (CELESTIAL.gravityG * b.mass) / (safe * safe);
      s.vx += nx * accel * dt;
      s.vy += ny * accel * dt;
      s.vz += nz * accel * dt;
    } else {
      // Linear falloff: strongest at the surface, zero at the reach edge.
      const t = 1 - (d - b.radius) / Math.max(1, reach - b.radius);
      const accel = CELESTIAL.pushAccel * clamp(t, 0, 1);
      s.vx -= nx * accel * dt;
      s.vy -= ny * accel * dt;
      s.vz -= nz * accel * dt;
    }
  }
}

/**
 * Push a ship out of any solid celestial body it has penetrated and cancel its
 * inward velocity, so bodies read as hard obstacles.  Returns a contact point
 * when a collision was resolved (for impact FX), else null.  Pure aside from
 * mutating `s`.
 */
export function resolveCelestialPenetration(
  s: ShipState,
  bodies: CelestialBody[],
): { px: number; py: number; pz: number } | null {
  if (!s.alive) return null;
  let contact: { px: number; py: number; pz: number } | null = null;
  for (const b of bodies) {
    const dx = s.px - b.px, dy = s.py - b.py, dz = s.pz - b.pz;
    const minD = b.radius + SHIP_COLLIDE_RADIUS;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= minD * minD) continue;
    const d = d2 > 1e-6 ? Math.sqrt(d2) : 1e-3;
    const nx = dx / d, ny = dy / d, nz = dz / d;
    s.px = b.px + nx * minD;
    s.py = b.py + ny * minD;
    s.pz = b.pz + nz * minD;
    const inward = s.vx * nx + s.vy * ny + s.vz * nz;
    if (inward < 0) {
      s.vx -= nx * inward;
      s.vy -= ny * inward;
      s.vz -= nz * inward;
    }
    contact = {
      px: b.px + nx * b.radius,
      py: b.py + ny * b.radius,
      pz: b.pz + nz * b.radius,
    };
  }
  return contact;
}

// ─── Shields & ship-on-ship collisions ───────────────────────────────────────

/**
 * Apply `amount` damage to an entity, soaked by its regenerating shield FIRST
 * and only then by the hull.  Returns the hull damage actually dealt (0 if the
 * shield absorbed it all) so callers can decide death/kill bookkeeping.  Pure:
 * mutates only `e.shield`/`e.hp`.  Both the server and any predicting code run
 * this identically, so shields never desync.
 */
export function damageEntity(e: EntityState, amount: number): number {
  if (amount <= 0 || !e.alive) return 0;
  // DEFENSE stat soaks a fraction of every incoming hit before shield/hull.
  // Fighters (baseline) have 0 armour, so this is identity for the player ship.
  let rem = amount * (1 - armorFor(e));
  if (rem <= 0) return 0;
  if (e.maxShield > 0 && e.shield > 0) {
    const absorbed = e.shield < rem ? e.shield : rem;
    e.shield -= absorbed;
    rem -= absorbed;
  }
  if (rem > 0) e.hp -= rem;
  return rem;
}

/** Physical collision radius (m) for an entity kind/role. */
export function collideRadius(e: EntityState): number {
  if (e.kind === "mother_ship") return 120;
  if (e.kind === "fleet_unit") {
    const def = fleetRoleDef(e.role);
    return def ? Math.max(SHIP_COLLIDE_RADIUS, def.scale * 0.6) : SHIP_COLLIDE_RADIUS;
  }
  return SHIP_COLLIDE_RADIUS;
}

/** Relative collision mass (heavier hulls shove lighter ones aside). */
export function collisionMass(e: EntityState): number {
  if (e.kind === "mother_ship") return 400;
  if (e.kind === "fleet_unit") {
    const def = fleetRoleDef(e.role);
    return def ? 1 + def.scale * 0.15 : 2;
  }
  return 1; // fighter
}

/** A point in the world where two hulls ground against each other this tick. */
export interface ShipContact {
  px: number;
  py: number;
  pz: number;
  /** True when this contact dealt grind damage (hostile hulls). */
  grind: boolean;
}

/**
 * Resolve ship-on-ship collisions for one fixed step.  Overlapping hulls are
 * mass-weighted-separated (`COLLISION.separation`), bounce along the contact
 * normal (`COLLISION.restitution`), and — only between HOSTILE hulls (different
 * teams) — grind each other for `COLLISION.grindDps * dt` via `damageEntity`
 * (shield first), so friendly fleets can cluster without self-destructing.
 *
 * Pure + deterministic given a STABLE `ships` order (the room iterates its
 * entity Map in insertion order): mutates positions/velocities/shield/hp and
 * returns the contact points for VFX.  Death bookkeeping stays with the caller.
 */
export function resolveShipCollisions(
  ships: EntityState[],
  dt: number,
): ShipContact[] {
  const contacts: ShipContact[] = [];
  for (let i = 0; i < ships.length; i++) {
    const a = ships[i];
    if (!a.alive) continue;
    const ra = collideRadius(a);
    const ma = collisionMass(a);
    for (let j = i + 1; j < ships.length; j++) {
      const b = ships[j];
      if (!b.alive) continue;
      const rb = collideRadius(b);
      const dx = b.px - a.px;
      const dy = b.py - a.py;
      const dz = b.pz - a.pz;
      const minD = ra + rb;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= minD * minD) continue;

      let d = Math.sqrt(d2);
      let nx: number;
      let ny: number;
      let nz: number;
      if (d < 1e-4) {
        // Exact overlap: pick a deterministic separation axis.
        nx = 1;
        ny = 0;
        nz = 0;
        d = 1e-4;
      } else {
        nx = dx / d;
        ny = dy / d;
        nz = dz / d;
      }

      const mb = collisionMass(b);
      const wa = mb / (ma + mb);
      const wb = ma / (ma + mb);

      // Positional softness: push the pair apart by the mass-weighted overlap.
      const overlap = (minD - d) * COLLISION.separation;
      a.px -= nx * overlap * wa;
      a.py -= ny * overlap * wa;
      a.pz -= nz * overlap * wa;
      b.px += nx * overlap * wb;
      b.py += ny * overlap * wb;
      b.pz += nz * overlap * wb;

      // Velocity bounce along the normal, only while the hulls are approaching.
      const rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny + (b.vz - a.vz) * nz;
      if (rvn < 0) {
        const jImp = -(1 + COLLISION.restitution) * rvn;
        const ia = jImp * wa;
        const ib = jImp * wb;
        a.vx -= nx * ia;
        a.vy -= ny * ia;
        a.vz -= nz * ia;
        b.vx += nx * ib;
        b.vy += ny * ib;
        b.vz += nz * ib;
      }

      // Hostile hulls grind each other down (shield first).
      const grind = a.team !== b.team;
      if (grind) {
        const dmg = COLLISION.grindDps * dt;
        damageEntity(a, dmg);
        damageEntity(b, dmg);
      }

      contacts.push({
        px: (a.px + b.px) * 0.5,
        py: (a.py + b.py) * 0.5,
        pz: (a.pz + b.pz) * 0.5,
        grind,
      });
    }
  }
  return contacts;
}

// ─── Fleet AI ────────────────────────────────────────────────────────────────

/** A 3D point. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Everything `fleetIntent` needs to decide one unit's move this tick.  The room
 * builds this each tick; the function itself stays pure (no globals, no clock,
 * no `Math.random`) so the fleet is fully deterministic and reproducible.
 */
export interface FleetContext {
  /** Live centre of this unit's rated operation zone. */
  zone: Vec3;
  /** Radius (m) of the rated operation zone. */
  zoneR: number;
  /** Nearest hostile to react to (different owner + team), if any. */
  hostile: EntityState | null;
  /** Friendly unit this frigate (support) unit should shadow (most-hurt ally), if any. */
  ward: EntityState | null;
  /** Spherical obstacles to steer around (celestial bodies, later). */
  obstacles: Obstacle[];
  /** Monotonic server tick (used for deterministic wander phase). */
  tick: number;
  /** A deterministic [0,1) sample unique to this unit + tick. */
  rand: number;
}

const ZERO_CMD: InputCommand = {
  seq: 0,
  dt: 0,
  thrust: 0,
  yaw: 0,
  pitch: 0,
  roll: 0,
  boost: false,
  fire: false,
  missile: false,
};

function len(x: number, y: number, z: number): number {
  return Math.hypot(x, y, z);
}

/** Pick the role goal point this unit should move toward this tick. */
function goalFor(
  unit: EntityState,
  ctx: FleetContext,
): { gx: number; gy: number; gz: number; engage: boolean } {
  const role: FleetRole = unit.role;
  const z = ctx.zone;

  // Combat roles chase a hostile when one is in range.
  const def = fleetRoleDef(role);
  if (def && def.armed && ctx.hostile) {
    const h = ctx.hostile;
    const d = len(h.px - unit.px, h.py - unit.py, h.pz - unit.pz);
    if (d <= def.engageRange) {
      return { gx: h.px, gy: h.py, gz: h.pz, engage: true };
    }
  }

  if (role === "frigate" && ctx.ward) {
    // Hold a protective station just off the warded ally.
    return {
      gx: ctx.ward.px,
      gy: ctx.ward.py + 18,
      gz: ctx.ward.pz,
      engage: false,
    };
  }

  // Default: orbit / prospect inside the zone via a slow deterministic circuit.
  const phase = ctx.tick * 0.0006 + ctx.rand * Math.PI * 2;
  const r = ctx.zoneR * (role === "miner" ? 0.75 : 0.55);
  return {
    gx: z.x + Math.cos(phase) * r,
    gy: z.y + Math.sin(phase * 0.5) * r * 0.3,
    gz: z.z + Math.sin(phase) * r,
    engage: false,
  };
}

/**
 * Produce a steering input toward a goal, kept inside the unit's rated zone and
 * deflected around obstacles.  This is the "3D pathfinding": continuous seek +
 * containment + sphere avoidance, which composes with obstacles fed by the
 * world-content task.  Pure + deterministic.
 */
export function fleetIntent(unit: EntityState, ctx: FleetContext): InputCommand {
  if (!unit.alive) return { ...ZERO_CMD };

  const goal = goalFor(unit, ctx);
  let dx = goal.gx - unit.px;
  let dy = goal.gy - unit.py;
  let dz = goal.gz - unit.pz;

  // Zone containment: if we've drifted outside the rated zone, override the goal
  // with a pull straight back toward the zone centre.
  const offx = unit.px - ctx.zone.x;
  const offy = unit.py - ctx.zone.y;
  const offz = unit.pz - ctx.zone.z;
  const offDist = len(offx, offy, offz);
  if (offDist > ctx.zoneR) {
    dx = ctx.zone.x - unit.px;
    dy = ctx.zone.y - unit.py;
    dz = ctx.zone.z - unit.pz;
  }

  const steer = steerToward(unit, dx, dy, dz, ctx.obstacles);
  if (!steer) return { ...ZERO_CMD };

  // Fire when armed, engaging a hostile, and pointed close enough at it.
  const def = fleetRoleDef(unit.role);
  let fire = false;
  let boost = false;
  if (def && def.armed && goal.engage && ctx.hostile) {
    const h = ctx.hostile;
    const d = len(h.px - unit.px, h.py - unit.py, h.pz - unit.pz);
    const aimTol = unit.role === "scout" || unit.role === "corsair" ? 0.38 : 0.28;
    fire =
      d <= def.fireRange &&
      Math.abs(steer.yawDiff) < aimTol &&
      Math.abs(steer.pitchDiff) < aimTol;
    // Drone fighters close fast and weave — light afterburner while engaging.
    if (goal.engage && (unit.role === "scout" || unit.role === "corsair") && d > 90) {
      boost = true;
      steer.thrust = Math.min(1, steer.thrust + 0.25);
    }
  }

  return {
    seq: 0,
    dt: 0,
    thrust: steer.thrust,
    yaw: steer.yaw,
    pitch: steer.pitch,
    roll: 0,
    boost,
    fire,
    missile: false,
  };
}

/** Result of the shared seek/avoid steering primitive. */
interface Steer {
  yaw: number;
  pitch: number;
  thrust: number;
  yawDiff: number;
  pitchDiff: number;
  dist: number;
}

/**
 * Continuous seek toward a goal vector `(dx,dy,dz)` with sphere avoidance —
 * the shared "3D pathfinding" primitive used by both `fleetIntent` and
 * `escortIntent`.  Returns `null` when the goal is effectively reached.  Pure +
 * deterministic.  (Extracted verbatim from `fleetIntent` so the existing fleet
 * behaviour — and its determinism tests — stay numerically identical.)
 */
function steerToward(
  unit: EntityState,
  dx: number,
  dy: number,
  dz: number,
  obstacles: Obstacle[],
): Steer | null {
  // Obstacle avoidance: add a repulsion from any sphere we are close to.
  for (const o of obstacles) {
    const ox = unit.px - o.x;
    const oy = unit.py - o.y;
    const oz = unit.pz - o.z;
    const od = len(ox, oy, oz);
    const margin = o.r + 80;
    if (od < margin && od > 1e-3) {
      const push = (margin - od) / margin;
      dx += (ox / od) * push * margin;
      dy += (oy / od) * push * margin;
      dz += (oz / od) * push * margin;
    }
  }

  const dist = len(dx, dy, dz);
  if (dist < 1e-3) return null;
  const nx = dx / dist;
  const ny = dy / dist;
  const nz = dz / dist;

  // Desired yaw/pitch from the goal direction (shared forwardVec convention:
  // forward = (sin yaw cos pitch, sin pitch, cos yaw cos pitch)).
  const targetYaw = Math.atan2(nx, nz);
  const targetPitch = Math.asin(clamp(ny, -1, 1));

  let yawDiff = targetYaw - unit.yaw;
  while (yawDiff > Math.PI) yawDiff -= 2 * Math.PI;
  while (yawDiff < -Math.PI) yawDiff += 2 * Math.PI;
  const pitchDiff = targetPitch - unit.pitch;

  // Proportional turn input, normalised to [-1,1].
  const yaw = clamp1(yawDiff * 2.2);
  const pitch = clamp1(pitchDiff * 2.2);

  // Thrust hard when roughly aligned; ease off when we need to turn sharply or
  // we're already on top of the goal.
  const aligned = Math.abs(yawDiff) < 0.9 && Math.abs(pitchDiff) < 0.9;
  const near = dist < 30;
  const thrust = aligned ? (near ? 0.25 : 1) : 0.35;

  return { yaw, pitch, thrust, yawDiff, pitchDiff, dist };
}

/**
 * Everything `escortIntent` needs to fly one summoned unit to the player's
 * controlled ship and protect it.  Built by the room each tick; the brain stays
 * pure + deterministic (no globals, no clock, no `Math.random`).
 */
export interface EscortContext {
  /** Live position of the ship the player is currently controlling. */
  protect: Vec3;
  /** World-space formation offset to hold relative to the protected ship. */
  slot: Vec3;
  /** Nearest hostile threatening this unit or the protected ship, if any. */
  hostile: EntityState | null;
  /** Spherical obstacles to steer around (celestial bodies, etc.). */
  obstacles: Obstacle[];
  /** Monotonic server tick. */
  tick: number;
  /** A deterministic [0,1) sample unique to this unit + tick. */
  rand: number;
}

/**
 * Escort brain (SERVER-ONLY, like `fleetIntent`): fly a summoned unit to its
 * formation slot beside the player's controlled ship, peel off to attack a
 * hostile that threatens itself or the protected ship (armed roles only), then
 * return to formation.  Lights the afterburner to catch up when far behind a
 * moving player.  Pure + deterministic.
 */
export function escortIntent(unit: EntityState, ctx: EscortContext): InputCommand {
  if (!unit.alive) return { ...ZERO_CMD };

  const def = fleetRoleDef(unit.role);

  // Default goal: the formation slot beside the protected ship.
  let gx = ctx.protect.x + ctx.slot.x;
  let gy = ctx.protect.y + ctx.slot.y;
  let gz = ctx.protect.z + ctx.slot.z;
  let engage = false;

  // Armed escorts peel off to attack a threat near themselves or the player.
  if (def && def.armed && ctx.hostile) {
    const h = ctx.hostile;
    const dToUnit = len(h.px - unit.px, h.py - unit.py, h.pz - unit.pz);
    const dToProtect = len(
      h.px - ctx.protect.x,
      h.py - ctx.protect.y,
      h.pz - ctx.protect.z,
    );
    if (dToUnit <= def.engageRange || dToProtect <= ESCORT.guardRadius) {
      gx = h.px;
      gy = h.py;
      gz = h.pz;
      engage = true;
    }
  }

  const steer = steerToward(
    unit,
    gx - unit.px,
    gy - unit.py,
    gz - unit.pz,
    ctx.obstacles,
  );
  if (!steer) return { ...ZERO_CMD };

  let fire = false;
  if (def && def.armed && engage && ctx.hostile) {
    const h = ctx.hostile;
    const d = len(h.px - unit.px, h.py - unit.py, h.pz - unit.pz);
    const aimTol = unit.role === "scout" || unit.role === "corsair" ? 0.38 : 0.28;
    fire =
      d <= def.fireRange &&
      Math.abs(steer.yawDiff) < aimTol &&
      Math.abs(steer.pitchDiff) < aimTol;
  }

  // Catch up to a distant, moving player while not engaging; drone escorts boost in combat.
  let boost = !engage && steer.dist > ESCORT.catchUpDist;
  if (engage && def?.armed && (unit.role === "scout" || unit.role === "corsair")) boost = true;

  return {
    seq: 0,
    dt: 0,
    thrust: steer.thrust,
    yaw: steer.yaw,
    pitch: steer.pitch,
    roll: 0,
    boost,
    fire,
    missile: false,
  };
}
