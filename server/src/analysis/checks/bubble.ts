import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../../chain/solana.js";

/**
 * Bubble-map-style rug screen (for SENT coins — Quant isn't buying these,
 * just deciding whether calling them out would embarrass him):
 *
 *   fresh wallets — top holders whose wallets have almost no history
 *                   (burners funded just to hold this coin)
 *   identical bags — several top holders with near-identical token amounts
 *                   (one operator bundling across wallets)
 *
 * Cheap approximations of what bubblemaps shows, from data we already have
 * plus ~10 throttled RPC calls.
 */
export interface BubbleInfo {
  checked: boolean;
  topChecked: number;
  freshTop: number; // how many of the checked top owners look fresh/burner
  clusterMax: number; // largest group of near-identical SIGNIFICANT bags
  clusterSharePct: number; // combined supply share of that cluster
}

const TOTAL_RAW = 1_000_000_000 * 1e6;
// only bags ≥0.15% of supply count — the top-20 tail of a healthy token
// naturally has many small holders with near-identical dust amounts
const SIGNIFICANT_RAW = TOTAL_RAW * 0.0015;

/** Largest cluster of near-identical significant bags (within 1.5%). Zero-RPC. */
export function identicalBagCluster(amounts: number[]): { size: number; sharePct: number } {
  const sorted = amounts.filter((a) => a >= SIGNIFICANT_RAW).sort((a, b) => a - b);
  let best = { size: 1, sharePct: 0 };
  let i = 0;
  for (let j = 1; j <= sorted.length; j++) {
    while (j < sorted.length && sorted[j] <= sorted[i] * 1.015) j++;
    if (j - i > best.size) {
      const share = (sorted.slice(i, j).reduce((s, a) => s + a, 0) / TOTAL_RAW) * 100;
      best = { size: j - i, sharePct: share };
    }
    i = j;
  }
  return best;
}

export async function bubbleScreen(owners: string[], amounts: number[]): Promise<BubbleInfo> {
  const conn = getConnection();
  const top = owners.slice(0, 10);
  let fresh = 0;
  let checked = 0;
  for (const o of top) {
    try {
      const sigs = await conn.getSignaturesForAddress(new PublicKey(o), { limit: 15 }, "confirmed");
      checked++;
      // a wallet whose ENTIRE history fits in <12 signatures is a burner —
      // real traders accumulate hundreds
      if (sigs.length < 12) fresh++;
    } catch {
      /* skip unreadable */
    }
  }
  const cluster = identicalBagCluster(amounts.slice(0, 20));
  return {
    checked: checked >= 5,
    topChecked: checked,
    freshTop: fresh,
    clusterMax: cluster.size,
    clusterSharePct: cluster.sharePct,
  };
}
