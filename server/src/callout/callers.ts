import fs from "node:fs";
import path from "node:path";
import { cfg } from "../config.js";
import { log } from "../log.js";
import { CALLER_SEED } from "./callers_seed.js";

/**
 * CALLER INTEL — pump.fun grades every caller's every call for us.
 *
 * `frontend-api-v3.pump.fun/callout/top/{mint}` is PUBLIC (no cookie, no CC
 * token — verified 2026-08-21; the global /callout/recent firehose went
 * auth-only around the same date). Each callout carries the caller's WALLET,
 * username, thesis text, and prices from which the call's peak multiple is
 * derived (maxPriceSol / calloutPrice). The reputation index is built by
 * ACCUMULATION: every coin RIKU researches, calls, or sees trending gets its
 * callout page harvested, and each callout is deposited ONCE (calloutId-
 * deduped) into a persistent per-wallet index. Warm-started from a 3,146-
 * callout firehose harvest (callers_seed.ts). Over weeks this becomes a map
 * of who on pump.fun actually calls runners — a real edge, and very
 * on-character: he judges other callers.
 *
 * The rate-limited CC API is NOT used here at all — it's reserved for the
 * revenue path (posting RIKU's own callouts). Harvesting stays polite anyway:
 * one lookup per CALLER_HARVEST_S, per-mint refresh ≥ CALLER_REFRESH_H.
 */

interface CallerStat {
  username: string;
  calls: number;
  sumMax: number; // sum of maxMultiplier across scored calls
  best: number; // best maxMultiplier seen
  coins: string[]; // mints this caller was seen on (capped)
  lastSeen: number;
}
interface TapeLine {
  who: string; // username or wallet slice
  text: string;
  mult: number | null; // the call's multiple at last sight
  at: number;
}
interface CallerDb {
  callers: Record<string, CallerStat>; // by caller WALLET address
  mints: Record<string, { at: number; callers: string[]; tape?: TapeLine[] }>; // harvest log per mint
  seen?: string[]; // calloutIds already deposited (each call counts once, ever)
}

