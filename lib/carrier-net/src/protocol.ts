/**
 * Wire protocol for the Carrier game server.
 *
 * Carrier-owned copy so the protocol can evolve independently of Skyforge
 * Squadron.  The ONLY intentional difference from space-net right now is the
 * WebSocket path: `/api/carrier` instead of `/api/space`.
 */
import { isDeployableRole, isFactionId, isPlatformKind } from "./types";
import type {
  BeamState,
  CelestialBody,
  EntityState,
  FactionId,
  FleetRole,
  GameEvent,
  InputCommand,
  Outpost,
  PlatformKind,
  PlatformState,
  PlayerEconomy,
  ProjectileState,
  RewardBox,
} from "./types";

/** WebSocket sub-path the Carrier server listens on. */
export const WS_PATH = "/api/carrier";

export type ClientMessage =
  | { t: "join"; name: string; shipType: number; faction?: FactionId }
  | { t: "input"; cmd: InputCommand }
  | { t: "deploy"; role: FleetRole }
  /** Take direct control of one owned entity (mothership / fighter / fleet unit). */
  | { t: "become"; entityId: string }
  /**
   * Toggle escort/summon on one owned fleet unit: it flies to the player's
   * currently-controlled ship and protects it (toggle off to release it back to
   * its zone patrol).
   */
  | { t: "summon"; entityId: string }
  /** Build one platform of `kind` and tether it to the owned mothership. */
  | { t: "build"; kind: PlatformKind };

export type ServerMessage =
  | {
      t: "welcome";
      id: string;
      serverTime: number;
      tickHz: number;
      snapshotHz: number;
    }
  | {
      t: "snapshot";
      time: number;
      ack: number;
      entities: EntityState[];
      projectiles: ProjectileState[];
      events: GameEvent[];
      economy: PlayerEconomy[];
      celestials: CelestialBody[];
      rewards: RewardBox[];
      outposts: Outpost[];
      beams: BeamState[];
      platforms: PlatformState[];
    };

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function decodeClient(raw: string): ClientMessage | null {
  try {
    const m = JSON.parse(raw) as ClientMessage;
    if (!m || typeof m !== "object" || typeof m.t !== "string") return null;
    // Validate untrusted payloads at ingress so malformed messages can never
    // reach the authoritative sim. Deploy in particular must carry a real role,
    // or it could poison the economy / spawn malformed fleet state downstream.
    if (m.t === "deploy" && !isDeployableRole((m as { role?: unknown }).role)) {
      return null;
    }
    // `join` may carry an optional faction; drop a malformed (non-faction) value
    // rather than letting it through so the room only ever sees a real id or none.
    if (m.t === "join") {
      const f = (m as { faction?: unknown }).faction;
      if (f !== undefined && !isFactionId(f)) {
        (m as { faction?: unknown }).faction = undefined;
      }
    }
    // `become`/`summon` must carry a non-empty entity id; ownership is enforced
    // by the room.
    if (m.t === "become" || m.t === "summon") {
      const eid = (m as { entityId?: unknown }).entityId;
      if (typeof eid !== "string" || eid.length === 0 || eid.length > 64) return null;
    }
    // `build` must name a real platform kind, or the economy/spawn maths break.
    if (m.t === "build" && !isPlatformKind((m as { kind?: unknown }).kind)) {
      return null;
    }
    return m;
  } catch {
    /* drop malformed */
  }
  return null;
}

export function decodeServer(raw: string): ServerMessage | null {
  try {
    const m = JSON.parse(raw) as ServerMessage;
    if (m && typeof m === "object" && typeof m.t === "string") return m;
  } catch {
    /* drop malformed */
  }
  return null;
}
