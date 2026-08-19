import fs from "node:fs";
import path from "node:path";
import { cfg } from "../config.js";
import { log } from "../log.js";
import { store } from "../store.js";

/**
 * THE KOL DESK — who RIKU reads, who he might follow, and what he's already
 * seen. Two lists on disk (live-editable at /admin, no deploy):
 *   kol_roster.txt — the ACTIVE roster: swept for fresh posts he reacts to
 *   kol_pool.txt   — follow candidates: never swept, only followed
 * Sweeps use ONE search call per 25 handles (measured cap: a 512-char query
 * fits ~28 `from:` terms), so a 75-handle roster costs 3 calls — against a
 * 450-per-15-min budget. The expensive part is the brain, not the API.
 */

const ROSTER = () => path.join(cfg.dataDir, "kol_roster.txt");
const POOL = () => path.join(cfg.dataDir, "kol_pool.txt");

function readList(file: string): string[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim().replace(/^@/, ""))
      .filter((l) => l && !l.startsWith("#"))
      .filter((l) => /^[A-Za-z0-9_]{1,15}$/.test(l));
  } catch {
    return [];
  }
}

let rosterCache: string[] = [];
let rosterAt = 0;
export function roster(): string[] {
  if (Date.now() - rosterAt > 20_000) {
    rosterCache = [...new Set(readList(ROSTER()))];
    rosterAt = Date.now();
  }
  return rosterCache;
}
export function followPool(): string[] {
  return [...new Set(readList(POOL()))];
}
export function saveRoster(text: string): void {
  fs.writeFileSync(ROSTER(), text);
  rosterAt = 0;
  log.info("kols", `roster updated — ${roster().length} handles`);
}
export function savePool(handles: string[]): number {
  const clean = [...new Set(handles.map((h) => h.trim().replace(/^@/, "")))].filter((h) =>
    /^[A-Za-z0-9_]{1,15}$/.test(h),
  );
  fs.writeFileSync(POOL(), `# FOLLOW POOL — bulk-imported\n${clean.join("\n")}\n`);
  log.info("kols", `follow pool updated — ${clean.length} handles`);
  return clean.length;
}

// ---------- seen posts: never react to the same tweet twice ----------
const SEEN_KEY = "kol:seen";
let seen: Record<string, number> = (() => {
  try { return JSON.parse(store.kvGet(SEEN_KEY) ?? "{}"); } catch { return {}; }
})();
export function isSeen(id: string): boolean {
  return !!seen[id];
}
export function markSeen(ids: string[]): void {
  for (const id of ids) seen[id] = Date.now();
  const keys = Object.keys(seen);
  if (keys.length > 1500) {
    const keep = keys.sort((a, b) => seen[b] - seen[a]).slice(0, 900);
    seen = Object.fromEntries(keep.map((k) => [k, seen[k]]));
  }
  store.kvSet(SEEN_KEY, JSON.stringify(seen));
}

// ---------- following: who he already follows (so he never re-follows) ----------
const FOLLOWED_KEY = "kol:followed";
export function followedSet(): Set<string> {
  try { return new Set(JSON.parse(store.kvGet(FOLLOWED_KEY) ?? "[]")); } catch { return new Set(); }
}
export function markFollowed(handle: string): void {
  const s = followedSet();
  s.add(handle.toLowerCase());
  store.kvSet(FOLLOWED_KEY, JSON.stringify([...s]));
}

/** Next handles worth following — roster first (his own read list), then pool. */
export function followCandidates(n = 3): string[] {
  const done = followedSet();
  const pick = [...roster(), ...followPool()].filter((h) => !done.has(h.toLowerCase()));
  // spread across the list instead of always the top
  const out: string[] = [];
  while (out.length < n && pick.length) {
    out.push(pick.splice(Math.floor(Math.random() * Math.min(pick.length, 40)), 1)[0]);
  }
  return out;
}
