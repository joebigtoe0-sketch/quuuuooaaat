import fs from "node:fs";
import path from "node:path";
import { cfg } from "../config.js";
import { log } from "../log.js";
import { store } from "../store.js";
import { harvestMint, callerRep } from "./callers.js";

/**
 * CALLOUT DISCOVERY — the callout tape brings RIKU coins, instead of him only
 * grading coins he already found.
 *
 * The global callout firehose went auth-only (~2026-08-21), so discovery works
 * the way the pump.fun frontend itself does now: keep a rotating pool of
 * COINS WORTH SWEEPING (pump.fun volume board + dexscreener boosts), and read
 * each coin's public callout page (`/callout/top/{mint}` — no auth) through
 * the caller-intel harvester. Every sweep deposits callers into the
 * reputation index; a FRESH callout from a caller whose accumulated record
 * clears the bar (≥ CALLER_DISCOVERY_MIN_CALLS graded calls, avg ≥
 * CALLER_DISCOVERY_AVG peak) nominates the coin into RIKU's research queue.
 *
 * Discovery NOMINATES, it never buys: nominated coins run the full research
 * gauntlet (scoring, hard rejects, fake-chart tells) like any other pick.
 * Capped per day so the show isn't wall-to-wall caller-follow segments.
 */

const FRESH_MAX_AGE_MS = 90 * 60_000; // older than this = we're late, not early

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

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startCalloutDiscovery(
  onFind: (mint: string, why: string) => { ok: boolean; why?: string },
): void {
  if (!cfg.callerDiscovery || timer) return;

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
      const calls = await harvestMint(mint); // deposits reputation + tape as a side effect
      if (today() !== st.day) {
        st.day = today();
        st.dayCount = 0;
      }
      for (const c of calls) {
        // ---- nomination gate ----
        if (Date.now() - c.at > FRESH_MAX_AGE_MS) continue;
        if (st.dayCount >= cfg.callerDiscoveryMaxPerDay) break;
        if (st.discovered[mint]) break;
        if (cfg.ownMint && mint === cfg.ownMint) break;
        const seenAt = store.seenAt(mint);
        if (seenAt && Date.now() - seenAt < 86_400_000) break; // already on the show
        const rep = callerRep(c.wallet);
        if (!rep || rep.calls < cfg.callerDiscoveryMinCalls || rep.avg < cfg.callerDiscoveryAvg) continue;
        const { touchBan } = await import("../agent/tokenguard.js");
        if (touchBan(mint)) break;
        const who = c.username || rep.username || "a caller I track";
        const why =
          `caller intel: ${who} (${rep.avg.toFixed(1)}x avg peak over ${rep.calls} graded calls, best ${rep.best.toFixed(1)}x) ` +
          `just called this — worth my own read`;
        const res = onFind(mint, why);
        if (res.ok) {
          st.discovered[mint] = Date.now();
          st.dayCount++;
          saveState();
          log.info("discovery", `nominated ${mint.slice(0, 8)}… via ${who} (${rep.avg.toFixed(1)}x/${rep.calls}) — ${st.dayCount}/${cfg.callerDiscoveryMaxPerDay} today`);
        } else {
          log.info("discovery", `worth nominating but queue said no (${res.why ?? "full"}) — next sweep catches it`);
        }
        break; // one nomination per coin per sweep is plenty
      }
    } catch (e) {
      log.warn("discovery", `sweep failed: ${String(e).slice(0, 80)}`);
    }
  }, Math.max(45, cfg.callerDiscoveryS) * 1000);
  log.info("discovery", `callout discovery on — sweep every ${cfg.callerDiscoveryS}s, bar ${cfg.callerDiscoveryAvg}x avg over ≥${cfg.callerDiscoveryMinCalls} calls, max ${cfg.callerDiscoveryMaxPerDay}/day`);
}
