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
    if (wasCalledEarly(mint)) return;
    if (calloutCapReached()) {
      log.info("callout", `early callout skipped for $${symbol} — daily cap`);
      return;
    }
    const text = await Promise.race([
      callFreeform(
        "You are RIKU, a cocky AI quant who calls coins on pump.fun. Write ONE public callout line (max 180 chars) for a coin you JUST bought. " +
          "It's a HOOK, not a report: one sharp joke or unhinged confession, backed by ONE concrete detail. Degen-native. " +
          "No hashtags, no DYOR, no financial advice, max one emoji. Output only the line.",
        `$${symbol} — why you took it: ${why}`,
        90,
        FRAGMENT_MODEL,
      ),
      new Promise<null>((r) => setTimeout(() => r(null), 9000)),
    ]);
    const line = (text ?? "").trim().replace(/^["']|["']$/g, "").slice(0, 190) ||
      `just took a position in $${symbol}. the tape made me do it.`;
    const res = await executeCallout(mint, line);
    if (res.ok) {
      store.kvSet(KEY(mint), String(Date.now()));
      store.addCallout({ mint, symbol, text: line, tier: "CALL", at: Date.now(), dry: res.dry, entryMcSol: null });
      log.info("callout", `EARLY callout on $${symbol}${res.dry ? " [dry]" : ""}: ${line.slice(0, 80)}`);
    } else {
      log.warn("callout", `early callout failed on $${symbol}: ${res.why}`);
    }
  } catch (e) {
    log.warn("callout", `early callout error: ${String(e).slice(0, 120)}`);
  }
}
