import fs from "node:fs";
import path from "node:path";
import { cfg } from "../config.js";
import { log } from "../log.js";
import { ccGet, ccQuietOk } from "./cc.js";

/**
 * CALLER INTEL — pump.fun grades every caller's every call for us.
 *
 * `/api/v1/communities/{mint}/callouts` returns, per callout, the caller's
 * identity AND pump.fun's own scoring of that call (multiplier /
 * maxMultiplier). There is no per-user history route, so the reputation index
 * is built by ACCUMULATION: every coin RIKU researches or calls gets its
 * callout page harvested once, and each harvest deposits every caller seen
 * into a persistent index. Over weeks this becomes a map of who on pump.fun
 * actually calls runners — a real edge, and very on-character: he judges
 * other callers.
 *
 * Rules of engagement with the API (it punishes bursts with penalty windows):
 *  - ONE request per tick, ticks CALLER_HARVEST_S apart (default 90s)
 *  - always yields to the posting path (ccQuietOk) — callouts are revenue,
 *    harvesting is homework
 *  - a mint is re-harvested at most every CALLER_REFRESH_H hours (default 6)
 */

interface CallerStat {
  username: string;
  calls: number;
  sumMax: number; // sum of maxMultiplier across scored calls
  best: number; // best maxMultiplier seen
  coins: string[]; // mints this caller was seen on (capped)
  lastSeen: number;
}
interface CallerDb {
  callers: Record<string, CallerStat>; // by userId
  mints: Record<string, { at: number; callers: string[] }>; // harvest log per mint
}

const FILE = () => path.join(cfg.dataDir, "callers.json");
let db: CallerDb = { callers: {}, mints: {} };
try {
  const j = JSON.parse(fs.readFileSync(FILE(), "utf8"));
  if (j?.callers && j?.mints) db = j;
} catch { /* first run */ }
function save(): void {
  try {
    fs.writeFileSync(FILE(), JSON.stringify(db));
  } catch (e) {
    log.warn("callers", `save failed: ${String(e).slice(0, 80)}`);
  }
}

const queue: string[] = [];

/** Ask the harvester to (re)visit a mint. Cheap; call it from research/callout paths. */
export function requestHarvest(mint: string): void {
  if (!mint || mint.length < 30) return;
  const seen = db.mints[mint];
  if (seen && Date.now() - seen.at < cfg.callerRefreshH * 3_600_000) return;
  if (!queue.includes(mint)) queue.push(mint);
}

function noteCall(userId: string, username: string, mint: string, maxMultiplier: number | null): void {
  const c = (db.callers[userId] ??= { username, calls: 0, sumMax: 0, best: 0, coins: [], lastSeen: 0 });
  c.username = username || c.username;
  c.lastSeen = Date.now();
  if (!c.coins.includes(mint)) {
    c.coins.push(mint);
    if (c.coins.length > 200) c.coins = c.coins.slice(-200);
  }
  // only SCORED calls count toward the average — a fresh unscored callout
  // must not drag a good caller toward zero
  if (typeof maxMultiplier === "number" && maxMultiplier > 0) {
    c.calls += 1;
    c.sumMax += maxMultiplier;
    if (maxMultiplier > c.best) c.best = maxMultiplier;
  }
}

async function harvestOne(mint: string): Promise<void> {
  const j = await ccGet(`/api/v1/communities/${mint}/callouts?limit=50`);
  const rows: any[] = Array.isArray(j) ? j : j?.callouts ?? j?.data ?? [];
  const ids: string[] = [];
  for (const r of rows) {
    const userId = String(r?.userId ?? r?.user?.id ?? "");
    const username = String(r?.username ?? r?.user?.username ?? "");
    if (!userId) continue;
    const mm = r?.maxMultiplier ?? r?.max_multiplier ?? null;
    noteCall(userId, username, mint, typeof mm === "number" ? mm : mm != null ? Number(mm) : null);
    if (!ids.includes(userId)) ids.push(userId);
  }
  db.mints[mint] = { at: Date.now(), callers: ids };
  save();
  log.info("callers", `harvested ${mint.slice(0, 8)}… — ${rows.length} callouts, ${ids.length} callers (index: ${Object.keys(db.callers).length})`);
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the slow background loop. One request per tick, revenue always first. */
export function startCallerHarvester(): void {
  if (timer) return;
  timer = setInterval(async () => {
    if (!queue.length) return;
    if (!ccQuietOk()) return; // a callout just posted or the API is punishing us — wait
    const mint = queue.shift()!;
    try {
      await harvestOne(mint);
    } catch (e) {
      const msg = String(e).slice(0, 100);
      // 429 → back of the queue, ccQuietOk() now holds the whole loop off
      if (/^Error: 429|^429/.test(msg)) queue.push(mint);
      log.warn("callers", `harvest ${mint.slice(0, 8)}… failed: ${msg}`);
    }
  }, Math.max(30, cfg.callerHarvestS) * 1000);
  log.info("callers", `harvester on — one lookup / ${cfg.callerHarvestS}s, refresh ≥ ${cfg.callerRefreshH}h, index has ${Object.keys(db.callers).length} callers`);
}

export interface CallerSignal {
  callers: number; // distinct callers seen on this mint
  scored: number; // of those, callers with ≥3 scored calls (credible sample)
  bestAvg: number; // best avg maxMultiplier among credible callers on this mint
  bestName: string; // that caller's username
  bestCalls: number; // their sample size
}

/** SYNC read for the scoring hot path — cache only, never a network call. */
export function callerSignal(mint: string): CallerSignal | null {
  const h = db.mints[mint];
  if (!h || !h.callers.length) return null;
  let bestAvg = 0, bestName = "", bestCalls = 0, scored = 0;
  for (const id of h.callers) {
    const c = db.callers[id];
    if (!c || c.calls < 3) continue; // one lucky call is noise, not reputation
    scored++;
    const avg = c.sumMax / c.calls;
    if (avg > bestAvg) {
      bestAvg = avg;
      bestName = c.username;
      bestCalls = c.calls;
    }
  }
  return { callers: h.callers.length, scored, bestAvg, bestName, bestCalls };
}

/** Leaderboard for admin/producer visibility. */
export function topCallers(n = 25): (CallerStat & { userId: string; avg: number })[] {
  return Object.entries(db.callers)
    .filter(([, c]) => c.calls >= 3)
    .map(([userId, c]) => ({ ...c, userId, avg: c.sumMax / c.calls }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, n);
}
