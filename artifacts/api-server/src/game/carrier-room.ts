/**
 * Authoritative game room for the Carrier cabinet.
 *
 * Carrier-owned copy of the space-shooter room so the two games never share
 * state.  One shared room holds every connected commander.  Runs a fixed-step
 * simulation (TICK_HZ) using the same `stepShip` the client predicts with.
 *
 * On top of the dogfight it owns a fully DETERMINISTIC world: celestial bodies
 * (planets / comets / asteroids), fly-through reward boxes, and seeded enemy
 * combat pockets are all generated from `WORLD_SEED` (never the wall clock), so
 * every server boot lays out the same reproducible play space.  New per-frame
 * logic (reward respawn, enemy fire cadence + respawn) is driven by a tick
 * counter rather than `Date.now`, keeping the simulation replayable.  Celestial
 * bodies double as obstacles exposed via `getObstacles()` for fleet pathfinding.
 *
 * Deployable fleets (task #119)
 * ─────────────────────────────
 * Every commander gets a mothership (the deploy + zone anchor) plus a fighter
 * they fly.  They spend credits to deploy role-classed AI units (attacker /
 * defender / tactical / miner) from BENEATH the mothership.  Each deployed unit
 * is a UUID-identified, player-owned authoritative entity with a class-scaled
 * rated XYZ zone; its movement is driven by the deterministic, server-only
 * `fleetIntent` AI (clients only ever interpolate fleet units).
 */
import { randomUUID } from "node:crypto";
import {
  BOSS,
  CARRIER,
  CELESTIAL,
  ENEMY,
  FLEET_ROLES,
  MOTHER_SHIP,
  OUTPOST,
  PLATFORM,
  PLATFORM_DEFS,
  REWARD,
  SHIP,
  SHIP_TYPES,
  TICK_DT,
  TICK_HZ,
  SNAPSHOT_HZ,
  ESCORT,
  SHIELD,
  WEAPON,
  MISSILE,
  WORLD_SEED,
  applyCelestialForces,
  damageEntity,
  fleetFireCooldownTicks,
  shieldRegenPerSecFor,
  weaponDamageFor,
  encode,
  escortIntent,
  FACTION_ORDER,
  FACTIONS,
  fleetIntent,
  fleetRoleDef,
  forwardVec,
  hash01,
  isDeployableRole,
  isFactionId,
  isMinerShipType,
  makeRng,
  roleShipType,
  randInt,
  randRange,
  randSphere,
  resolveCelestialCollisions,
  resolveCelestialPenetration,
  resolveShipCollisions,
  spawnEntity,
  spawnShip,
  stepCelestial,
  stepShip,
  type BeamState,
  type CelestialBody,
  type CelestialKind,
  type EntityKind,
  type EntityState,
  type FactionId,
  type FleetContext,
  type FleetRole,
  type ForceKind,
  type GameEvent,
  type InputCommand,
  type Obstacle,
  type Outpost,
  type PlatformKind,
  type PlatformState,
  type PlayerEconomy,
  type ProjectileState,
  type RewardBox,
  type Rng,
} from "@workspace/carrier-net";
import { logger } from "../lib/logger";
import { postDiscord } from "./discord";

export interface Conn {
  send(data: string): void;
}

interface Player {
  id: string;
  conn: Conn;
  controlledEntityId: string;
  motherShipId: string;
  queue: InputCommand[];
  lastSeq: number;
  lastFireAt: number;
  lastMissileAt: number;
  credits: number;
  lastDeployAt: number;
  joined: boolean;
  /** Lore faction chosen at join — drives the mothership model + hull tint of the whole fleet. */
  faction: FactionId;
  /** simTick at which this commander actually entered (drives the enemy grace window). */
  joinTick: number;
}

/** Per-enemy bookkeeping kept out of the wire `EntityState`. */
interface EnemyMeta {
  /** Home anchor the enemy patrols around + respawns at. */
  hx: number;
  hy: number;
  hz: number;
  /** Earliest tick this enemy may fire again. */
  fireReadyTick: number;
  /** Tick at which a downed enemy respawns at home (0 = manual, via outpost). */
  respawnTick: number;
  /** The outpost this pirate garrisons (it is leashed to it). */
  outpostId: string;
}

/** Per-outpost server-only bookkeeping (never sent verbatim on the wire). */
interface OutpostMeta {
  /** Reward-cache box id this outpost guards (locked until cleared). */
  rewardId: string;
  /** Pirate entity ids garrisoning this outpost. */
  garrison: string[];
  /** Tick at which a cleared outpost re-arms (respawn garrison, re-lock reward). */
  rearmTick: number;
}

type LiveProjectile = ProjectileState & {
  dieAt: number;
  /** Player id of whoever fired — used to suppress friendly fire. */
  ownerPlayer: string;
  /** Per-projectile damage override (missiles hit harder). */
  damage?: number;
};

/** Per-fleet-unit server-only bookkeeping (never sent on the wire). */
interface FleetMeta {
  /** Zone-centre offset from the owning mothership (formation slot). */
  offX: number;
  offY: number;
  offZ: number;
  /** Last tick this unit fired (for its cooldown). */
  lastFireTick: number;
}

let nextProjectileId = 1;

/** Range (m) within which a miner hull extends an extraction cone onto a rock. */
const MINING_RANGE = 460;
/** How many ticks a laser beam stays drawn after a shot is fired. */
const LASER_SHOW_TICKS = 3;
/** Drawn length (m) of a free-aimed laser beam. */
const LASER_LEN = 520;

function isFiniteInput(cmd: InputCommand): boolean {
  return (
    Number.isFinite(cmd.seq) &&
    Number.isFinite(cmd.dt) &&
    Number.isFinite(cmd.thrust) &&
    Number.isFinite(cmd.yaw) &&
    Number.isFinite(cmd.pitch) &&
    Number.isFinite(cmd.roll)
  );
}

function randSpawn(): { px: number; py: number; pz: number; yaw: number } {
  const r = SHIP.arena * 0.6;
  return {
    px: (Math.random() * 2 - 1) * r,
    py: (Math.random() * 2 - 1) * r * 0.4,
    pz: (Math.random() * 2 - 1) * r,
    yaw: Math.random() * Math.PI * 2,
  };
}

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Produce a steering input that turns `e` toward a world point. */
function steerToward(
  e: EntityState,
  tx: number,
  ty: number,
  tz: number,
  thrust: number,
): InputCommand {
  const dx = tx - e.px;
  const dy = ty - e.py;
  const dz = tz - e.pz;
  const desiredYaw = Math.atan2(dx, dz);
  const yawErr = wrapAngle(desiredYaw - e.yaw);
  const horiz = Math.hypot(dx, dz);
  const desiredPitch = Math.atan2(dy, horiz);
  const pitchErr = wrapAngle(desiredPitch - e.pitch);
  return {
    seq: 0,
    dt: TICK_DT,
    thrust,
    yaw: clamp(yawErr * 2, -1, 1),
    pitch: clamp(pitchErr * 2, -1, 1),
    roll: 0,
    boost: false,
    fire: false,
    missile: false,
  };
}

/** Fleet weapon cooldown expressed in whole ticks. */
const FLEET_FIRE_COOLDOWN_TICKS = Math.ceil((WEAPON.cooldownMs * 2) / (1000 / TICK_HZ));

