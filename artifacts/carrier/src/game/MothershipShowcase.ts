/**
 * MothershipShowcase — a disposable WebGL preview for the hangar select screen.
 *
 * Composes each mothership from real catalog assets: the class's OWN distinct
 * hull GLB `def.hull` is the HERO (largest), floating above a SMALLER platform
 * base, ringed by TINY turret fixtures. Hulls keep their real GLB textures/PBR
 * lit by a neutral studio IBL (RoomEnvironment), with only a subtle muted faction
 * accent as emissive trim + rim-glow point lights — no flat neon wash. The camera
 * frames the whole composite, which slowly auto-rotates.
 *
 * Self-contained and disposable like the cabinet engines: it owns its renderer,
 * scene, RAF loop, env map, and resize observer, and tears them all down in
 * dispose(). It CANNOT import the arcade's three helpers (leaf packages can't
 * cross-import), so the clone/fit/dispose utilities are local.
 *
 * `select(def, accent)` swaps the displayed mothership. `replaceSlot(slot, file)`
 * hot-swaps any composing asset (hull/platform/turret) with a user-uploaded GLB
 * and live-rebuilds. Uploads are validated then PERSISTED per-device (IndexedDB,
 * keyed by the replaced asset id) via shipModelStore, and reapplied on the next
 * visit through `loadPersistedOverrides()`, so custom ship models survive a
 * refresh. `resetSlot(slot)` removes an override and deletes its saved copy.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { loadAsset, type LoadedModel } from "@workspace/assets";
import { MOTHERSHIPS, type MothershipDef, type TurretMount } from "./motherships";
import {
  validateModelFile,
  saveOverride,
  loadOverrides,
  deleteOverride,
  ModelValidationError,
} from "./shipModelStore";

const PLATFORM_ID = "environment/carrier/cyberpunk-platform-b";
const TURRET_GUN_ID = "props/carrier/turret-gun";
const TURRET_CANNON_ID = "props/carrier/turret-cannon";
/** Distinct per-class hull GLBs (one per mothership), deduped. */
const HULL_IDS = [...new Set(MOTHERSHIPS.map((m) => m.hull))];
const TURRET_IDS = [TURRET_GUN_ID, TURRET_CANNON_ID] as const;

/**
 * Target longest-side fits (arbitrary preview units). The HULL is the hero, the
 * platform a clearly smaller base beneath it, and turrets tiny rim fixtures.
 */
const HULL_FIT = 58;
// The hull is a city-sized mothership; the platform base + turrets are tiny
// fixtures beside it (was 26 / 5 — that read ~100x too large vs the hull).
const PLATFORM_FIT = 6;
const TURRET_FIT = 1.2;

/** Which composing asset a user upload replaces. */
export type ShowcaseSlot = "hull" | "platform" | "turret-gun" | "turret-cannon";

export class MothershipShowcase {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly rig: THREE.Group;
  private readonly stars: THREE.Points;
  private readonly accentLightA: THREE.PointLight;
  private readonly accentLightB: THREE.PointLight;
  private readonly resizeObs: ResizeObserver;
  private readonly loader = new GLTFLoader();
  private envMap: THREE.Texture | null = null;

