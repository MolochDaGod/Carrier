/**
 * Carrier — client game engine.
 *
 * Disposable Three.js class (one per session) that:
 *  - renders a starfield arena with a correctly-scaled sun (distant directional
 *    light + far billboard),
 *  - samples local input each frame and PREDICTS the local ship with the shared
 *    `stepShip` (same integrator the server runs),
 *  - RECONCILES against authoritative snapshots (snap to server state, replay
 *    pending inputs),
 *  - INTERPOLATES all other entities from a buffered snapshot history.
 *
 * Scale: 1 world unit = 1 metre.  Ship models are fit to SHIP_FIT (40 m).
 */
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { loadAsset, type LoadedModel } from "@workspace/assets";
import { VfxManager, type VfxHandle } from "@workspace/vfx";
import {
  FIGHTER_GLB,
  fleetModelFor,
  type DeployRole,
  type ShipModel,
} from "./factionAssets";
import { attachThrusters, updateThrusterSet } from "./thrusters";
import {
  BOSS,
  CARRIER,
  DEPLOYABLE_ROLES,
  ENEMY,
  FACTIONS,
  FACTION_ORDER,
  FLEET_ROLES,
  FLEET_UNIT,
  MOTHER_SHIP,
  PLATFORM,
  PLATFORM_DEFS,
  PLATFORM_KINDS,
  SHIP,
  fleetRoleDef,
  forwardVec,
  motherTurretVisualCount,
  spawnShip,
  stepShip,
  type BeamState,
  type CelestialBody,
  type EntityState,
  type FactionId,
  type FleetRole,
  type GameEvent,
  type InputCommand,
  type Outpost,
  type PlatformKind,
  type PlatformState,
  type PlayerEconomy,
  type ProjectileState,
  type RewardBox,
} from "@workspace/carrier-net";
import {
  AFTERBURNER,
  CAMERA,
  INTERP_DELAY_MS,
  PLATFORM_COLORS,
  ROLE_COLORS,
  SHIP_ACCENTS,
  SHIP_FIT,
  type BuildOption,
  type CamMode,
  type CarrierHudState,
  type ConnStatus,
  type DeployOption,
  type FleetRow,
  type MapBlip,
  type OutpostPing,
  type PlatformRow,
  type RosterRow,
  type ScoreRow,
  type TutorialHint,
} from "./constants";
import { SUN, sunPosition, SCALE } from "./scale";
import { FACTION_ACCENT } from "./motherships";
import {
  disposeGroup,
  fitObject,
  loadHullModel,
  loadStationModel,
  stationFit,
} from "./hullFactory";
import { disposeHullOverrides } from "./hullOverrides";
import { CarrierSocket } from "./net";
import { Turret } from "./Turret";

interface SnapEntry {
  time: number;
  entities: Map<string, EntityState>;
  celestials: Map<string, CelestialBody>;
}

/** Duration (seconds) of the opening fly-around cinematic. */
const CINEMATIC_DUR = 7;

/**
 * Flight-training onboarding shown after the cinematic. Each step displays a
 * prompt and advances either when the player performs the action OR after
 * `maxMs` (so an impatient pilot is never trapped). The per-step "done" check
 * lives in CarrierGame.tutorialStepDone, keyed by 1-based index.
 */
const TUTORIAL_STEPS: { title: string; body: string; maxMs: number }[] = [
  { title: "Throttle", body: "Hold W to fire your engines and pull away from the carrier.", maxMs: 9000 },
  { title: "Maneuver", body: "A / D to turn · ↑ / ↓ to pitch · move the mouse to aim. Click once to lock the cursor.", maxMs: 11000 },
  { title: "Afterburner", body: "Hold Shift to boost — watch the afterburner gauge heat up.", maxMs: 8000 },
  { title: "Weapons", body: "LMB or Space to fire cannons · RMB to launch homing missiles.", maxMs: 9000 },
  { title: "Command", body: "Fleet Log (left): click any ship to fly it · right-click drones to escort · Tab toggles carrier ↔ your last ship.", maxMs: 9000 },
  { title: "Engage", body: "You're cleared for combat, Commander. Hostiles inbound — good hunting.", maxMs: 5500 },
];

interface RemoteView {
  group: THREE.Group;
  /** Faint wireframe sphere of the unit's rated zone (owned fleet units only). */
  zone: THREE.Mesh | null;
}

export interface CarrierOpts {
  name: string;
  shipType: number;
  faction?: FactionId;
}

const LOCAL_NOSE = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion();
const _qr = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _scratch = new THREE.Vector3();

/** Control-cycle ordering: carrier first, then your fighter, then fleet units. */
function kindRank(e: EntityState): number {
  return kindRank2(e.kind);
}
function kindRank2(kind: EntityState["kind"]): number {
  if (kind === "mother_ship") return 0;
  if (kind === "fighter") return 1;
  return 2;
}

export class CarrierGame {
  private container: HTMLElement;
  private onHud: (s: CarrierHudState) => void;
  private opts: CarrierOpts;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private raf = 0;
  private clock = new THREE.Clock();
  private disposed = false;

  private socket = new CarrierSocket();
  private selfId: string | null = null;
  /** The commander's mothership entity id (from economy snapshots). */
  private motherShipId: string | null = null;
  /**
   * Last non-carrier hull the commander piloted — Tab toggles between this and
   * the mothership (not a full roster cycle).
   */
  private lastPilotedId: string | null = null;
  private controlledEntityId: string | null = null;

  private self: EntityState;
  private pending: InputCommand[] = [];
  private seq = 0;
  /** Last frame's local boost/afterburner input — drives the self plume spike. */
  private selfBoosting = false;
  /** Sustained afterburner heat (0..1) — climbs while boosting, cools when idle. */
  private boostHeat = 0;
  /**
   * True while the afterburner is overheated and locked out. Latches when
   * `boostHeat` tops out at 1.0 and clears once it cools below
   * `AFTERBURNER.recoverAt`, so boost has to be managed.
   */
  private boostLocked = false;
  /** Bumped on each false→true overheat lockout edge (HUD alarm + red flash). */
  private overheatPulse = 0;
  /** Bumped each time a locked-out afterburner cools back and re-engages. */
  private boostReadyPulse = 0;
  /** Bumped each time the controlled unit's hull takes damage (HUD hit cue). */
  private damagePulse = 0;
  /** Last hp seen for the tracked unit, to detect a decrease frame-over-frame. */
  private lastCueHp = -1;
  /** Which entity `lastCueHp` belongs to, so swapping units never reads as a hit. */
  private lastCueEntityId: string | null = null;

  /** Live mothership groups that carry animated hull turrets (self + remotes). */
  private motherGroups = new Set<THREE.Object3D>();
  private remotes = new Map<string, RemoteView>();
  /**
   * Optimistic set of owned fleet-unit ids the commander has toggled to escort.
   * Mirrors the server's escort toggle (fire-and-forget, like `become`); used
   * only to badge the Fleet Log. Cleared for any unit that stops being a
   * summonable owned fleet unit so the badge can never get stuck.
   */
  private escorting = new Set<string>();
  private snaps: SnapEntry[] = [];
  private latestEntities = new Map<string, EntityState>();
  private latestEconomy: PlayerEconomy[] = [];

  private projs = new Map<number, ProjectileState>();
  private projMeshes = new Map<number, THREE.Mesh>();
  private projTrails = new Map<number, VfxHandle>();
  /** Position history for spline missile trails (id → recent world points). */
  private projHistory = new Map<number, THREE.Vector3[]>();
  private projSplines = new Map<number, THREE.Line>();
  // Spinning shuriken bolt: a flat throwing-star disc (normal +Z) that whirls
  // down its line of travel, trailing a quarks flame/particle exhaust.
  private projGeo = makeShurikenGeometry(2.6);
  private projMat = new THREE.MeshBasicMaterial({
    color: 0xfff1c2, transparent: true, opacity: 0.98,
    depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  });
  private missileGeo = new THREE.ConeGeometry(1.4, 5.2, 6);
  private missileMat = new THREE.MeshBasicMaterial({
    color: 0xff6622, transparent: true, opacity: 0.95,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });

  /** Shared combat VFX (rocket exhaust trails + impact bursts). */
  private vfx: VfxManager | null = null;
  /** PMREM environment map giving hull/station metal its reflections. */
  private envMap: THREE.Texture | null = null;

  private selfGroup: THREE.Group | null = null;
  /** Hull key (kind:role:shipType) the self mesh is currently built for. */
  private selfGroupKey = "";

  // Build platforms (server-owned; rendered tethered to their carrier).
  private latestPlatforms: PlatformState[] = [];
  private platformViews = new Map<string, {
    group: THREE.Group;
    body: THREE.Object3D;
    glb: THREE.Object3D | null;
    cable: THREE.Mesh;
    cableMat: THREE.ShaderMaterial;
  }>();
  private platformTemplate: THREE.Object3D | null = null;
  private platformLoading = false;

  // Celestial bodies (planets/comets/asteroids) — interpolated like remotes.
  private latestCelestials = new Map<string, CelestialBody>();
  private celestialViews = new Map<string, THREE.Group>();

  // Fly-through reward boxes.
  private latestRewards: RewardBox[] = [];
  private rewardViews = new Map<string, { group: THREE.Group; halo: THREE.Mesh }>();
  private rewardGeo = new THREE.IcosahedronGeometry(1, 0);
  private haloGeo = new THREE.SphereGeometry(1, 12, 12);
  /** Lazy-loaded Lootbox GLB used as the reward-cache pickup; null until loaded. */
  private lootboxTpl: THREE.Object3D | null = null;
  private lootboxReq = false;

