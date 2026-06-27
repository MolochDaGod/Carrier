/**
 * Carrier — dev-only model inspector engine.
 *
 * A tiny disposable Three.js viewer that renders a single ship / station asset
 * on a turntable with a ground grid + axes for orientation reference. It reuses
 * the *exact* `autoOrientShip` / `fitObject` / `tintMetal` helpers the live game
 * uses (see `./modelFit`) and reads asset ids / `yaw` / `fitMul` straight from
 * `./factionAssets`, so what you see here matches the in-game render.
 *
 * Not shipped to production — the only route that mounts this is gated behind
 * `import.meta.env.DEV` in `main.tsx`, so the whole module tree-shakes out of a
 * production build.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { loadAsset, type LoadedModel } from "@workspace/assets";
import { type FactionId } from "@workspace/carrier-net";
import { autoOrientShip, fitObject, tintMetal } from "./modelFit";
import type { ShipModel, StationModel } from "./factionAssets";

/** One selectable asset in the inspector. */
export type InspectItem =
  | { kind: "fighter" | "fleet"; id: string; label: string; group: string; fit: number; model: ShipModel }
  | { kind: "station"; id: string; label: string; group: string; fit: number; faction: FactionId; def: StationModel };

export class ModelInspector {
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
  private grid: THREE.GridHelper | null = null;
  private axes: THREE.AxesHelper | null = null;
  private loadToken = 0;

  /** Faction tint applied to fighter/fleet hulls (stations carry their own). */
  private tintFaction: FactionId = "scavengers";
  private lastItem: InspectItem | null = null;
  private lastLineup: InspectItem[] | null = null;

  /** Whether the turntable auto-rotates the model. */
  spin = true;

