import { io, type Socket } from "socket.io-client";
import { log } from "../log.js";
import { pushChat } from "./livechat.js";
import { walletPubkey } from "../chain/wallet.js";

/**
 * Direct connection to pump.fun's livestream chat backend (livechat.pump.fun,
 * a Socket.io server) for RIKU's own coin room. Reverse-engineered live:
 *   join   -> emit "joinRoom" {roomId: mint}
 *   inbound-> event "newMessage" {roomId, username, userAddress, message, messageType}
 * Feeds every REGULAR viewer message into his chat buffer so he reacts at the
 * facecam — no browser, no userscript, no CSP. Socket.io auto-reconnects.
 */
let socket: Socket | null = null;

export function startPumpChat(mint: string): void {
  if (!mint) return;
  if (socket) { try { socket.disconnect(); } catch {} socket = null; }

  const s = io("https://livechat.pump.fun", {
    transports: ["websocket"],
    extraHeaders: { origin: "https://pump.fun" },
    reconnection: true,
    reconnectionDelay: 3000,
    reconnectionDelayMax: 15000,
  });
  socket = s;

  const joinRoom = () => {
    for (const [ev, payload] of [
      ["joinRoom", { roomId: mint }],
      ["join", { roomId: mint }],
      ["subscribe", { roomId: mint }],
    ] as const) {
      try { s.emit(ev, payload); } catch {}
    }
  };

  s.on("connect", () => {
    log.info("pumpchat", `connected to livechat — watching room ${mint.slice(0, 8)}…`);
    joinRoom();
  });

  s.on("newMessage", (m: any) => {
    try {
      if (!m || String(m.roomId) !== mint) return;               // only our coin's room
      if (m.messageType && m.messageType !== "REGULAR") return;  // skip system/mod messages
      const self = walletPubkey()?.toBase58();
      if (self && m.userAddress === self) return;                // never react to himself
      const user = String(m.username ?? "viewer").trim();
      const text = String(m.message ?? "").trim();
      if (text) pushChat(user, text);
    } catch {}
  });

  s.on("connect_error", (e) => log.warn("pumpchat", `connect_error: ${String(e?.message ?? e).slice(0, 100)}`));
  s.on("disconnect", (r) => log.info("pumpchat", `livechat disconnected (${r}) — reconnecting`));
}

export function stopPumpChat(): void {
  if (socket) { try { socket.disconnect(); } catch {} socket = null; }
}
