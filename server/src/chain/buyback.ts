import { PublicKey } from "@solana/web3.js";
import { cfg } from "../config.js";
import { store } from "../store.js";
import { log } from "../log.js";
import { solBalance, loadWallet } from "./wallet.js";
import { executeBuy, getTokenBalanceRaw } from "./pump.js";

/**
 * The flywheel: whatever SOL lands in Quant's wallet above the operating float
 * (callout payouts, however pump.fun delivers them) becomes a buyback of
 * Quant's own token. Mechanism-agnostic by design — the payout claiming flow
 * is new and undocumented; if claiming turns out to be manual, the user claims
 * in the browser and the stream reacts within one poll.
 *
 * Rails: never touch the float, per-tx and per-day caps, own-mint must be
 * tradeable, every buy ledgered.
 */
export interface PendingBuyback {
  sol: number;
}

/** SOL earned and not yet allocated: wallet balance above float + trading
 *  reserve. This is the pool the AGENT splits between buybacks and trading. */
export async function unallocatedSol(): Promise<number> {
  if (cfg.simMode) return Number(store.kvGet("sim:earnSol") ?? 0);
  if (!loadWallet()) return 0;
  try {
    const bal = await solBalance();
    return Math.max(0, Math.floor((bal - cfg.floatSol - cfg.tradeReserveSol) * 1e4) / 1e4);
  } catch {
    return 0;
  }
}

/** Rolling own-token market history so he can spot dips worth buying. */
export async function ownMcStats(): Promise<{ mcSol: number; high24Sol: number; drawdownPct: number } | null> {
  let mcSol = 0;
  if (cfg.simMode) {
    mcSol = Number(store.kvGet("sim:ownMc") ?? 0) / 150; // sim tracks USD; ~SOL at $150
  } else {
    if (!cfg.ownMint) return null;
    try {
      const { getTokenState } = await import("./pump.js");
      const st = await getTokenState(new PublicKey(cfg.ownMint));
      if (st.kind !== "curve" && st.kind !== "amm") return null;
      mcSol = st.mcSol;
    } catch {
      return null;
    }
  }
  if (!mcSol) return null;
  // sample into a 48h ring (>=5 min apart)
  const hist: { at: number; mc: number }[] = JSON.parse(store.kvGet("ownMc:hist") ?? "[]");
  const now = Date.now();
  if (!hist.length || now - hist[hist.length - 1].at > 5 * 60_000) {
    hist.push({ at: now, mc: mcSol });
    while (hist.length && hist[0].at < now - 48 * 3600_000) hist.shift();
    store.kvSet("ownMc:hist", JSON.stringify(hist.slice(-600)));
  }
  const day = hist.filter((h) => h.at > now - 24 * 3600_000);
  const high24Sol = Math.max(mcSol, ...day.map((h) => h.mc));
  const drawdownPct = high24Sol > 0 ? ((high24Sol - mcSol) / high24Sol) * 100 : 0;
  return { mcSol, high24Sol, drawdownPct };
}

/** The watcher no longer spends anything: it tracks the market, detects new
 *  earnings, and tells the AGENT — who decides when a buyback is smart
 *  (dips are discounts; earnings are also his trading budget). */
export function startBuybackWatch(_onPending?: (p: PendingBuyback) => void): NodeJS.Timeout {
  if (cfg.simMode) {
    // sim: creator rewards trickle into the unallocated pool
    const simTick = () => {
      void ownMcStats();
      if (Math.random() < 0.3) {
        const sol = Math.floor((0.02 + Math.random() * 0.06) * 1e4) / 1e4;
        const pool = Number(store.kvGet("sim:earnSol") ?? 0) + sol;
        store.kvSet("sim:earnSol", String(pool));
        log.info("buyback", `[SIM] creator rewards landed: ${sol.toFixed(4)} SOL (war chest ${pool.toFixed(4)})`);
      }
    };
    return setInterval(simTick, (cfg.buybackPollS * 1000) / cfg.simSpeed);
  }
  const tick = async () => {
    try {
      if (!loadWallet()) return;
      void ownMcStats(); // keep the dip radar fed
      const pool = await unallocatedSol();
      const lastSeen = Number(store.kvGet("earn:lastSeen") ?? 0);
      if (pool > lastSeen + cfg.minBuybackSol) {
        log.info("buyback", `earnings landed: war chest now ${pool.toFixed(4)} SOL (was ${lastSeen.toFixed(4)}) — the agent decides its use`);
        const { memory } = await import("../agent/memory.js");
        memory.journal("earnings", `${(pool - lastSeen).toFixed(4)} SOL of rewards landed — war chest at ${pool.toFixed(4)} SOL. Buyback, trade, or hold: my call.`);
      }
      store.kvSet("earn:lastSeen", String(pool));
    } catch (e) {
      log.warn("buyback", `watch failed: ${String(e).slice(0, 120)}`);
    }
  };
  void tick();
  return setInterval(tick, cfg.buybackPollS * 1000);
}

/** Execute the buyback (called by the director mid-ceremony). */
export async function doBuyback(sol: number): Promise<{ sig: string } | null> {
  if (cfg.simMode) {
    const sig = `SIM${Date.now().toString(36)}`;
    store.addBuyback({ sol, sig, at: Date.now() });
    // tokens acquired at the simulated market price (1B supply)
    const mc = Number(store.kvGet("sim:ownMc") ?? 6500);
    const solUsd = 150;
    const tokens = (sol * solUsd) / Math.max(1e-9, mc / 1e9);
    store.kvSet("sim:bbTokens", String(Number(store.kvGet("sim:bbTokens") ?? 0) + tokens));
    store.kvSet("sim:earnSol", String(Math.max(0, Number(store.kvGet("sim:earnSol") ?? 0) - sol)));
    // buy pressure nudges the sim market up a hair
    store.kvSet("sim:ownMc", String(mc * (1 + 0.004 + Math.random() * 0.008)));
    log.info("buyback", `[SIM] bought own token: ${sol} SOL — ${sig}`);
    return { sig };
  }
  const payer = loadWallet();
  if (!payer || !cfg.ownMint) return null;
  const res = await executeBuy(payer, new PublicKey(cfg.ownMint), sol);
  store.addBuyback({ sol, sig: res.sig, at: Date.now() });
  log.info("buyback", `bought own token: ${sol} SOL — ${res.sig}`);
  return { sig: res.sig };
}

export async function ownTokenBalanceUi(): Promise<number> {
  const payer = loadWallet();
  if (!payer || !cfg.ownMint) return 0;
  const raw = await getTokenBalanceRaw(new PublicKey(cfg.ownMint), payer.publicKey);
  return Number(raw) / 1e6;
}
