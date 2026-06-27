/**
 * Code-built effect prototypes.
 *
 * The source packs are Godot assets and can't be imported, so each effect is
 * re-authored here against the three.quarks 0.17.1 API, reusing the harvested
 * bitmap textures. A builder returns a plain `THREE.Object3D` (a `ParticleEmitter`
 * or a `Group` of them) that {@link VfxManager} treats exactly like a
 * JSON-loaded prototype: cloned per spawn, tinted via `opts.color`, batched, and
 * disposed centrally. Builders therefore stay white/neutral — colour is a
 * per-spawn concern.
 */
import * as THREE from "three";
import {
  ParticleSystem,
  RenderMode,
  ConstantValue,
  IntervalValue,
  ConstantColor,
  PiecewiseBezier,
  Bezier,
  Gradient,
  ConeEmitter,
  SphereEmitter,
  PointEmitter,
  DonutEmitter,
  ColorOverLife,
  SizeOverLife,
  RotationOverLife,
  FrameOverLife,
  ApplyForce,
  OrbitOverLife,
  Noise,
  GravityForce,
  Vector3,
  Vector4,
} from "three.quarks";

/**
 * three.quarks' `ParticleEmitter` extends `Object3D`, but its bundled `three`
 * typings resolve to a different `Object3D` identity than the app's
 * `@types/three`, so TS won't accept an emitter where a `THREE.Object3D` is
 * required. They are the same object at runtime; this bridges the identity.
 */
const emitterObj = (ps: ParticleSystem): THREE.Object3D =>
  ps.emitter as unknown as THREE.Object3D;

/** Additive sprite material for glows, flashes, sparks and streaks. */
function additive(tex: THREE.Texture): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/**
 * Normal-blended sprite material for "dark" bodies (void cores, mist, columns).
 * Additive black is invisible, so the dark family bakes a near-black tone into
 * `startColor` and renders it with normal blending — `fadeOut` multiplies that
 * baked colour (ColorOverLife multiplies by startColor) so the darkness survives
 * the alpha fade, and a per-spawn `opts.color` tint multiplies on top.
 */
function normalBlend(tex: THREE.Texture): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    blending: THREE.NormalBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** A constant start colour (used to bake a dark base tone into the dark family). */
function startColor(r: number, g: number, b: number, a = 1): ConstantColor {
  return new ConstantColor(new Vector4(r, g, b, a));
}

/** A size-over-life curve that pops in then eases out (p1..p4 control points). */
function sizeCurve(p1: number, p2: number, p3: number, p4: number): SizeOverLife {
  return new SizeOverLife(new PiecewiseBezier([[new Bezier(p1, p2, p3, p4), 0]]));
}

/** Fade alpha 1 -> 0 over life, holding full white RGB (tint applied per spawn). */
function fadeOut(hold = 0.15): ColorOverLife {
  return new ColorOverLife(
    new Gradient(
      [
        [new Vector3(1, 1, 1), 0],
        [new Vector3(1, 1, 1), 1],
      ],
      [
        [1, 0],
        [1, hold],
        [0, 1],
      ],
    ),
  );
}

const WHITE = () => new ConstantColor(new Vector4(1, 1, 1, 1));

/**
 * Muzzle flash: a bright front bloom plus a short forward cone of sparks. Spawns
 * facing +Z; callers orient it down the shot direction.
 */
export function buildMuzzle(flash: THREE.Texture, spark: THREE.Texture): THREE.Object3D {
  const group = new THREE.Group();

  const bloom = new ParticleSystem({
    duration: 0.12,
    looping: false,
    startLife: new IntervalValue(0.05, 0.12),
    startSpeed: new ConstantValue(0),
    startSize: new IntervalValue(1.1, 1.6),
    startRotation: new IntervalValue(0, Math.PI * 2),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(0),
    emissionBursts: [
      { time: 0, count: new ConstantValue(2), cycle: 1, interval: 0.01, probability: 1 },
    ],
    shape: new PointEmitter(),
    material: additive(flash),
    renderMode: RenderMode.BillBoard,
    behaviors: [sizeCurve(0.2, 1, 0.6, 0), fadeOut(0.05)],
  });

  const sparks = new ParticleSystem({
    duration: 0.15,
    looping: false,
    startLife: new IntervalValue(0.1, 0.22),
    startSpeed: new IntervalValue(6, 12),
    startSize: new IntervalValue(0.18, 0.35),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(0),
    emissionBursts: [
      { time: 0, count: new ConstantValue(14), cycle: 1, interval: 0.01, probability: 1 },
    ],
    shape: new ConeEmitter({ radius: 0.05, angle: 0.5, thickness: 1 }),
    material: additive(spark),
    renderMode: RenderMode.StretchedBillBoard,
    speedFactor: 0.4,
    behaviors: [sizeCurve(0.3, 1, 0.4, 0), fadeOut(0.1)],
  });

  group.add(emitterObj(bloom), emitterObj(sparks));
  return group;
}

