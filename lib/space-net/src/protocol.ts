/**
 * Wire protocol between client and authoritative server.
 *
 * v1 uses JSON for debuggability (player counts are small and snapshots are
 * compact). The shapes are explicit unions so both sides share one source of
 * truth; encode/decode wrap (de)serialisation with a safe parse so a malformed
 * frame is dropped rather than throwing inside the socket handler.
 */
import type {
  EntityState,
  GameEvent,
  InputCommand,
  PlayerEconomy,
  ProjectileState,
} from "./types";

/** WebSocket sub-path the game server listens on (under the /api proxy route). */
export const WS_PATH = "/api/space";

/** Client -> Server. */
export type ClientMessage =
  | { t: "join"; name: string; shipType: number }
  | { t: "input"; cmd: InputCommand }
  /**
   * Set a course for the player's mothership.
   * The server validates and clamps the destination to the arena boundary then
   * updates the controlled entity's `hasCourse/courseTx/courseTz` fields.
   */
  | { t: "course"; tx: number; tz: number }
  /** Fire the currently selected weapon (server enforces the cooldown). */
  | { t: "fire" }
  /** Select a player weapon (index into the shared `WEAPONS` table). */
  | { t: "weapon"; w: number }
  /** Buy the next level of an upgrade (server checks credits + max level). */
  | { t: "upgrade"; id: string };

/** Server -> Client. */
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
      /** Highest input seq the server has processed for THIS recipient. */
      ack: number;
      /**
       * All live entities in the simulation (fighters, mother ships, fleet
       * units, mines). Replaces the old `ships` array; clients render each
       * entity according to its `kind` field and predict/reconcile only the
       * one they control (identified via `economy[].controlledEntityId`).
       */
      entities: EntityState[];
      projectiles: ProjectileState[];
      events: GameEvent[];
      /**
       * Per-player economy + ownership data. Each connected player has one
       * entry; the local client finds its own entry by matching `playerId`
       * against the welcome `id`.
       */
      economy: PlayerEconomy[];
    };

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function decodeClient(raw: string): ClientMessage | null {
  try {
    const m = JSON.parse(raw) as ClientMessage;
    if (m && typeof m === "object" && typeof m.t === "string") return m;
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
