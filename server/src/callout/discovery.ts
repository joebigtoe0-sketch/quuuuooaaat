import fs from "node:fs";
import path from "node:path";
import { cfg } from "../config.js";
import { log } from "../log.js";
import { store } from "../store.js";
import { harvestMint, callerRep, callerPnl, parseAlertItem, persistIntel, type HarvestedCall } from "./callers.js";

/**
 * CALLOUT DISCOVERY — the callout tape brings RIKU coins, instead of him only
 * grading coins he already found. One of SEVERAL discovery feeds (gifted
 * inbox, conveyor, scouts…) — this is the caller-driven one.
 *
 * Two speeds:
 *
 *  FAST — the global /callout/recent feed, polled every ~20s. It went
 *  cookie-only (~2026-08-21), so this path only runs when PUMP_COOKIE is set
 *  (any pump.fun browser session's cookie header). Latency from "proven
 *  caller posts a call" to "nomination" is seconds — which matters, because
 *  calls peak in minutes.
 *
 *  SLOW — sweep the callout pages of trending coins (pump.fun volume board +
 *  dexscreener boosts) one coin per tick via the public /callout/top route.
 *  No cookie needed. Catches what the fast feed misses and keeps the
 *  reputation index growing even with no cookie configured.
 *
 * Every observed callout lands in the per-call rows store (calls.json) —
 * entry price, peak, time-to-peak, mc at call — which is both the reputation
 * source and the backtest dataset for the caller-follow tactic.
 *
 * Discovery NOMINATES research, it never buys. Nominated coins run the full
 * gauntlet (scoring, hard rejects, fake-chart tells) like any other pick.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const SWEEP_FRESH_MS = 90 * 60_000; // slow path: anything younger than this is still worth a look
const FAST_FRESH_MS = 10 * 60_000; // fast path: the feed delivers in seconds; older = something's off

interface DiscoveryState {
  discovered: Record<string, number>; // mint -> at (never re-nominate)
  day: string;
  dayCount: number;
}
const FILE = () => path.join(cfg.dataDir, "discovery.json");
let st: DiscoveryState = { discovered: {}, day: "", dayCount: 0 };
try {
  const j = JSON.parse(fs.readFileSync(FILE(), "utf8"));
  if (j?.discovered) st = { discovered: j.discovered, day: j.day ?? "", dayCount: j.dayCount ?? 0 };
} catch { /* first run */ }
function saveState(): void {
  try {
    fs.writeFileSync(FILE(), JSON.stringify(st));
  } catch {}
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

type OnFind = (mint: string, why: string) => { ok: boolean; why?: string };

/** The nomination gate, shared by both speeds. Returns true if nominated.
 *  `skin` (the caller's own position on the coin): pass it when the feed
 *  already delivered it; leave undefined to fetch from the public PnL route. */
async function tryNominate(
  c: HarvestedCall,
  onFind: OnFind,
  freshMs: number,
  source: string,
  skinIn?: { costUsd: number; pnlPct: number | null } | null,
): Promise<boolean> {
  if (Date.now() - c.at > freshMs) return false;
  if (today() !== st.day) {
    st.day = today();
    st.dayCount = 0;
  }
  if (st.dayCount >= cfg.callerDiscoveryMaxPerDay) return false;
  if (st.discovered[c.mint]) return false;
  if (cfg.ownMint && c.mint === cfg.ownMint) return false;
  const seenAt = store.seenAt(c.mint);
  if (seenAt && Date.now() - seenAt < 86_400_000) return false; // already on the show
  const rep = callerRep(c.wallet);
  if (!rep || rep.calls < cfg.callerDiscoveryMinCalls || rep.avg < cfg.callerDiscoveryAvg) return false;
  const { touchBan } = await import("../agent/tokenguard.js");
  if (touchBan(c.mint)) return false;
  const who = c.username || rep.username || "a caller I track";
  const mcNote = c.mcAtCall > 0 ? ` at $${Math.round(c.mcAtCall).toLocaleString("en-US")} mc` : "";
  // skin check: is the caller actually positioned in what they're calling?
  const skin =
    skinIn !== undefined
      ? skinIn
      : await Promise.race([
          callerPnl(c.wallet, c.mint).then((p) => (p ? { costUsd: p.costUsd, pnlPct: p.pct } : null)),
          new Promise<null>((r) => setTimeout(() => r(null), 2500)),
        ]);
  const skinNote =
    skin == null
      ? "" // unknown ≠ not holding
      : skin.costUsd > 5
        ? ` — and they're holding it themselves ($${Math.round(skin.costUsd)} cost basis)`
        : " — calling it without holding it, noted";
  const why =
    `caller intel: ${who} (${rep.avg.toFixed(1)}x avg peak over ${rep.calls} graded calls, best ${rep.best.toFixed(1)}x) ` +
    `just called this${mcNote}${skinNote} — worth my own read`;
  const res = onFind(c.mint, why);
  if (res.ok) {
    st.discovered[c.mint] = Date.now();
    st.dayCount++;
    saveState();
    log.info("discovery", `[${source}] nominated ${c.mint.slice(0, 8)}… via ${who} (${rep.avg.toFixed(1)}x/${rep.calls}) — ${st.dayCount}/${cfg.callerDiscoveryMaxPerDay} today`);
    return true;
  }
  log.info("discovery", `[${source}] worth nominating but queue said no (${res.why ?? "full"})`);
  return false;
}

/** Coins currently worth sweeping for callouts: pump.fun's volume board plus
 *  dexscreener-boosted pump coins. Either source may be empty (pump.fun's
 *  coin list is Cloudflare-moody server-side) — the union usually isn't. */
async function sweepCandidates(): Promise<string[]> {
  const mints: string[] = [];
  try {
    const { scoutPumpTrending, scoutDexscreener } = await import("../social/scout.js");
    const [pump, dex] = await Promise.all([
      scoutPumpTrending().catch(() => []),
      scoutDexscreener().catch(() => []),
    ]);
    for (const h of [...pump, ...dex]) {
      if (h.mint && h.mint.endsWith("pump") && !mints.includes(h.mint)) mints.push(h.mint);
    }
  } catch (e) {
    log.warn("discovery", `candidate fetch failed: ${String(e).slice(0, 80)}`);
  }
  return mints.slice(0, 24);
}

// ---------- FAST: the cookie-gated FOLLOW feed ----------
// `/following-positions/alerts?kinds=callout` — real-time callouts from every
// account the cookie's user FOLLOWS, each item carrying pump.fun's own
// grading (maxMultiplier), the mc at call, the thesis, AND the author's live
// position on the coin. Coverage = the follow list: follow the graded top
// callers (calloutfollow tooling) and this becomes a curated alpha feed.
const FEED_ALERTS = "https://frontend-api-v3.pump.fun/following-positions/alerts";
let fastTimer: ReturnType<typeof setInterval> | null = null;

function startFastFeed(onFind: OnFind): void {
  const cookie = (process.env.PUMP_COOKIE ?? "").trim();
  if (!cookie) {
    log.info("discovery", "PUMP_COOKIE not set — live follow-feed off, trending sweep only (nominations will lag calls by up to ~45 min)");
    return;
  }
  let disabled = false;
  let failStreak = 0;
  fastTimer = setInterval(async () => {
    if (disabled) return;
    try {
      const res = await fetch(`${FEED_ALERTS}?pageSize=50&kinds=callout`, {
        headers: {
          "user-agent": UA,
          origin: "https://pump.fun",
          accept: "*/*",
          "content-type": "application/json",
          cookie,
        },
      });
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        disabled = true;
        log.warn("discovery", `follow feed rejected the cookie (${res.status}) — refresh PUMP_COOKIE and restart; falling back to trending sweep`);
        return;
      }
      if (!res.ok) throw new Error(`alerts ${res.status}`);
      const j: any = await res.json();
      const items: any[] = j?.items ?? [];
      failStreak = 0;
      for (const it of items) {
        const c = parseAlertItem(it);
        if (!c) continue;
        await tryNominate(c, onFind, FAST_FRESH_MS, "follow-feed", c.skin);
      }
      if (items.length) persistIntel();
    } catch (e) {
      if (++failStreak === 5) log.warn("discovery", `follow feed failing repeatedly: ${String(e).slice(0, 80)}`);
    }
  }, 20_000);
  log.info("discovery", "live follow-feed ON — polling followed callers' callouts every 20s (call → nomination in seconds)");
}

