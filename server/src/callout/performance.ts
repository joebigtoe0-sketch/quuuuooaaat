import { log } from "../log.js";
import { store } from "../store.js";
import { getSolUsd } from "../chain/solana.js";

/**
 * CALLOUT TRACK RECORD — what he called, where it was, how far it ran.
 *
 * pump.fun's own callout history reads "MOOT 7x — $17.0K → $113K MC", i.e.
 * ENTRY market cap vs the PEAK it reached afterwards. We can rebuild exactly
 * that: the entry mc is recorded when the call posts, and the coin API hands
 * back `ath_market_cap` (USD) plus the live `usd_market_cap`.
 *
 * Units are a trap here: `market_cap` is SOL while `usd_market_cap` and
 * `ath_market_cap` are USD. Everything below works in USD.
 */
export interface CallPerf {
  mint: string;
  symbol: string;
  at: number;
  tier: string;
  entryMcUsd: number | null;
  nowMcUsd: number | null;
  peakMcUsd: number | null;
  multiplier: number | null; // peak / entry — the number pump.fun shows
  nowMultiplier: number | null; // live / entry
  dry: boolean;
}

const CACHE_KEY = "callout:perf";
const TTL_MS = 5 * 60_000;
let cache: { at: number; rows: CallPerf[] } = { at: 0, rows: [] };
try {
  const raw = store.kvGet(CACHE_KEY);
  if (raw) cache = JSON.parse(raw);
} catch { /* fresh */ }

async function coinMc(mint: string): Promise<{ nowUsd: number | null; peakUsd: number | null }> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
      signal: controller.signal,
      headers: { accept: "application/json", origin: "https://pump.fun" },
    });
    clearTimeout(t);
    if (!res.ok) return { nowUsd: null, peakUsd: null };
    const j: any = await res.json();
    return {
      nowUsd: typeof j.usd_market_cap === "number" ? j.usd_market_cap : null,
      peakUsd: typeof j.ath_market_cap === "number" ? j.ath_market_cap : null,
    };
  } catch {
    return { nowUsd: null, peakUsd: null };
  }
}

/** Rebuild the record. Throttled: at most one refresh per TTL. */
export async function refreshPerformance(force = false): Promise<CallPerf[]> {
  if (!force && Date.now() - cache.at < TTL_MS && cache.rows.length) return cache.rows;
  const calls = store.callouts();
  if (!calls.length) return [];
  const solUsd = await getSolUsd().catch(() => 0);
  // newest first, and only one row per mint (the FIRST call is the real entry)
  const seen = new Set<string>();
  const unique = [...calls].sort((a, b) => a.at - b.at).filter((c) => (seen.has(c.mint) ? false : (seen.add(c.mint), true)));
  const rows: CallPerf[] = [];
  for (const c of unique.slice(-120)) {
    const prev = cache.rows.find((r) => r.mint === c.mint);
    // entry mc was stored in SOL; convert once using the live SOL price. Small
    // drift vs the price at call time, immaterial against a 2x-100x multiple.
    const entryMcUsd = c.entryMcSol != null && solUsd > 0 ? c.entryMcSol * solUsd : (prev?.entryMcUsd ?? null);
    const { nowUsd, peakUsd } = await coinMc(c.mint);
    // peak can only ever go UP — keep the best we've ever observed
    const peak = Math.max(peakUsd ?? 0, prev?.peakMcUsd ?? 0, nowUsd ?? 0) || null;
    rows.push({
      mint: c.mint,
      symbol: c.symbol,
      at: c.at,
      tier: c.tier,
      entryMcUsd,
      nowMcUsd: nowUsd ?? prev?.nowMcUsd ?? null,
      peakMcUsd: peak,
      multiplier: entryMcUsd && peak ? peak / entryMcUsd : null,
      nowMultiplier: entryMcUsd && nowUsd ? nowUsd / entryMcUsd : null,
      dry: c.dry,
    });
    await new Promise((r) => setTimeout(r, 120)); // be polite to the API
  }
  rows.sort((a, b) => b.at - a.at);
  cache = { at: Date.now(), rows };
  try { store.kvSet(CACHE_KEY, JSON.stringify(cache)); } catch {}
  log.info("callout", `performance rebuilt — ${rows.length} calls tracked`);
  return rows;
}

export type Range = "today" | "7d" | "30d" | "all";
const WINDOWS: Record<Range, number> = { today: 0, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, all: Infinity };

export function inRange(at: number, range: Range): boolean {
  if (range === "all") return true;
  if (range === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return at >= d.getTime();
  }
  return Date.now() - at <= WINDOWS[range];
}

/** The board: rows for a window plus the averages that headline it. */
export function board(rows: CallPerf[], range: Range) {
  const inWin = rows.filter((r) => inRange(r.at, range));
  const scored = inWin.filter((r) => r.multiplier != null);
  const avg = scored.length ? scored.reduce((s, r) => s + (r.multiplier ?? 0), 0) / scored.length : null;
  const avgNow = (() => {
    const n = inWin.filter((r) => r.nowMultiplier != null);
    return n.length ? n.reduce((s, r) => s + (r.nowMultiplier ?? 0), 0) / n.length : null;
  })();
  const best = scored.reduce<CallPerf | null>((b, r) => (!b || (r.multiplier ?? 0) > (b.multiplier ?? 0) ? r : b), null);
  return {
    range,
    calls: inWin.length,
    avgMultiplier: avg,
    avgNowMultiplier: avgNow,
    winners2x: scored.filter((r) => (r.multiplier ?? 0) >= 2).length,
    best: best ? { symbol: best.symbol, multiplier: best.multiplier, mint: best.mint } : null,
    rows: inWin.slice(0, 60),
  };
}
