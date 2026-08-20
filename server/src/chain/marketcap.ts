import { PublicKey } from "@solana/web3.js";
import { getTokenState } from "./pump.js";
import { getSolUsd } from "./solana.js";

/**
 * THE market cap, from the source everyone else reads.
 *
 * Our own AMM maths is demonstrably wrong: measured live, ZBULL priced at 2.78
 * SOL against pump.fun's 21.28, and $RIKU at 62.9 against 106.0 — and the error
 * isn't a constant factor, so it can't be corrected with a multiplier. That
 * number leaks into the call record, the $RIKU market cap and the research
 * screen, where being 8x wrong is worse than being slow.
 *
 * pump.fun's API is what the audience sees on the coin page, so it IS the
 * truth for anything we display or record. Our on-chain figure stays as the
 * fallback (and is still used for trade execution, where the curve maths is
 * correct and an RPC read beats an HTTP round-trip).
 */
export interface Mc {
  mcSol: number | null;
  mcUsd: number | null;
  source: "pump" | "chain" | "none";
}

const cache = new Map<string, { at: number; mc: Mc }>();
const TTL = 30_000;

export async function marketCap(mint: string): Promise<Mc> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < TTL) return hit.mc;
  let mc: Mc = { mcSol: null, mcUsd: null, source: "none" };
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
      signal: controller.signal,
      headers: { accept: "application/json", origin: "https://pump.fun" },
    });
    clearTimeout(t);
    if (res.ok) {
      const j: any = await res.json();
      const mcSol = typeof j.market_cap === "number" ? j.market_cap : null;
      const mcUsd = typeof j.usd_market_cap === "number" ? j.usd_market_cap : null;
      if (mcSol || mcUsd) mc = { mcSol, mcUsd, source: "pump" };
    }
  } catch { /* fall through to chain */ }
  if (mc.source === "none") {
    try {
      const st = await getTokenState(new PublicKey(mint));
      if (st.kind === "curve" || st.kind === "amm") {
        const solUsd = await getSolUsd().catch(() => 0);
        mc = { mcSol: st.mcSol, mcUsd: solUsd ? st.mcSol * solUsd : null, source: "chain" };
      }
    } catch { /* leave as none */ }
  }
  cache.set(mint, { at: Date.now(), mc });
  return mc;
}
