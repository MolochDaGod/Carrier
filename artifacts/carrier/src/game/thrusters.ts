/**
 * Engine boosters: animated additive-shader exhaust flames that ride a ship's
 * OUTER group (so they survive the async procedural→GLB/OBJ hull swap, exactly
 * like the cosmetic hull turrets). Each flame owns its OWN geometry + material,
 * so the generic `disposeGroup` sweep on teardown frees them automatically — no
 * shared resource is ever disposed by accident.
 *
 * The look mirrors the energy-beam shaders (`CarrierGame` bottom): a single
 * `uTime` uniform animates flicker and a `uIntensity` uniform (0..~1) drives how
 * long + bright the plume reads, so a parked hull idles with a small pilot flame
 * and a boosting hull throws a long white-hot plume. Intensity is driven per
 * frame from the ship's own speed via `updateThrusterSet`.
 */
import * as THREE from "three";
import type { FactionId } from "@workspace/carrier-net";

export type ThrusterKind = "fighter" | "fleet_unit" | "mother_ship";

export interface AttachOpts {
  kind: ThrusterKind;
  /** Flame tint (faction/role colour); the hot core always blends toward white. */
  color: string | number;
  /** The hull's fit length — every mount/size is derived from this. */
  fitLen: number;
  /** Speed (units/s) at which the plume reads as "full throttle". */
  ref: number;
  /**
   * Capital hulls only: which faction station this belongs to. Selects the
   * per-faction belly engine layout in `MOTHER_MOUNTS` so flames land on each
   * station's real engine geometry instead of a generic 2x2 cluster.
   */
  faction?: FactionId;
}

interface ThrusterHandle {
  mats: THREE.ShaderMaterial[];
  ref: number;
  cur: number;
  /** Smoothed afterburner spike (0 = none, 1 = full boost), separate from speed. */
  boost: number;
}

interface Mount {
  pos: [number, number, number];
  dir: THREE.Vector3;
  radius: number;
  height: number;
}

/** Idle floor so engines always show a faint pilot flame when stationary. */
const IDLE = 0.16;
/**
 * The cone is built this much taller than the speed-driven plume needs, so a
 * boost/afterburner spike can extend the visible flame BEYOND the normal
 * full-throttle length into the extra headroom. The shader keeps the
 * speed-driven plume filling only `BASE_MAX` of the cone (so the normal look is
 * unchanged) and lets boost push the fill toward 1.0.
 */
const BOOST_HEADROOM = 1.6;
const UP = new THREE.Vector3(0, 1, 0);

