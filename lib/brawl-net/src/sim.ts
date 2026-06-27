/**
 * Pure, deterministic core simulation for the Ruins Brawler.
 *
 * Everything here is side-effect-free given its arguments (no globals, no
 * `Math.random`, no wall-clock): the same inputs always produce the same output.
 * `stepPlayer` is run VERBATIM by both the authoritative server and the
 * predicting client; `stepZombie` / projectile / collision helpers run
 * server-side but are kept pure so the whole simulation stays reproducible.
 *
 * Map generation (`generateWorld`) is seed-deterministic so every connected
 * player and the server share one identical ruins layout.
 */
import { makeRng, randRange, randInt } from "./rng";
import {
  PLAYER,
  WORLD,
  ZOMBIE,
  type BrawlWorld,
  type Obstacle,
  type PlayerInput,
  type PlayerState,
  type ProjectileState,
  type SafeZone,
  type ZombieState,
} from "./types";

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

function norm2(x: number, z: number): [number, number] {
  const d = Math.hypot(x, z);
  if (d < 1e-6) return [0, 0];
  return [x / d, z / d];
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

/** Push a circle (px,pz,r) out of one axis-aligned obstacle box. */
function resolveObstacle(px: number, pz: number, r: number, o: Obstacle): [number, number] {
  const minx = o.px - o.hw;
  const maxx = o.px + o.hw;
  const minz = o.pz - o.hd;
  const maxz = o.pz + o.hd;
  const cx = clamp(px, minx, maxx);
  const cz = clamp(pz, minz, maxz);
  const dx = px - cx;
  const dz = pz - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 > r * r) return [px, pz];
  if (d2 > 1e-8) {
    const d = Math.sqrt(d2);
    const k = (r - d) / d;
    return [px + dx * k, pz + dz * k];
  }
  // Centre is inside the box — eject along the least-penetration axis.
  const toL = px - minx;
  const toR = maxx - px;
  const toT = pz - minz;
  const toB = maxz - pz;
  const m = Math.min(toL, toR, toT, toB);
  if (m === toL) return [minx - r, pz];
  if (m === toR) return [maxx + r, pz];
  if (m === toT) return [px, minz - r];
  return [px, maxz + r];
}

/** Resolve a circle against all obstacles and clamp it to the arena bounds. */
export function collideWorld(
  px: number,
  pz: number,
  r: number,
  world: BrawlWorld,
): [number, number] {
  let x = px;
  let z = pz;
  for (const o of world.obstacles) {
    [x, z] = resolveObstacle(x, z, r, o);
  }
  const lim = WORLD.half - r;
  x = clamp(x, -lim, lim);
  z = clamp(z, -lim, lim);
  return [x, z];
}

export function inSafeZone(px: number, pz: number, zones: SafeZone[]): boolean {
  for (const z of zones) {
    const dx = px - z.px;
    const dz = pz - z.pz;
    if (dx * dx + dz * dz <= z.radius * z.radius) return true;
  }
  return false;
}

/** Keep a circle OUT of every safe zone (zombies cannot enter sanctuaries). */
export function keepOutOfSafe(
  px: number,
  pz: number,
  r: number,
  zones: SafeZone[],
): [number, number] {
  let x = px;
  let z = pz;
  for (const zo of zones) {
    const dx = x - zo.px;
    const dz = z - zo.pz;
    const minD = zo.radius + r;
    const d2 = dx * dx + dz * dz;
    if (d2 < minD * minD) {
      if (d2 < 1e-12) {
        // Dead-centre: no push direction exists, so eject along +x.
        x = zo.px + minD;
        z = zo.pz;
        continue;
      }
      const d = Math.sqrt(d2);
      const k = (minD - d) / d;
      x += dx * k;
      z += dz * k;
    }
  }
  return [x, z];
}

// ---------------------------------------------------------------------------
// Player integrator (shared client + server)
// ---------------------------------------------------------------------------