  private composite: THREE.Group | null = null;
  private models: Record<string, LoadedModel> = {};
  /** User-uploaded replacement scenes by asset id (owned; fully disposed). */
  private overrides: Record<string, THREE.Object3D> = {};
  /** The currently displayed selection, so uploads can rebuild in place. */
  private current: { def: MothershipDef; accent: string } | null = null;
  private ready = false;
  private raf = 0;
  private disposed = false;
  private spin = 0;
  private orbitRadius = 60;

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth || 1, container.clientHeight || 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      42,
      (container.clientWidth || 1) / (container.clientHeight || 1),
      0.1,
      4000,
    );
    this.camera.position.set(0, 26, 96);
    this.camera.lookAt(0, 0, 0);

    this.rig = new THREE.Group();
    this.scene.add(this.rig);

    // Neutral studio IBL so the real GLB metal/PBR catches reflections instead of
    // reading as a flat tinted wash (mirrors the live game + dev inspector).
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envMap;
    pmrem.dispose();

    // Lighting: cool ambient, a warm key + fill, and two accent point lights
    // recoloured per selection for a SUBTLE muted faction rim glow.
    this.scene.add(new THREE.HemisphereLight(0x9bb6ff, 0x0a0c18, 0.55));
    const key = new THREE.DirectionalLight(0xcfe6ff, 1.25);
    key.position.set(40, 60, 50);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x8090ff, 0.45);
    fill.position.set(-50, 10, -30);
    this.scene.add(fill);

    this.accentLightA = new THREE.PointLight(0x6c8bb0, 900, 600, 2);
    this.accentLightA.position.set(40, 24, 36);
    this.scene.add(this.accentLightA);
    this.accentLightB = new THREE.PointLight(0x6c8bb0, 500, 600, 2);
    this.accentLightB.position.set(-40, -10, -24);
    this.scene.add(this.accentLightB);

    this.stars = makeStarfield();
    this.scene.add(this.stars);

    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(container);
  }

  /** Load the shared composition assets. Safe to call once; resolves when ready. */
  async init(): Promise<void> {
    const ids = [PLATFORM_ID, ...HULL_IDS, ...TURRET_IDS];
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
    for (const [id, model] of loaded) {
      if (model) this.models[id] = model;
    }
    this.ready = true;
  }

  start(): void {
    if (this.raf) return;
    const loop = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      this.spin += 0.0032;
      this.rig.rotation.y = this.spin;
      this.stars.rotation.y -= 0.0004;
      const t = performance.now() * 0.001;
      const r = this.orbitRadius;
      this.accentLightA.position.x = Math.cos(t * 0.6) * r;
      this.accentLightA.position.z = Math.sin(t * 0.6) * r;
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /**
   * Swap the displayed mothership (rebuilds the composite from its loadout).
   * `accent` is the MUTED faction accent used for the rim-glow lights + subtle
   * emissive trim, so switching faction visibly refreshes the showcase even when
   * the same hull stays selected.
   */
  select(def: MothershipDef, accent?: string): void {
    if (this.disposed) return;
    this.current = { def, accent: accent ?? def.accent };
    this.rebuild();
  }

  /**
   * Hot-swap a composing asset with a user-uploaded GLB and rebuild in place.
   * The upload is validated (type/size), shown immediately, AND persisted
   * per-device (keyed by the replaced asset id) so it survives a refresh.
   * Resolves once the new asset is loaded + shown. Throws a
   * {@link ModelValidationError} for a bad file, or an Error if the GLB can't be
   * parsed — callers should surface `err.message` to the user.
   */
  async replaceSlot(slot: ShowcaseSlot, file: File): Promise<void> {
    if (this.disposed || !this.current) return;
    validateModelFile(file); // throws ModelValidationError before any work
    const id = this.slotId(slot);
    const url = URL.createObjectURL(file);
    try {
      let gltf;
      try {
        gltf = await this.loader.loadAsync(url);
      } catch {
        throw new Error("Could not read that model — is it a valid GLB/glTF file?");
      }
      if (this.disposed) {
        disposeOwned(gltf.scene);
        return;
      }
      const prev = this.overrides[id];
      this.overrides[id] = gltf.scene;
      this.rebuild();
      if (prev) disposeOwned(prev);
    } finally {
      URL.revokeObjectURL(url);
    }
    // Persist last (best-effort) so a storage hiccup never blocks the live swap.
    await saveOverride(id, file);
  }

  /**
   * Reapply any persisted overrides saved on a previous visit. Loads each stored
   * GLB blob, installs it as an override, and rebuilds once. Safe no-op if none
   * are saved or storage is unavailable. Call after `select()` so the composite
   * exists to rebuild.
   */
  async loadPersistedOverrides(): Promise<void> {
    if (this.disposed) return;
    const stored = await loadOverrides();
    if (this.disposed || stored.length === 0) return;
    let changed = false;
    for (const rec of stored) {
      const url = URL.createObjectURL(rec.blob);
      try {
        const gltf = await this.loader.loadAsync(url);
        if (this.disposed) {
          disposeOwned(gltf.scene);
          return;
        }
        const prev = this.overrides[rec.id];
        this.overrides[rec.id] = gltf.scene;
        if (prev) disposeOwned(prev);
        changed = true;
      } catch {
        // Corrupt stored blob — drop it so it can't wedge future loads.
        void deleteOverride(rec.id);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    if (changed && this.current) this.rebuild();
  }

  /**
   * Remove a slot's override (in-memory + persisted) and revert to the catalog
   * default, rebuilding in place. No-op if the slot has no override.
   */
  async resetSlot(slot: ShowcaseSlot): Promise<void> {
    if (this.disposed) return;
    const id = this.slotId(slot);
    const prev = this.overrides[id];
    if (prev) {
      delete this.overrides[id];
      this.rebuild();
      disposeOwned(prev);
    }
    await deleteOverride(id);
  }

  /** Whether the given slot currently has a user override applied. */
  hasOverride(slot: ShowcaseSlot): boolean {
    return !!this.overrides[this.slotId(slot)];
  }

  /** Resolve the catalog/override asset id backing a swappable slot. */
  private slotId(slot: ShowcaseSlot): string {
    switch (slot) {
      case "hull":
        return this.current?.def.hull ?? HULL_IDS[0];
      case "platform":
        return PLATFORM_ID;
      case "turret-gun":
        return TURRET_GUN_ID;
      case "turret-cannon":
        return TURRET_CANNON_ID;
    }
  }

  // --- composition ----------------------------------------------------------

  private rebuild(): void {
    if (!this.current) return;
    const { def } = this.current;
    const accent = new THREE.Color(this.current.accent);
    this.accentLightA.color.copy(accent).lerp(new THREE.Color(0xffffff), 0.25);
    this.accentLightB.color.copy(accent).lerp(new THREE.Color(0xffffff), 0.25);

    if (this.composite) {
      this.rig.remove(this.composite);
      disposeComposite(this.composite);
      this.composite = null;
    }
    this.spin = 0;
    this.rig.rotation.y = 0;

    const group = new THREE.Group();

    // Smaller platform base, sitting on the floor (y=0).
    let platformTop = 0;
    const platform = this.cloneFit(PLATFORM_ID, PLATFORM_FIT * def.hullScale, accent, 0.16);
    if (platform) {
      group.add(platform);
      platform.updateMatrixWorld(true);
      platformTop = new THREE.Box3().setFromObject(platform).max.y;
    }
    const platformR = (PLATFORM_FIT * def.hullScale) / 2;

    // Hull — the HERO — floating above the platform. Each class has its OWN hull.
    const hull = this.cloneFit(def.hull, HULL_FIT * def.hullScale, accent, 0.12);
    if (hull) {
      hull.position.y += platformTop + HULL_FIT * def.hullScale * 0.12;
      group.add(hull);
    }

    // Tiny turret fixtures arranged around the platform rim.
    const mounts = def.turrets;
    mounts.forEach((mount, i) => {
      const turret = this.cloneTurret(mount, def.hullScale);
      if (!turret) return;
      const ang = (i / Math.max(1, mounts.length)) * Math.PI * 2 + Math.PI / 4;
      const r = platformR * 0.72;
      turret.position.set(Math.cos(ang) * r, platformTop, Math.sin(ang) * r);
      group.add(turret);
    });

    if (group.children.length === 0) {
      group.add(makeFallbackHull(accent, def.hullScale));
    }

    // Recentre the composite on the origin so it frames + spins cleanly, then
    // frame the camera to the whole bounding sphere (hull stays the focus).
    group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    group.position.sub(center);

    const radius = 0.5 * Math.hypot(size.x, size.y, size.z) || 40;
    this.orbitRadius = radius * 1.05;
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (radius / Math.sin(fov / 2)) * 1.12;
    this.camera.position.set(0, radius * 0.4, dist);
    this.camera.lookAt(0, 0, 0);
    this.accentLightA.position.set(this.orbitRadius, radius * 0.5, this.orbitRadius);
    this.accentLightB.position.set(-this.orbitRadius, -radius * 0.3, -this.orbitRadius);

    this.composite = group;
    this.rig.add(group);
  }

  private cloneTurret(mount: TurretMount, hullScale: number): THREE.Object3D | null {
    // Resource/healing turrets glow in a muted green, combat in a muted red.
    const tint =
      mount.role === "combat"
        ? new THREE.Color("#b85c52")
        : mount.role === "healing"
          ? new THREE.Color("#6caa86")
          : new THREE.Color("#6c8bb0");
    return this.cloneFit(mount.model, TURRET_FIT * hullScale, tint, 0.28);
  }

  /** Resolve a model's source scene (user override first, then catalog). */
  private sourceScene(id: string): THREE.Object3D | null {
    return this.overrides[id] ?? this.models[id]?.scene ?? null;
  }

  /**
   * Clone a catalog/override model, keep its real GLB textures + PBR, add a
   * subtle muted-accent emissive trim, recentre on the floor, and fit to `fit`.
   * Clones SHARE geometry with their source, so meshes are flagged `sharedGeo`
   * (disposal frees only the freshly-built per-clone materials).
   */
  private cloneFit(
    id: string,
    fit: number,
    accent: THREE.Color,
    emissiveStrength: number,
  ): THREE.Object3D | null {
    const src = this.sourceScene(id);
    if (!src) return null;
    const obj = src.clone(true);

    obj.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.userData.sharedGeo = true;
        const hasUV = !!o.geometry.getAttribute("uv");
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const next = mats.map((mm) => {
          const base = mm as THREE.MeshStandardMaterial;
          const map = hasUV ? base.map ?? null : null;
          return new THREE.MeshStandardMaterial({
            map,
            color: map ? 0xffffff : 0x6b7480,
            metalness: 0.9,
            roughness: 0.45,
            emissive: accent.clone(),
            emissiveIntensity: emissiveStrength,
            envMapIntensity: 1.1,
          });
        });
        o.material = Array.isArray(o.material) ? next : next[0];
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });

    fitObject(obj, fit);
    return obj;
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
    if (this.composite) disposeComposite(this.composite);
    this.composite = null;
    for (const id of Object.keys(this.overrides)) disposeOwned(this.overrides[id]);
    this.overrides = {};
    (this.stars.geometry as THREE.BufferGeometry).dispose();
    (this.stars.material as THREE.Material).dispose();
    this.envMap?.dispose();
    this.envMap = null;
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }

  get isReady(): boolean {
    return this.ready;
  }
}

