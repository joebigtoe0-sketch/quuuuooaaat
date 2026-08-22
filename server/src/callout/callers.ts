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
  sumMax: number; // sum of peak multiples across graded calls
  best: number; // best peak multiple seen
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
  seen?: string[]; // legacy field, no longer used (rows map dedupes now)
}

/** One callout, tracked over time. The SAME callout is re-seen on later
 *  harvests with a matured peak — rows update in place, and reputation is
 *  re-derived from them, so a call graded at 2 minutes old (peak ≈ 1.0x)
 *  stops dragging its caller's average once it runs. This is also the
 *  backtest dataset: entry price, peak price, time-to-peak, mc at call. */
export interface CallRow {
  w: string; // caller wallet
  u: string; // username (may lag)
  m: string; // mint
  at: number; // call time (ms)
  entry: number; // calloutPrice (SOL)
  peak: number; // maxPriceSol so far
  peakAt: number; // peakTimestamp (ms) — time-to-peak = peakAt - at
  mc: number; // marketCap at call (USD, pump.fun's number)
  mult: number | null; // current multiple at last sight
  seen: number; // when we last saw this row
}

const FILE = () => path.join(cfg.dataDir, "callers.json");
const CALLS_FILE = () => path.join(cfg.dataDir, "calls.json");
let db: CallerDb = { callers: {}, mints: {} };
try {
  const j = JSON.parse(fs.readFileSync(FILE(), "utf8"));
  if (j?.callers && j?.mints) db = j;
} catch { /* first run */ }
let calls: Record<string, CallRow> = {};
try {
  const j = JSON.parse(fs.readFileSync(CALLS_FILE(), "utf8"));
  if (j?.rows) calls = j.rows;
} catch { /* first run */ }

// Reputation = frozen seed baseline (3,146-callout firehose harvest of
// 2026-08-15, aggregates only) + everything in the live rows map.
const SEED_AT = Date.parse("2026-08-15T14:04:54.367Z");
const seedBase = new Map(CALLER_SEED.map((s) => [s.w, { n: s.n, sum: s.avg * s.n, best: s.best }]));

function rowPeakMult(r: CallRow): number | null {
  if (r.entry > 0 && r.peak > 0) return r.peak / r.entry;
  return r.mult && r.mult > 0 ? r.mult : null;
}

/** Recompute one wallet's stats from seed baseline + its live rows. */
function rebuildWallet(w: string, rowsByWallet?: Map<string, CallRow[]>): void {
  const mine = rowsByWallet?.get(w) ?? Object.values(calls).filter((r) => r.w === w);
  const base = seedBase.get(w);
  const prev = db.callers[w];
  const c: CallerStat = {
    username: prev?.username ?? "",
    calls: base?.n ?? 0,
    sumMax: base?.sum ?? 0,
    best: base?.best ?? 0,
    coins: prev?.coins ?? [],
    lastSeen: prev?.lastSeen || (base ? SEED_AT : 0),
  };
  for (const r of mine) {
    const pm = rowPeakMult(r);
    if (pm != null) {
      c.calls += 1;
      c.sumMax += pm;
      if (pm > c.best) c.best = pm;
    }
    if (r.u && !c.username) c.username = r.u;
    if (r.at > c.lastSeen) c.lastSeen = r.at;
    if (!c.coins.includes(r.m)) {
      c.coins.push(r.m);
      if (c.coins.length > 200) c.coins = c.coins.slice(-200);
    }
  }
  db.callers[w] = c;
}

// boot: rebuild the whole index from seed + rows (drops the first-generation
// incremental sums, which graded calls at first sight — immature peaks)
{
  const byWallet = new Map<string, CallRow[]>();
  for (const r of Object.values(calls)) {
    const arr = byWallet.get(r.w) ?? [];
    arr.push(r);
    byWallet.set(r.w, arr);
  }
  const wallets = new Set([...seedBase.keys(), ...byWallet.keys(), ...Object.keys(db.callers)]);
  for (const w of wallets) rebuildWallet(w, byWallet);
}

function save(): void {
  try {
    delete db.seen;
    fs.writeFileSync(FILE(), JSON.stringify(db));
  } catch (e) {
    log.warn("callers", `save failed: ${String(e).slice(0, 80)}`);
  }
}
function saveCalls(): void {
  try {
    const ids = Object.keys(calls);
    if (ids.length > 25000) {
      // prune oldest by call time — the backtest window slides, it doesn't grow forever
      const drop = ids.sort((a, b) => calls[a].at - calls[b].at).slice(0, ids.length - 25000);
      for (const id of drop) delete calls[id];
    }
    fs.writeFileSync(CALLS_FILE(), JSON.stringify({ rows: calls }));
  } catch (e) {
    log.warn("callers", `calls save failed: ${String(e).slice(0, 80)}`);
  }
}

