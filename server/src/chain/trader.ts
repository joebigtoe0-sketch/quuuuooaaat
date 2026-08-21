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

/**
 * RECONCILE THE LEDGER AGAINST THE CHAIN.
 *
 * A position stays "open" in the ledger until a sell records against it, so any
 * exit that landed on-chain without being written back leaves a ghost — and the
 * exit watchers then queue sells forever for tokens he no longer owns ("EXIT
 * queued: $VOLUME — held 37h", when $VOLUME left the wallet a day ago).
 *
 * The wallet is the truth. Anything the wallet doesn't hold gets closed.
 */
export async function reconcilePositions(): Promise<number> {
  if (cfg.tradeDryRun) return 0; // paper positions have no on-chain balance
  const wallet = loadWallet();
  if (!wallet) return 0;
  let closed = 0;
  for (const p of openPositions()) {
    try {
      // TICKERS TOO: operator calls once stored mint.slice(0,6) as the symbol,
      // so positions read "$J8PSdN" where the coin is "$TripleT". pump.fun
      // knows the real one — repair it here and teach the cashtag dictionary.
      try {
        const { marketCap } = await import("./marketcap.js");
        const mc = await marketCap(p.mint);
        if (mc.symbol && mc.symbol !== p.symbol && p.mint.startsWith(p.symbol)) {
          log.info("trade", `symbol fixed: $${p.symbol} → $${mc.symbol}`);
          p.symbol = mc.symbol;
          save();
        }
        if (mc.name && mc.symbol) store.noteToken(mc.name, mc.symbol);
      } catch { /* leave the label alone */ }
      const bal = await getTokenBalanceRaw(new PublicKey(p.mint), wallet.publicKey);
      // dust: below 1 whole token (6dp) it can't be sold and isn't a position
      if (bal >= 1_000_000n) continue;
      p.tokensRaw = "0";
      p.closed = {
        at: Date.now(),
        solReceived: p.soldSol ?? 0,
        reason: "no longer in the wallet — ledger reconciled to chain",
      };
      closed++;
      log.info("trade", `reconciled: $${p.symbol} closed — wallet holds none`);
    } catch { /* RPC hiccup: leave it open, next pass tries again */ }
  }
  if (closed) save();
  return closed;
}
/** Gross SOL bought today vs the daily cap — for /health diagnostics. */
export function tradeSpentToday(): { spent: number; cap: number } {
  return { spent: spentToday(), cap: cfg.maxDailyTradeSol };
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
  // every rejection is recorded — a silently starving desk is undebuggable
  const block = (why: string): { ok: false; dry: false; why: string } => {
    store.kvSet("trade:lastblock", JSON.stringify({ at: Date.now(), mint: mint.slice(0, 8), symbol, sol, why }));
    return { ok: false, dry: false, why };
  };
  // launch snipes and operator calls have their OWN slot caps and must never
  // be starved by stale research positions hogging the global cap
  const capExempt = strategyId === "devsnipe" || strategyId === "opcall";
  if (!capExempt && openPositions().length >= cfg.maxOpenPositions) return block("max positions");
  // MAX_TRADE_SOL bounds what the AGENT may risk on its own. An operator call
  // (opcall / long-term hold) is an explicit instruction and sizes itself.
  const operatorSized = strategyId === "opcall" || strategyId === HOLD_STRATEGY;
  if (!operatorSized && sol > cfg.maxTradeSol) sol = cfg.maxTradeSol;
  if (!operatorSized && spentToday() + sol > cfg.maxDailyTradeSol)
    return block(`daily trade cap (${spentToday().toFixed(2)}/${cfg.maxDailyTradeSol} SOL spent)`);
  if (openPositions().some((p) => p.mint === mint)) return block("already holding");
  {
    // THE DESK BOOK — last rail before SOL moves: blacklisted or recently
    // exited mints never get re-bought, no matter which path proposed it.
    const { touchBan } = await import("../agent/tokenguard.js");
    const ban = touchBan(mint);
    if (ban) return block(ban);
  }

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
    void import("../desk/records.js").then((m) => m.recordDecision({
      kind: "buy", mint, symbol, entryMcUsd: null, sizeSol: sol,
      tier: null, score: null, hardReject: null, reason: thesis.slice(0, 200), checks: [], dry: true,
    }));
    return { ok: true, dry: true };
  }

  const payer = loadWallet();
  if (!payer) return { ok: false, dry: false, why: "no wallet" };
  const bal = await solBalance();
  if (bal - sol < cfg.floatSol) return { ok: false, dry: false, why: "would breach float" };
  // DECISION RECORD, opened (and hash-committed on-chain) BEFORE the buy —
  // the commitment must predate the fill or it proves nothing
  const { openDecision, sealDecision } = await import("../desk/records.js");
  const rec = await openDecision({
    kind: "buy", mint, symbol, entryMcUsd: null, sizeSol: sol,
    tier: null, score: null, hardReject: null, reason: thesis.slice(0, 200), checks: [], dry: false,
  });
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
    sealDecision(rec, { txSig: res.sig });
    return { ok: true, dry: false, sig: res.sig };
  } catch (e) {
    sealDecision(rec, { txSig: null }); // committed but unfilled — honesty includes the misses
    return { ok: false, dry: false, why: String(e).slice(0, 120) };
  }
}