  // AI mining outposts (the contestable "ping" objectives).
  private latestOutposts: Outpost[] = [];
  private outpostViews = new Map<string, {
    group: THREE.Group;
    coreMat: THREE.MeshBasicMaterial;
    ringMat: THREE.MeshBasicMaterial;
    columnMat: THREE.MeshBasicMaterial;
    light: THREE.PointLight;
    ring: THREE.Mesh;
  }>();
  private outpostCoreGeo = new THREE.OctahedronGeometry(1, 0);
  private outpostRingGeo = new THREE.TorusGeometry(1, 0.04, 8, 48);
  private outpostColumnGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);

  // Live beams (mining cones + offensive lasers).
  private latestBeams: BeamState[] = [];
  private beamViews = new Map<string, { mesh: THREE.Mesh; mat: THREE.ShaderMaterial }>();
  private beamGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);

  // Lazy-loaded 19 MB explosion GLB; procedural fallback until it arrives.
  private explosionTemplate: THREE.Object3D | null = null;
  private explosionLoading = false;

  // Distant set-pieces (black-hole + solar-system backdrops).
  private backdrops: THREE.Object3D[] = [];

  private keys = new Set<string>();
  /** 0 = LMB primary, 2 = RMB missile. */
  private mouseBtns = new Set<number>();
  private mouseDx = 0;
  private mouseDy = 0;
  private pointerLocked = false;
  private invertY = false;

  // Mothership camera modes (client-only): "follow" chase-flight (default),
  // "orbit" survey (ship parked, camera orbits the hull with vantage presets),
  // "free" detached fly-cam. Only available while controlling a mother_ship;
  // forced back to "follow" for fighters/fleet units.
  private camMode: CamMode = "follow";
  private orbitYaw = 0;
  private orbitPitch = 0.35;
  private orbitDist = 0;
  private wheelDelta = 0;

  // Opening fly-around cinematic + flight-training onboarding.
  private introT = 0;
  private cinematicActive = false;
  /** 0 = not started, 1..N = active step, -1 = finished. */
  private tutorialStep = 0;
  private tutorialStepAt = 0;
  /** Orbit "vantage" presets cycled with KeyB (front / rear / port / top). */
  private vantageIdx = 0;
  private readonly vantages: { yaw: number; pitch: number }[] = [
    { yaw: 0, pitch: 0.32 },              // rear quarter (default)
    { yaw: Math.PI, pitch: 0.32 },        // bow-on
    { yaw: Math.PI / 2, pitch: 0.22 },    // broadside
    { yaw: 0, pitch: 1.25 },              // top-down survey
  ];
  // Free-cam state.
  private freePos = new THREE.Vector3();
  private freeYaw = 0;
  private freePitch = 0;

  private status: ConnStatus = "connecting";
  private lastSnapAt = 0;
  private clockOffset: number | null = null;

  /** Billboard quad tracking the sun. */
  private sunBillboard: THREE.Mesh | null = null;

  constructor(
    container: HTMLElement,
    onHud: (s: CarrierHudState) => void,
    opts: CarrierOpts,
  ) {
    this.container = container;
    this.onHud = onHud;
    this.opts = opts;
    this.self = spawnShip("local", opts.name, opts.shipType, 0, 0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setClearColor(0x010208, 1);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      CAMERA.fov,
      container.clientWidth / container.clientHeight,
      1,
      SUN.distance * 1.5,
    );
    this.camera.position.set(0, CAMERA.height, -CAMERA.distance);

    this.buildScene();
    this.bindInput();
  }

  start(): void {
    // The self mesh tracks whichever hull the commander is piloting (any owned
    // entity via become — fighter, carrier, or fleet unit).
    this.socket.onStatus = (s) => { this.status = s; };
    this.socket.onWelcome = (m) => {
      this.selfId = m.id;
      // Fighter entity id === player id by convention; authoritative control id
      // arrives on the first snapshot — seed last-piloted for Tab toggle.
      this.lastPilotedId = m.id;
      this.socket.send({ t: "join", name: this.opts.name, shipType: this.opts.shipType, faction: this.opts.faction });
    };
    this.socket.onSnapshot = (m) => this.onSnapshot(m);
    this.socket.connect();

    this.clock.start();
    this.loop();
  }

  // ---- scene ----------------------------------------------------------------

  private buildScene(): void {
    this.scene.fog = new THREE.FogExp2(0x010208, 0.000025);

    // Ambient fill
    const hemi = new THREE.HemisphereLight(0x99bbff, 0x080818, 0.6);
    this.scene.add(hemi);

    // Sun: distant directional light derived from scale system
    const [sx, sy, sz] = sunPosition();
    const sunDir = new THREE.DirectionalLight(SUN.color, SUN.intensity);
    sunDir.position.set(sx, sy, sz);
    this.scene.add(sunDir);

    // Fill light opposite the sun
    const fill = new THREE.PointLight(0x2244aa, 0.4, 0, 2);
    fill.position.set(-sx * 0.001, -sy * 0.001, -sz * 0.001);
    this.scene.add(fill);

    // Sun billboard — a flat quad at the sun's position showing a glow disc
    this.sunBillboard = this.makeSunBillboard(sx, sy, sz);
    this.scene.add(this.sunBillboard);

    // Stars — three depth layers, vertex-coloured for variety.
    this.scene.add(this.makeStars(3500, SHIP.arena * 3));
    this.scene.add(this.makeStars(1200, SHIP.arena * 1.8));
    this.scene.add(this.makeStars(500, SHIP.arena * 1.1));

    // Deep-space nebula gradient enveloping the arena (adds depth + colour).
    this.addNebula();

    // Accent rim light so ships read against the dark field.
    const rim = new THREE.PointLight(0x4a82ff, 0.5, SHIP.arena * 2.5, 2);
    rim.position.set(0, SHIP.arena * 0.35, 0);
    this.scene.add(rim);

    // Faint arena boundary (much larger than skies — 5 000 m radius)
    this.scene.add(this.makeArenaBox());

    // Distant black-hole + solar-system set-pieces (loaded async, non-blocking).
    this.addBackdrops();

    // Neutral studio IBL so the metal ship/station PBR materials catch
    // reflections — three auto-applies scene.environment to every standard mat.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envMap;
    pmrem.dispose();

    // Shared combat VFX layer (quarks). Prototypes load async; track()/play()
    // are no-ops until ready, so spawning before load simply skips the effect.
    this.vfx = new VfxManager(this.scene);
    this.vfx.load(["fireSparks", "explosion", "muzzleFlash", "projectileTrail"]).catch(() => {});
  }

  /** Load the two environment GLBs once and park them far outside the arena. */
  private addBackdrops(): void {
    const place = (
      id: string,
      pos: [number, number, number],
      fit: number,
    ): void => {
      loadAsset(id)
        .then((m: LoadedModel) => {
          if (this.disposed) return;
          const obj = m.scene.clone(true);
          fitObject(obj, fit);
          obj.position.set(pos[0], pos[1], pos[2]);
          this.scene.add(obj);
          this.backdrops.push(obj);
        })
        .catch(() => { /* backdrop is decorative — ignore load failures */ });
    };
    place("environment/carrier/black-hole", [-SHIP.arena * 4, SHIP.arena * 1.6, -SHIP.arena * 5], SHIP.arena * 2.2);
    place("environment/carrier/solar-system", [SHIP.arena * 5, -SHIP.arena * 1.2, SHIP.arena * 4.5], SHIP.arena * 3);
  }

  private makeSunBillboard(sx: number, sy: number, sz: number): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(SUN.billboardSize, SUN.billboardSize);
    const mat = new THREE.MeshBasicMaterial({
      color: SUN.glowColor,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(sx, sy, sz);
    // Always face the origin so it reads as a distant disc
    mesh.lookAt(0, 0, 0);
    return mesh;
  }

  private makeStars(count: number, radius: number): THREE.Points {
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const palette = [
      new THREE.Color(0xffffff),
      new THREE.Color(0xbcd8ff),
      new THREE.Color(0x9fb8ff),
      new THREE.Color(0xffd9a8),
    ];
    for (let i = 0; i < count; i++) {
      const u = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const r = radius * (0.7 + Math.random() * 0.3);
      const s = Math.sqrt(1 - u * u);
      pos[i * 3] = r * s * Math.cos(t);
      pos[i * 3 + 1] = r * u;
      pos[i * 3 + 2] = r * s * Math.sin(t);
      const c = palette[(Math.random() * palette.length) | 0];
      const b = 0.6 + Math.random() * 0.4;
      col[i * 3] = c.r * b;
      col[i * 3 + 1] = c.g * b;
      col[i * 3 + 2] = c.b * b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size: 2.6,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
      vertexColors: true,
    });
    return new THREE.Points(geo, mat);
  }

  /**
   * A large BackSide gradient sphere enveloping the arena — reads as a faint
   * deep-space nebula and gives the otherwise-flat void real depth + colour.
   * Tracked in `backdrops` so it is disposed on teardown.
   */
  private addNebula(): void {
    const top = new THREE.Color(0x2a1656);
    const mid = new THREE.Color(0x0e2c5a);
    const warm = new THREE.Color(0x5a2342);
    const R = SHIP.arena * 3.2;
    const geo = new THREE.IcosahedronGeometry(R, 4);
    const p = geo.getAttribute("position") as THREE.BufferAttribute;
    const n = p.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const mix = (p.getY(i) / R + 1) / 2;
      const c = top.clone().lerp(mid, mix);
      c.lerp(warm, Math.abs(Math.sin(p.getX(i) * 0.0009)) * 0.45);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    this.scene.add(mesh);
    this.backdrops.push(mesh);
  }

  private makeArenaBox(): THREE.LineSegments {
    const a = SHIP.arena;
    const box = new THREE.BoxGeometry(a * 2, a * 2, a * 2);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    const mat = new THREE.LineBasicMaterial({ color: 0x1a3a6e, transparent: true, opacity: 0.12 });
    return new THREE.LineSegments(edges, mat);
  }

  private makeFallbackShip(shipType: number, accentOverride?: string): THREE.Group {
    const g = new THREE.Group();
    const accent = accentOverride ?? SHIP_ACCENTS[shipType % SHIP_ACCENTS.length];
    const accentCol = new THREE.Color(accent);
    const L = SHIP_FIT;
    const hullMat = new THREE.MeshStandardMaterial({ color: 0x2b3340, roughness: 0.45, metalness: 0.7 });
    const accentMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.35, metalness: 0.6, emissive: accentCol, emissiveIntensity: 0.35 });

    // Tapered fuselage — nose toward +Z (the canonical local nose).
    const fuse = new THREE.Mesh(new THREE.ConeGeometry(L * 0.13, L * 0.95, 12), hullMat);
    fuse.rotation.x = Math.PI / 2;
    fuse.position.z = L * 0.05;
    g.add(fuse);

    // Mid hull block.
    const mid = new THREE.Mesh(new THREE.BoxGeometry(L * 0.2, L * 0.14, L * 0.4), hullMat);
    mid.position.z = -L * 0.18;
    g.add(mid);

    // Cockpit canopy.
    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(L * 0.09, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0x88ccff, roughness: 0.15, metalness: 0.2, emissive: 0x335577, emissiveIntensity: 0.4, transparent: true, opacity: 0.85 }),
    );
    canopy.scale.z = 1.6;
    canopy.position.set(0, L * 0.07, L * 0.12);
    g.add(canopy);

    // Swept wings + wingtip lights.
    for (const s of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(L * 0.5, L * 0.03, L * 0.28), accentMat);
      wing.position.set(s * L * 0.3, 0, -L * 0.16);
      wing.rotation.y = s * 0.5;
      g.add(wing);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(L * 0.035, 8, 6), new THREE.MeshBasicMaterial({ color: accent }));
      tip.position.set(s * L * 0.52, 0, -L * 0.24);
      g.add(tip);
    }

    // Twin engine nacelles + glow discs at the rear.
    for (const s of [-1, 1]) {
      const nac = new THREE.Mesh(new THREE.CylinderGeometry(L * 0.05, L * 0.06, L * 0.3, 10), hullMat);
      nac.rotation.x = Math.PI / 2;
      nac.position.set(s * L * 0.12, -L * 0.02, -L * 0.34);
      g.add(nac);
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(L * 0.06, 12),
        new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
      );
      disc.position.set(s * L * 0.12, -L * 0.02, -L * 0.49);
      g.add(disc);
    }

    // Engine glow.
    const glow = new THREE.PointLight(accentCol, 1.2, L * 3, 2);
    glow.position.set(0, 0, -L * 0.5);
    g.add(glow);
    return g;
  }

  /** Pick the right hull for an entity by kind/role (fighter / mother / fleet). */
  private makeEntityGroup(entity: EntityState): THREE.Group {
    const faction = entity.faction ?? FACTION_ORDER[0];
    let g: THREE.Group;
    if (entity.kind === "mother_ship") g = this.makeMothership(faction, entity.shipType);
    else if (entity.kind === "fleet_unit") g = this.makeFleetUnit(entity.role, faction);
    else g = this.makeFighter(entity, faction);

    // Floating in-world identity tag (name + short UID) + deflector bubble. Both
    // ride the hull group; the tag is a billboarded canvas sprite, the shield a
    // translucent additive sphere whose opacity tracks the deflector charge.
    const r = this.hullRadius(entity);
    const tag = this.makeNameTag(r * 1.35);
    tag.position.y = r * 1.45;
    g.add(tag);
    g.userData.nameTag = tag;
    g.userData.tagBaseScale = tag.scale.x;
    if (entity.maxShield > 0) {
      const bubble = this.makeShieldBubble(r * 1.25);
      g.add(bubble);
      g.userData.shieldBubble = bubble;
    }
    return g;
  }

  /** Rough visual hull radius per kind, for sizing tags + shield bubbles. */
  private hullRadius(entity: EntityState): number {
    if (entity.kind === "mother_ship") return SHIP_FIT * MOTHER_SHIP.scaleFactor * 0.5;
    if (entity.kind === "fleet_unit") return SHIP_FIT * 0.7;
    return SHIP_FIT * (entity.id === BOSS.id ? BOSS.scale : 1) * 0.7;
  }

  /** A billboarded canvas-texture name/uid sprite (text filled lazily). */
  private makeNameTag(scale: number): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(scale, scale * 0.25, 1);
    sprite.renderOrder = 999;
    sprite.userData.canvas = canvas;
    sprite.userData.text = "";
    return sprite;
  }

  /** Paint a name-tag sprite's text (no-op when unchanged). */
  private setTagText(sprite: THREE.Sprite, text: string, color: string): void {
    const key = `${text}|${color}`;
    if (sprite.userData.text === key) return;
    sprite.userData.text = key;
    const canvas = sprite.userData.canvas as HTMLCanvasElement;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = "bold 22px ui-monospace, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
    ctx.fillStyle = color;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const mat = sprite.material as THREE.SpriteMaterial;
    (mat.map as THREE.CanvasTexture).needsUpdate = true;
  }

  /** Translucent additive deflector sphere; opacity driven per frame. */
  private makeShieldBubble(radius: number): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 16, 12),
      new THREE.MeshBasicMaterial({
        color: 0x66ccff, transparent: true, opacity: 0,
        depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      }),
    );
    return mesh;
  }

  /** Free the owned canvas-texture name tag a group carries (sprite is skipped
   * by disposeGroup; the shield bubble is a Mesh disposeGroup already frees). */
  private disposeEntityExtras(g: THREE.Object3D): void {
    const tag = g.userData.nameTag as THREE.Sprite | undefined;
    if (tag) {
      const mat = tag.material as THREE.SpriteMaterial;
      mat.map?.dispose();
      mat.dispose();
      g.userData.nameTag = undefined;
    }
  }

  /** Player/enemy fighter hull: procedural fallback now, GLB swapped in async. */
  private makeFighter(entity: EntityState, faction: FactionId): THREE.Group {
    const isEnemy = entity.team === ENEMY.team;
    const g = new THREE.Group();
    const fb = this.makeFallbackShip(entity.shipType, isEnemy ? "#ff3b30" : FACTIONS[faction].color);
    g.add(fb);
    g.userData.fallback = fb;
    this.requestShipModel(g, isEnemy ? FIGHTER_GLB.enemy : FIGHTER_GLB.player, faction, SHIP_FIT);
    // Animated rear boosters on the outer group (survive the async hull swap).
    attachThrusters(g, {
      kind: "fighter",
      color: isEnemy ? "#ff5a3c" : FACTIONS[faction].color,
      fitLen: SHIP_FIT,
      ref: SHIP.maxSpeed,
    });
    // The world boss is the same enemy hull scaled up so it reads as a capital
    // threat looming at the centre of the zone.
    if (entity.id === BOSS.id) g.scale.setScalar(BOSS.scale);
    return g;
  }

  /** Large capital hull — faction OBJ station over a procedural fallback. */
  private makeMothership(faction: FactionId, shipType: number): THREE.Group {
    const g = new THREE.Group();
    // Muted client accent (matches the hangar showcase) — keeps the brief
    // procedural fallback consistent with the lit OBJ station that replaces it.
    const fb = this.buildProceduralMother(FACTION_ACCENT[faction]);
    g.add(fb);
    g.userData.fallback = fb;
    this.requestStationModel(g, faction);
    // Cosmetic hull turrets live on the OUTER group (not the fallback) so they
    // persist when the async OBJ station swaps the fallback out — a mothership
    // bristles with 20–30 guns whichever hull is showing. They take the MUTED
    // client accent (matching the lit hull) so the fixtures read as part of the
    // painted-metal hull instead of glowing neon attachments; the firing beam is
    // brightened back to legible inside the Turret itself.
    this.addMotherTurrets(g, FACTION_ACCENT[faction], shipType, faction);
    // Capital boosters fire downward from a belly cluster — matching the engine
    // "legs" on the faction stations. On the outer group so they survive the swap.
    attachThrusters(g, {
      kind: "mother_ship",
      color: FACTION_ACCENT[faction],
      // Use the faction's true station fit (incl. fitMul) so the per-faction
      // belly-engine layout in thrusters.ts scales with the rendered hull.
      fitLen: stationFit(faction),
      ref: MOTHER_SHIP.maxSpeed,
      faction,
    });
    return g;
  }

  /**
   * Stud a mothership's upper hull with real animated turrets (the rigged
   * heavy-metal-turret GLB). They load asynchronously and self-deploy; each
   * tracks + fires at the nearest hostile every frame (see `updateTurrets`).
   * The instances are stored on `g.userData.turrets` so their lifecycle is tied
   * to the (transient) mothership group — `disposeMother` frees them on teardown.
   */
  private addMotherTurrets(g: THREE.Group, accent: string, shipType: number, faction: FactionId): void {
    // Match thruster + station fit so turrets land on the rendered hull mesh.
    const len = stationFit(faction);
    const size = len * 0.048;
    const count = Math.min(10, Math.max(5, Math.round(motherTurretVisualCount(shipType) / 2.5)));
    const turrets: Turret[] = [];
    g.userData.turrets = turrets;
    g.userData.turretFaction = faction;
    this.motherGroups.add(g);

    const up = new THREE.Vector3(0, 1, 0);
    const rows = Math.ceil(count / 2);
    let placed = 0;
    for (let r = 0; r < rows && placed < count; r++) {
      const zt = rows === 1 ? 0 : r / (rows - 1);
      const z = (zt - 0.5) * len * 0.62;
      for (const sx of [-1, 1]) {
        if (placed >= count) break;
        placed++;
        const pos = new THREE.Vector3(sx * len * 0.13, len * 0.11, z);
        Turret.create({ size, beamColor: accent, range: len * 2.6 })
          .then((t) => {
            if (this.disposed || !this.motherGroups.has(g)) {
              t.dispose();
              return;
            }
            t.mountOn(g, pos, up);
            t.deploy();
            turrets.push(t);
          })
          .catch(() => {
            /* asset failed to load — hull simply shows no turret there */
          });
      }
    }
  }

  /** Free any animated turrets carried by a (mothership) group before disposal. */
  private disposeMother(g: THREE.Object3D | null): void {
    if (!g || !this.motherGroups.has(g)) return;
    const turrets = g.userData.turrets as Turret[] | undefined;
    if (turrets) for (const t of turrets) t.dispose();
    g.userData.turrets = undefined;
    this.motherGroups.delete(g);
  }

  /** Per-frame: aim + fire every live hull turret at the nearest hostile. */
  private updateTurrets(dt: number): void {
    if (this.motherGroups.size === 0) return;
    // Snapshot alive entity world positions + factions once per frame.
    const cands: { p: THREE.Vector3; f: FactionId | undefined }[] = [];
    for (const e of this.latestEntities.values()) {
      if (!e.alive) continue;
      cands.push({ p: new THREE.Vector3(e.px, e.py, e.pz), f: e.faction });
    }
    // Hostile target lists are identical for every mothership of the same
    // faction — compute each once per frame and reuse across its turrets.
    const byFaction = new Map<FactionId | undefined, THREE.Vector3[]>();
    for (const g of this.motherGroups) {
      const turrets = g.userData.turrets as Turret[] | undefined;
      if (!turrets || turrets.length === 0) continue;
      const faction = g.userData.turretFaction as FactionId | undefined;
      let targets = byFaction.get(faction);
      if (!targets) {
        targets = cands.filter((c) => c.f !== faction).map((c) => c.p);
        byFaction.set(faction, targets);
      }
      for (const t of turrets) t.update(dt, targets);
    }
  }

  /**
   * Per-frame: drive every ship's engine boosters from its current speed, with
   * an extra afterburner spike. The local ship uses its real boost INPUT (so the
   * plume flares the instant you hold Shift, even before speed catches up);
   * remote ships now carry an authoritative `boost` flag in their snapshot, so
   * their plume flares exactly when they are boosting instead of being inferred
   * from over-cap speed (which lingered after boost was released).
   */
  private updateThrusters(dt: number): void {
    const t = performance.now() * 0.001;
    if (this.selfGroup) {
      const sp = Math.hypot(this.self.vx, this.self.vy, this.self.vz);
      updateThrusterSet(this.selfGroup, sp, t, dt, this.selfBoosting);
    }
    for (const [id, view] of this.remotes) {
      const e = this.latestEntities.get(id);
      const sp = e ? Math.hypot(e.vx, e.vy, e.vz) : 0;
      updateThrusterSet(view.group, sp, t, dt, e ? e.boost && e.alive : undefined);
    }
  }

  /** Procedural capital-hull fallback shown until the faction station loads. */
  private buildProceduralMother(accent: string): THREE.Group {
    const g = new THREE.Group();
    const accentCol = new THREE.Color(accent);
    const len = SHIP_FIT * MOTHER_SHIP.scaleFactor;
    const hullMat = new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 0.75, metalness: 0.55 });
    const plateMat = new THREE.MeshStandardMaterial({ color: 0x2a313c, roughness: 0.8, metalness: 0.5 });
    const accentMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.4, metalness: 0.6, emissive: accentCol, emissiveIntensity: 0.3 });

    // Main hull + wider belly plate.
    const hull = new THREE.Mesh(new THREE.BoxGeometry(len * 0.32, len * 0.18, len), hullMat);
    g.add(hull);
    const belly = new THREE.Mesh(new THREE.BoxGeometry(len * 0.4, len * 0.1, len * 0.8), plateMat);
    belly.position.y = -len * 0.12;
    g.add(belly);

    // Command spine + forward bridge tower.
    const spine = new THREE.Mesh(new THREE.BoxGeometry(len * 0.08, len * 0.26, len * 0.7), accentMat);
    spine.position.y = len * 0.14;
    g.add(spine);
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(len * 0.1, len * 0.12, len * 0.14), hullMat);
    bridge.position.set(0, len * 0.24, len * 0.28);
    g.add(bridge);

    // Glowing side strakes.
    for (const s of [-1, 1]) {
      const strake = new THREE.Mesh(new THREE.BoxGeometry(len * 0.04, len * 0.06, len * 0.85), accentMat);
      strake.position.set(s * len * 0.17, 0, 0);
      g.add(strake);
    }

    // Engine bank — three emissive discs + glow at the rear.
    for (let i = -1; i <= 1; i++) {
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(len * 0.05, 16),
        new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
      );
      disc.position.set(i * len * 0.1, 0, -len * 0.5);
      g.add(disc);
    }
    const glow = new THREE.PointLight(accentCol, 1.6, len * 2, 2);
    glow.position.set(0, 0, -len * 0.5);
    g.add(glow);

    // Note: cosmetic hull turrets are added on the OUTER mothership group by
    // `addMotherTurrets` (so they survive the async OBJ-station swap), not here.
    return g;
  }

  /** Role-classed fleet unit — GLB hull over a role-coloured procedural fallback. */
  private makeFleetUnit(role: FleetRole, faction: FactionId): THREE.Group {
    const g = new THREE.Group();
    const def = fleetRoleDef(role);
    const fb = this.buildProceduralFleet(role);
    g.add(fb);
    g.userData.fallback = fb;
    if (role !== "none") {
      this.requestShipModel(g, fleetModelFor(faction, role as DeployRole), faction, def ? def.scale : 8);
      attachThrusters(g, {
        kind: "fleet_unit",
        color: ROLE_COLORS[role],
        fitLen: def ? def.scale : 8,
        ref: FLEET_UNIT.maxSpeed,
      });
    }
    return g;
  }

  /** Procedural fleet-hull fallback (role-coloured) shown until the GLB loads. */
  private buildProceduralFleet(role: FleetRole): THREE.Group {
    const g = new THREE.Group();
    const def = fleetRoleDef(role);
    const len = def ? def.scale : 8;
    const color = role !== "none" ? ROLE_COLORS[role] : "#ffffff";
    const col = new THREE.Color(color);
    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.55, emissive: col, emissiveIntensity: 0.3 });
    const hullMat = new THREE.MeshStandardMaterial({ color: 0x2b3340, roughness: 0.5, metalness: 0.6 });
    const body = new THREE.Mesh(new THREE.ConeGeometry(len * 0.2, len, 8), bodyMat);
    body.rotation.x = Math.PI / 2;
    g.add(body);
    // Dark hull mid-section for panel "texture" contrast against the accent body.
    const mid = new THREE.Mesh(
      new THREE.CylinderGeometry(len * 0.22, len * 0.22, len * 0.34, 8),
      hullMat,
    );
    mid.rotation.x = Math.PI / 2;
    mid.position.z = -len * 0.08;
    g.add(mid);
    // Stub wings.
    for (const s of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(len * 0.5, len * 0.04, len * 0.22), hullMat);
      wing.position.set(s * len * 0.28, 0, -len * 0.12);
      wing.rotation.y = s * 0.4;
      g.add(wing);
    }
    // Harvesters get a glowing collector rig at the nose — the mining beam visibly
    // springs from this emitter, so the "harvesting ship" reads as a miner.
    if (role === "miner") {
      const ringMat = new THREE.MeshStandardMaterial({
        color, emissive: col, emissiveIntensity: 0.7, roughness: 0.3, metalness: 0.75,
      });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(len * 0.3, len * 0.05, 8, 20), ringMat);
      ring.position.z = len * 0.42;
      g.add(ring);
      const struts = new THREE.Mesh(new THREE.TorusGeometry(len * 0.16, len * 0.03, 6, 14), ringMat);
      struts.position.z = len * 0.36;
      g.add(struts);
      const emitter = new THREE.Mesh(
        new THREE.SphereGeometry(len * 0.13, 12, 12),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }),
      );
      emitter.position.z = len * 0.5;
      g.add(emitter);
      const tip = new THREE.PointLight(col, 0.7, len * 3, 2);
      tip.position.z = len * 0.5;
      g.add(tip);
    }
    // Engine glow disc + light.
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(len * 0.12, 10),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    disc.position.z = -len * 0.5;
    g.add(disc);
    const glow = new THREE.PointLight(col, 0.6, len * 2.5, 2);
    glow.position.z = -len * 0.5;
    g.add(glow);
    return g;
  }

  /** Async-load a hull GLB, faction-tint + metal it, and swap it in for the
   *  procedural fallback in `group`. loadAsset's promise cache shares one decode
   *  across concurrent requests for the same id. */
  private requestShipModel(
    group: THREE.Group, model: ShipModel, faction: FactionId, fit: number,
  ): void {
    loadHullModel(model, faction, fit)
      .then((clone) => {
        if (this.disposed || !group.parent) { disposeGroup(clone); return; }
        this.swapFallback(group, clone);
      })
      .catch(() => { /* keep the procedural fallback */ });
  }

  /** Async-load a faction's (possibly multi-part) OBJ station, assemble the
   *  parts at native transforms, metal-PBR them, fit the whole assembly ONCE,
   *  and swap it in for the procedural mothership. */
  private requestStationModel(group: THREE.Group, faction: FactionId): void {
    loadStationModel(faction)
      .then((assembly) => {
        if (this.disposed || !group.parent) { disposeGroup(assembly); return; }
        this.swapFallback(group, assembly);
      })
      .catch(() => { /* keep the procedural mothership */ });
  }

  /** Remove a group's procedural fallback child and add the loaded model. */
  private swapFallback(group: THREE.Group, model: THREE.Object3D): void {
    const fb = group.userData.fallback as THREE.Object3D | undefined;
    if (fb) {
      group.remove(fb);
      disposeGroup(fb);
      group.userData.fallback = undefined;
    }
    group.add(model);
    group.userData.glb = model;
  }

  /** Faint wireframe sphere marking a unit's rated operation zone. */
  private makeZoneMesh(color: string): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.06 }),
    );
    return mesh;
  }

  // ---- input ----------------------------------------------------------------

  private bindInput(): void {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.renderer.domElement.addEventListener("click", this.onCanvasClick);
    this.renderer.domElement.addEventListener("mousedown", this.onMouseDown);
    this.renderer.domElement.addEventListener("mouseup", this.onMouseUp);
    this.renderer.domElement.addEventListener("contextmenu", this.onContextMenu);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("resize", this.onResize);
    this.renderer.domElement.addEventListener("wheel", this.onWheel, { passive: true });
  }

  private onKeyDown = (e: KeyboardEvent) => {
    // While the opening fly-around plays, any of these keys skips straight to control.
    if (this.cinematicActive) {
      if (e.code === "Space" || e.code === "Enter" || e.code === "Escape" || e.code === "KeyV") {
        e.preventDefault();
        this.endCinematic();
        return;
      }
    }
    if (e.code === "Tab") { e.preventDefault(); this.cycleControl(); return; }
    // Mothership camera modes: V cycles follow→orbit→free; B cycles orbit vantage.
    if (e.code === "KeyV") { this.cycleCamMode(); return; }
    if (e.code === "KeyB" && this.camMode === "orbit") { this.cycleVantage(); return; }
    this.keys.add(e.code);
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code))
      e.preventDefault();
  };
  private onWheel = (e: WheelEvent) => {
    if (this.camMode === "orbit") this.wheelDelta += e.deltaY;
  };
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
  private onCanvasClick = () => {
    if (this.cinematicActive) this.endCinematic();
    if (!this.pointerLocked) this.renderer.domElement.requestPointerLock?.();
  };
  private onMouseDown = (e: MouseEvent) => {
    if (e.button === 0 || e.button === 2) this.mouseBtns.add(e.button);
    if (e.button === 0 && !this.pointerLocked) this.onCanvasClick();
  };
  private onMouseUp = (e: MouseEvent) => {
    this.mouseBtns.delete(e.button);
  };
  private onContextMenu = (e: MouseEvent) => {
    if (this.pointerLocked) e.preventDefault();
  };
  private onPointerLockChange = () => {
    this.pointerLocked = document.pointerLockElement === this.renderer.domElement;
  };
  private onMouseMove = (e: MouseEvent) => {
    if (!this.pointerLocked) return;
    this.mouseDx += e.movementX;
    this.mouseDy += e.movementY;
  };
  private onResize = () => {
    if (this.disposed) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private sampleInput(dt: number): InputCommand {
    const k = this.keys;
    const down = (...codes: string[]) => codes.some((c) => k.has(c));
    let thrust = 0, yaw = 0, pitch = 0, roll = 0;
    if (down("KeyW")) thrust += 1;
    if (down("KeyS")) thrust -= 1;
    if (down("KeyA", "ArrowLeft")) yaw += 1;
    if (down("KeyD", "ArrowRight")) yaw -= 1;
    if (down("ArrowUp")) pitch += 1;
    if (down("ArrowDown")) pitch -= 1;
    if (down("KeyQ")) roll += 1;
    if (down("KeyE")) roll -= 1;
    const mSens = 0.06;
    yaw -= this.mouseDx * mSens * 0.16;
    pitch += -this.mouseDy * mSens * 0.16 * (this.invertY ? -1 : 1);
    this.mouseDx = 0;
    this.mouseDy = 0;
    const boost = down("ShiftLeft", "ShiftRight");
    const fire = down("Space") || down("KeyF") || this.mouseBtns.has(0);
    const missile = this.mouseBtns.has(2);
    const clamp1 = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v);
    return {
      seq: ++this.seq, dt,
      thrust: clamp1(thrust), yaw: clamp1(yaw), pitch: clamp1(pitch), roll: clamp1(roll),
      boost, fire, missile,
    };
  }

  // ---- net ------------------------------------------------------------------

  private onSnapshot(m: {
    time: number; ack: number; entities: EntityState[];
    projectiles: ProjectileState[];
    events: GameEvent[];
    economy: PlayerEconomy[];
    celestials: CelestialBody[];
    rewards: RewardBox[];
    outposts: Outpost[];
    beams: BeamState[];
    platforms: PlatformState[];
  }): void {
    const localNow = performance.now();
    this.lastSnapAt = localNow;

    const offset = m.time - localNow;
    if (this.clockOffset === null) this.clockOffset = offset;
    else this.clockOffset += (offset - this.clockOffset) * 0.05;

    const map = new Map<string, EntityState>();
    for (const e of m.entities) map.set(e.id, e);
    this.latestEntities = map;
    this.latestEconomy = m.economy;

    const cmap = new Map<string, CelestialBody>();
    for (const c of m.celestials) cmap.set(c.id, c);
    this.latestCelestials = cmap;
    this.latestRewards = m.rewards;
    this.latestOutposts = m.outposts ?? [];
    this.latestBeams = m.beams;
    this.latestPlatforms = m.platforms;

    if (this.selfId) {
      const eco = m.economy.find((e) => e.playerId === this.selfId);
      if (eco) {
        this.motherShipId = eco.motherShipId;
        // When control switches to a different entity, drop any inputs still
        // queued for the old one — the server discards queued commands on
        // `become`, so replaying them onto the new entity would jitter it.
        if (eco.controlledEntityId !== this.controlledEntityId) this.pending = [];
        const prev = this.controlledEntityId;
        this.controlledEntityId = eco.controlledEntityId;
        const auth = map.get(eco.controlledEntityId);
        if (auth && auth.kind !== "mother_ship") {
          this.lastPilotedId = eco.controlledEntityId;
        } else if (prev && prev !== eco.motherShipId && map.get(prev)?.alive) {
          // Switched to carrier — remember what we just left as "last piloted".
          this.lastPilotedId = prev;
        }
      }
    }

    this.snaps.push({ time: m.time, entities: map, celestials: cmap });
    while (this.snaps.length > 40) this.snaps.shift();

    const ceid = this.controlledEntityId;
    if (ceid) {
      const auth = map.get(ceid);
      if (auth) {
        copyEntity(this.self, auth);
        this.pending = this.pending.filter((c) => c.seq > m.ack);
        for (const c of this.pending) stepShip(this.self, c, Math.max(0, Math.min(0.05, c.dt)));
      }
    }

    const seen = new Set<number>();
    for (const p of m.projectiles) { seen.add(p.id); this.projs.set(p.id, p); }
    for (const id of [...this.projs.keys()]) if (!seen.has(id)) this.projs.delete(id);

    for (const ev of m.events) {
      if (ev.k === "explode") this.spawnExplosion(ev.px, ev.py, ev.pz, true);
      else if (ev.k === "hit") {
        this.spawnImpact(ev.px, ev.py, ev.pz);
        this.vfx?.play("explosion", new THREE.Vector3(ev.px, ev.py, ev.pz), { scale: 0.55, ttl: 420 });
      } else if (ev.k === "fire") {
        this.vfx?.play("muzzleFlash", new THREE.Vector3(ev.px, ev.py, ev.pz), { scale: 0.9, ttl: 120 });
      } else if (ev.k === "impact") this.spawnImpact(ev.px, ev.py, ev.pz);
      else if (ev.k === "reward") this.spawnPickup(ev.px, ev.py, ev.pz);
    }
  }

  // ---- loop -----------------------------------------------------------------

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());

    // Camera modes are mothership-only — snap back to chase-flight otherwise.
    if (this.camMode !== "follow" && this.camMode !== "intro" && !this.controllingMother())
      this.camMode = "follow";

    const ceid = this.controlledEntityId;
    // In orbit/free survey modes the carrier parks (we stop sending input, so the
    // server simply doesn't step it) and WASD/mouse drive the camera instead.
    if (this.status === "connected" && this.selfId && ceid && this.camMode === "follow") {
      const cmd = this.sampleInput(dt);
      // Gate boost on the heat gauge: an overheated afterburner stays locked out
      // until it cools below recoverAt, so the server-side boost speed and the
      // plume both respect the lockout (we send the gated flag, not the raw key).
      if (this.boostLocked) cmd.boost = false;
      this.socket.send({ t: "input", cmd });
      // Drive the local plume spike off the (gated) live boost input + alive state.
      this.selfBoosting = cmd.boost && this.self.alive;
      if (this.self.alive) {
        stepShip(this.self, cmd, dt);
        this.pending.push(cmd);
        if (this.pending.length > 240) this.pending.shift();
      }
    } else {
      // Not actively flying (orbit/free survey/disconnected) — no afterburner.
      this.selfBoosting = false;
    }

    // Afterburner heat: builds while boosting, bleeds off otherwise (clamped 0..1).
    const heatRate = this.selfBoosting ? AFTERBURNER.heatPerSec : -AFTERBURNER.coolPerSec;
    this.boostHeat = Math.max(0, Math.min(1, this.boostHeat + heatRate * dt));
    // Latch the overheat lockout at max heat; release once cooled below recoverAt.
    // Count the false→true / true→false edges so the HUD can fire a one-shot
    // alarm + red flash on lockout and a softer "ready again" chirp on recovery.
    const wasLocked = this.boostLocked;
    if (this.boostHeat >= 1) this.boostLocked = true;
    else if (this.boostLocked && this.boostHeat <= AFTERBURNER.recoverAt)
      this.boostLocked = false;
    if (this.boostLocked && !wasLocked) this.overheatPulse++;
    else if (!this.boostLocked && wasLocked) this.boostReadyPulse++;

    this.updateSelfMesh();
    this.updateRemotes();
    this.updatePlatforms();
    this.updateCelestials();
    this.updateRewards();
    this.updateOutposts();
    this.updateBeams();
    this.updateProjectiles();
    this.updateTurrets(dt);
    this.updateThrusters(dt);
    this.vfx?.update(dt);
    this.updateCamera(dt);
    this.updateTutorial();

    // Keep sun billboard always facing camera
    if (this.sunBillboard) this.sunBillboard.lookAt(this.camera.position);

    this.renderer.render(this.scene, this.camera);
    this.pushHud();
  };

  private updateSelfMesh(): void {
    // The hull follows whatever entity we currently control: rebuild it when the
    // controlled kind/role changes (e.g. fighter → carrier → fleet unit).
    const ceid = this.controlledEntityId;
    const auth = ceid ? this.latestEntities.get(ceid) : undefined;
    const ent = auth ?? this.self;
    const key = `${ent.kind}:${ent.role}:${ent.shipType}:${ent.faction ?? ""}`;
    if (key !== this.selfGroupKey || !this.selfGroup) {
      if (this.selfGroup) {
        this.disposeMother(this.selfGroup);
        this.disposeEntityExtras(this.selfGroup);
        this.scene.remove(this.selfGroup);
        disposeGroup(this.selfGroup);
      }
      this.selfGroup = this.makeEntityGroup(ent);
      this.scene.add(this.selfGroup);
      this.selfGroupKey = key;
    }
    this.selfGroup.position.set(this.self.px, this.self.py, this.self.pz);
    applyOrientation(this.selfGroup, this.self.yaw, this.self.pitch, this.self.roll);
    this.selfGroup.visible = this.self.alive;
    // Tag/shield use the authoritative entity (shield/uid live there); the
    // predicted `this.self` only carries transform + a stale name.
    this.updateEntityDecor(this.selfGroup, auth ?? this.self);
  }

  // ---- platforms ------------------------------------------------------------

  private updatePlatforms(): void {
    const t = performance.now() * 0.001;
    const live = new Set(this.latestPlatforms.map((p) => p.id));
    for (const [id, view] of [...this.platformViews]) {
      if (!live.has(id)) this.removePlatformView(id, view);
    }
    for (const plat of this.latestPlatforms) {
      let view = this.platformViews.get(plat.id);
      if (!view) {
        const { group, body } = this.makePlatformGroup(plat.kind);
        this.scene.add(group);
        const cableMat = makePlasmaMaterial(0x66ccff);
        const cable = new THREE.Mesh(this.beamGeo, cableMat);
        this.scene.add(cable);
        view = { group, body, glb: null, cable, cableMat };
        this.platformViews.set(plat.id, view);
        this.ensurePlatformTemplate();
      }
      // Tether the platform to the (interpolated) carrier so it tracks smoothly.
      const mp = this.entityRenderPos(plat.motherShipId);
      const ang = (plat.slot / PLATFORM.maxPerPlayer) * Math.PI * 2;
      const px = mp.x + Math.cos(ang) * PLATFORM.cableLength;
      const py = mp.y + PLATFORM.offsetY;
      const pz = mp.z + Math.sin(ang) * PLATFORM.cableLength;
      view.group.position.set(px, py, pz);
      view.group.rotation.y += 0.004;
      orientBeam(view.cable, mp.x, mp.y, mp.z, px, py, pz, 1.1);
      view.cableMat.uniforms.uTime.value = t;
    }
  }

  /** Procedural platform tile + capability light, coloured by kind. */
  private makePlatformGroup(kind: PlatformKind): { group: THREE.Group; body: THREE.Object3D } {
    const group = new THREE.Group();
    const color = new THREE.Color(PLATFORM_COLORS[kind]);
    // Platforms are small docked installations next to the city-sized
    // mothership — was a ~50m disc, which read ~100x too large in the fleet.
    const pf = SHIP_FIT * 0.2; // ~8m platform footprint
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(pf * 0.42, pf * 0.48, pf * 0.14, 8),
      new THREE.MeshStandardMaterial({
        color: 0x2b3242, roughness: 0.7, metalness: 0.5,
        emissive: color, emissiveIntensity: 0.25,
      }),
    );
    group.add(body);
    const beacon = new THREE.Mesh(
      new THREE.IcosahedronGeometry(pf * 0.12, 0),
      new THREE.MeshBasicMaterial({ color }),
    );
    beacon.position.y = pf * 0.32;
    group.add(beacon);
    const light = new THREE.PointLight(color, 1.4, SHIP_FIT * 2, 2);
    light.position.y = pf * 0.45;
    group.add(light);
    return { group, body };
  }

  /** Lazy-load the platform GLB once; swap each platform's procedural tile. */
  private ensurePlatformTemplate(): void {
    if (this.platformTemplate) { this.applyPlatformTemplate(); return; }
    if (this.platformLoading) return;
    this.platformLoading = true;
    loadAsset("environment/carrier/cyberpunk-platform")
      .then((m: LoadedModel) => {
        if (this.disposed) return;
        this.platformTemplate = m.scene;
        this.applyPlatformTemplate();
      })
      .catch(() => { /* keep procedural tiles */ })
      .finally(() => { this.platformLoading = false; });
  }

  private applyPlatformTemplate(): void {
    const tpl = this.platformTemplate;
    if (!tpl) return;
    for (const view of this.platformViews.values()) {
      if (view.glb) continue;
      const clone = tpl.clone(true);
      // clone(true) SHARES geometry with the loadAsset template; flag it so
      // disposeGroup frees only the owned materials, never the cached geometry.
      clone.traverse((o) => { if (o instanceof THREE.Mesh) o.userData.sharedGeo = true; });
      fitObject(clone, SHIP_FIT * 0.2);
      view.group.remove(view.body);
      disposeGroup(view.body); // procedural tile is owned — safe to dispose
      view.group.add(clone);
      view.body = clone;
      view.glb = clone;
    }
  }

  /** Remove a platform view; GLB clones share template geo/mats so DETACH them. */
  private removePlatformView(
    id: string,
    view: { group: THREE.Group; body: THREE.Object3D; glb: THREE.Object3D | null; cable: THREE.Mesh; cableMat: THREE.ShaderMaterial },
  ): void {
    if (view.glb) view.group.remove(view.glb);
    this.scene.remove(view.group);
    disposeGroup(view.group);
    this.scene.remove(view.cable);
    view.cableMat.dispose();
    this.platformViews.delete(id);
  }

  /** Best rendered position for an entity (controlled self / remote / snapshot). */
  private entityRenderPos(id: string): THREE.Vector3 {
    if (id === this.controlledEntityId)
      return _scratch.set(this.self.px, this.self.py, this.self.pz);
    const remote = this.remotes.get(id);
    if (remote) return _scratch.copy(remote.group.position);
    const e = this.latestEntities.get(id);
    if (e) return _scratch.set(e.px, e.py, e.pz);
    return _scratch.set(0, 0, 0);
  }

  // ---- become / build -------------------------------------------------------

  /** Request direct control of any owned hull (fighter, carrier, or fleet unit). */
  become(entityId: string): void {
    if (this.status !== "connected" || !this.selfId) return;
    const e = this.latestEntities.get(entityId);
    if (!e || e.owner !== this.selfId || !e.alive) return;
    if (entityId === this.controlledEntityId) return;
    if (e.kind !== "mother_ship") this.lastPilotedId = entityId;
    else if (this.controlledEntityId && this.controlledEntityId !== this.motherShipId) {
      this.lastPilotedId = this.controlledEntityId;
    }
    this.socket.send({ t: "become", entityId });
  }

  /**
   * Toggle escort/summon on one owned fleet unit (server validates ownership +
   * that it isn't the piloted ship, and toggles the escort on/off). The local
   * `escorting` set mirrors the toggle optimistically to badge the Fleet Log.
   */
  summon(entityId: string): void {
    if (this.status !== "connected" || !this.selfId) return;
    const e = this.latestEntities.get(entityId);
    if (!e || e.owner !== this.selfId || !e.alive) return;
    if (e.kind !== "fleet_unit" || e.role === "none") return;
    if (entityId === this.controlledEntityId) return;
    if (this.escorting.has(entityId)) this.escorting.delete(entityId);
    else this.escorting.add(entityId);
    this.socket.send({ t: "summon", entityId });
  }

  /** Request the carrier to build a tethered platform of `kind`. */
  build(kind: PlatformKind): void {
    if (this.status !== "connected") return;
    this.socket.send({ t: "build", kind });
  }

  /**
   * Tab toggles between the mothership and the last piloted hull (fighter,
   * drone, etc.) — not a full roster cycle. Use Fleet Log clicks to jump to
   * any specific ship.
   */
  private cycleControl(): void {
    if (this.status !== "connected" || !this.selfId || !this.motherShipId) return;
    const mother = this.motherShipId;
    const cur = this.controlledEntityId;
    if (cur === mother) {
      const target = this.resolveLastPiloted();
      if (target && target !== mother) this.become(target);
    } else {
      if (cur && cur !== mother) this.lastPilotedId = cur;
      this.become(mother);
    }
  }

  /** Pick the last piloted hull if still alive, else the personal fighter. */
  private resolveLastPiloted(): string | null {
    const mother = this.motherShipId;
    if (this.lastPilotedId && this.lastPilotedId !== mother) {
      const e = this.latestEntities.get(this.lastPilotedId);
      if (e && e.owner === this.selfId && e.alive) return this.lastPilotedId;
    }
    if (this.selfId) {
      const fighter = this.latestEntities.get(this.selfId);
      if (fighter && fighter.alive) return this.selfId;
    }
    for (const e of this.latestEntities.values()) {
      if (e.owner === this.selfId && e.alive && e.kind !== "mother_ship") return e.id;
    }
    return null;
  }

  /** True while the controlled unit is a mothership (camera modes available). */
  private controllingMother(): boolean {
    const auth = this.controlledEntityId
      ? this.latestEntities.get(this.controlledEntityId)
      : undefined;
    return (auth?.kind ?? this.self.kind) === "mother_ship";
  }

  /** V: cycle the mothership camera follow → orbit → free (carriers only). */
  private cycleCamMode(): void {
    if (!this.controllingMother()) { this.camMode = "follow"; return; }
    const order: CamMode[] = ["follow", "orbit", "free"];
    this.camMode = order[(order.indexOf(this.camMode) + 1) % order.length];
    if (this.camMode === "orbit") this.enterOrbit();
    else if (this.camMode === "free") this.enterFree();
  }

  /** B: jump the orbit camera to the next vantage preset. */
  private cycleVantage(): void {
    this.vantageIdx = (this.vantageIdx + 1) % this.vantages.length;
    const v = this.vantages[this.vantageIdx];
    this.orbitYaw = v.yaw;
    this.orbitPitch = v.pitch;
  }

  /** Seed orbit state when entering survey mode from the current framing. */
  private enterOrbit(): void {
    const len = SHIP_FIT * MOTHER_SHIP.scaleFactor;
    this.orbitDist = len * 2.4;
    this.wheelDelta = 0;
    const v = this.vantages[this.vantageIdx];
    this.orbitYaw = v.yaw;
    this.orbitPitch = v.pitch;
  }

  /** Seed free-cam state from the live camera so the view continues smoothly. */
  private enterFree(): void {
    this.freePos.copy(this.camera.position);
    const dir = new THREE.Vector3(this.self.px, this.self.py, this.self.pz)
      .sub(this.freePos)
      .normalize();
    this.freeYaw = Math.atan2(dir.x, dir.z);
    this.freePitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
  }

  private updateRemotes(): void {
    const renderTime = this.serverRenderTime();
    const ceid = this.controlledEntityId;

    for (const [id, entity] of this.latestEntities) {
      if (id === ceid) continue;
      if (!this.remotes.has(id)) {
        const group = this.makeEntityGroup(entity);
        this.scene.add(group);
        // Zone wireframe only for the local commander's own fleet units.
        let zone: THREE.Mesh | null = null;
        if (entity.kind === "fleet_unit" && entity.owner === this.selfId && entity.role !== "none") {
          zone = this.makeZoneMesh(ROLE_COLORS[entity.role]);
          this.scene.add(zone);
        }
        this.remotes.set(id, { group, zone });
      }
    }
    for (const [id, view] of [...this.remotes]) {
      // Drop a remote view when its entity is gone OR when it has become the
      // locally-controlled entity. The latter matters every time you `become` a
      // different ship: the entity you switch TO is still in latestEntities, so
      // without this it keeps its old remote view AND is redrawn as the predicted
      // selfGroup — rendering two of every ship you take control of.
      if (!this.latestEntities.has(id) || id === ceid) {
        this.disposeMother(view.group);
        this.disposeEntityExtras(view.group);
        this.scene.remove(view.group);
        disposeGroup(view.group);
        if (view.zone) { this.scene.remove(view.zone); disposeGroup(view.zone); }
        this.remotes.delete(id);
      }
    }

    const [a, b] = this.bracket(renderTime);
    for (const [id, view] of this.remotes) {
      const sa = a?.entities.get(id), sb = b?.entities.get(id);
      const s = lerpEntity(sa, sb, a, b, renderTime) ?? this.latestEntities.get(id);
      if (!s) continue;
      view.group.position.set(s.px, s.py, s.pz);
      applyOrientation(view.group, s.yaw, s.pitch, s.roll);
      view.group.visible = s.alive;
      this.updateEntityDecor(view.group, s);
      if (view.zone) {
        view.zone.position.set(s.zoneX, s.zoneY, s.zoneZ);
        view.zone.scale.setScalar(Math.max(1, s.zoneR));
        view.zone.visible = s.alive && s.zoneR > 0;
      }
    }
  }

  /** Short combat label — no long name·uid spam above every hull. */
  private entityLabel(s: EntityState): { text: string; color: string; show: boolean } {
    const ceid = this.controlledEntityId;
    const own = s.owner === this.selfId;
    if (s.id === ceid) return { text: "", color: "#8fe3ff", show: false };
    if (s.team === ENEMY.team) {
      const boss = s.id === BOSS.id;
      return { text: boss ? "DREADLORD" : "HOSTILE", color: "#ff5a45", show: true };
    }
    if (s.kind === "mother_ship") {
      return { text: own ? "CARRIER" : "CAPITAL", color: own ? "#66ddff" : "#aabbcc", show: true };
    }
    if (s.kind === "fleet_unit" && s.role !== "none") {
      const def = fleetRoleDef(s.role);
      return { text: (def?.label ?? s.role).toUpperCase(), color: ROLE_COLORS[s.role], show: true };
    }
    if (own) return { text: s.kind === "fighter" ? "FIGHTER" : "ALLY", color: "#8fe3ff", show: true };
    return { text: "UNIT", color: "#cccccc", show: true };
  }

  /** Per-frame refresh of an entity group's name tag + shield bubble. */
  private updateEntityDecor(g: THREE.Object3D, s: EntityState): void {
    const tag = g.userData.nameTag as THREE.Sprite | undefined;
    if (tag) {
      const label = this.entityLabel(s);
      const dx = s.px - this.self.px, dy = s.py - this.self.py, dz = s.pz - this.self.pz;
      const dist = Math.hypot(dx, dy, dz);
      const maxDist = s.team === ENEMY.team ? 3200 : 2200;
      const show = s.alive && label.show && dist < maxDist;
      if (show) this.setTagText(tag, label.text, label.color);
      tag.visible = show;
      if (show) {
        const scale = Math.max(0.55, Math.min(1.1, 1.2 - dist / maxDist));
        const base = (g.userData.tagBaseScale as number) ?? tag.scale.x;
        tag.scale.set(base * scale, base * 0.22 * scale, 1);
      }
    }
    const bubble = g.userData.shieldBubble as THREE.Mesh | undefined;
    if (bubble) {
      const frac = s.maxShield > 0 ? s.shield / s.maxShield : 0;
      const mat = bubble.material as THREE.MeshBasicMaterial;
      const pulse = 0.85 + 0.15 * Math.sin(performance.now() * 0.004);
      mat.opacity = s.alive ? Math.max(0, Math.min(1, frac)) * 0.28 * pulse : 0;
      bubble.visible = s.alive && frac > 0.02;
      const sc = 1 + frac * 0.08;
      bubble.scale.setScalar(sc);
    }
  }

  private updateProjectiles(): void {
    const now = performance.now();
    const extrap = Math.min(0.12, (now - this.lastSnapAt) / 1000);
    const spin = now * 0.02;
    const seen = new Set<number>();
    for (const [id, p] of this.projs) {
      seen.add(id);
      const isMissile = p.kind === "missile";
      let mesh = this.projMeshes.get(id);
      if (!mesh) {
        mesh = new THREE.Mesh(isMissile ? this.missileGeo : this.projGeo,
          isMissile ? this.missileMat : this.projMat);
        this.scene.add(mesh);
        this.projMeshes.set(id, mesh);
        const trail = this.vfx?.track(
          isMissile ? "projectileTrail" : "fireSparks",
          mesh.position,
          { scale: isMissile ? 2.2 : 1.6, color: isMissile ? "#ff6622" : undefined },
        );
        if (trail) this.projTrails.set(id, trail);
        if (isMissile) this.projHistory.set(id, []);
      }
      mesh.position.set(p.px + p.vx * extrap, p.py + p.vy * extrap, p.pz + p.vz * extrap);
      const sp = Math.hypot(p.vx, p.vy, p.vz);
      if (sp > 1e-3) {
        _bdir.set(p.vx / sp, p.vy / sp, p.vz / sp);
        _bquat.setFromUnitVectors(LOCAL_NOSE, _bdir);
        if (isMissile) {
          mesh.quaternion.copy(_bquat);
          const hist = this.projHistory.get(id)!;
          hist.push(mesh.position.clone());
          if (hist.length > 14) hist.shift();
          if (hist.length >= 3) {
            const curve = new THREE.CatmullRomCurve3(hist, false, "catmullrom", 0.35);
            const pts = curve.getPoints(18);
            let line = this.projSplines.get(id);
            if (!line) {
              const geo = new THREE.BufferGeometry().setFromPoints(pts);
              line = new THREE.Line(geo, new THREE.LineBasicMaterial({
                color: 0xff8844, transparent: true, opacity: 0.55,
                depthWrite: false, blending: THREE.AdditiveBlending,
              }));
              this.scene.add(line);
              this.projSplines.set(id, line);
            } else {
              (line.geometry as THREE.BufferGeometry).setFromPoints(pts);
            }
          }
        } else {
          _spinQ.setFromAxisAngle(_bdir, spin);
          mesh.quaternion.copy(_spinQ).multiply(_bquat);
        }
      }
      this.projTrails.get(id)?.setPosition(mesh.position);
    }
    for (const [id, mesh] of [...this.projMeshes]) {
      if (!seen.has(id)) {
        this.scene.remove(mesh);
        this.projMeshes.delete(id);
        const trail = this.projTrails.get(id);
        if (trail) { trail.stop(); this.projTrails.delete(id); }
        const line = this.projSplines.get(id);
        if (line) {
          this.scene.remove(line);
          line.geometry.dispose();
          (line.material as THREE.Material).dispose();
          this.projSplines.delete(id);
        }
        this.projHistory.delete(id);
      }
    }
  }

  private updateCamera(dt: number): void {
    if (this.camMode === "intro") { this.updateIntroCamera(dt); return; }
    if (this.camMode === "orbit") { this.updateOrbitCamera(dt); return; }
    if (this.camMode === "free") { this.updateFreeCamera(dt); return; }

    const [fx, fy, fz] = forwardVec(this.self.yaw, this.self.pitch);
    const fwd = new THREE.Vector3(fx, fy, fz).normalize();

    // Frame the shot for whatever we're piloting. The controlled kind comes from
    // the authoritative entity (this.self only carries predicted transform), so a
    // capital ship gets a pulled-back, softer, free-flowing follow that keeps the
    // whole hull in view, while fighters keep their snappy chase.
    const auth = this.controlledEntityId
      ? this.latestEntities.get(this.controlledEntityId)
      : undefined;
    const kind = auth?.kind ?? this.self.kind;
    let distance: number = CAMERA.distance, height: number = CAMERA.height,
      lead: number = CAMERA.lead, lerp: number = CAMERA.lerp;
    if (kind === "mother_ship") {
      const len = SHIP_FIT * MOTHER_SHIP.scaleFactor;
      distance = len * CAMERA.mother.distMul;
      height = len * CAMERA.mother.heightMul;
      lead = len * CAMERA.mother.leadMul;
      lerp = CAMERA.mother.lerp;
    } else if (kind === "fleet_unit") {
      distance = CAMERA.fleet.distance;
      height = CAMERA.fleet.height;
      lead = CAMERA.fleet.lead;
      lerp = CAMERA.fleet.lerp;
    }

    const desired = new THREE.Vector3(
      this.self.px - fwd.x * distance,
      this.self.py - fwd.y * distance + height,
      this.self.pz - fwd.z * distance,
    );
    const k = Math.min(1, lerp * dt);
    this.camera.position.lerp(desired, k);
    const look = new THREE.Vector3(
      this.self.px + fwd.x * lead,
      this.self.py + fwd.y * lead,
      this.self.pz + fwd.z * lead,
    );
    this.camera.lookAt(look);

    const sp = Math.hypot(this.self.vx, this.self.vy, this.self.vz);
    const boosting = sp > SHIP.maxSpeed + 1;
    const targetFov = CAMERA.fov + (boosting ? CAMERA.boostFovKick : 0);
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, 6 * dt);
    this.camera.updateProjectionMatrix();
  }

  // ---- opening cinematic + flight training ---------------------------------

  /** Begin the opening fly-around. Called by the launcher once the hyperspace
   *  intro overlay clears (we are connected + the ship is visible). */
  beginCinematic(): void {
    if (this.cinematicActive || this.tutorialStep === -1) return;
    this.introT = 0;
    this.cinematicActive = true;
    this.camMode = "intro";
  }

  /** Skip the cinematic from the HUD button (same as the in-canvas skip keys). */
  skipCinematic(): void {
    this.endCinematic();
  }

  /** Finish the cinematic, hand control back to follow-cam, and start training. */
  private endCinematic(): void {
    if (!this.cinematicActive) return;
    this.cinematicActive = false;
    if (this.camMode === "intro") this.camMode = "follow";
    this.tutorialStep = 1;
    this.tutorialStepAt = performance.now();
  }

  /**
   * Cinematic fly-around: a sweeping orbit of the ship you're about to pilot
   * that pulls in from high/wide and ends directly behind the hull so the
   * hand-off to the chase cam is seamless. Input is gated off (the loop only
   * samples input in "follow"), so the player just watches.
   */
  private updateIntroCamera(dt: number): void {
    this.introT += dt;
    const t = Math.min(1, this.introT / CINEMATIC_DUR);
    const e = t * t * (3 - 2 * t); // smoothstep

    const center = new THREE.Vector3(this.self.px, this.self.py, this.self.pz);
    const [fx, fy, fz] = forwardVec(this.self.yaw, this.self.pitch);
    const fwd = new THREE.Vector3(fx, fy, fz).normalize();

    // Match the follow-cam framing for the controlled kind so t=1 lines up.
    const auth = this.controlledEntityId
      ? this.latestEntities.get(this.controlledEntityId)
      : undefined;
    const kind = auth?.kind ?? this.self.kind;
    let followDist: number = CAMERA.distance, followHeight: number = CAMERA.height;
    if (kind === "mother_ship") {
      const len = SHIP_FIT * MOTHER_SHIP.scaleFactor;
      followDist = len * CAMERA.mother.distMul;
      followHeight = len * CAMERA.mother.heightMul;
    } else if (kind === "fleet_unit") {
      followDist = CAMERA.fleet.distance;
      followHeight = CAMERA.fleet.height;
    }

    // Azimuth sweeps ~1.25 turns, landing behind the ship (-fwd direction).
    const behind = Math.atan2(-fwd.x, -fwd.z);
    const sweep = Math.PI * 2 * 1.25;
    const az = behind - sweep * (1 - e);

    const dist = THREE.MathUtils.lerp(followDist * 3.2 + 120, followDist, e);
    const height = THREE.MathUtils.lerp(followHeight * 2.4 + 80, followHeight, e);
    const bob = Math.sin(this.introT * 0.7) * height * 0.06 * (1 - e);

    const off = new THREE.Vector3(Math.sin(az) * dist, height + bob, Math.cos(az) * dist);
    const desired = center.clone().add(off);
    this.camera.position.lerp(desired, Math.min(1, 4 * dt));

    // Look slightly ahead of the hull as we settle, matching the chase look.
    const look = center.clone().addScaledVector(fwd, followDist * 0.15 * e);
    this.camera.lookAt(look);

    const targetFov = THREE.MathUtils.lerp(CAMERA.fov + 14, CAMERA.fov, e);
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, 4 * dt);
    this.camera.updateProjectionMatrix();

    if (t >= 1) this.endCinematic();
  }

  /** Advance the flight-training sequence (called every frame). */
  private updateTutorial(): void {
    if (this.tutorialStep <= 0) return; // not started or finished
    const idx = this.tutorialStep - 1;
    if (idx >= TUTORIAL_STEPS.length) { this.tutorialStep = -1; return; }
    const now = performance.now();
    const elapsed = now - this.tutorialStepAt;
    const def = TUTORIAL_STEPS[idx];
    const ready = elapsed > def.maxMs || (elapsed > 800 && this.tutorialStepDone(this.tutorialStep));
    if (!ready) return;
    this.tutorialStep += 1;
    this.tutorialStepAt = now;
    if (this.tutorialStep > TUTORIAL_STEPS.length) this.tutorialStep = -1;
  }

  /** Whether the player has performed the action for a given 1-based step. */
  private tutorialStepDone(step: number): boolean {
    const k = this.keys;
    const sp = Math.hypot(this.self.vx, this.self.vy, this.self.vz);
    switch (step) {
      case 1: return sp > 6;
      case 2: return k.has("KeyA") || k.has("KeyD") || k.has("ArrowLeft") ||
                     k.has("ArrowRight") || k.has("ArrowUp") || k.has("ArrowDown");
      case 3: return k.has("ShiftLeft") || k.has("ShiftRight") || sp > SHIP.maxSpeed + 1;
      case 4: return k.has("Space") || k.has("KeyF") || this.mouseBtns.has(0);
      default: return false; // info steps advance on their timeout
    }
  }

  /** The HUD prompt for the active training step, or null. */
  private tutorialHint(): TutorialHint | null {
    if (this.tutorialStep <= 0) return null;
    const idx = this.tutorialStep - 1;
    if (idx >= TUTORIAL_STEPS.length) return null;
    const def = TUTORIAL_STEPS[idx];
    return { title: def.title, body: def.body, step: this.tutorialStep, total: TUTORIAL_STEPS.length };
  }

  /** Survey/orbit camera: the carrier is parked; the camera orbits the hull. */
  private updateOrbitCamera(dt: number): void {
    const len = SHIP_FIT * MOTHER_SHIP.scaleFactor;
    const center = new THREE.Vector3(this.self.px, this.self.py, this.self.pz);

    // Mouse drags the orbit; a gentle auto-spin keeps the survey cinematic.
    this.orbitYaw += this.mouseDx * 0.004 + dt * 0.05;
    this.orbitPitch += this.mouseDy * 0.004 * (this.invertY ? -1 : 1);
    this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch, -1.45, 1.45);
    this.mouseDx = 0;
    this.mouseDy = 0;

    // Wheel zoom, clamped so the whole hull stays in (and never inside the) frame.
    if (this.wheelDelta !== 0) {
      this.orbitDist *= 1 + Math.sign(this.wheelDelta) * 0.08;
      this.wheelDelta = 0;
    }
    this.orbitDist = THREE.MathUtils.clamp(this.orbitDist, len * 1.1, len * 7);

    const cp = Math.cos(this.orbitPitch);
    const off = new THREE.Vector3(
      Math.sin(this.orbitYaw) * cp,
      Math.sin(this.orbitPitch),
      Math.cos(this.orbitYaw) * cp,
    ).multiplyScalar(this.orbitDist);
    const desired = center.clone().add(off);
    this.camera.position.lerp(desired, Math.min(1, 6 * dt));
    this.camera.lookAt(center);

    const targetFov = CAMERA.fov;
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, 6 * dt);
    this.camera.updateProjectionMatrix();
  }

  /** Detached free-fly camera: WASD + QE/Space/Shift to move, mouse to look. */
  private updateFreeCamera(dt: number): void {
    const len = SHIP_FIT * MOTHER_SHIP.scaleFactor;
    this.freeYaw -= this.mouseDx * 0.0025;
    this.freePitch += -this.mouseDy * 0.0025 * (this.invertY ? -1 : 1);
    this.freePitch = THREE.MathUtils.clamp(this.freePitch, -1.45, 1.45);
    this.mouseDx = 0;
    this.mouseDy = 0;

    const cp = Math.cos(this.freePitch);
    const forward = new THREE.Vector3(
      Math.sin(this.freeYaw) * cp,
      Math.sin(this.freePitch),
      Math.cos(this.freeYaw) * cp,
    ).normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

    const k = this.keys;
    const down = (...codes: string[]) => codes.some((c) => k.has(c));
    const boost = down("ShiftLeft", "ShiftRight") ? 2.6 : 1;
    const speed = len * 0.9 * boost * dt;
    const move = new THREE.Vector3();
    if (down("KeyW")) move.add(forward);
    if (down("KeyS")) move.sub(forward);
    if (down("KeyD", "ArrowRight")) move.add(right);
    if (down("KeyA", "ArrowLeft")) move.sub(right);
    if (down("Space", "KeyE")) move.y += 1;
    if (down("KeyQ", "ControlLeft")) move.y -= 1;
    if (move.lengthSq() > 0) this.freePos.addScaledVector(move.normalize(), speed);

    this.camera.position.copy(this.freePos);
    this.camera.lookAt(this.freePos.clone().add(forward));

    const targetFov = CAMERA.fov;
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, 6 * dt);
    this.camera.updateProjectionMatrix();
  }

  private spawnExplosion(x: number, y: number, z: number, big = false): void {
    const pos = new THREE.Vector3(x, y, z);
    this.vfx?.play("explosion", pos, { scale: big ? 1.4 : 0.85, ttl: big ? 900 : 600 });
    const mat = new THREE.MeshBasicMaterial({ color: 0xff6622, transparent: true, opacity: 0.9 });
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(SCALE.ship.miner * (big ? 1.6 : 1), 10, 10),
      mat,
    );
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    const born = performance.now();
    const dur = big ? 950 : 700;
    const tick = () => {
      if (this.disposed) return;
      const t = (performance.now() - born) / dur;
      if (t >= 1) { this.scene.remove(mesh); mesh.geometry.dispose(); mat.dispose(); return; }
      mesh.scale.setScalar(1 + t * (big ? 18 : 12));
      mat.opacity = 0.9 * (1 - t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    if (big) this.ensureExplosionTemplate(x, y, z);
  }

  /** Lazy-load the 19 MB explosion GLB; spawn a clone at (x,y,z) when ready. */
  private ensureExplosionTemplate(x: number, y: number, z: number): void {
    if (this.explosionTemplate) { this.spawnGlbBurst(x, y, z); return; }
    if (this.explosionLoading) return;
    this.explosionLoading = true;
    loadAsset("props/carrier/sphere-explosion")
      .then((m: LoadedModel) => {
        if (this.disposed) return;
        this.explosionTemplate = m.scene;
      })
      .catch(() => { /* keep the procedural fallback */ })
      .finally(() => { this.explosionLoading = false; });
  }

  private spawnGlbBurst(x: number, y: number, z: number): void {
    const tpl = this.explosionTemplate;
    if (!tpl || this.disposed) return;
    const obj = tpl.clone(true);
    // clone(true) SHARES geometry with the loadAsset template; flag it so
    // disposeGroup frees only the owned materials, never the cached geometry.
    obj.traverse((o) => { if (o instanceof THREE.Mesh) o.userData.sharedGeo = true; });
    fitObject(obj, SCALE.ship.attack * 1.5);
    obj.position.set(x, y, z);
    this.scene.add(obj);
    const born = performance.now();
    const tick = () => {
      if (this.disposed) { disposeGroup(obj); return; }
      const t = (performance.now() - born) / 600;
      if (t >= 1) { this.scene.remove(obj); disposeGroup(obj); return; }
      obj.scale.setScalar(0.4 + t * 1.8);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** Brief bright flash where a body collides with a celestial / projectile. */
  private spawnImpact(x: number, y: number, z: number): void {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xfff0a0, transparent: true, opacity: 0.95, depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(SCALE.ship.miner * 0.8, 8, 8), mat);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    const born = performance.now();
    const tick = () => {
      if (this.disposed) { mesh.geometry.dispose(); mat.dispose(); return; }
      const t = (performance.now() - born) / 350;
      if (t >= 1) { this.scene.remove(mesh); mesh.geometry.dispose(); mat.dispose(); return; }
      mesh.scale.setScalar(1 + t * 6);
      mat.opacity = 0.95 * (1 - t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** Expanding gold ring when a reward box is collected. */
  private spawnPickup(x: number, y: number, z: number): void {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd23f, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.RingGeometry(2, 3.4, 24), mat);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    const born = performance.now();
    const tick = () => {
      if (this.disposed) { mesh.geometry.dispose(); mat.dispose(); return; }
      const t = (performance.now() - born) / 500;
      if (t >= 1) { this.scene.remove(mesh); mesh.geometry.dispose(); mat.dispose(); return; }
      mesh.lookAt(this.camera.position);
      mesh.scale.setScalar(1 + t * 14);
      mat.opacity = 0.9 * (1 - t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---- celestials / rewards / beams -----------------------------------------

  private updateCelestials(): void {
    const renderTime = this.serverRenderTime();
    const [a, b] = this.bracket(renderTime);

    for (const [id, body] of this.latestCelestials) {
      if (!this.celestialViews.has(id)) {
        const g = this.makeCelestial(body);
        this.scene.add(g);
        this.celestialViews.set(id, g);
      }
    }
    for (const [id, g] of [...this.celestialViews]) {
      if (!this.latestCelestials.has(id)) {
        this.scene.remove(g);
        disposeGroup(g);
        this.celestialViews.delete(id);
      }
    }

    for (const [id, g] of this.celestialViews) {
      const ca = a?.celestials.get(id), cb = b?.celestials.get(id);
      let px = 0, py = 0, pz = 0;
      if (ca && cb && a && b && b.time > a.time) {
        const f = Math.max(0, Math.min(1, (renderTime - a.time) / (b.time - a.time)));
        px = ca.px + (cb.px - ca.px) * f;
        py = ca.py + (cb.py - ca.py) * f;
        pz = ca.pz + (cb.pz - ca.pz) * f;
      } else {
        const cur = this.latestCelestials.get(id);
        if (!cur) continue;
        px = cur.px; py = cur.py; pz = cur.pz;
      }
      g.position.set(px, py, pz);
      g.rotation.y += 0.02 * (g.userData.spin as number);
    }
  }

  private makeCelestial(body: CelestialBody): THREE.Group {
    const g = new THREE.Group();
    const palette: Record<string, { base: number; emissive: number }> = {
      planet: { base: 0x6b8cae, emissive: 0x16243a },
      comet: { base: 0xbfe6ff, emissive: 0x335577 },
      asteroid: { base: 0x8a7f72, emissive: 0x1a1410 },
    };
    const c = palette[body.kind];
    const detail = body.kind === "planet" ? 2 : 1;
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(body.radius, detail),
      new THREE.MeshStandardMaterial({
        color: c.base, emissive: c.emissive, roughness: 0.95, metalness: 0.05, flatShading: body.kind !== "planet",
      }),
    );
    g.add(mesh);

    // A faint force-field halo coloured by gravity (blue) vs push (orange).
    const halo = new THREE.Mesh(
      this.haloGeo,
      new THREE.MeshBasicMaterial({
        color: body.force === "gravity" ? 0x3366ff : 0xff8833,
        transparent: true, opacity: 0.05, side: THREE.BackSide, depthWrite: false,
      }),
    );
    halo.scale.setScalar(body.forceRadius);
    g.add(halo);

    g.userData.spin = ((body.seed % 7) - 3) * 0.3 || 1;
    return g;
  }

  /** Lazy-load the Lootbox pickup GLB once; reward views fall back to the
   *  procedural gem until (and unless) it resolves.  Client-only visual. */
  private ensureLootbox(): void {
    if (this.lootboxReq) return;
    this.lootboxReq = true;
    loadAsset("props/pickups/lootbox")
      .then((m: LoadedModel) => { if (!this.disposed) this.lootboxTpl = m.scene; })
      .catch(() => { /* keep the procedural gem fallback */ });
  }

  private updateRewards(): void {
    const t = performance.now() / 1000;
    this.ensureLootbox();
    for (const r of this.latestRewards) {
      let view = this.rewardViews.get(r.id);
      if (!view) {
        const group = new THREE.Group();
        if (this.lootboxTpl) {
          // Clone the shared template: geometry stays shared (flagged so
          // disposeGroup never frees it), materials are cloned so each cache
          // owns — and safely disposes — its own.
          const box = this.lootboxTpl.clone(true);
          box.traverse((o) => {
            if (o instanceof THREE.Mesh) {
              o.userData.sharedGeo = true;
              const mm = o.material;
              o.material = Array.isArray(mm)
                ? mm.map((x) => (x as THREE.Material).clone())
                : (mm as THREE.Material).clone();
            }
          });
          fitObject(box, r.radius * 1.2);
          group.add(box);
        } else {
          const mat = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.95 });
          const core = new THREE.Mesh(this.rewardGeo, mat);
          core.scale.setScalar(r.radius * 0.42);
          group.add(core);
        }
        const haloMat = new THREE.MeshBasicMaterial({
          color: 0xffe89a, transparent: true, opacity: 0.18, side: THREE.BackSide, depthWrite: false,
        });
        const halo = new THREE.Mesh(this.haloGeo, haloMat);
        halo.scale.setScalar(r.radius);
        group.add(halo);
        const light = new THREE.PointLight(0xffd23f, 1.6, r.radius * 8, 2);
        group.add(light);
        this.scene.add(group);
        view = { group, halo };
        this.rewardViews.set(r.id, view);
      }
      view.group.position.set(r.px, r.py, r.pz);
      view.group.visible = r.active;
      view.group.rotation.y = t * 1.2;
      view.group.rotation.x = t * 0.7;
      const pulse = 0.85 + Math.sin(t * 4 + r.px) * 0.15;
      view.halo.scale.setScalar(r.radius * pulse);
    }
    const live = new Set(this.latestRewards.map((r) => r.id));
    for (const [id, view] of [...this.rewardViews]) {
      if (!live.has(id)) {
        this.scene.remove(view.group);
        disposeGroup(view.group);
        this.rewardViews.delete(id);
      }
    }
  }

  /** Beacon per outpost: a status ring (red contested / green cleared) + a tall
   *  light column you can spot across the arena, plus a slowly-spinning core. */
  private updateOutposts(): void {
    const t = performance.now() / 1000;
    for (const o of this.latestOutposts) {
      let view = this.outpostViews.get(o.id);
      if (!view) {
        const group = new THREE.Group();
        const coreMat = new THREE.MeshBasicMaterial({ color: 0xffd0cb });
        const core = new THREE.Mesh(this.outpostCoreGeo, coreMat);
        core.scale.setScalar(o.radius * 0.5);
        group.add(core);

        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xff3b30, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
        });
        const ring = new THREE.Mesh(this.outpostRingGeo, ringMat);
        ring.rotation.x = Math.PI / 2;
        ring.scale.setScalar(o.radius * 1.7);
        group.add(ring);

        const columnMat = new THREE.MeshBasicMaterial({
          color: 0xff3b30, transparent: true, opacity: 0.16,
          side: THREE.DoubleSide, depthWrite: false,
        });
        const column = new THREE.Mesh(this.outpostColumnGeo, columnMat);
        column.scale.set(o.radius * 0.5, 6000, o.radius * 0.5);
        column.position.y = 3000;
        group.add(column);

        const light = new THREE.PointLight(0xff3b30, 2.4, o.radius * 18, 2);
        group.add(light);

        this.scene.add(group);
        view = { group, coreMat, ringMat, columnMat, light, ring };
        this.outpostViews.set(o.id, view);
      }
      view.group.position.set(o.px, o.py, o.pz);
      const col = o.cleared ? 0x2bd96b : 0xff3b30;
      view.ringMat.color.setHex(col);
      view.columnMat.color.setHex(col);
      view.light.color.setHex(col);
      view.coreMat.color.setHex(o.cleared ? 0x9affc4 : 0xffd0cb);
      view.group.rotation.y = t * 0.4;
      const pulse = 1 + Math.sin(t * 3 + o.px) * 0.08;
      view.ring.scale.setScalar(o.radius * 1.7 * pulse);
    }
    const live = new Set(this.latestOutposts.map((o) => o.id));
    for (const [id, view] of [...this.outpostViews]) {
      if (!live.has(id)) {
        this.removeOutpostView(view);
        this.outpostViews.delete(id);
      }
    }
  }

  /** Tear down one outpost beacon. Disposes only the per-view owned materials +
   *  light — never the SHARED geometries (those are freed once in dispose()). */
  private removeOutpostView(view: {
    group: THREE.Group;
    coreMat: THREE.MeshBasicMaterial;
    ringMat: THREE.MeshBasicMaterial;
    columnMat: THREE.MeshBasicMaterial;
    light: THREE.PointLight;
  }): void {
    this.scene.remove(view.group);
    view.coreMat.dispose();
    view.ringMat.dispose();
    view.columnMat.dispose();
    view.light.dispose();
  }

  private updateBeams(): void {
    const t = performance.now() * 0.001;
    const live = new Set(this.latestBeams.map((b) => b.id));
    for (const [id, view] of [...this.beamViews]) {
      if (!live.has(id)) {
        this.scene.remove(view.mesh);
        view.mat.dispose();
        this.beamViews.delete(id);
      }
    }
    for (const b of this.latestBeams) {
      let view = this.beamViews.get(b.id);
      if (!view) {
        const mat = b.kind === "mining"
          ? makeMiningMaterial(0x66ffcc)
          : makeLaserMaterial(b.team === ENEMY.team ? 0xff3b30 : 0x33d4ff);
        const mesh = new THREE.Mesh(this.beamGeo, mat);
        this.scene.add(mesh);
        view = { mesh, mat };
        this.beamViews.set(b.id, view);
      }
      view.mat.uniforms.uTime.value = t;
      orientBeam(view.mesh, b.sx, b.sy, b.sz, b.tx, b.ty, b.tz, b.kind === "mining" ? 7 : 2.2);
    }
  }

  // ---- interpolation helpers ------------------------------------------------

  private serverRenderTime(): number {
    if (this.clockOffset === null) return 0;
    return performance.now() + this.clockOffset - INTERP_DELAY_MS;
  }

  private bracket(t: number): [SnapEntry | null, SnapEntry | null] {
    let a: SnapEntry | null = null, b: SnapEntry | null = null;
    for (let i = 0; i < this.snaps.length; i++) {
      const s = this.snaps[i];
      if (s.time <= t) a = s;
      if (s.time >= t) { b = s; break; }
    }
    return [a ?? b, b ?? a];
  }

  // ---- HUD ------------------------------------------------------------------

  private pushHud(): void {
    const rows: ScoreRow[] = [];
    for (const eco of this.latestEconomy) {
      const entity = this.latestEntities.get(eco.controlledEntityId);
      if (!entity) continue;
      rows.push({ id: eco.playerId, name: entity.name, kills: entity.kills,
        deaths: entity.deaths, you: eco.playerId === this.selfId });
    }
    rows.sort((p, q) => q.kills - p.kills || p.deaths - q.deaths);

    const ceid = this.controlledEntityId;
    const auth = ceid ? this.latestEntities.get(ceid) : undefined;
    const hp = auth?.hp ?? this.self.hp;
    const alive = auth?.alive ?? this.self.alive;
    const respawnIn = auth && !auth.alive && auth.respawnAt > 0
      ? Math.max(0, (auth.respawnAt - Date.now()) / 1000) : 0;
    const sp = Math.hypot(this.self.vx, this.self.vy, this.self.vz);

    // Hull-damage detection for the cockpit hit cue: bump a monotonic pulse
    // whenever the controlled unit's hp drops between frames. Reset tracking
    // when control switches or the unit is dead, so swapping units / respawning
    // (a fresh full hull) never reads as taking damage.
    if (ceid !== this.lastCueEntityId || !alive) {
      this.lastCueEntityId = ceid;
      this.lastCueHp = hp;
    } else if (hp < this.lastCueHp - 0.001) {
      this.damagePulse++;
      this.lastCueHp = hp;
    } else if (hp > this.lastCueHp) {
      // Healed / regenerated — track upward so the next dip measures fresh.
      this.lastCueHp = hp;
    }

    // Economy + fleet for the local commander.
    const myEco = this.latestEconomy.find((e) => e.playerId === this.selfId);
    const credits = myEco?.credits ?? 0;

    // Prune the optimistic escort badge set: drop any id that is no longer an
    // owned, living, non-piloted fleet unit (destroyed, piloted, or not ours).
    for (const id of [...this.escorting]) {
      const e = this.latestEntities.get(id);
      const ok = e && e.owner === this.selfId && e.alive
        && e.kind === "fleet_unit" && e.role !== "none" && id !== ceid;
      if (!ok) this.escorting.delete(id);
    }

    const fleet: FleetRow[] = [];
    const roleCounts: Partial<Record<FleetRole, number>> = {};
    for (const entity of this.latestEntities.values()) {
      if (entity.kind !== "fleet_unit" || entity.owner !== this.selfId) continue;
      if (entity.role === "none") continue;
      roleCounts[entity.role] = (roleCounts[entity.role] ?? 0) + 1;
      fleet.push({
        id: entity.id,
        role: entity.role,
        label: fleetRoleDef(entity.role)?.label ?? entity.role,
        hpPct: Math.max(0, Math.min(1, entity.hp / entity.maxHp)),
        shieldPct: entity.maxShield > 0
          ? Math.max(0, Math.min(1, entity.shield / entity.maxShield)) : 0,
      });
    }
    const totalFleet = fleet.length;

    const deployOptions: DeployOption[] = DEPLOYABLE_ROLES.map((role) => {
      const def = FLEET_ROLES[role];
      const ofRole = roleCounts[role] ?? 0;
      const available =
        credits >= def.cost &&
        totalFleet < CARRIER.maxFleetPerPlayer &&
        ofRole < def.cap;
      return { role, label: def.label, cost: def.cost, available };
    });

    // Roster of every owned, living unit — drives the become buttons.
    const roster: RosterRow[] = [];
    for (const entity of this.latestEntities.values()) {
      if (entity.owner !== this.selfId || !entity.alive) continue;
      const label = entity.kind === "mother_ship" ? "Carrier"
        : entity.kind === "fighter" ? "Fighter"
        : fleetRoleDef(entity.role)?.label ?? entity.role;
      const summonable = entity.kind === "fleet_unit"
        && entity.role !== "none" && entity.id !== ceid;
      roster.push({
        id: entity.id, kind: entity.kind, label,
        hpPct: Math.max(0, Math.min(1, entity.hp / entity.maxHp)),
        shieldPct: entity.maxShield > 0
          ? Math.max(0, Math.min(1, entity.shield / entity.maxShield)) : 0,
        active: entity.id === ceid,
        summonable,
        escorting: this.escorting.has(entity.id),
        isMother: entity.kind === "mother_ship",
      });
    }
    roster.sort((a, b) => kindRank2(a.kind) - kindRank2(b.kind) || a.id.localeCompare(b.id));

    // Owned platforms + build affordability.
    const myPlatforms = this.latestPlatforms.filter((p) => p.owner === this.selfId);
    const platforms: PlatformRow[] = myPlatforms.map((p) => ({
      id: p.id, kind: p.kind, label: PLATFORM_DEFS[p.kind].label,
      hpPct: Math.max(0, Math.min(1, p.hp / p.maxHp)),
    }));
    const buildOptions: BuildOption[] = PLATFORM_KINDS.map((kind) => {
      const def = PLATFORM_DEFS[kind];
      const available =
        credits >= def.cost && myPlatforms.length < PLATFORM.maxPerPlayer;
      return { kind, label: def.label, cost: def.cost, blurb: def.blurb, available };
    });

    const factionDef = FACTIONS[this.opts.faction ?? FACTION_ORDER[0]];
    this.onHud({
      status: this.status,
      faction: { id: factionDef.id, name: factionDef.name, color: factionDef.color },
      players: this.latestEconomy.length,
      hp, maxHp: SHIP.maxHp,
      shield: auth?.shield ?? 0,
      maxShield: auth?.maxShield ?? 0,
      alive, respawnIn,
      kills: auth?.kills ?? 0, deaths: auth?.deaths ?? 0,
      speed: Math.min(1, sp / SHIP.boostMaxSpeed),
      boost: sp > SHIP.maxSpeed + 1,
      boostHeat: this.boostHeat,
      boostLocked: this.boostLocked,
      overheatPulse: this.overheatPulse,
      boostReadyPulse: this.boostReadyPulse,
      damagePulse: this.damagePulse,
      scoreboard: rows.slice(0, 6),
      credits,
      deployOptions,
      fleet,
      controlledEntityId: ceid,
      roster,
      platforms,
      buildOptions,
      mapBlips: this.buildMapBlips(),
      outposts: this.buildOutpostPings(),
      camMode: this.camMode,
      controllingMother: this.controllingMother(),
      cinematic: this.cinematicActive,
      hint: this.tutorialHint(),
      aiming: this.pointerLocked,
      firingPrimary: this.mouseBtns.has(0) || this.keys.has("Space") || this.keys.has("KeyF"),
      firingMissile: this.mouseBtns.has(2),
    });
  }

  /** Top-down strategic-map blips, normalised to [-1,1] across the arena. */
  private buildMapBlips(): MapBlip[] {
    const arena = SHIP.arena;
    const norm = (v: number) => Math.max(-1, Math.min(1, v / arena));
    const blips: MapBlip[] = [];
    const ceid = this.controlledEntityId;
    for (const e of this.latestEntities.values()) {
      if (!e.alive) continue;
      if (e.owner === this.selfId) {
        let color: string = SHIP_ACCENTS[e.shipType % SHIP_ACCENTS.length];
        let kind: MapBlip["kind"] = "fleet";
        if (e.id === ceid) { kind = "self"; color = "#ffffff"; }
        else if (e.kind === "mother_ship") { kind = "carrier"; color = "#00d4ff"; }
        else if (e.kind === "fleet_unit" && e.role !== "none") color = ROLE_COLORS[e.role];
        blips.push({ x: norm(e.px), y: norm(e.pz), kind, color });
      } else if (e.team === ENEMY.team) {
        blips.push({ x: norm(e.px), y: norm(e.pz), kind: "enemy", color: "#ff3b30" });
      }
    }
    for (const p of this.latestPlatforms) {
      blips.push({ x: norm(p.px), y: norm(p.pz), kind: "platform", color: PLATFORM_COLORS[p.kind] });
    }
    for (const r of this.latestRewards) {
      if (!r.active) continue;
      blips.push({ x: norm(r.px), y: norm(r.pz), kind: "reward", color: "#ffd23f" });
    }
    for (const o of this.latestOutposts) {
      blips.push({
        x: norm(o.px), y: norm(o.pz), kind: "outpost",
        color: o.cleared ? "#2bd96b" : "#ff3b30",
      });
    }
    return blips;
  }

  /** Outpost "pings" for the HUD — distance from the controlled unit, nearest first. */
  private buildOutpostPings(): OutpostPing[] {
    const ceid = this.controlledEntityId;
    const self = ceid ? this.latestEntities.get(ceid) : null;
    const sx = self?.px ?? this.self.px;
    const sy = self?.py ?? this.self.py;
    const sz = self?.pz ?? this.self.pz;
    return this.latestOutposts
      .map((o) => ({
        id: o.id,
        distance: Math.hypot(o.px - sx, o.py - sy, o.pz - sz),
        garrisonAlive: o.garrisonAlive,
        garrisonTotal: o.garrisonTotal,
        cleared: o.cleared,
        rewardAmount: o.rewardAmount,
      }))
      .sort((a, b) => a.distance - b.distance);
  }

  setInvertY(v: boolean): void { this.invertY = v; }

  /** Request the server to deploy one fleet unit of `role` from the mothership. */
  deploy(role: FleetRole): void {
    if (this.status !== "connected") return;
    this.socket.send({ t: "deploy", role });
  }

  // ---- teardown -------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.socket.dispose();
    // Free the owned override templates + reset the prime memo, so the next
    // launch re-reads storage and picks up anything saved in the Shipyard since.
    disposeHullOverrides();

    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    this.renderer.domElement.removeEventListener("click", this.onCanvasClick);
    this.renderer.domElement.removeEventListener("mousedown", this.onMouseDown);
    this.renderer.domElement.removeEventListener("mouseup", this.onMouseUp);
    this.renderer.domElement.removeEventListener("contextmenu", this.onContextMenu);
    this.renderer.domElement.removeEventListener("wheel", this.onWheel);
    if (this.pointerLocked) document.exitPointerLock?.();

    for (const view of this.remotes.values()) {
      this.disposeMother(view.group);
      this.disposeEntityExtras(view.group);
      this.scene.remove(view.group);
      disposeGroup(view.group);
    }
    this.remotes.clear();
    if (this.selfGroup) {
      this.disposeMother(this.selfGroup);
      this.disposeEntityExtras(this.selfGroup);
      disposeGroup(this.selfGroup);
    }
    for (const g of [...this.motherGroups]) this.disposeMother(g);
    for (const trail of this.projTrails.values()) trail.stop();
    this.projTrails.clear();
    for (const mesh of this.projMeshes.values()) this.scene.remove(mesh);
    this.projMeshes.clear();
    for (const line of this.projSplines.values()) {
      this.scene.remove(line);
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.projSplines.clear();
    this.projHistory.clear();
    this.projGeo.dispose();
    this.projMat.dispose();
    this.missileGeo.dispose();
    this.missileMat.dispose();
    // Dispose VFX before the scene.traverse sweep so quarks frees its own batch.
    this.vfx?.dispose();
    this.vfx = null;
    if (this.envMap) { this.envMap.dispose(); this.envMap = null; }
    this.scene.environment = null;

    for (const g of this.celestialViews.values()) { this.scene.remove(g); disposeGroup(g); }
    this.celestialViews.clear();
    for (const view of this.rewardViews.values()) { this.scene.remove(view.group); disposeGroup(view.group); }
    this.rewardViews.clear();
    for (const view of this.outpostViews.values()) this.removeOutpostView(view);
    this.outpostViews.clear();
    this.outpostCoreGeo.dispose();
    this.outpostRingGeo.dispose();
    this.outpostColumnGeo.dispose();
    for (const view of this.beamViews.values()) { this.scene.remove(view.mesh); view.mat.dispose(); }
    this.beamViews.clear();
    for (const [id, view] of [...this.platformViews]) this.removePlatformView(id, view);
    this.platformViews.clear();
    if (this.platformTemplate) { disposeGroup(this.platformTemplate); this.platformTemplate = null; }
    for (const obj of this.backdrops) { this.scene.remove(obj); disposeGroup(obj); }
    this.backdrops.length = 0;
    this.rewardGeo.dispose();
    this.haloGeo.dispose();
    this.beamGeo.dispose();

    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points || o instanceof THREE.LineSegments) {
        (o.geometry as THREE.BufferGeometry)?.dispose?.();
        const m = (o as THREE.Mesh).material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
        else (m as THREE.Material)?.dispose?.();
      }
    });
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container)
      this.container.removeChild(this.renderer.domElement);
  }
}

