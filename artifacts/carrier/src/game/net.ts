/**
 * Thin WebSocket client wrapper for the Carrier game server.
 *
 * Connects to `/api/carrier` — Carrier's own isolated room, never sharing
 * state with Skyforge Squadron.
 */
import {
  WS_PATH,
  decodeServer,
  encode,
  type ClientMessage,
  type ServerMessage,
} from "@workspace/carrier-net";
import type { ConnStatus } from "./constants";

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${WS_PATH}`;
}

export class CarrierSocket {
  private ws: WebSocket | null = null;
  private disposed = false;

  onWelcome: ((m: Extract<ServerMessage, { t: "welcome" }>) => void) | null = null;
  onSnapshot: ((m: Extract<ServerMessage, { t: "snapshot" }>) => void) | null = null;
  onStatus: ((s: ConnStatus) => void) | null = null;

  connect(): void {
    this.onStatus?.("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this.onStatus?.("error");
      return;
    }
    this.ws = ws;
    ws.onopen = () => { if (!this.disposed) this.onStatus?.("connected"); };
    ws.onmessage = (ev) => {
      if (this.disposed) return;
      const msg = decodeServer(typeof ev.data === "string" ? ev.data : "");
      if (!msg) return;
      if (msg.t === "welcome") this.onWelcome?.(msg);
      else if (msg.t === "snapshot") this.onSnapshot?.(msg);
    };
    ws.onerror = () => { if (!this.disposed) this.onStatus?.("error"); };
    ws.onclose = () => { if (!this.disposed) this.onStatus?.("disconnected"); };
  }

  send(msg: ClientMessage): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(encode(msg));
  }

  dispose(): void {
    this.disposed = true;
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }
}
