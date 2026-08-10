/**
 * CarrierIntro — a disposable WebGL cinematic shown as the launch "load screen".
 *
 * It plays while the live CarrierGame connects underneath (so the network +
 * asset streaming happen in the background): the player's chosen mothership
 * arrives out of hyperspace — a tunnel of star streaks rushing past, a bright
 * flash on deceleration — and the camera then settles into a slow, faction-tinted
 * orbit that demonstrates the hull, its platform and its ring of turrets before
 * handing off to gameplay.
 *
 * Self-contained and disposable like the cabinet engines / MothershipShowcase: it
 * owns its renderer, scene, RAF loop and resize observer and tears them all down
 * in dispose(). Leaf packages can't cross-import the arcade three helpers, so the
 * clone/fit/dispose utilities are local (mirroring MothershipShowcase).
 *
 * Decoupled from the in-game ship rendering: it composes the mothership from the
 * same catalog data MothershipShowcase uses, and reads an OPTIONAL per-hull
 * `model` id off the mothership def if one is ever added — so distinct per-ship
 * hulls flow through automatically without editing this file.
 */
import * as THREE from "three";
import { loadAsset, type LoadedModel } from "@workspace/assets";
import { MOTHERSHIPS, type MothershipDef, type TurretMount } from "./motherships";

const PLATFORM_ID = "environment/carrier/cyberpunk-platform-b";
const DEFAULT_HULL_ID = "vehicles/space/carrier/spaceship";
const TURRET_IDS = [
  "props/carrier/turret-gun",
  "props/carrier/turret-cannon",
] as const;

/** Target longest-side fit (arbitrary preview units), matching the showcase. */
const PLATFORM_FIT = 60;
const HULL_FIT = 34;
const TURRET_FIT = 9;

/** Cinematic timeline (seconds). After DECEL the orbit runs indefinitely. */
const WARP_DUR = 1.5;
const DECEL_DUR = 1.0;
const ORBIT_START = WARP_DUR + DECEL_DUR;

/** Hyperspace tunnel tunables. */
const STREAK_COUNT = 720;
const TUNNEL_LEN = 2200;
const TUNNEL_RADIUS = 420;
const WARP_SPEED = 2100; // world units / second at full warp

/** Resolve the hull catalog id for a mothership def (forward-compatible). */
function hullIdFor(def: MothershipDef): string {
  const maybe = (def as { model?: unknown }).model;
  return typeof maybe === "string" && maybe.length > 0 ? maybe : DEFAULT_HULL_ID;
}

export interface CarrierIntroOpts {
  shipType: number;
  factionColor: string;
}

export class CarrierIntro {
  private readonly container: HTMLElement;
  private readonly opts: CarrierIntroOpts;
  private readonly def: MothershipDef;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly rig: THREE.Group;
  private readonly accentLightA: THREE.PointLight;
  private readonly accentLightB: THREE.PointLight;
  private readonly resizeObs: ResizeObserver;

  // Hyperspace tunnel (line streaks) + a soft warp flash sprite.
  private readonly streaks: THREE.LineSegments;
  private readonly streakAng: Float32Array;
  private readonly streakRad: Float32Array;
  private readonly streakZ: Float32Array;
  private readonly streakSpd: Float32Array;
  private readonly flash: THREE.Sprite;

  private composite: THREE.Group | null = null;
  private models: Record<string, LoadedModel> = {};

  private t = 0;
  private raf = 0;
  private disposed = false;
  private lastFrame = 0;

  // Orbit framing, derived from the hull scale once composed.
  private centerY = 6;
  private frameDist = 150;
  private orbitAzimuth = 0;

  constructor(container: HTMLElement, opts: CarrierIntroOpts) {
    this.container = container;
    this.opts = opts;
    this.def = MOTHERSHIPS[opts.shipType] ?? MOTHERSHIPS[0];

    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x02030a, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x02030a, 0.00035);

