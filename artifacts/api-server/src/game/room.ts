/**
 * Authoritative game room for the space sim (`@workspace/space-net`).
 *
 * RETAINED FOUNDATION: this room previously backed the retired "skies" arcade
 * cabinet. The cabinet is gone (the arcade out-links to the real Carrier
 * artifact now), but this room and the shared netcode are deliberately kept as
 * the basis for a future "live PvP waters" mode; it is not wired to any cabinet.
 *
 * Each connected player commands ONE mothership — their mobile base "Moe".
 * The room runs a fixed-step simulation (TICK_HZ) using the SAME integrators
 * the client predicts with; the server is the single source of truth.
 *
 * Entity model
 * ───────────
 * The room owns a flat `entities` map (id → EntityState). Each human player
 * controls exactly one entity (their mother ship, for now). AI-controlled entities
 * (future mother ships, fleet units) also live in this map and receive
 * server-generated intent commands each tick; their stub behaviour is
 * "hold position" (zero thrust, zero rotation) until a real AI producer is
 * wired up in a later task.
 *
 * Per-tick responsibilities
 * ─────────────────────────
 * 1. Respawn dead entities whose timer has elapsed.
 * 2. Step AI-controlled entities (hold-position stub; fleet AI comes later).
 * 3. Step each player's mothership via `stepMotherShipCourse` when a course is set.
 * 4. Accrue credits for every mothership that is underway.
 * 5. Fire turret projectiles at nearby enemies for each mothership.
 * 6. Integrate and resolve projectile hits against all entities.
 *
 * Mother ship classes
 * ──────────────────
 * When a player sends a `join` message they include `shipType` (0-5) which is
 * the Mother Ship class index. `setIdentity` looks up that class from the
 * shared `MOTHER_SHIP_CLASSES` table (same data the client displays), changes
 * the entity kind to `mother_ship`, and applies the class's `maxHp` so the
 * server and client are always in agreement about the starting state.
 *
 * Snapshots go out at SNAPSHOT_HZ with:
 *   - `entities`  — the full entity world.
 *   - `economy`   — per-player credits + ownership.
 *   - `ack`       — per-recipient highest processed input seq (personalised).
 */
import {
  CARRIER,
  MOTHER_SHIP,
  SHIP,
  FLEET_UNIT,
  SHIP_TYPES,
  TICK_DT,
  TICK_HZ,
  SNAPSHOT_HZ,
  WEAPON,
  WEAPONS,
  type EntityState,
  type EntityKind,
  type GameEvent,
  type InputCommand,
  type PlayerEconomy,
  type ProjectileState,
  type UpgradeId,
  type UpgradeLevels,
  emptyUpgrades,
  encode,
  forwardVec,
  getMotherShipClass,
  getWeapon,
  getUpgrade,
  spawnEntity,
  stepMotherShipCourse,
  upgradeCost,
  upgradeMultiplier,
} from "@workspace/space-net";
import { logger } from "../lib/logger";

/** Minimal send sink so the room never depends on the `ws` type directly. */
export interface Conn {
  send(data: string): void;
}

interface Player {
  id: string;
  conn: Conn;
  /** The entity id this player currently controls (the mothership). */
  controlledEntityId: string;
  queue: InputCommand[];
  lastSeq: number;
  joined: boolean;
  /** Accumulated credits (fractional accumulator, floor sent over wire). */
  credits: number;
  /** ms-timestamp of the last turret shot fired by this player's mothership. */
  turretLastFireAt: number;
  /** Currently selected player weapon (index into `WEAPONS`). */
  weapon: number;
  /** Purchased upgrade levels. */
  upgrades: UpgradeLevels;
  /** ms-timestamp of the last player-fired (spacebar) shot. */
  weaponLastFireAt: number;
}

/**
 * Internal projectile extends the wire type with a server-only expiry plus the
 * per-shot damage + hit radius (player weapons and turrets differ, so each
 * projectile carries its own values rather than being inferred at hit time).
 */
