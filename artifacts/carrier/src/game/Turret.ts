/**
 * Turret — a clean, reusable, animated weapon emplacement.
 *
 * Wraps the rigged `props/carrier/heavy-metal-turret` GLB (skinned mesh + 6
 * baked clips: Spawn / Idle / Fire / Reload / Disabled / DisabledLoop) into a
 * drop-in turret you can mesh onto any host asset (a hull, a platform, a
 * planet) and point at a target.
 *
 * Design (best-practice turret rig):
 *   root (anchor, meshed rigidly into the host)
 *     └─ foundation  — a procedural mounting collar; NEVER rotates, so the
 *                      turret reads as bolted down ("rigid foundation").
 *        └─ yaw      — the turntable: slews horizontally to face the target.
 *           └─ pitch — the cradle: elevates (clamped) toward the target.
 *              └─ model (cloned GLB, smart-scaled to the requested size).
 *
 * Aiming is done on the groups we own (yaw/pitch transforms), not by fighting
 * the baked skeleton, so the logic is deterministic and verifiable. The mixer
 * still drives the barrel's recoil/idle motion underneath. The whole thing is
 * disposable and shares its loaded template across instances.
 *
 * NOTE: the model orientation (forward = +Z, up = +Y) and the muzzle offset are
 * tuned by the constants below; the Carrier cabinet is Puter-gated so live
 * screenshots aren't possible — these are manual-verify values.
 */
import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { loadAsset } from "@workspace/assets";

const TURRET_ID = "props/carrier/heavy-metal-turret";

/** Clip names as authored in the GLB. */
type ClipName = "Spawn" | "Idle" | "Fire" | "Reload" | "Disabled" | "DisabledLoop";

export interface TurretOptions {
  /** Longest-axis size of the gun model, in world metres ("smart scaled down"). */
  size?: number;
  /** Max engagement range; targets beyond this are ignored. */
  range?: number;
  /** Seconds between shots. */
  fireCooldown?: number;
  /** Beam / muzzle colour. Brightened toward white for a legible firing core. */
  beamColor?: THREE.ColorRepresentation;
  /**
   * Painted-metal fixture tint (subtle emissive trim) applied to the cloned gun
   * model + mounting collar, so the turret reads as part of the host hull rather
   * than a glowing neon attachment. Defaults to `beamColor`.
   */
  fixtureColor?: THREE.ColorRepresentation;
  /** Turntable slew speed (rad/s). */
  turnRate?: number;
  /** Max elevation magnitude (radians). Kept modest so the planted feet stay clean. */
  pitchClamp?: number;
  /** Half-angle (radians) the gun must be within before it will fire. */
  fireConeRad?: number;
}

const DEFAULTS = {
  size: 8,
  range: 600,
  fireCooldown: 1.1,
  beamColor: 0x66ccff as THREE.ColorRepresentation,
  fixtureColor: 0x66ccff as THREE.ColorRepresentation,
  turnRate: 2.4,
  pitchClamp: THREE.MathUtils.degToRad(16),
  fireConeRad: THREE.MathUtils.degToRad(8),
};

interface Template {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
  /** Longest source-axis length (pre-scale), for the smart-fit ratio. */
  longest: number;
}

let templatePromise: Promise<Template> | null = null;

/** Load + measure the source turret once; all instances clone from this. */
async function getTemplate(): Promise<Template> {
  if (!templatePromise) {
    templatePromise = (async () => {
      const model = await loadAsset(TURRET_ID);
      const box = new THREE.Box3().setFromObject(model.scene);
      const size = new THREE.Vector3();
      box.getSize(size);
      const longest = Math.max(size.x, size.y, size.z) || 1;
      return { scene: model.scene as unknown as THREE.Group, clips: model.animations, longest };
    })().catch((err) => {
      templatePromise = null; // allow retry on transient failure
      throw err;
    });
  }
  return templatePromise;
}

interface ActiveBeam {
  /** core + glow meshes that share the turret's beam geometry. */
  meshes: THREE.Mesh[];
  /** Each material with its starting opacity, so the fade scales from there. */
  mats: { mat: THREE.MeshBasicMaterial; base: number }[];
  life: number;
  ttl: number;
}

export class Turret {
  readonly root = new THREE.Group();

  private readonly opts: Required<TurretOptions>;
  private readonly yaw = new THREE.Group();
  private readonly pitch = new THREE.Group();
  private readonly muzzle = new THREE.Object3D();
  private model!: THREE.Object3D;

