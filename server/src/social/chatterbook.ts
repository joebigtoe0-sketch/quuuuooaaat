import fs from "node:fs";
import path from "node:path";
import { cfg } from "../config.js";

/**
 * THE REGULARS BOOK — who's in chat and what he knows about them. Every
 * message updates counts + recent lines automatically; the durable NOTES are
 * things HE decided were worth remembering (their bags, running jokes,
 * milestones), written back from the chat beat. This is how one-off viewers
 * become regulars he greets by name and history.
 */
export interface Chatter {
  name: string; // as they type it
  firstSeen: number;
  lastSeen: number;
  msgs: number;
  notes: string[]; // durable facts, cap 6, newest last
  recent: string[]; // last lines, cap 5
}

const FILE = path.join(cfg.dataDir, "chatters.json");
let book: Record<string, Chatter> = {}; // key = lowercased name
try {
  book = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch { /* first run */ }

let saveTimer: NodeJS.Timeout | null = null;
function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(book));
      fs.renameSync(tmp, FILE);
    } catch { /* disk hiccup — next save wins */ }
  }, 1000);
}

export function noteMessage(user: string, text: string): void {
  const key = user.toLowerCase();
  const c = (book[key] ??= { name: user, firstSeen: Date.now(), lastSeen: 0, msgs: 0, notes: [], recent: [] });
  c.lastSeen = Date.now();
  c.msgs++;
  c.recent.push(text.slice(0, 120));
  if (c.recent.length > 5) c.recent.shift();
  // cap the book: keep the 400 most recently active
  const keys = Object.keys(book);
  if (keys.length > 400) {
    for (const k of keys.sort((a, b) => book[a].lastSeen - book[b].lastSeen).slice(0, keys.length - 400)) delete book[k];
  }
  save();
}

export function addNote(user: string, note: string): void {
  const c = book[user.toLowerCase()];
  if (!c) return;
  const n = note.trim().slice(0, 120);
  if (!n || c.notes.some((x) => x.toLowerCase() === n.toLowerCase())) return;
  c.notes.push(n);
  if (c.notes.length > 6) c.notes.shift();
  save();
}

/** Prompt context for the users in the current batch — history + notes. */
export function chatContext(users: string[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const u of users) {
    const key = u.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const c = book[key];
    if (!c) continue;
    const days = Math.floor((Date.now() - c.firstSeen) / 86_400_000);
    const std = c.msgs >= 20 ? "REGULAR" : c.msgs >= 5 ? "familiar face" : "newer face";
    lines.push(
      `- ${c.name}: ${std}, ${c.msgs} msgs${days > 0 ? ` since ${days}d ago` : " (first day!)"}${c.notes.length ? `. You remember: ${c.notes.join("; ")}` : ""}`,
    );
  }
  return lines.join("\n").slice(0, 900);
}
