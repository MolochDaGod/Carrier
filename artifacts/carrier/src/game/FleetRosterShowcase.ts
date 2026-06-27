/**
 * FleetRosterShowcase — a disposable WebGL preview of the deployable fleet
 * classes for the faction dossier.
 *
 * Renders the six deployable hulls (`FLEET_GLB`) as small, gently auto-rotating
 * 3D previews laid out in a 2×3 grid, faction-tinted to match the active
 * faction. To stay light it uses ONE WebGL context and renders each cell into
 * its own scissored viewport region (so six previews cost one context, not six),
 * with a separate scene per cell sharing one camera. The React label overlay
 * (`FleetRosterPanel`) lays its labels out in the same row-major order.
 *
 * Self-contained and disposable like the other carrier previews: it owns its
 * renderer, scenes, RAF loop, and resize observer and frees them in dispose().
 */
import * as THREE from "three";
import type { FactionId } from "@workspace/carrier-net";
import { DEPLOY_ROLES, fleetModelFor } from "./factionAssets";
import { disposeGroup, loadHullModel } from "./hullFactory";

/** Grid layout — six deployable classes in two columns, three rows. */
export const ROSTER_COLS = 2;
export const ROSTER_ROWS = 3;

/** Deployable roster order (row-major); matches the label overlay. */
export const ROSTER_ROLES = DEPLOY_ROLES;

/** Target longest-side fit per preview cell (arbitrary preview units). */
const CELL_FIT = 9;

interface Cell {
  role: string;
  scene: THREE.Scene;
  pivot: THREE.Group;
  hull: THREE.Object3D | null;
}

export class FleetRosterShowcase {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly cells: Cell[] = [];
  private readonly resizeObs: ResizeObserver;

  private faction: FactionId | null = null;
  private buildSeq = 0;
  private raf = 0;
  private disposed = false;
  private spin = 0;

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

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);
    this.camera.position.set(0, 4.5, 20);
    this.camera.lookAt(0, 0, 0);

    // One scene per cell (each carries its own hull + lights) so the shared
    // camera can render them independently into scissored viewports.
    for (const role of ROSTER_ROLES) {
      const scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0x4a648f, 1.2));
      const key = new THREE.DirectionalLight(0xcfe6ff, 1.5);
      key.position.set(6, 9, 8);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0x8090ff, 0.55);
      fill.position.set(-7, 2, -5);
      scene.add(fill);
      const pivot = new THREE.Group();
      scene.add(pivot);
      this.cells.push({ role, scene, pivot, hull: null });
    }

    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(container);
  }

  /**
   * Build (or rebuild) the roster hulls for `faction`. Re-tinting means a fresh
   * faction-tinted clone per hull, so a faction change disposes the old hulls
   * and reloads — `loadAsset` is cached, so only the clone/tint work repeats.
   */
  async setFaction(faction: FactionId): Promise<void> {
    if (this.disposed || faction === this.faction) return;
    this.faction = faction;
    const mySeq = ++this.buildSeq;

    const built = await Promise.all(
      ROSTER_ROLES.map(async (role) => {
        try {
          return await loadHullModel(fleetModelFor(faction, role), faction, CELL_FIT);
        } catch {
          return null;
        }
      }),
    );
    if (this.disposed || mySeq !== this.buildSeq) {
      // A newer faction won the race — drop the stale clones.
      for (const obj of built) if (obj) disposeGroup(obj);
      return;
    }

    this.cells.forEach((cell, i) => {
      if (cell.hull) {
        cell.pivot.remove(cell.hull);
        disposeGroup(cell.hull);
        cell.hull = null;
      }
      const hull = built[i] ?? makeFallbackHull();
      cell.pivot.add(hull);
      cell.hull = hull;
    });
  }

  start(): void {
    if (this.raf) return;
    const loop = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      this.spin += 0.006;
      this.renderRoster();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private renderRoster(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const cellW = w / ROSTER_COLS;
    const cellH = h / ROSTER_ROWS;

    this.renderer.setScissorTest(true);
    this.camera.aspect = cellW / cellH;
    this.camera.updateProjectionMatrix();

    this.cells.forEach((cell, i) => {
      const col = i % ROSTER_COLS;
      const row = Math.floor(i / ROSTER_COLS);
      // WebGL viewport origin is bottom-left; the overlay grid is top-down.
      // setViewport/setScissor take LOGICAL pixels — three multiplies by the
      // renderer pixel ratio internally, so do NOT pre-scale by DPR here (that
      // double-applies it and misaligns cells on HiDPI displays).
      const x = col * cellW;
      const y = h - (row + 1) * cellH;
      this.renderer.setViewport(x, y, cellW, cellH);
      this.renderer.setScissor(x, y, cellW, cellH);
      cell.pivot.rotation.y = this.spin + i * 0.4;
      this.renderer.render(cell.scene, this.camera);
    });

    this.renderer.setScissorTest(false);
  }

  private onResize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObs.disconnect();
    for (const cell of this.cells) {
      if (cell.hull) disposeGroup(cell.hull);
      cell.hull = null;
    }
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}

/** A procedural stand-in if a hull GLB fails to load (offline / missing). */
function makeFallbackHull(): THREE.Object3D {
  const body = new THREE.Mesh(
    new THREE.ConeGeometry(2.6, 8, 6),
    new THREE.MeshStandardMaterial({
      color: 0x4a566e,
      metalness: 0.7,
      roughness: 0.4,
    }),
  );
  body.rotation.x = Math.PI / 2;
  return body;
}