// ---- module helpers ---------------------------------------------------------

function copyEntity(dst: EntityState, src: EntityState): void {
  dst.px = src.px; dst.py = src.py; dst.pz = src.pz;
  dst.yaw = src.yaw; dst.pitch = src.pitch; dst.roll = src.roll;
  dst.vx = src.vx; dst.vy = src.vy; dst.vz = src.vz;
  dst.hp = src.hp; dst.alive = src.alive; dst.respawnAt = src.respawnAt;
  dst.kills = src.kills; dst.deaths = src.deaths;
  dst.shipType = src.shipType; dst.name = src.name;
  dst.kind = src.kind; dst.owner = src.owner; dst.team = src.team;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

function lerpEntity(
  sa: EntityState | undefined, sb: EntityState | undefined,
  a: SnapEntry | null, b: SnapEntry | null, t: number,
): EntityState | null {
  if (sa && sb && a && b && b.time > a.time) {
    const f = Math.max(0, Math.min(1, (t - a.time) / (b.time - a.time)));
    return { ...sb,
      px: sa.px + (sb.px - sa.px) * f, py: sa.py + (sb.py - sa.py) * f, pz: sa.pz + (sb.pz - sa.pz) * f,
      yaw: lerpAngle(sa.yaw, sb.yaw, f), pitch: lerpAngle(sa.pitch, sb.pitch, f), roll: lerpAngle(sa.roll, sb.roll, f),
    };
  }
  return sb ?? sa ?? null;
}

function applyOrientation(group: THREE.Object3D, yaw: number, pitch: number, roll: number): void {
  const [fx, fy, fz] = forwardVec(yaw, pitch);
  _fwd.set(fx, fy, fz).normalize();
  _q.setFromUnitVectors(LOCAL_NOSE, _fwd);
  _qr.setFromAxisAngle(_fwd, roll);
  group.quaternion.copy(_qr).multiply(_q);
}

const _ba = new THREE.Vector3();
const _bb = new THREE.Vector3();
const _bdir = new THREE.Vector3();
const _bup = new THREE.Vector3(0, 1, 0);
const _bquat = new THREE.Quaternion();
const _spinQ = new THREE.Quaternion();

/** Flat 4-point throwing-star (shuriken) in the XY plane, normal +Z, centred. */
function makeShurikenGeometry(radius: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const points = 4;
  const inner = radius * 0.36;
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? radius : inner;
    const a = (i / (points * 2)) * Math.PI * 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  geo.center();
  return geo;
}

/** Position + orient a unit Y-cylinder so it spans from A to B with the given radius. */
function orientBeam(
  mesh: THREE.Mesh, ax: number, ay: number, az: number,
  bx: number, by: number, bz: number, radius: number,
): void {
  _ba.set(ax, ay, az);
  _bb.set(bx, by, bz);
  _bdir.subVectors(_bb, _ba);
  const len = _bdir.length() || 0.001;
  _bdir.normalize();
  mesh.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  _bquat.setFromUnitVectors(_bup, _bdir);
  mesh.quaternion.copy(_bquat);
  mesh.scale.set(radius, len, radius);
}

// ---- procedural energy shaders --------------------------------------------
// All three drive the shared open-cylinder beamGeo (uv.x = around the tube,
// uv.y = along its length) and animate from a single `uTime` uniform bumped by
// the render loop. Additive + depthWrite:false so they read as glowing energy.

const BEAM_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Bright laser bolt/beam: hot scrolling core, additive glow. */
function makeLaserMaterial(color: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) } },
    vertexShader: BEAM_VERT,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
      void main() {
        float scroll = 0.5 + 0.5 * sin(vUv.y * 26.0 - uTime * 22.0);
        // Hot rounded core: brightest along the tube's camera-facing crest so the
        // beam reads as a solid bolt with a glowing white centre + coloured haze.
        float core = pow(max(0.0, sin(vUv.x * 3.14159)), 1.5);
        float a = (0.4 + scroll * 0.35) * (0.4 + 0.6 * core);
        vec3 col = mix(uColor, vec3(1.0), 0.4 + core * 0.6);
        gl_FragColor = vec4(col, a);
      }
    `,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

/** Plasma chain: braided energy that flows along the tether, additive. */
function makePlasmaMaterial(color: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) } },
    vertexShader: BEAM_VERT,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
      void main() {
        float flow = vUv.y * 7.0 - uTime * 3.0;
        float a1 = 0.5 + 0.5 * sin(flow);
        float a2 = 0.5 + 0.5 * sin(flow * 2.3 + 1.7);
        float energy = pow(a1 * a2, 1.4);
        float rim = max(0.0, sin(vUv.x * 3.14159)); // bright at the tube's facing crest
        float a = (0.22 + energy * 0.78) * (0.45 + 0.55 * rim);
        vec3 col = mix(uColor, vec3(1.0), energy * 0.6);
        gl_FragColor = vec4(col, a);
      }
    `,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

/** Mining beam: a spinning spiral of energy with pulses streaming up the beam. */
function makeMiningMaterial(color: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) } },
    vertexShader: BEAM_VERT,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
      void main() {
        // Spiral: couple the angle around the tube to position along its length.
        float spiral = sin(vUv.x * 6.2831 * 3.0 + vUv.y * 16.0 - uTime * 9.0);
        float bands = smoothstep(0.25, 1.0, spiral);
        // Stream: discrete pulses flowing along the beam toward the emitter.
        float s = fract(vUv.y * 4.0 - uTime * 2.2);
        float stream = smoothstep(0.0, 0.12, s) * (1.0 - smoothstep(0.45, 1.0, s));
        float a = clamp(0.14 + bands * 0.5 + stream * 0.55, 0.0, 1.0);
        vec3 col = mix(uColor, vec3(1.0), clamp(bands * 0.5 + stream * 0.6, 0.0, 1.0));
        gl_FragColor = vec4(col, a);
      }
    `,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

