/**
 * Wire protocol for the Ruins Brawler game server.
 *
 * Brawler-owned, isolated from carrier-net / space-net. The defining difference
 * is the WebSocket path: `/api/brawl`, its own authoritative room.
 */
import { isShopItemId } from "./types";
import type {
  GameEvent,
  LootState,
  PlayerInput,
  PlayerState,
  ProjectileState,
  ShopItemId,
  ZombieState,
} from "./types";

/** WebSocket sub-path the Brawler server listens on (must be unique). */
export const WS_PATH = "/api/brawl";

export type ClientMessage =
  | { t: "join"; name: string }
  | { t: "input"; cmd: PlayerInput }
  | { t: "buy"; item: ShopItemId };

export type ServerMessage =
  | {
      t: "welcome";
      id: string;
      serverTime: number;
      tickHz: number;
      snapshotHz: number;
      /** Map seed — the client regenerates the identical static world from it. */
      seed: number;
    }
  | {
      t: "snapshot";
      time: number;
      ack: number;
      players: PlayerState[];
      zombies: ZombieState[];
      projectiles: ProjectileState[];
      loot: LootState[];
      events: GameEvent[];
    };

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isValidInput(c: unknown): c is PlayerInput {
  if (!c || typeof c !== "object") return false;
  const i = c as Record<string, unknown>;
  return (
    isFiniteNum(i["seq"]) &&
    isFiniteNum(i["dt"]) &&
    isFiniteNum(i["moveX"]) &&
    isFiniteNum(i["moveZ"]) &&
    isFiniteNum(i["aimX"]) &&
    isFiniteNum(i["aimZ"]) &&
    typeof i["fire"] === "boolean" &&
    typeof i["dash"] === "boolean" &&
    isFiniteNum(i["weapon"])
  );
}

export function decodeClient(raw: string): ClientMessage | null {
  try {
    const m = JSON.parse(raw) as ClientMessage;
    if (!m || typeof m !== "object" || typeof m.t !== "string") return null;
    // Validate untrusted payloads at ingress so malformed messages can never
    // reach the authoritative sim.
    if (m.t === "join") {
      const name = (m as { name?: unknown }).name;
      if (typeof name !== "string") return null;
      return { t: "join", name: name.slice(0, 32) };
    }
    if (m.t === "input") {
      const cmd = (m as { cmd?: unknown }).cmd;
      if (!isValidInput(cmd)) return null;
      return m;
    }
    if (m.t === "buy") {
      if (!isShopItemId((m as { item?: unknown }).item)) return null;
      return m;
    }
    return null;
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
