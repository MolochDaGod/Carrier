/**
 * Authoritative game room for the Ruins Brawler cabinet.
 *
 * Brawler-owned copy of the server-room pattern (mirrors CarrierRoom) so the two
 * games never share state. One shared room holds every connected survivor and
 * runs a fixed-step simulation (TICK_HZ) using the SAME `stepPlayer` the client
 * predicts with. Everything else — firing, projectiles, the zombie horde
 * (spawn / AI / contact), dash damage, loot, the safe-zone shop, and respawns —
 * is fully server-authoritative; clients only interpolate the remote state.
 *
 * The static ruins world is generated ONCE from `WORLD_SEED` (never the wall
 * clock) and the seed is handed to each client in `welcome`, so every player and
 * the server share one identical map without broadcasting any geometry.
 */
import {
  LOOT,
  PLAYER,
  PROJECTILE,
  SHOP,
  SHOP_AMMO_AMOUNT,
  SNAPSHOT_HZ,
  SPAWN,
  TICK_DT,
  TICK_HZ,
  WEAPONS,
  WORLD_SEED,
  ZOMBIE,
  collideWorld,
  encode,
  generateWorld,
  hasWeapon,
  inSafeZone,
  isDashing,
  keepOutOfSafe,
  makeRng,
  nearestSafeZone,
  separateZombies,
  spawnPlayer,
  spawnZombie,
  stepPlayer,
  stepProjectile,
  stepZombie,
  projectileHitsWorld,
  type BrawlWorld,
  type GameEvent,
  type LootKind,
  type LootState,
  type PlayerInput,
  type PlayerState,
  type ProjectileState,
  type ShopItemId,
  type ZombieState,
  type Rng,
} from "@workspace/brawl-net";
import { logger } from "../lib/logger";

export interface Conn {
  send(data: string): void;
}

interface Player {
  conn: Conn;
  state: PlayerState;
  queue: PlayerInput[];
  /** Highest input seq applied — echoed back as the snapshot `ack`. */
  lastSeq: number;
  /** Tick the player last fired (weapon cooldown gate). */
  lastFireTick: number;
  /** Zombie ids already gored by the CURRENT dash (one hit per dash each). */
  dashHits: Set<string>;
  joined: boolean;
}

/** Per-zombie server-only bookkeeping kept off the wire. */
interface ZombieMeta {
  /** Earliest tick this zombie may melee a player again. */
  attackReadyTick: number;
}

type LiveProjectile = ProjectileState & {
  damage: number;
  dieTick: number;
  ownerId: string;
};

const clampDt = (dt: number): number => (dt > 0 ? Math.min(dt, 0.1) : 0);

export class BrawlRoom {
  private players = new Map<string, Player>();
  private zombies = new Map<string, ZombieState>();
  private zombieMeta = new Map<string, ZombieMeta>();
  private projectiles: LiveProjectile[] = [];
  private loot: LootState[] = [];
  private events: GameEvent[] = [];
  private world: BrawlWorld;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private snapTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt = Date.now();
  private simTick = 0;
  private nextId = 1;
  private nextZombieId = 1;
  private nextProjId = 1;
  private nextLootId = 1;
  private lastSpawnTick = 0;
  /** Seeded RNG for ALL server randomness (spawn / spread / loot) — never Math.random. */
  private rng: Rng = makeRng(0x8badf00d);

