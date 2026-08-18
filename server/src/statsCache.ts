import { PublicKey } from "@solana/web3.js";
import { cfg } from "./config.js";
import { log } from "./log.js";
import { store } from "./store.js";
import { snapshotKPIs } from "./agent/goals.js";

/**
 * The wallet/stats payloads behind the 💰/📊 stream panels involve chain RPCs,
 * dexscreener, and per-position sell estimates — seconds of latency and Helius
 * rate-limit pressure if computed per request. This cache rebuilds them in the
 * background every few minutes; the routes serve memory instantly.
 */
const REFRESH_S = Number(process.env.STATS_REFRESH_S ?? 180);

let walletCache: any = null;
let statsCache: any = null;
let builtAt = 0;

async function buildWallet(): Promise<any> {
  const { walletHoldings, solBalance, walletPubkey } = await import("./chain/wallet.js");
  const { getSolUsd } = await import("./chain/solana.js");
  const { openPositions, paperBank } = await import("./chain/trader.js");
  const { estimateSellSolFor } = await import("./chain/pump.js");
  const [sol, solUsd, real] = await Promise.all([solBalance(), getSolUsd(), walletHoldings()]);
  const priced = new Map<string, number>();
  if (real.length) {
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${real.map((h: any) => h.mint).join(",")}`);
      const j: any = await r.json();
      for (const p of j?.pairs ?? []) {
        const m = p?.baseToken?.address;
        const pr = Number(p?.priceUsd);
        if (m && Number.isFinite(pr) && !priced.has(m)) priced.set(m, pr);
      }
    } catch {}
  }
  const items: any[] = real.map((h: any) => ({
    symbol: h.symbol, amount: h.amount, image: h.image,
    valueUsd: priced.has(h.mint) ? priced.get(h.mint)! * h.amount : null, paper: false,
  }));
  for (const p of openPositions()) {
    let v: number | null = null;
    try { v = (await estimateSellSolFor(new PublicKey(p.mint), BigInt(p.tokensRaw))) * solUsd; } catch {}
    items.push({ symbol: p.symbol, amount: Number(p.tokensRaw) / 1e6, image: null, valueUsd: v, paper: true });
  }
  items.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
  return { address: walletPubkey()?.toBase58() ?? null, sol, solUsd, solValueUsd: sol * solUsd, paperBankSol: paperBank(), items };
}

async function buildStats(): Promise<any> {
  const { positionsSummary, paperBank } = await import("./chain/trader.js");
  const { xFollowers, xPostsToday, xHandle } = await import("./social/x.js");
  const kpis = await snapshotKPIs().catch(() => null);
  const pos = await positionsSummary();
  return {
    calls: store.callouts().length,
    tweetsToday: kpis?.tweetsToday ?? 0,
    filmsToday: kpis?.filmsToday ?? 0,
    xHandle: xHandle(),
    xFollowers: await xFollowers(),
    xPostsToday: xPostsToday(),
    trading: {
      paperBankSol: paperBank(),
      openPositions: pos.open,
      realizedPnlSol: pos.realizedSol,
      unrealizedPnlSol: pos.unrealizedSol,
    },
    ownTokenMcUsd: kpis?.ownMcUsd ?? null,
  };
}

let refreshing = false;
export async function refreshStatsCache(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    walletCache = await buildWallet();
  } catch (e) {
    log.warn("stats", `wallet cache build failed: ${String(e).slice(0, 100)}`);
  }
  try {
    statsCache = await buildStats();
  } catch (e) {
    log.warn("stats", `stats cache build failed: ${String(e).slice(0, 100)}`);
  }
  builtAt = Date.now();
  refreshing = false;
}

export function startStatsCache(): void {
  void refreshStatsCache();
  setInterval(() => void refreshStatsCache(), REFRESH_S * 1000);
  log.info("stats", `wallet/stats cache refreshing every ${REFRESH_S}s`);
}

export const cachedWallet = () => (walletCache ? { ...walletCache, cachedAt: builtAt } : { loading: true });
export const cachedStats = () => (statsCache ? { ...statsCache, cachedAt: builtAt } : { loading: true });