/** Impact flash + radial spark spray for projectile/bullet hits. */
export function buildHitImpact(flash: THREE.Texture, spark: THREE.Texture): THREE.Object3D {
  const group = new THREE.Group();

  const flashPs = new ParticleSystem({
    duration: 0.18,
    looping: false,
    startLife: new IntervalValue(0.08, 0.16),
    startSpeed: new ConstantValue(0),
    startSize: new IntervalValue(0.9, 1.4),
    startRotation: new IntervalValue(0, Math.PI * 2),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(0),
    emissionBursts: [
      { time: 0, count: new ConstantValue(1), cycle: 1, interval: 0.01, probability: 1 },
    ],
    shape: new PointEmitter(),
    material: additive(flash),
    renderMode: RenderMode.BillBoard,
    behaviors: [sizeCurve(0.4, 1, 0.5, 0), fadeOut(0.05)],
  });

  const sparks = new ParticleSystem({
    duration: 0.25,
    looping: false,
    startLife: new IntervalValue(0.15, 0.4),
    startSpeed: new IntervalValue(4, 9),
    startSize: new IntervalValue(0.12, 0.26),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(0),
    emissionBursts: [
      { time: 0, count: new ConstantValue(18), cycle: 1, interval: 0.01, probability: 1 },
    ],
    shape: new SphereEmitter({ radius: 0.1, thickness: 1 }),
    material: additive(spark),
    renderMode: RenderMode.StretchedBillBoard,
    speedFactor: 0.5,
    behaviors: [
      sizeCurve(0.4, 1, 0.4, 0),
      fadeOut(0.1),
      new ApplyForce(new Vector3(0, -1, 0), new ConstantValue(6)),
    ],
  });

  group.add(emitterObj(flashPs), emitterObj(sparks));
  return group;
}

/** A stylised slash crescent for melee weapon hits (a few stretched streaks). */
export function buildHitSlash(streak: THREE.Texture): THREE.Object3D {
  const ps = new ParticleSystem({
    duration: 0.2,
    looping: false,
    startLife: new IntervalValue(0.12, 0.22),
    startSpeed: new IntervalValue(7, 11),
    startSize: new IntervalValue(0.3, 0.5),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(0),
    emissionBursts: [
      { time: 0, count: new ConstantValue(6), cycle: 1, interval: 0.01, probability: 1 },
    ],
    shape: new ConeEmitter({ radius: 0.1, angle: 0.9, thickness: 0.4 }),
    material: additive(streak),
    renderMode: RenderMode.StretchedBillBoard,
    speedFactor: 0.9,
    behaviors: [sizeCurve(0.5, 1, 0.5, 0), fadeOut(0.1)],
  });
  return emitterObj(ps);
}

/** Small spark puff for arrow/bolt impacts. */
export function buildArrowImpact(spark: THREE.Texture): THREE.Object3D {
  const ps = new ParticleSystem({
    duration: 0.2,
    looping: false,
    startLife: new IntervalValue(0.12, 0.3),
    startSpeed: new IntervalValue(3, 6),
    startSize: new IntervalValue(0.1, 0.2),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(0),
    emissionBursts: [
      { time: 0, count: new ConstantValue(10), cycle: 1, interval: 0.01, probability: 1 },
    ],
    shape: new SphereEmitter({ radius: 0.06, thickness: 1 }),
    material: additive(spark),
    renderMode: RenderMode.StretchedBillBoard,
    speedFactor: 0.4,
    behaviors: [
      sizeCurve(0.4, 1, 0.4, 0),
      fadeOut(0.1),
      new ApplyForce(new Vector3(0, -1, 0), new ConstantValue(5)),
    ],
  });
  return emitterObj(ps);
}

