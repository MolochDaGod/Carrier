/**
 * MothershipInspector — a DEV-ONLY disposable "ship bay" scene.
 *
 * The Carrier game sits behind a Puter guest gate that automated browsers can't
 * drive, and the headless screenshot browser has no WebGL, so the only way to
 * confirm sizing/silhouettes by eye is to actually see every hull next to each
 * other at true relative scale during a real WebGL session. This scene spawns
 * exactly that — the player fighter and one of each fleet hull as scale anchors,
 * then the six mothership-class hulls, then every faction station — and reuses
 * the SAME render path as gameplay (`loadHullModel` / `loadStationModel` →
 * `fitObject`) so what you see here is exactly what spawns in a match.
 *
 * Beyond a static line-up it is interactive: click any ship (or call `focus()`
 * from the React list) to glide the camera onto it and read its dossier. The
 * selected hull is ringed by a faction-coloured box so the focus target is
 * unmistakable.
 *
 * Reached only via the hidden `?inspect` URL flag (see App.tsx) — it never goes
 * through auth and is never exposed to normal players. Disposable like the
 * cabinet engines: owns its renderer, scene, RAF loop, OrbitControls, resize
 * observer, pointer listeners, and selection helper, and tears them all down in
 * dispose().
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import {
  FACTIONS,
  FACTION_ORDER,
  fleetRoleDef,
  type FactionId,
  type FleetRole,
  type FleetRoleDef,
} from "@workspace/carrier-net";
import { FIGHTER_GLB, fleetModelFor } from "./factionAssets";
import { MOTHERSHIPS, type MothershipDef } from "./motherships";
import { SHIP_FIT } from "./constants";
import { disposeGroup, loadHullModel, loadStationModel } from "./hullFactory";

/** Fleet hulls shown as scale anchors (smallest → largest reads left → right). */
const ANCHOR_FLEET: Exclude<FleetRole, "none">[] = [
  "scout",
  "corsair",
  "cruiser",
  "dreadnought",
];

/** Gap between successive hulls, as a fraction of the combined half-widths. */
const GAP = 0.45;

/** Coarse classification of a placed hull, for grouping + dossier rendering. */
export type InspectorKind = "fighter" | "fleet" | "mothership" | "station";

/** One placed entry in the inspector line-up (mirrors `placed[]` by index). */
export interface InspectorEntry {
  /** Index into the placed-object array — also the selection handle. */
  index: number;
  label: string;
  kind: InspectorKind;
  /** Faction whose tint/colour this hull is shown in (display only). */
  faction: FactionId;
  /** Measured longest-axis length in world units (metres). */
  size: number;
  color: string;
  /** Full design dossier — motherships only. */
  ship?: MothershipDef;
  /** Fleet-role stats — fleet anchors only. */
  fleet?: FleetRoleDef;
}

/** Per-place metadata supplied before the model's on-screen size is measured. */
interface PlaceMeta {
  label: string;
  kind: InspectorKind;
  faction: FactionId;
  color: string;
  ship?: MothershipDef;
  fleet?: FleetRoleDef;
}

