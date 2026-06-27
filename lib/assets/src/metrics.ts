import { Box3, type Object3D, Sphere, Vector3 } from "three";

import type { ModelMetrics } from "./types.js";

/**
 * Measure an object's dimensional metrics from its current world-space bounding
 * box. This is the single source of truth for "how big / where is" a model, used
 * both to annotate freshly-loaded models (see `loaders.ts`) and to re-measure a
 * clone after it has been scaled or posed.
 *
 * The object should be attached to the scene graph it will live in (or have up-
 * to-date matrices) before measuring; `Box3.setFromObject` calls
 * `updateWorldMatrix` itself, so a detached, freshly-cloned object measures fine.
 */
export function measure(obj: Object3D): ModelMetrics {
  const box = new Box3().setFromObject(obj);

  // An empty box (no renderable geometry) yields +/-Infinity; normalise to zero
  // so consumers get safe, finite numbers rather than NaN-propagating scales.
  if (!isFinite(box.min.x) || !isFinite(box.max.x)) {
    const zero = { x: 0, y: 0, z: 0 };
    return {
      size: { ...zero },
      center: { ...zero },
      min: { ...zero },
      max: { ...zero },
      footprint: { x: 0, z: 0 },
      longestHorizontal: 0,
      longest: 0,
      radius: 0,
      feetOffset: 0,
    };
  }

  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  const sphere = box.getBoundingSphere(new Sphere(center.clone()));

  return {
    size: { x: size.x, y: size.y, z: size.z },
    center: { x: center.x, y: center.y, z: center.z },
    min: { x: box.min.x, y: box.min.y, z: box.min.z },
    max: { x: box.max.x, y: box.max.y, z: box.max.z },
    footprint: { x: size.x / 2, z: size.z / 2 },
    longestHorizontal: Math.max(size.x, size.z),
    longest: Math.max(size.x, size.y, size.z),
    radius: sphere.radius,
    feetOffset: -box.min.y,
  };
}
