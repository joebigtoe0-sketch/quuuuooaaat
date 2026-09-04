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
 * SCORING — EXPECTED PROFIT PER CALL at a REACHABLE exit, shrunk toward the
 * population, with per-call credit capped.
 *
 * This was mean-LOG-return first, and that was wrong. Log-mean is the growth
 * rate you get compounding your whole stack into every call, and nobody follows
 * a caller that way — you stake a fixed clip per call, so what you actually
 * earn is the arithmetic mean. The difference is not academic: a caller who
 * rugged 5 of 10 and mooned 3 made a fixed-clip follower +223% per call, and
 * log-mean ranked him BELOW someone buying eight consistent 3x's. Asymmetric
 * calling is what a good memecoin caller does; the metric was punishing it.
 *
 * Every term is there to close a specific hole:
 *   profit/call the honest number: what a follower earns per unit staked.
 *   mean        more calls is not more score. Calling less and better wins.
 *   losers      subtract properly — a rug is -95%, not a small positive.
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
  const raw = fs.readFileSync(FILE(), "utf8");
  try {
    const j = JSON.parse(raw);
    if (j?.calls) db = { calls: j.calls, firstBy: j.firstBy ?? {} };
  } catch (e) {
    // A file that EXISTS but will not parse is a truncated write, not a first
    // run — the crash-loop marathon (SIGKILL mid-writeFileSync) produced
    // exactly this, and the old code then silently started empty and OVERWROTE
    // the recoverable file on the next save. Days of caller history gone.
    // Preserve the evidence, scream, start fresh only after both.
    const bak = `${FILE()}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(FILE(), bak); } catch {}
    log.warn("tgcalls", `LEDGER CORRUPT — preserved to ${path.basename(bak)}, starting fresh: ${String(e).slice(0, 60)}`);
  }
} catch { /* genuinely no file — first run */ }

let dirty = false;
export function save(): void {
  if (!dirty) return;
  try {
    // atomic: a kill mid-write leaves a stale .tmp, never a truncated ledger
    const tmp = `${FILE()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE());
    dirty = false;
  } catch (e) {
    log.warn("tgcalls", `save failed: ${String(e).slice(0, 80)}`);
  }
}
setInterval(save, 30_000).unref?.();
// flush on shutdown — Railway SIGTERMs us on every deploy
for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, save);

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

/** All-time-high from the tape, as a market cap. Uses the highest 5m CLOSE for
 *  the same reason grading does — a wick is not a price anyone got. */