    this.camera = new THREE.PerspectiveCamera(95, w / h, 0.5, 6000);
    this.camera.position.set(0, 30, 600);
    this.camera.lookAt(0, 0, 0);

    this.rig = new THREE.Group();
    this.scene.add(this.rig);

    // Lighting: cool ambient + a warm key + two faction-tinted accent lights.
    this.scene.add(new THREE.AmbientLight(0x33507a, 1.0));
    const key = new THREE.DirectionalLight(0xcfe6ff, 1.5);
    key.position.set(40, 60, 50);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x8090ff, 0.45);
    fill.position.set(-50, 10, -30);
    this.scene.add(fill);

    const accent = new THREE.Color(opts.factionColor);
    this.accentLightA = new THREE.PointLight(accent.getHex(), 900, 600, 2);
    this.accentLightA.position.set(45, 24, 36);
    this.scene.add(this.accentLightA);
    this.accentLightB = new THREE.PointLight(accent.getHex(), 520, 600, 2);
    this.accentLightB.position.set(-45, -10, -24);
    this.scene.add(this.accentLightB);

    // Hyperspace streaks.
    this.streakAng = new Float32Array(STREAK_COUNT);
    this.streakRad = new Float32Array(STREAK_COUNT);
    this.streakZ = new Float32Array(STREAK_COUNT);
    this.streakSpd = new Float32Array(STREAK_COUNT);
    this.streaks = this.makeStreaks(accent);
    this.scene.add(this.streaks);

    // Warp flash — a camera-facing additive sprite scaled to fill the view.
    this.flash = this.makeFlash(accent);
    this.scene.add(this.flash);

    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(container);
  }

  /** Load the composition assets and build the mothership. Resolves when ready. */
  async init(): Promise<void> {
    const hullId = hullIdFor(this.def);
    const ids = [PLATFORM_ID, hullId, ...TURRET_IDS];
    const loaded = await Promise.all(
      ids.map(async (id) => {
        try {
          return [id, await loadAsset(id)] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );
    if (this.disposed) return;
    for (const [id, model] of loaded) if (model) this.models[id] = model;
    this.buildMothership(hullId);
  }

  start(): void {
    if (this.raf || this.disposed) return;
    this.lastFrame = performance.now();
    const loop = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.05, (now - this.lastFrame) * 0.001);
      this.lastFrame = now;
      this.update(dt);
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Seconds elapsed since the cinematic began animating. */
  get elapsed(): number {
    return this.t;
  }

  // --- per-frame -------------------------------------------------------------

  private update(dt: number): void {
    this.t += dt;
    const t = this.t;

    // Warp factor: 1 during warp, eased to 0 across the deceleration window.
    let warp: number;
    if (t <= WARP_DUR) warp = 1;
    else if (t <= ORBIT_START) warp = 1 - smoothstep((t - WARP_DUR) / DECEL_DUR);
    else warp = 0;

    this.updateStreaks(dt, warp);

    // Flash peaks right as the warp collapses, then fades fast.
    const flashT = clamp01((t - (WARP_DUR - 0.15)) / 0.18);
    const flashFade = clamp01(1 - (t - WARP_DUR) / 0.55);
    const flashAmt = Math.min(flashT, flashFade);
    (this.flash.material as THREE.SpriteMaterial).opacity = flashAmt * 0.9;
    this.flash.visible = flashAmt > 0.001;
    this.flash.position.copy(this.camera.position);
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    this.flash.position.addScaledVector(fwd, 40);
    this.flash.scale.setScalar(120);

    // Camera: a single spherical orbit rig. Azimuth holds during the warp
    // (camera dead-behind on +Z) then spins; distance + FOV ease into framing.
    const orbiting = t > ORBIT_START;
    if (orbiting) this.orbitAzimuth += dt * 0.22;
    const pitch = 0.26 + Math.sin(t * 0.22) * 0.14;

    const dist = lerpToward(
      this.camera.position.distanceTo(new THREE.Vector3(0, this.centerY, 0)),
      orbiting ? this.frameDist : 600 - smoothstep(t / ORBIT_START) * 200,
      Math.min(1, 2.4 * dt),
    );
    const cp = Math.cos(pitch);
    const center = new THREE.Vector3(0, this.centerY, 0);
    const desired = new THREE.Vector3(
      Math.sin(this.orbitAzimuth) * cp,
      Math.sin(pitch),
      Math.cos(this.orbitAzimuth) * cp,
    ).multiplyScalar(dist).add(center);
    this.camera.position.lerp(desired, Math.min(1, 3 * dt));
    this.camera.lookAt(center);

    const targetFov = orbiting ? 46 : 95 - smoothstep(t / ORBIT_START) * 30;
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, 4 * dt);
    this.camera.updateProjectionMatrix();

    // Gentle hull self-rotation + drifting accent light for life.
    if (this.composite) this.composite.rotation.y += dt * 0.06;
    this.accentLightA.position.x = Math.cos(t * 0.5) * 50;
    this.accentLightA.position.z = Math.sin(t * 0.5) * 50;
  }

  private updateStreaks(dt: number, warp: number): void {
    const pos = this.streaks.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const camZ = this.camera.position.z + 60;
    const move = WARP_SPEED * warp * dt;
    for (let i = 0; i < STREAK_COUNT; i++) {
      let z = this.streakZ[i] + move * this.streakSpd[i];
      if (z > camZ) {
        z = -TUNNEL_LEN + Math.random() * 120;
        this.streakAng[i] = Math.random() * Math.PI * 2;
        this.streakRad[i] = 14 + Math.random() * TUNNEL_RADIUS;
        this.streakSpd[i] = 0.6 + Math.random() * 0.9;
      }
      this.streakZ[i] = z;
      const c = Math.cos(this.streakAng[i]) * this.streakRad[i];
      const s = Math.sin(this.streakAng[i]) * this.streakRad[i];
      const len = 4 + 240 * warp * this.streakSpd[i];
      const o = i * 6;
      arr[o] = c; arr[o + 1] = s; arr[o + 2] = z;
      arr[o + 3] = c; arr[o + 4] = s; arr[o + 5] = z - len;
    }
    pos.needsUpdate = true;
    const mat = this.streaks.material as THREE.LineBasicMaterial;
    // Streaks blaze during warp, fade to faint static "stars" once orbiting.
    mat.opacity = 0.25 + 0.65 * warp;
  }

  // --- composition -----------------------------------------------------------

  private buildMothership(hullId: string): void {
    const def = this.def;
    const accent = new THREE.Color(def.accent);
    const group = new THREE.Group();

    const platform = this.cloneFit(PLATFORM_ID, PLATFORM_FIT, accent, 0.12);
    if (platform) {
      platform.scale.multiplyScalar(def.hullScale);
      group.add(platform);
    }
    const platformR = (PLATFORM_FIT * def.hullScale) / 2;

    const hull = this.cloneFit(hullId, HULL_FIT * def.hullScale, accent, 0.35);
    if (hull) {
      hull.position.y = 10 * def.hullScale;
      group.add(hull);
    }

    def.turrets.forEach((mount, i) => {
      const turret = this.cloneTurret(mount, accent);
      if (!turret) return;
      const ang = (i / Math.max(1, def.turrets.length)) * Math.PI * 2 + Math.PI / 4;
      const r = platformR * 0.62;
      turret.position.set(Math.cos(ang) * r, 3.5 * def.hullScale, Math.sin(ang) * r);
      group.add(turret);
    });

    if (group.children.length === 0) {
      group.add(makeFallbackHull(accent, def.hullScale));
    }

    this.composite = group;
    this.rig.add(group);

    // Frame the orbit around the assembled hull.
    this.centerY = 8 * def.hullScale;
    this.frameDist = Math.max(110, platformR * 3.1);
  }

  private cloneTurret(mount: TurretMount, accent: THREE.Color): THREE.Object3D | null {
    const tint =
      mount.role === "combat"
        ? new THREE.Color("#ff5d5d")
        : mount.role === "healing"
          ? new THREE.Color("#5dff9b")
          : accent;
    return this.cloneFit(mount.model, TURRET_FIT, tint, 0.5);
  }

  /** Clone a catalog model, recentre on the floor, fit to `fit`, tint emissive. */
  private cloneFit(
    id: string,
    fit: number,
    emissive: THREE.Color,
    emissiveStrength: number,
  ): THREE.Object3D | null {
    const model = this.models[id];
    if (!model) return null;
    const obj = model.scene.clone(true);
    obj.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const src = o.material;
        const tintMat = (m: THREE.Material): THREE.Material => {
          const c = m.clone();
          if (
            c instanceof THREE.MeshStandardMaterial ||
            c instanceof THREE.MeshPhysicalMaterial
          ) {
            c.emissive = emissive.clone();
            c.emissiveIntensity = emissiveStrength;
          }
          return c;
        };
        o.material = Array.isArray(src) ? src.map(tintMat) : tintMat(src);
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });
    fitObject(obj, fit);
    return obj;
  }

  // --- helpers ---------------------------------------------------------------

  private makeStreaks(accent: THREE.Color): THREE.LineSegments {
    const positions = new Float32Array(STREAK_COUNT * 2 * 3);
    for (let i = 0; i < STREAK_COUNT; i++) {
      this.streakAng[i] = Math.random() * Math.PI * 2;
      this.streakRad[i] = 14 + Math.random() * TUNNEL_RADIUS;
      this.streakZ[i] = -TUNNEL_LEN + Math.random() * TUNNEL_LEN;
      this.streakSpd[i] = 0.6 + Math.random() * 0.9;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const color = accent.clone().lerp(new THREE.Color(0xffffff), 0.55);
    const mat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    return new THREE.LineSegments(geo, mat);
  }

  private makeFlash(accent: THREE.Color): THREE.Sprite {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    const c = accent.clone().lerp(new THREE.Color(0xffffff), 0.7);
    const css = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
    grad.addColorStop(0, `rgba(255,255,255,1)`);
    grad.addColorStop(0.25, `rgba(${css},0.9)`);
    grad.addColorStop(1, `rgba(${css},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    sprite.renderOrder = 10;
    return sprite;
  }

  private onResize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObs.disconnect();
    if (this.composite) disposeGroup(this.composite);
    this.composite = null;
    this.streaks.geometry.dispose();
    (this.streaks.material as THREE.Material).dispose();
    const fm = this.flash.material as THREE.SpriteMaterial;
    fm.map?.dispose();
    fm.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}

// --- module helpers ---------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/** Frame-rate-independent ease of `a` toward `b` by factor k in [0,1]. */
function lerpToward(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/** Recentre an object on the floor (y=0) and scale so its longest side == fit. */
function fitObject(obj: THREE.Object3D, fit: number): void {
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const longest = Math.max(size.x, size.y, size.z) || 1;
  const scale = fit / longest;
  obj.scale.setScalar(scale);
  obj.position.x -= center.x * scale;
  obj.position.z -= center.z * scale;
  obj.position.y -= box.min.y * scale;
}

/** A procedural stand-in if no GLBs loaded (offline / missing assets). */
function makeFallbackHull(accent: THREE.Color, scale: number): THREE.Object3D {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.ConeGeometry(8 * scale, 30 * scale, 6),
    new THREE.MeshStandardMaterial({
      color: 0x223047,
      emissive: accent.clone(),
      emissiveIntensity: 0.4,
      metalness: 0.6,
      roughness: 0.4,
    }),
  );
  body.rotation.x = Math.PI / 2;
  g.add(body);
  return g;
}

function disposeGroup(g: THREE.Object3D): void {
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      (o.geometry as THREE.BufferGeometry)?.dispose?.();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
      else (m as THREE.Material)?.dispose?.();
    }
  });
}
