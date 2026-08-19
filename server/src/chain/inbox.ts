import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { getConnection, findSender } from "./solana.js";
import { cfg } from "../config.js";
import { log } from "../log.js";

/**
 * The inbox: people SEND coins to Quant's wallet; a new mint appearing in the
 * balance IS the show's input. Ported from calloutbot walletWatch.js —
 * snapshot-diff over both token programs, fails closed, baseline on first tick
 * so existing holdings never fire.
 */
export interface InboxEvent {
  mint: string;
  amountRaw: bigint;
  sender: string | null;
}

const DENYLIST = new Set<string>([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

async function snapshot(owner: PublicKey): Promise<Map<string, bigint>> {
  const conn = getConnection();
  const held = new Map<string, bigint>();
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    // Fail CLOSED: a partial snapshot would report every missing holding as
    // brand new on the next good poll.
    const res = await conn.getParsedTokenAccountsByOwner(owner, { programId }, "confirmed");
    for (const { account } of res.value) {
      const info = (account.data as any)?.parsed?.info;
      if (!info) continue;
      const raw = BigInt(info.tokenAmount?.amount ?? "0");
      if (raw > 0n) held.set(info.mint, raw);
    }
  }
  return held;
}

export function startInbox(
  owner: PublicKey,
  onNew: (ev: InboxEvent) => void,
): NodeJS.Timeout {
  let known: Map<string, bigint> | null = null;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = await snapshot(owner);
      if (known === null) {
        known = now;
        log.info("inbox", `watching ${owner.toBase58()} — ${known.size} existing holdings ignored`);
        return;
      }
      // tokens HE bought (open positions) or his own token (buybacks) appear in
      // the wallet too — those are NOT gifts. Skip them or he "receives" his own
      // trades and re-researches them as sent to the desk.
      const { openPositions } = await import("./trader.js");
      const ownedMints = new Set(openPositions().map((p) => p.mint));
      for (const [mint, amountRaw] of now) {
        if (DENYLIST.has(mint)) continue;
        if (cfg.ownMint && mint === cfg.ownMint) continue;
        if (ownedMints.has(mint)) continue;
        if (!known.has(mint)) {
          log.info("inbox", `coin received: ${mint}`);
          const sender = await findSender(owner, mint).catch(() => null);
          onNew({ mint, amountRaw, sender });
        }
      }
      known = now;
    } catch (e) {
      log.warn("inbox", `poll failed: ${String(e).slice(0, 120)}`);
    } finally {
      busy = false;
    }
  };

  void tick();
  return setInterval(tick, cfg.inboxPollS * 1000);
}