/**
 * Animated sprite-sheet burst (28-frame shatter), used for skill casts and magic
 * impacts. Tintable per spawn for elemental variants.
 */
export function buildSparkBurst(sheet: THREE.Texture): THREE.Object3D {
  const ps = new ParticleSystem({
    duration: 0.6,
    looping: false,
    startLife: new IntervalValue(0.35, 0.55),
    startSpeed: new IntervalValue(0.5, 2),
    startSize: new IntervalValue(0.9, 1.5),
    startRotation: new IntervalValue(0, Math.PI * 2),
    startColor: WHITE(),
    uTileCount: 6,
    vTileCount: 5,
    emissionOverTime: new ConstantValue(0),
    emissionBursts: [
      { time: 0, count: new ConstantValue(5), cycle: 1, interval: 0.01, probability: 1 },
    ],
    shape: new SphereEmitter({ radius: 0.2, thickness: 1 }),
    material: additive(sheet),
    renderMode: RenderMode.BillBoard,
    behaviors: [
      new FrameOverLife(new PiecewiseBezier([[new Bezier(0, 9, 18, 27), 0]])),
      fadeOut(0.55),
    ],
  });
  return emitterObj(ps);
}

/**
 * Looping, caller-driven (via `track`) trail of stretched streaks left in world
 * space — rides an arrow/bolt and lingers briefly behind it.
 */
export function buildArrowTrail(streak: THREE.Texture): THREE.Object3D {
  const ps = new ParticleSystem({
    duration: 1,
    looping: true,
    worldSpace: true,
    startLife: new IntervalValue(0.15, 0.3),
    startSpeed: new ConstantValue(0),
    startSize: new IntervalValue(0.12, 0.22),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(60),
    shape: new PointEmitter(),
    material: additive(streak),
    renderMode: RenderMode.StretchedBillBoard,
    speedFactor: 0.2,
    behaviors: [sizeCurve(1, 0.7, 0.3, 0), fadeOut(0.05)],
  });
  return emitterObj(ps);
}

/**
 * Looping magic projectile body: a pulsing core plus orbiting sparks. Driven via
 * `track` so it follows the bolt; tint per spawn (fire/ice/void).
 */
export function buildMagicBolt(glow: THREE.Texture, spark: THREE.Texture): THREE.Object3D {
  const group = new THREE.Group();

  const core = new ParticleSystem({
    duration: 1,
    looping: true,
    startLife: new IntervalValue(0.18, 0.28),
    startSpeed: new ConstantValue(0),
    startSize: new IntervalValue(0.55, 0.8),
    startRotation: new IntervalValue(0, Math.PI * 2),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(40),
    shape: new PointEmitter(),
    material: additive(glow),
    renderMode: RenderMode.BillBoard,
    behaviors: [sizeCurve(0.4, 1, 0.7, 0), fadeOut(0.2)],
  });

  const sparks = new ParticleSystem({
    duration: 1,
    looping: true,
    worldSpace: true,
    startLife: new IntervalValue(0.25, 0.5),
    startSpeed: new IntervalValue(0.5, 1.5),
    startSize: new IntervalValue(0.1, 0.2),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(30),
    shape: new SphereEmitter({ radius: 0.18, thickness: 1 }),
    material: additive(spark),
    renderMode: RenderMode.StretchedBillBoard,
    speedFactor: 0.3,
    behaviors: [sizeCurve(0.5, 1, 0.4, 0), fadeOut(0.1)],
  });

  group.add(emitterObj(core), emitterObj(sparks));
  return group;
}

/**
 * Looping status aura: motes rising in a ring around a target. Driven via
 * `track` to follow the target; tint per spawn (poison/burning/blessing).
 */
