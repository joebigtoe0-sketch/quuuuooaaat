import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { cfg } from "../config.js";
import { log } from "../log.js";
import type { HarvestedCall } from "./callers.js";

/**
 * CALLER-FOLLOW — the executing strategy on top of caller intel.
 *
 * ENTRY: a graded caller (median bar handled upstream in discovery) calls a
 * coin THEY HOLD, and the price hasn't already eaten their move:
 *   current mc ≤ call mc × (caller median ÷ CALLER_FOLLOW_ROOM)
 * i.e. with a 3x-median caller calling at $10k, we still buy at $12k
 * (room to $30k ≈ 2.5x) but not at $20k (room only 1.5x). Their median is
 * the target the trade is priced against — never their lottery average.
 *
 * EXIT: when THEY exit. Their wallet is public — the watcher reads the
 * caller's token balance on-chain every ~30s; when it drops below half of
 * what they held at our entry, we're out. No skin, no trade: a caller who
 * isn't holding can never signal an exit, so we never follow those.
 * Rug guard: if our position marks below −CALLER_FOLLOW_STOP_PCT% we exit
 * regardless — a caller asleep at the wheel doesn't take us down with him.
 *
 * STAGE: buy is instant, public callout is instant (the first minutes pay);
 * the show catches up — the coin queues as a position REVEAL (research
 * ceremony that honestly announces the position, then callout visuals).
 * Exits are also instant, then the actor narrates the exit on stream.
 */

interface FollowState {
  [mint: string]: {
    wallet: string; // the caller we followed
    who: string;
    balAtEntry: string; // caller's raw token balance when we bought
    boughtAt: number;
    callMcUsd: number;
    med: number;
  };
}
const FILE = () => path.join(cfg.dataDir, "callerfollow.json");
let st: { pos: FollowState; day: string; count: number } = { pos: {}, day: "", count: 0 };
try {
  const j = JSON.parse(fs.readFileSync(FILE(), "utf8"));
  if (j?.pos) st = j;
} catch { /* first run */ }
function save(): void {
  try {
    fs.writeFileSync(FILE(), JSON.stringify(st));
  } catch {}
}
const today = (): string => new Date().toISOString().slice(0, 10);

interface StageHooks {
  /** queue the on-stream position-reveal ceremony for a fresh buy */
  reveal: (mint: string, sol: number) => void;
  /** queue the on-stream exit narration after an instant sell */
  narrateExit: (mint: string, symbol: string, reason: string, solReceived: number, costSol: number) => void;
}
let hooks: StageHooks | null = null;

/** Called from discovery when a graded caller's fresh call passes the rep
 *  gate. Returns true if we bought (research then stages as a reveal). */
export async function attemptFollowBuy(
  c: HarvestedCall & { skin?: { costUsd: number; pnlPct: number | null } | null },
  rep: { med: number; h2: number; calls: number; username: string },
): Promise<boolean> {
  if (!cfg.callerFollow || !hooks) return false;
  try {
    if (today() !== st.day) {
      st.day = today();
      st.count = 0;
    }
    if (st.count >= cfg.callerFollowMaxPerDay) return false;
    if (st.pos[c.mint]) return false;
    // no skin, no trade — their wallet IS our exit signal
    if (!c.skin || c.skin.costUsd < 10) return false;
    if (!(c.mcAtCall > 0) || !(rep.med > 1)) return false;

    // entry premium: how much of their median move is left from HERE?
    const { marketCap } = await import("../chain/marketcap.js");
    const mc = await marketCap(c.mint);
    const mcNowUsd = mc.mcUsd;
    if (!mcNowUsd || mcNowUsd <= 0) return false;
    const targetUsd = c.mcAtCall * rep.med; // where their TYPICAL call peaks
    const room = targetUsd / mcNowUsd;
    if (room < cfg.callerFollowRoom) {
      log.info("follower", `pass ${c.mint.slice(0, 8)}… — ${c.username || "caller"} called at $${Math.round(c.mcAtCall)}, now $${Math.round(mcNowUsd)}, med ${rep.med.toFixed(1)}x leaves only ${room.toFixed(1)}x room`);
      return false;
    }

    // caller's balance BEFORE we buy — the exit baseline
    const { getTokenBalanceRaw } = await import("../chain/pump.js");
    let balAtEntry = 0n;
    try {
      balAtEntry = await getTokenBalanceRaw(new PublicKey(c.mint), new PublicKey(c.wallet));
    } catch { /* RPC hiccup — tracked as 0, watcher self-heals on first read */ }

    const symbol =
      c.symbol ||
      (await import("../chain/marketcap.js").then((m) => m.resolveSymbol(c.mint)).catch(() => null)) ||
      c.mint.slice(0, 4);
    const who = c.username || rep.username || "a graded caller";
    const thesis =
      `following ${who}: ${rep.med.toFixed(1)}x median over ${rep.calls} calls, ${rep.h2}% hit 2x, ` +
      `called at $${Math.round(c.mcAtCall).toLocaleString("en-US")} holding $${Math.round(c.skin.costUsd)} of it — ` +
      `${room.toFixed(1)}x room to their typical peak`;

    const { tradeBuy } = await import("../chain/trader.js");
    const res = await tradeBuy(c.mint, symbol, cfg.callerFollowSol, thesis, mc.mcSol ?? null, "callerfollow");
    if (!res.ok) {
      log.info("follower", `buy blocked ${c.mint.slice(0, 8)}…: ${res.why}`);
      return false;
    }
    st.pos[c.mint] = {
      wallet: c.wallet, who, balAtEntry: balAtEntry.toString(),
      boughtAt: Date.now(), callMcUsd: c.mcAtCall, med: rep.med,
    };
    st.count++;
    save();
    log.info("follower", `FOLLOWED ${who} into $${symbol} (${cfg.callerFollowSol} SOL, ${room.toFixed(1)}x room)${res.dry ? " [dry]" : ""}`);
    // instant public callout — the first minutes pay; the show catches up
    void import("./early.js").then((m) => m.earlyCallout(c.mint, symbol, thesis)).catch(() => {});
    hooks.reveal(c.mint, cfg.callerFollowSol);
    return true;
  } catch (e) {
    log.warn("follower", `attempt failed: ${String(e).slice(0, 100)}`);
    return false;
  }
}

