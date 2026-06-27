/**
 * VfxManager.test.ts
 * ------------------
 * Guards the GPU-memory lifecycle rules that are otherwise silent when they
 * regress (and are exactly what cause per-session memory growth):
 *
 *  1. One-shot `play()` instances auto-remove once their emitters drain.
 *  2. One-shot instances are force-removed after their TTL even if the emitters
 *     never drain (covers looping prototypes used as a one-shot).
 *  3. A `track()` handle drains and frees itself after `stop()`.
 *  4. Per-instance tinted material clones are disposed on cleanup.
 *  5. The shared prototype materials survive instance cleanup and are only freed
 *     by `dispose()`.
 *
 * three.quarks is fully mocked: the real renderer needs a WebGL context, and we
 * only care about the bookkeeping VfxManager does around it. The mock models
 * emitters with a finite "life" so we can simulate draining deterministically.
 */

import * as THREE from "three";
import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// three.quarks mock
// ---------------------------------------------------------------------------
// Each emitter owns a `system` whose `remaining` life is ticked down by the
// BatchedRenderer (only when `autoDestroy` is set); when it hits zero the
// emitter is marked `removed`, which is how the real library makes
// runOnAllParticleEmitters report "no emitters left". Materials carry a
// `disposed` counter and an `isClone` flag so tests can tell tinted clones from
// shared prototype materials.

interface FakeMaterial {
  isClone: boolean;
  color: THREE.Color;
  disposed: number;
  clone(): FakeMaterial;
  dispose(): void;
}

interface FakeSystem {
  material: FakeMaterial;
  texture: { disposed: number; dispose(): void };
  autoDestroy: boolean;
  looping: boolean;
  emitting: boolean;
  remaining: number;
  initial: number;
  disposed: number;
  _emitter: FakeEmitter;
  dispose(): void;
}

interface FakeEmitter {
  removed: boolean;
  system: FakeSystem;
}

interface PrototypeRecord {
  root: THREE.Object3D;
  material: FakeMaterial;
}

interface QuarksMockState {
  reg: Map<THREE.Object3D, FakeEmitter[]>;
  prototypes: PrototypeRecord[];
  materials: FakeMaterial[];
}

interface QuarksMockConfig {
  /** Number of `BatchedRenderer.update` ticks an autoDestroy emitter survives. */
  emitterLifeTicks: number;
}

vi.mock("three.quarks", async () => {
  const THREELib = await import("three");

  const state: QuarksMockState = {
    reg: new Map(),
    prototypes: [],
    materials: [],
  };
  const config: QuarksMockConfig = { emitterLifeTicks: 3 };

  function makeMaterial(isClone: boolean): FakeMaterial {
    const mat: FakeMaterial = {
      isClone,
      color: new THREELib.Color(),
      disposed: 0,
      clone() {
        return makeMaterial(true);
      },
      dispose() {
        this.disposed++;
      },
    };
    state.materials.push(mat);
    return mat;
  }

  function makeEmitter(material: FakeMaterial): FakeEmitter {
    const emitter = { removed: false } as FakeEmitter;
    emitter.system = {
      material,
      texture: {
        disposed: 0,
        dispose() {
          this.disposed++;
        },
      },
      autoDestroy: false,
      looping: false,
      emitting: true,
      remaining: config.emitterLifeTicks,
      initial: config.emitterLifeTicks,
      disposed: 0,
      _emitter: emitter,
      dispose() {
        this.disposed++;
      },
    };
    return emitter;
  }

  class BatchedRenderer extends THREELib.Object3D {
    _systems = new Set<FakeSystem>();
    update(_dt: number): void {
      for (const sys of this._systems) {
        if (!sys.autoDestroy) continue;
        sys.remaining -= 1;
        if (sys.remaining <= 0) sys._emitter.removed = true;
      }
    }
    deleteSystem(sys: FakeSystem): void {
      this._systems.delete(sys);
    }
  }

  class QuarksLoader {
    setCrossOrigin(_v: string): void {}
    parse(_json: unknown): THREE.Object3D {
      const root = new THREELib.Group();
      const sharedMat = makeMaterial(false);
      const emitters = [makeEmitter(sharedMat)];
      state.reg.set(root, emitters);
      state.prototypes.push({ root, material: sharedMat });
      // Cloning shares the prototype's material by reference (the leak risk the
      // tint path guards against), but gives the clone fresh emitter systems.
      root.clone = ((_recursive?: boolean) => {
        const c = new THREELib.Group();
        const cloneEmitters = emitters.map((e) => makeEmitter(e.system.material));
        state.reg.set(c, cloneEmitters);
        return c;
      }) as typeof root.clone;
      return root;
    }
  }

  const QuarksUtil = {
    runOnAllParticleEmitters(root: THREE.Object3D, cb: (pe: FakeEmitter) => void): void {
      const ems = state.reg.get(root) ?? [];
      for (const e of ems) if (!e.removed) cb(e);
    },
    addToBatchRenderer(root: THREE.Object3D, batch: BatchedRenderer): void {
      for (const e of state.reg.get(root) ?? []) batch._systems.add(e.system);
    },
    setAutoDestroy(root: THREE.Object3D, v: boolean): void {
      for (const e of state.reg.get(root) ?? []) e.system.autoDestroy = v;
    },
    restart(root: THREE.Object3D): void {
      for (const e of state.reg.get(root) ?? []) {
        e.removed = false;
        e.system.remaining = e.system.initial;
      }
    },
    endEmit(root: THREE.Object3D): void {
      for (const e of state.reg.get(root) ?? []) e.system.emitting = false;
    },
  };

  return {
    BatchedRenderer,
    QuarksLoader,
    QuarksUtil,
    __state: state,
    __config: config,
    __reset() {
      state.reg.clear();
      state.prototypes.length = 0;
      state.materials.length = 0;
      config.emitterLifeTicks = 3;
    },
  };
});

