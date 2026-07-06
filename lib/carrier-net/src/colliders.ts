/**
 * Convex-ish hull colliders for Carrier entities.
 *
 * Each hull is an axis-aligned ellipsoid in world space (a fast convex
 * approximation — no Rapier dependency, deterministic on server + client).
 * Pairwise ship resolution still uses a conservative bounding sphere; splash
 * and explosion knockback use the ellipsoid for distance falloff.
 */
import { SHIP_COLLIDE_RADIUS, fleetRoleDef, type EntityState } from "./types";

/** Half-extents (metres) along local X / Y / Z for the convex capsule. */
export interface ColliderExtents {
  hx: number;
  hy: number;
  hz: number;
}

/** Per-kind ellipsoid half-axes (metres). Y is vertical, Z is nose-forward. */
export function colliderExtents(e: EntityState): ColliderExtents {
  if (e.kind === "mother_ship") {
    return { hx: 72, hy: 48, hz: 96 };
  }
  if (e.kind === "fleet_unit") {
    const def = fleetRoleDef(e.role);
    const s = def ? def.scale * 0.42 : 5;
    return { hx: s * 1.1, hy: s * 0.65, hz: s * 1.35 };
  }
  // Fighter / mech — narrow capsule.
  return { hx: 5.5, hy: 3.8, hz: 9 };
}

/**
 * Normalised ellipsoid distance from entity centre to a world point.
 * Values &lt; 1 mean inside the convex hull; 0 = centre.
 */
export function colliderDistance(
  e: EntityState,
  px: number,
  py: number,
  pz: number,
): number {
  const { hx, hy, hz } = colliderExtents(e);
  const dx = (px - e.px) / hx;
  const dy = (py - e.py) / hy;
  const dz = (pz - e.pz) / hz;
  return Math.hypot(dx, dy, dz);
}

/** Conservative sphere radius for broad-phase pairwise collision. */
export function collideRadius(e: EntityState): number {
  const { hx, hy, hz } = colliderExtents(e);
  return Math.max(hx, hy, hz, SHIP_COLLIDE_RADIUS);
}