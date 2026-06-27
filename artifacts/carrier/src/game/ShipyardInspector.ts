/**
 * Carrier — Shipyard import/preview engine.
 *
 * A disposable Three.js turntable viewer for the "go ship by ship" import flow.
 * It mirrors {@link ModelInspector}'s scene/camera/IBL/grid/axes/frame/dispose
 * structure, but adds the one thing the dev inspector lacks: rendering a
 * USER-UPLOADED `.glb`/`.gltf` file (parsed from an object URL) right next to —
 * and through the *exact* same `autoOrientShip` / `fitObject` / `tintMetal` path
 * as — the in-game default for a chosen ship slot. So what you preview here is
 * what the ship will look like once the import is wired into the live render.
 *
 * Disposal note: catalog assets share geometry/textures with the `loadAsset`
 * session cache (never free those), but an IMPORTED scene's geometry is parsed
 * fresh and owned solely by this viewer, so it MUST be disposed on swap/teardown.
 * We track `currentImported` to free geometry only for imports.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { loadAsset, type LoadedModel } from "@workspace/assets";
import { type FactionId } from "@workspace/carrier-net";
import { autoOrientShip, fitObject, tintMetal } from "./modelFit";

/** A single ship "slot" the user can preview a default for and import into. */
export interface ShipSlot {
  /** Override storage key (real asset id for ships, primary part id for stations). */
  key: string;
  label: string;
  group: string;
  /** Longest-axis fit length (metres) — matches the live game for this slot. */
  fit: number;
  kind: "fighter" | "fleet" | "station";
  /** Asset ids to load for the DEFAULT (in-game) preview. */
  catalogIds: string[];
  /** Manual Y-rotation for ship hulls; omit to auto-orient nose → +Z. */
  yaw?: number;
  /** Station tint faction (stations carry their own colour). */
  faction?: FactionId;
}

/** Measured facts about whatever model is currently shown. */
export interface ModelStats {
  /** Triangle count across the whole model. */
  triangles: number;
  /** Native longest-axis size BEFORE the fit normalise (source units). */
  nativeSize: number;
  /** Fit length the model was normalised to (metres). */
  fit: number;
}

export type ShipyardState =
  | { status: "empty" }
  | { status: "loading"; source: "default" | "import" }
  | { status: "ready"; source: "default" | "import"; stats: ModelStats }
  | { status: "error"; message: string };

export class ShipyardInspector {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private clock = new THREE.Clock();
  private raf = 0;
  private disposed = false;

  private envMap: THREE.Texture;
  private turntable = new THREE.Group();
  private current: THREE.Object3D | null = null;
  private currentImported = false;
  private grid: THREE.GridHelper | null = null;
  private axes: THREE.AxesHelper | null = null;
  private loadToken = 0;

  private readonly gltf = new GLTFLoader();
  private tintFaction: FactionId = "scavengers";
  /** Re-show source so a faction/tint change re-issues the current view. */
  private lastSlot: ShipSlot | null = null;
  private lastFile: File | null = null;

  spin = true;