  private mixer!: THREE.AnimationMixer;
  private actions = new Map<ClipName, THREE.AnimationAction>();
  private currentLoop: ClipName = "Idle";

  private foundationMat: THREE.MeshStandardMaterial | null = null;
  private foundationGeo: THREE.BufferGeometry | null = null;

  private deployed = false;
  private active = false;
  private cooldown = 0;

  private beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  private beams: ActiveBeam[] = [];
  /** Outer glow colour (muted faction accent). */
  private beamColor: THREE.Color;
  /** Bright inner core colour (accent lerped toward white) for legibility. */
  private beamCore: THREE.Color;
  /** Per-instance tinted materials cloned off the shared GLB template. */
  private ownedMaterials: THREE.Material[] = [];

  private disposed = false;

  // scratch
  private readonly _v = new THREE.Vector3();
  private readonly _local = new THREE.Vector3();
  private readonly _muzzleW = new THREE.Vector3();
  private readonly _inv = new THREE.Matrix4();

  private constructor(template: Template, opts: TurretOptions) {
    this.opts = { ...DEFAULTS, ...opts };
    // Fixture tint defaults to the beam hue when not given explicitly.
    if (opts.fixtureColor === undefined) this.opts.fixtureColor = this.opts.beamColor;
    this.beamColor = new THREE.Color(this.opts.beamColor);
    // Hot inner core so the firing beam stays legible against a muted hull.
    this.beamCore = this.beamColor.clone().lerp(new THREE.Color(0xffffff), 0.6);

    this.buildFoundation();
    this.buildModel(template);

    this.root.add(this.foundationMesh!);
    this.root.add(this.yaw);
    this.yaw.add(this.pitch);
    this.pitch.add(this.model);
    this.pitch.add(this.muzzle);

    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of template.clips) {
      const name = clip.name as ClipName;
      this.actions.set(name, this.mixer.clipAction(clip));
    }
    // Idle underneath everything by default.
    this.playLoop("Idle");
    this.mixer.addEventListener("finished", this.onClipFinished);
  }

  private foundationMesh: THREE.Mesh | null = null;

  /** Build the turret; resolves once the shared template is loaded. */
  static async create(opts: TurretOptions = {}): Promise<Turret> {
    const template = await getTemplate();
    return new Turret(template, opts);
  }

  /** Eagerly warm the shared template (e.g. during a loading screen). */
  static preload(): Promise<unknown> {
    return getTemplate();
  }

  private buildFoundation(): void {
    const r = this.opts.size * 0.42;
    const h = this.opts.size * 0.18;
    this.foundationGeo = new THREE.CylinderGeometry(r, r * 1.18, h, 16);
    // Gunmetal collar nudged toward the fixture tint with a faint emissive trim,
    // so the mounting base reads as the same painted metal as the host hull.
    const fixture = new THREE.Color(this.opts.fixtureColor);
    const collar = new THREE.Color(0x3b424c).lerp(fixture, 0.25);
    this.foundationMat = new THREE.MeshStandardMaterial({
      color: collar,
      roughness: 0.5,
      metalness: 0.85,
      emissive: fixture,
      emissiveIntensity: 0.12,
    });
    const mesh = new THREE.Mesh(this.foundationGeo, this.foundationMat);
    mesh.position.y = h * 0.5;
    this.foundationMesh = mesh;
    // The turntable sits on top of the collar.
    this.yaw.position.y = h;
  }

  private buildModel(template: Template): void {
    this.model = cloneSkinned(template.scene);
    const scale = this.opts.size / template.longest;
    this.model.scale.setScalar(scale);

    // Recentre on the turntable axis and seat the base at y = 0.
    const box = new THREE.Box3().setFromObject(this.model);
    const center = new THREE.Vector3();
    box.getCenter(center);
    this.model.position.x -= center.x;
    this.model.position.z -= center.z;
    this.model.position.y -= box.min.y;

    // Muzzle marker: front-top of the model (forward = +Z), where the beam exits.
    this.muzzle.position.set(0, this.opts.size * 0.55, this.opts.size * 0.5);

    this.tintModel();
  }

  /**
   * Re-skin the cloned gun with painted-metal PBR + a subtle muted-accent
   * emissive trim, mirroring the hangar showcase so the in-match fixture reads
   * as part of the host hull rather than a glowing neon attachment.
   *
   * `cloneSkinned` SHARES the template geometry + maps; we replace materials with
   * freshly-built, per-instance ones (kept in `ownedMaterials`) and dispose ONLY
   * those on teardown — the shared geometry + textures are never freed here.
   */
  private tintModel(): void {
    const accent = new THREE.Color(this.opts.fixtureColor);
    this.model.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const hasUV = !!o.geometry.getAttribute("uv");
      const src = Array.isArray(o.material) ? o.material : [o.material];
      const next = src.map((mm) => {
        const base = mm as THREE.MeshStandardMaterial;
        const map = hasUV ? base.map ?? null : null;
        const mat = new THREE.MeshStandardMaterial({
          map,
          color: map ? 0xffffff : 0x6b7480,
          metalness: 0.9,
          roughness: 0.45,
          emissive: accent,
          emissiveIntensity: 0.22,
          envMapIntensity: 1.1,
        });
        this.ownedMaterials.push(mat);
        return mat;
      });
      o.material = Array.isArray(o.material) ? next : next[0];
    });
  }

  /** Add the turret to a host and bolt the foundation flush to its surface. */
  mountOn(host: THREE.Object3D, localPosition: THREE.Vector3, surfaceNormal?: THREE.Vector3): void {
    this.root.position.copy(localPosition);
    if (surfaceNormal) {
      this.root.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        surfaceNormal.clone().normalize(),
      );
    }
    host.add(this.root);
  }

  /**
   * Play the "meshed into the asset" deploy animation, then go live. Call this
   * when the turret is unlocked / built onto the host (e.g. a level gate).
   */
  deploy(): void {
    if (this.deployed) return;
    this.deployed = true;
    const spawn = this.actions.get("Spawn");
    if (spawn) {
      spawn.reset();
      spawn.setLoop(THREE.LoopOnce, 1);
      spawn.clampWhenFinished = true;
      this.actions.get("Idle")?.stop();
      spawn.play();
    } else {
      this.active = true;
    }
  }

  setActive(on: boolean): void {
    this.active = on;
  }

  /**
   * Per-frame: advance animation, acquire the nearest in-range target, slew the
   * turntable + cradle toward it, and fire (with a beam) when aligned.
   * `targets` are WORLD-space positions of candidate hostiles.
   */
  update(dt: number, targets: readonly THREE.Vector3[]): void {
    if (this.disposed) return;
    this.mixer.update(dt);
    this.updateBeams(dt);
    if (this.cooldown > 0) this.cooldown -= dt;
    if (!this.active) return;

    const target = this.acquire(targets);
    if (!target) {
      // Idle sweep so dormant turrets still feel alive.
      this.yaw.rotation.y += dt * 0.25;
      this.slerpPitch(0, dt);
      return;
    }

    // Convert the world target into the foundation's local frame.
    this.root.updateWorldMatrix(true, false);
    this._inv.copy(this.root.matrixWorld).invert();
    this._local.copy(target).applyMatrix4(this._inv);

    const desiredYaw = Math.atan2(this._local.x, this._local.z);
    this.slerpYaw(desiredYaw, dt);

    const horiz = Math.hypot(this._local.x, this._local.z);
    // Barrel points +Z; a +X rotation tips it down, so elevate with the negated
    // angle. (Manual-verify: the Carrier cabinet is Puter-gated, no screenshots.)
    const desiredPitch = THREE.MathUtils.clamp(
      Math.atan2(this._local.y - this.yaw.position.y, horiz),
      -this.opts.pitchClamp,
      this.opts.pitchClamp,
    );
    const aimPitch = -desiredPitch;
    this.slerpPitch(aimPitch, dt);

    // Fire only when the barrel is aligned in BOTH yaw and pitch, and off cooldown.
    const yawErr = Math.abs(angleDelta(this.yaw.rotation.y, desiredYaw));
    const pitchErr = Math.abs(this.pitch.rotation.x - aimPitch);
    if (yawErr < this.opts.fireConeRad && pitchErr < this.opts.fireConeRad && this.cooldown <= 0) {
      this.fireAt(target);
      this.cooldown = this.opts.fireCooldown;
    }
  }

  private acquire(targets: readonly THREE.Vector3[]): THREE.Vector3 | null {
    this.root.getWorldPosition(this._muzzleW);
    let best: THREE.Vector3 | null = null;
    let bestD = this.opts.range * this.opts.range;
    for (const t of targets) {
      const d = this._muzzleW.distanceToSquared(t);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  private slerpYaw(desired: number, dt: number): void {
    const d = angleDelta(this.yaw.rotation.y, desired);
    const step = Math.sign(d) * Math.min(Math.abs(d), this.opts.turnRate * dt);
    this.yaw.rotation.y += step;
  }

  private slerpPitch(desired: number, dt: number): void {
    const d = desired - this.pitch.rotation.x;
    const step = Math.sign(d) * Math.min(Math.abs(d), this.opts.turnRate * dt);
    this.pitch.rotation.x += step;
  }

  private fireAt(target: THREE.Vector3): void {
    const fire = this.actions.get("Fire");
    if (fire) {
      fire.reset();
      fire.setLoop(THREE.LoopOnce, 1);
      fire.clampWhenFinished = true;
      this.actions.get(this.currentLoop)?.stop();
      fire.play();
    }
    this.spawnBeam(target);
  }

  /**
   * A brief additive tracer connecting the muzzle to the target. Drawn as a
   * white-hot core inside a softer muted-accent glow sheath, so the shot stays
   * legible in combat while the colour reads as the same intentional faction
   * tone as the (muted) hull rather than a flat neon tube.
   */
  private spawnBeam(target: THREE.Vector3): void {
    this.muzzle.getWorldPosition(this._muzzleW);
    const dir = this._v.copy(target).sub(this._muzzleW);
    const len = dir.length();
    if (len < 1e-3) return;

    // Precompute the shared muzzle→target transform (in the turret's root frame).
    const localPos = this.root.worldToLocal(
      this._muzzleW.clone().addScaledVector(dir, 0.5),
    );
    const localQuat = new THREE.Quaternion()
      .setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
      .premultiply(this.root.getWorldQuaternion(new THREE.Quaternion()).invert());

    const t = this.opts.size * 0.04;
    const layers: { color: THREE.Color; opacity: number; thickness: number }[] = [
      { color: this.beamColor, opacity: 0.45, thickness: t * 2.2 }, // outer glow
      { color: this.beamCore, opacity: 0.95, thickness: t * 0.85 }, // hot core
    ];

    const meshes: THREE.Mesh[] = [];
    const mats: { mat: THREE.MeshBasicMaterial; base: number }[] = [];
    for (const layer of layers) {
      const mat = new THREE.MeshBasicMaterial({
        color: layer.color,
        transparent: true,
        opacity: layer.opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.beamGeo, mat);
      mesh.scale.set(layer.thickness, len, layer.thickness);
      mesh.position.copy(localPos);
      mesh.quaternion.copy(localQuat);
      // Beams live in the turret's root so they ride along if the host moves.
      this.root.add(mesh);
      meshes.push(mesh);
      mats.push({ mat, base: layer.opacity });
    }
    this.beams.push({ meshes, mats, life: 0, ttl: 0.14 });
  }

  private updateBeams(dt: number): void {
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.life += dt;
      const k = b.life / b.ttl;
      if (k >= 1) {
        for (const m of b.meshes) this.root.remove(m);
        for (const { mat } of b.mats) mat.dispose();
        this.beams.splice(i, 1);
      } else {
        for (const { mat, base } of b.mats) mat.opacity = base * (1 - k);
      }
    }
  }

  private playLoop(name: ClipName): void {
    const action = this.actions.get(name);
    if (!action) return;
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.fadeIn(0.2);
    action.play();
    this.currentLoop = name;
  }

  private onClipFinished = (e: { action: THREE.AnimationAction }) => {
    const clip = e.action.getClip().name as ClipName;
    if (clip === "Spawn") {
      this.active = true;
      e.action.fadeOut(0.25);
      this.playLoop("Idle");
    } else if (clip === "Fire") {
      e.action.fadeOut(0.12);
      this.playLoop("Idle");
    }
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mixer.removeEventListener("finished", this.onClipFinished);
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);

    for (const b of this.beams) {
      for (const m of b.meshes) this.root.remove(m);
      for (const { mat } of b.mats) mat.dispose();
    }
    this.beams.length = 0;
    this.beamGeo.dispose();
    this.foundationGeo?.dispose();
    this.foundationMat?.dispose();

    // NOTE: SkeletonUtils.clone duplicates the node graph + skeleton but SHARES
    // the template's geometries and textures. We DID replace the shared materials
    // with per-instance tinted ones (`ownedMaterials`) in `tintModel`, so those
    // are ours to free — but their `.map` textures are still shared, and
    // MeshStandardMaterial.dispose() leaves textures untouched, so this is safe.
    // The geometries (shared) are intentionally never freed here.
    for (const m of this.ownedMaterials) m.dispose();
    this.ownedMaterials.length = 0;
    this.root.parent?.remove(this.root);
  }
}

/** Smallest signed angle (radians) from `a` to `b`, in (-PI, PI]. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
