/**
 * Attaches the Ruins Brawler WebSocket server onto the existing HTTP server.
 *
 * Brawler-owned copy so it never shares state with the Carrier or Skyforge
 * rooms. Listens on `/api/brawl` — a unique path, separate from `/api/carrier`
 * and `/api/space`.
 */
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { WS_PATH, decodeClient } from "@workspace/brawl-net";
import { getBrawlRoom } from "./brawl-room";
import { logger } from "../lib/logger";

export function attachBrawlServer(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  const room = getBrawlRoom();

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
        room.setName(id, msg.name);
      } else if (msg.t === "input") {
        room.enqueue(id, msg.cmd);
      } else if (msg.t === "buy") {
        room.buy(id, msg.item);
      }
    });

    ws.on("close", () => room.remove(id));
    ws.on("error", () => room.remove(id));
  });

  logger.info({ path: WS_PATH }, "brawl WS server attached");
}