/** Upsert one observed callout (from a page harvest OR the live feed) and
 *  refresh its caller's derived stats. Same id re-seen = peak/mult update. */
export function upsertCall(row: Omit<CallRow, "seen">, calloutId: string): void {
  const prev = calls[calloutId];
  calls[calloutId] = {
    ...row,
    at: prev?.at && prev.at < row.at ? prev.at : row.at,
    u: row.u || prev?.u || "",
    peak: Math.max(prev?.peak ?? 0, row.peak),
    peakAt: row.peakAt || prev?.peakAt || 0,
    seen: Date.now(),
  };
  rebuildWallet(row.w);
}

/** Raw rows for analytics/backtesting. */
export function callRows(): CallRow[] {
  return Object.values(calls);
}

/** Batched persistence for external writers (the live-feed poller). */
export function persistIntel(): void {
  save();
  saveCalls();
}

/** Does the caller have SKIN in the coin they called? Public pump.fun PnL
 *  route — cost basis + PnL of any wallet on any mint. This is the omo "FOMO
 *  feed" edge: weight a call by whether its author is actually positioned. */
export async function callerPnl(
  wallet: string,
  mint: string,
): Promise<{ costUsd: number; unrealUsd: number | null; realUsd: number | null; pct: number | null } | null> {
  try {
    const res = await fetch(`https://profile-api.pump.fun/v2/pnl/token/${wallet}/${mint}`, {
      headers: { "user-agent": UA, origin: "https://pump.fun", accept: "*/*" },
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const d = j?.data;
    if (!d) return null;
    return {
      costUsd: Number(d.cost_basis_usd ?? 0),
      unrealUsd: d.unrealized_pnl_usd != null ? Number(d.unrealized_pnl_usd) : null,
      realUsd: d.realized_pnl_usd != null ? Number(d.realized_pnl_usd) : null,
      pct: d.percentage_usd != null ? Number(d.percentage_usd) : null,
    };
  } catch {
    return null;
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
  /** market cap (USD) at call time — the basis for entry-premium checks */
  mcAtCall: number;
  mint: string;
}

/** One callout item from EITHER public source (per-coin /callout/top page or
 *  the cookie-gated /callout/recent feed — same wire shape). Upserts the row,
 *  refreshes the caller's derived stats, notes the tape. */
export function parseCalloutItem(r: any, mintHint?: string): HarvestedCall | null {
  const wallet = String(r?.userId ?? "");
  const calloutId = String(r?.calloutId ?? "");
  const mint = String(r?.coinMint ?? mintHint ?? "");
  if (!wallet || !calloutId || !mint) return null;
  const username = String(r?.username ?? "").trim();
  const at = Number(r?.createdAt ?? 0) || Date.now();
  const entry = Number(r?.calloutPrice ?? 0);
  const peak = Number(r?.maxPriceSol ?? 0);
  const cur = typeof r?.multiple === "number" ? r.multiple : null;
  const mcAtCall = Number(r?.marketCap ?? 0);
  upsertCall(
    { w: wallet, u: username, m: mint, at, entry, peak, peakAt: Number(r?.peakTimestamp ?? 0) || 0, mc: mcAtCall, mult: cur },
    calloutId,
  );
  const thesis = String(r?.thesis ?? "").trim();
  if (thesis) noteTape(mint, username || wallet.slice(0, 6), thesis, cur, at);
  const peakMult = entry > 0 && peak > 0 ? peak / entry : cur;
  return { calloutId, wallet, username, thesis, peakMult, at, mcAtCall, mint };
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
    const parsed = parseCalloutItem(r, mint);
    if (!parsed) continue;
    if (!ids.includes(parsed.wallet)) ids.push(parsed.wallet);
    out.push(parsed);
  }
  const tape = db.mints[mint]?.tape;
  db.mints[mint] = { at: Date.now(), callers: ids, tape };
  save();
  saveCalls();
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

/** The full graded leaderboard — every caller the index has ever graded.
 *  pump.fun caps its own board at top-50; ours shows everything we can prove.
 *  n = 0 means no cap; minCalls guards against one-lucky-call rankings. */
export function topCallers(n = 0, minCalls = 3): (CallerStat & { userId: string; avg: number })[] {
  const rows = Object.entries(db.callers)
    .filter(([, c]) => c.calls >= Math.max(1, minCalls))
    .map(([userId, c]) => ({ ...c, userId, avg: c.sumMax / c.calls }))
    .sort((a, b) => b.avg - a.avg);
  return n > 0 ? rows.slice(0, n) : rows;
}

/** Index totals for the "we grade more than the house does" pitch. */
export function indexStats(): { callers: number; graded: number; coinsSwept: number } {
  const all = Object.values(db.callers);
  return {
    callers: all.length,
    graded: all.filter((c) => c.calls >= 3).length,
    coinsSwept: Object.keys(db.mints).length,
  };
}
