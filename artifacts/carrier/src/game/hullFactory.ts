/**
 * hullFactory — the single shared render path for Carrier hull/station models.
 *
 * Both the live game engine (`CarrierGame`) and the dev-only mothership
 * inspector (`MothershipInspector`) build their fighter/fleet/station meshes
 * from these helpers, so what the inspector shows at true relative scale matches
 * exactly what spawns in gameplay. Keep these pure (no engine/scene state) so
 * neither caller drifts from the other.
 *
 * The fit formula is the contract: a station is normalised to
 *   SHIP_FIT * MOTHER_SHIP.scaleFactor * fitMul
 * (its longest axis), a fighter to SHIP_FIT, and a fleet unit to its role scale.
 */
import * as THREE from "three";
import { loadAsset, type LoadedModel } from "@workspace/assets";
import { FACTIONS, MOTHER_SHIP, type FactionId } from "@workspace/carrier-net";
import { FACTION_STATIONS, type ShipModel } from "./factionAssets";
import { FACTION_ACCENT } from "./motherships";
import { SHIP_FIT } from "./constants";
import { ensureOverridesPrimed, getOverrideTemplate } from "./hullOverrides";

/** Longest-axis fit length used for a faction's station, matching gameplay. */
export function stationFit(faction: FactionId): number {
  return SHIP_FIT * MOTHER_SHIP.scaleFactor * FACTION_STATIONS[faction].fitMul;
}

/**
 * Load a faction's (possibly multi-part) OBJ station, assemble the parts at
 * their native transforms, metal-PBR tint them, and fit the whole assembly ONCE
 * to the gameplay station size. Resolves to a ready-to-add group.
 */
export async function loadStationModel(faction: FactionId): Promise<THREE.Group> {
  const def = FACTION_STATIONS[faction];
  await ensureOverridesPrimed();
  const assembly = new THREE.Group();
  // A saved Shipyard replacement is ONE file keyed to the station's primary part
  // id (def.parts[0]); it stands in for the WHOLE multi-part assembly — exactly
  // as the Shipyard preview treats a station import. Otherwise assemble the
  // catalog parts at their native transforms.
  const override = getOverrideTemplate(def.parts[0]);
  if (override) {
    assembly.add(override.clone(true));
  } else {
    const models = await Promise.all(def.parts.map((id) => loadAsset(id)));
    for (const m of models) assembly.add((m as LoadedModel).scene.clone(true));
  }
  tintMetalHull(assembly, faction, true);
  fitObject(assembly, stationFit(faction));
  return assembly;
}

/**
 * Load a fighter/fleet hull GLB, auto-orient (or force the model's yaw),
 * metal-PBR tint it, and fit it to `fit`. Resolves to a ready-to-add object.
 */
export async function loadHullModel(
  model: ShipModel,
  faction: FactionId,
  fit: number,
): Promise<THREE.Object3D> {
  await ensureOverridesPrimed();
  // Prefer a saved Shipyard replacement for this slot; else the catalog default.
  // Orientation/tint/fit are applied identically either way, so what the Shipyard
  // preview shows for this model id is what spawns here.
  const override = getOverrideTemplate(model.id);
  const src = override ?? (await loadAsset(model.id) as LoadedModel).scene;
  const clone = src.clone(true);
  if (model.yaw === undefined) autoOrientShip(clone);
  else clone.rotation.y = model.yaw;
  tintMetalHull(clone, faction, false);
  fitObject(clone, fit);
  return clone;
}

/**
 * Re-skin a loaded hull/station with faction-tinted metal PBR.
 *
 * `m.scene.clone(true)` SHARES geometry with the loadAsset template and every
 * sibling clone, so meshes are flagged `sharedGeo` (disposeGroup never frees
 * shared geometry) and only the freshly-built materials below are owned.
 *
 * Motherships (`station`) get the same hero-hull treatment as the hangar
 * showcase: the MUTED client `FACTION_ACCENT` as a subtle emissive trim (so the
 * capital hull reads as real painted metal rather than a glowing neon wash),
 * matching the showcase's metalness/roughness/envMap. Fighters + fleet units
 * keep the brighter neon faction emissive for combat-readability at distance.
 * Neither path touches the shared netcode `FACTIONS[id].color`.
 */
