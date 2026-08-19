import { cfg } from "../config.js";
import { store } from "../store.js";
import { allPositions } from "../chain/trader.js";

/**
 * THE DESK BOOK — the one memory every gate consults before touching a mint.
 * Two layers:
 *   1. the permanent blacklist (scam/rug/operator-flagged) — forever
 *   2. the exit ledger — a coin he already bought and sold is off the menu
 *      for cfg.rebuyCooldownH hours (closed positions in trader's ledger)
 * Research pickers, the buy gauntlet, callouts and the gift inbox all call
 * touchBan(); one memory, no per-path drift.
 */

export interface ExitRecord {
  at: number;
  pnlSol: number;
  reason: string;
}

/** Most recent close of this mint in the positions ledger, if any. */
export function lastExit(mint: string): ExitRecord | null {
  let best: ExitRecord | null = null;
  for (const p of allPositions()) {
    if (p.mint !== mint || !p.closed) continue;
    if (!best || p.closed.at > best.at) {
      best = { at: p.closed.at, pnlSol: (p.soldSol ?? 0) - p.costSol, reason: p.closed.reason ?? "" };
    }
  }
  return best;
}

/** Human-readable reason the desk must not touch this mint right now, or null. */
export function touchBan(mint: string): string | null {
  const bl = store.blacklistGet(mint);
  if (bl) return `blacklisted (${bl.by}): ${bl.reason}`;
  const ex = lastExit(mint);
  if (ex) {
    const ageH = (Date.now() - ex.at) / 3_600_000;
    if (ageH < cfg.rebuyCooldownH) {
      const pnl = ex.pnlSol >= 0 ? `+${ex.pnlSol.toFixed(3)}` : ex.pnlSol.toFixed(3);
      return `already played it — exited ${Math.round(ageH)}h ago (${pnl} SOL, "${ex.reason.slice(0, 60)}")`;
    }
  }
  return null;
}

/** Auto-blacklist on exits that smell like fraud — a scam exit is forever. */
const SCAMMY = /scam|rug|honeypot|fraud|drain|stole|dump.?er|blacklis/i;
export function noteExitReason(mint: string, symbol: string, reason: string): void {
  if (SCAMMY.test(reason)) {
    store.blacklistAdd(mint, `sold $${symbol}: ${reason.slice(0, 100)}`, "exit");
  }
}
