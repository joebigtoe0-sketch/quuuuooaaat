import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { Cue, ServerMsg, SnapshotMsg } from "./protocol.js";
import { log } from "./log.js";

/**
 * Broadcast hub. Every connected client (the OBS-captured /stage page, plus
 * any debug browser) gets the same ticks and cues; a late joiner gets a full
 * snapshot so an OBS refresh mid-show recovers everything.
 */
export class Hub {
  private wss: WebSocketServer;
  private snapshotFn: (() => SnapshotMsg) | null = null;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (ws) => {
      log.info("hub", `client connected (${this.wss.clients.size} total)`);
      if (this.snapshotFn) {
        try {
          ws.send(JSON.stringify(this.snapshotFn()));
        } catch {}
      }
    });
  }

  onSnapshot(fn: () => SnapshotMsg): void {
    this.snapshotFn = fn;
  }

  broadcast(msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const c of this.wss.clients) {
      if (c.readyState === WebSocket.OPEN) c.send(data);
    }
  }

  cue(cue: Cue): void {
    this.broadcast({ t: "cue", cue, now: Date.now() });
  }

  get watchers(): number {
    return this.wss.clients.size;
  }
}
