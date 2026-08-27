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
  const { openPositions, bankSol } = await import("./chain/trader.js");
  const { estimateSellSolFor } = await import("./chain/pump.js");
  const [sol, solUsd, real] = await Promise.all([solBalance(), getSolUsd(), walletHoldings()]);
  const priced = new Map<string, number>();
  const dexSymbol = new Map<string, string>(); // reliable ticker from the market
  const dexImage = new Map<string, string>(); // fallback art when ipfs metadata had none
  if (real.length) {
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${real.map((h: any) => h.mint).join(",")}`);
      const j: any = await r.json();
      for (const p of j?.pairs ?? []) {
        const m = p?.baseToken?.address;
        const pr = Number(p?.priceUsd);
        if (m && Number.isFinite(pr) && !priced.has(m)) priced.set(m, pr);
        const sym = p?.baseToken?.symbol;
        if (m && sym && !dexSymbol.has(m)) dexSymbol.set(m, String(sym));
        const img = p?.info?.imageUrl;
        if (m && img && !dexImage.has(m)) dexImage.set(m, String(img));
      }
    } catch {}
  }
  // dexscreener only indexes coins with a real pool, so bonding-curve tokens —
  // gifts, and $RIKU itself — came back priceless and imageless. pump.fun knows
  // both: price = market cap / the standard 1B supply.
  const PUMP_SUPPLY = 1_000_000_000;
  const unpriced = real.filter((h: any) => !priced.has(h.mint)).slice(0, 12);
  for (const h of unpriced) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${h.mint}`, {
        signal: controller.signal,
        headers: { accept: "application/json", origin: "https://pump.fun" },
      });
      clearTimeout(t);
      if (!res.ok) continue;
      const j: any = await res.json();
      const mcUsd = Number(j?.usd_market_cap);
      if (Number.isFinite(mcUsd) && mcUsd > 0) priced.set(h.mint, mcUsd / PUMP_SUPPLY);
      if (j?.image_uri && !dexImage.has(h.mint)) dexImage.set(h.mint, String(j.image_uri));
      if (j?.symbol && !dexSymbol.has(h.mint)) dexSymbol.set(h.mint, String(j.symbol));
    } catch { /* leave unpriced */ }
  }
  // entry/PnL per token — only tokens he BOUGHT have a cost basis; gifted
  // bags show value only. Basis = cost minus what partial exits already took.
  const posByMint = new Map(openPositions().map((p: any) => [p.mint, p]));
  const attachPnl = (it: any, p: any) => {
    if (it.valueUsd == null) return;
    const basisUsd = Math.max(0, p.costSol - (p.soldSol ?? 0)) * solUsd;
    it.costUsd = basisUsd;
    it.pnlUsd = it.valueUsd - basisUsd;
    it.pnlPct = basisUsd > 0.01 ? (it.pnlUsd / basisUsd) * 100 : null;
    it.entryUsd = it.amount > 0 && basisUsd > 0 ? basisUsd / it.amount : null;
  };
  const items: any[] = [];
  for (const h of real) {
    const p = posByMint.get(h.mint);
    let valueUsd: number | null = priced.has(h.mint) ? priced.get(h.mint)! * h.amount : null;
    // dexscreener doesn't index bonding-curve-only tokens yet — for a held
    // position, fall back to the on-curve sellback value so value + PnL show.
    if (valueUsd == null && p) {
      try { valueUsd = (await estimateSellSolFor(new PublicKey(p.mint), BigInt(p.tokensRaw))) * solUsd; } catch {}
    }
    const it: any = { symbol: dexSymbol.get(h.mint) ?? h.symbol, amount: h.amount, image: h.image ?? dexImage.get(h.mint) ?? null, valueUsd, paper: false };
    if (p) attachPnl(it, p);
    items.push(it);
  }
  // paper positions exist only in the ledger — surface them with the ᴾ marker.
  // Live positions are real token accounts and already appear in the wallet list.
  if (cfg.tradeDryRun) {
    for (const p of openPositions()) {
      let v: number | null = null;
      try { v = (await estimateSellSolFor(new PublicKey(p.mint), BigInt(p.tokensRaw))) * solUsd; } catch {}
      const it: any = { symbol: p.symbol, amount: Number(p.tokensRaw) / 1e6, image: null, valueUsd: v, paper: true };
      attachPnl(it, p);
      items.push(it);
    }
  }
  items.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
  // everything he owns, in one number — SOL plus every priced bag
  const tokensUsd = items.filter((i: any) => !i.paper).reduce((s: number, i: any) => s + (i.valueUsd ?? 0), 0);
  const solValueUsd = sol * solUsd;
  return {
    address: walletPubkey()?.toBase58() ?? null,
    sol,
    solUsd,
    solValueUsd,
    tokensUsd,
    totalUsd: solValueUsd + tokensUsd,
    unpricedCount: items.filter((i: any) => !i.paper && i.valueUsd == null).length,
    paperBankSol: await bankSol(),
    paperMode: cfg.tradeDryRun,
    items,
  };
}

async function buildStats(): Promise<any> {
  const { positionsSummary, bankSol, allPositions, isReconciledClose } = await import("./chain/trader.js");
  const { xFollowers, xPostsToday, xHandle } = await import("./social/x.js");
  const kpis = await snapshotKPIs().catch(() => null);
  const pos = await positionsSummary();
  // TODAY's realized: positions SOLD since local midnight (UTC), full
  // round-trip result (soldSol - costSol) — partial exits on still-open
  // positions land here on the day they finally close.
  // RECONCILED closes are excluded: those are corpses we merely NOTICED today
  // (rugged days ago, no sell, no SOL moved), and booking their whole cost as a
  // fresh loss buried three winning trades under a fake -1 SOL on the big screen.
  // They stay in all-time realized, where the money genuinely is gone.
  const dayStart = new Date().setUTCHours(0, 0, 0, 0);
  const realizedTodaySol = allPositions()
    .filter((p: any) => p.closed && p.closed.at >= dayStart && !isReconciledClose(p))
    .reduce((s: number, p: any) => s + ((p.soldSol ?? 0) - p.costSol), 0);
  return {
    calls: store.callouts().length,
    tweetsToday: kpis?.tweetsToday ?? 0,
    filmsToday: kpis?.filmsToday ?? 0,
    xHandle: xHandle(),
    xFollowers: await xFollowers(),
    xPostsToday: xPostsToday(),
    trading: {
      paperBankSol: await bankSol(),
      paperMode: cfg.tradeDryRun,
      openPositions: pos.open,
      realizedPnlSol: pos.realizedSol,
      unrealizedPnlSol: pos.unrealizedSol,
      realizedTodaySol,
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