const FILE = () => path.join(cfg.dataDir, "callers.json");
let db: CallerDb = { callers: {}, mints: {} };
try {
  const j = JSON.parse(fs.readFileSync(FILE(), "utf8"));
  if (j?.callers && j?.mints) db = j;
} catch { /* first run */ }
const seenIds = new Set(db.seen ?? []);
// warm start: seed wallets we have firehose history for but haven't met yet
// (lastSeen = when the firehose harvest saw them; names backfill in the loop)
const SEED_AT = Date.parse("2026-08-15T14:04:54.367Z");
for (const s of CALLER_SEED) {
  if (!db.callers[s.w]) {
    db.callers[s.w] = { username: "", calls: s.n, sumMax: s.avg * s.n, best: s.best, coins: [], lastSeen: SEED_AT };
  }
}
function save(): void {
  try {
    db.seen = [...seenIds].slice(-20000);
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

/** Keep the actual callout TEXT per mint — the "caller tape" RIKU reads when
 *  forming a thesis. Capped, deduped, newest last. */
export function noteTape(mint: string, who: string, text: string, mult: number | null, at: number): void {
  const t = (text ?? "").trim().slice(0, 200);
  if (!t) return;
  const m = (db.mints[mint] ??= { at: 0, callers: [] });
  const tape = (m.tape ??= []);
  if (tape.some((l) => l.text === t)) return;
  tape.push({ who: who || "anon", text: t, mult, at });
  if (tape.length > 6) m.tape = tape.slice(-6);
}

export function callerTape(mint: string): TapeLine[] {
  return db.mints[mint]?.tape ?? [];
}

/** A caller's accumulated reputation, if they have one. */
export function callerRep(userId: string): { calls: number; avg: number; best: number; username: string } | null {
  const c = db.callers[userId];
  if (!c || c.calls < 1) return null;
  return { calls: c.calls, avg: c.sumMax / c.calls, best: c.best, username: c.username };
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

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface HarvestedCall {
  calloutId: string;
  wallet: string;
  username: string;
  thesis: string;
  /** peak multiple of the call so far (maxPriceSol / calloutPrice) */
  peakMult: number | null;
  at: number;
}

/** Read a coin's callout page (public pump.fun route) and deposit every
 *  not-yet-seen callout into the reputation index + the coin's tape.
 *  Returns the parsed callouts so discovery can nominate off fresh ones. */
export async function harvestMint(mint: string): Promise<HarvestedCall[]> {
  const res = await fetch(`https://frontend-api-v3.pump.fun/callout/top/${mint}?limit=50`, {
    headers: { "user-agent": UA, origin: "https://pump.fun", accept: "*/*" },
  });
  if (!res.ok) throw new Error(`callout/top ${res.status}`);
  const j: any = await res.json();
  const rows: any[] = j?.callouts ?? [];
  const out: HarvestedCall[] = [];
  const ids: string[] = [];
  for (const r of rows) {
    const wallet = String(r?.userId ?? "");
    const calloutId = String(r?.calloutId ?? "");
    if (!wallet || !calloutId) continue;
    const username = String(r?.username ?? "").trim();
    const at = Number(r?.createdAt ?? 0) || Date.now();
    const entry = Number(r?.calloutPrice ?? 0);
    const peak = Number(r?.maxPriceSol ?? 0);
    const cur = typeof r?.multiple === "number" ? r.multiple : null;
    const peakMult = entry > 0 && peak > 0 ? peak / entry : cur;
    // each callout funds a caller's record exactly once, ever
    if (!seenIds.has(calloutId)) {
      seenIds.add(calloutId);
      noteCall(wallet, username, mint, peakMult);
    }
    const thesis = String(r?.thesis ?? "").trim();
    if (thesis) noteTape(mint, username || wallet.slice(0, 6), thesis, cur ?? peakMult, at);
    if (!ids.includes(wallet)) ids.push(wallet);
    out.push({ calloutId, wallet, username, thesis, peakMult, at });
  }
  const tape = db.mints[mint]?.tape;
  db.mints[mint] = { at: Date.now(), callers: ids, tape };
  save();
  log.info("callers", `harvested ${mint.slice(0, 8)}… — ${rows.length} callouts, ${ids.length} callers (index: ${Object.keys(db.callers).length})`);
  return out;
}

/** A caller's public pump.fun username — backfilled for callers who entered
 *  the index without one (the warm-start seed carried only wallets). */
async function backfillOneName(): Promise<void> {
  const wallet = Object.entries(db.callers).find(([, c]) => c.calls >= 3 && !c.username)?.[0];
  if (!wallet) return;
  const res = await fetch(`https://frontend-api-v3.pump.fun/users/${wallet}`, {
    headers: { "user-agent": UA, origin: "https://pump.fun", accept: "*/*" },
  });
  if (!res.ok) throw new Error(`users ${res.status}`);
  const j: any = await res.json();
  const name = String(j?.username ?? "").trim();
  // never loop on the same nameless wallet — a wallet slice is an honest name
  db.callers[wallet].username = name || wallet.slice(0, 6);
  save();
  log.info("callers", `named ${wallet.slice(0, 8)}… → ${db.callers[wallet].username}`);
}

/** Fresh callout read for the analysis hot path: harvest now unless this mint
 *  was already harvested in the last 10 min. One public GET, sub-second. */
export async function harvestFresh(mint: string): Promise<void> {
  const h = db.mints[mint];
  if (h && Date.now() - h.at < 10 * 60_000) return;
  await harvestMint(mint);
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the slow background loop. One request per tick, revenue always first. */
export function startCallerHarvester(): void {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      if (queue.length) {
        await harvestMint(queue.shift()!);
      } else {
        await backfillOneName(); // idle tick → give a graded caller their name
      }
    } catch (e) {
      log.warn("callers", `harvest tick failed: ${String(e).slice(0, 100)}`);
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