/**
 * Advance one player by a single input command. Handles aim/facing, the dash
 * trigger + lunge kinematics, normal move, obstacle collision, and arena
 * bounds. Mutates and returns `p`. Combat consequences (firing, dash damage)
 * are resolved server-side; this is only the movement model the client predicts.
 */
export function stepPlayer(
  p: PlayerState,
  input: PlayerInput,
  world: BrawlWorld,
  dt: number,
  tick: number,
): PlayerState {
  if (!p.alive) {
    p.vx = 0;
    p.vz = 0;
    return p;
  }
  if (dt <= 0) return p;

  const [ax, az] = norm2(input.aimX, input.aimZ);
  if (ax !== 0 || az !== 0) {
    p.ax = ax;
    p.az = az;
  }

  // Dash trigger (shared so the client predicts the lunge instantly).
  if (input.dash && tick >= p.dashReadyTick) {
    p.dashTick = tick + PLAYER.dashTicks;
    p.dashReadyTick = tick + PLAYER.dashCooldownTicks;
    p.dashX = p.ax;
    p.dashZ = p.az;
  }

  let nx = p.px;
  let nz = p.pz;
  if (tick < p.dashTick) {
    nx += p.dashX * PLAYER.dashSpeed * dt;
    nz += p.dashZ * PLAYER.dashSpeed * dt;
    p.vx = p.dashX * PLAYER.dashSpeed;
    p.vz = p.dashZ * PLAYER.dashSpeed;
  } else {
    let mx = input.moveX;
    let mz = input.moveZ;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) {
      mx /= ml;
      mz /= ml;
    }
    nx += mx * PLAYER.speed * dt;
    nz += mz * PLAYER.speed * dt;
    p.vx = mx * PLAYER.speed;
    p.vz = mz * PLAYER.speed;
  }

  [nx, nz] = collideWorld(nx, nz, PLAYER.radius, world);
  p.px = nx;
  p.pz = nz;
  return p;
}

export function isDashing(p: PlayerState, tick: number): boolean {
  return tick < p.dashTick;
}

// ---------------------------------------------------------------------------
// Zombie AI (server-only, but pure)
// ---------------------------------------------------------------------------

/**
 * Advance one zombie toward its target. Walks the shortest line to `target`
 * (the server picks the nearest living, non-safe player), collides with
 * obstacles, and is ejected from safe zones. If there is no target it idles.
 */
export function stepZombie(
  z: ZombieState,
  target: { px: number; pz: number } | null,
  world: BrawlWorld,
  dt: number,
): ZombieState {
  if (dt <= 0) return z;
  if (target) {
    const [dx, dz] = norm2(target.px - z.px, target.pz - z.pz);
    const sp = ZOMBIE.speed * (1 + z.tier * 0.15);
    z.vx = dx * sp;
    z.vz = dz * sp;
    if (dx !== 0 || dz !== 0) z.facing = Math.atan2(dx, dz);
  } else {
    z.vx = 0;
    z.vz = 0;
  }
  let nx = z.px + z.vx * dt;
  let nz = z.pz + z.vz * dt;
  [nx, nz] = collideWorld(nx, nz, ZOMBIE.radius, world);
  [nx, nz] = keepOutOfSafe(nx, nz, ZOMBIE.radius, world.safeZones);
  z.px = nx;
  z.pz = nz;
  return z;
}

/**
 * Resolve pairwise crowd separation between zombies so they spread out instead
 * of stacking. Deterministic given a stable iteration order, so callers MUST
 * pass the list in the same order every tick.
 */
export function separateZombies(zs: ZombieState[]): void {
  const minD = ZOMBIE.radius * 2;
  for (let i = 0; i < zs.length; i++) {
    const a = zs[i];
    for (let j = i + 1; j < zs.length; j++) {
      const b = zs[j];
      const dx = b.px - a.px;
      const dz = b.pz - a.pz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= minD * minD || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      const overlap = ((minD - d) * 0.5) * ZOMBIE.separation;
      const nx = dx / d;
      const nz = dz / d;
      a.px -= nx * overlap;
      a.pz -= nz * overlap;
      b.px += nx * overlap;
      b.pz += nz * overlap;
    }
  }
}