// The effect JSON loader pulls in Vite's import.meta.glob + multi-MB base64
// payloads; the mocked QuarksLoader ignores the JSON, so stub it out.
vi.mock("./urls.js", () => ({
  loadEffectJson: vi.fn(async () => ({})),
}));

import { VfxManager } from "./VfxManager.js";
import * as quarks from "three.quarks";

const mock = quarks as unknown as {
  __state: QuarksMockState;
  __config: QuarksMockConfig;
  __reset(): void;
};

function liveCount(vfx: VfxManager): number {
  return (vfx as unknown as { live: unknown[] }).live.length;
}

let scene: THREE.Scene;

beforeEach(() => {
  mock.__reset();
  scene = new THREE.Scene();
});

describe("VfxManager one-shot lifecycle", () => {
  it("auto-removes a one-shot instance once its emitters drain", async () => {
    mock.__config.emitterLifeTicks = 3;
    const vfx = new VfxManager(scene);
    await vfx.load(["muzzleFlash"]);

    vfx.play("muzzleFlash", new THREE.Vector3());
    expect(liveCount(vfx)).toBe(1);
    // constructor adds the batch (1 child), play adds the instance root (2).
    expect(scene.children.length).toBe(2);

    vfx.update(0.1); // life 3 -> 2
    vfx.update(0.1); // life 2 -> 1
    expect(liveCount(vfx)).toBe(1);

    vfx.update(0.1); // life 1 -> 0, emitter drains -> cleanup
    expect(liveCount(vfx)).toBe(0);
    // root detached from the scene; only the batch renderer remains.
    expect(scene.children.length).toBe(1);
  });

  it("force-removes a one-shot after its TTL even if the emitters never drain", async () => {
    mock.__config.emitterLifeTicks = 1_000_000; // emitters stay alive forever
    const vfx = new VfxManager(scene);
    await vfx.load(["flamethrower"]);

    vfx.play("flamethrower", new THREE.Vector3(), { ttl: 0.5 });
    expect(liveCount(vfx)).toBe(1);

    vfx.update(0.3); // age 0.3 < 0.5, emitters still alive
    expect(liveCount(vfx)).toBe(1);

    vfx.update(0.3); // age 0.6 >= 0.5 -> forced cleanup
    expect(liveCount(vfx)).toBe(0);
    expect(scene.children.length).toBe(1);
  });
});