  constructor(container: HTMLElement, private onState: (s: InspectorState) => void) {
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

    // Lighting + neutral studio IBL so PBR metal catches reflections, exactly
    // like the live scene (the game uses the same RoomEnvironment env map).
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

  /**
   * Set the faction tint for fighter/fleet hulls (stations carry their own).
   * Pure setter — the page re-issues `show()`/`showLineup()` to apply it, which
   * keeps single- and lineup-mode rebuilds on one code path.
   */
  setFaction(faction: FactionId): void {
    this.tintFaction = faction;
  }

  setSpin(spin: boolean): void {
    this.spin = spin;
  }

  /** Reset the orbit camera framing for the current model. */
  resetView(): void {
    if (this.current) this.frame(this.current);
  }

  /** Load + display one asset, replacing whatever was shown before. */
  show(item: InspectItem): void {
    this.lastItem = item;
    this.lastLineup = null;
    const token = ++this.loadToken;
    this.onState({ status: "loading", item });

    const ids = item.kind === "station" ? item.def.parts : [item.model.id];
    Promise.all(ids.map((id) => loadAsset(id)))
      .then((models: LoadedModel[]) => {
        if (this.disposed || token !== this.loadToken) return;
        const built = this.build(item, models);
        this.swap(built);
        this.frame(built);
        this.onState({ status: "ready", item });
      })
      .catch((err) => {
        if (this.disposed || token !== this.loadToken) return;
        console.error("[carrier-inspector] failed to load", item.id, err);
        this.onState({ status: "error", item, message: String(err?.message ?? err) });
      });
  }

  /**
   * Load + lay out a whole faction lineup — the player fighter, every fleet hull
   * and the faction's station — at their TRUE relative fits, sitting on the grid
   * side by side so relative scale reads at a glance. Reuses the same
   * build/orient/fit/tint path as `show`, so sizes match the live game exactly.
   */
  showLineup(items: InspectItem[]): void {
    this.lastItem = null;
    this.lastLineup = items;
    const token = ++this.loadToken;
    this.onState({ status: "loading", item: items[0] });

    const ids = [
      ...new Set(items.flatMap((it) => (it.kind === "station" ? it.def.parts : [it.model.id]))),
    ];
    Promise.all(ids.map((id) => loadAsset(id)))
      .then((loaded: LoadedModel[]) => {
        if (this.disposed || token !== this.loadToken) return;
        const cache = new Map<string, LoadedModel>();
        ids.forEach((id, i) => cache.set(id, loaded[i]));
        const group = this.buildLineup(items, cache);
        this.swap(group, true);
        this.frame(group);
        this.onState({ status: "ready", item: items[0] });
      })
      .catch((err) => {
        if (this.disposed || token !== this.loadToken) return;
        console.error("[carrier-inspector] failed to load lineup", err);
        this.onState({ status: "error", item: items[0], message: String(err?.message ?? err) });
      });
  }

  /** Build every lineup item at its real fit and lay them left→right on the grid. */
  private buildLineup(items: InspectItem[], cache: Map<string, LoadedModel>): THREE.Object3D {
    const group = new THREE.Group();
    const box = new THREE.Box3();
    const size = new THREE.Vector3();
    // Gap between hulls, sized to the smallest (fighter) so it reads at any zoom.
    const gap = 16;
    let cursor = 0;
    for (const item of items) {
      const ids = item.kind === "station" ? item.def.parts : [item.model.id];
      const models = ids.map((id) => cache.get(id)).filter((m): m is LoadedModel => !!m);
      if (models.length !== ids.length) continue;
      const obj = this.build(item, models);
      group.add(obj);
      box.setFromObject(obj);
      box.getSize(size);
      // Sit the model's bottom on the ground plane (y=0), left edge at the cursor.
      obj.position.y += -box.min.y;
      obj.position.x += cursor - box.min.x;
      cursor += size.x + gap;
    }
    const rowWidth = Math.max(0, cursor - gap);
    // Recentre the whole row on x=0 so the turntable spins it in place.
    for (const child of group.children) child.position.x -= rowWidth / 2;
    return group;
  }

  /** Assemble + orient + fit + tint a loaded asset the same way the game does. */
  private build(item: InspectItem, models: LoadedModel[]): THREE.Object3D {
    if (item.kind === "station") {
      const assembly = new THREE.Group();
      for (const m of models) assembly.add(m.scene.clone(true));
      tintMetal(assembly, item.faction, true);
      fitObject(assembly, item.fit);
      return assembly;
    }
    const clone = models[0].scene.clone(true);
    if (item.model.yaw === undefined) autoOrientShip(clone);
    else clone.rotation.y = item.model.yaw;
    tintMetal(clone, this.tintFaction, false);
    fitObject(clone, item.fit);
    return clone;
  }

  /**
   * Replace the turntable's model + rebuild the size-matched grid/axes.
   * In `lineup` mode the row sits ON the ground (bottom at y=0) and is wide, so
   * the grid hugs the row and the axes shrink to a small nose-reference marker.
   */
  private swap(obj: THREE.Object3D, lineup = false): void {
    if (this.current) {
      this.turntable.remove(this.current);
      disposeOwned(this.current);
      this.current = null;
    }
    this.turntable.rotation.y = 0;
    this.turntable.add(obj);
    this.current = obj;

    // Size grid + axes to the model so orientation reads at any scale.
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    box.getSize(size);
    const span = Math.max(size.x, size.z) || 1;
    const groundY = box.min.y;

    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); (this.grid.material as THREE.Material).dispose(); }
    const gridSize = span * (lineup ? 1.15 : 2.2);
    this.grid = new THREE.GridHelper(gridSize, lineup ? 28 : 22, 0x3a6ea5, 0x18324f);
    this.grid.position.y = groundY * 1.001;
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.6;
    this.scene.add(this.grid);

    if (this.axes) { this.scene.remove(this.axes); this.axes.geometry.dispose(); (this.axes.material as THREE.Material).dispose(); }
    // +Z (blue) is the canonical nose direction — line it up with the grid.
    this.axes = new THREE.AxesHelper(lineup ? span * 0.12 : span * 0.85);
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
    if (this.current) disposeOwned(this.current);
    if (this.grid) { this.grid.geometry.dispose(); (this.grid.material as THREE.Material).dispose(); }
    if (this.axes) { this.axes.geometry.dispose(); (this.axes.material as THREE.Material).dispose(); }
    this.envMap.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

export type InspectorState =
  | { status: "loading"; item: InspectItem }
  | { status: "ready"; item: InspectItem }
  | { status: "error"; item: InspectItem; message: string };

/**
 * Dispose only what the inspector OWNS: the freshly-built tinted materials.
 * Geometry + textures come from the loadAsset session cache (flagged
 * `userData.sharedGeo` by tintMetal) and must never be freed here.
 */
function disposeOwned(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) m.dispose();
  });
}