export function buildStatusAura(spark: THREE.Texture): THREE.Object3D {
  const ps = new ParticleSystem({
    duration: 1,
    looping: true,
    startLife: new IntervalValue(0.7, 1.2),
    startSpeed: new IntervalValue(0.6, 1.1),
    startSize: new IntervalValue(0.12, 0.24),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(18),
    shape: new DonutEmitter({ radius: 0.45, donutRadius: 0.08, thickness: 1 }),
    material: additive(spark),
    renderMode: RenderMode.BillBoard,
    behaviors: [
      sizeCurve(0.2, 1, 0.7, 0),
      fadeOut(0.2),
      new RotationOverLife(new IntervalValue(-2, 2)),
      new ApplyForce(new Vector3(0, 1, 0), new ConstantValue(2)),
    ],
  });
  return emitterObj(ps);
}

// ---------------------------------------------------------------------------
// Elemental Magic FX (fire family) — re-authored from the Godot "BinbunVFX
// Vol2" Elemental Magic pack. White/neutral additive bodies; warmth comes from
// the per-spawn `opts.color` tint (fire = gold/orange).
// ---------------------------------------------------------------------------

/**
 * Fire cast: a one-shot charge-up. Concentric flat flares bloom outward on the
 * ground, a bright central bloom flashes, and a short upward spray of embers
 * lifts off. Triggered via `play()`.
 */
export function buildFireCast(glow: THREE.Texture, sparkle: THREE.Texture): THREE.Object3D {
  const group = new THREE.Group();

  const flares = new ParticleSystem({
    duration: 0.9,
    looping: false,
    startLife: new IntervalValue(0.45, 0.65),
    startSpeed: new ConstantValue(0),
    startSize: new IntervalValue(1.2, 1.8),
    startRotation: new IntervalValue(0, Math.PI * 2),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(0),
    emissionBursts: [
      { time: 0, count: new ConstantValue(1), cycle: 1, interval: 0.01, probability: 1 },
      { time: 0.18, count: new ConstantValue(1), cycle: 1, interval: 0.01, probability: 1 },
      { time: 0.36, count: new ConstantValue(1), cycle: 1, interval: 0.01, probability: 1 },
    ],
    shape: new PointEmitter(),
    material: additive(glow),
    renderMode: RenderMode.HorizontalBillBoard,
    behaviors: [sizeCurve(0.1, 0.7, 1, 1.15), fadeOut(0.1)],
  });

  const bloom = new ParticleSystem({
    duration: 0.9,
    looping: false,
    startLife: new IntervalValue(0.35, 0.55),
    startSpeed: new ConstantValue(0),
    startSize: new IntervalValue(1, 1.6),
    startRotation: new IntervalValue(0, Math.PI * 2),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(0),
    emissionBursts: [
      { time: 0.1, count: new ConstantValue(2), cycle: 1, interval: 0.02, probability: 1 },
    ],
    shape: new PointEmitter(),
    material: additive(glow),
    renderMode: RenderMode.BillBoard,
    behaviors: [sizeCurve(0.2, 1, 0.8, 0), fadeOut(0.1)],
  });

  const embers = new ParticleSystem({
    duration: 0.9,
    looping: false,
    startLife: new IntervalValue(0.4, 0.8),
    startSpeed: new IntervalValue(1, 2.5),
    startSize: new IntervalValue(0.12, 0.26),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(0),
    emissionBursts: [
      { time: 0.05, count: new ConstantValue(24), cycle: 1, interval: 0.02, probability: 1 },
    ],
    shape: new SphereEmitter({ radius: 0.4, thickness: 1 }),
    material: additive(sparkle),
    renderMode: RenderMode.StretchedBillBoard,
    speedFactor: 0.3,
    behaviors: [
      sizeCurve(0.4, 1, 0.5, 0),
      fadeOut(0.1),
      new ApplyForce(new Vector3(0, 1, 0), new ConstantValue(4)),
    ],
  });

  group.add(emitterObj(flares), emitterObj(bloom), emitterObj(embers));
  return group;
}

/**
 * Fireball: a looping projectile body — a pulsing glowing core, spiralling
 * streaks orbiting the travel axis, plus shed sparks. Driven via `track()` so it
 * follows the bolt; tint per spawn.
 */
