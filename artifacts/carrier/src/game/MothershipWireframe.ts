/**
 * MothershipWireframe — a disposable WebGL "construction" preview.
 *
 * Renders a faction's OWN mothership hull (`def.hull`, the same distinct hull the
 * MothershipShowcase composes) as a glowing wireframe that draws itself into
 * existence from the keel up via a sweeping clip plane, then slowly rotates, with
 * a small harvester/drone wireframe orbiting it. Used on the landing screen:
 * hovering a faction emblem swaps the CARRIER wordmark for this animated wireframe
 * build of that faction's hull. No platform — just the hull + its orbiting drone.
 *
 * Self-contained and disposable like the sibling showcase: it owns its renderer,
 * scene, RAF loop, and resize observer and tears them all down in dispose().
 * `select(def, color)` is async (loads the per-faction hull GLB on demand) and is
 * guarded by a load token so rapid hover changes never race.
 */
import * as THREE from "three";
import { loadAsset, type LoadedModel } from "@workspace/assets";
import type { MothershipDef } from "./motherships";
import { fleetModelFor } from "./factionAssets";

/** Small harvester drone that orbits the hull (a representative deployable miner). */
const DRONE_ID = fleetModelFor("scavengers", "miner").id;

const HULL_FIT = 40;
// The orbiting harvester is a tiny skimmer next to the city-sized hull
// (was 9 — it read like a second ship rather than a drone).
const DRONE_FIT = 3;
/** Seconds for the bottom-up wireframe reveal sweep. */
const REVEAL_SECONDS = 1.25;

export class MothershipWireframe {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly rig: THREE.Group;
  private readonly resizeObs: ResizeObserver;
  /** Global clip plane (normal -Y): keeps fragments with y < constant. */
  private readonly clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);

  private composite: THREE.Group | null = null;
  private drone: THREE.Object3D | null = null;
  private droneOrbitR = 0;
  private droneHeight = 0;
  private models: Record<string, LoadedModel | undefined> = {};

  private revealMinY = 0;
  private revealMaxY = 1;
  private reveal = 0; // 0..1 sweep progress

  private raf = 0;
  private disposed = false;
  private spin = 0;
  private orbit = 0;
  private loadToken = 0;

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth || 1, container.clientHeight || 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.clippingPlanes = [this.clip];
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      40,
      (container.clientWidth || 1) / (container.clientHeight || 1),
      0.1,
      4000,
    );
    this.camera.position.set(0, 14, 78);
    this.camera.lookAt(0, 0, 0);

    this.rig = new THREE.Group();
    this.scene.add(this.rig);

    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(container);
  }

  /**
   * Display `def`'s OWN mothership hull as a freshly-revealing wireframe in
   * `color`, with an orbiting drone. Loads the per-faction hull GLB (and the
   * shared drone) on demand; safe to call repeatedly on hover.
   */
  async select(def: MothershipDef, color: string): Promise<void> {
    if (this.disposed) return;
    const myToken = ++this.loadToken;

    const need = [def.hull, DRONE_ID].filter((id) => !(id in this.models));
    if (need.length) {
      const loaded = await Promise.all(
        need.map(async (id) => {
          try {
            return [id, await loadAsset(id)] as const;
          } catch {
            return [id, undefined] as const;
          }
        }),
      );
      if (this.disposed || myToken !== this.loadToken) return;
      for (const [id, model] of loaded) this.models[id] = model;
    }
    if (this.disposed || myToken !== this.loadToken) return;

    this.build(def, new THREE.Color(color));
  }

  private build(def: MothershipDef, color: THREE.Color): void {
    if (this.composite) {
      this.rig.remove(this.composite);
      disposeGroup(this.composite);
      this.composite = null;
    }
    if (this.drone) {
      this.rig.remove(this.drone);
      disposeGroup(this.drone);
      this.drone = null;
    }
    this.spin = 0;
    this.orbit = 0;
    this.rig.rotation.y = 0;

    const group = new THREE.Group();

    const hull = this.cloneWire(def.hull, HULL_FIT * def.hullScale, color);
    if (hull) group.add(hull);
    if (group.children.length === 0) {
      group.add(makeFallbackWire(color, def.hullScale));
    }

    // Recentre the hull on the origin so it frames + spins cleanly.
    const box = new THREE.Box3().setFromObject(group);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);
    group.position.sub(center);

    this.revealMinY = box.min.y - center.y - 1;
    this.revealMaxY = box.max.y - center.y + 1;
    this.reveal = 0;
    this.clip.constant = this.revealMinY;

    const maxDim = Math.max(size.x, size.y, size.z) || 60;

    // A small harvester drone orbiting the hull.
    const drone = this.cloneWire(DRONE_ID, DRONE_FIT, color);
    if (drone) {
      this.droneOrbitR = maxDim * 0.62 + DRONE_FIT;
      this.droneHeight = size.y * 0.18;
      this.drone = drone;
      this.rig.add(drone);
    }

    // Frame the camera to the hull + drone orbit, then pull in by `fill` so the
    // wireframe build reads ~3x larger and fills the title space better (same
    // centred position + reveal/spin — only the framing distance changes).
    const reach = Math.max(maxDim, this.droneOrbitR * 2);
    const fill = 3;
    this.camera.position.set(0, (reach * 0.26) / fill, (reach * 1.4) / fill);
    this.camera.lookAt(0, 0, 0);

    this.composite = group;
    this.rig.add(group);
  }

  start(): void {
    if (this.raf) return;
    let last = performance.now();
    const loop = (now: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      if (this.reveal < 1) {
        this.reveal = Math.min(1, this.reveal + dt / REVEAL_SECONDS);
        this.clip.constant =
          this.revealMinY + (this.revealMaxY - this.revealMinY) * easeOut(this.reveal);
      }
      // Hold off spinning until the build is mostly done.
      if (this.reveal > 0.4) this.spin += 0.0045;
      this.rig.rotation.y = this.spin;

      // The drone orbits the hull (independent of the hull's own slow spin).
      if (this.drone) {
        this.orbit += dt * 0.9;
        this.drone.position.set(
          Math.cos(this.orbit) * this.droneOrbitR,
          this.droneHeight + Math.sin(this.orbit * 1.7) * (this.droneOrbitR * 0.08),
          Math.sin(this.orbit) * this.droneOrbitR,
        );
        this.drone.rotation.y = -this.orbit + Math.PI / 2;
      }

      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Clone a catalog model, fit it, and convert every mesh to a wireframe. */
  private cloneWire(id: string, fit: number, color: THREE.Color): THREE.Object3D | null {
    const model = this.models[id];
    if (!model) return null;
    const obj = model.scene.clone(true);

    obj.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const wire = new THREE.MeshBasicMaterial({
          color,
          wireframe: true,
          transparent: true,
          opacity: 0.85,
          depthWrite: false,
        });
        o.material = wire;
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
    if (this.composite) disposeGroup(this.composite);
    this.composite = null;
    if (this.drone) disposeGroup(this.drone);
    this.drone = null;
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}

// --- module helpers ---------------------------------------------------------

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
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

/** A procedural wireframe stand-in if no GLBs loaded (offline / missing assets). */
function makeFallbackWire(color: THREE.Color, scale: number): THREE.Object3D {
  const body = new THREE.Mesh(
    new THREE.ConeGeometry(8 * scale, 30 * scale, 8),
    new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.85 }),
  );
  body.rotation.x = Math.PI / 2;
  return body;
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