  constructor() {
    this.world = generateWorld(WORLD_SEED);
    logger.info(
      {
        obstacles: this.world.obstacles.length,
        safeZones: this.world.safeZones.length,
        seed: WORLD_SEED,
      },
      "BrawlRoom world generated (deterministic)",
    );
  }

  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), 1000 / TICK_HZ);
    this.snapTimer = setInterval(() => this.broadcast(), 1000 / SNAPSHOT_HZ);
    logger.info({ tickHz: TICK_HZ, snapshotHz: SNAPSHOT_HZ }, "BrawlRoom started");
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.snapTimer) clearInterval(this.snapTimer);
    this.tickTimer = null;
    this.snapTimer = null;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  add(conn: Conn): string {
    const id = `p${this.nextId++}`;
    const [px, pz] = this.safeSpawn();
    const state = spawnPlayer(id, id, px, pz);
    this.players.set(id, {
      conn,
      state,
      queue: [],
      lastSeq: 0,
      lastFireTick: 0,
      dashHits: new Set(),
      joined: false,
    });
    conn.send(
      encode({
        t: "welcome",
        id,
        serverTime: Date.now() - this.startedAt,
        tickHz: TICK_HZ,
        snapshotHz: SNAPSHOT_HZ,
        seed: WORLD_SEED,
      }),
    );
    logger.info({ id, players: this.players.size }, "brawler survivor joined");
    return id;
  }

  remove(id: string): void {
    if (this.players.delete(id)) {
      logger.info({ id, players: this.players.size }, "brawler survivor left");
    }
  }

  setName(id: string, name: string): void {
    const p = this.players.get(id);
    if (!p) return;
    p.state.name = name.slice(0, 32) || id;
    p.joined = true;
  }

  enqueue(id: string, cmd: PlayerInput): void {
    const p = this.players.get(id);
    if (!p) return;
    p.queue.push(cmd);
  }

  /** Process a safe-zone shop purchase (rejected unless the player is in a safe zone). */
  buy(id: string, item: ShopItemId): void {
    const p = this.players.get(id);
    if (!p || !p.state.alive) return;
    if (!inSafeZone(p.state.px, p.state.pz, this.world.safeZones)) return;
    const def = SHOP[item];
    const s = p.state;
    if (s.credits < def.cost) return;

    if (def.weapon !== undefined) {
      if (hasWeapon(s.unlocked, def.weapon)) return; // already owned
      s.unlocked |= 1 << def.weapon;
      s.weapon = def.weapon;
    } else if (item === "armor") {
      s.maxArmor = Math.min(PLAYER.armorCap, s.maxArmor + PLAYER.armorStep);
      s.armor = s.maxArmor;
    } else if (item === "ammo") {
      s.ammo += SHOP_AMMO_AMOUNT;
    } else if (item === "heal") {
      s.hp = s.maxHp;
    }
    s.credits -= def.cost;
    this.events.push({ k: "purchase", px: s.px, pz: s.pz, id, n: def.cost });
  }

  // -------------------------------------------------------------------------
  // Fixed-step simulation
  // -------------------------------------------------------------------------

  private tick(): void {
    this.simTick++;
    const tick = this.simTick;

    this.stepPlayers(tick);
    this.stepZombies(tick);
    this.stepProjectiles(tick);
    this.stepLoot();
    this.spawnZombies(tick);
  }

  private stepPlayers(tick: number): void {
    for (const [id, p] of this.players) {
      const s = p.state;

      // Respawn dead survivors at the nearest sanctuary once their timer is up.
      if (!s.alive) {
        s.vx = 0;
        s.vz = 0;
        p.queue.length = 0;
        if (tick >= s.respawnTick) {
          const zone = nearestSafeZone(s.px, s.pz, this.world.safeZones);
          s.px = zone.px;
          s.pz = zone.pz;
          s.hp = s.maxHp;
          s.armor = s.maxArmor;
          s.alive = true;
          s.dashTick = 0;
          s.dashReadyTick = 0;
          this.events.push({ k: "respawn", px: s.px, pz: s.pz, id });
        }
        continue;
      }

      // Drain queued inputs in order; track fire/weapon intent for this tick.
      let wantFire = false;
      let desiredWeapon = s.weapon;
      const prevDashReady = s.dashReadyTick;
      for (const cmd of p.queue) {
        if (cmd.seq > p.lastSeq) p.lastSeq = cmd.seq;
        if (hasWeapon(s.unlocked, cmd.weapon | 0)) desiredWeapon = cmd.weapon | 0;
        if (cmd.fire) wantFire = true;
        stepPlayer(s, cmd, this.world, clampDt(cmd.dt), tick);
      }
      p.queue.length = 0;
      s.weapon = desiredWeapon;
      s.safe = inSafeZone(s.px, s.pz, this.world.safeZones);

      // A fresh dash clears the per-dash hit ledger so it can gore again.
      if (s.dashReadyTick !== prevDashReady) p.dashHits.clear();

      this.resolveFire(p, wantFire, tick);
      this.resolveDashDamage(p, tick);
    }
  }

  /** Server-authoritative weapon fire: ammo + cooldown gated, spread via seeded rng. */
  private resolveFire(p: Player, wantFire: boolean, tick: number): void {
    const s = p.state;
    if (!wantFire) return;
    const w = WEAPONS[s.weapon] ?? WEAPONS[0];
    if (tick < p.lastFireTick + w.cooldownTicks) return;
    if (s.ammo < w.ammoCost) return;
    s.ammo -= w.ammoCost;
    p.lastFireTick = tick;

    const baseAng = Math.atan2(s.ax, s.az);
    for (let i = 0; i < w.count; i++) {
      const ang = baseAng + (this.rng() * 2 - 1) * w.spread;
      const dx = Math.sin(ang);
      const dz = Math.cos(ang);
      this.projectiles.push({
        id: `b${this.nextProjId++}`,
        px: s.px + dx * (PLAYER.radius + 0.4),
        pz: s.pz + dz * (PLAYER.radius + 0.4),
        vx: dx * w.projectileSpeed,
        vz: dz * w.projectileSpeed,
        weapon: w.id,
        damage: w.damage,
        dieTick: tick + w.projectileLifeTicks,
        ownerId: s.id,
      });
    }
    this.events.push({ k: "shoot", px: s.px, pz: s.pz, id: s.id, n: w.id });
  }

  /** RMB dash gores any zombie in the lunge radius (once per dash each). */
  private resolveDashDamage(p: Player, tick: number): void {
    const s = p.state;
    if (!isDashing(s, tick)) return;
    const reach = PLAYER.dashRadius + ZOMBIE.radius;
    for (const [zid, z] of this.zombies) {
      if (p.dashHits.has(zid)) continue;
      const dx = z.px - s.px;
      const dz = z.pz - s.pz;
      if (dx * dx + dz * dz > reach * reach) continue;
      p.dashHits.add(zid);
      this.damageZombie(zid, z, PLAYER.dashDamage, s.id);
    }
  }

  private stepZombies(tick: number): void {
    const living: PlayerState[] = [];
    for (const p of this.players.values()) if (p.state.alive) living.push(p.state);

    for (const [zid, z] of this.zombies) {
      // Target the nearest living player; the safe-zone push keeps zombies out
      // of sanctuaries so they pile at the edge rather than reaching shoppers.
      let target: PlayerState | null = null;
      let bd = Infinity;
      for (const ps of living) {
        const dx = ps.px - z.px;
        const dz = ps.pz - z.pz;
        const d = dx * dx + dz * dz;
        if (d < bd) {
          bd = d;
          target = ps;
        }
      }
      stepZombie(z, target, this.world, TICK_DT);

      // Melee contact: damage the target if in range, off cooldown, not safe.
      if (target && !target.safe) {
        const dx = target.px - z.px;
        const dz = target.pz - z.pz;
        if (dx * dx + dz * dz <= ZOMBIE.attackRange * ZOMBIE.attackRange) {
          const meta = this.zombieMeta.get(zid);
          if (meta && tick >= meta.attackReadyTick) {
            meta.attackReadyTick = tick + ZOMBIE.attackCooldownTicks;
            this.damagePlayer(target, ZOMBIE.touchDamage, tick);
          }
        }
      }
    }

    separateZombies([...this.zombies.values()]);
  }

  private stepProjectiles(tick: number): void {
    const survivors: LiveProjectile[] = [];
    for (const pr of this.projectiles) {
      if (tick >= pr.dieTick) continue;
      stepProjectile(pr, TICK_DT);
      if (projectileHitsWorld(pr.px, pr.pz, this.world)) {
        this.events.push({ k: "hit", px: pr.px, pz: pr.pz, n: pr.weapon });
        continue;
      }
      let hit = false;
      for (const [zid, z] of this.zombies) {
        const dx = z.px - pr.px;
        const dz = z.pz - pr.pz;
        const rr = ZOMBIE.radius + PROJECTILE.radius;
        if (dx * dx + dz * dz <= rr * rr) {
          this.events.push({ k: "hit", px: pr.px, pz: pr.pz, n: pr.weapon });
          this.damageZombie(zid, z, pr.damage, pr.ownerId);
          hit = true;
          break;
        }
      }
      if (!hit) survivors.push(pr);
    }
    this.projectiles = survivors;
  }

  private stepLoot(): void {
    const living: PlayerState[] = [];
    for (const p of this.players.values()) if (p.state.alive) living.push(p.state);
    if (!living.length) return;

    const keep: LootState[] = [];
    for (const l of this.loot) {
      // Magnet toward the nearest living survivor; collect inside pickupRadius.
      let near: PlayerState | null = null;
      let bd = Infinity;
      for (const ps of living) {
        const dx = ps.px - l.px;
        const dz = ps.pz - l.pz;
        const d = dx * dx + dz * dz;
        if (d < bd) {
          bd = d;
          near = ps;
        }
      }
      if (near) {
        const dist = Math.sqrt(bd);
        if (dist <= PLAYER.pickupRadius) {
          this.collectLoot(near, l.kind);
          this.events.push({ k: "pickup", px: l.px, pz: l.pz, id: near.id, n: l.kind });
          continue;
        }
        if (dist <= PLAYER.magnetRadius) {
          l.px += (near.px - l.px) * 0.15;
          l.pz += (near.pz - l.pz) * 0.15;
        }
      }
      keep.push(l);
    }
    this.loot = keep;
  }

  private collectLoot(s: PlayerState, kind: LootKind): void {
    if (kind === 0) s.ammo += LOOT.ammoAmount;
    else s.credits += LOOT.creditAmount;
  }

  private spawnZombies(tick: number): void {
    if (tick < this.lastSpawnTick + SPAWN.intervalTicks) return;
    const living: PlayerState[] = [];
    for (const p of this.players.values()) if (p.state.alive) living.push(p.state);
    if (!living.length) return;
    this.lastSpawnTick = tick;

    const cap = Math.min(SPAWN.hardMax, SPAWN.baseMax + SPAWN.perPlayer * living.length);
    for (let i = 0; i < SPAWN.perWave && this.zombies.size < cap; i++) {
      const anchor = living[Math.floor(this.rng() * living.length)] ?? living[0];
      const ang = this.rng() * Math.PI * 2;
      const dist = SPAWN.minDist + this.rng() * (SPAWN.maxDist - SPAWN.minDist);
      let px = anchor.px + Math.sin(ang) * dist;
      let pz = anchor.pz + Math.cos(ang) * dist;
      [px, pz] = collideWorld(px, pz, ZOMBIE.radius, this.world);
      [px, pz] = keepOutOfSafe(px, pz, ZOMBIE.radius, this.world.safeZones);
      const tier = this.rng() < 0.12 ? 1 : 0;
      const zid = `z${this.nextZombieId++}`;
      this.zombies.set(zid, spawnZombie(zid, px, pz, tier));
      this.zombieMeta.set(zid, { attackReadyTick: 0 });
    }
  }

  // -------------------------------------------------------------------------
  // Damage application
  // -------------------------------------------------------------------------

  private damageZombie(zid: string, z: ZombieState, amount: number, ownerId: string): void {
    z.hp -= amount;
    if (z.hp > 0) return;
    this.zombies.delete(zid);
    this.zombieMeta.delete(zid);
    this.events.push({ k: "kill", px: z.px, pz: z.pz, id: zid });

    const owner = this.players.get(ownerId);
    if (owner) {
      owner.state.kills += 1;
      owner.state.credits += PLAYER.creditPerKill;
    }
    if (this.rng() < ZOMBIE.lootChance) {
      const kind: LootKind = this.rng() < 0.5 ? 0 : 1;
      this.loot.push({ id: `l${this.nextLootId++}`, px: z.px, pz: z.pz, kind });
    }
  }

  private damagePlayer(s: PlayerState, amount: number, tick: number): void {
    if (!s.alive || s.safe) return;
    // Armour absorbs first, then health.
    let rem = amount;
    if (s.armor > 0) {
      const absorbed = Math.min(s.armor, rem);
      s.armor -= absorbed;
      rem -= absorbed;
    }
    if (rem > 0) s.hp -= rem;
    this.events.push({ k: "hurt", px: s.px, pz: s.pz, id: s.id });
    if (s.hp <= 0) {
      s.hp = 0;
      s.alive = false;
      s.respawnTick = tick + PLAYER.respawnTicks;
      this.events.push({ k: "death", px: s.px, pz: s.pz, id: s.id });
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Pick a spawn inside a random safe zone (clear of zombies on join). */
  private safeSpawn(): [number, number] {
    const zones = this.world.safeZones;
    const zone = zones[Math.floor(this.rng() * zones.length)] ?? zones[0];
    const ang = this.rng() * Math.PI * 2;
    const rad = this.rng() * (zone.radius * 0.5);
    return [zone.px + Math.cos(ang) * rad, zone.pz + Math.sin(ang) * rad];
  }

  private broadcast(): void {
    const players: PlayerState[] = [];
    for (const p of this.players.values()) players.push(p.state);
    const zombies = [...this.zombies.values()];
    const projectiles: ProjectileState[] = this.projectiles.map((pr) => ({
      id: pr.id,
      px: pr.px,
      pz: pr.pz,
      vx: pr.vx,
      vz: pr.vz,
      weapon: pr.weapon,
    }));
    const loot = this.loot;
    const events = this.events;
    const time = Date.now() - this.startedAt;

    for (const p of this.players.values()) {
      p.conn.send(
        encode({
          t: "snapshot",
          time,
          ack: p.lastSeq,
          players,
          zombies,
          projectiles,
          loot,
          events,
        }),
      );
    }
    this.events = [];
  }
}

let room: BrawlRoom | null = null;
export function getBrawlRoom(): BrawlRoom {
  if (!room) {
    room = new BrawlRoom();
    room.start();
  }
  return room;
}