export function buildFireball(
  glow: THREE.Texture,
  sparkle: THREE.Texture,
  streak: THREE.Texture,
): THREE.Object3D {
  const group = new THREE.Group();

  const core = new ParticleSystem({
    duration: 1,
    looping: true,
    startLife: new IntervalValue(0.15, 0.25),
    startSpeed: new ConstantValue(0),
    startSize: new IntervalValue(0.7, 1),
    startRotation: new IntervalValue(0, Math.PI * 2),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(45),
    shape: new PointEmitter(),
    material: additive(glow),
    renderMode: RenderMode.BillBoard,
    behaviors: [sizeCurve(0.5, 1, 0.7, 0), fadeOut(0.2)],
  });

  const spiral = new ParticleSystem({
    duration: 1,
    looping: true,
    worldSpace: true,
    startLife: new IntervalValue(0.3, 0.5),
    startSpeed: new IntervalValue(0.2, 0.6),
    startSize: new IntervalValue(0.15, 0.3),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(40),
    shape: new SphereEmitter({ radius: 0.28, thickness: 0.4 }),
    material: additive(streak),
    renderMode: RenderMode.StretchedBillBoard,
    speedFactor: 0.4,
    behaviors: [
      sizeCurve(0.4, 1, 0.5, 0),
      fadeOut(0.1),
      new OrbitOverLife(new ConstantValue(8), new Vector3(1, 0, 0)),
    ],
  });

  const sparks = new ParticleSystem({
    duration: 1,
    looping: true,
    worldSpace: true,
    startLife: new IntervalValue(0.3, 0.6),
    startSpeed: new IntervalValue(0.5, 1.5),
    startSize: new IntervalValue(0.08, 0.18),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(25),
    shape: new SphereEmitter({ radius: 0.3, thickness: 1 }),
    material: additive(sparkle),
    renderMode: RenderMode.StretchedBillBoard,
    speedFactor: 0.3,
    behaviors: [
      sizeCurve(0.5, 1, 0.4, 0),
      fadeOut(0.1),
      new ApplyForce(new Vector3(0, -1, 0), new ConstantValue(2)),
    ],
  });

  group.add(emitterObj(core), emitterObj(spiral), emitterObj(sparks));
  return group;
}

/**
 * Fire area (AOE): a self-cleaning ground burst — a flat glow disc that grows
 * and fades, rising glow rings, and a ring of upward fire particles. One-shot
 * via `play()`; size with `opts.scale`.
 */
export function buildFireArea(glow: THREE.Texture, sparkle: THREE.Texture): THREE.Object3D {
  const group = new THREE.Group();

  const disc = new ParticleSystem({
    duration: 1.4,
    looping: false,
    startLife: new IntervalValue(1, 1.2),
    startSpeed: new ConstantValue(0),
    startSize: new IntervalValue(2.4, 2.8),
    startRotation: new IntervalValue(0, Math.PI * 2),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(0),
    emissionBursts: [
      { time: 0, count: new ConstantValue(1), cycle: 1, interval: 0.01, probability: 1 },
    ],
    shape: new PointEmitter(),
    material: additive(glow),
    renderMode: RenderMode.HorizontalBillBoard,
    behaviors: [sizeCurve(0.2, 0.8, 1, 0.9), fadeOut(0.5)],
  });

  const rings = new ParticleSystem({
    duration: 1,
    looping: false,
    startLife: new IntervalValue(0.6, 0.9),
    startSpeed: new IntervalValue(1, 2),
    startSize: new IntervalValue(0.8, 1.4),
    startRotation: new IntervalValue(0, Math.PI * 2),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(8),
    shape: new DonutEmitter({ radius: 0.6, donutRadius: 0.1, thickness: 1 }),
    material: additive(glow),
    renderMode: RenderMode.HorizontalBillBoard,
    behaviors: [
      sizeCurve(0.4, 1, 0.8, 0),
      fadeOut(0.2),
      new ApplyForce(new Vector3(0, 1, 0), new ConstantValue(2)),
    ],
  });
  emitterObj(rings).rotation.x = -Math.PI / 2; // lay the donut flat on the ground

  const fire = new ParticleSystem({
    duration: 1,
    looping: false,
    startLife: new IntervalValue(0.6, 1),
    startSpeed: new IntervalValue(2.5, 4.5),
    startSize: new IntervalValue(0.2, 0.4),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(40),
    shape: new DonutEmitter({ radius: 1.4, donutRadius: 0.2, thickness: 1 }),
    material: additive(sparkle),
    renderMode: RenderMode.StretchedBillBoard,
    speedFactor: 0.4,
    behaviors: [
      sizeCurve(0.4, 1, 0.5, 0),
      fadeOut(0.15),
      new ApplyForce(new Vector3(0, 1, 0), new ConstantValue(4)),
    ],
  });
  emitterObj(fire).rotation.x = -Math.PI / 2; // lay the spawn ring flat on the ground

  group.add(emitterObj(disc), emitterObj(rings), emitterObj(fire));
  return group;
}