export class CarrierRoom {
  private players = new Map<string, Player>();
  private entities = new Map<string, EntityState>();
  private aiEntityIds = new Set<string>();
  private enemyMeta = new Map<string, EnemyMeta>();
  private projectiles: LiveProjectile[] = [];
  private events: GameEvent[] = [];
  private celestials: CelestialBody[] = [];
  private rewards: RewardBox[] = [];
  private rewardRespawnAt = new Map<string, number>();
  /** AI mining outposts (the contestable "ping" objectives). */
  private outposts: Outpost[] = [];
  private outpostMeta = new Map<string, OutpostMeta>();
  /** Reward ids that belong to an outpost (skipped by the free-reward respawn). */
  private guardedRewardIds = new Set<string>();
  private beams: BeamState[] = [];
  /** Tick when each entity last fired (for drawing transient laser beams). */
  private lastFireTick = new Map<string, number>();
  private lastFireAim = new Map<string, { x: number; y: number; z: number }>();
  /** UUID set of every server-driven (AI) fleet unit. */
  private fleet = new Map<string, FleetMeta>();
  /** Build platforms tethered to motherships, keyed by platform UUID. */
  private platforms = new Map<string, PlatformState>();
  /** Per-platform turret bookkeeping (kept off the wire). */
  private platformFire = new Map<string, { lastFireTick: number; aim: { x: number; y: number; z: number } | null }>();
  /** Per-mothership built-in turret bookkeeping (kept off the wire). */
  private motherFire = new Map<string, { lastFireTick: number; aim: { x: number; y: number; z: number } | null }>();
  /** Entity ids under direct player control this tick (excluded from fleet AI). */
  private controlledIds = new Set<string>();
  /** Last wall-clock ms each entity took shield damage (drives regen delay). */
  private shieldHitAt = new Map<string, number>();
  /** Escorting fleet units → the player id whose controlled ship they guard. */
  private escorts = new Map<string, string>();
  /** Spherical obstacles the fleet steers around (the celestial bodies). */
  private obstacles: Obstacle[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private snapTimer: ReturnType<typeof setInterval> | null = null;
  private nextId = 1;
  private tickCount = 0;
  private startedAt = Date.now();
  /** Monotonic tick counter — the deterministic clock the fleet AI runs on. */
  private simTick = 0;
  /** Seeded RNG for all fleet randomness (never Math.random). */
  private rng = makeRng(0x5ca1ab1e);

  constructor() {
    this.generateWorld();
  }

  // -------------------------------------------------------------------------
  // Deterministic world generation (seeded; never reads the wall clock).
  // -------------------------------------------------------------------------
  private generateWorld(): void {
    const rng = makeRng(WORLD_SEED);
    const arena = SHIP.arena;

    // Static planets — large gravity anchors.
    for (let i = 0; i < CELESTIAL.planetCount; i++) {
      const radius = randRange(rng, CELESTIAL.planetMinR, CELESTIAL.planetMaxR);
      const dist = randRange(rng, arena * 0.25, arena * 0.7);
      const [px, py, pz] = randSphere(rng, dist);
      this.celestials.push(
        this.makeStaticBody("planet", `planet-${i}`, px, py, pz, radius, "gravity", rng),
      );
    }

    // Drifting comets — small push (repulsor) bodies with a long tail of force.
    for (let i = 0; i < CELESTIAL.cometCount; i++) {
      const radius = randRange(rng, CELESTIAL.cometMinR, CELESTIAL.cometMaxR);
      const dist = randRange(rng, arena * 0.2, arena * 0.8);
      const [cx, cy, cz] = randSphere(rng, dist);
      this.celestials.push(
        this.makeMovingBody("comet", `comet-${i}`, cx, cy, cz, radius, "push", rng),
      );
    }

    // Tumbling asteroids — the mining targets; weak gravity, drift + collide.
    for (let i = 0; i < CELESTIAL.asteroidCount; i++) {
      const radius = randRange(rng, CELESTIAL.asteroidMinR, CELESTIAL.asteroidMaxR);
      const dist = randRange(rng, arena * 0.15, arena * 0.85);
      const [cx, cy, cz] = randSphere(rng, dist);
      this.celestials.push(
        this.makeMovingBody("asteroid", `asteroid-${i}`, cx, cy, cz, radius, "gravity", rng),
      );
    }

    // Reward boxes near asteroids + small planets (good fly-through bait).
    const anchors = this.celestials.filter(
      (b) => b.kind === "asteroid" || (b.kind === "planet" && b.radius <= CELESTIAL.smallPlanetR),
    );
    for (let i = 0; i < REWARD.count; i++) {
      const anchor = anchors.length
        ? anchors[randInt(rng, 0, anchors.length - 1)]
        : null;
      const base = anchor ? anchor.radius + randRange(rng, 60, 180) : randRange(rng, 200, arena * 0.7);
      const [ox, oy, oz] = randSphere(rng, base);
      const cx = anchor ? anchor.px : 0;
      const cy = anchor ? anchor.py : 0;
      const cz = anchor ? anchor.pz : 0;
      this.rewards.push({
        id: `reward-${i}`,
        px: cx + ox,
        py: cy + oy,
        pz: cz + oz,
        radius: REWARD.radius,
        amount: REWARD.amount,
        active: true,
      });
    }

    // AI mining outposts — the contestable objective "pings".  Each sits near an
    // asteroid (a mining target), guards a locked reward cache, and is defended
    // by a small pirate fleet leashed to it.  Clearing the garrison unlocks the
    // cache; the outpost re-arms on a tick clock so it can be contested again.
    for (let i = 0; i < OUTPOST.count; i++) {
      const anchor = anchors.length
        ? anchors[randInt(rng, 0, anchors.length - 1)]
        : null;
      const base = anchor
        ? anchor.radius + randRange(rng, 220, 420)
        : randRange(rng, arena * 0.25, arena * 0.65);
      const [ox, oy, oz] = randSphere(rng, base);
      const px = (anchor ? anchor.px : 0) + ox;
      const py = (anchor ? anchor.py : 0) + oy;
      const pz = (anchor ? anchor.pz : 0) + oz;
      const id = `outpost-${i}`;
      const seed = randInt(rng, 0, 0x7fffffff);

      // Seeded difficulty tier: weighted pick from OUTPOST.tiers so the map
      // offers a spread of easy→hard missions with scaled garrison + reward.
      const totalWeight = OUTPOST.tiers.reduce((s, t) => s + t.weight, 0);
      let roll = randRange(rng, 0, totalWeight);
      let tier: (typeof OUTPOST.tiers)[number] = OUTPOST.tiers[0];
      for (const t of OUTPOST.tiers) {
        if (roll < t.weight) { tier = t; break; }
        roll -= t.weight;
      }

      // Guarded reward cache, co-located with the outpost, locked until cleared.
      const rewardId = `outpost-reward-${i}`;
      this.rewards.push({
        id: rewardId,
        px,
        py,
        pz,
        radius: REWARD.radius,
        amount: tier.rewardAmount,
        active: false,
      });
      this.guardedRewardIds.add(rewardId);

      // Pirate garrison anchored around the outpost (size set by the tier).
      const garrison: string[] = [];
      for (let k = 0; k < tier.garrison; k++) {
        const [gx, gy, gz] = randSphere(rng, randRange(rng, 90, tier.radius + 200));
        // Pirates fly combat hulls (Scout / Cruiser / Dreadnought = 1, 4, 5).
        const combatTypes = [1, 4, 5];
        const shipType = combatTypes[randInt(rng, 0, combatTypes.length - 1)];
        const hx = px + gx;
        const hy = py + gy;
        const hz = pz + gz;
        const eid = `ai_${this.nextId++}`;
        const enemy = spawnEntity(
          eid,
          `Pirate-${i}-${k}`,
          "fighter",
          "enemy",
          ENEMY.team,
          shipType,
          hx,
          hy,
          hz,
          randRange(rng, -Math.PI, Math.PI),
        );
        this.entities.set(eid, enemy);
        this.aiEntityIds.add(eid);
        this.enemyMeta.set(eid, {
          hx,
          hy,
          hz,
          fireReadyTick: 0,
          respawnTick: 0,
          outpostId: id,
        });
        garrison.push(eid);
      }

      this.outposts.push({
        id,
        px,
        py,
        pz,
        radius: tier.radius,
        alertRadius: OUTPOST.alertRadius,
        garrisonAlive: garrison.length,
        garrisonTotal: garrison.length,
        cleared: false,
        rewardAmount: tier.rewardAmount,
        seed,
      });
      this.outpostMeta.set(id, { rewardId, garrison, rearmTick: 0 });
    }

    // The always-on world boss — a single oversized pirate capital ship that
    // loiters near the centre of the zone (0,0,0).
    this.spawnBoss();

    logger.info(
      {
        celestials: this.celestials.length,
        rewards: this.rewards.length,
        outposts: this.outposts.length,
        enemies: this.aiEntityIds.size,
        seed: WORLD_SEED,
      },
      "CarrierRoom world generated (deterministic)",
    );
  }

  /**
   * (Re)spawn the Pirate Dreadlord world boss at the centre of the zone with
   * full boss HP.  Registered as an AI entity (team `ENEMY.team`) so it shares
   * the projectile/damage/broadcast paths, but it is driven by `updateBoss`
   * rather than the outpost-leashed garrison AI.  Server-authoritative.
   */
  private spawnBoss(): void {
    const existing = this.entities.get(BOSS.id);
    if (existing) {
      existing.px = BOSS.cx; existing.py = BOSS.cy; existing.pz = BOSS.cz;
      existing.yaw = 0; existing.pitch = 0; existing.roll = 0;
      existing.vx = existing.vy = existing.vz = 0;
      existing.hp = BOSS.maxHp; existing.maxHp = BOSS.maxHp;
      existing.alive = true; existing.respawnAt = 0;
    } else {
      const boss = spawnEntity(
        BOSS.id, "Pirate Dreadlord", "fighter", "enemy",
        ENEMY.team, BOSS.shipType, BOSS.cx, BOSS.cy, BOSS.cz, 0,
      );
      boss.hp = BOSS.maxHp; boss.maxHp = BOSS.maxHp;
      this.entities.set(BOSS.id, boss);
      this.aiEntityIds.add(BOSS.id);
      this.enemyMeta.set(BOSS.id, {
        hx: BOSS.cx, hy: BOSS.cy, hz: BOSS.cz,
        fireReadyTick: 0, respawnTick: 0, outpostId: "",
      });
    }
  }

  private makeStaticBody(
    kind: CelestialKind,
    id: string,
    px: number,
    py: number,
    pz: number,
    radius: number,
    force: ForceKind,
    rng: Rng,
  ): CelestialBody {
    return {
      id,
      kind,
      px,
      py,
      pz,
      vx: 0,
      vy: 0,
      vz: 0,
      radius,
      mass: radius,
      force,
      forceRadius: radius * CELESTIAL.forceReachMult,
      rcx: px,
      rcy: py,
      rcz: pz,
      rhalf: 0,
      seed: randInt(rng, 1, 0x7fffffff),
    };
  }

  private makeMovingBody(
    kind: CelestialKind,
    id: string,
    px: number,
    py: number,
    pz: number,
    radius: number,
    force: ForceKind,
    rng: Rng,
  ): CelestialBody {
    const speed = randRange(rng, CELESTIAL.moveSpeedMin, CELESTIAL.moveSpeedMax);
    const [vx, vy, vz] = randSphere(rng, speed);
    return {
      id,
      kind,
      px,
      py,
      pz,
      vx,
      vy,
      vz,
      radius,
      mass: radius,
      force,
      forceRadius: radius * CELESTIAL.forceReachMult,
      rcx: px,
      rcy: py,
      rcz: pz,
      rhalf: CELESTIAL.regionHalf,
      seed: randInt(rng, 1, 0x7fffffff),
    };
  }

  /**
   * Celestial bodies as collision obstacles for future fleet pathfinding.
   * Returns a fresh, read-only snapshot (callers must not mutate the sim).
   */
  getObstacles(): { id: string; px: number; py: number; pz: number; radius: number }[] {
    return this.celestials.map((b) => ({
      id: b.id,
      px: b.px,
      py: b.py,
      pz: b.pz,
      radius: b.radius,
    }));
  }

  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), 1000 / TICK_HZ);
    this.snapTimer = setInterval(() => this.broadcast(), 1000 / SNAPSHOT_HZ);
    logger.info({ tickHz: TICK_HZ, snapshotHz: SNAPSHOT_HZ }, "CarrierRoom started");
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.snapTimer) clearInterval(this.snapTimer);
    this.tickTimer = null;
    this.snapTimer = null;
  }

  /**
   * Pick a player spawn that maximises clearance from the world boss (anchored
   * at the arena centre) and every pirate outpost, so commanders never drop
   * straight into a hostile zone. The plain `randSpawn` shell (arena * 0.6) sits
   * entirely inside the boss `engageRange`, which is why fresh players felt
   * attacked the instant the match started. We sample a handful of random spots
   * and keep the one whose nearest hostile anchor is farthest away.
   */
  private safePlayerSpawn(): { px: number; py: number; pz: number; yaw: number } {
    let best = randSpawn();
    let bestClearance = -Infinity;
    for (let i = 0; i < 24; i++) {
      const cand = randSpawn();
      let nearest = Math.hypot(cand.px - BOSS.cx, cand.py - BOSS.cy, cand.pz - BOSS.cz);
      for (const o of this.outposts) {
        const d = Math.hypot(cand.px - o.px, cand.py - o.py, cand.pz - o.pz);
        if (d < nearest) nearest = d;
      }
      if (nearest > bestClearance) { bestClearance = nearest; best = cand; }
    }
    return best;
  }

  add(conn: Conn): string {
    const id = `p${this.nextId++}`;

    // Mothership: the deploy + zone anchor, owned by the player. Placed clear of
    // the boss + outposts so the commander doesn't spawn under fire.
    const ms = this.safePlayerSpawn();
    const motherShipId = `ms_${id}`;
    const mother = spawnEntity(motherShipId, `${id}-carrier`, "mother_ship",
      id, 0, 0, ms.px, ms.py, ms.pz, ms.yaw);
    this.entities.set(motherShipId, mother);

    // Fighter: what the player flies, spawned just off the mothership.
    const fighter = spawnShip(id, id, 0,
      ms.px + 120, ms.py, ms.pz + 120, ms.yaw);
    this.entities.set(id, fighter);

    const player: Player = {
      id,
      conn,
      controlledEntityId: id,
      motherShipId,
      queue: [],
      lastSeq: 0,
      lastFireAt: 0,
      lastMissileAt: 0,
      credits: CARRIER.startCredits,
      lastDeployAt: 0,
      joined: false,
      faction: FACTION_ORDER[0],
      joinTick: 0,
    };
    this.players.set(id, player);

    conn.send(
      encode({
        t: "welcome",
        id,
        serverTime: Date.now() - this.startedAt,
        tickHz: TICK_HZ,
        snapshotHz: SNAPSHOT_HZ,
      }),
    );
    logger.info({ id, players: this.players.size }, "carrier commander joined");
    return id;
  }

  remove(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.entities.delete(id);
    this.entities.delete(p.motherShipId);
    this.motherFire.delete(p.motherShipId);
    // Disband the commander's whole fleet.
    for (const [uid, ent] of [...this.entities]) {
      if (ent.kind === "fleet_unit" && ent.owner === id) {
        this.entities.delete(uid);
        this.fleet.delete(uid);
      }
    }
    // Tear down every platform they had cabled to their carrier.
    for (const [pid, plat] of [...this.platforms]) {
      if (plat.owner === id) {
        this.platforms.delete(pid);
        this.platformFire.delete(pid);
      }
    }
    logger.info({ id, players: this.players.size }, "carrier commander left");
  }

  setIdentity(id: string, name: string, shipType: number, faction?: FactionId): void {
    const p = this.players.get(id);
    if (!p) return;
    if (faction && isFactionId(faction)) p.faction = faction;
    const entity = this.entities.get(p.controlledEntityId);
    if (entity) {
      entity.name = name.slice(0, 16) || id;
      entity.shipType = Math.max(0, Math.min(SHIP_TYPES - 1, shipType | 0));
      entity.faction = p.faction;
    }
    // The mothership wears the same faction (drives its station model + accent).
    const mother = this.entities.get(p.motherShipId);
    if (mother) mother.faction = p.faction;
    const wasJoined = p.joined;
    p.joined = true;
    // Start the enemy grace window from the moment the commander truly enters.
    p.joinTick = this.simTick;
    // Announce the arrival to Discord once (the client re-sends identity on
    // reconnect, so only fire on the first real entry).
    if (!wasJoined) {
      const callsign = (entity?.name ?? id).slice(0, 32);
      const faction = FACTIONS[p.faction]?.name ?? p.faction;
      postDiscord(
        `🚀 **${callsign}** joined the sector flying for **${faction}**. ` +
          `Commanders online: ${this.joinedCount()}.`,
      );
    }
  }

  /** Number of commanders that have fully entered the sector. */
  private joinedCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.joined) n++;
    return n;
  }

  enqueue(id: string, cmd: InputCommand): void {
    const p = this.players.get(id);
    if (!p) return;
    if (!isFiniteInput(cmd)) return;
    if (cmd.seq <= p.lastSeq || p.queue.some((q) => q.seq === cmd.seq)) return;
    p.queue.push(cmd);
  }

  addAIEntity(
    kind: EntityKind,
    owner: string,
    team: number,
    shipType: number,
  ): string {
    const id = `ai_${this.nextId++}`;
    const sp = randSpawn();
    const entity = spawnEntity(id, `AI-${id}`, kind, owner, team, shipType,
      sp.px, sp.py, sp.pz, sp.yaw);
    this.entities.set(id, entity);
    this.aiEntityIds.add(id);
    this.enemyMeta.set(id, {
      hx: sp.px, hy: sp.py, hz: sp.pz, fireReadyTick: 0, respawnTick: 0, outpostId: "",
    });
    logger.info({ id, kind, owner }, "carrier AI entity added");
    return id;
  }

  removeAIEntity(id: string): void {
    this.entities.delete(id);
    this.aiEntityIds.delete(id);
    this.enemyMeta.delete(id);
  }

  /** Monotonic-ish server clock (wall time); centralised so callers don't read it directly. */
  private now(): number {
    return Date.now();
  }

  // ─── Deploy ────────────────────────────────────────────────────────────────

  /**
   * Try to deploy one fleet unit of `role` for player `id`.  Enforces credits,
   * the global per-player cap, the per-role cap, and a short deploy cooldown —
   * all server-side.  Returns true on success.
   */
  deploy(id: string, role: FleetRole): boolean {
    const p = this.players.get(id);
    if (!p || !p.joined) return false;
    // Defence-in-depth: reject any non-deployable role even if it slipped past
    // the wire decoder, so cost/cap maths can never run with an undefined def.
    if (!isDeployableRole(role)) return false;
    const def = fleetRoleDef(role);
    if (!def) return false;

    const now = Date.now();
    if (now - p.lastDeployAt < CARRIER.deployCooldownMs) return false;
    if (p.credits < def.cost) return false;

    const mother = this.entities.get(p.motherShipId);
    if (!mother || !mother.alive) return false;

    // Caps: total fleet + per-role.
    let total = 0;
    let ofRole = 0;
    for (const ent of this.entities.values()) {
      if (ent.kind === "fleet_unit" && ent.owner === id) {
        total++;
        if (ent.role === role) ofRole++;
      }
    }
    if (total >= CARRIER.maxFleetPerPlayer) return false;
    if (ofRole >= def.cap) return false;

    p.credits -= def.cost;
    p.lastDeployAt = now;

    // Launch from BENEATH the mothership hull, with a little deterministic jitter.
    const jx = (this.rng() * 2 - 1) * 24;
    const jz = (this.rng() * 2 - 1) * 24;
    const px = mother.px + jx;
    const py = mother.py - CARRIER.launchOffset;
    const pz = mother.pz + jz;

    const uuid = randomUUID();
    const unit = spawnEntity(uuid, `${def.label}-${uuid.slice(0, 4)}`,
      "fleet_unit", id, mother.team, roleShipType(role), px, py, pz, mother.yaw, role,
      p.faction);
    unit.zoneR = def.zoneR;

    // Formation slot: spread units around the mothership in a deterministic ring
    // so each gets its own rated zone anchored relative to the mothership.
    const ang = this.rng() * Math.PI * 2;
    const ringR = def.zoneR * 0.6;
    const offY = (this.rng() * 2 - 1) * def.zoneR * 0.25;
    this.fleet.set(uuid, {
      offX: Math.cos(ang) * ringR,
      offY: offY - def.zoneR * 0.15,
      offZ: Math.sin(ang) * ringR,
      lastFireTick: 0,
    });

    this.refreshZone(unit);
    logger.info({ id, role, uuid }, "fleet unit deployed");
    return true;
  }

  // ─── Direct control (become) ───────────────────────────────────────────────

  /**
   * Take direct control of one owned entity.  Ownership is validated here — the
   * authoritative gate — so a client can never seize an entity it does not own.
   * The previously-controlled entity simply reverts to its autonomous behaviour
   * (fleet AI for fleet units; station-holding for the carrier/fighter).
   */
  become(id: string, entityId: string): boolean {
    const p = this.players.get(id);
    if (!p || !p.joined) return false;
    const target = this.entities.get(entityId);
    if (!target) return false;
    // The carrier, the fighter, and every fleet unit are all owner-stamped with
    // the commander's player id; reject anything not owned by this commander.
    if (target.owner !== id) return false;
    if (!target.alive) return false;
    if (p.controlledEntityId === entityId) return true;
    p.controlledEntityId = entityId;
    // Discard stale queued input from the previous body so the new one doesn't
    // inherit half-applied commands at the seam.
    p.queue = [];
    logger.info({ id, entityId, kind: target.kind }, "carrier commander took control");
    return true;
  }

  // ─── Build platforms ───────────────────────────────────────────────────────

  /**
   * Build one platform of `kind` and tether it to the commander's mothership.
   * Server-authoritative: validates ownership of a live carrier, credits, the
   * per-commander platform cap, a free slot, and a short build cooldown.  Cables
   * structurally link platforms to the carrier only — combat ships are never
   * tethered (enforced by construction: only platforms are ever cabled here).
   */
  build(id: string, kind: PlatformKind): boolean {
    const p = this.players.get(id);
    if (!p || !p.joined) return false;
    const def = PLATFORM_DEFS[kind];
    if (!def) return false;

    const now = Date.now();
    if (now - p.lastDeployAt < PLATFORM.buildCooldownMs) return false;

    const mother = this.entities.get(p.motherShipId);
    if (!mother || !mother.alive) return false;
    if (p.credits < def.cost) return false;

    // Find the lowest free slot index for this commander.
    const used = new Set<number>();
    let count = 0;
    for (const plat of this.platforms.values()) {
      if (plat.owner !== id) continue;
      used.add(plat.slot);
      count++;
    }
    if (count >= PLATFORM.maxPerPlayer) return false;
    let slot = 0;
    while (used.has(slot) && slot < PLATFORM.maxPerPlayer) slot++;
    if (slot >= PLATFORM.maxPerPlayer) return false;

    p.credits -= def.cost;
    p.lastDeployAt = now;

    const pid = randomUUID();
    const platform: PlatformState = {
      id: pid,
      owner: id,
      motherShipId: p.motherShipId,
      kind,
      slot,
      px: mother.px,
      py: mother.py,
      pz: mother.pz,
      hp: PLATFORM.maxHp,
      maxHp: PLATFORM.maxHp,
    };
    this.positionPlatform(platform, mother);
    this.platforms.set(pid, platform);
    this.platformFire.set(pid, { lastFireTick: 0, aim: null });
    logger.info({ id, kind, slot, pid }, "platform built");
    return true;
  }

  /** Re-anchor a tethered platform to its mothership at its slot offset. */
  private positionPlatform(plat: PlatformState, mother: EntityState): void {
    const ang = (plat.slot / PLATFORM.maxPerPlayer) * Math.PI * 2;
    plat.px = mother.px + Math.cos(ang) * PLATFORM.cableLength;
    plat.py = mother.py + PLATFORM.offsetY;
    plat.pz = mother.pz + Math.sin(ang) * PLATFORM.cableLength;
  }

  /** Re-anchor a unit's rated zone centre to its owner's mothership. */
  private refreshZone(unit: EntityState): void {
    const meta = this.fleet.get(unit.id);
    if (!meta) return;
    const mother = this.findMothership(unit.owner);
    if (mother) {
      unit.zoneX = mother.px + meta.offX;
      unit.zoneY = mother.py + meta.offY;
      unit.zoneZ = mother.pz + meta.offZ;
    }
  }

  private findMothership(owner: string): EntityState | undefined {
    const p = this.players.get(owner);
    if (!p) return undefined;
    const ms = this.entities.get(p.motherShipId);
    return ms && ms.alive ? ms : undefined;
  }

  // ─── Simulation tick ─────────────────────────────────────────────────────────

  private tick(): void {
    const now = this.now();
    this.tickCount++;
    this.simTick++;

    // Respawn downed player ships + motherships (AI enemies respawn on a tick
    // clock in updateEnemies; fleet units are removed on death instead).
    for (const entity of this.entities.values()) {
      if (this.aiEntityIds.has(entity.id) || entity.kind === "fleet_unit") continue;
      if (!entity.alive && now >= entity.respawnAt) {
        const sp = randSpawn();
        entity.px = sp.px; entity.py = sp.py; entity.pz = sp.pz;
        entity.yaw = sp.yaw; entity.pitch = 0; entity.roll = 0;
        entity.vx = entity.vy = entity.vz = 0;
        entity.hp = entity.maxHp; entity.alive = true; entity.respawnAt = 0;
      }
    }

    this.updateEnemies();
    this.updateBoss(now);

    // Refresh the set of entities under direct player control this tick, so the
    // fleet AI never fights the player for a unit it has taken over.
    this.controlledIds.clear();
    for (const p of this.players.values()) {
      if (p.joined) this.controlledIds.add(p.controlledEntityId);
    }

    // Credit accrual — deterministic, per fixed tick (no wall-clock).  Each live
    // production platform adds a flat bonus to its owner's rate.
    for (const p of this.players.values()) {
      if (!p.joined) continue;
      let rate = CARRIER.creditRatePerSec;
      for (const plat of this.platforms.values()) {
        if (plat.owner === p.id && plat.kind === "production") {
          rate += PLATFORM.productionBonusPerSec;
        }
      }
      p.credits += rate * TICK_DT;
    }

    // Fleet AI: deterministic server-side intent → shared integrator.
    this.tickFleet(now);

    // Platforms: keep them tethered to their carrier and run their capability.
    this.tickPlatforms(now);

    // Built-in mothership defensive turrets.
    this.tickMotherTurrets(now);

    // Player input.
    for (const p of this.players.values()) {
      const entity = this.entities.get(p.controlledEntityId);
      if (!entity) continue;
      const q = p.queue;
      p.queue = [];
      for (const cmd of q) {
        if (cmd.seq <= p.lastSeq) continue;
        const dt = Math.max(0, Math.min(0.05, cmd.dt));
        stepShip(entity, cmd, dt);
        p.lastSeq = cmd.seq;
        if (cmd.fire) this.tryFire(entity, p.id, now, () => p.lastFireAt, (t) => { p.lastFireAt = t; });
        if (cmd.missile) this.tryMissile(entity, p.id, now, () => p.lastMissileAt, (t) => { p.lastMissileAt = t; });
      }
    }

    // Celestial motion + body-on-body collisions.
    for (const b of this.celestials) stepCelestial(b, TICK_DT);
    for (const hit of resolveCelestialCollisions(this.celestials)) {
      this.events.push({ k: "impact", px: hit.px, py: hit.py, pz: hit.pz });
    }

    // Gravity / push forces + hard penetration for every live ship.
    for (const entity of this.entities.values()) {
      if (!entity.alive) continue;
      applyCelestialForces(entity, this.celestials, TICK_DT);
      const contact = resolveCelestialPenetration(entity, this.celestials);
      if (contact) this.events.push({ k: "impact", px: contact.px, py: contact.py, pz: contact.pz });
    }

    // Ship-on-ship collisions: pure, mass-weighted separation + bounce, with
    // hostile (cross-team) hulls grinding each other down via shield-then-hull
    // damage. Iterate insertion-order-stable values for determinism.
    this.resolveCollisions(now);

    // Shield regen: each entity recharges after a delay since its last shield hit.
    this.regenShields(now);

    this.updateRewards();
    this.stepProjectiles(now);
    this.updateOutposts();
    this.buildBeams();
  }

  /**
   * Resolve ship-on-ship collisions for the tick. Collects every live ship into
   * an insertion-order-stable array (deterministic), runs the pure
   * `resolveShipCollisions` solver (mass-weighted separation + restitution bounce
   * + hostile grind damage applied via shield-then-hull `damageEntity` inside the
   * solver), then surfaces impact FX, stamps shield-hit clocks for grind contacts,
   * and removes/kills any hull destroyed by the grind. Pure-data in, authority out.
   */
  private resolveCollisions(now: number): void {
    const ships: EntityState[] = [];
    for (const e of this.entities.values()) if (e.alive) ships.push(e);
    if (ships.length < 2) return;

    // Snapshot shields so we can stamp the regen-delay clock for any hull the
    // grind drained this tick (contacts carry no entity ids).
    const shieldBefore = new Map<string, number>();
    for (const e of ships) shieldBefore.set(e.id, e.shield);

    const contacts = resolveShipCollisions(ships, TICK_DT);
    for (const c of contacts) {
      this.events.push({ k: "impact", px: c.px, py: c.py, pz: c.pz });
    }

    const deadFleet = new Set<string>();
    for (const e of ships) {
      if (e.shield < (shieldBefore.get(e.id) ?? e.shield)) this.shieldHitAt.set(e.id, now);
      // Apply destruction for any ship the grind took to zero hull.
      if (e.alive && e.hp <= 0) {
        this.killEntity(e, "", now);
        if (e.kind === "fleet_unit") deadFleet.add(e.id);
      }
    }
    for (const id of deadFleet) this.removeFleetUnit(id);
  }

  /**
   * Recharge entity shields. A shield only regenerates once `SHIELD.regenDelayMs`
   * has elapsed since it last took damage; it then refills at `SHIELD.regenPerSec`
   * up to the entity's `maxShield`. Dead entities and those with no shield capacity
   * are skipped. Uses wall-clock `now` to gate the delay (server authority).
   */
  private regenShields(now: number): void {
    for (const e of this.entities.values()) {
      if (!e.alive || e.maxShield <= 0 || e.shield >= e.maxShield) continue;
      const hitAt = this.shieldHitAt.get(e.id) ?? 0;
      if (now - hitAt < SHIELD.regenDelayMs) continue;
      e.shield = Math.min(e.maxShield, e.shield + shieldRegenPerSecFor(e) * TICK_DT);
    }
  }

  /**
   * Pirate-garrison AI.  Each pirate is LEASHED to its outpost: it only wakes
   * when a player comes within the outpost's `alertRadius`, never chases past
   * `OUTPOST.leashRadius` of the outpost centre, and otherwise drifts back to its
   * home anchor.  Dead pirates stay down until their outpost re-arms (handled in
   * `updateOutposts`), so there are no arena-wide random attacks.
   */
  private updateEnemies(): void {
    for (const id of this.aiEntityIds) {
      if (id === BOSS.id) continue; // the world boss is driven by updateBoss
      const e = this.entities.get(id);
      const meta = this.enemyMeta.get(id);
      if (!e || !meta || !e.alive) continue;

      const outpost = this.outpostById(meta.outpostId);
      // Leash anchor = outpost centre (fall back to home if it somehow vanished).
      const ocx = outpost ? outpost.px : meta.hx;
      const ocy = outpost ? outpost.py : meta.hy;
      const ocz = outpost ? outpost.pz : meta.hz;

      const target = this.nearestPlayerNear(
        ocx, ocy, ocz, outpost ? outpost.alertRadius : OUTPOST.alertRadius,
      );
      if (target) {
        // Leash: if we've drifted too far from the outpost, return before chasing.
        const lx = e.px - ocx, ly = e.py - ocy, lz = e.pz - ocz;
        if (Math.hypot(lx, ly, lz) > OUTPOST.leashRadius) {
          stepShip(e, steerToward(e, ocx, ocy, ocz, 1), TICK_DT);
          continue;
        }
        const dx = target.px - e.px, dy = target.py - e.py, dz = target.pz - e.pz;
        const dist = Math.hypot(dx, dy, dz);
        stepShip(e, steerToward(e, target.px, target.py, target.pz, 1), TICK_DT);
        const [fx, fy, fz] = forwardVec(e.yaw, e.pitch);
        const aim = dist > 1e-3 ? (fx * dx + fy * dy + fz * dz) / dist : 0;
        if (dist <= ENEMY.fireRange && aim >= ENEMY.fireAim && this.tickCount >= meta.fireReadyTick) {
          const lead = dist / WEAPON.projectileSpeed;
          this.spawnProjectileAt(
            e, e.owner, this.now(),
            target.px + target.vx * lead,
            target.py + target.vy * lead,
            target.pz + target.vz * lead,
          );
          meta.fireReadyTick = this.tickCount + ENEMY.fireCooldownTicks;
        }
        continue;
      }
      // No player threatening the outpost — drift home.
      stepShip(e, steerToward(e, meta.hx, meta.hy, meta.hz, 0.35), TICK_DT);
    }
  }

  /**
   * Drive the Pirate Dreadlord world boss.  While alive it loiters near the
   * centre of the zone (leashed to `BOSS.leashRadius`), hunts the nearest joined
   * commander within `BOSS.engageRange`, and fires when aimed + in range.  While
   * dead it re-arms on a tick clock so the event is never-ending; the re-spawn
   * posts a Discord "appeared" notice whenever commanders are present.
   */
  private updateBoss(now: number): void {
    void now;
    const e = this.entities.get(BOSS.id);
    const meta = this.enemyMeta.get(BOSS.id);
    if (!e || !meta) return;

    if (!e.alive) {
      // Re-arm on a tick clock (deterministic) once the cooldown elapses.
      if (this.tickCount >= meta.respawnTick) {
        this.spawnBoss();
        // Only announce a fresh appearance while commanders are in the sector.
        if (this.anyJoined()) {
          postDiscord(
            "☠️ **A Pirate Dreadlord has emerged near the galactic core!** " +
              "Rally and take it down for a shared bounty.",
          );
        }
      }
      return;
    }

    const target = this.nearestPlayerNear(BOSS.cx, BOSS.cy, BOSS.cz, BOSS.engageRange);
    if (target) {
      // Leash: return to centre before chasing if we've drifted too far.
      const lx = e.px - BOSS.cx, ly = e.py - BOSS.cy, lz = e.pz - BOSS.cz;
      if (Math.hypot(lx, ly, lz) > BOSS.leashRadius) {
        stepShip(e, steerToward(e, BOSS.cx, BOSS.cy, BOSS.cz, 1), TICK_DT);
        return;
      }
      const dx = target.px - e.px, dy = target.py - e.py, dz = target.pz - e.pz;
      const dist = Math.hypot(dx, dy, dz);
      stepShip(e, steerToward(e, target.px, target.py, target.pz, 1), TICK_DT);
      const [fx, fy, fz] = forwardVec(e.yaw, e.pitch);
      const aim = dist > 1e-3 ? (fx * dx + fy * dy + fz * dz) / dist : 0;
      if (dist <= BOSS.fireRange && aim >= BOSS.fireAim && this.tickCount >= meta.fireReadyTick) {
        const lead = dist / WEAPON.projectileSpeed;
        this.spawnProjectileAt(
          e, e.owner, this.now(),
          target.px + target.vx * lead,
          target.py + target.vy * lead,
          target.pz + target.vz * lead,
        );
        meta.fireReadyTick = this.tickCount + BOSS.fireCooldownTicks;
      }
      return;
    }
    // No commander in range — drift back toward the centre.
    stepShip(e, steerToward(e, BOSS.cx, BOSS.cy, BOSS.cz, 0.35), TICK_DT);
  }

  /** True if at least one commander has fully entered the sector. */
  private anyJoined(): boolean {
    for (const p of this.players.values()) if (p.joined) return true;
    return false;
  }

  /**
   * Boss-down payoff: pay every joined commander the bounty and announce the
   * defeat to Discord.  Called from `applyDamage` the tick the boss is downed.
   */
  private handleBossDefeated(): void {
    let paid = 0;
    for (const p of this.players.values()) {
      if (!p.joined) continue;
      p.credits += BOSS.bounty;
      paid++;
    }
    logger.info({ paid, bounty: BOSS.bounty }, "carrier pirate boss defeated");
    if (paid > 0) {
      postDiscord(
        `💥 **The Pirate Dreadlord has been destroyed!** ` +
          `Bounty of ${BOSS.bounty} credits paid to ${paid} commander${paid === 1 ? "" : "s"}.`,
      );
    }
  }

  /**
   * Maintain outpost state each tick: recount the living garrison, unlock the
   * reward cache when an outpost is cleared, and re-arm (respawn the garrison +
   * re-lock the cache) once its contest timer elapses.
   */
  private updateOutposts(): void {
    for (const o of this.outposts) {
      const meta = this.outpostMeta.get(o.id);
      if (!meta) continue;

      let alive = 0;
      for (const eid of meta.garrison) {
        const e = this.entities.get(eid);
        if (e && e.alive) alive++;
      }
      o.garrisonAlive = alive;

      const reward = this.rewards.find((r) => r.id === meta.rewardId);

      if (!o.cleared && alive === 0) {
        // Just cleared — unlock the reward cache + start the re-arm timer.
        o.cleared = true;
        if (reward) reward.active = true;
        meta.rearmTick = this.tickCount + OUTPOST.contestRespawnTicks;
        this.events.push({ k: "reward", px: o.px, py: o.py, pz: o.pz });
      } else if (o.cleared && this.tickCount >= meta.rearmTick) {
        // Re-arm: respawn the whole garrison at home + re-lock the cache.
        for (const eid of meta.garrison) {
          const e = this.entities.get(eid);
          const em = this.enemyMeta.get(eid);
          if (!e || !em) continue;
          e.px = em.hx; e.py = em.hy; e.pz = em.hz;
          e.pitch = 0; e.roll = 0;
          e.vx = e.vy = e.vz = 0;
          e.hp = SHIP.maxHp; e.alive = true; e.respawnAt = 0;
        }
        o.garrisonAlive = meta.garrison.length;
        o.cleared = false;
        if (reward) {
          reward.active = false;
          this.rewardRespawnAt.delete(reward.id);
        }
      }
    }
  }

  private outpostById(id: string): Outpost | null {
    for (const o of this.outposts) if (o.id === id) return o;
    return null;
  }

  /** Nearest live, past-grace player entity within `radius` of a world point. */
  private nearestPlayerNear(
    x: number, y: number, z: number, radius: number,
  ): EntityState | null {
    let best: EntityState | null = null;
    let bestD2 = radius * radius;
    for (const p of this.players.values()) {
      if (!p.joined) continue;
      // Startup safe-window: leave fresh commanders (and their motherships)
      // alone so nothing approaches them for roughly the first minute.
      if (this.simTick - p.joinTick < ENEMY.graceTicks) continue;
      const t = this.entities.get(p.controlledEntityId);
      if (!t || !t.alive) continue;
      const dx = t.px - x, dy = t.py - y, dz = t.pz - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= bestD2) { bestD2 = d2; best = t; }
    }
    return best;
  }

  /** Fly-through reward pickups (players only) + tick-based respawn. */
  private updateRewards(): void {
    for (const box of this.rewards) {
      if (box.active) continue;
      // Outpost-guarded caches are unlocked/re-locked by `updateOutposts`, never
      // on the free fly-through respawn timer.
      if (this.guardedRewardIds.has(box.id)) continue;
      const at = this.rewardRespawnAt.get(box.id);
      if (at !== undefined && this.tickCount >= at) {
        box.active = true;
        this.rewardRespawnAt.delete(box.id);
      }
    }
    for (const p of this.players.values()) {
      if (!p.joined) continue;
      const e = this.entities.get(p.controlledEntityId);
      if (!e || !e.alive) continue;
      for (const box of this.rewards) {
        if (!box.active) continue;
        const dx = box.px - e.px, dy = box.py - e.py, dz = box.pz - e.pz;
        if (dx * dx + dy * dy + dz * dz <= box.radius * box.radius) {
          box.active = false;
          // Free boxes reappear on the shared timer; a guarded cache stays
          // collected until its outpost re-arms (re-locks it).
          if (!this.guardedRewardIds.has(box.id)) {
            this.rewardRespawnAt.set(box.id, this.tickCount + REWARD.respawnTicks);
          }
          p.credits += box.amount;
          this.events.push({ k: "reward", px: box.px, py: box.py, pz: box.pz });
        }
      }
    }
  }

  private tickFleet(now: number): void {
    for (const [uid, meta] of this.fleet) {
      const unit = this.entities.get(uid);
      if (!unit) { this.fleet.delete(uid); continue; }
      if (!unit.alive) continue;
      // A unit the player has "become" is driven by their input, not the AI.
      if (this.controlledIds.has(uid)) continue;

      this.refreshZone(unit);

      const hostile = this.nearestHostile(unit);
      const rand = hash01(this.simTick, hashStr(uid), 7);

      // Escorting units fly the dedicated escort brain toward the player's
      // currently-controlled ship; everything else holds its rated zone.
      const intent = this.escortTarget(uid)
        ? this.escortIntentFor(unit, uid, hostile)
        : fleetIntent(unit, {
            zone: { x: unit.zoneX, y: unit.zoneY, z: unit.zoneZ },
            zoneR: unit.zoneR,
            hostile,
            ward: unit.role === "frigate" ? this.mostHurtAlly(unit) : null,
            obstacles: this.obstacles,
            tick: this.simTick,
            rand,
          });
      stepShip(unit, intent, TICK_DT);

      const def = fleetRoleDef(unit.role);
      if (intent.fire && def && def.armed &&
          this.simTick - meta.lastFireTick >=
            fleetFireCooldownTicks(unit.role, FLEET_FIRE_COOLDOWN_TICKS)) {
        meta.lastFireTick = this.simTick;
        this.spawnProjectile(unit, unit.owner, now);
      }
    }
  }

  /**
   * Resolve the live ship a unit is escorting, or `null` if it isn't escorting
   * (or the protected ship is gone/dead, in which case the stale escort order is
   * cleared so the unit reverts to holding its rated zone).
   */
  private escortTarget(uid: string): EntityState | null {
    const playerId = this.escorts.get(uid);
    if (!playerId) return null;
    const p = this.players.get(playerId);
    const protect = p && p.joined ? this.entities.get(p.controlledEntityId) : undefined;
    if (!protect || !protect.alive) { this.escorts.delete(uid); return null; }
    return protect;
  }

  /**
   * Build the per-unit `EscortContext` (deterministic formation slot from the
   * unit's stable uid) and run the pure `escortIntent` brain.
   */
  private escortIntentFor(
    unit: EntityState,
    uid: string,
    hostile: EntityState | null,
  ): InputCommand {
    const protect = this.escortTarget(uid)!;
    // Deterministic ring slot around the protected ship, stable per unit uid.
    const ang = hash01(hashStr(uid), 0, 31) * Math.PI * 2;
    const lift = (hash01(hashStr(uid), 0, 33) * 2 - 1) * ESCORT.formationR * 0.3;
    return escortIntent(unit, {
      protect: { x: protect.px, y: protect.py, z: protect.pz },
      slot: {
        x: Math.cos(ang) * ESCORT.formationR,
        y: lift,
        z: Math.sin(ang) * ESCORT.formationR,
      },
      hostile,
      obstacles: this.obstacles,
      tick: this.simTick,
      rand: hash01(this.simTick, hashStr(uid), 11),
    });
  }

  /**
   * Toggle an escort order on one owned fleet unit. Server-authoritative: only
   * the unit's owner may summon it, the unit must be a live fleet unit, and a
   * unit already escorting is recalled (toggle). The unit flies to its owner's
   * currently-controlled ship via the escort brain until recalled or destroyed.
   */
  summon(id: string, entityId: string): boolean {
    const p = this.players.get(id);
    if (!p || !p.joined) return false;
    const unit = this.entities.get(entityId);
    if (!unit || !unit.alive) return false;
    if (unit.owner !== id) return false;
    if (unit.kind !== "fleet_unit") return false;
    // Can't escort the ship you're currently piloting.
    if (p.controlledEntityId === entityId) return false;
    if (this.escorts.get(entityId) === id) {
      this.escorts.delete(entityId);
      logger.info({ id, entityId }, "fleet unit recalled from escort");
    } else {
      this.escorts.set(entityId, id);
      logger.info({ id, entityId }, "fleet unit summoned to escort");
    }
    return true;
  }

  /**
   * Keep every platform glued to its carrier and run its per-kind capability:
   * turrets auto-fire at the nearest hostile in range; utility platforms repair
   * nearby owned units; production platforms are handled in credit accrual.  A
   * platform whose carrier is gone (or whose hull is destroyed) is removed.
   */
  private tickPlatforms(now: number): void {
    for (const [pid, plat] of [...this.platforms]) {
      const mother = this.entities.get(plat.motherShipId);
      if (!mother) {
        this.platforms.delete(pid);
        this.platformFire.delete(pid);
        continue;
      }
      if (plat.hp <= 0) {
        this.events.push({ k: "explode", px: plat.px, py: plat.py, pz: plat.pz });
        this.platforms.delete(pid);
        this.platformFire.delete(pid);
        continue;
      }

      // Stay tethered to the carrier at the platform's slot offset.
      this.positionPlatform(plat, mother);

      const pf = this.platformFire.get(pid);

      if (plat.kind === "turret") {
        let target: EntityState | null = null;
        let bestD2 = PLATFORM.turretRange * PLATFORM.turretRange;
        for (const ent of this.entities.values()) {
          if (!ent.alive || ent.owner === plat.owner) continue;
          const dx = ent.px - plat.px, dy = ent.py - plat.py, dz = ent.pz - plat.pz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < bestD2) { bestD2 = d2; target = ent; }
        }
        if (target && pf && this.simTick - pf.lastFireTick >= PLATFORM.turretFireCooldownTicks) {
          pf.lastFireTick = this.simTick;
          this.firePlatformBolt(plat, mother, target.px, target.py, target.pz, now);
        }
      } else if (plat.kind === "utility") {
        const r2 = PLATFORM.utilityRange * PLATFORM.utilityRange;
        for (const ent of this.entities.values()) {
          if (!ent.alive || ent.owner !== plat.owner) continue;
          if (ent.hp >= ent.maxHp) continue;
          const dx = ent.px - plat.px, dy = ent.py - plat.py, dz = ent.pz - plat.pz;
          if (dx * dx + dy * dy + dz * dz <= r2) {
            ent.hp = Math.min(ent.maxHp, ent.hp + PLATFORM.utilityRepairPerSec * TICK_DT);
          }
        }
      }
    }
  }

  /** Fire one turret bolt from a platform toward a target point. */
  private firePlatformBolt(
    plat: PlatformState,
    mother: EntityState,
    tx: number,
    ty: number,
    tz: number,
    now: number,
  ): void {
    const dx = tx - plat.px, dy = ty - plat.py, dz = tz - plat.pz;
    const d = Math.hypot(dx, dy, dz) || 1;
    const dirx = dx / d, diry = dy / d, dirz = dz / d;
    this.projectiles.push({
      id: nextProjectileId++,
      // Attribute the bolt to the carrier so the existing team / own-fleet
      // friendly-fire checks treat it as the commander's fire.
      owner: mother.id,
      ownerPlayer: plat.owner,
      px: plat.px, py: plat.py, pz: plat.pz,
      vx: dirx * WEAPON.projectileSpeed,
      vy: diry * WEAPON.projectileSpeed,
      vz: dirz * WEAPON.projectileSpeed,
      dieAt: now + WEAPON.projectileLifeMs,
    });
    this.events.push({ k: "fire", px: plat.px, py: plat.py, pz: plat.pz });
    const pf = this.platformFire.get(plat.id);
    if (pf) {
      pf.aim = {
        x: plat.px + dirx * LASER_LEN,
        y: plat.py + diry * LASER_LEN,
        z: plat.pz + dirz * LASER_LEN,
      };
    }
  }

  /**
   * Built-in mothership defensive turrets: each live mothership auto-fires a
   * salvo at the nearest hostile (different team) within range, on a tick-based
   * cooldown.  Mirrors the platform-turret pattern; deterministic (no wall-clock
   * gates the firing decision — `now` only stamps projectile lifetimes).
   */
  private tickMotherTurrets(now: number): void {
    for (const e of this.entities.values()) {
      if (e.kind !== "mother_ship" || !e.alive) continue;
      let mf = this.motherFire.get(e.id);
      if (!mf) { mf = { lastFireTick: 0, aim: null }; this.motherFire.set(e.id, mf); }
      if (this.simTick - mf.lastFireTick < MOTHER_SHIP.turretFireCooldownTicks) continue;

      // Nearest hostile (different team, not the commander's own) in range.
      let target: EntityState | null = null;
      let bestD2 = MOTHER_SHIP.turretRange * MOTHER_SHIP.turretRange;
      for (const t of this.entities.values()) {
        if (!t.alive || t.team === e.team || t.owner === e.owner) continue;
        const dx = t.px - e.px, dy = t.py - e.py, dz = t.pz - e.pz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; target = t; }
      }
      if (!target) continue;

      mf.lastFireTick = this.simTick;
      // Salvo from evenly-spaced hull mounts toward the target.  The functional
      // bolt count is balance-capped (`turretSalvoBolts`) even though the hull
      // displays 20–30 cosmetic turret models.
      const r = MOTHER_SHIP.turretMountRadius;
      for (let i = 0; i < MOTHER_SHIP.turretSalvoBolts; i++) {
        const ang = (i / MOTHER_SHIP.turretSalvoBolts) * Math.PI * 2;
        const mx = e.px + Math.cos(ang) * r;
        const my = e.py;
        const mz = e.pz + Math.sin(ang) * r;
        const dx = target.px - mx, dy = target.py - my, dz = target.pz - mz;
        const d = Math.hypot(dx, dy, dz) || 1;
        this.projectiles.push({
          id: nextProjectileId++,
          // Attribute to the mothership so friendly-fire checks treat the salvo
          // as the commander's own fire (never hits its fleet/fighter/itself).
          owner: e.id,
          ownerPlayer: e.owner,
          px: mx, py: my, pz: mz,
          vx: (dx / d) * WEAPON.projectileSpeed,
          vy: (dy / d) * WEAPON.projectileSpeed,
          vz: (dz / d) * WEAPON.projectileSpeed,
          dieAt: now + WEAPON.projectileLifeMs,
        });
        this.events.push({ k: "fire", px: mx, py: my, pz: mz });
      }
      // One representative laser beam toward the target for the client.
      const dx = target.px - e.px, dy = target.py - e.py, dz = target.pz - e.pz;
      const d = Math.hypot(dx, dy, dz) || 1;
      mf.aim = {
        x: e.px + (dx / d) * LASER_LEN,
        y: e.py + (dy / d) * LASER_LEN,
        z: e.pz + (dz / d) * LASER_LEN,
      };
    }
  }

  /** Nearest alive entity not owned by `unit`'s commander (a hostile). */
  private nearestHostile(unit: EntityState): EntityState | null {
    let best: EntityState | null = null;
    let bestD = Infinity;
    for (const ent of this.entities.values()) {
      if (!ent.alive) continue;
      if (ent.owner === unit.owner) continue;
      const dx = ent.px - unit.px, dy = ent.py - unit.py, dz = ent.pz - unit.pz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = ent; }
    }
    return best;
  }

  /** The owner's most-damaged ally (for tactical units to protect). */
  private mostHurtAlly(unit: EntityState): EntityState | null {
    let best: EntityState | null = null;
    let bestFrac = 1.01;
    for (const ent of this.entities.values()) {
      if (!ent.alive || ent.id === unit.id) continue;
      if (ent.owner !== unit.owner) continue;
      if (ent.kind === "mother_ship") continue;
      const frac = ent.hp / ent.maxHp;
      if (frac < bestFrac) { bestFrac = frac; best = ent; }
    }
    return best;
  }

  // ─── Weapons ─────────────────────────────────────────────────────────────────

  private tryFire(
    entity: EntityState,
    ownerPlayer: string,
    now: number,
    getLast: () => number,
    setLast: (t: number) => void,
  ): void {
    if (!entity.alive) return;
    if (now - getLast() < WEAPON.cooldownMs) return;
    setLast(now);
    this.spawnProjectile(entity, ownerPlayer, now);
  }

  private tryMissile(
    entity: EntityState,
    ownerPlayer: string,
    now: number,
    getLast: () => number,
    setLast: (t: number) => void,
  ): void {
    if (!entity.alive) return;
    if (now - getLast() < MISSILE.cooldownMs) return;
    setLast(now);
    this.spawnMissile(entity, ownerPlayer, now);
  }

  /** Fire one bolt along the entity's facing and record laser-beam endpoints. */
  private spawnProjectile(entity: EntityState, ownerPlayer: string, now: number): void {
    const [fx, fy, fz] = forwardVec(entity.yaw, entity.pitch);
    this.pushBolt(entity, ownerPlayer, now, fx, fy, fz);
  }

  /** Fire one bolt toward a world point (lead targeting for AI). */
  private spawnProjectileAt(
    entity: EntityState,
    ownerPlayer: string,
    now: number,
    tx: number,
    ty: number,
    tz: number,
  ): void {
    const dx = tx - entity.px, dy = ty - entity.py, dz = tz - entity.pz;
    const d = Math.hypot(dx, dy, dz) || 1;
    this.pushBolt(entity, ownerPlayer, now, dx / d, dy / d, dz / d);
  }

  private pushBolt(
    entity: EntityState,
    ownerPlayer: string,
    now: number,
    fx: number,
    fy: number,
    fz: number,
  ): void {
    const mx = entity.px + fx * WEAPON.muzzleForward;
    const my = entity.py + fy * WEAPON.muzzleForward;
    const mz = entity.pz + fz * WEAPON.muzzleForward;
    this.projectiles.push({
      id: nextProjectileId++,
      owner: entity.id,
      ownerPlayer,
      kind: "bolt",
      px: mx, py: my, pz: mz,
      vx: fx * WEAPON.projectileSpeed + entity.vx,
      vy: fy * WEAPON.projectileSpeed + entity.vy,
      vz: fz * WEAPON.projectileSpeed + entity.vz,
      dieAt: now + WEAPON.projectileLifeMs,
    });
    this.events.push({ k: "fire", px: mx, py: my, pz: mz });
    this.lastFireTick.set(entity.id, this.tickCount);
    this.lastFireAim.set(entity.id, {
      x: mx + fx * LASER_LEN,
      y: my + fy * LASER_LEN,
      z: mz + fz * LASER_LEN,
    });
  }

  /** Launch a homing missile along the ship's nose. */
  private spawnMissile(entity: EntityState, ownerPlayer: string, now: number): void {
    const [fx, fy, fz] = forwardVec(entity.yaw, entity.pitch);
    const mx = entity.px + fx * MISSILE.muzzleForward;
    const my = entity.py + fy * MISSILE.muzzleForward;
    const mz = entity.pz + fz * MISSILE.muzzleForward;
    this.projectiles.push({
      id: nextProjectileId++,
      owner: entity.id,
      ownerPlayer,
      kind: "missile",
      px: mx, py: my, pz: mz,
      vx: fx * MISSILE.projectileSpeed + entity.vx * 0.35,
      vy: fy * MISSILE.projectileSpeed + entity.vy * 0.35,
      vz: fz * MISSILE.projectileSpeed + entity.vz * 0.35,
      dieAt: now + MISSILE.projectileLifeMs,
      damage: MISSILE.damage,
    });
    this.events.push({ k: "fire", px: mx, py: my, pz: mz });
  }

  /**
   * Rebuild the live beam list each tick: a mining cone from every miner-class
   * hull to the rock it is harvesting, plus a transient laser beam for any
   * entity that fired in the last few ticks.
   */
  private buildBeams(): void {
    const beams: BeamState[] = [];
    for (const e of this.entities.values()) {
      if (!e.alive) continue;
      const [fx, fy, fz] = forwardVec(e.yaw, e.pitch);
      const mx = e.px + fx * WEAPON.muzzleForward;
      const my = e.py + fy * WEAPON.muzzleForward;
      const mz = e.pz + fz * WEAPON.muzzleForward;

      // Mining cone → nearest harvestable rock in range.
      if (isMinerShipType(e.shipType)) {
        const rock = this.nearestRockTo(e, MINING_RANGE);
        if (rock) {
          const dx = e.px - rock.px, dy = e.py - rock.py, dz = e.pz - rock.pz;
          const d = Math.hypot(dx, dy, dz) || 1;
          beams.push({
            id: `mine-${e.uid}`,
            kind: "mining",
            sourceUid: e.uid,
            sx: mx, sy: my, sz: mz,
            targetUid: rock.id,
            tx: rock.px + (dx / d) * rock.radius,
            ty: rock.py + (dy / d) * rock.radius,
            tz: rock.pz + (dz / d) * rock.radius,
            team: e.team,
          });
        }
      }

      // Transient laser beam after a recent shot.
      const lastFire = this.lastFireTick.get(e.id);
      if (lastFire !== undefined && this.tickCount - lastFire <= LASER_SHOW_TICKS) {
        const aim = this.lastFireAim.get(e.id);
        if (aim) {
          beams.push({
            id: `laser-${e.uid}`,
            kind: "laser",
            sourceUid: e.uid,
            sx: mx, sy: my, sz: mz,
            targetUid: "",
            tx: aim.x, ty: aim.y, tz: aim.z,
            team: e.team,
          });
        }
      }
    }

    // Transient turret beams from platforms that fired recently.
    for (const plat of this.platforms.values()) {
      if (plat.kind !== "turret") continue;
      const pf = this.platformFire.get(plat.id);
      if (!pf || !pf.aim) continue;
      if (this.simTick - pf.lastFireTick > LASER_SHOW_TICKS) continue;
      const mother = this.entities.get(plat.motherShipId);
      beams.push({
        id: `plat-laser-${plat.id}`,
        kind: "laser",
        sourceUid: plat.id,
        sx: plat.px, sy: plat.py, sz: plat.pz,
        targetUid: "",
        tx: pf.aim.x, ty: pf.aim.y, tz: pf.aim.z,
        team: mother ? mother.team : 0,
      });
    }

    // Transient turret beams from motherships that fired recently.
    for (const e of this.entities.values()) {
      if (e.kind !== "mother_ship" || !e.alive) continue;
      const mf = this.motherFire.get(e.id);
      if (!mf || !mf.aim) continue;
      if (this.simTick - mf.lastFireTick > LASER_SHOW_TICKS) continue;
      beams.push({
        id: `mother-laser-${e.uid}`,
        kind: "laser",
        sourceUid: e.uid,
        sx: e.px, sy: e.py, sz: e.pz,
        targetUid: "",
        tx: mf.aim.x, ty: mf.aim.y, tz: mf.aim.z,
        team: e.team,
      });
    }

    this.beams = beams;
  }

  private nearestRockTo(e: EntityState, range: number): CelestialBody | null {
    let best: CelestialBody | null = null;
    let bestD2 = range * range;
    for (const b of this.celestials) {
      if (b.kind === "planet") continue;
      const dx = b.px - e.px, dy = b.py - e.py, dz = b.pz - e.pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = b; }
    }
    return best;
  }

  /** Nearest hostile entity a projectile may home toward or splash-damage. */
  private nearestHostileTo(
    pr: LiveProjectile,
    radius: number,
  ): EntityState | null {
    const shooter = this.entities.get(pr.owner);
    let best: EntityState | null = null;
    let bestD2 = radius * radius;
    for (const target of this.entities.values()) {
      if (!target.alive || target.id === pr.owner) continue;
      if (shooter && shooter.team === target.team) continue;
      if (target.owner === pr.ownerPlayer) continue;
      const dx = target.px - pr.px, dy = target.py - pr.py, dz = target.pz - pr.pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = target; }
    }
    return best;
  }

  private stepProjectiles(now: number): void {
    const dt = TICK_DT;
    const alive: LiveProjectile[] = [];
    const deadFleet = new Set<string>();
    for (const pr of this.projectiles) {
      if (now >= pr.dieAt) continue;

      // Guided missiles steer toward the nearest hostile each tick (spline-like arc).
      if (pr.kind === "missile") {
        const target = this.nearestHostileTo(pr, 1400);
        if (target) {
          const dx = target.px - pr.px, dy = target.py - pr.py, dz = target.pz - pr.pz;
          const d = Math.hypot(dx, dy, dz) || 1;
          const wantVx = (dx / d) * MISSILE.projectileSpeed;
          const wantVy = (dy / d) * MISSILE.projectileSpeed;
          const wantVz = (dz / d) * MISSILE.projectileSpeed;
          const k = Math.min(1, MISSILE.homingStrength * dt);
          pr.vx += (wantVx - pr.vx) * k;
          pr.vy += (wantVy - pr.vy) * k;
          pr.vz += (wantVz - pr.vz) * k;
          const sp = Math.hypot(pr.vx, pr.vy, pr.vz) || 1;
          const cap = MISSILE.projectileSpeed * 1.15;
          if (sp > cap) {
            pr.vx *= cap / sp; pr.vy *= cap / sp; pr.vz *= cap / sp;
          }
        }
      }

      pr.px += pr.vx * dt; pr.py += pr.vy * dt; pr.pz += pr.vz * dt;
      const a = SHIP.arena;
      if (Math.abs(pr.px) > a || Math.abs(pr.py) > a || Math.abs(pr.pz) > a) continue;
      let hit = false;
      // Solid celestial bodies stop bolts (impact FX, no entity damage).
      for (const b of this.celestials) {
        const dx = b.px - pr.px, dy = b.py - pr.py, dz = b.pz - pr.pz;
        if (dx * dx + dy * dy + dz * dz <= b.radius * b.radius) {
          this.events.push({ k: "impact", px: pr.px, py: pr.py, pz: pr.pz });
          hit = true;
          break;
        }
      }
      if (hit) continue;
      for (const target of this.entities.values()) {
        if (!target.alive || target.id === pr.owner) continue;
        // No friendly fire: same-team shots pass through, and never hit an
        // entity owned by the firing commander (its own fleet/mothership).
        const shooter = this.entities.get(pr.owner);
        if (shooter && shooter.team === target.team) continue;
        if (target.owner === pr.ownerPlayer) continue;
        const dx = target.px - pr.px, dy = target.py - pr.py, dz = target.pz - pr.pz;
        const hitR = pr.kind === "missile" ? MISSILE.hitRadius : WEAPON.hitRadius;
        if (dx * dx + dy * dy + dz * dz <= hitR * hitR) {
          if (pr.kind === "missile") {
            this.detonateMissile(pr, now, deadFleet);
          } else {
            this.applyDamage(target, pr.owner, now, pr.damage);
          }
          this.events.push({ k: "hit", px: pr.px, py: pr.py, pz: pr.pz });
          if (pr.kind !== "missile" && !target.alive && target.kind === "fleet_unit") {
            deadFleet.add(target.id);
          }
          hit = true;
          break;
        }
      }
      // Bolts also damage hostile platforms (never the firer's own).
      if (!hit) {
        for (const plat of this.platforms.values()) {
          if (plat.owner === pr.ownerPlayer) continue;
          const dx = plat.px - pr.px, dy = plat.py - pr.py, dz = plat.pz - pr.pz;
          if (dx * dx + dy * dy + dz * dz <= WEAPON.hitRadius * WEAPON.hitRadius) {
            const shooter = this.entities.get(pr.owner);
            plat.hp -= shooter ? weaponDamageFor(shooter) : WEAPON.damage;
            this.events.push({ k: "hit", px: pr.px, py: pr.py, pz: pr.pz });
            hit = true;
            break;
          }
        }
      }
      if (!hit) alive.push(pr);
    }
    this.projectiles = alive;
    // Destroyed fleet units leave the roster (no respawn).
    for (const id of deadFleet) this.removeFleetUnit(id);
  }

  /**
   * Apply weapon damage to an entity: shields absorb first (and stamp the
   * shield-hit clock so regen is delayed), then the hull takes the remainder.
   * On hull depletion the entity is killed via the unified `killEntity`.
   */
  /** Missile detonation: splash damage + big explosion FX. */
  private detonateMissile(
    pr: LiveProjectile,
    now: number,
    deadFleet: Set<string>,
  ): void {
    const dmg = pr.damage ?? MISSILE.damage;
    const r2 = MISSILE.splashRadius * MISSILE.splashRadius;
    const shooter = this.entities.get(pr.owner);
    for (const target of this.entities.values()) {
      if (!target.alive || target.id === pr.owner) continue;
      if (shooter && shooter.team === target.team) continue;
      if (target.owner === pr.ownerPlayer) continue;
      const dx = target.px - pr.px, dy = target.py - pr.py, dz = target.pz - pr.pz;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      this.applyDamage(target, pr.owner, now, dmg);
      if (!target.alive && target.kind === "fleet_unit") deadFleet.add(target.id);
    }
    this.events.push({ k: "explode", px: pr.px, py: pr.py, pz: pr.pz });
  }

  private applyDamage(
    entity: EntityState,
    attackerId: string,
    now: number,
    overrideDmg?: number,
  ): void {
    const attacker = this.entities.get(attackerId);
    const dmg = overrideDmg ?? (attacker ? weaponDamageFor(attacker) : WEAPON.damage);
    const shieldBefore = entity.shield;
    damageEntity(entity, dmg);
    if (entity.shield < shieldBefore) this.shieldHitAt.set(entity.id, now);
    if (entity.hp > 0) return;
    this.killEntity(entity, attackerId, now);
  }

  /**
   * Unified destruction path used by weapon hits AND collision grind: marks the
   * entity dead, zeroes its motion, schedules a respawn (tick-clock for seeded
   * enemies, wall-clock for player ships; fleet units are removed by the caller),
   * credits the killer, and emits the explosion. Caller removes dead fleet units
   * after its own iteration so the entities map isn't mutated mid-loop.
   */
  private killEntity(entity: EntityState, attackerId: string, now: number): void {
    if (!entity.alive) return;
    entity.hp = 0; entity.shield = 0; entity.alive = false; entity.deaths += 1;
    entity.vx = entity.vy = entity.vz = 0;
    this.shieldHitAt.delete(entity.id);
    const meta = this.enemyMeta.get(entity.id);
    if (meta) {
      // Tick-based respawn for seeded enemies (the boss re-arms on its own clock).
      meta.respawnTick =
        this.tickCount + (entity.id === BOSS.id ? BOSS.respawnTicks : ENEMY.respawnTicks);
    } else if (entity.kind !== "fleet_unit") {
      entity.respawnAt = now + SHIP.respawnDelay;
    }
    const attacker = attackerId ? this.entities.get(attackerId) : undefined;
    if (attacker && attacker.id !== entity.id) attacker.kills += 1;
    this.events.push({ k: "explode", px: entity.px, py: entity.py, pz: entity.pz });
    // World-boss payoff: pay every commander a bounty + announce on Discord.
    if (entity.id === BOSS.id) this.handleBossDefeated();
  }

  /** Remove a destroyed fleet unit from the roster + all server-side bookkeeping. */
  private removeFleetUnit(id: string): void {
    this.entities.delete(id);
    this.fleet.delete(id);
    this.escorts.delete(id);
    this.shieldHitAt.delete(id);
  }

  // ─── Broadcast ───────────────────────────────────────────────────────────────

  private broadcast(): void {
    if (this.players.size === 0) { this.events = []; return; }
    const time = Date.now() - this.startedAt;

    const joinedPlayerIds = new Set<string>();
    for (const p of this.players.values()) if (p.joined) joinedPlayerIds.add(p.id);

    // Every entity owned by a joined commander (fighter + mothership + fleet),
    // plus all seeded AI combatants (outpost garrisons + the world boss) so the
    // pirate threat is actually visible to clients.
    const entities: EntityState[] = [];
    for (const entity of this.entities.values()) {
      if (joinedPlayerIds.has(entity.owner) || this.aiEntityIds.has(entity.id)) {
        entities.push(entity);
      }
    }

    const projectiles: ProjectileState[] = this.projectiles.map((p) => ({
      id: p.id, owner: p.owner,
      px: p.px, py: p.py, pz: p.pz,
      vx: p.vx, vy: p.vy, vz: p.vz,
      kind: p.kind,
    }));

    const economy: PlayerEconomy[] = [];
    for (const p of this.players.values()) {
      if (!p.joined) continue;
      economy.push({
        playerId: p.id,
        controlledEntityId: p.controlledEntityId,
        motherShipId: p.motherShipId,
        credits: Math.floor(p.credits),
      });
    }

    // Platforms owned by any joined commander.
    const platforms: PlatformState[] = [];
    for (const plat of this.platforms.values()) {
      if (joinedPlayerIds.has(plat.owner)) platforms.push(plat);
    }

    const events = this.events;
    for (const p of this.players.values()) {
      try {
        p.conn.send(
          encode({
            t: "snapshot",
            time,
            ack: p.lastSeq,
            entities,
            projectiles,
            events,
            economy,
            celestials: this.celestials,
            rewards: this.rewards,
            outposts: this.outposts,
            beams: this.beams,
            platforms,
          }),
        );
      } catch { /* broken socket cleaned up by close handler */ }
    }
    this.events = [];
  }
}

/** Small deterministic string hash → 32-bit int (for per-unit AI variation). */
function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

let room: CarrierRoom | null = null;
export function getCarrierRoom(): CarrierRoom {
  if (!room) {
    room = new CarrierRoom();
    room.start();
  }
  return room;
}
