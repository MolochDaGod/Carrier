/**
 * Engine boosters: animated additive-shader exhaust flames that ride a ship's
 * OUTER group (so they survive the async procedural→GLB/OBJ hull swap, exactly
 * like the cosmetic hull turrets). Each flame owns its OWN geometry + material,
 * so the generic `disposeGroup` sweep on teardown frees them automatically.
 *
 * Mounts are re-anchored to the fitted hull bounding box when the GLB/OBJ swaps
 * in (`repositionThrustersFromHull`). Each frame the plume aims opposite the
 * ship's velocity (fallback: opposite nose forward when nearly stationary).
 */
import * as THREE from "three";
import { forwardVec, type FactionId } from "@workspace/carrier-net";

export type ThrusterKind = "fighter" | "fleet_unit" | "mother_ship";

export interface AttachOpts {
  kind: ThrusterKind;
  color: string | number;
  fitLen: number;
  ref: number;
  faction?: FactionId;
}

interface ThrusterMesh {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
}

interface ThrusterHandle {
  kind: ThrusterKind;
  faction?: FactionId;
  meshes: ThrusterMesh[];
  ref: number;
  cur: number;
  boost: number;
}

interface MountSpec {
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  radius: number;
  height: number;
}

const IDLE = 0.16;
const BOOST_HEADROOM = 1.6;
const UP = new THREE.Vector3(0, 1, 0);
const MOTION_ALIGN_MIN = 10;

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();
const _exhaustWorld = new THREE.Vector3();
const _exhaustLocal = new THREE.Vector3();
const _groupQuat = new THREE.Quaternion();
const _invGroupQuat = new THREE.Quaternion();
const _fwd = new THREE.Vector3();

const THRUSTER_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const THRUSTER_FRAG = /* glsl */ `
  uniform float uTime; uniform float uIntensity; uniform float uBoost; uniform vec3 uColor;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
  void main() {
    float y = vUv.y;
    float thr = clamp(uIntensity, 0.0, 1.0);
    float boost = clamp(uBoost, 0.0, 1.0);
    float baseLen = mix(0.18, 0.62, thr);
    float len = mix(baseLen, 1.0, boost);
    float body = smoothstep(len, len * 0.18, y);
    float core = smoothstep(0.55, 0.0, y);
    float flick = 0.85 + 0.15 * sin(uTime * 38.0 + vUv.x * 27.0);
    float n = hash(vec2(floor(vUv.x * 8.0), floor((y - uTime * 1.6) * 9.0)));
    float rim = pow(max(0.0, sin(vUv.x * 3.14159)), 0.6);
    float a = body * (0.32 + 0.68 * core) * flick * (0.55 + 0.45 * rim);
    a *= (0.7 + 0.3 * n) * (0.35 + 0.85 * thr + 0.5 * boost);
    vec3 hot = vec3(1.0, 0.96, 0.86);
    vec3 col = mix(uColor, hot, clamp(core * 0.85 + boost * 0.55, 0.0, 1.0));
    gl_FragColor = vec4(col * (0.85 + 0.5 * core + 0.5 * boost), clamp(a, 0.0, 1.0));
  }
`;

function makeThrusterMaterial(color: string | number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: IDLE },
      uBoost: { value: 0 },
      uColor: { value: new THREE.Color(color) },
    },
    vertexShader: THRUSTER_VERT,
    fragmentShader: THRUSTER_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

function makeThrusterMesh(m: MountSpec, color: string | number): ThrusterMesh {
  const coneH = m.height * BOOST_HEADROOM;
  const geo = new THREE.ConeGeometry(m.radius, coneH, 14, 1, true);
  geo.translate(0, coneH / 2, 0);
  const mat = makeThrusterMaterial(color);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.quaternion.setFromUnitVectors(UP, m.dir);
  mesh.position.copy(m.pos);
  mesh.renderOrder = 3;
  return { mesh, mat };
}