// ---------------------------------------------------------------------------
// Dark Magic FX (evil/void family) — re-authored from the Godot "BinbunVFX
// Vol2" Dark Magic pack. The dark BODY (cores, mist, central glow) is
// normal-blended with a baked near-black tone so it reads as dark; energy
// ACCENTS (auras, rings, columns, sparks) stay white/additive so the per-spawn
// `opts.color` tint reads cleanly (evil orange-red / void purple / pure black).
// ---------------------------------------------------------------------------

/**
 * Dark orb: a looping charged ball — a churning near-black core that wobbles
 * (noise), a swirling additive aura orbiting it, and particles drawn inward.
 * Driven via `track()`; tint per spawn.
 */
export function buildDarkOrb(glow: THREE.Texture, sparkle: THREE.Texture): THREE.Object3D {
  const group = new THREE.Group();

  const core = new ParticleSystem({
    duration: 1,
    looping: true,
    startLife: new IntervalValue(0.4, 0.7),
    startSpeed: new ConstantValue(0),
    startSize: new IntervalValue(0.9, 1.3),
    startRotation: new IntervalValue(0, Math.PI * 2),
    startColor: startColor(0.08, 0.02, 0.12, 1),
    emissionOverTime: new ConstantValue(25),
    shape: new SphereEmitter({ radius: 0.15, thickness: 1 }),
    material: normalBlend(glow),
    renderMode: RenderMode.BillBoard,
    behaviors: [
      sizeCurve(0.5, 1, 0.8, 0.3),
      fadeOut(0.3),
      new Noise(new ConstantValue(3), new ConstantValue(1.2)),
    ],
  });

  const aura = new ParticleSystem({
    duration: 1,
    looping: true,
    startLife: new IntervalValue(0.5, 0.8),
    startSpeed: new ConstantValue(0),
    startSize: new IntervalValue(0.25, 0.45),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(40),
    shape: new DonutEmitter({ radius: 0.7, donutRadius: 0.12, thickness: 1 }),
    material: additive(sparkle),
    renderMode: RenderMode.StretchedBillBoard,
    speedFactor: 0.2,
    behaviors: [
      sizeCurve(0.3, 1, 0.7, 0),
      fadeOut(0.2),
      new OrbitOverLife(new ConstantValue(6), new Vector3(0, 1, 0)),
    ],
  });

  const inward = new ParticleSystem({
    duration: 1,
    looping: true,
    startLife: new IntervalValue(0.5, 0.9),
    startSpeed: new ConstantValue(0),
    startSize: new IntervalValue(0.1, 0.22),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(30),
    shape: new SphereEmitter({ radius: 1.3, thickness: 0.2 }),
    material: additive(sparkle),
    renderMode: RenderMode.StretchedBillBoard,
    speedFactor: 0.3,
    behaviors: [
      sizeCurve(0.2, 0.8, 1, 0),
      fadeOut(0.1),
      new GravityForce(new Vector3(0, 0, 0), 6),
    ],
  });

  group.add(emitterObj(core), emitterObj(aura), emitterObj(inward));
  return group;
}

/**
 * Dark projectile: a looping evil bolt — a near-black void core, a bright glow
 * halo, crossing flares, and an additive world-space trail. Driven via
 * `track()`; tint per spawn.
 */