// ---------- SLOW: the trending sweep ----------
let timer: ReturnType<typeof setInterval> | null = null;

export function startCalloutDiscovery(onFind: OnFind): void {
  if (!cfg.callerDiscovery || timer) return;

  startFastFeed(onFind);

  let pool: string[] = [];
  let cursor = 0;
  let poolAt = 0;

  timer = setInterval(async () => {
    try {
      // refresh the sweep pool every ~10 min; walk it one coin per tick
      if (Date.now() - poolAt > 10 * 60_000 || cursor >= pool.length) {
        const next = await sweepCandidates();
        if (next.length) {
          pool = next;
          cursor = 0;
          poolAt = Date.now();
          log.info("discovery", `sweep pool refreshed — ${pool.length} trending coins`);
        }
      }
      if (!pool.length) {
        log.warn("discovery", "sweep pool empty — both trending sources returned nothing");
        return;
      }
      const mint = pool[cursor++ % pool.length];
      const calls = await harvestMint(mint); // deposits rows + tape as a side effect
      for (const c of calls) {
        if (await tryNominate(c, onFind, SWEEP_FRESH_MS, "sweep")) break; // one per coin per sweep
      }
    } catch (e) {
      log.warn("discovery", `sweep failed: ${String(e).slice(0, 80)}`);
    }
  }, Math.max(45, cfg.callerDiscoveryS) * 1000);
  log.info("discovery", `callout discovery on — sweep every ${cfg.callerDiscoveryS}s, bar ${cfg.callerDiscoveryAvg}x avg over ≥${cfg.callerDiscoveryMinCalls} calls, max ${cfg.callerDiscoveryMaxPerDay}/day`);
}
