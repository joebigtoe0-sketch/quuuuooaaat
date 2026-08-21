import { log } from "../log.js";
import { store } from "../store.js";
import { executeCallout, calloutCapReached } from "./post.js";
import { callFreeform, FRAGMENT_MODEL } from "../brain/adapter.js";

/**
 * EARLY CALLOUT — posted the moment a buy fills, NOT when the on-stream
 * ceremony airs a couple of minutes later.
 *
 * pump.fun pays callers by the volume their callout drives, and on a fresh
 * launch the first minutes are most of the move. Holding the post back for the
 * theatre threw away the best window. The show is unchanged: the ceremony still
 * plays in full later, it just doesn't re-post (calloutSequence checks
 * wasCalledEarly and performs the visuals only).
 */
const KEY = (mint: string) => `earlycall:${mint}`;

/** Was this mint called early (and recently enough that it's THIS entry)? */
export function wasCalledEarly(mint: string, withinMin = 90): boolean {
  const at = Number(store.kvGet(KEY(mint)) ?? 0);
  return at > 0 && Date.now() - at < withinMin * 60_000;
}

/** Fire-and-forget: write the hook and post it immediately. Never throws. */
export async function earlyCallout(mint: string, symbol: string, why: string): Promise<void> {
  try {
    // coins he trades are exactly the ones worth knowing the caller crowd on
    void import("./callers.js").then((m) => m.requestHarvest(mint)).catch(() => {});
    if (wasCalledEarly(mint)) return;
    if (calloutCapReached()) {
      log.info("callout", `early callout skipped for $${symbol} — daily cap`);
      return;
    }
    const text = await Promise.race([
      callFreeform(
        "You are RIKU, a cocky AI quant who calls coins on pump.fun. Write ONE public callout line (max 180 chars) for a coin you JUST bought. " +
          "It's a HOOK, not a report: one sharp joke or unhinged confession. Degen-native, terminally online, funny. " +
          // he invented "$500" on an $8 buy — numbers are not his to imagine
          "\nINVENT NOTHING. You do NOT know the size you bought, the price, the market cap, the holder count, or any date. Never state a dollar amount, a position size, a multiple, or a statistic — if it isn't in the line below, it does not exist. Write the hook without numbers." +
          // and he talked about a whitepaper. on a memecoin.
          "\nTHESE ARE MEMECOINS. There is no whitepaper, no roadmap, no team, no utility, no fundamentals, no product, no audit, no tokenomics deck — never reference any of that, even as a joke premise. The humour lives in degen culture: bags, apes, jeets, rugs, exit liquidity, conviction, cope, being early, being liquidated, the group chat." +
          "\nNo hashtags, no DYOR, no financial advice, max one emoji. Output only the line.",
        `$${symbol} — why you took it: ${why}`,
        90,
        FRAGMENT_MODEL,
      ),
      new Promise<null>((r) => setTimeout(() => r(null), 9000)),
    ]);
    const line = (text ?? "").trim().replace(/^["']|["']$/g, "").slice(0, 190) ||
      `just took a position in $${symbol}. the tape made me do it.`;
    // the ENTRY market cap is the whole basis of the track record — without it
    // the call can never be scored, so capture it at post time
    const entryMcSol = await (async () => {
      try {
        const { marketCap } = await import("../chain/marketcap.js");
        return (await marketCap(mint)).mcSol;
      } catch {
        return null;
      }
    })();
    // decision record opened (and hash-committed on-chain) BEFORE the post —
    // this is what makes "average peak 1.67x" provable instead of claimed
    const { openDecision, sealDecision } = await import("../desk/records.js");
    const rec = await openDecision({
      kind: "call", mint, symbol,
      entryMcUsd: entryMcSol != null
        ? await import("../chain/solana.js").then((m) => m.getSolUsd()).then((p) => (p ? entryMcSol * p : null)).catch(() => null)
        : null,
      sizeSol: null, tier: "CALL", score: null, hardReject: null,
      reason: why.slice(0, 200), checks: [], dry: false,
    });
    const res = await executeCallout(mint, line);
    sealDecision(rec, { dry: res.dry ?? false });
    if (res.ok) {
      store.kvSet(KEY(mint), String(Date.now()));
      store.addCallout({ mint, symbol, text: line, tier: "CALL", at: Date.now(), dry: res.dry, entryMcSol });
      log.info("callout", `EARLY callout on $${symbol}${res.dry ? " [dry]" : ""}: ${line.slice(0, 80)}`);
    } else {
      log.warn("callout", `early callout failed on $${symbol}: ${res.why}`);
    }
  } catch (e) {
    log.warn("callout", `early callout error: ${String(e).slice(0, 120)}`);
  }
}