type LiveProjectile = ProjectileState & {
  dieAt: number;
  damage: number;
  hitRadius: number;
};

let nextProjectileId = 1;

/** Guard untrusted client input: every numeric field must be finite. */
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

/** Spawn a mothership at a random position in the arena. */
function randMotherSpawn(): { px: number; py: number; pz: number; yaw: number } {
  const r = SHIP.arena * 0.5;
  return {
    px: (Math.random() * 2 - 1) * r,
    py: (Math.random() * 2 - 1) * r * 0.1,
    pz: (Math.random() * 2 - 1) * r,
    yaw: Math.random() * Math.PI * 2,
  };
}

/** Clamp a course destination to stay inside the arena with margin. */
function clampCourse(v: number): number {
  const limit = SHIP.arena - 80;
  return Math.max(-limit, Math.min(limit, v));
}

/** Forward muzzle offset for player-fired weapons (bow of the ~150-long hull). */
const PLAYER_MUZZLE_FORWARD = 80;
/** Slight elevation above the hull for player muzzles. */
const PLAYER_MUZZLE_UP = 14;

/** Zero-input command used by AI "hold-position" stub. */
const HOLD_CMD: InputCommand = {
  seq: 0,
  dt: TICK_DT,
  thrust: 0,
  yaw: 0,
  pitch: 0,
  roll: 0,
  boost: false,
  fire: false,
};

/** Return the respawn delay (ms) appropriate for the entity kind. */
function respawnDelayFor(kind: EntityKind): number {
  if (kind === "mother_ship") return MOTHER_SHIP.respawnDelay;
  if (kind === "fleet_unit") return FLEET_UNIT.respawnDelay;
  return SHIP.respawnDelay;
}

export class GameRoom {
  private players = new Map<string, Player>();
  /**
   * All live entities keyed by entity id.  Fighter/mother-ship entities are
   * created and removed in lockstep with their owning player.  AI entities
   * (future) are registered here independently via `addAIEntity`.
   */
  private entities = new Map<string, EntityState>();
  private aiEntityIds = new Set<string>();