/** Spread pattern for capital-hull rear clusters (fractions of bbox width/height). */
interface MotherMount {
  x: number;
  y: number;
  r: number;
  h: number;
}

function ring(count: number, radius: number, y: number, r: number, h: number): MotherMount[] {
  const out: MotherMount[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    out.push({ x: Math.cos(a) * radius, y, r, h });
  }
  return out;
}

const MOTHER_MOUNTS: Record<FactionId, MotherMount[]> = {
  scavengers: [
    { x: -0.28, y: -0.12, r: 0.035, h: 0.28 },
    { x: 0.28, y: -0.12, r: 0.035, h: 0.28 },
    { x: -0.28, y: 0.12, r: 0.035, h: 0.28 },
    { x: 0.28, y: 0.12, r: 0.035, h: 0.28 },
  ],
  hollow: [
    { x: -0.35, y: -0.18, r: 0.03, h: 0.26 },
    { x: 0.35, y: -0.18, r: 0.03, h: 0.26 },
    { x: -0.35, y: 0.18, r: 0.03, h: 0.26 },
    { x: 0.35, y: 0.18, r: 0.03, h: 0.26 },
  ],
  network: [
    { x: -0.12, y: -0.12, r: 0.03, h: 0.24 },
    { x: 0.12, y: -0.12, r: 0.03, h: 0.24 },
    { x: -0.12, y: 0.12, r: 0.03, h: 0.24 },
    { x: 0.12, y: 0.12, r: 0.03, h: 0.24 },
  ],
  brood: ring(6, 0.32, 0, 0.032, 0.24),
  prospector: [
    { x: -0.22, y: 0, r: 0.028, h: 0.24 },
    { x: 0, y: 0, r: 0.028, h: 0.24 },
    { x: 0.22, y: 0, r: 0.028, h: 0.24 },
  ],
};

/** Hull bbox in the parent group's local space. */
function hullBoxInGroup(group: THREE.Group, hull: THREE.Object3D): THREE.Box3 {
  hull.updateMatrixWorld(true);
  group.updateMatrixWorld(true);
  _box.setFromObject(hull);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  _box.applyMatrix4(inv);
  return _box.clone();
}

/**
 * Engine nozzles on the hull's rear face (+Z nose → min-Z exhaust face).
 * Positions sit flush on the mesh surface, not floating below it.
 */
function mountsFromHullBox(
  kind: ThrusterKind,
  box: THREE.Box3,
  faction?: FactionId,
): MountSpec[] {
  box.getSize(_size);
  box.getCenter(_center);
  const fit = Math.max(_size.x, _size.y, _size.z, 1);
  const inset = fit * 0.012;
  const rearZ = box.min.z + inset;
  const exhaustDir = new THREE.Vector3(0, 0, -1);

  if (kind === "mother_ship") {
    const layout = (faction && MOTHER_MOUNTS[faction]) || MOTHER_MOUNTS.scavengers;
    return layout.map((m) => ({
      pos: new THREE.Vector3(
        _center.x + m.x * _size.x,
        _center.y + m.y * _size.y,
        rearZ,
      ),
      dir: exhaustDir.clone(),
      radius: m.r * fit,
      height: m.h * fit,
    }));
  }

  if (kind === "fleet_unit") {
    return [{
      pos: new THREE.Vector3(_center.x, _center.y, rearZ),
      dir: exhaustDir.clone(),
      radius: fit * 0.12,
      height: fit * 0.55,
    }];
  }

  const span = _size.x * 0.16;
  const radius = fit * 0.055;
  const height = fit * 0.52;
  return [
    {
      pos: new THREE.Vector3(_center.x - span, _center.y, rearZ),
      dir: exhaustDir.clone(),
      radius,
      height,
    },
    {
      pos: new THREE.Vector3(_center.x + span, _center.y, rearZ),
      dir: exhaustDir.clone(),
      radius,
      height,
    },
  ];
}