export function buildDarkProjectile(
  glow: THREE.Texture,
  sparkle: THREE.Texture,
  streak: THREE.Texture,
): THREE.Object3D {
  const group = new THREE.Group();

  const core = new ParticleSystem({
    duration: 1,
    looping: true,
    startLife: new IntervalValue(0.18, 0.3),
    startSpeed: new ConstantValue(0),
    startSize: new IntervalValue(0.6, 0.9),
    startRotation: new IntervalValue(0, Math.PI * 2),
    startColor: startColor(0.1, 0.02, 0.14, 1),
    emissionOverTime: new ConstantValue(40),
    shape: new PointEmitter(),
    material: normalBlend(glow),
    renderMode: RenderMode.BillBoard,
    behaviors: [sizeCurve(0.5, 1, 0.7, 0.2), fadeOut(0.2)],
  });

  const halo = new ParticleSystem({
    duration: 1,
    looping: true,
    startLife: new IntervalValue(0.15, 0.25),
    startSpeed: new ConstantValue(0),
    startSize: new IntervalValue(0.5, 0.8),
    startRotation: new IntervalValue(0, Math.PI * 2),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(35),
    shape: new PointEmitter(),
    material: additive(glow),
    renderMode: RenderMode.BillBoard,
    behaviors: [sizeCurve(0.4, 1, 0.7, 0), fadeOut(0.25)],
  });

  const flares = new ParticleSystem({
    duration: 1,
    looping: true,
    startLife: new IntervalValue(0.2, 0.35),
    startSpeed: new ConstantValue(0),
    startSize: new IntervalValue(0.7, 1.1),
    startRotation: new IntervalValue(0, Math.PI * 2),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(12),
    shape: new PointEmitter(),
    material: additive(streak),
    renderMode: RenderMode.BillBoard,
    behaviors: [
      sizeCurve(0.2, 1, 0.6, 0),
      fadeOut(0.15),
      new RotationOverLife(new IntervalValue(-3, 3)),
    ],
  });

  const trail = new ParticleSystem({
    duration: 1,
    looping: true,
    worldSpace: true,
    startLife: new IntervalValue(0.25, 0.45),
    startSpeed: new ConstantValue(0),
    startSize: new IntervalValue(0.3, 0.5),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(50),
    shape: new PointEmitter(),
    material: additive(streak),
    renderMode: RenderMode.StretchedBillBoard,
    speedFactor: 0.2,
    behaviors: [sizeCurve(1, 0.7, 0.3, 0), fadeOut(0.05)],
  });

  group.add(emitterObj(core), emitterObj(halo), emitterObj(flares), emitterObj(trail));
  return group;
}

/**
 * Dark area (AOE): a self-cleaning ground burst — a flat near-black mist plane,
 * an additive ground ring, and rising dark columns. One-shot via `play()`; size
 * with `opts.scale`.
 */
export function buildDarkArea(
  glow: THREE.Texture,
  sparkle: THREE.Texture,
  streak: THREE.Texture,
): THREE.Object3D {
  const group = new THREE.Group();
  void sparkle;

  const mist = new ParticleSystem({
    duration: 1.4,
    looping: false,
    startLife: new IntervalValue(1, 1.3),
    startSpeed: new ConstantValue(0),
    startSize: new IntervalValue(2, 2.8),
    startRotation: new IntervalValue(0, Math.PI * 2),
    startColor: startColor(0.07, 0.02, 0.1, 1),
    emissionOverTime: new ConstantValue(0),
    emissionBursts: [
      { time: 0, count: new ConstantValue(3), cycle: 1, interval: 0.05, probability: 1 },
    ],
    shape: new PointEmitter(),
    material: normalBlend(glow),
    renderMode: RenderMode.HorizontalBillBoard,
    behaviors: [sizeCurve(0.3, 0.8, 1, 1), fadeOut(0.4)],
  });

  const ring = new ParticleSystem({
    duration: 1.2,
    looping: false,
    startLife: new IntervalValue(0.8, 1.1),
    startSpeed: new ConstantValue(0),
    startSize: new IntervalValue(2, 2.4),
    startRotation: new IntervalValue(0, Math.PI * 2),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(0),
    emissionBursts: [
      { time: 0, count: new ConstantValue(1), cycle: 1, interval: 0.01, probability: 1 },
    ],
    shape: new PointEmitter(),
    material: additive(glow),
    renderMode: RenderMode.HorizontalBillBoard,
    behaviors: [sizeCurve(0.2, 0.7, 1, 1.1), fadeOut(0.3)],
  });

  const columns = new ParticleSystem({
    duration: 1,
    looping: false,
    startLife: new IntervalValue(0.6, 1),
    startSpeed: new IntervalValue(2.5, 4.5),
    startSize: new IntervalValue(0.3, 0.6),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(35),
    shape: new DonutEmitter({ radius: 1.2, donutRadius: 0.25, thickness: 1 }),
    material: additive(streak),
    renderMode: RenderMode.StretchedBillBoard,
    speedFactor: 0.5,
    behaviors: [
      sizeCurve(0.5, 1, 0.6, 0),
      fadeOut(0.15),
      new ApplyForce(new Vector3(0, 1, 0), new ConstantValue(3)),
    ],
  });
  emitterObj(columns).rotation.x = -Math.PI / 2; // lay the spawn ring flat on the ground

  group.add(emitterObj(mist), emitterObj(ring), emitterObj(columns));
  return group;
}