// ---------------------------------------------------------------------------
// Projectiles
// ---------------------------------------------------------------------------

export function stepProjectile(pr: ProjectileState, dt: number): ProjectileState {
  pr.px += pr.vx * dt;
  pr.pz += pr.vz * dt;
  return pr;
}

/** True if a projectile point is inside any obstacle box (treated as a wall). */
export function projectileHitsWorld(px: number, pz: number, world: BrawlWorld): boolean {
  if (px < -WORLD.half || px > WORLD.half || pz < -WORLD.half || pz > WORLD.half) {
    return true;
  }
  for (const o of world.obstacles) {
    if (px >= o.px - o.hw && px <= o.px + o.hw && pz >= o.pz - o.hd && pz <= o.pz + o.hd) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// World generation (seed-deterministic)
// ---------------------------------------------------------------------------

export const SAFE = {
  count: 4,
  radius: 26,
  /** Distance of the outer safe zones from the centre. */
  ring: WORLD.half * 0.6,
} as const;

export const RUINS = {
  count: 84,
  minHalf: 1.6,
  maxHalf: 4.6,
  minHeight: 3,
  maxHeight: 13,
  /** Clearance kept between a ruin and any safe zone. */
  safeMargin: 6,
} as const;

/**
 * Build the entire static world from a single seed: a central safe hub plus
 * evenly-spaced outer safe zones, and a field of axis-aligned ruins that avoid
 * the safe zones. Pure + deterministic — identical for every player.
 */
export function generateWorld(seed: number): BrawlWorld {
  const rng = makeRng(seed >>> 0);

  const safeZones: SafeZone[] = [
    { id: "safe-0", px: 0, pz: 0, radius: SAFE.radius },
  ];
  for (let i = 1; i < SAFE.count; i++) {
    const ang = (i - 1) * ((Math.PI * 2) / (SAFE.count - 1));
    safeZones.push({
      id: `safe-${i}`,
      px: Math.cos(ang) * SAFE.ring,
      pz: Math.sin(ang) * SAFE.ring,
      radius: SAFE.radius,
    });
  }

  const obstacles: Obstacle[] = [];
  let attempts = 0;
  while (obstacles.length < RUINS.count && attempts < RUINS.count * 24) {
    attempts++;
    const hw = randRange(rng, RUINS.minHalf, RUINS.maxHalf);
    const hd = randRange(rng, RUINS.minHalf, RUINS.maxHalf);
    const lim = WORLD.half - Math.max(hw, hd) - 2;
    const px = randRange(rng, -lim, lim);
    const pz = randRange(rng, -lim, lim);
    const height = randRange(rng, RUINS.minHeight, RUINS.maxHeight);
    const blockSeed = randInt(rng, 1, 0x7fffffff);

    const rad = Math.hypot(hw, hd);
    let bad = false;
    for (const z of safeZones) {
      const dx = px - z.px;
      const dz = pz - z.pz;
      if (Math.hypot(dx, dz) < z.radius + rad + RUINS.safeMargin) {
        bad = true;
        break;
      }
    }
    if (bad) continue;

    obstacles.push({
      id: `ruin-${obstacles.length}`,
      px,
      pz,
      hw,
      hd,
      height,
      seed: blockSeed,
    });
  }

  return { obstacles, safeZones };
}

export function nearestSafeZone(px: number, pz: number, zones: SafeZone[]): SafeZone {
  let best = zones[0];
  let bd = Infinity;
  for (const z of zones) {
    const dx = px - z.px;
    const dz = pz - z.pz;
    const d = dx * dx + dz * dz;
    if (d < bd) {
      bd = d;
      best = z;
    }
  }
  return best;
}
