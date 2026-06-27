/**
 * Attaches the Carrier WebSocket server onto the existing HTTP server.
 *
 * Carrier-owned copy so it never shares state with the space room.
 * Listens on `/api/carrier` — a separate path from the `/api/space` room
 * (the retained `@workspace/space-net` PvP-waters foundation).
 */
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { WS_PATH, decodeClient } from "@workspace/carrier-net";
import { getCarrierRoom } from "./carrier-room";
import { logger } from "../lib/logger";

export function attachCarrierServer(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  const room = getCarrierRoom();

  server.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "", "http://localhost").pathname;
    } catch {
      pathname = req.url ?? "";
    }
    if (pathname !== WS_PATH) return;

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    const id = room.add({ send: (data) => ws.send(data) });

    ws.on("message", (raw) => {
      const msg = decodeClient(raw.toString());
      if (!msg) return;
      if (msg.t === "join") {
        room.setIdentity(id, msg.name, msg.shipType, msg.faction);
      } else if (msg.t === "input") {
        room.enqueue(id, msg.cmd);
      } else if (msg.t === "deploy") {
        room.deploy(id, msg.role);
      } else if (msg.t === "become") {
        room.become(id, msg.entityId);
      } else if (msg.t === "summon") {
        room.summon(id, msg.entityId);
      } else if (msg.t === "build") {
        room.build(id, msg.kind);
      }
    });

    ws.on("close", () => room.remove(id));
    ws.on("error", () => room.remove(id));
  });

  logger.info({ path: WS_PATH }, "carrier WS server attached");
}
