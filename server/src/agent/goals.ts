import { PublicKey } from "@solana/web3.js";
import { cfg } from "../config.js";
import { store } from "../store.js";
import { solBalance } from "../chain/wallet.js";
import { getTokenState } from "../chain/pump.js";
import { getSolUsd } from "../chain/solana.js";
import { ownTokenBalanceUi, unallocatedSol, ownMcStats } from "../chain/buyback.js";
import { positionsSummary, paperBank, bankSol } from "../chain/trader.js";
import { imagesLeftToday } from "../media/imagegen.js";

/**
 * The scoreboard the agent plays against. Injected into every planning prompt
 * so decisions connect to the three goals:
 *   1. own token market cap    2. KOL reach    3. trading PnL
 */
export interface KPIs {
  ownMcUsd: number | null;
  ownMcDrawdownPct: number | null;
  warChestSol: number;
  treasurySol: number;
  ownTokensHeld: number;
  buybackSolTotal: number;
  calloutsToday: number;
  tweetsToday: number;
  filmsToday: number;
  openPositions: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  paperBankSol: number;
  solUsd: number;
}

/** Sim: the own-token market is a gentle geometric random walk from a fresh
 *  ~$6.5k launch, nudged upward every buyback. Persisted so it has a history. */
function simOwnMc(): number {
  const now = Date.now();
  let mc = Number(store.kvGet("sim:ownMc") ?? 0) || 6500;
  const lastAt = Number(store.kvGet("sim:ownMcAt") ?? 0) || now;
  const simMin = ((now - lastAt) / 60_000) * cfg.simSpeed;
  for (let i = 0; i < Math.min(60, Math.floor(simMin / 5)); i++)
    mc *= 1 + 0.002 + (Math.random() - 0.5) * 0.024;
  mc = Math.min(500_000, Math.max(3_000, mc));
  store.kvSet("sim:ownMc", String(mc));
  store.kvSet("sim:ownMcAt", String(now));
  return mc;
}

export async function snapshotKPIs(): Promise<KPIs> {
  const solUsd = await getSolUsd();
  let ownMcUsd: number | null = null;
  if (cfg.simMode) {
    ownMcUsd = simOwnMc();
  } else if (cfg.ownMint) {
    // pump.fun's figure, not ours — our AMM maths reads ~40% low on $RIKU
    try {
      const { marketCap } = await import("../chain/marketcap.js");
      const mc = await marketCap(cfg.ownMint);
      ownMcUsd = mc.mcUsd ?? (mc.mcSol != null ? mc.mcSol * solUsd : null);
    } catch {}
  }
  const pos = await positionsSummary();
  const day = (k: string) => Number(store.kvGet(`${k}:${new Date().toISOString().slice(0, 10)}`) ?? 0);
  const mcStats = await ownMcStats().catch(() => null);
  return {
    ownMcUsd,
    ownMcDrawdownPct: mcStats ? Math.round(mcStats.drawdownPct) : null,
    warChestSol: await unallocatedSol().catch(() => 0),
    // sim: the paper bankroll IS the treasury; he holds 2% of the 1B supply
    treasurySol: cfg.simMode ? paperBank() : await solBalance(),
    ownTokensHeld: cfg.simMode
      ? cfg.simOwnSupplyPct * 1e7 + Number(store.kvGet("sim:bbTokens") ?? 0)
      : await ownTokenBalanceUi(),
    buybackSolTotal: store.buybacks().reduce((a, b) => a + b.sol, 0),
    calloutsToday: store.calloutsToday(),
    tweetsToday: day("tweets"),
    filmsToday: day("films"),
    openPositions: pos.open,
    realizedPnlSol: pos.realizedSol,
    unrealizedPnlSol: pos.unrealizedSol,
    paperBankSol: await bankSol(),
    solUsd,
  };
}

export function bumpDaily(k: "tweets" | "films"): void {
  const key = `${k}:${new Date().toISOString().slice(0, 10)}`;
  store.kvSet(key, String(Number(store.kvGet(key) ?? 0) + 1));
}

export function kpiText(k: KPIs): string {
  return (
    `own token mc: ${k.ownMcUsd ? "$" + Math.round(k.ownMcUsd).toLocaleString() : "not launched"}${k.ownMcDrawdownPct != null && k.ownMcDrawdownPct > 0 ? ` (-${k.ownMcDrawdownPct}% off 24h high${k.ownMcDrawdownPct >= 20 ? " — DIP, buyback discount" : ""})` : ""} | ` +
    `treasury ${k.treasurySol.toFixed(3)} SOL | WAR CHEST (unallocated earnings) ${k.warChestSol.toFixed(3)} SOL | $RIKU held ${Math.round(k.ownTokensHeld).toLocaleString()} | ` +
    `bought back ${k.buybackSolTotal.toFixed(3)} SOL total | ` +
    `today: ${k.calloutsToday} callouts, ${k.tweetsToday}/${cfg.maxTweetsPerDay} tweets (daily min target ${cfg.minTweetsPerDay}, spaced ${cfg.minTweetGapMin}+ min), ${k.filmsToday} films, memes left ${imagesLeftToday()} | ` +
    `trading: ${cfg.tradeDryRun ? `paper bankroll ${k.paperBankSol.toFixed(3)} SOL (started ${cfg.paperStartSol.toFixed(1)})` : `bankroll ${k.paperBankSol.toFixed(3)} SOL (real, from the war chest)`}, ${k.openPositions} open, ` +
    `realized ${k.realizedPnlSol >= 0 ? "+" : ""}${k.realizedPnlSol.toFixed(3)} SOL, ` +
    `unrealized ${k.unrealizedPnlSol >= 0 ? "+" : ""}${k.unrealizedPnlSol.toFixed(3)} SOL`
  );
}