/** Provisional mounts before the async hull swap (uses fitLen fractions). */
function provisionalMounts(kind: ThrusterKind, fit: number, faction?: FactionId): MountSpec[] {
  const box = new THREE.Box3(
    new THREE.Vector3(-fit * 0.22, -fit * 0.14, -fit * 0.5),
    new THREE.Vector3(fit * 0.22, fit * 0.14, fit * 0.5),
  );
  return mountsFromHullBox(kind, box, faction);
}

function exhaustDirLocal(
  group: THREE.Object3D,
  vx: number,
  vy: number,
  vz: number,
  yaw: number,
  pitch: number,
): THREE.Vector3 {
  const sp = Math.hypot(vx, vy, vz);
  if (sp > MOTION_ALIGN_MIN) {
    _exhaustWorld.set(-vx / sp, -vy / sp, -vz / sp);
  } else {
    const [fx, fy, fz] = forwardVec(yaw, pitch);
    _exhaustWorld.set(-fx, -fy, -fz);
  }
  group.getWorldQuaternion(_groupQuat);
  _invGroupQuat.copy(_groupQuat).invert();
  return _exhaustLocal.copy(_exhaustWorld).applyQuaternion(_invGroupQuat).normalize();
}

/**
 * Re-anchor booster nozzles to the fitted hull mesh (call after `swapFallback`).
 */
export function repositionThrustersFromHull(group: THREE.Group): void {
  const h = group.userData.thrusters as ThrusterHandle | undefined;
  if (!h) return;
  const hull = (group.userData.glb as THREE.Object3D | undefined)
    ?? (group.userData.fallback as THREE.Object3D | undefined);
  if (!hull) return;

  const mounts = mountsFromHullBox(h.kind, hullBoxInGroup(group, hull), h.faction);
  for (let i = 0; i < h.meshes.length && i < mounts.length; i++) {
    h.meshes[i].mesh.position.copy(mounts[i].pos);
  }
}

export function attachThrusters(group: THREE.Group, opts: AttachOpts): void {
  const mounts = provisionalMounts(opts.kind, opts.fitLen, opts.faction);
  const meshes: ThrusterMesh[] = [];
  for (const m of mounts) {
    const entry = makeThrusterMesh(m, opts.color);
    group.add(entry.mesh);
    meshes.push(entry);
  }
  const handle: ThrusterHandle = {
    kind: opts.kind,
    faction: opts.faction,
    meshes,
    ref: opts.ref,
    cur: IDLE,
    boost: 0,
  };
  group.userData.thrusters = handle;
  repositionThrustersFromHull(group);
}

export function updateThrusterSet(
  group: THREE.Object3D,
  speed: number,
  t: number,
  dt: number,
  boost?: boolean,
  motion?: { vx: number; vy: number; vz: number; yaw: number; pitch: number },
): void {
  const h = group.userData.thrusters as ThrusterHandle | undefined;
  if (!h) return;

  const throttle = Math.min(1.25, speed / h.ref);
  const target = Math.max(IDLE, throttle);
  h.cur += (target - h.cur) * Math.min(1, 9 * dt);

  const boosting = boost ?? speed > h.ref * 1.06;
  const boostTarget = boosting ? 1 : 0;
  const boostRate = boosting ? 16 : 6;
  h.boost += (boostTarget - h.boost) * Math.min(1, boostRate * dt);

  let exhaustDir: THREE.Vector3 | null = null;
  if (motion) {
    exhaustDir = exhaustDirLocal(group, motion.vx, motion.vy, motion.vz, motion.yaw, motion.pitch);
  }

  for (const { mesh, mat } of h.meshes) {
    if (exhaustDir) {
      mesh.quaternion.setFromUnitVectors(UP, exhaustDir);
    }
    mat.uniforms.uTime.value = t;
    mat.uniforms.uIntensity.value = h.cur;
    mat.uniforms.uBoost.value = h.boost;
  }
}