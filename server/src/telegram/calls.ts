import fs from "node:fs";
import path from "node:path";
import { cfg } from "../config.js";
import { log } from "../log.js";

/**
 * THE CALL LEDGER — who called what, first, and whether following them paid.
 *
 * Two boards from one record set:
 *   GROUP  — every call is recorded to the group it was posted in, so a group
 *            can see its own activity even when the coin was called elsewhere.
 *   GLOBAL — only the FIRST caller of a mint, anywhere, scores. A later post of
 *            the same mint in another group is group-recorded and globally
 *            worth nothing. Prizes pay off the global board only.
 *
 * SCORING — mean log-return at a REACHABLE exit, shrunk toward the population.
 *
 * Every term is there to close a specific hole:
 *   log()      a 10x (+2.30) exactly cancels a -90% (-2.30), and the sum of
 *              logs IS the compounded return of equal-weight following this
 *              caller. It answers the only question a bounty should pay on.
 *   mean       more calls is not more score. Calling less and better wins.
 *   losers     subtract. Under "average multiple" a rug costs a sprayer almost
 *              nothing (multiples floor at 0); in log space it is a real hole,
 *              so spraying is actively expensive rather than merely diluted.
 *   reachable  the exit is the best 5-minute CLOSE after the call, never the
 *              high. A wick to 20x that lasted nine seconds on $200 of volume
 *              is not a 20x call — nobody could have sold into it. This is the
 *              same lesson the trading side paid for twice (see the vertical
 *              gate): score what was actually gettable, not what printed.
 *   shrinkage  n/(n+k) toward the population mean, so two lucky calls cannot
 *              top the board while genuine selectivity is left unpunished. A
 *              soft version of the hard ">=8 calls" bar the caller index uses.
 */

export interface TgCall {
  mint: string;
  symbol: string;
  callerId: string;
  callerName: string;
  at: number;
  groupId: string;
  groupTitle: string;
  /** entry price from the tape (candle close at call time) — grading uses this
   *  so entry and exit come from ONE source and the ratio is self-consistent */
  entryPrice: number | null;
  mcAtCall: number | null;
  /** true only for the global first caller of this mint */
  scored: boolean;
  /** reachable exit multiple; null until graded, 0 excluded from scoring */
  exitMult?: number | null;
  gradedAt?: number;
}

interface Db {
  calls: TgCall[];
  /** mint -> callerId of the first caller anywhere */
  firstBy: Record<string, { callerId: string; at: number; callerName: string }>;
}

const FILE = () => path.join(cfg.dataDir, "tgcalls.json");
let db: Db = { calls: [], firstBy: {} };
try {
  const j = JSON.parse(fs.readFileSync(FILE(), "utf8"));
  if (j?.calls) db = { calls: j.calls, firstBy: j.firstBy ?? {} };
} catch { /* first run */ }

let dirty = false;
export function save(): void {
  if (!dirty) return;
  try {
    fs.writeFileSync(FILE(), JSON.stringify(db));
    dirty = false;
  } catch (e) {
    log.warn("tgcalls", `save failed: ${String(e).slice(0, 80)}`);
  }
}
setInterval(save, 30_000).unref?.();

// ------------------------------------------------------------------ tape --

/** 5-minute candles, newest last. Sparse — only minutes WITH trades exist, so
 *  a small limit still reaches back hours on a quiet chart. */
async function candles(mint: string, limit = 200): Promise<{ timestamp: number; close: number }[]> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8_000);
    const res = await fetch(
      `https://swap-api.pump.fun/v1/coins/${mint}/candles?interval=5m&limit=${limit}&currency=USD`,
      { signal: ctl.signal, headers: { "user-agent": "riku/1.0" } },
    );
    clearTimeout(timer);
    if (!res.ok) return [];
    const rows = (await res.json()) as { timestamp: number; close: string }[];
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => ({ timestamp: Number(r.timestamp), close: Number(r.close) }))
      .filter((r) => Number.isFinite(r.timestamp) && Number.isFinite(r.close) && r.close > 0);
  } catch {
    return [];
  }
}

export async function priceNow(mint: string): Promise<number | null> {
  const c = await candles(mint, 5);
  return c.length ? c[c.length - 1].close : null;
}

// --------------------------------------------------------------- record --

export interface RecordResult {
  first: boolean;
  /** set when someone already called this mint globally */
  priorCaller?: { callerName: string; at: number };
}

export async function recordCall(args: {
  mint: string;
  symbol: string;
  callerId: string;
  callerName: string;
  groupId: string;
  groupTitle: string;
  mcAtCall: number | null;
}): Promise<RecordResult> {
  const prior = db.firstBy[args.mint];
  const first = !prior;
  // one call per caller per mint per group — reposting your own call is not a
  // second call, in either direction
  const dupe = db.calls.some(
    (c) => c.mint === args.mint && c.callerId === args.callerId && c.groupId === args.groupId,
  );
  if (!dupe) {
    db.calls.push({
      mint: args.mint,
      symbol: args.symbol,
      callerId: args.callerId,
      callerName: args.callerName,
      at: Date.now(),
      groupId: args.groupId,
      groupTitle: args.groupTitle,
      entryPrice: await priceNow(args.mint),
      mcAtCall: args.mcAtCall,
      scored: first,
    });
    if (first) db.firstBy[args.mint] = { callerId: args.callerId, at: Date.now(), callerName: args.callerName };
    dirty = true;
  }
  return first ? { first: true } : { first: false, priorCaller: { callerName: prior.callerName, at: prior.at } };
}