export class MothershipInspector {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly resizeObs: ResizeObserver;
  private readonly placed: THREE.Object3D[] = [];
  /** Highlight colour per placed index (the hull's real display faction). */
  private readonly placedColor: string[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private envMap: THREE.Texture | null = null;
  private selectionBox: THREE.BoxHelper | null = null;
  private selectedIndex: number | null = null;
  private raf = 0;
  private disposed = false;
  private cursorX = 0;
  private lastT = 0;

  // Pointer click-vs-drag tracking (OrbitControls also consumes drags).
  private downX = 0;
  private downY = 0;
  private downAt = 0;

  // Camera focus tween (eased glide onto a selected hull).
  private focusing = false;
  private focusT = 0;
  private readonly focusDur = 0.55;
  private readonly camFrom = new THREE.Vector3();
  private readonly camTo = new THREE.Vector3();
  private readonly tgtFrom = new THREE.Vector3();
  private readonly tgtTo = new THREE.Vector3();

  private onEntries?: (entries: InspectorEntry[]) => void;
  private onSelect?: (index: number) => void;
  private readonly onPointerDown = (e: PointerEvent) => {
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.downAt = performance.now();
    this.focusing = false; // a manual grab cancels any in-flight glide
  };
  private readonly onPointerUp = (e: PointerEvent) => {
    const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
    if (moved < 6 && performance.now() - this.downAt < 500) this.pick(e);
  };

  constructor(
    container: HTMLElement,
    onEntries?: (entries: InspectorEntry[]) => void,
    onSelect?: (index: number) => void,
  ) {
    this.container = container;
    this.onEntries = onEntries;
    this.onSelect = onSelect;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth || 1, container.clientHeight || 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070f);
    this.scene.fog = new THREE.FogExp2(0x05070f, 0.00018);

    this.camera = new THREE.PerspectiveCamera(
      55,
      (container.clientWidth || 1) / (container.clientHeight || 1),
      0.5,
      20000,
    );
    this.camera.position.set(0, 400, 1400);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxDistance = 12000;

    // Lighting mirrors the game arena so tinted metal PBR reads the same.
    this.scene.add(new THREE.HemisphereLight(0x99bbff, 0x080818, 0.6));
    const key = new THREE.DirectionalLight(0xfff3dd, 2.2);
    key.position.set(600, 900, 700);
    this.scene.add(key);
    const fill = new THREE.PointLight(0x2244aa, 0.5, 0, 2);
    fill.position.set(-600, 200, -400);
    this.scene.add(fill);

    // Neutral studio IBL (same as the game) so the metal materials catch
    // reflections; three auto-applies scene.environment to every standard mat.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envMap;
    pmrem.dispose();

    // Ground grid as a fixed-pitch scale reference (cells = 100 m).
    const grid = new THREE.GridHelper(8000, 80, 0x335577, 0x16233a);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(grid);

    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);

    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(container);
  }

  /**
   * Build the line-up: fighter + fleet anchors, then all mothership hulls, then
   * every faction station — each via the gameplay render path. Resolves once
   * everything is placed and reports the dossier entries.
   */
  async init(): Promise<void> {
    const entries: InspectorEntry[] = [];

    // Player fighter — the canonical scale anchor.
    const fighterFaction = FACTION_ORDER[0];
    await this.place(loadHullModel(FIGHTER_GLB.player, fighterFaction, SHIP_FIT), entries, {
      label: "Fighter",
      kind: "fighter",
      faction: fighterFaction,
      color: FACTIONS[fighterFaction].color,
    });

    // One of each fleet hull at its gameplay role scale.
    for (let i = 0; i < ANCHOR_FLEET.length; i++) {
      const role = ANCHOR_FLEET[i];
      const def = fleetRoleDef(role);
      const faction = FACTION_ORDER[i % FACTION_ORDER.length];
      await this.place(loadHullModel(fleetModelFor(faction, role), faction, def ? def.scale : 8), entries, {
        label: role[0].toUpperCase() + role.slice(1),
        kind: "fleet",
        faction,
        color: FACTIONS[faction].color,
        fleet: def ?? undefined,
      });
    }

    // A wider gap, then the six distinct mothership-class hulls so a human can
    // eyeball that each class shows a different silhouette + capital scale.
    this.cursorX += SHIP_FIT * 2;
    for (let i = 0; i < MOTHERSHIPS.length; i++) {
      const m = MOTHERSHIPS[i];
      const faction = FACTION_ORDER[i % FACTION_ORDER.length];
      await this.place(loadHullModel({ id: m.hull }, faction, SHIP_FIT * 4 * m.hullScale), entries, {
        label: m.name,
        kind: "mothership",
        faction,
        color: FACTIONS[faction].color,
        ship: m,
      });
    }

    // A wider gap, then every faction station at true relative scale.
    this.cursorX += SHIP_FIT * 2;
    for (const faction of FACTION_ORDER) {
      await this.place(loadStationModel(faction), entries, {
        label: FACTIONS[faction].name,
        kind: "station",
        faction,
        color: FACTIONS[faction].color,
      });
    }

    if (this.disposed) return;
    this.frameAll();
    this.onEntries?.(entries);
  }

  /** Await a built model, sit it on the grid, advance the cursor, record it. */
  private async place(
    build: Promise<THREE.Object3D>,
    entries: InspectorEntry[],
    meta: PlaceMeta,
  ): Promise<void> {
    let obj: THREE.Object3D;
    try {
      obj = await build;
    } catch {
      return; // asset missing — skip this slot rather than fail the whole row
    }
    if (this.disposed) {
      disposeGroup(obj);
      return;
    }

    // Measure post-fit so spacing + the legend use the real on-screen size.
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    box.getSize(size);
    const halfW = size.x / 2 || 1;
    const longest = Math.max(size.x, size.y, size.z) || 1;

    // First slot starts at the cursor; otherwise add a gap before it.
    if (this.placed.length > 0) this.cursorX += halfW * (1 + GAP);
    obj.position.x += this.cursorX - box.getCenter(new THREE.Vector3()).x;
    obj.position.y += -box.min.y; // rest on the grid (y = 0)
    this.cursorX += halfW * (1 + GAP);

    const index = this.placed.length;
    obj.userData.inspectIndex = index;
    this.scene.add(obj);
    this.placed.push(obj);
    this.placedColor.push(meta.color);
    entries.push({
      index,
      label: meta.label,
      kind: meta.kind,
      faction: meta.faction,
      size: longest,
      color: meta.color,
      ship: meta.ship,
      fleet: meta.fleet,
    });
  }

  /** Frame the camera so the whole line-up fits, centred on its midpoint. */
  private frameAll(): void {
    const box = new THREE.Box3();
    for (const o of this.placed) box.expandByObject(o);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 100;
    const dist = radius / Math.tan((this.camera.fov * Math.PI) / 360);
    this.controls.target.copy(center);
    this.camera.position.set(center.x, center.y + radius * 0.45, center.z + dist * 1.2);
    this.camera.near = Math.max(0.5, radius * 0.001);
    this.camera.far = dist * 8;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /**
   * Glide the camera onto the hull at `index` and ring it. Preserves the current
   * viewing angle (only the distance + pivot change) so the framing feels like a
   * dolly toward the ship rather than a jarring teleport.
   */
  focus(index: number): void {
    const obj = this.placed[index];
    if (!obj || this.disposed) return;
    this.selectedIndex = index;
    this.highlight(obj, index);

    const box = new THREE.Box3().setFromObject(obj);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 100;
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (radius / Math.tan(fov / 2)) * 1.5;

    // Keep the present orbit direction; fall back to a 3/4 view if degenerate.
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-4) dir.set(0.5, 0.4, 1);
    dir.normalize();

    this.camFrom.copy(this.camera.position);
    this.tgtFrom.copy(this.controls.target);
    this.tgtTo.copy(center);
    this.camTo.copy(center).addScaledVector(dir, dist);
    this.focusT = 0;
    this.focusing = true;

    // Open the clip planes for close-in inspection of a single hull.
    this.camera.near = Math.max(0.1, radius * 0.01);
    this.camera.far = Math.max(this.camera.far, dist * 20);
    this.camera.updateProjectionMatrix();
  }

  /** Ring the selected object with a faction-coloured bounding box. */
  private highlight(obj: THREE.Object3D, index: number): void {
    const color = this.entryColor(index);
    if (this.selectionBox) {
      this.scene.remove(this.selectionBox);
      this.selectionBox.geometry.dispose();
      (this.selectionBox.material as THREE.Material).dispose();
      this.selectionBox = null;
    }
    const helper = new THREE.BoxHelper(obj, new THREE.Color(color));
    (helper.material as THREE.LineBasicMaterial).transparent = true;
    (helper.material as THREE.LineBasicMaterial).opacity = 0.9;
    helper.update();
    this.selectionBox = helper;
    this.scene.add(helper);
  }

  private entryColor(index: number): string {
    return this.placedColor[index] ?? "#00d4ff";
  }

  /** Raycast a pointer event against the placed hulls and select the first hit. */
  private pick(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.placed, true);
    if (hits.length === 0) return;
    // Walk up to the placed root that carries the index tag.
    let node: THREE.Object3D | null = hits[0].object;
    while (node && node.userData.inspectIndex === undefined) node = node.parent;
    if (!node) return;
    const index = node.userData.inspectIndex as number;
    // Emit only — React owns the selection state and drives focus() back, so the
    // 3D click and the list click share one path (no double tween).
    if (index === this.selectedIndex) this.focus(index); // re-centre same target
    this.onSelect?.(index);
  }

  start(): void {
    if (this.raf) return;
    this.lastT = performance.now();
    const loop = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.05, (now - this.lastT) / 1000);
      this.lastT = now;

      if (this.focusing) {
        this.focusT = Math.min(1, this.focusT + dt / this.focusDur);
        const k = this.focusT * this.focusT * (3 - 2 * this.focusT); // smoothstep
        this.camera.position.lerpVectors(this.camFrom, this.camTo, k);
        this.controls.target.lerpVectors(this.tgtFrom, this.tgtTo, k);
        if (this.focusT >= 1) this.focusing = false;
      }

      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
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
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.resizeObs.disconnect();
    this.controls.dispose();
    if (this.selectionBox) {
      this.scene.remove(this.selectionBox);
      this.selectionBox.geometry.dispose();
      (this.selectionBox.material as THREE.Material).dispose();
      this.selectionBox = null;
    }
    for (const o of this.placed) {
      this.scene.remove(o);
      disposeGroup(o);
    }
    this.placed.length = 0;
    this.envMap?.dispose();
    this.envMap = null;
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }

  get selection(): number | null {
    return this.selectedIndex;
  }
}