  constructor(container: HTMLElement, private onState: (s: ShipyardState) => void) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setClearColor(0x05070f, 1);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      50,
      container.clientWidth / container.clientHeight,
      0.1,
      20000,
    );
    this.camera.position.set(60, 40, 80);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.scene.add(this.turntable);

    this.scene.add(new THREE.HemisphereLight(0x99bbff, 0x0a0c18, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(1, 1.4, 0.8);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x4a82ff, 0.5);
    fill.position.set(-1, 0.4, -0.8);
    this.scene.add(fill);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envMap;
    pmrem.dispose();

    window.addEventListener("resize", this.onResize);
    this.loop();
  }

  setFaction(faction: FactionId): void {
    this.tintFaction = faction;
    // Re-issue the current view so the tint refreshes on one code path.
    if (this.lastFile && this.lastSlot) void this.showImported(this.lastFile, this.lastSlot);
    else if (this.lastSlot) this.showDefault(this.lastSlot);
  }

  setSpin(spin: boolean): void {
    this.spin = spin;
  }

  resetView(): void {
    if (this.current) this.frame(this.current);
  }

  /** Load + show the in-game DEFAULT model for a slot (catalog assets). */
  showDefault(slot: ShipSlot): void {
    this.lastSlot = slot;
    this.lastFile = null;
    const token = ++this.loadToken;
    this.onState({ status: "loading", source: "default" });

    Promise.all(slot.catalogIds.map((id) => loadAsset(id)))
      .then((models: LoadedModel[]) => {
        if (this.disposed || token !== this.loadToken) return;
        const built = this.buildCatalog(slot, models);
        this.swap(built, false);
        this.frame(built);
        this.onState({ status: "ready", source: "default", stats: this.measure(built, slot.fit) });
      })
      .catch((err) => {
        if (this.disposed || token !== this.loadToken) return;
        console.error("[carrier-shipyard] failed to load default", slot.key, err);
        this.onState({ status: "error", message: String(err?.message ?? err) });
      });
  }

  /**
   * Parse + show a user-uploaded GLB/glTF for a slot, oriented/tinted/fit exactly
   * like the default so the comparison is honest. The caller validates the file
   * (type/size) first. Resolves once shown (or rejects with a friendly message).
   */
  async showImported(file: File, slot: ShipSlot): Promise<void> {
    this.lastSlot = slot;
    this.lastFile = file;
    const token = ++this.loadToken;
    this.onState({ status: "loading", source: "import" });

    const url = URL.createObjectURL(file);
    try {
      let gltf;
      try {
        gltf = await this.gltf.loadAsync(url);
      } catch {
        throw new Error("Could not read that model — is it a valid GLB/glTF file?");
      }
      if (this.disposed || token !== this.loadToken) {
        disposeTree(gltf.scene, true);
        return;
      }
      const built = this.buildImported(gltf.scene, slot);
      this.swap(built, true);
      this.frame(built);
      this.onState({ status: "ready", source: "import", stats: this.measure(built, slot.fit) });
    } catch (err) {
      if (this.disposed || token !== this.loadToken) return;
      console.error("[carrier-shipyard] failed to import", err);
      const message = err instanceof Error ? err.message : String(err);
      this.onState({ status: "error", message });
      throw err instanceof Error ? err : new Error(message);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Assemble + orient + fit + tint a catalog asset the same way the game does. */
  private buildCatalog(slot: ShipSlot, models: LoadedModel[]): THREE.Object3D {
    if (slot.kind === "station") {
      const assembly = new THREE.Group();
      for (const m of models) assembly.add(m.scene.clone(true));
      tintMetal(assembly, slot.faction ?? "scavengers", true);
      fitObject(assembly, slot.fit);
      return assembly;
    }
    const clone = models[0].scene.clone(true);
    if (slot.yaw === undefined) autoOrientShip(clone);
    else clone.rotation.y = slot.yaw;
    tintMetal(clone, this.tintFaction, false);
    fitObject(clone, slot.fit);
    return clone;
  }

  /** Orient + fit + tint an imported scene through the same slot rules. */
  private buildImported(scene: THREE.Object3D, slot: ShipSlot): THREE.Object3D {
    // tintMetal REPLACES each mesh material with a fresh one (reusing only the
    // diffuse `map`), orphaning the source materials + their non-diffuse textures.
    // The whole import is owned by this viewer, so snapshot the originals BEFORE
    // the swap and stash them on the root for a complete teardown later.
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        materials.add(m);
        collectTextures(m, textures);
      }
    });
    scene.userData.importDisposables = { materials, textures };

    if (slot.kind === "station") {
      tintMetal(scene, slot.faction ?? "scavengers", true);
    } else {
      if (slot.yaw === undefined) autoOrientShip(scene);
      else scene.rotation.y = slot.yaw;
      tintMetal(scene, this.tintFaction, false);
    }
    // tintMetal flags meshes sharedGeo (true for catalog clones); an imported
    // scene owns its geometry, so clear the flag for honest disposal bookkeeping.
    scene.traverse((o) => { if (o instanceof THREE.Mesh) o.userData.sharedGeo = false; });
    fitObject(scene, slot.fit);
    return scene;
  }

  /** Measure triangle count + native longest-axis (pre-fit) of a built model. */
  private measure(obj: THREE.Object3D, fit: number): ModelStats {
    let triangles = 0;
    obj.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const g = o.geometry as THREE.BufferGeometry;
      const idx = g.getIndex();
      const pos = g.getAttribute("position");
      if (idx) triangles += idx.count / 3;
      else if (pos) triangles += pos.count / 3;
    });
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    box.getSize(size);
    // The model is already fit-normalised, so its longest axis ≈ fit; report the
    // fit as nativeSize-after-fit for context (pre-fit native size isn't kept).
    const nativeSize = Math.max(size.x, size.y, size.z) || fit;
    return { triangles: Math.round(triangles), nativeSize, fit };
  }

  /** Replace the turntable's model + rebuild the size-matched grid/axes. */
  private swap(obj: THREE.Object3D, imported: boolean): void {
    if (this.current) {
      this.turntable.remove(this.current);
      disposeTree(this.current, this.currentImported);
      this.current = null;
    }
    this.turntable.rotation.y = 0;
    this.turntable.add(obj);
    this.current = obj;
    this.currentImported = imported;

    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    box.getSize(size);
    const span = Math.max(size.x, size.z) || 1;
    const groundY = box.min.y;

    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); (this.grid.material as THREE.Material).dispose(); }
    this.grid = new THREE.GridHelper(span * 2.2, 22, 0x3a6ea5, 0x18324f);
    this.grid.position.y = groundY * 1.001;
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.6;
    this.scene.add(this.grid);

    if (this.axes) { this.scene.remove(this.axes); this.axes.geometry.dispose(); (this.axes.material as THREE.Material).dispose(); }
    // +Z (blue) is the canonical nose direction — line it up with the grid.
    this.axes = new THREE.AxesHelper(span * 0.85);
    this.axes.position.y = groundY * 1.001;
    this.scene.add(this.axes);
  }

  /** Frame the orbit camera to fit the model's bounding sphere. */
  private frame(obj: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(obj);
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    const r = sphere.radius || 1;
    const dist = r * 2.6;
    this.controls.target.copy(sphere.center);
    this.camera.position.set(
      sphere.center.x + dist * 0.6,
      sphere.center.y + dist * 0.45,
      sphere.center.z + dist * 0.85,
    );
    this.camera.near = Math.max(0.05, r * 0.02);
    this.camera.far = r * 60;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = this.clock.getDelta();
    if (this.spin) this.turntable.rotation.y += dt * 0.4;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private onResize = (): void => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onResize);
    this.controls.dispose();
    if (this.current) disposeTree(this.current, this.currentImported);
    if (this.grid) { this.grid.geometry.dispose(); (this.grid.material as THREE.Material).dispose(); }
    if (this.axes) { this.axes.geometry.dispose(); (this.axes.material as THREE.Material).dispose(); }
    this.envMap.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/** Every texture-bearing slot on a standard/physical material we might own. */
