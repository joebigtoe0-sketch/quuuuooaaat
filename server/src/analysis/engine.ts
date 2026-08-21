import { cfg } from "../config.js";
import { PublicKey } from "@solana/web3.js";
import { getTokenState, getTokenAgeMinutes, type TokenState } from "../chain/pump.js";
import { getSolUsd, getTokenMeta } from "../chain/solana.js";
import { fetchCoinInfo, type CoinInfo } from "./checks/frontendApi.js";
import { fetchHolders, type HolderInfo } from "./checks/holders.js";
import { devHistory, smartWalletsAmong, type DevHistory } from "./checks/creator.js";
import { fetchDexPaid } from "./checks/dexpaid.js";
import { fetchDexStats, type DexStats } from "./checks/dexstats.js";
import { bubbleScreen, type BubbleInfo } from "./checks/bubble.js";
import type { CheckRow, VerdictTier } from "../protocol.js";
import { scoreToken, tierFor } from "./score.js";
import { log } from "../log.js";

/**
 * The research fan-out: every live fact Quant can gather about a coin in a few
 * seconds, plus the verdict. Entertainment-grade but scam-averse — the tier is
 * decided HERE by code; the LLM only narrates it.
 */
export interface Analysis {
  mint: string;
  name: string;
  symbol: string;
  image?: string;
  state: TokenState;
  coin: CoinInfo | null;
  holders: HolderInfo | null;
  dev: DevHistory;
  smartWallets: string[];
  ageMin: number | null;
  sentUsd: number | null; // null = conveyor pick (nothing was sent)
  solUsd: number;
  /** What other pump.fun callers actually wrote about this coin (their callout
   *  texts + each call's multiple) — thesis material, and roast material. */
  callerTape: { who: string; text: string; mult: number | null }[];
  rows: CheckRow[];
  score: number;
  tier: VerdictTier;
  hardReject: string | null;
  /** Score under the strict BUY posture (sent coins are scored leniently for
   *  callouts — buying uses this number instead). */
  buyScore: number;
  buyReject: string | null;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]).catch(() => null);

export async function analyze(mint: string, sentAmountRaw: bigint | null): Promise<Analysis> {
  const pk = new PublicKey(mint);
  const t0 = Date.now();

  const [state, coin, holdersRaw, chainAgeMin, solUsd, meta] = await Promise.all([
    withTimeout(getTokenState(pk), 6000).then((s) => s ?? ({ kind: "none" } as TokenState)),
    withTimeout(fetchCoinInfo(mint), 6000),
    withTimeout(fetchHolders(pk), 6000),
    withTimeout(getTokenAgeMinutes(pk), 6000),
    getSolUsd(),
    withTimeout(getTokenMeta(mint), 5000),
  ]);

  // age: pump.fun's created_timestamp is authoritative; the chain signature
  // scan caps at 3000 sigs and UNDER-reports age on busy tokens
  const ageMin = coin?.createdTs ? (Date.now() - coin.createdTs) / 60000 : chainAgeMin;

  const owners = holdersRaw?.owners ?? null;
  const dev = devHistory(coin?.creator ?? null);
  const smart = smartWalletsAmong(owners ?? []);

  const priceSol = state.kind === "curve" || state.kind === "amm" ? state.priceSol : 0;
  const sentUsd =
    sentAmountRaw === null ? null : (Number(sentAmountRaw) / 1e6) * priceSol * solUsd;

  // deeper forensics: dex-paid + market stats are cheap (always); the bubble
  // screen costs ~10 RPC calls, so it runs only for SENT coins — where the
  // job is "don't call an obvious rug", per the desk rules
  const [dexPaid, dexStats] = await Promise.all([
    withTimeout(fetchDexPaid(mint), 5000),
    withTimeout(fetchDexStats(mint), 5000),
  ]);
  let bubble: BubbleInfo | null = null;
  if (sentUsd !== null && owners && owners.length >= 5 && holdersRaw) {
    bubble = await withTimeout(bubbleScreen(owners, holdersRaw.amounts), 12000);
  }

  const name = coin?.name || meta?.name || mint.slice(0, 8);
  const symbol = coin?.symbol || meta?.symbol || mint.slice(0, 4);

  // "paid dexscreener" = approved order OR enhanced token info on the pair
  // (only paid tokens get the info block) — two independent proofs
  const paid = dexPaid === true || dexStats?.hasInfo === true ? true : dexPaid;

  const sentPct = sentAmountRaw === null ? null : (Number(sentAmountRaw) / 1e6 / 1e9) * 100;
  // caller intel: sync cache read only (never a network call in the hot path);
  // queue the mint so the background harvester fills the cache for next time
  const { callerSignal, requestHarvest } = await import("../callout/callers.js");
  requestHarvest(mint);
  const callerIntel = callerSignal(mint);
  const scored = scoreToken({
    state, coin, holders: holdersRaw, dev, smart, ageMin, sentUsd, sentPct,
    dexPaid: paid ?? null, bubble, dexStats: dexStats ?? null, callerIntel,
  });
  // SKIN IN THE GAME: the more supply someone puts on the desk, the better the
  // hearing. Bonus scales with sent %, auto-call past the threshold — but the
  // hard scam-rejects (rugs, whales, mayhem) can never be bought off.
  if (sentPct !== null && !scored.hardReject) {
    const bonus = Math.min(15, Math.round(sentPct * 1.5));
    if (bonus > 0) {
      scored.rows.push({ label: "SKIN IN THE GAME", verdict: "pass", detail: `${sentPct.toFixed(2)}% of supply sent — +${bonus} to the read` });
      scored.score = Math.min(100, scored.score + bonus);
      scored.tier = tierFor(scored.score, true, null);
    }
    if (sentPct >= cfg.autoCallPct) {
      scored.rows.push({ label: "ALIGNMENT", verdict: "pass", detail: `${sentPct.toFixed(1)}% of supply on the desk — that is conviction; auto-call (holders still screened)` });
      if (scored.tier !== "STRONG CALL") scored.tier = "CALL";
    }
  }
  // buy posture: same facts, scouted (strict) rules — this is the number the
  // trading gate uses, so a lenient callout score can never trigger a buy
  const buyScored =
    sentUsd === null
      ? scored
      : scoreToken({
          state, coin, holders: holdersRaw, dev, smart, ageMin, sentUsd: null, sentPct: null,
          dexPaid: paid ?? null, bubble, dexStats: dexStats ?? null, callerIntel,
        });

  log.info(
    "analysis",
    `${symbol} (${mint.slice(0, 8)}…) → ${scored.tier} score=${scored.score}` +
      `${scored.hardReject ? ` reject=${scored.hardReject}` : ""} in ${Date.now() - t0}ms | ` +
      scored.rows.map((r) => `${r.label}:${r.verdict}`).join(" "),
  );

  return {
    mint,
    name,
    symbol,
    image: coin?.image ?? meta?.image ?? undefined,
    state,
    coin,
    holders: holdersRaw,
    dev,
    smartWallets: smart,
    ageMin,
    sentUsd,
    solUsd,
    rows: scored.rows,
    score: scored.score,
    tier: scored.tier,
    hardReject: scored.hardReject,
    buyScore: buyScored.score,
    buyReject: buyScored.hardReject,
    callerTape: (await import("../callout/callers.js").then((m) => m.callerTape(mint)).catch(() => []))
      .map((t) => ({ who: t.who, text: t.text, mult: t.mult })),
  };
}