// --- module helpers ---------------------------------------------------------

/** Recentre an object on the floor (y=0) and scale so its longest side == fit. */
function fitObject(obj: THREE.Object3D, fit: number): void {
  // Refresh the FULL subtree's world matrices first. Box3.setFromObject only
  // updates the root's matrix, not descendants — so a freshly-cloned model whose
  // child node carries a baked scale (e.g. the platform GLB's Platform_4x4 at
  // scale 100) would otherwise be measured at its raw, unscaled size, computing
  // a wildly oversized fit factor that the baked scale then multiplies again.
  obj.updateMatrixWorld(true);
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

function makeStarfield(): THREE.Points {
  const count = 1200;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 600 + Math.random() * 1400;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0x9fc4ff,
    size: 2.4,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.8,
  });
  return new THREE.Points(geo, mat);
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

/**
 * Dispose a built composite. Its meshes are clones whose geometry is SHARED with
 * the catalog cache / override template (`sharedGeo`), so only the owned,
 * freshly-built per-clone materials are freed — never the shared geometry.
 */
function disposeComposite(g: THREE.Object3D): void {
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      if (!o.userData.sharedGeo) (o.geometry as THREE.BufferGeometry)?.dispose?.();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
      else (m as THREE.Material)?.dispose?.();
    }
  });
}

/** Fully dispose an OWNED scene (an uploaded override template) — geo + mats. */
function disposeOwned(g: THREE.Object3D): void {
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      (o.geometry as THREE.BufferGeometry)?.dispose?.();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
      else (m as THREE.Material)?.dispose?.();
    }
  });
}
