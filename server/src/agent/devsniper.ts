import { PublicKey } from "@solana/web3.js";
import { cfg } from "../config.js";
import { log } from "../log.js";
import { devHistory } from "../analysis/checks/creator.js";
import { getTokenState } from "../chain/pump.js";
import { getSolUsd } from "../chain/solana.js";
import { tradeBuy, openPositions } from "../chain/trader.js";
import { solBalance } from "../chain/wallet.js";
import { memory } from "./memory.js";
import type { ConveyorItem } from "../protocol.js";

/**
 * THE QUIET EDGE — instant entries on launches from PROVEN devs (the 130-dev
 * bond-record watchlist + the creator-stats archive) while the curve is still
 * under the mc ceiling. The buy fires silently the moment the launch hits the
 * feed; a couple of minutes later the director stages an ORGANIC-looking
 * launch-feed research that "discovers" the coin, scores it, reveals the
 * position, and calls it. The stream never hears the word sniper.
 *
 * Exits: 95% bonding progress (bank before migration) or maxHold hours.
 * All the usual rails still hold: desk book, daily caps, own-mint, dry-run.
 */

const STRAT_ID = "devsnipe";

interface DirectorHook {
  queueReveal(mint: string, sol: number): void;
  onAgentAction(qa: { action: { do: "trade_sell"; mint: string; fraction: number; reason: string }; plannedAt: number }): void;
}

let dir: DirectorHook | null = null;
const inflight = new Set<string>(); // mints being bought right now
const exiting = new Map<string, number>(); // mint -> ts sell was enqueued

export function armDevSniper(d: DirectorHook): void {
  dir = d;
  setInterval(() => void watchExits(), 60_000).unref?.();
  log.info("snipe", `dev-sniper armed (${cfg.devsnipeEnabled ? "ON" : "OFF"}): mc<$${cfg.devsnipeMaxMcUsd}, exit ${cfg.devsnipeExitProgress * 100}% / ${cfg.devsnipeMaxHoldH}h`);
}

/** Feed hook — called for every pumpportal launch. Fire fast, fail silent. */
export async function onSnipeLaunch(item: ConveyorItem): Promise<void> {
  try {
    if (!cfg.devsnipeEnabled || !dir) return;
    if (!item.dev || !item.mint.endsWith("pump")) return;
    if (cfg.ownMint && item.mint === cfg.ownMint) return;
    if (inflight.has(item.mint)) return;

    const d = devHistory(item.dev);
    const proven = d.onWatchlist || (d.launches >= cfg.devsnipeMinLaunches && d.bondRate >= cfg.devsnipeMinBondRate);
    if (!proven) return;
    if (openPositions().filter((p) => p.strategyId === STRAT_ID).length >= cfg.devsnipeMaxOpen) return;

    inflight.add(item.mint);
    // early enough = still under the ceiling when we can actually fill
    const st = await getTokenState(new PublicKey(item.mint));
    if (st.kind !== "curve" || st.mayhem) { inflight.delete(item.mint); return; }
    const solUsd = await getSolUsd().catch(() => 150);
    const mcUsd = st.mcSol * solUsd;
    if (mcUsd > cfg.devsnipeMaxMcUsd) { inflight.delete(item.mint); return; }

    // HIS book's sizing: 0.05 min .. 6% of wallet, conviction from the record
    const held = await solBalance().catch(() => 0);
    const minSol = 0.05;
    const maxSol = Math.max(minSol + 0.001, held * 0.06);
    const conviction = d.onWatchlist ? Math.min(1, 0.7 + d.bondRate * 0.3) : Math.min(1, d.bondRate);
    const jitter = 0.88 + Math.random() * 0.24;
    const sol = Math.round(Math.max(minSol, Math.min((minSol + conviction * (maxSol - minSol)) * jitter, maxSol, cfg.maxTradeSol)) * 1000) / 1000;

    const record = d.known ? `${d.bonds}/${d.launches} bonded` : "watchlist wallet";
    const res = await tradeBuy(
      item.mint,
      item.symbol,
      sol,
      `recognized the dev wallet at launch (${record}) — in under $${(mcUsd / 1000).toFixed(1)}k`,
      st.mcSol,
      STRAT_ID,
    );
    if (res.ok) {
      log.info("snipe", `IN: $${item.symbol} ${sol} SOL @ ~$${Math.round(mcUsd)} mc (${record})${res.dry ? " [dry]" : ""}`);
      memory.journal("trade", `${res.dry ? "[dry] " : ""}moved the second $${item.symbol} launched — I know this dev (${record}). ${sol} SOL at ~$${Math.round(mcUsd)} mc`);
      // the show catches up in a couple of minutes: an "organic" launch-feed
      // find, researched on stream, position revealed, called out
      setTimeout(() => dir?.queueReveal(item.mint, sol), cfg.devsnipeRevealDelayMs);
    } else {
      inflight.delete(item.mint);
      log.info("snipe", `pass on $${item.symbol}: ${res.why}`);
    }
  } catch (e) {
    inflight.delete(item.mint);
    log.warn("snipe", `launch check failed: ${String(e).slice(0, 120)}`);
  }
}

/** Exit discipline: 95% bonding (bank before migration) or the clock. */
async function watchExits(): Promise<void> {
  if (!dir) return;
  for (const [m, at] of exiting) if (Date.now() - at > 10 * 60_000) exiting.delete(m);
  for (const p of openPositions()) {
    if (p.strategyId !== STRAT_ID || exiting.has(p.mint)) continue;
    const ageH = (Date.now() - p.openedAt) / 3_600_000;
    let reason: string | null = null;
    if (ageH >= cfg.devsnipeMaxHoldH) {
      reason = `held ${Math.round(ageH)}h and the move never came — recycling the capital`;
    } else {
      const st = await getTokenState(new PublicKey(p.mint)).catch(() => null);
      if (st && st.kind === "curve" && st.progress >= cfg.devsnipeExitProgress) {
        reason = "curve is about to graduate — banking the ride before the pool migrates";
      } else if (st && st.kind === "amm") {
        reason = "it graduated on me — taking the win off the table";
      }
    }
    if (reason) {
      exiting.set(p.mint, Date.now());
      dir.onAgentAction({ action: { do: "trade_sell", mint: p.mint, fraction: 1, reason }, plannedAt: Date.now() });
      log.info("snipe", `EXIT queued: $${p.symbol} — ${reason}`);
    }
  }
}
