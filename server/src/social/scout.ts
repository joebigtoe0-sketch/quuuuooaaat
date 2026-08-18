import { log } from "../log.js";

/**
 * Token discovery beyond the launch feed — the agent's "find plays" senses:
 *   - dexscreener trending Solana pairs (public API)
 *   - pump.fun trending / about-to-graduate boards (frontend API)
 * Returns raw candidates; the agent researches them through the SAME analysis
 * engine as sent coins before any buy is even possible.
 */
export interface ScoutHit {
  mint: string;
  symbol: string;
  name: string;
  source: string;
  note: string; // volume/mc context for the prompt
}

export async function scoutDexscreener(): Promise<ScoutHit[]> {
  try {
    const res = await fetch("https://api.dexscreener.com/token-boosts/top/v1", {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as any[];
    const mints = (Array.isArray(data) ? data : [])
      .filter((d) => d.chainId === "solana" && typeof d.tokenAddress === "string")
      .map((d) => d.tokenAddress as string)
      .slice(0, 15);
    if (!mints.length) return [];
    // resolve real ticker symbols + liquidity/mc in ONE batched pairs call
    const meta = new Map<string, { symbol: string; name: string; note: string }>();
    try {
      const pr = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mints.join(",")}`, {
        headers: { accept: "application/json" },
      });
      if (pr.ok) {
        const pd = (await pr.json()) as any;
        for (const pair of pd.pairs ?? []) {
          const addr = pair?.baseToken?.address;
          if (!addr || meta.has(addr)) continue;
          meta.set(addr, {
            symbol: String(pair.baseToken.symbol ?? addr.slice(0, 6)).slice(0, 12),
            name: String(pair.baseToken.name ?? "").slice(0, 40),
            note: `mc $${Math.round(pair.marketCap ?? pair.fdv ?? 0).toLocaleString()}, liq $${Math.round(pair.liquidity?.usd ?? 0).toLocaleString()}`,
          });
        }
      }
    } catch {}
    return mints.slice(0, 10).map((mint) => {
      const m = meta.get(mint);
      return {
        mint,
        symbol: m?.symbol ?? mint.slice(0, 6),
        name: m?.name ?? "",
        source: "dexscreener-boosts",
        note: m?.note ?? "boosted token",
      };
    });
  } catch (e) {
    log.warn("scout", `dexscreener failed: ${String(e).slice(0, 80)}`);
    return [];
  }
}

export async function scoutPumpTrending(): Promise<ScoutHit[]> {
  const out: ScoutHit[] = [];
  // about-to-graduate = the "king of the hill" board — high momentum
  for (const [url, source] of [
    ["https://frontend-api-v3.pump.fun/coins/king-of-the-hill?includeNsfw=false", "pump-koth"],
    [
      "https://frontend-api-v3.pump.fun/coins?offset=0&limit=12&sort=volume_24h&order=DESC&includeNsfw=false",
      "pump-volume",
    ],
  ] as const) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json", origin: "https://pump.fun" } });
      if (!res.ok) continue;
      const data = (await res.json()) as any;
      const coins = Array.isArray(data) ? data : [data];
      for (const c of coins.slice(0, 8)) {
        if (!c?.mint) continue;
        out.push({
          mint: c.mint,
          symbol: String(c.symbol ?? "").slice(0, 12),
          name: String(c.name ?? "").slice(0, 40),
          source,
          note: `mc $${Math.round(c.usd_market_cap ?? 0).toLocaleString()}`,
        });
      }
    } catch {}
  }
  return out;
}

/** Majors and noise that a cashtag sweep should never chase. */
export const CASHTAG_IGNORE = new Set([
  "SOL", "BTC", "ETH", "USDC", "USDT", "BNB", "XRP", "DOGE", "ADA", "SUI", "TON",
  "USD", "EUR", "PNL", "MC", "ATH", "CA", "DEX", "CEX", "NFA", "DYOR", "QUANT",
]);

/** Resolve a cashtag to a solana mint via dexscreener search — deepest-liquidity
 *  exact-symbol match wins; pump-suffix mints preferred. */
export async function resolveTicker(sym: string): Promise<{ mint: string; symbol: string } | null> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(sym)}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const j: any = await res.json();
    const pairs: any[] = (Array.isArray(j?.pairs) ? j.pairs : []).filter(
      (p: any) =>
        p?.chainId === "solana" &&
        String(p?.baseToken?.symbol ?? "").toUpperCase() === sym.toUpperCase(),
    );
    if (!pairs.length) return null;
    pairs.sort(
      (a, b) =>
        (b.baseToken.address.endsWith("pump") ? 1e9 : 0) + (b?.liquidity?.usd ?? 0) -
        ((a.baseToken.address.endsWith("pump") ? 1e9 : 0) + (a?.liquidity?.usd ?? 0)),
    );
    const best = pairs[0];
    return { mint: String(best.baseToken.address), symbol: String(best.baseToken.symbol) };
  } catch {
    return null;
  }
}

export async function scoutAll(): Promise<ScoutHit[]> {
  const [dex, pump] = await Promise.all([scoutDexscreener(), scoutPumpTrending()]);
  const seen = new Set<string>();
  const all = [...pump, ...dex].filter((h) => {
    if (seen.has(h.mint)) return false;
    seen.add(h.mint);
    return true;
  });
  log.info("scout", `${all.length} trending candidates (${pump.length} pump, ${dex.length} dex)`);
  return all;
}