/**
 * Dark vortex: a self-cleaning swirling ground vortex — flat streak arms orbit
 * the centre and are drawn inward, over a growing near-black central glow.
 * One-shot via `play()`; size with `opts.scale`.
 */
export function buildDarkVortex(glow: THREE.Texture, streak: THREE.Texture): THREE.Object3D {
  const group = new THREE.Group();

  const swirl = new ParticleSystem({
    duration: 1.4,
    looping: false,
    startLife: new IntervalValue(0.8, 1.2),
    startSpeed: new ConstantValue(0),
    startSize: new IntervalValue(0.4, 0.8),
    startRotation: new IntervalValue(0, Math.PI * 2),
    startColor: WHITE(),
    emissionOverTime: new ConstantValue(60),
    shape: new DonutEmitter({ radius: 1.6, donutRadius: 0.4, thickness: 1 }),
    material: additive(streak),
    renderMode: RenderMode.HorizontalBillBoard,
    behaviors: [
      sizeCurve(0.3, 1, 0.7, 0),
      fadeOut(0.2),
      // emitter is laid flat (rotation.x = -90deg) so local +Z maps to world up.
      new OrbitOverLife(new ConstantValue(7), new Vector3(0, 0, 1)),
      new GravityForce(new Vector3(0, 0, 0), 3),
    ],
  });
  emitterObj(swirl).rotation.x = -Math.PI / 2; // lay the vortex flat on the ground

  const center = new ParticleSystem({
    duration: 1.4,
    looping: false,
    startLife: new IntervalValue(0.8, 1.1),
    startSpeed: new ConstantValue(0),
    startSize: new IntervalValue(1.2, 1.8),
    startRotation: new IntervalValue(0, Math.PI * 2),
    startColor: startColor(0.1, 0.02, 0.14, 1),
    emissionOverTime: new ConstantValue(0),
    emissionBursts: [
      { time: 0, count: new ConstantValue(1), cycle: 1, interval: 0.01, probability: 1 },
    ],
    shape: new PointEmitter(),
    material: normalBlend(glow),
    renderMode: RenderMode.HorizontalBillBoard,
    behaviors: [sizeCurve(0.2, 0.8, 1, 1), fadeOut(0.4)],
  });

  group.add(emitterObj(swirl), emitterObj(center));
  return group;
}

/** Mesh debris (bone shards) flung outward under gravity, for kills. */
export function buildBoneDebris(): THREE.Object3D {
  const ps = new ParticleSystem({
    duration: 0.3,
    looping: false,
    startLife: new IntervalValue(0.6, 1.1),
    startSpeed: new IntervalValue(4, 8),
    startSize: new IntervalValue(0.6, 1.1),
    startRotation: new IntervalValue(0, Math.PI * 2),
    startColor: new ConstantColor(new Vector4(0.92, 0.9, 0.82, 1)),
    emissionOverTime: new ConstantValue(0),
    emissionBursts: [
      { time: 0, count: new ConstantValue(10), cycle: 1, interval: 0.01, probability: 1 },
    ],
    shape: new SphereEmitter({ radius: 0.15, thickness: 1 }),
    material: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    renderMode: RenderMode.Mesh,
    instancingGeometry: new THREE.BoxGeometry(0.12, 0.045, 0.045),
    behaviors: [
      new ApplyForce(new Vector3(0, -1, 0), new ConstantValue(14)),
      new RotationOverLife(new IntervalValue(-8, 8)),
      fadeOut(0.6),
    ],
  });
  return emitterObj(ps);
}
