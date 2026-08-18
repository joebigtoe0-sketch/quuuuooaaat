import { cfg, isLive } from "../config.js";
import { store } from "../store.js";
import { log } from "../log.js";
import { walletPubkey } from "../chain/wallet.js";
import { getAccessToken, postCallout } from "./cc.js";

/**
 * The callout desk. Rules learned from calloutbot:
 *  - PREFLIGHT auth before the verdict beat commits to "CALL" on stream —
 *    if CC is down, the show degrades in character instead of failing after
 *    the buildup.
 *  - duplicate_callout is a success; daily cap; per-mint dedupe via store.
 *  - There is NO top-up path: the sent coins ARE the $1 gate. If pump.fun's
 *    balance check still rejects, that's a decline, not a purchase.
 */
export async function calloutPreflight(): Promise<boolean> {
  if (cfg.calloutDryRun) return true;
  try {
    await getAccessToken();
    return true;
  } catch (e) {
    log.warn("callout", `preflight failed: ${String(e).slice(0, 120)}`);
    return false;
  }
}

export function calloutCapReached(): boolean {
  return store.calloutsToday() >= cfg.maxCalloutsPerDay;
}

export async function executeCallout(
  mint: string,
  text: string,
): Promise<{ ok: boolean; dry: boolean; why?: string }> {
  const wallet = walletPubkey();
  if (!wallet) return { ok: false, dry: false, why: "no wallet" };
  if (cfg.simMode) {
    log.info("callout", `[SIM] posted on ${mint}: "${text}"`);
    return { ok: true, dry: false };
  }
  // same hard gate as X: nothing posts to the real world before GO LIVE
  if (!isLive()) {
    log.info("callout", `[PRE-LIVE] composed, not posted on ${mint}: "${text}"`);
    return { ok: true, dry: true };
  }
  if (cfg.calloutDryRun) {
    log.info("callout", `[DRY] would post on ${mint}: "${text}"`);
    return { ok: true, dry: true };
  }
  if (calloutCapReached()) return { ok: false, dry: false, why: "daily cap" };
  try {
    await postCallout(mint, text, wallet.toBase58());
    log.info("callout", `posted on ${mint}: "${text}"`);
    return { ok: true, dry: false };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("duplicate_callout")) {
      log.info("callout", `duplicate on ${mint} — treating as success`);
      return { ok: true, dry: false };
    }
    log.warn("callout", `post failed on ${mint}: ${msg.slice(0, 200)}`);
    return { ok: false, dry: false, why: msg.slice(0, 100) };
  }
}