const THRUSTER_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// vUv.y runs 0 at the nozzle (cone base) → 1 at the plume tip (cone apex).
const THRUSTER_FRAG = /* glsl */ `
  uniform float uTime; uniform float uIntensity; uniform float uBoost; uniform vec3 uColor;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
  void main() {
    float y = vUv.y;
    float thr = clamp(uIntensity, 0.0, 1.0);
    float boost = clamp(uBoost, 0.0, 1.0);
    // Plume length grows with throttle but only fills up to BASE_MAX of the
    // (head-roomed) cone; an afterburner boost pushes the fill toward the tip.
    float baseLen = mix(0.18, 0.62, thr);
    float len = mix(baseLen, 1.0, boost);
    float body = smoothstep(len, len * 0.18, y);   // solid near nozzle, cut past len
    float core = smoothstep(0.55, 0.0, y);          // hottest right at the nozzle
    float flick = 0.85 + 0.15 * sin(uTime * 38.0 + vUv.x * 27.0);
    float n = hash(vec2(floor(vUv.x * 8.0), floor((y - uTime * 1.6) * 9.0)));
    float rim = pow(max(0.0, sin(vUv.x * 3.14159)), 0.6); // brighten the facing crest
    float a = body * (0.32 + 0.68 * core) * flick * (0.55 + 0.45 * rim);
    // Boost runs brighter on top of the speed-driven punch.
    a *= (0.7 + 0.3 * n) * (0.35 + 0.85 * thr + 0.5 * boost);
    vec3 hot = vec3(1.0, 0.96, 0.86);
    // Boost burns hotter/whiter all the way down the plume.
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

/**
 * Per-faction capital-station belly engine layout. Every station is fit so its
 * LONGEST axis = its station fit, then recentred on the bbox centre, so these
 * fractions-of-fit map straight onto the in-game hull. The numbers were read off
 * each station's actual lower-hull geometry (the bottom ~15% slab of vertices),
 * so the downward flames sit on each hull's real engine pods rather than a
 * generic cluster:
 *  - scavengers: 4 corner "legs" dangling under the green pyramid.
 *  - hollow: 4 outboard nacelles at the corners of the elongated spire.
 *  - network: one tight central pod under the cube's narrow underside point.
 *  - brood: a ring of pods around the underside of the flat disc.
 *  - prospector: a transverse row of pods on the long-thin spine's belly.
 * `y` is tucked just inside each hull's lowest extent so the plume emerges from
 * the belly. `r`/`h` are radius/height, all as fractions of the station fit.
 */
interface MotherMount {
  x: number;
  y: number;
  z: number;
  r: number;
  h: number;
}

function ring(count: number, radius: number, y: number, r: number, h: number): MotherMount[] {
  const out: MotherMount[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    out.push({ x: Math.cos(a) * radius, y, z: Math.sin(a) * radius, r, h });
  }
  return out;
}

const MOTHER_MOUNTS: Record<FactionId, MotherMount[]> = {
  scavengers: [
    { x: -0.155, y: -0.47, z: -0.16, r: 0.035, h: 0.32 },
    { x: 0.155, y: -0.47, z: -0.16, r: 0.035, h: 0.32 },
    { x: -0.155, y: -0.47, z: 0.16, r: 0.035, h: 0.32 },
    { x: 0.155, y: -0.47, z: 0.16, r: 0.035, h: 0.32 },
  ],
  hollow: [
    { x: -0.42, y: -0.16, z: -0.21, r: 0.03, h: 0.3 },
    { x: 0.42, y: -0.16, z: -0.21, r: 0.03, h: 0.3 },
    { x: -0.42, y: -0.16, z: 0.21, r: 0.03, h: 0.3 },
    { x: 0.42, y: -0.16, z: 0.21, r: 0.03, h: 0.3 },
  ],
  network: [
    { x: -0.04, y: -0.36, z: -0.04, r: 0.03, h: 0.3 },
    { x: 0.04, y: -0.36, z: -0.04, r: 0.03, h: 0.3 },
    { x: -0.04, y: -0.36, z: 0.04, r: 0.03, h: 0.3 },
    { x: 0.04, y: -0.36, z: 0.04, r: 0.03, h: 0.3 },
  ],
  brood: ring(6, 0.3, -0.045, 0.032, 0.26),
  prospector: [
    { x: -0.06, y: -0.072, z: 0, r: 0.028, h: 0.3 },
    { x: 0, y: -0.072, z: 0, r: 0.028, h: 0.3 },
    { x: 0.06, y: -0.072, z: 0, r: 0.028, h: 0.3 },
  ],
};

/**
 * Engine mount layout per hull kind. Ships (nose = local +Z) exhaust straight
 * back (-Z); the capital hull fires DOWNWARD (-Y) from per-faction belly pods
 * (see `MOTHER_MOUNTS`) so flames land on each station's real engine geometry.
 */
function mountsFor(kind: ThrusterKind, fit: number, faction?: FactionId): Mount[] {
  if (kind === "mother_ship") {
    const dir = new THREE.Vector3(0, -1, 0);
    const layout = (faction && MOTHER_MOUNTS[faction]) || MOTHER_MOUNTS.scavengers;
    return layout.map((m) => ({
      pos: [m.x * fit, m.y * fit, m.z * fit] as [number, number, number],
      dir,
      radius: m.r * fit,
      height: m.h * fit,
    }));
  }
  if (kind === "fleet_unit") {
    const dir = new THREE.Vector3(0, 0, -1);
    return [{ pos: [0, 0, -fit * 0.5], dir, radius: fit * 0.13, height: fit * 0.7 }];
  }
  // fighter — twin rear engines
  const dir = new THREE.Vector3(0, 0, -1);
  const radius = fit * 0.06;
  const height = fit * 0.6;
  return [
    { pos: [-fit * 0.1, 0, -fit * 0.46], dir, radius, height },
    { pos: [fit * 0.1, 0, -fit * 0.46], dir, radius, height },
  ];
}

/**
 * Build the boosters for a ship and attach them to its outer `group`. The handle
 * is stored on `group.userData.thrusters` and read back by `updateThrusterSet`.
 */
export function attachThrusters(group: THREE.Group, opts: AttachOpts): void {
  const mats: THREE.ShaderMaterial[] = [];
  for (const m of mountsFor(opts.kind, opts.fitLen, opts.faction)) {
    // Open-ended cone, base shifted to the origin so the apex extends +Y; then
    // re-aimed down the exhaust direction. Per-instance geo + mat → safe to let
    // disposeGroup free them on teardown.
    // Built with extra headroom so an afterburner boost can extend the plume
    // past the speed-driven max into the unfilled tip (see BOOST_HEADROOM).
    const coneH = m.height * BOOST_HEADROOM;
    const geo = new THREE.ConeGeometry(m.radius, coneH, 14, 1, true);
    geo.translate(0, coneH / 2, 0);
    const mat = makeThrusterMaterial(opts.color);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.quaternion.setFromUnitVectors(UP, m.dir);
    mesh.position.set(m.pos[0], m.pos[1], m.pos[2]);
    mesh.renderOrder = 3;
    group.add(mesh);
    mats.push(mat);
  }
  const handle: ThrusterHandle = { mats, ref: opts.ref, cur: IDLE, boost: 0 };
  group.userData.thrusters = handle;
}

/**
 * Per-frame update: ramp the plume toward the ship's current throttle (speed /
 * ref) and advance the flicker clock. No-op for groups without boosters.
 *
 * `boost` drives a dedicated afterburner spike on TOP of the speed ramp: when
 * true the plume snaps longer/brighter (faster attack, gentle release); when
 * omitted (e.g. remote ships with no input on the wire) it is inferred from an
 * over-cap speed so dashing fleets still flare. Pass `false` to force the plain
 * speed-driven plume.
 */
export function updateThrusterSet(
  group: THREE.Object3D,
  speed: number,
  t: number,
  dt: number,
  boost?: boolean,
): void {
  const h = group.userData.thrusters as ThrusterHandle | undefined;
  if (!h) return;
  const throttle = Math.min(1.25, speed / h.ref);
  const target = Math.max(IDLE, throttle);
  h.cur += (target - h.cur) * Math.min(1, 9 * dt);
  // Explicit input wins; otherwise infer a dash from speed past the throttle cap.
  const boosting = boost ?? speed > h.ref * 1.06;
  const boostTarget = boosting ? 1 : 0;
  // Snappy attack so a dash flares instantly; slower release so it lingers.
  const boostRate = boosting ? 16 : 6;
  h.boost += (boostTarget - h.boost) * Math.min(1, boostRate * dt);
  for (const mat of h.mats) {
    mat.uniforms.uTime.value = t;
    mat.uniforms.uIntensity.value = h.cur;
    mat.uniforms.uBoost.value = h.boost;
  }
}
