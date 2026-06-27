import * as THREE from "three";
import { BatchedRenderer, QuarksLoader, QuarksUtil } from "three.quarks";
import type { ParticleEmitter, ParticleSystem } from "three.quarks";
import { ALL_EFFECT_KEYS, EFFECTS, type EffectKey } from "./effects.js";
import type { TextureName } from "./textures.js";
import {
  createBeam,
  createShockwave,
  createWeaponTrail,
  type BeamHandle,
  type BeamOptions,
  type LiveMesh,
  type ShockwaveOptions,
  type TrailHandle,
  type TrailOptions,
} from "./primitives.js";
import { loadEffectJson } from "./urls.js";

/**
 * three.quarks bundles its own `three` typings whose `Object3D` identity differs
 * from the app's `@types/three`, so its `BatchedRenderer`/`ParticleEmitter` are
 * not structurally seen as `THREE.Object3D` even though they extend it at
 * runtime. This bridges the two (identical-at-runtime) type identities.
 */
const asObject3D = (o: unknown): THREE.Object3D => o as unknown as THREE.Object3D;

/** Per-spawn overrides for a one-shot effect. */
export interface PlayOptions {
  /** Orientation for the spawned effect (Euler or Quaternion). */
  rotation?: THREE.Euler | THREE.Quaternion;
  /** Uniform scale multiplier (default 1). */
  scale?: number;
  /**
   * Tint applied to every emitter's material. The supplied material is cloned
   * per-instance so the shared prototype is never mutated; the clone is disposed
   * when the instance ends.
   */
  color?: THREE.ColorRepresentation;
  /**
   * Hard cap (seconds) after which the instance is force-stopped and cleaned up
   * even if its emitters are still alive (covers looping prototypes used as a
   * one-shot). Default 4s.
   */
  ttl?: number;
}

interface LiveInstance {
  root: THREE.Object3D;
  age: number;
  ttl: number;
  tinted: THREE.Material[];
}

/**
 * Handle to a caller-driven, looping effect (e.g. a flare riding a projectile).
 * Reposition it each frame, then `stop()` it; the manager drains the remaining
 * particles and cleans up automatically.
 */
export interface VfxHandle {
  /** Move the effect to a new world position. */
  setPosition(p: THREE.Vector3): VfxHandle;
  /** Orient the effect. */
  setQuaternion(q: THREE.Quaternion): VfxHandle;
  /** End emission; particles fade out and the instance frees itself. */
  stop(): void;
}

/**
 * VfxManager
 * ----------
 * A per-scene, engine-agnostic wrapper around a three.quarks `BatchedRenderer`.
 * Load the effect prototypes once, `play(key, position, opts)` to spawn a
 * one-shot instance, drive everything from a per-frame `update(dt)`, and
 * `dispose()` to tear it all down.
 *
 * One-shot instances auto-remove and free their GPU resources when their
 * emitters finish (or after a TTL fallback), so a long session never leaks.
 */