/** Long-term conviction holds: bought only on an operator call, and RIKU can
 *  never sell them himself — only an operator-initiated sell may close one. */
export const HOLD_STRATEGY = "hold";
export function isHoldPosition(mint: string): boolean {
  return openPositions().some((p) => p.mint === mint && p.strategyId === HOLD_STRATEGY);
}

export async function tradeSell(
  mint: string,
  fraction: number,
  reason: string,
  operator = false,
): Promise<{ ok: boolean; dry: boolean; solReceived?: number; why?: string }> {
  if (cfg.ownMint && mint === cfg.ownMint) return { ok: false, dry: false, why: "own token is never sold" };
  const pos = openPositions().find((p) => p.mint === mint);
  if (!pos) return { ok: false, dry: false, why: "no such position" };
  // the conviction rail: a long-term hold only closes when the desk says so
  if (pos.strategyId === HOLD_STRATEGY && !operator)
    return { ok: false, dry: false, why: "long-term conviction hold — not sold on impulse" };
  // a ghost position: the ledger says he holds it, the wallet disagrees. Close
  // it here rather than failing this sell and every future one.
  if (!cfg.tradeDryRun) {
    const w = loadWallet();
    if (w) {
      try {
        const bal = await getTokenBalanceRaw(new PublicKey(mint), w.publicKey);
        if (bal < 1_000_000n) {
          pos.tokensRaw = "0";
          pos.closed = { at: Date.now(), solReceived: pos.soldSol ?? 0, reason: "no longer in the wallet — ledger reconciled to chain" };
          save();
          log.info("trade", `reconciled on sell: $${pos.symbol} — wallet holds none`);
          return { ok: false, dry: false, why: "position already gone from the wallet — ledger closed" };
        }
      } catch { /* RPC hiccup — fall through and let the sell try */ }
    }
  }
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
    void import("../desk/records.js").then((m) => m.recordDecision({
      kind: "sell", mint, symbol: pos.symbol, entryMcUsd: null, sizeSol: null,
      tier: null, score: null, hardReject: null,
      reason: `${Math.round(fraction * 100)}%: ${reason}`.slice(0, 200), checks: [], dry: true,
    }));
    return { ok: true, dry: true, solReceived };
  }

  const payer = loadWallet();
  if (!payer) return { ok: false, dry: false, why: "no wallet" };
  const { openDecision, sealDecision } = await import("../desk/records.js");
  const rec = await openDecision({
    kind: "sell", mint, symbol: pos.symbol, entryMcUsd: null, sizeSol: null,
    tier: null, score: null, hardReject: null,
    reason: `${Math.round(fraction * 100)}%: ${reason}`.slice(0, 200), checks: [], dry: false,
  });
  try {
    const res = await executeSell(payer, new PublicKey(mint), sellRaw);
    sealDecision(rec, { txSig: res.sig });
    pos.soldSol = (pos.soldSol ?? 0) + res.solReceived;
    if (sellRaw >= BigInt(pos.tokensRaw)) {
      pos.closed = { at: Date.now(), solReceived: res.solReceived, reason };
      if (pos.strategyId) void import("../agent/strategies.js").then((m) => m.noteStrategyClose(pos.strategyId!, pos.soldSol! - pos.costSol));
    } else pos.tokensRaw = (BigInt(pos.tokensRaw) - sellRaw).toString();
    save();
    log.info("trade", `sold ${Math.round(fraction * 100)}% of ${pos.symbol} → ${res.solReceived.toFixed(4)} SOL — ${res.sig}`);
    return { ok: true, dry: false, solReceived: res.solReceived };
  } catch (e) {
    sealDecision(rec, { txSig: null });
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
