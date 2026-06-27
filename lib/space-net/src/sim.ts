/**
 * The single fixed-step ship integrator, shared verbatim by the authoritative
 * server and the predicting client. Determinism is the whole point: given the
 * same starting `ShipState` and the same `InputCommand`, both sides must produce
 * identical output, or client-side prediction will fight the server.
 *
 * Keep this pure: mutate the passed state in place and return it, no globals, no
 * randomness, no time-of-day. All tunables come from `SHIP` in types.ts.
 */
import {
  CARRIER,
  SHIP,
  type InputCommand,
  type ShipState,
  forwardVec,
} from "./types";

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;
const clamp1 = (v: number) => clamp(v, -1, 1);

/** Advance one ship by a single input command. Mutates and returns `s`. */
export function stepShip(s: ShipState, cmd: InputCommand, dt: number): ShipState {
  if (!s.alive) return s;
  if (dt <= 0) return s;

  // Orientation: integrate angular rates from normalised inputs.
  s.yaw += clamp1(cmd.yaw) * SHIP.yawRate * dt;
  s.pitch += clamp1(cmd.pitch) * SHIP.pitchRate * dt;
  // Keep pitch out of gimbal extremes so forward never collapses.
  s.pitch = clamp(s.pitch, -1.3, 1.3);
  // Roll is visual flavour; bleed it back toward level when not banking.
  s.roll += clamp1(cmd.roll) * SHIP.rollRate * dt;
  s.roll += (0 - s.roll) * Math.min(1, 2 * dt) * (cmd.roll === 0 ? 1 : 0.15);
  // Normalise yaw to keep the number bounded over long sessions.
  if (s.yaw > Math.PI) s.yaw -= 2 * Math.PI;
  else if (s.yaw < -Math.PI) s.yaw += 2 * Math.PI;

  // Thrust along the current facing.
  const [fx, fy, fz] = forwardVec(s.yaw, s.pitch);
  const thrust = clamp1(cmd.thrust);
  const accel = SHIP.thrustAccel * (cmd.boost ? SHIP.boostMult : 1);
  s.vx += fx * thrust * accel * dt;
  s.vy += fy * thrust * accel * dt;
  s.vz += fz * thrust * accel * dt;

  // Exponential drag toward zero.
  const keep = Math.pow(SHIP.drag, dt);
  s.vx *= keep;
  s.vy *= keep;
  s.vz *= keep;

  // Speed cap (boost raises the ceiling).
  const cap = cmd.boost ? SHIP.boostMaxSpeed : SHIP.maxSpeed;
  const sp = Math.hypot(s.vx, s.vy, s.vz);
  if (sp > cap) {
    const k = cap / sp;
    s.vx *= k;
    s.vy *= k;
    s.vz *= k;
  }

  // Integrate position.
  s.px += s.vx * dt;
  s.py += s.vy * dt;
  s.pz += s.vz * dt;

  // Clamp to the cubic arena, killing the velocity component into the wall so a
  // ship slides along it instead of sticking through.
  const a = SHIP.arena;
  if (s.px > a) {
    s.px = a;
    if (s.vx > 0) s.vx = 0;
  } else if (s.px < -a) {
    s.px = -a;
    if (s.vx < 0) s.vx = 0;
  }
  if (s.py > a) {
    s.py = a;
    if (s.vy > 0) s.vy = 0;
  } else if (s.py < -a) {
    s.py = -a;
    if (s.vy < 0) s.vy = 0;
  }
  if (s.pz > a) {
    s.pz = a;
    if (s.vz > 0) s.vz = 0;
  } else if (s.pz < -a) {
    s.pz = -a;
    if (s.vz < 0) s.vz = 0;
  }

  return s;
}

/**
 * Advance a mothership one tick while following a set course.
 *
 * Called server-side each tick for mother_ship entities that have `hasCourse`.
 * The mothership turns to face its destination, thrusts when roughly aligned,
 * and coasts to a stop when it arrives. Mutates `s` in place and returns it.
 *
 * Pure: no randomness, no globals, dt is passed in. Determinism is required —
 * both server and client run this verbatim.
 */
export function stepMotherShipCourse(s: ShipState, dt: number): ShipState {
  if (!s.alive || !s.hasCourse) return s;

  const dx = s.courseTx - s.px;
  const dz = s.courseTz - s.pz;
  const dist = Math.hypot(dx, dz);

  // Arrived — clear course and coast to a stop.
  if (dist < CARRIER.arrivalRadius) {
    s.hasCourse = false;
    const keepStop = Math.pow(CARRIER.drag * 0.7, dt);
    s.vx *= keepStop;
    s.vy *= keepStop;
    s.vz *= keepStop;
    s.px += s.vx * dt;
    s.py += s.vy * dt;
    s.pz += s.vz * dt;
    return s;
  }

  // Compute target yaw (horizontal plane only — carrier stays level).
  const targetYaw = Math.atan2(dx, dz);
  let yawDiff = targetYaw - s.yaw;
  while (yawDiff > Math.PI) yawDiff -= 2 * Math.PI;
  while (yawDiff < -Math.PI) yawDiff += 2 * Math.PI;

  // Smoothly turn toward destination.
  const maxTurn = CARRIER.courseTurnRate * dt;
  const turn = Math.max(-maxTurn, Math.min(maxTurn, yawDiff));
  s.yaw += turn;
  if (s.yaw > Math.PI) s.yaw -= 2 * Math.PI;
  else if (s.yaw < -Math.PI) s.yaw += 2 * Math.PI;

  // Thrust only when roughly aligned (within 60°).
  const aligned = Math.abs(yawDiff) < Math.PI / 3;
  if (aligned) {
    const [fx, , fz] = forwardVec(s.yaw, 0);
    s.vx += fx * CARRIER.thrustAccel * dt;
    s.vz += fz * CARRIER.thrustAccel * dt;
  }

  // Damp vertical drift (carrier stays at its launch altitude).
  s.vy *= Math.pow(0.3, dt);

  // Pitch and roll bleed toward level (visual only).
  s.pitch += (0 - s.pitch) * Math.min(1, 3 * dt);
  s.roll += (0 - s.roll) * Math.min(1, 2 * dt);

  // Exponential drag.
  const keep = Math.pow(CARRIER.drag, dt);
  s.vx *= keep;
  s.vz *= keep;

  // Speed cap.
  const sp = Math.hypot(s.vx, s.vz);
  if (sp > CARRIER.courseMaxSpeed) {
    const k = CARRIER.courseMaxSpeed / sp;
    s.vx *= k;
    s.vz *= k;
  }

  // Integrate position.
  s.px += s.vx * dt;
  s.py += s.vy * dt;
  s.pz += s.vz * dt;

  // Clamp to arena.
  const a = SHIP.arena;
  s.px = clamp(s.px, -a, a);
  s.pz = clamp(s.pz, -a, a);

  return s;
}
