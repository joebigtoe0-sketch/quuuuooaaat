/**
 * Live market stats from dexscreener (works for both curve coins after
 * indexing and graduated PumpSwap pairs): market cap, 24h volume, 24h price
 * change, liquidity. Free public endpoint.
 */
export interface DexStats {
  mcUsd: number | null;
  vol24Usd: number | null;
  chg24Pct: number | null;
  liqUsd: number | null;
  hasInfo: boolean; // enhanced token info on dexscreener = a PAID profile
  // the shorter windows and trade counts — a 24h average hides everything that
  // matters on a memecoin, and the fake-chart tells all live in these
  vol1hUsd: number | null;
  vol5mUsd: number | null;
  chg1hPct: number | null;
  chg6hPct: number | null;
  buys24: number | null;
  sells24: number | null;
  fdvUsd: number | null;
}

export async function fetchDexStats(mint: string): Promise<DexStats | null> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 4500);
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const j: any = await res.json();
    const pairs: any[] = Array.isArray(j?.pairs) ? j.pairs : [];
    if (!pairs.length) return null;
    // best pair = deepest liquidity
    const p = pairs.sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0))[0];
    const num = (v: any) => (typeof v === "number" && isFinite(v) ? v : v != null && isFinite(Number(v)) ? Number(v) : null);
    return {
      mcUsd: num(p?.marketCap) ?? num(p?.fdv),
      vol24Usd: num(p?.volume?.h24),
      chg24Pct: num(p?.priceChange?.h24),
      liqUsd: num(p?.liquidity?.usd),
      hasInfo: pairs.some((q) => q?.info != null),
      vol1hUsd: num(p?.volume?.h1),
      vol5mUsd: num(p?.volume?.m5),
      chg1hPct: num(p?.priceChange?.h1),
      chg6hPct: num(p?.priceChange?.h6),
      buys24: num(p?.txns?.h24?.buys),
      sells24: num(p?.txns?.h24?.sells),
      fdvUsd: num(p?.fdv) ?? num(p?.marketCap),
    };
  } catch {
    return null;
  }
}