export function tintMetalHull(
  root: THREE.Object3D,
  faction: FactionId,
  station: boolean,
): void {
  // Muted accent for capital hulls (matches the hangar showcase); bright neon
  // for small fighters/fleet so factions stay legible mid-dogfight.
  const accent = new THREE.Color(
    station ? FACTION_ACCENT[faction] : FACTIONS[faction].color,
  );
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.userData.sharedGeo = true;
    const hasUV = !!o.geometry.getAttribute("uv");
    const src = Array.isArray(o.material) ? o.material : [o.material];
    const next = src.map((mm) => {
      const base = mm as THREE.MeshStandardMaterial;
      const map = hasUV ? base.map ?? null : null;
      return new THREE.MeshStandardMaterial({
        map,
        color: map ? 0xffffff : station ? 0x6b7480 : 0x707886,
        metalness: station ? 0.9 : 0.92,
        roughness: station ? 0.45 : 0.4,
        emissive: accent,
        emissiveIntensity: station ? 0.12 : 0.22,
        envMapIntensity: station ? 1.1 : 1.15,
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

const _aoBox = new THREE.Box3();
const _aoSize = new THREE.Vector3();
const _aoCenter = new THREE.Vector3();
const _aoV = new THREE.Vector3();
const _aoUp = new THREE.Vector3(0, 1, 0);
const _aoQ = new THREE.Quaternion();

/**
 * Rotate a hull about Y so its (taper-detected) nose faces local +Z — the
 * engine's canonical nose direction. Samples vertices at each end and votes the
 * pointier (smaller average radius) end as the nose.
 */
export function autoOrientShip(obj: THREE.Object3D): void {
  obj.updateMatrixWorld(true);
  _aoBox.setFromObject(obj);
  _aoBox.getSize(_aoSize);
  _aoBox.getCenter(_aoCenter);
  // Pick the hull's longest axis (X, Y, or Z) as the nose-tail line.
  const axis = _aoSize.x >= _aoSize.y && _aoSize.x >= _aoSize.z ? "x"
    : _aoSize.y >= _aoSize.z ? "y" : "z";
  const half = (axis === "x" ? _aoSize.x : axis === "y" ? _aoSize.y : _aoSize.z) * 0.5 || 1;
  const cut = 0.45 * half;
  const cLng = axis === "x" ? _aoCenter.x : axis === "y" ? _aoCenter.y : _aoCenter.z;
  const cPerA = axis === "x" ? _aoCenter.z : axis === "y" ? _aoCenter.x : _aoCenter.x;
  const cPerB = axis === "x" ? _aoCenter.y : axis === "y" ? _aoCenter.z : _aoCenter.y;

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
      const lng = (axis === "x" ? _aoV.x : axis === "y" ? _aoV.y : _aoV.z) - cLng;
      const r = Math.hypot(
        (axis === "x" ? _aoV.z : axis === "y" ? _aoV.x : _aoV.x) - cPerA,
        (axis === "x" ? _aoV.y : axis === "y" ? _aoV.z : _aoV.y) - cPerB,
      );
      if (lng > cut) { frontR += r; frontN++; }
      else if (lng < -cut) { backR += r; backN++; }
    }
  });
  const fAvg = frontN ? frontR / frontN : Infinity;
  const bAvg = backN ? backR / backN : Infinity;
  const noseSign = fAvg <= bAvg ? 1 : -1; // +1 → nose at +length end
  const nose = new THREE.Vector3(
    axis === "x" ? noseSign : 0,
    axis === "y" ? noseSign : 0,
    axis === "z" ? noseSign : 0,
  );
  // Rotate the detected nose axis onto the engine's canonical +Z forward.
  _aoQ.setFromUnitVectors(nose.normalize(), new THREE.Vector3(0, 0, 1));
  obj.quaternion.premultiply(_aoQ);
}

/**
 * Dispose a group's owned GPU resources. `sharedGeo` meshes are loadAsset-
 * template clones whose geometry is shared with the cache + sibling clones, so
 * only their (owned, cloned) materials are freed — never the geometry.
 */
export function disposeGroup(g: THREE.Object3D): void {
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      if (!o.userData.sharedGeo) (o.geometry as THREE.BufferGeometry)?.dispose?.();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
      else (m as THREE.Material)?.dispose?.();
    }
  });
}
