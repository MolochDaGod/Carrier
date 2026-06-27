/**
 * Shared model fit + nose-orientation helpers.
 *
 * Extracted from CarrierGame so the dev-only model inspector can fit and orient
 * hulls with the *exact* same logic the live game uses — there is no second
 * implementation to drift out of sync.
 */
import * as THREE from "three";
import { FACTIONS, type FactionId } from "@workspace/carrier-net";

const _aoBox = new THREE.Box3();
const _aoSize = new THREE.Vector3();
const _aoCenter = new THREE.Vector3();
const _aoV = new THREE.Vector3();
const _aoUp = new THREE.Vector3(0, 1, 0);
const _aoQ = new THREE.Quaternion();

/**
 * Auto-orient a hull so its nose faces local +Z (the engine's canonical nose).
 * Find the model's longest horizontal axis, sample the vertices at each of the
 * two ends along that axis, measure each end's mean perpendicular (cross-section)
 * radius, and treat the smaller-radius end as the nose. The world-Y delta that
 * brings that end to +Z is premultiplied onto the clone's quaternion (premultiply
 * = parent-space spin, so it stays correct even if the loader left a root tilt,
 * e.g. a Z-up FBX). Runs once per template clone, before `fitObject`.
 */
export function autoOrientShip(obj: THREE.Object3D): void {
  obj.updateMatrixWorld(true);
  _aoBox.setFromObject(obj);
  _aoBox.getSize(_aoSize);
  _aoBox.getCenter(_aoCenter);
  const alongX = _aoSize.x >= _aoSize.z;
  const half = (alongX ? _aoSize.x : _aoSize.z) * 0.5 || 1;
  const cut = 0.45 * half; // only the outer ~10% of each end votes
  const cLng = alongX ? _aoCenter.x : _aoCenter.z;
  const cPer = alongX ? _aoCenter.z : _aoCenter.x;

  let total = 0;
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh) total += o.geometry.getAttribute("position")?.count ?? 0;
  });
  const step = total > 4000 ? Math.ceil(total / 4000) : 1;

  let frontR = 0, frontN = 0, backR = 0, backN = 0, i = 0;
  obj.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const pos = o.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) return;
    for (let k = 0; k < pos.count; k++, i++) {
      if (i % step !== 0) continue;
      _aoV.fromBufferAttribute(pos, k).applyMatrix4(o.matrixWorld);
      const lng = (alongX ? _aoV.x : _aoV.z) - cLng;
      const r = Math.abs((alongX ? _aoV.z : _aoV.x) - cPer);
      if (lng > cut) { frontR += r; frontN++; }
      else if (lng < -cut) { backR += r; backN++; }
    }
  });
  const fAvg = frontN ? frontR / frontN : Infinity;
  const bAvg = backN ? backR / backN : Infinity;
  const noseSign = fAvg <= bAvg ? 1 : -1; // +1 → nose at +length end
  const nx = alongX ? noseSign : 0;
  const nz = alongX ? 0 : noseSign;
  // World-Y rotation that maps the nose direction onto +Z.
  _aoQ.setFromAxisAngle(_aoUp, -Math.atan2(nx, nz));
  obj.quaternion.premultiply(_aoQ);
}

/**
 * Re-material a loaded clone with faction-tinted metal PBR. Each source material
 * is CLONED into a fresh standard material (the loadAsset template's materials
 * are shared across faction clones and must never be mutated); the diffuse map is
 * referenced (never cloned/disposed — Material.dispose() leaves textures alone)
 * and only kept when the geometry actually has UVs.
 */
export function tintMetal(root: THREE.Object3D, faction: FactionId, station: boolean): void {
  const fcol = new THREE.Color(FACTIONS[faction].color);
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    // `m.scene.clone(true)` SHARES geometry with the loadAsset template and
    // every sibling faction/class clone. Flag it so disposeGroup never frees
    // it on per-entity teardown (the loadAsset cache owns it for the session);
    // only the freshly-built materials below are owned and disposable.
    o.userData.sharedGeo = true;
    const hasUV = !!o.geometry.getAttribute("uv");
    const src = Array.isArray(o.material) ? o.material : [o.material];
    const next = src.map((mm) => {
      const base = mm as THREE.MeshStandardMaterial;
      const map = hasUV ? base.map ?? null : null;
      return new THREE.MeshStandardMaterial({
        map,
        color: map ? 0xffffff : 0x707886,
        metalness: 0.92,
        roughness: 0.4,
        emissive: fcol,
        emissiveIntensity: station ? 0.14 : 0.22,
        envMapIntensity: 1.15,
      });
    });
    o.material = Array.isArray(o.material) ? next : next[0];
  });
}

/** Recentre an object on its bounding-box centre and scale so its longest axis = fit. */
export function fitObject(obj: THREE.Object3D, fit: number): void {
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const longest = Math.max(size.x, size.y, size.z) || 1;
  const s = fit / longest;
  obj.position.sub(center.multiplyScalar(s));
  obj.scale.multiplyScalar(s);
}
