/**
 * Mesh-based effects that aren't particle systems: the spline beam, the
 * force-push shockwave, and the swept weapon-trail ribbon. Each exposes a
 * {@link LiveMesh} the {@link VfxManager} ticks every frame and disposes when
 * done; beams and trails additionally return a caller-driven handle. Everything
 * is plain Three.js (no GL needed at construction), so it is headless-safe.
 */
import * as THREE from "three";

/** A self-managing mesh effect the manager updates and reaps. */
export interface LiveMesh {
  root: THREE.Object3D;
  /** Advance; return false when finished (the manager then disposes it). */
  update(dt: number): boolean;
  /** Swap in the sprite texture once it has finished loading (optional). */
  setMap?(tex: THREE.Texture | null): void;
  dispose(): void;
}

export interface BeamOptions {
  color?: THREE.ColorRepresentation;
  thickness?: number;
  /** Scroll speed of the texture along the beam (default 3). */
  scroll?: number;
  /** Seconds to fade out after `stop()` (default 0.15). */
  fade?: number;
}

/** Handle to a live beam; reposition its endpoints each frame, then `stop()`. */
export interface BeamHandle {
  setEndpoints(from: THREE.Vector3, to: THREE.Vector3): BeamHandle;
  stop(): void;
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * A glowing beam between two points: two crossed, additive, texture-scrolled
 * quads spanning local +Y (0..1), oriented and scaled onto the segment. Good for
 * laser/lightning/magic beams ("spline animated effects").
 */
export function createBeam(
  tex: THREE.Texture | null,
  from: THREE.Vector3,
  to: THREE.Vector3,
  opts: BeamOptions = {},
): { mesh: LiveMesh; handle: BeamHandle } {
  const thickness = opts.thickness ?? 0.25;
  const scroll = opts.scroll ?? 3;
  const fadeTime = opts.fade ?? 0.15;

  const mat = new THREE.MeshBasicMaterial({
    map: null,
    color: new THREE.Color(opts.color ?? 0xffffff),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  let map: THREE.Texture | null = null;
  const setMap = (t: THREE.Texture | null) => {
    map?.dispose();
    map = t ? t.clone() : null;
    if (map) {
      map.wrapT = THREE.RepeatWrapping;
      map.needsUpdate = true;
    }
    mat.map = map;
    mat.needsUpdate = true;
  };
  setMap(tex);

  // Unit quad spanning Y 0..1, width on X.
  const makeQuad = () => {
    const g = new THREE.PlaneGeometry(1, 1);
    g.translate(0, 0.5, 0);
    return new THREE.Mesh(g, mat);
  };
  const a = makeQuad();
  const b = makeQuad();
  b.rotation.y = Math.PI / 2;

  const root = new THREE.Group();
  root.add(a, b);

  let stopping = false;
  let fade = 0;
  const baseColor = new THREE.Color(opts.color ?? 0xffffff);

  const apply = (f: THREE.Vector3, t: THREE.Vector3) => {
    const dir = t.clone().sub(f);
    const len = dir.length();
    root.position.copy(f);
    if (len > 1e-4) {
      root.quaternion.setFromUnitVectors(UP, dir.clone().normalize());
      root.scale.set(thickness, len, 1);
      map?.repeat.set(1, Math.max(1, len / Math.max(thickness, 0.01) / 4));
    }
  };
  apply(from, to);

  const mesh: LiveMesh = {
    root,
    update(dt) {
      if (map) map.offset.y -= scroll * dt;
      if (stopping) {
        fade += dt;
        const k = Math.max(0, 1 - fade / fadeTime);
        mat.color.setRGB(baseColor.r * k, baseColor.g * k, baseColor.b * k);
        if (fade >= fadeTime) return false;
      }
      return true;
    },
    setMap,
    dispose() {
      a.geometry.dispose();
      b.geometry.dispose();
      mat.dispose();
      map?.dispose();
      root.parent?.remove(root);
    },
  };

  const handle: BeamHandle = {
    setEndpoints(f, t) {
      if (!stopping) apply(f, t);
      return handle;
    },
    stop() {
      stopping = true;
    },
  };
  return { mesh, handle };
}

export interface ShockwaveOptions {
  color?: THREE.ColorRepresentation;
  /** Final radius (default 3). */
  radius?: number;
  /** Lifetime seconds (default 0.45). */
  duration?: number;
  /** Plane normal (default world up — a ground ring). */
  normal?: THREE.Vector3;
}

/**
 * An expanding, fading ring that bursts outward from an impact — the visual for
 * a knockback / force-push.
 */
export function createShockwave(
  tex: THREE.Texture | null,
  position: THREE.Vector3,
  opts: ShockwaveOptions = {},
): LiveMesh {
  const radius = opts.radius ?? 3;
  const duration = opts.duration ?? 0.45;
  const baseColor = new THREE.Color(opts.color ?? 0xffffff);

  const geo = new THREE.RingGeometry(0.35, 0.5, 48);
  const mat = new THREE.MeshBasicMaterial({
    map: tex ?? null,
    color: baseColor.clone(),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(position);
  const normal = (opts.normal ?? UP).clone().normalize();
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);

  let age = 0;
  return {
    root: mesh,
    update(dt) {
      age += dt;
      const t = age / duration;
      if (t >= 1) return false;
      const s = 0.3 + radius * t;
      mesh.scale.set(s, s, s);
      const k = 1 - t;
      mat.color.setRGB(baseColor.r * k, baseColor.g * k, baseColor.b * k);
      return true;
    },
    setMap(t) {
      mat.map = t;
      mat.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      mesh.parent?.remove(mesh);
    },
  };
}

export interface TrailOptions {
  color?: THREE.ColorRepresentation;
  /** How long a sample lives before fading out (default 0.18s). */
  duration?: number;
  /** Max retained samples (default 24). */
  segments?: number;
}

/** Handle for a weapon trail; push the blade's two ends each frame, then stop. */
export interface TrailHandle {
  /** Add the current blade span (tip & base) to the swept ribbon. */
  push(tip: THREE.Vector3, base: THREE.Vector3): TrailHandle;
  stop(): void;
}

interface TrailSample {
  tip: THREE.Vector3;
  base: THREE.Vector3;
  age: number;
}

/**
 * A swept ribbon connecting successive blade spans — the classic melee weapon
 * trail. Fade is baked into per-vertex colour so additive blending makes older
 * segments vanish. Caller pushes (tip, base) each frame and `stop()`s on release.
 */
export function createWeaponTrail(
  tex: THREE.Texture | null,
  opts: TrailOptions = {},
): { mesh: LiveMesh; handle: TrailHandle } {
  const duration = opts.duration ?? 0.18;
  const maxSamples = opts.segments ?? 24;
  const color = new THREE.Color(opts.color ?? 0xffffff);

  const samples: TrailSample[] = [];
  let stopping = false;

  const geo = new THREE.BufferGeometry();
  const cap = maxSamples * 2;
  const positions = new Float32Array(cap * 3);
  const colors = new Float32Array(cap * 3);
  const uvs = new Float32Array(cap * 2);
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setDrawRange(0, 0);

  const mat = new THREE.MeshBasicMaterial({
    map: tex ?? null,
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;

  const rebuild = () => {
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const k = Math.max(0, 1 - s.age / duration); // newest=1, oldest=0
      const head = (n - 1 - i) / Math.max(1, n - 1); // along strip for UV
      const o = i * 2;
      positions[o * 3] = s.tip.x;
      positions[o * 3 + 1] = s.tip.y;
      positions[o * 3 + 2] = s.tip.z;
      positions[(o + 1) * 3] = s.base.x;
      positions[(o + 1) * 3 + 1] = s.base.y;
      positions[(o + 1) * 3 + 2] = s.base.z;
      colors[o * 3] = color.r * k;
      colors[o * 3 + 1] = color.g * k;
      colors[o * 3 + 2] = color.b * k;
      colors[(o + 1) * 3] = color.r * k;
      colors[(o + 1) * 3 + 1] = color.g * k;
      colors[(o + 1) * 3 + 2] = color.b * k;
      uvs[o * 2] = head;
      uvs[o * 2 + 1] = 1;
      uvs[(o + 1) * 2] = head;
      uvs[(o + 1) * 2 + 1] = 0;
    }
    geo.setDrawRange(0, n * 2);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.attributes.uv.needsUpdate = true;
  };

  const mesh_: LiveMesh = {
    root: mesh,
    update(dt) {
      for (const s of samples) s.age += dt;
      while (samples.length && samples[0].age >= duration) samples.shift();
      rebuild();
      if (stopping && samples.length === 0) return false;
      return true;
    },
    setMap(t) {
      mat.map = t;
      mat.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      mesh.parent?.remove(mesh);
    },
  };

  const handle: TrailHandle = {
    push(tip, base) {
      if (stopping) return handle;
      samples.push({ tip: tip.clone(), base: base.clone(), age: 0 });
      if (samples.length > maxSamples) samples.shift();
      return handle;
    },
    stop() {
      stopping = true;
    },
  };
  return { mesh: mesh_, handle };
}