export async function athFromTape(mint: string, supply = 1e9): Promise<{ mcUsd: number; at: number } | null> {
  const rows = await candles(mint, 1000);
  if (!rows.length) return null;
  const top = rows.reduce((b, r) => (r.close > b.close ? r : b));
  return { mcUsd: top.close * supply, at: top.timestamp };
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
  /** raw expected profit per call, before shrinkage (0.5 = +50% per call) */
  meanProfit: number;
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
/**
 * @param days   how far back to count calls
 * @param kDays  what window the shrinkage should be sized for. Normally the
 *               same as `days`, but the monthly competition wants the FULL
 *               month's bar all month long — otherwise on the 2nd a single
 *               lucky call tops the standings and the board swings wildly as
 *               the month fills in.
 */
export function leaderboard(groupId?: string, days?: number, kDays?: number): BoardRow[] {
  const cutoff = Date.now() - (days ?? cfg.tgScoreWindowDays) * 86_400_000;
  const pool = db.calls.filter(
    (c) => c.at >= cutoff && c.exitMult != null && c.exitMult > 0 && (groupId ? c.groupId === groupId : c.scored),
  );
  if (!pool.length) return [];
  // one call cannot carry a caller — see TG_MAX_CREDIT_MULT
  const credit = (m: number) => Math.min(m, cfg.tgMaxCreditMult);
  // SHRINK TOWARD ZERO, not the population mean. Shrinking toward the population
  // was backwards: on the live 1D board the population averaged +132%/call
  // (inflated by one 14x), so a caller with a SINGLE 3.6x had five phantom calls
  // at +132% added to him and ranked ABOVE a caller with six real ones. The term
  // meant to punish thin records was protecting them. Zero is the honest prior:
  // no evidence, no assumed edge.
  const prior = 0;

  const by = new Map<string, TgCall[]>();
  for (const c of pool) {
    const arr = by.get(c.callerId) ?? [];
    arr.push(c);
    by.set(c.callerId, arr);
  }
  // k grows with the window. One call in a day is a normal day; one call in
  // thirty is not participating. sqrt keeps it gentle: at 30d a single perfect
  // 10x still scores +32% against +24% for twelve solid calls — possible, but it
  // has to be genuinely exceptional.
  const k = cfg.tgScoreShrinkK * Math.sqrt(Math.max(1, kDays ?? days ?? cfg.tgScoreWindowDays));
  const rows: BoardRow[] = [];
  for (const [callerId, cs] of by) {
    const mults = cs.map((c) => c.exitMult!);
    // profit per unit staked: a 3x returns +2.00, a rug at 0.05 returns -0.95
    const profits = mults.map((m) => credit(m) - 1);
    const meanProfit = profits.reduce((a, b) => a + b, 0) / profits.length;
    const n = profits.length;
    const best = cs.reduce<TgCall | null>((b, c) => (!b || c.exitMult! > b.exitMult! ? c : b), null);
    rows.push({
      callerId,
      callerName: cs[cs.length - 1].callerName,
      calls: cs.length,
      scored: cs.filter((c) => c.scored).length,
      meanProfit,
      score: (meanProfit * n + prior * k) / (n + k),
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

// ------------------------------------------------------------- the board --

export interface CallRank {
  symbol: string;
  mint: string;
  callerName: string;
  callerId: string;
  mult: number;
  at: number;
}

/** Individual calls in a window, best first — the ranked list under the board. */
export function topCalls(groupId: string | undefined, days: number, limit = 10): CallRank[] {
  const cutoff = Date.now() - days * 86_400_000;
  return db.calls
    .filter((c) => c.at >= cutoff && c.exitMult != null && (groupId ? c.groupId === groupId : c.scored))
    .sort((a, b) => b.exitMult! - a.exitMult!)
    .slice(0, limit)
    .map((c) => ({ symbol: c.symbol, mint: c.mint, callerName: c.callerName, callerId: c.callerId, mult: c.exitMult!, at: c.at }));
}

export interface WindowStats {
  calls: number;
  graded: number;
  hit2x: number;
  median: number;
  avgProfit: number;
  best: number | null;
}

export function windowStats(groupId: string | undefined, days: number): WindowStats {
  const cutoff = Date.now() - days * 86_400_000;
  const inWin = db.calls.filter((c) => c.at >= cutoff && (groupId ? c.groupId === groupId : c.scored));
  const graded = inWin.filter((c) => c.exitMult != null).map((c) => c.exitMult!);
  const capped = graded.map((m) => Math.min(m, cfg.tgMaxCreditMult));
  return {
    calls: inWin.length,
    graded: graded.length,
    hit2x: graded.length ? (graded.filter((m) => m >= 2).length / graded.length) * 100 : 0,
    median: median(graded),
    avgProfit: capped.length ? capped.reduce((a, b) => a + b, 0) / capped.length - 1 : 0,
    best: graded.length ? Math.max(...graded) : null,
  };
}

/**
 * Undo a call. The magnifying-glass button turns a card back into a lookup, so
 * someone can check a coin without it counting against their record — but only
 * inside the grace window, or it becomes a free "delete the ones that rugged".
 * If it was the global first call, the mint is released so the next caller can
 * claim it honestly.
 */
export function unrecordCall(mint: string, callerId: string, groupId: string, graceMs: number): boolean {
  const i = db.calls.findIndex((c) => c.mint === mint && c.callerId === callerId && c.groupId === groupId);
  if (i < 0) return false;
  if (Date.now() - db.calls[i].at > graceMs) return false;
  const wasFirst = db.calls[i].scored && db.firstBy[mint]?.callerId === callerId;
  db.calls.splice(i, 1);
  if (wasFirst) {
    delete db.firstBy[mint];
    // promote the earliest surviving call on this mint, if any
    const next = db.calls.filter((c) => c.mint === mint).sort((a, b) => a.at - b.at)[0];
    if (next) {
      next.scored = true;
      db.firstBy[mint] = { callerId: next.callerId, at: next.at, callerName: next.callerName };
    }
  }
  dirty = true;
  save();
  return true;
}
