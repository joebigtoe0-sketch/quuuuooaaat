/**
 * pump.fun frontend API — creator, timestamps, socials, liveness.
 * Flaky in practice: retried twice, and every failure degrades to UNKNOWN
 * (which scores toward PASS, never toward CALL).
 */
export interface CoinInfo {
  creator: string | null;
  createdTs: number | null; // ms
  lastTradeTs: number | null; // ms
  complete: boolean;
  hasPool: boolean;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  description: string;
  name: string;
  symbol: string;
  image: string | null;
  usdMarketCap: number | null;
  replyCount: number | null;
}

export async function fetchCoinInfo(mint: string): Promise<CoinInfo | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
        signal: controller.signal,
        headers: { accept: "application/json", origin: "https://pump.fun" },
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const j: any = await res.json();
      if (!j || typeof j !== "object") continue;
      return {
        creator: j.creator ?? null,
        createdTs: j.created_timestamp ?? null,
        lastTradeTs: j.last_trade_timestamp ?? null,
        complete: Boolean(j.complete),
        hasPool: Boolean(j.raydium_pool || j.pump_swap_pool),
        twitter: j.twitter ?? null,
        telegram: j.telegram ?? null,
        website: j.website ?? null,
        description: String(j.description ?? "").slice(0, 400),
        name: String(j.name ?? "").slice(0, 60),
        symbol: String(j.symbol ?? "").slice(0, 16),
        image: j.image_uri ?? null,
        usdMarketCap: typeof j.usd_market_cap === "number" ? j.usd_market_cap : null,
        replyCount: typeof j.reply_count === "number" ? j.reply_count : null,
      };
    } catch {
      /* retry once, then null */
    }
  }
  return null;
}