  private projectiles: LiveProjectile[] = [];
  private events: GameEvent[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private snapTimer: ReturnType<typeof setInterval> | null = null;
  private nextId = 1;
  private startedAt = Date.now();

  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), 1000 / TICK_HZ);
    this.snapTimer = setInterval(() => this.broadcast(), 1000 / SNAPSHOT_HZ);
    logger.info({ tickHz: TICK_HZ, snapshotHz: SNAPSHOT_HZ }, "GameRoom started");
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.snapTimer) clearInterval(this.snapTimer);
    this.tickTimer = null;
    this.snapTimer = null;
  }

  /** Register a new connection; spawns a mothership and returns the player id. */
  add(conn: Conn): string {
    const id = `p${this.nextId++}`;
    const sp = randMotherSpawn();
    // Spawn a placeholder mothership that will be upgraded to the chosen class
    // when the player sends their `join` message with their chosen ship type.
    const mothership = spawnEntity(
      id,
      id,
      "mother_ship",
      id,
      0,
      0,
      sp.px,
      sp.py,
      sp.pz,
      sp.yaw,
    );
    this.entities.set(id, mothership);

    const player: Player = {
      id,
      conn,
      controlledEntityId: id,
      queue: [],
      lastSeq: 0,
      joined: false,
      credits: 0,
      turretLastFireAt: 0,
      weapon: 0,
      upgrades: emptyUpgrades(),
      weaponLastFireAt: 0,
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
    logger.info({ id, players: this.players.size }, "carrier joined");
    return id;
  }

  remove(id: string): void {
    if (this.players.delete(id)) {
      // Remove the player's entity from the world.
      this.entities.delete(id);
      logger.info({ id, players: this.players.size }, "carrier left");
    }
  }

  /**
   * Finalise a pilot's identity: name + chosen Mother Ship class.
   *
   * The class index (`shipType` on the wire, 0-5) is looked up in the shared
   * `MOTHER_SHIP_CLASSES` table. The placeholder mothership entity is upgraded
   * to that class's `maxHp` so the server's simulation exactly matches what
   * the selection screen advertised to the client.
   */
  setIdentity(id: string, name: string, shipType: number): void {
    const p = this.players.get(id);
    if (!p) return;

    const clampedType = Math.max(0, Math.min(SHIP_TYPES - 1, shipType | 0));
    const classDef = getMotherShipClass(clampedType);

    const entity = this.entities.get(p.controlledEntityId);
    if (entity) {
      entity.name = name.slice(0, 16) || id;
      entity.shipType = clampedType;
      // Apply class-specific stats so server simulation matches the client's display.
      entity.kind = "mother_ship";
      entity.maxHp = classDef.maxHp;
      entity.hp = classDef.maxHp;
    }
    p.joined = true;

    logger.info(
      { id, name: entity?.name, class: classDef.id, maxHp: classDef.maxHp },
      "pilot identity set",
    );
  }

  /** Queue a client input for the next tick (motherships ignore most axes). */
  enqueue(id: string, cmd: InputCommand): void {
    const p = this.players.get(id);
    if (!p) return;
    if (!isFiniteInput(cmd)) return;
    if (cmd.seq <= p.lastSeq || p.queue.some((q) => q.seq === cmd.seq)) return;
    p.queue.push(cmd);
  }

  /**
   * Set (or update) the course destination for a player's mothership.
   * Validates the numbers are finite and clamps to the arena boundary.
   */
  setCourse(playerId: string, rawTx: number, rawTz: number): void {
    if (!Number.isFinite(rawTx) || !Number.isFinite(rawTz)) return;
    const p = this.players.get(playerId);
    if (!p || !p.joined) return;
    const entity = this.entities.get(p.controlledEntityId);
    if (!entity || entity.kind !== "mother_ship") return;
    entity.hasCourse = true;
    entity.courseTx = clampCourse(rawTx);
    entity.courseTz = clampCourse(rawTz);
    logger.info(
      { id: playerId, tx: entity.courseTx, tz: entity.courseTz },
      "course set",
    );
  }

  /** Select a player's active weapon (clamped to the shared `WEAPONS` table). */
  selectWeapon(playerId: string, w: number): void {
    const p = this.players.get(playerId);
    if (!p || !Number.isFinite(w)) return;
    p.weapon = Math.max(0, Math.min(WEAPONS.length - 1, w | 0));
  }

  /**
   * Fire the player's currently-selected weapon forward along their ship's
   * heading. Honours the weapon cooldown (scaled by the reload upgrade) and
   * spawns one projectile per pellet, each carrying its own damage + hit radius.
   */
  fireWeapon(playerId: string): void {
    const p = this.players.get(playerId);
    if (!p || !p.joined) return;
    const entity = this.entities.get(p.controlledEntityId);
    if (!entity || !entity.alive || entity.kind !== "mother_ship") return;

    const now = this.now();
    const weapon = getWeapon(p.weapon);
    const cooldown = weapon.cooldownMs * upgradeMultiplier("reload", p.upgrades.reload);
    if (now - p.weaponLastFireAt < cooldown) return;
    p.weaponLastFireAt = now;

    const dmg = weapon.damage * upgradeMultiplier("damage", p.upgrades.damage);
    const rangeMul = upgradeMultiplier("range", p.upgrades.range);
    const speed = weapon.projectileSpeed * rangeMul;
    const life = weapon.lifeMs * rangeMul;

    // Forward unit vector from the ship's yaw (bow points +Z at yaw 0).
    const [fx, , fz] = forwardVec(entity.yaw, 0);
    const mx = entity.px + fx * PLAYER_MUZZLE_FORWARD;
    const my = entity.py + PLAYER_MUZZLE_UP;
    const mz = entity.pz + fz * PLAYER_MUZZLE_FORWARD;

    const pellets = Math.max(1, weapon.pellets | 0);
    for (let i = 0; i < pellets; i++) {
      // Spread the pellets evenly across the fan, centred on the heading.
      const offset = pellets === 1 ? 0 : (i / (pellets - 1) - 0.5) * weapon.spread;
      const a = entity.yaw + offset;
      this.projectiles.push({
        id: nextProjectileId++,
        owner: entity.id,
        px: mx,
        py: my,
        pz: mz,
        vx: Math.sin(a) * speed,
        vy: 0,
        vz: Math.cos(a) * speed,
        dieAt: now + life,
        damage: dmg,
        hitRadius: weapon.hitRadius,
      });
    }
    this.events.push({ k: "fire", px: mx, py: my, pz: mz });
  }

  /**
   * Buy the next level of an upgrade for a player. Validates the upgrade exists,
   * is below its max level, and that the player can afford it; spends credits and
   * applies any immediate effect (hull rescales the entity's max + current hp).
   */
  buyUpgrade(playerId: string, upgradeId: string): void {
    const p = this.players.get(playerId);
    if (!p || !p.joined) return;
    const def = getUpgrade(upgradeId as UpgradeId);
    if (!def) return;
    const current = p.upgrades[def.id] ?? 0;
    if (current >= def.maxLevel) return;
    const cost = upgradeCost(def.id, current);
    if (!Number.isFinite(cost) || p.credits < cost) return;

    p.credits -= cost;
    p.upgrades[def.id] = current + 1;

    if (def.id === "hull") {
      const entity = this.entities.get(p.controlledEntityId);
      if (entity) {
        const base = getMotherShipClass(entity.shipType).maxHp;
        const newMax = Math.round(base * upgradeMultiplier("hull", p.upgrades.hull));
        const delta = Math.max(0, newMax - entity.maxHp);
        entity.maxHp = newMax;
        // Grant the added hull immediately so the buy feels impactful.
        entity.hp = Math.min(newMax, entity.hp + delta);
      }
    }
    logger.info(
      { id: playerId, upgrade: def.id, level: p.upgrades[def.id], cost },
      "upgrade purchased",
    );
  }

  /** Register a server-side AI entity (hold-position stub). */
  addAIEntity(
    kind: EntityKind,
    owner: string,
    team: number,
    shipType: number,
  ): string {
    const id = `ai_${this.nextId++}`;
    const sp = randMotherSpawn();
    const entity = spawnEntity(id, `AI-${id}`, kind, owner, team, shipType, sp.px, sp.py, sp.pz, sp.yaw);
    this.entities.set(id, entity);
    this.aiEntityIds.add(id);
    logger.info({ id, kind, owner }, "AI entity added");
    return id;
  }

  removeAIEntity(id: string): void {
    this.entities.delete(id);
    this.aiEntityIds.delete(id);
  }

  private now(): number {
    return Date.now();
  }

  private tick(): void {
    const now = this.now();

    // 1. Respawn dead entities whose timer has elapsed.
    for (const entity of this.entities.values()) {
      if (!entity.alive && now >= entity.respawnAt) {
        const sp = randMotherSpawn();
        entity.px = sp.px;
        entity.py = sp.py;
        entity.pz = sp.pz;
        entity.yaw = sp.yaw;
        entity.pitch = 0;
        entity.roll = 0;
        entity.vx = entity.vy = entity.vz = 0;
        // Restore to entity's own maxHp (class-specific for mother ships).
        entity.hp = entity.maxHp;
        entity.alive = true;
        entity.respawnAt = 0;
        entity.hasCourse = false;
      }
    }

    // 2. Step AI-controlled entities with hold-position stub.
    for (const aiId of this.aiEntityIds) {
      const entity = this.entities.get(aiId);
      if (entity?.alive) {
        void HOLD_CMD;
      }
    }

    // 3. Step player motherships (course-following + input drain).
    for (const p of this.players.values()) {
      const entity = this.entities.get(p.controlledEntityId);
      if (!entity) continue;

      // Drain the input queue (mostly zero for motherships, but we honour any
      // manual course-correction the client might be sending).
      const q = p.queue;
      p.queue = [];
      for (const cmd of q) {
        if (cmd.seq <= p.lastSeq) continue;
        p.lastSeq = cmd.seq;
      }

      // Drive course-following integrator.
      if (entity.kind === "mother_ship" && entity.alive) {
        stepMotherShipCourse(entity, TICK_DT);

        // 4. Credit accrual while underway.
        const speed = Math.hypot(entity.vx, entity.vy, entity.vz);
        if (speed >= CARRIER.creditMoveThreshold) {
          p.credits += CARRIER.creditRatePerSec * TICK_DT;
        }

        // 5. Turret auto-fire at nearest enemy in range.
        this.stepTurrets(p, entity, now);
      }
    }

    // 6. Integrate projectiles + resolve hits.
    this.stepProjectiles(now);
  }

  /**
   * Fire turret projectiles from a mothership at the nearest enemy in range.
   * One burst per CARRIER.turretCooldownMs; all CARRIER.numTurrets fire together
   * toward the same target (simulating a broadside salvo).
   */
  private stepTurrets(p: Player, mothership: EntityState, now: number): void {
    if (now - p.turretLastFireAt < CARRIER.turretCooldownMs) return;

    // Find nearest enemy entity (any entity not owned by this player) in range.
    let nearestDist = Infinity;
    let nearest: EntityState | null = null;
    for (const target of this.entities.values()) {
      if (!target.alive || target.owner === p.id) continue;
      const dx = target.px - mothership.px;
      const dy = target.py - mothership.py;
      const dz = target.pz - mothership.pz;
      const dist = Math.hypot(dx, dy, dz);
      if (dist < nearestDist && dist <= CARRIER.turretRange) {
        nearestDist = dist;
        nearest = target;
      }
    }
    if (!nearest) return;

    // Fire a salvo from each turret mount toward the target.
    p.turretLastFireAt = now;
    const turretOffsets = buildTurretOffsets(mothership);
    for (const offset of turretOffsets) {
      this.fireTurretProjectile(mothership, offset, nearest, now);
    }
  }

  private fireTurretProjectile(
    source: EntityState,
    offset: [number, number, number],
    target: EntityState,
    now: number,
  ): void {
    const mx = source.px + offset[0];
    const my = source.py + offset[1];
    const mz = source.pz + offset[2];

    // Aim directly at the target (leading omitted — carrier combat is slow).
    const dx = target.px - mx;
    const dy = target.py - my;
    const dz = target.pz - mz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.01) return;
    const inv = 1 / dist;
    const sp = CARRIER.turretProjectileSpeed;

    this.projectiles.push({
      id: nextProjectileId++,
      owner: source.id,
      px: mx,
      py: my,
      pz: mz,
      vx: (dx * inv) * sp,
      vy: (dy * inv) * sp,
      vz: (dz * inv) * sp,
      dieAt: now + CARRIER.turretProjectileLifeMs,
      damage: CARRIER.turretDamage,
      // Wider hit radius for mothership turrets (slower homing bolts).
      hitRadius: WEAPON.hitRadius * 1.5,
    });
  }

  private stepProjectiles(now: number): void {
    const dt = TICK_DT;
    const alive: LiveProjectile[] = [];
    for (const pr of this.projectiles) {
      if (now >= pr.dieAt) continue;
      pr.px += pr.vx * dt;
      pr.py += pr.vy * dt;
      pr.pz += pr.vz * dt;

      const a = SHIP.arena;
      if (Math.abs(pr.px) > a || Math.abs(pr.py) > a || Math.abs(pr.pz) > a) {
        continue;
      }

      // Each projectile carries its own hit radius (player weapon vs turret).
      const hitR = pr.hitRadius;
      let hit = false;
      for (const target of this.entities.values()) {
        if (!target.alive || target.id === pr.owner) continue;
        const dx = target.px - pr.px;
        const dy = target.py - pr.py;
        const dz = target.pz - pr.pz;
        if (dx * dx + dy * dy + dz * dz <= hitR * hitR) {
          this.applyDamage(target, pr.owner, now, pr.damage);
          this.events.push({ k: "hit", px: pr.px, py: pr.py, pz: pr.pz });
          hit = true;
          break;
        }
      }
      if (!hit) alive.push(pr);
    }
    this.projectiles = alive;
  }

  private applyDamage(
    entity: EntityState,
    attackerId: string,
    now: number,
    dmg: number,
  ): void {
    entity.hp -= dmg;
    if (entity.hp > 0) return;
    entity.hp = 0;
    entity.alive = false;
    entity.deaths += 1;
    // Use the entity kind's respawn delay, not the global SHIP constant.
    entity.respawnAt = now + respawnDelayFor(entity.kind);
    entity.vx = entity.vy = entity.vz = 0;
    const attacker = this.entities.get(attackerId);
    if (attacker && attacker.id !== entity.id) attacker.kills += 1;
    this.events.push({ k: "explode", px: entity.px, py: entity.py, pz: entity.pz });
  }

  private broadcast(): void {
    if (this.players.size === 0) {
      this.events = [];
      return;
    }
    const time = Date.now() - this.startedAt;

    const joinedPlayerIds = new Set<string>();
    for (const p of this.players.values()) {
      if (p.joined) joinedPlayerIds.add(p.id);
    }

    const entities: EntityState[] = [];
    for (const entity of this.entities.values()) {
      if (joinedPlayerIds.has(entity.owner) || this.aiEntityIds.has(entity.id)) {
        entities.push(entity);
      }
    }

    const projectiles: ProjectileState[] = this.projectiles.map((pr) => ({
      id: pr.id,
      owner: pr.owner,
      px: pr.px,
      py: pr.py,
      pz: pr.pz,
      vx: pr.vx,
      vy: pr.vy,
      vz: pr.vz,
    }));

    const economy: PlayerEconomy[] = [];
    for (const p of this.players.values()) {
      if (!p.joined) continue;
      economy.push({
        playerId: p.id,
        controlledEntityId: p.controlledEntityId,
        credits: Math.floor(p.credits),
        weapon: p.weapon,
        upgrades: { ...p.upgrades },
      });
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
          }),
        );
      } catch {
        /* broken socket cleaned up by its close handler */
      }
    }
    this.events = [];
  }
}

/**
 * Build 4 turret mount offsets in world-space for a mothership.
 * Turrets sit on the four quadrants of the hull at ≈ 40% of scale
 * (MOTHER_SHIP.scaleFactor * SHIP_FIT ≈ 30*14 = 420 units long, so 70 units).
 */
function buildTurretOffsets(
  mothership: EntityState,
): [number, number, number][] {
  // Mothership is ≈ 420 units long; turrets sit at ~70 units from centre.
  const r = 70;
  // Rotate the four cardinal offsets by the mothership's current yaw.
  const cy = Math.cos(mothership.yaw);
  const sy = Math.sin(mothership.yaw);
  // Local offsets: [±fwd, 0, ±side]
  const local: [number, number][] = [
    [r, r],
    [-r, r],
    [r, -r],
    [-r, -r],
  ];
  return local.map(([lx, lz]) => [
    lx * cy - lz * sy,
    12, // slight elevation above the hull
    lx * sy + lz * cy,
  ]);
}

void forwardVec; // imported for potential future use

/** Lazily-created shared room (one per server process). */
let room: GameRoom | null = null;
export function getRoom(): GameRoom {
  if (!room) {
    room = new GameRoom();
    room.start();
  }
  return room;
}
