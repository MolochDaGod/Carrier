/**
 * Hull-surface turret placement for mothership stations.
 *
 * After the faction station GLB loads, raycasts from candidate points above the
 * hull onto mesh geometry and returns mount positions + outward normals so
 * turrets sit flush on the convex hull instead of a flat grid in empty space.
 */
import * as THREE from "three";

export interface HullMount {
  position: THREE.Vector3;
  normal: THREE.Vector3;
}

const _ray = new THREE.Raycaster();
const _down = new THREE.Vector3(0, -1, 0);
const _origin = new THREE.Vector3();
const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();

/**
 * Sample `count` mount sites on the upper hull of `hull` (local space).
 * Falls back to a ring above the bbox if raycasts miss.
 */
export function sampleHullTurretMounts(hull: THREE.Object3D, count: number): HullMount[] {
  hull.updateMatrixWorld(true);
  _box.setFromObject(hull);
  _box.getSize(_size);
  _box.getCenter(_center);

  const meshes: THREE.Mesh[] = [];
  hull.traverse((o) => {
    if (o instanceof THREE.Mesh && o.geometry) meshes.push(o);
  });

  const mounts: HullMount[] = [];
  const rows = Math.ceil(count / 2);
  let placed = 0;

  for (let r = 0; r < rows && placed < count; r++) {
    const zt = rows <= 1 ? 0.5 : r / (rows - 1);
    const z = _center.z + (zt - 0.5) * _size.z * 0.55;
    for (const side of [-1, 1]) {
      if (placed >= count) break;
      const x = _center.x + side * _size.x * 0.22;
      const yTop = _box.max.y + _size.y * 0.35;
      _origin.set(x, yTop, z);
      _ray.set(_origin, _down);
      _ray.far = _size.y * 2.5;

      const hits = _ray.intersectObjects(meshes, false);
      if (hits.length > 0) {
        const hit = hits[0];
        const worldN = new THREE.Vector3(0, 1, 0);
        if (hit.face) {
          worldN.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();
        }
        if (worldN.y < 0.15) continue;
        const pos = hit.point.clone();
        hull.worldToLocal(pos);
        const localN = worldN.clone().transformDirection(
          new THREE.Matrix4().copy(hull.matrixWorld).invert(),
        ).normalize();
        mounts.push({ position: pos, normal: localN });
        placed++;
        continue;
      }

      const fallbackY = _box.max.y + _size.y * 0.04;
      mounts.push({
        position: new THREE.Vector3(x, fallbackY, z),
        normal: new THREE.Vector3(0, 1, 0),
      });
      placed++;
    }
  }

  while (mounts.length < count) {
    const ang = (mounts.length / count) * Math.PI * 2;
    const r = Math.max(_size.x, _size.z) * 0.28;
    mounts.push({
      position: new THREE.Vector3(
        _center.x + Math.cos(ang) * r,
        _box.max.y + _size.y * 0.05,
        _center.z + Math.sin(ang) * r,
      ),
      normal: new THREE.Vector3(0, 1, 0),
    });
  }

  return mounts.slice(0, count);
}