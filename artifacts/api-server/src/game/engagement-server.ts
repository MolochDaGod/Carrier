/**
 * Engagement room server for Grudge Space RTS PvP lobbies.
 * Path: /api/engagement — separate from the Carrier dogfight room at /api/carrier.
 */
import type { Server } from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { logger } from "../lib/logger";

export const ENGAGEMENT_WS_PATH = "/api/engagement";

const TICK_HZ = Number(process.env.ENGAGEMENT_TICK_HZ ?? 20);
const TICK_MS = Math.round(1000 / TICK_HZ);
const MAX_PILOTS = Number(process.env.ENGAGEMENT_MAX_PILOTS ?? 8);

interface Pilot {
  id: string;
  grudgeId: string;
  displayName: string;
  loadoutId: string;
  ready: boolean;
  teamSlot: number;
  lastSeenMs: number;
}

interface Room {
  id: string;
  pilots: Map<string, Pilot>;
  sockets: Map<string, WebSocket>;
  hostId: string | null;
  tick: number;
  tickTimer: ReturnType<typeof setInterval>;
}

const rooms = new Map<string, Room>();

function sanitizeName(name: unknown): string {
  return String(name ?? "Commander")
    .replace(/[^\w \-_.]/g, "")
    .slice(0, 32) || "Commander";
}

function sanitizeRoomId(id: unknown): string {
  return String(id ?? "default")
    .replace(/[^a-zA-Z0-9_\-]/g, "")
    .slice(0, 64) || "default";
}

function roomSnapshot(room: Room): object {
  return {
    type: "state",
    roomId: room.id,
    tick: room.tick,
    pilots: Array.from(room.pilots.values()).map((p) => ({
      id: p.id,
      grudgeId: p.grudgeId,
      displayName: p.displayName,
      ready: p.ready,
    })),
    hostId: room.hostId,
    tickHz: TICK_HZ,
    maxPilots: MAX_PILOTS,
  };
}

function broadcast(room: Room, msg: object, excludeId: string | null = null) {
  const data = JSON.stringify(msg);
  for (const [sid, ws] of room.sockets) {
    if (sid === excludeId) continue;
    if (ws.readyState === 1) ws.send(data);
  }
}

function disposeRoomIfEmpty(roomId: string) {
  const room = rooms.get(roomId);
  if (!room || room.pilots.size > 0) return;
  clearInterval(room.tickTimer);
  rooms.delete(roomId);
}

function getOrCreateRoom(roomId: string): Room {
  let room = rooms.get(roomId);
  if (room) return room;
  room = {
    id: roomId,
    pilots: new Map(),
    sockets: new Map(),
    hostId: null,
    tick: 0,
    tickTimer: setInterval(() => {
      const r = rooms.get(roomId);
      if (!r) return;
      r.tick += 1;
      broadcast(r, roomSnapshot(r));
    }, TICK_MS),
  };
  rooms.set(roomId, room);
  return room;
}

function nextTeamSlot(room: Room): number {
  const used = new Set(Array.from(room.pilots.values()).map((p) => p.teamSlot));
  for (let i = 0; i < MAX_PILOTS; i++) {
    if (!used.has(i)) return i;
  }
  return room.pilots.size;
}

export function attachEngagementServer(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "", "http://localhost").pathname;
    } catch {
      pathname = req.url ?? "";
    }
    if (pathname !== ENGAGEMENT_WS_PATH) return;

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    const socketId = `e_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
    let roomId: string | null = null;

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        const type = msg.type as string | undefined;
        if (!type) return;

        if (type === "join") {
          const id = sanitizeRoomId(msg.roomId);
          const room = getOrCreateRoom(id);
          if (room.pilots.size >= MAX_PILOTS) {
            ws.send(JSON.stringify({ type: "error", message: "room full" }));
            ws.close(4000, "room full");
            return;
          }

          const pilot: Pilot = {
            id: socketId,
            grudgeId: String(msg.grudgeId ?? `guest_${socketId}`).slice(0, 64),
            displayName: sanitizeName(msg.displayName),
            loadoutId: String(msg.loadoutId ?? "default").slice(0, 32),
            ready: false,
            teamSlot: nextTeamSlot(room),
            lastSeenMs: Date.now(),
          };

          room.pilots.set(socketId, pilot);
          room.sockets.set(socketId, ws);
          roomId = id;
          if (!room.hostId) room.hostId = socketId;

          ws.send(
            JSON.stringify({
              type: "joined",
              selfId: socketId,
              roomId: id,
              tick: room.tick,
              hostId: room.hostId,
              teamSlot: pilot.teamSlot,
              localTeam: pilot.teamSlot + 1,
              pilots: Array.from(room.pilots.values()).map((p) => ({
                id: p.id,
                grudgeId: p.grudgeId,
                displayName: p.displayName,
                ready: p.ready,
              })),
              tickHz: TICK_HZ,
              maxPilots: MAX_PILOTS,
            }),
          );

          broadcast(
            room,
            {
              type: "pilot_join",
              pilot: {
                id: pilot.id,
                grudgeId: pilot.grudgeId,
                displayName: pilot.displayName,
                ready: pilot.ready,
              },
            },
            socketId,
          );
          return;
        }

        if (!roomId) return;
        const room = rooms.get(roomId);
        const pilot = room?.pilots.get(socketId);
        if (!room || !pilot) return;

        if (type === "ready") {
          pilot.ready = Boolean(msg.ready);
          pilot.lastSeenMs = Date.now();
          broadcast(room, roomSnapshot(room));
          return;
        }

        if (type === "input") {
          pilot.lastSeenMs = Date.now();
          broadcast(
            room,
            {
              type: "intent",
              fromId: socketId,
              fromTeam: pilot.teamSlot + 1,
              tick: room.tick,
              payload: msg,
            },
            socketId,
          );
          return;
        }

        if (type === "ping") {
          ws.send(JSON.stringify({ type: "pong", serverTime: Date.now(), tick: room.tick }));
        }
      } catch {
        /* ignore */
      }
    });

    ws.on("close", () => {
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      room.pilots.delete(socketId);
      room.sockets.delete(socketId);
      if (room.hostId === socketId) {
        const next = room.pilots.keys().next().value as string | undefined;
        room.hostId = next ?? null;
      }
      broadcast(room, { type: "pilot_leave", pilotId: socketId });
      broadcast(room, roomSnapshot(room));
      disposeRoomIfEmpty(roomId);
    });
  });

  logger.info({ path: ENGAGEMENT_WS_PATH, tickHz: TICK_HZ }, "engagement WS server attached");
}