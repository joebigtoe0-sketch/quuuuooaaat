import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { cfg } from "../config.js";
import { log } from "../log.js";
import { loadWallet, solBalance } from "./wallet.js";
import { executeBuy, executeSell, getTokenBalanceRaw, getTokenState, estimateSellSolFor } from "./pump.js";

/**
 * The trading arm — Quant buys tokens it likes and may sell THOSE (its own
 * token is unsellable at the pump.ts level). The agent PROPOSES trades; every
 * rail here is code:
 *   - TRADE_DRY_RUN default true (paper positions, real prices)
 *   - per-trade cap, per-day cap, max open positions
 *   - buys must come through the analysis engine (enforced by the action layer)
 *   - the buyback float and gas float are untouchable
 */
export interface Position {
  mint: string;
  symbol: string;
  thesis: string;
  strategyId?: string; // which of his playbooks made this trade
  soldSol?: number; // cumulative proceeds across partial exits
  costSol: number;
  tokensRaw: string; // bigint as string
  openedAt: number;
  dry: boolean;
  entryMcSol: number | null;
  closed?: { at: number; solReceived: number; reason: string };
}

const FILE = path.join(cfg.dataDir, "positions.json");
let positions: Position[] = [];
try {
  positions = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch {}
function save(): void {
  try {
    fs.writeFileSync(FILE + ".tmp", JSON.stringify(positions, null, 1));
    fs.renameSync(FILE + ".tmp", FILE);
  } catch {}
}

const dayKey = () => `tradesol:${new Date().toISOString().slice(0, 10)}`;
import { store } from "../store.js";
const spentToday = () => Number(store.kvGet(dayKey()) ?? 0);

/** Paper-trading bankroll: starts at PAPER_START_SOL (1 SOL), buys deduct,
 *  sells credit. THIS is the budget the agent plays with while in dry run. */
export function paperBank(): number {
  const v = store.kvGet("paper:bank");
  return v === undefined ? cfg.paperStartSol : Number(v);
}
function paperAdjust(delta: number): void {
  store.kvSet("paper:bank", String(Math.max(0, paperBank() + delta)));
}
/** The spendable trading bankroll: the paper ledger while TRADE_DRY_RUN, the
 * real war chest (balance − float − reserve) once trading is live. */
export async function bankSol(): Promise<number> {
  if (cfg.tradeDryRun) return paperBank();
  const { unallocatedSol } = await import("./buyback.js");
  return unallocatedSol().catch(() => 0);
}

export function openPositions(): Position[] {
  return positions.filter((p) => !p.closed);
}
export function allPositions(): Position[] {
  return positions;
}

export async function tradableFloat(): Promise<number> {
  const bal = await solBalance();
  return Math.max(0, bal - cfg.floatSol - cfg.tradeReserveSol * 0); // reserve handled in buyback
}

export async function tradeBuy(
  mint: string,
  symbol: string,
  sol: number,
  thesis: string,
  entryMcSol: number | null,
  strategyId?: string,
): Promise<{ ok: boolean; dry: boolean; sig?: string; why?: string }> {
  if (openPositions().length >= cfg.maxOpenPositions) return { ok: false, dry: false, why: "max positions" };
  if (sol > cfg.maxTradeSol) sol = cfg.maxTradeSol;
  if (spentToday() + sol > cfg.maxDailyTradeSol) return { ok: false, dry: false, why: "daily trade cap" };
  if (openPositions().some((p) => p.mint === mint)) return { ok: false, dry: false, why: "already holding" };

  if (cfg.tradeDryRun) {
    if (paperBank() < sol) return { ok: false, dry: true, why: `paper bankroll too low (${paperBank().toFixed(3)} SOL)` };
    // paper fill at live price
    let tokensRaw = "0";
    try {
      const st = await getTokenState(new PublicKey(mint));
      if (st.kind === "curve" || st.kind === "amm") {
        tokensRaw = String(BigInt(Math.round((sol / st.priceSol) * 1e6)));
      }
    } catch {}
    positions.push({ mint, symbol, thesis, strategyId, costSol: sol, tokensRaw, openedAt: Date.now(), dry: true, entryMcSol });
    save();
    paperAdjust(-sol);
    store.kvSet(dayKey(), String(spentToday() + sol));
    log.info("trade", `[DRY] bought ${symbol} for ${sol} SOL (bankroll ${paperBank().toFixed(3)})`);
    return { ok: true, dry: true };
  }

  const payer = loadWallet();
  if (!payer) return { ok: false, dry: false, why: "no wallet" };
  const bal = await solBalance();
  if (bal - sol < cfg.floatSol) return { ok: false, dry: false, why: "would breach float" };
  try {
    const res = await executeBuy(payer, new PublicKey(mint), sol);
    const tokensRaw = await getTokenBalanceRaw(new PublicKey(mint), payer.publicKey);
    positions.push({
      mint,
      symbol,
      thesis,
      strategyId,
      costSol: sol,
      tokensRaw: tokensRaw.toString(),
      openedAt: Date.now(),
      dry: false,
      entryMcSol: res.mcSol,
    });
    save();
    store.kvSet(dayKey(), String(spentToday() + sol));
    log.info("trade", `bought ${symbol} for ${sol} SOL — ${res.sig}`);
    return { ok: true, dry: false, sig: res.sig };
  } catch (e) {
    return { ok: false, dry: false, why: String(e).slice(0, 120) };
  }
}

export async function tradeSell(
  mint: string,
  fraction: number,
  reason: string,
): Promise<{ ok: boolean; dry: boolean; solReceived?: number; why?: string }> {
  if (cfg.ownMint && mint === cfg.ownMint) return { ok: false, dry: false, why: "own token is never sold" };
  const pos = openPositions().find((p) => p.mint === mint);
  if (!pos) return { ok: false, dry: false, why: "no such position" };
  fraction = Math.min(1, Math.max(0.1, fraction));

  const sellRaw = (BigInt(pos.tokensRaw) * BigInt(Math.round(fraction * 100))) / 100n;
  if (pos.dry || cfg.tradeDryRun) {
    let solReceived = 0;
    try {
      solReceived = await estimateSellSolFor(new PublicKey(mint), sellRaw);
    } catch {}
    pos.soldSol = (pos.soldSol ?? 0) + solReceived;
    if (sellRaw >= BigInt(pos.tokensRaw)) {
      // close by AMOUNT sold, not requested fraction (rounding sells 100%)
      pos.closed = { at: Date.now(), solReceived, reason: reason + " (dry)" };
      if (pos.strategyId) void import("../agent/strategies.js").then((m) => m.noteStrategyClose(pos.strategyId!, pos.soldSol! - pos.costSol));
    } else pos.tokensRaw = (BigInt(pos.tokensRaw) - sellRaw).toString();
    save();
    paperAdjust(solReceived);
    log.info("trade", `[DRY] sold ${Math.round(fraction * 100)}% of ${pos.symbol} ≈ ${solReceived.toFixed(4)} SOL (bankroll ${paperBank().toFixed(3)})`);
    return { ok: true, dry: true, solReceived };
  }

  const payer = loadWallet();
  if (!payer) return { ok: false, dry: false, why: "no wallet" };
  try {
    const res = await executeSell(payer, new PublicKey(mint), sellRaw);
    pos.soldSol = (pos.soldSol ?? 0) + res.solReceived;
    if (sellRaw >= BigInt(pos.tokensRaw)) {
      pos.closed = { at: Date.now(), solReceived: res.solReceived, reason };
      if (pos.strategyId) void import("../agent/strategies.js").then((m) => m.noteStrategyClose(pos.strategyId!, pos.soldSol! - pos.costSol));
    } else pos.tokensRaw = (BigInt(pos.tokensRaw) - sellRaw).toString();
    save();
    log.info("trade", `sold ${Math.round(fraction * 100)}% of ${pos.symbol} → ${res.solReceived.toFixed(4)} SOL — ${res.sig}`);
    return { ok: true, dry: false, solReceived: res.solReceived };
  } catch (e) {
    return { ok: false, dry: false, why: String(e).slice(0, 120) };
  }
}

export async function positionsSummary(): Promise<{
  open: number;
  realizedSol: number;
  unrealizedSol: number;
  lines: string[];
}> {
  const open = openPositions();
  let unrealized = 0;
  const lines: string[] = [];
  for (const p of open) {
    let nowSol = 0;
    try {
      nowSol = await estimateSellSolFor(new PublicKey(p.mint), BigInt(p.tokensRaw));
    } catch {}
    unrealized += nowSol - p.costSol;
    lines.push(
      `$${p.symbol} mint=${p.mint}: cost ${p.costSol.toFixed(3)}, now ~${nowSol.toFixed(3)} SOL (${nowSol >= p.costSol ? "+" : ""}${(((nowSol - p.costSol) / Math.max(p.costSol, 1e-9)) * 100).toFixed(0)}%)${p.dry ? " [dry]" : ""} — ${p.thesis.slice(0, 50)}`,
    );
  }
  const realized = positions
    .filter((p) => p.closed)
    .reduce((a, p) => a + ((p.soldSol ?? p.closed!.solReceived) - p.costSol), 0);
  return { open: open.length, realizedSol: realized, unrealizedSol: unrealized, lines };
}
