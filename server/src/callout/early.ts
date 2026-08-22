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
    // the ENTRY market cap is the whole basis of the track record — without it
    // the call can never be scored. Fetched BEFORE the line is written so the
    // callout can actually cite it: a hook with zero substance is spam.
    const entryMcSol = await (async () => {
      try {
        const { marketCap } = await import("../chain/marketcap.js");
        return (await marketCap(mint)).mcSol;
      } catch {
        return null;
      }
    })();
    const mcUsd = await (async () => {
      try {
        if (entryMcSol == null) return null;
        const { getSolUsd } = await import("../chain/solana.js");
        const p = await getSolUsd();
        return p ? Math.round(entryMcSol * p) : null;
      } catch {
        return null;
      }
    })();
    // facts = the angle + current mc, NOTHING else. Caller-tape quotes fed in
    // here produced word salad ("that other caller's still stuck at 1.0x") —
    // the tape is research material, not hook material.
    const facts = [
      `your thesis: ${why}`,
      mcUsd != null ? `market cap right now: $${mcUsd.toLocaleString("en-US")}` : "",
    ].filter(Boolean).join("\n");
    const text = await Promise.race([
      callFreeform(
        "You are RIKU, a cocky AI quant who calls coins on pump.fun. Write ONE public callout line for a coin you JUST bought. " +
          "\nSTYLE — deadpan degen shitpost. Everyone reading should half-know you're trolling, and that's the charm; the alpha hides inside the bit. SHORT: one or two short sentences, under ~140 chars, lowercase preferred, absurd confidence, zero explanation. Pick ONE shape and nail it:" +
          "\n1) fake TA with absurdly wrong specificity — 'cup and handle on the 5 second chart', 'golden cross forming on the 9 seconds. rip it to bonding'" +
          "\n2) insider larp — 'cabal said to trim some before they turn on the faucet', 'the group chat went quiet. that's the signal'" +
          "\n3) machine-quant absurdity — 'backtested this on 11 seconds of data. verdict: yes', 'my model flagged it and then unplugged itself'" +
          "\n4) pure command — 'rip it to bonding', 'send it. i'll explain after'" +
          "\nFake indicators, fake timeframes and cabal bits are JOKES and always allowed. Real numbers are different: at most ONE, and only the current mc from DATA (optional — most lines need no number at all). Never invent your buy size, prices, multiples, holders, or stats." +
          "\nNEVER NAME OR IDENTIFY ANOTHER CALLER OR TRADER, never explain your strategy (no medians, hit rates, 'x room', anyone's entries or targets)." +
          "\nTHESE ARE MEMECOINS — no whitepaper/roadmap/team/utility talk, even as a joke premise. No hashtags, no DYOR, no financial advice, max one emoji. Output only the line.",
        `$${symbol} — DATA:\n${facts}`,
        90,
        FRAGMENT_MODEL,
      ),
      new Promise<null>((r) => setTimeout(() => r(null), 9000)),
    ]);
    // trim at a word boundary — a callout that ends mid-word ("the narrati")
    // reads like a bot glitch
    const cutClean = (s: string, max: number): string => {
      if (s.length <= max) return s;
      const cut = s.slice(0, max);
      const sp = cut.lastIndexOf(" ");
      return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim();
    };
    const line = cutClean((text ?? "").trim().replace(/^["']|["']$/g, ""), 190) ||
      `cup and handle on the 5 second chart. $${symbol} to bonding.`;
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
