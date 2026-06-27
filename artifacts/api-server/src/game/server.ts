/**
 * Attaches the space-shooter WebSocket server onto the existing HTTP server.
 *
 * RETAINED FOUNDATION: the retired "skies" arcade cabinet used to be the only
 * consumer of this room + `@workspace/space-net`. The cabinet has been removed
 * (the arcade now out-links to the real Carrier artifact), but this room, its
 * server, and the shared netcode lib are deliberately preserved as the basis
 * for a future "live PvP waters" mode. It is not wired to any current cabinet.
 *
 * We use a `noServer` WebSocketServer and handle the HTTP `upgrade` event
 * ourselves so we only claim connections on `WS_PATH` (`/api/space`) and leave
 * any other upgrade untouched. The shared proxy forwards `/api/*` to this service
 * without rewriting the path, so the client connects to `wss://<host>/api/space`.
 */
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { WS_PATH, decodeClient } from "@workspace/space-net";
import { getRoom } from "./room";
import { logger } from "../lib/logger";

export function attachGameServer(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  const room = getRoom();

  server.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "", "http://localhost").pathname;
    } catch {
      pathname = req.url ?? "";
    }
    if (pathname !== WS_PATH) return; // not ours; leave it alone

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
        room.setIdentity(id, msg.name, msg.shipType);
      } else if (msg.t === "input") {
        room.enqueue(id, msg.cmd);
      } else if (msg.t === "course") {
        room.setCourse(id, msg.tx, msg.tz);
      } else if (msg.t === "fire") {
        room.fireWeapon(id);
      } else if (msg.t === "weapon") {
        room.selectWeapon(id, msg.w);
      } else if (msg.t === "upgrade") {
        room.buyUpgrade(id, msg.id);
      }
    });

    ws.on("close", () => room.remove(id));
    ws.on("error", () => room.remove(id));
  });

  logger.info({ path: WS_PATH }, "space-shooter WS server attached");
}