describe("VfxManager tracked-handle lifecycle", () => {
  it("keeps a tracked instance alive until stop(), then drains it", async () => {
    mock.__config.emitterLifeTicks = 3;
    const vfx = new VfxManager(scene);
    await vfx.load(["projectileTrail"]);

    const handle = vfx.track("projectileTrail", new THREE.Vector3());
    expect(handle).not.toBeNull();
    expect(liveCount(vfx)).toBe(1);

    // Looping + not auto-destroying: it never drains on its own.
    for (let i = 0; i < 5; i++) vfx.update(0.1);
    expect(liveCount(vfx)).toBe(1);

    handle!.stop();
    for (let i = 0; i < 3; i++) vfx.update(0.1);
    expect(liveCount(vfx)).toBe(0);
    expect(scene.children.length).toBe(1);
  });
});

describe("VfxManager material disposal", () => {
  it("disposes per-instance tinted clones but keeps the shared prototype material until dispose()", async () => {
    mock.__config.emitterLifeTicks = 1_000_000; // force the TTL path
    const vfx = new VfxManager(scene);
    await vfx.load(["bloodImpact"]);
    const protoMat = mock.__state.prototypes[0].material;

    vfx.play("bloodImpact", new THREE.Vector3(), { color: 0xff0000, ttl: 0.5 });
    const clones = mock.__state.materials.filter((m) => m.isClone);
    expect(clones.length).toBe(1);
    const tinted = clones[0];
    expect(tinted.disposed).toBe(0);

    vfx.update(0.3);
    vfx.update(0.3); // TTL elapsed -> cleanup
    expect(liveCount(vfx)).toBe(0);

    // The tinted clone is freed; the shared prototype material survives.
    expect(tinted.disposed).toBe(1);
    expect(protoMat.disposed).toBe(0);

    vfx.dispose();
    expect(protoMat.disposed).toBe(1);
  });

  it("never frees the shared prototype material through a one-shot's full lifecycle", async () => {
    mock.__config.emitterLifeTicks = 3;
    const vfx = new VfxManager(scene);
    await vfx.load(["explosion"]);
    const protoMat = mock.__state.prototypes[0].material;

    // No tint: the clone shares the prototype material by reference. Cleanup
    // must NOT dispose it, or every spawn would free the shared GPU resource.
    vfx.play("explosion", new THREE.Vector3());
    vfx.update(0.1);
    vfx.update(0.1);
    vfx.update(0.1);
    expect(liveCount(vfx)).toBe(0);
    expect(protoMat.disposed).toBe(0);

    vfx.dispose();
    expect(protoMat.disposed).toBe(1);
  });
});

describe("VfxManager dispose()", () => {
  it("drains every live instance and frees prototype materials on dispose()", async () => {
    mock.__config.emitterLifeTicks = 1_000_000; // nothing drains on its own
    const vfx = new VfxManager(scene);
    await vfx.load(["explosion", "bloodImpact"]);

    vfx.play("explosion", new THREE.Vector3(), { ttl: 100 });
    vfx.play("bloodImpact", new THREE.Vector3(), { ttl: 100 });
    expect(liveCount(vfx)).toBe(2);

    vfx.dispose();
    expect(liveCount(vfx)).toBe(0);
    // every prototype material freed exactly once
    for (const proto of mock.__state.prototypes) {
      expect(proto.material.disposed).toBe(1);
    }
    // double dispose is a safe no-op
    expect(() => vfx.dispose()).not.toThrow();
  });

  it("frees a json prototype's own textures but never a shared-cache texture", async () => {
    const vfx = new VfxManager(scene);
    await vfx.load(["explosion"]);

    // A `json` prototype owns its base64-parsed textures: dispose() must free them.
    const ownTexture = mock.__state.prototypes[0].root;
    // Inject a shared-cache texture exactly as the primitive / built-effect paths
    // do, and assert dispose() leaves it alone (the module cache owns it page-wide).
    const shared = new THREE.Texture();
    const sharedDispose = vi.spyOn(shared, "dispose");
    const internals = vfx as unknown as {
      primTextures: Map<string, THREE.Texture>;
      sharedTextures: Set<THREE.Texture>;
    };
    internals.primTextures.set("glow", shared);
    internals.sharedTextures.add(shared);

    vfx.dispose();

    expect(sharedDispose).not.toHaveBeenCalled();
    // json prototype emitter textures were disposed (not in the shared set).
    const emitters = mock.__state.reg.get(ownTexture) ?? [];
    for (const e of emitters) expect(e.system.texture.disposed).toBe(1);
  });
});