/** They sell → we sell. Checks every open followed position's CALLER wallet
 *  on-chain; also runs the rug guard on our own mark. */
async function watchTick(): Promise<void> {
  const mints = Object.keys(st.pos);
  if (!mints.length) return;
  const { openPositions, tradeSell } = await import("../chain/trader.js");
  const { getTokenBalanceRaw } = await import("../chain/pump.js");
  for (const mint of mints) {
    const f = st.pos[mint];
    const pos = openPositions().find((p) => p.mint === mint);
    if (!pos) {
      delete st.pos[mint]; // closed some other way (operator, rails)
      save();
      continue;
    }
    let reason = "";
    try {
      const bal = await getTokenBalanceRaw(new PublicKey(mint), new PublicKey(f.wallet));
      const entry = BigInt(f.balAtEntry || "0");
      if (entry === 0n && bal > 0n) {
        // baseline was an RPC miss at entry — heal it now
        f.balAtEntry = bal.toString();
        save();
      } else if (entry > 0n && bal < entry / 2n) {
        reason = `${f.who} just dumped — I followed them in, I follow them out`;
      }
    } catch { /* RPC hiccup — keep holding, next tick retries */ }
    if (!reason) {
      // rug guard: our own mark, independent of the caller
      try {
        const { estimateSellSolFor } = await import("../chain/pump.js");
        const val = await estimateSellSolFor(new PublicKey(mint), BigInt(pos.tokensRaw));
        if (pos.costSol > 0 && val < pos.costSol * (1 - cfg.callerFollowStopPct / 100))
          reason = `down ${cfg.callerFollowStopPct}%+ while ${f.who} sleeps — rug guard, I'm out`;
      } catch {}
    }
    if (!reason) continue;
    const r = await tradeSell(mint, 1, reason);
    if (r.ok || /no such position|already gone/.test(r.why ?? "")) {
      log.info("follower", `EXITED $${pos.symbol}: ${reason}${r.dry ? " [dry]" : ""}`);
      hooks?.narrateExit(mint, pos.symbol, reason, r.solReceived ?? 0, pos.costSol);
      delete st.pos[mint];
      save();
    } else {
      log.warn("follower", `exit failed $${pos.symbol}: ${r.why} — retrying next tick`);
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startCallerFollow(h: StageHooks): void {
  hooks = h;
  if (!cfg.callerFollow) {
    log.info("follower", "CALLER_FOLLOW off — nominations stay research-only");
    return;
  }
  if (timer) return;
  timer = setInterval(() => void watchTick(), 30_000);
  log.info(
    "follower",
    `caller-follow LIVE — ${cfg.callerFollowSol} SOL per follow, need ${cfg.callerFollowRoom}x room to caller's median, ` +
      `exit when their wallet sells (30s on-chain watch), rug guard −${cfg.callerFollowStopPct}%, max ${cfg.callerFollowMaxPerDay}/day` +
      (cfg.tradeDryRun ? " [DRY RUN]" : " [REAL SOL]"),
  );
}