export class VfxManager {
  private readonly scene: THREE.Scene;
  private readonly batch = new BatchedRenderer();
  private readonly prototypes = new Map<EffectKey, THREE.Object3D>();
  private readonly live: LiveInstance[] = [];
  /** Live mesh-based effects (beams, shockwaves, weapon trails). */
  private readonly meshes: { mesh: LiveMesh; texName: TextureName | null }[] = [];
  /** Textures the mesh primitives currently use (borrowed from the shared cache). */
  private readonly primTextures = new Map<TextureName, THREE.Texture>();
  /**
   * Every texture this manager borrowed from the module-level cache in
   * `textures.ts` (primitive textures + `built`-effect prototype textures). These
   * are owned by that shared cache for the page lifetime and are reused across
   * managers, so `dispose()` must NOT free them — doing so would invalidate the
   * GPU texture for any other (or future) manager that holds the same instance.
   */
  private readonly sharedTextures = new Set<THREE.Texture>();
  private primTexLoading = false;
  private disposed = false;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    // The batch renderer must live under the Scene: three.quarks self-disposes
    // any system whose top-most ancestor is not a Scene.
    this.scene.add(asObject3D(this.batch));
  }

  /** True once at least one prototype has been parsed. */
  get ready(): boolean {
    return this.prototypes.size > 0;
  }

  /**
   * Parse the requested effect prototypes (default: all). Safe to call more than
   * once; already-loaded keys are skipped. Textures are embedded as base64 in
   * the JSON, so no extra network fetches happen.
   */
  async load(keys: EffectKey[] = ALL_EFFECT_KEYS): Promise<void> {
    const loader = new QuarksLoader();
    (loader as unknown as { setCrossOrigin(v: string): void }).setCrossOrigin("");
    await Promise.all(
      keys.map(async (key) => {
        if (this.prototypes.has(key)) return;
        const def = EFFECTS[key];
        if (def.kind === "json") {
          const json = await loadEffectJson(def.file);
          if (this.disposed) return;
          const obj = loader.parse(json as unknown as Record<string, unknown>);
          this.prototypes.set(key, obj);
        } else {
          const spec = await def.load();
          const { loadTexture } = await import("./textures.js");
          const texs = await Promise.all(spec.textures.map((t) => loadTexture(t)));
          if (this.disposed) return;
          for (const t of texs) this.sharedTextures.add(t);
          this.prototypes.set(key, spec.build(texs));
        }
      }),
    );
  }

  /**
   * Spawn a one-shot instance of `key` at `position`. Silently no-ops if the
   * prototype hasn't loaded yet (so callers never need to guard).
   */
  play(key: EffectKey, position: THREE.Vector3, opts: PlayOptions = {}): void {
    const proto = this.prototypes.get(key);
    if (!proto || this.disposed) return;

    const root = proto.clone(true);
    root.position.copy(position);
    if (opts.rotation) {
      if (opts.rotation instanceof THREE.Quaternion) root.quaternion.copy(opts.rotation);
      else root.setRotationFromEuler(opts.rotation);
    }
    if (opts.scale != null) root.scale.setScalar(opts.scale);

    const tinted: THREE.Material[] = [];
    if (opts.color != null) {
      const col = new THREE.Color(opts.color);
      QuarksUtil.runOnAllParticleEmitters(root, (pe: ParticleEmitter) => {
        const system = pe.system as unknown as ParticleSystem;
        const mat = system.material.clone();
        const tintable = mat as THREE.Material & { color?: THREE.Color };
        if (tintable.color) tintable.color = col.clone();
        system.material = mat;
        tinted.push(mat);
      });
    }

    this.scene.add(root);
    QuarksUtil.addToBatchRenderer(root, this.batch);
    QuarksUtil.setAutoDestroy(root, true);
    QuarksUtil.restart(root);

    this.live.push({ root, age: 0, ttl: opts.ttl ?? 4, tinted });
  }

  /**
   * Spawn a looping instance the caller drives by hand (a flare/trail riding a
   * moving projectile). Returns a {@link VfxHandle}; reposition it each frame and
   * call `stop()` when the projectile dies. Returns null if not loaded.
   */
  track(key: EffectKey, position: THREE.Vector3, opts: PlayOptions = {}): VfxHandle | null {
    const proto = this.prototypes.get(key);
    if (!proto || this.disposed) return null;

    const root = proto.clone(true);
    root.position.copy(position);
    if (opts.scale != null) root.scale.setScalar(opts.scale);

    const tinted: THREE.Material[] = [];
    if (opts.color != null) {
      const col = new THREE.Color(opts.color);
      QuarksUtil.runOnAllParticleEmitters(root, (pe: ParticleEmitter) => {
        const system = pe.system as unknown as ParticleSystem;
        const mat = system.material.clone();
        const tintable = mat as THREE.Material & { color?: THREE.Color };
        if (tintable.color) tintable.color = col.clone();
        system.material = mat;
        tinted.push(mat);
      });
    }

    // Force continuous emission so the effect rides the projectile for its life.
    QuarksUtil.runOnAllParticleEmitters(root, (pe: ParticleEmitter) => {
      (pe.system as unknown as ParticleSystem).looping = true;
    });

    this.scene.add(root);
    QuarksUtil.addToBatchRenderer(root, this.batch);
    QuarksUtil.restart(root);

    const inst: LiveInstance = { root, age: 0, ttl: Infinity, tinted };
    this.live.push(inst);

    const handle: VfxHandle = {
      setPosition: (p) => {
        root.position.copy(p);
        return handle;
      },
      setQuaternion: (q) => {
        root.quaternion.copy(q);
        return handle;
      },
      stop: () => {
        QuarksUtil.setAutoDestroy(root, true);
        QuarksUtil.endEmit(root);
        // Cap how long the drained husk can linger before forced cleanup.
        inst.ttl = inst.age + 1.5;
      },
    };
    return handle;
  }

  /**
   * Begin loading the textures the mesh primitives use (idempotent). Primitives
   * render texture-less until these resolve, then swap in automatically — so
   * callers never await. Tests never invoke a primitive, so this stays dormant.
   */
  private ensurePrimTextures(): void {
    if (this.primTexLoading || this.disposed) return;
    this.primTexLoading = true;
    void (async () => {
      const { loadTexture } = await import("./textures.js");
      const names: TextureName[] = ["streak", "glow", "sparkle"];
      for (const name of names) {
        const tex = await loadTexture(name);
        if (this.disposed) return;
        this.sharedTextures.add(tex);
        this.primTextures.set(name, tex);
        for (const e of this.meshes) {
          if (e.texName === name) e.mesh.setMap?.(tex);
        }
      }
    })();
  }

  private register(mesh: LiveMesh, texName: TextureName | null): void {
    this.scene.add(mesh.root);
    this.meshes.push({ mesh, texName });
  }

  /**
   * A glowing beam between two world points (laser/lightning/magic ray). Returns
   * a {@link BeamHandle}: move its endpoints each frame, then `stop()` to fade it
   * out. Returns null after the manager is disposed.
   */
  beam(from: THREE.Vector3, to: THREE.Vector3, opts: BeamOptions = {}): BeamHandle | null {
    if (this.disposed) return null;
    this.ensurePrimTextures();
    const tex = this.primTextures.get("streak") ?? null;
    const { mesh, handle } = createBeam(tex, from, to, opts);
    this.register(mesh, tex ? null : "streak");
    return handle;
  }

  /**
   * An expanding, fading ring at `position` — the visual for a knockback /
   * force-push shockwave. Self-cleans when it finishes.
   */
  shockwave(position: THREE.Vector3, opts: ShockwaveOptions = {}): void {
    if (this.disposed) return;
    this.ensurePrimTextures();
    const tex = this.primTextures.get("glow") ?? null;
    const mesh = createShockwave(tex, position, opts);
    this.register(mesh, tex ? null : "glow");
  }

  /**
   * A swept melee weapon trail. Returns a {@link TrailHandle}: `push(tip, base)`
   * the blade's two ends each frame, then `stop()` on release. Returns null
   * after the manager is disposed.
   */
  weaponTrail(opts: TrailOptions = {}): TrailHandle | null {
    if (this.disposed) return null;
    this.ensurePrimTextures();
    const tex = this.primTextures.get("streak") ?? null;
    const { mesh, handle } = createWeaponTrail(tex, opts);
    this.register(mesh, tex ? null : "streak");
    return handle;
  }

  /** Advance all live effects. Call once per frame from the host loop. */
  update(dt: number): void {
    if (this.disposed) return;
    this.batch.update(dt);
    for (let i = this.meshes.length - 1; i >= 0; i--) {
      const e = this.meshes[i];
      if (!e.mesh.update(dt)) {
        e.mesh.dispose();
        this.meshes.splice(i, 1);
      }
    }
    for (let i = this.live.length - 1; i >= 0; i--) {
      const inst = this.live[i];
      inst.age += dt;
      let remaining = 0;
      QuarksUtil.runOnAllParticleEmitters(inst.root, () => remaining++);
      if (remaining === 0 || inst.age >= inst.ttl) {
        this.cleanupInstance(inst);
        this.live.splice(i, 1);
      }
    }
  }

  private cleanupInstance(inst: LiveInstance): void {
    QuarksUtil.runOnAllParticleEmitters(inst.root, (pe: ParticleEmitter) => {
      const system = pe.system as unknown as ParticleSystem;
      try {
        this.batch.deleteSystem(pe.system);
      } catch {
        /* already removed */
      }
      system.dispose();
    });
    inst.root.parent?.remove(inst.root);
    for (const mat of inst.tinted) mat.dispose();
    inst.tinted.length = 0;
  }

  /** Fully tear down: stop live effects and free every GPU resource we own. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const inst of this.live) this.cleanupInstance(inst);
    this.live.length = 0;

    // Reap any live mesh effects (beams, shockwaves, weapon trails).
    for (const e of this.meshes) e.mesh.dispose();
    this.meshes.length = 0;

    // Primitive textures are borrowed from the shared module cache (see
    // `sharedTextures`); the cache owns them page-wide, so we only drop our refs.
    this.primTextures.clear();

    // Dispose the prototype materials + per-instance geometry (clones share these
    // by reference, but all clones are gone by now). Mesh-render prototypes
    // (bone-debris) also own an instancing geometry. Prototype TEXTURES are only
    // freed when they are NOT shared-cache instances: `json` prototypes own their
    // base64-parsed textures, but `built` prototypes borrow from the shared cache.
    for (const proto of this.prototypes.values()) {
      QuarksUtil.runOnAllParticleEmitters(proto, (pe: ParticleEmitter) => {
        const system = pe.system as unknown as ParticleSystem;
        system.material.dispose();
        const tex = system.texture;
        if (tex && !this.sharedTextures.has(tex as unknown as THREE.Texture)) tex.dispose();
        const inst = (system as unknown as { instancingGeometry?: THREE.BufferGeometry })
          .instancingGeometry;
        inst?.dispose();
      });
    }
    this.prototypes.clear();
    this.sharedTextures.clear();

    // Dispose the batch's own meshes (it clones materials internally) and detach.
    asObject3D(this.batch).traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const m = mesh.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose();
    });
    asObject3D(this.batch).parent?.remove(asObject3D(this.batch));
  }
}