const TEXTURE_SLOTS = [
  "map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap",
  "bumpMap", "displacementMap", "alphaMap", "lightMap", "specularMap",
  "clearcoatMap", "clearcoatNormalMap", "clearcoatRoughnessMap",
  "sheenColorMap", "sheenRoughnessMap", "transmissionMap", "thicknessMap",
  "iridescenceMap", "iridescenceThicknessMap", "anisotropyMap",
] as const;

/** Collect all bound textures across a material's known slots into `out`. */
function collectTextures(m: THREE.Material, out: Set<THREE.Texture>): void {
  const any = m as unknown as Record<string, unknown>;
  for (const slot of TEXTURE_SLOTS) {
    const tex = any[slot];
    if (tex instanceof THREE.Texture) out.add(tex);
  }
}

/**
 * Dispose a built model. Materials are always owned (freshly built by tintMetal).
 * Geometry/textures are freed only for IMPORTED models — catalog clones share the
 * `loadAsset` session cache and must never have their geometry/textures disposed.
 *
 * For imports this disposes: the current (tinted) materials AND their textures,
 * the geometry, and — via `userData.importDisposables` stashed in `buildImported`
 * — the original glTF materials + every texture they referenced (tintMetal only
 * carried `map` forward). It also handles the pre-build cancel path where the raw
 * glTF scene still wears its source materials. Texture.dispose() is idempotent so
 * the shared diffuse `map` being freed twice is harmless.
 */
function disposeTree(root: THREE.Object3D, includeGeometry: boolean): void {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (includeGeometry) {
        const owned = new Set<THREE.Texture>();
        collectTextures(m, owned);
        for (const t of owned) t.dispose();
      }
      m.dispose();
    }
    if (includeGeometry) o.geometry.dispose();
  });

  if (includeGeometry) {
    const stash = root.userData.importDisposables as
      | { materials: Set<THREE.Material>; textures: Set<THREE.Texture> }
      | undefined;
    if (stash) {
      for (const t of stash.textures) t.dispose();
      for (const m of stash.materials) m.dispose();
      delete root.userData.importDisposables;
    }
  }
}