// ---------------------------------------------------------------- grade --

/** The reachable exit: the best 5-minute CLOSE strictly after the call, inside
 *  the tracking window. Closes, not highs — a wick nobody could sell into is
 *  not a result. */
export async function gradeCall(c: TgCall): Promise<number | null> {
  if (!c.entryPrice || c.entryPrice <= 0) return null;
  const rows = await candles(c.mint, 500);
  if (!rows.length) return null;
  const until = c.at + cfg.tgGradeWindowH * 3_600_000;
  const after = rows.filter((r) => r.timestamp > c.at && r.timestamp <= until);
  if (!after.length) return null;
  const best = Math.max(...after.map((r) => r.close));
  return best / c.entryPrice;
}

/** Grade everything old enough to have an outcome and not yet final. */
export async function gradeOpenCalls(limit = 25): Promise<number> {
  const now = Date.now();
  const due = db.calls.filter((c) => {
    if (!c.scored) return false; // only the globally-scored calls need a grade
    const age = now - c.at;
    if (age < cfg.tgGradeAfterMin * 60_000) return false;
    const closed = age > cfg.tgGradeWindowH * 3_600_000;
    if (closed && c.exitMult != null) return false; // final
    return c.exitMult == null || !closed; // ungraded, or still maturing
  });
  let n = 0;
  for (const c of due.slice(0, limit)) {
    const m = await gradeCall(c);
    if (m != null) {
      // a call's grade only ever improves while the window is open — a coin
      // that ran and came back still ran
      c.exitMult = Math.max(c.exitMult ?? 0, m);
      c.gradedAt = now;
      dirty = true;
      n++;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  if (n) save();
  return n;
}

// ----------------------------------------------------------------- board --

export interface BoardRow {
  callerId: string;
  callerName: string;
  calls: number;
  scored: number;
  meanLog: number;
  score: number;
  medianMult: number;
  hit2x: number;
  best: { symbol: string; mult: number } | null;
  /** ranked either way, but only eligible rows can take a prize */
  eligible: boolean;
}

const median = (a: number[]): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * @param groupId omit for the GLOBAL board (scored calls only — first callers).
 *                pass a group to see that group's own activity, scored or not.
 */
export function leaderboard(groupId?: string): BoardRow[] {
  const cutoff = Date.now() - cfg.tgScoreWindowDays * 86_400_000;
  const pool = db.calls.filter(
    (c) => c.at >= cutoff && c.exitMult != null && c.exitMult > 0 && (groupId ? c.groupId === groupId : c.scored),
  );
  if (!pool.length) return [];
  // population mean is what a thin record gets shrunk toward
  // one call cannot carry a caller — see TG_MAX_CREDIT_MULT
  const credit = (m: number) => Math.min(m, cfg.tgMaxCreditMult);
  const popMean = pool.reduce((s, c) => s + Math.log(credit(c.exitMult!)), 0) / pool.length;

  const by = new Map<string, TgCall[]>();
  for (const c of pool) {
    const arr = by.get(c.callerId) ?? [];
    arr.push(c);
    by.set(c.callerId, arr);
  }
  const k = cfg.tgScoreShrinkK;
  const rows: BoardRow[] = [];
  for (const [callerId, cs] of by) {
    const mults = cs.map((c) => c.exitMult!);
    const logs = mults.map((m) => Math.log(credit(m)));
    const meanLog = logs.reduce((a, b) => a + b, 0) / logs.length;
    const n = logs.length;
    const best = cs.reduce<TgCall | null>((b, c) => (!b || c.exitMult! > b.exitMult! ? c : b), null);
    rows.push({
      callerId,
      callerName: cs[cs.length - 1].callerName,
      calls: cs.length,
      scored: cs.filter((c) => c.scored).length,
      meanLog,
      score: (meanLog * n + popMean * k) / (n + k),
      medianMult: median(mults),
      hit2x: (mults.filter((m) => m >= 2).length / mults.length) * 100,
      best: best ? { symbol: best.symbol, mult: best.exitMult! } : null,
      eligible: cs.filter((c) => c.scored).length >= cfg.tgMinScoredCalls,
    });
  }
  return rows.sort((a, b) => b.score - a.score);
}

/** Every call on one mint, oldest first — powers the "already called" line. */
export function callsForMint(mint: string): TgCall[] {
  return db.calls.filter((c) => c.mint === mint).sort((a, b) => a.at - b.at);
}

export function callerHistory(callerId: string): TgCall[] {
  return db.calls.filter((c) => c.callerId === callerId).sort((a, b) => b.at - a.at);
}

export function stats(): { calls: number; mints: number; callers: number; graded: number } {
  return {
    calls: db.calls.length,
    mints: Object.keys(db.firstBy).length,
    callers: new Set(db.calls.map((c) => c.callerId)).size,
    graded: db.calls.filter((c) => c.exitMult != null).length,
  };
}
