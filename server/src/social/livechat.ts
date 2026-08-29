import { log } from "../log.js";
import { cfg } from "../config.js";

/**
 * The pump.fun livestream chat, as Quant experiences it. Messages arrive from
 * the producer (/admin/chat-add relays real chat until a native pump.fun chat
 * integration exists) or from the sim's mock viewers. He reads them when he
 * walks to the facecam (chatBeat) — unread count nudges his planner.
 */
export interface ChatMsg {
  user: string;
  text: string;
  at: number;
}

const buf: ChatMsg[] = [];
let lastReadAt = 0;

export function pushChat(user: string, text: string): ChatMsg | null {
  const u = String(user ?? "viewer").trim().slice(0, 24) || "viewer";
  const t = String(text ?? "").trim().slice(0, 200);
  if (!t) return null;
  const msg = { user: u, text: t, at: Date.now() };
  buf.push(msg);
  if (buf.length > 200) buf.shift();
  // chat is content too — surface it in the on-stream terminal feed
  void import("../feed.js").then(({ pushFeed }) => pushFeed("chat", `${u}: ${t}`)).catch(() => {});
  // and every voice goes in the regulars book — connections need memory
  void import("./chatterbook.js").then(({ noteMessage }) => noteMessage(u, t)).catch(() => {});
  return msg;
}

export function unreadChat(): number {
  return buf.filter((m) => m.at > lastReadAt).length;
}

/** UNREAD messages only (up to n), marking the buffer read — re-reading the
 *  same lines every facecam visit made him answer old chat twice. */
export function readChat(n = 8): ChatMsg[] {
  const msgs = buf.filter((m) => m.at > lastReadAt).slice(-n);
  lastReadAt = Date.now();
  return msgs;
}

export function allChat(n = 50): ChatMsg[] {
  return buf.slice(-n);
}

// ---------- sim: mock viewers so the rehearsal has a living chat ----------
const MOCK_USERS = ["degenDave", "wagmi_wendy", "0xShrimp", "bondwatcher", "gmgn_earl", "solRat", "pattycakes", "chartgoblin"];
const MOCK_LINES = [
  "wen bond",
  "what's the bar at today",
  "RIKU you sleeping on $WIF",
  "do a backflip",
  "chat is this guy even real",
  "rate my bag: 14 rugs and a dream",
  "why no buys today ser",
  "the robot has more discipline than me fr",
  "what does the 55 score mean",
  "gm quant",
  "play air guitar",
  "bro really said selection over speed 💀",
  "can you check the coin i sent",
  "how much of your own token do you hold",
];
export function startMockChat(): void {
  const tick = () => {
    if (Math.random() < 0.6) {
      pushChat(
        MOCK_USERS[Math.floor(Math.random() * MOCK_USERS.length)],
        MOCK_LINES[Math.floor(Math.random() * MOCK_LINES.length)],
      );
    }
  };
  setInterval(tick, Math.max(5_000, 90_000 / cfg.simSpeed));
  log.info("chat", "mock livestream chat running (sim)");
}
