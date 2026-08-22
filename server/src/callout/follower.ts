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
    fails?: number; // consecutive exit failures — bounded, never infinite
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

/** Which caller did we follow into this mint? (for the stage's board moment) */
export function followedWho(mint: string): string | null {
  return st.pos[mint]?.who ?? null;
}

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

    // THE GAUNTLET — a good caller does not buy off a rug check. Full analysis
    // before the SOL moves: wash/mayhem/bundle/no-tape hard rejects are
    // absolute ($HOT taught us: bought at :09, scored 0/wash at :22).
    try {
      const { analyze } = await import("../analysis/engine.js");
      const a = await Promise.race([
        analyze(c.mint, null),
        new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
      ]);
      if (!a) {
        log.info("follower", `pass ${c.mint.slice(0, 8)}… — chain unreadable in time, no blind buys`);
        return false;
      }
      if (a.buyReject) {
        log.info("follower", `pass ${c.mint.slice(0, 8)}… — hard reject: ${a.buyReject} (${c.username || "caller"}'s call doesn't outrank the rug check)`);
        return false;
      }
      if (a.buyScore < 20) {
        log.info("follower", `pass ${c.mint.slice(0, 8)}… — buy score ${a.buyScore} too weak to follow anyone into`);
        return false;
      }
    } catch (e) {
      log.warn("follower", `analysis failed for ${c.mint.slice(0, 8)}… — no blind buys: ${String(e).slice(0, 60)}`);
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
    // PUBLIC thesis (ledger, callout LLM, trade ticket): the INDEX gets the
    // credit, never the individual — naming who we follow leaks the strategy
    // and invites front-running of our own signal
    const thesis =
      `my caller index lit up: a top-graded caller (${rep.med.toFixed(1)}x median peak over ${rep.calls} graded calls, ${rep.h2}% hit 2x) ` +
      `called this at $${Math.round(c.mcAtCall).toLocaleString("en-US")} and is holding it themselves — ` +
      `${room.toFixed(1)}x room left to their typical peak`;

    // SIZING: a % of spendable SOL, scaled by how good this caller actually
    // is — an elite-median caller with a real hit rate deserves more than a
    // barely-cleared bar. CALLER_FOLLOW_SOL is the floor; the global rails
    // (MAX_TRADE_SOL, daily cap, float) cap the top.
    const quality = rep.med >= 2 && rep.h2 >= 45 ? 1.5 : rep.med >= 1.6 ? 1.0 : 0.75;
    let sol = cfg.callerFollowSol;
    try {
      const { solBalance } = await import("../chain/wallet.js");
      const spendable = Math.max(0, (await solBalance()) - cfg.floatSol);
      sol = Math.max(cfg.callerFollowSol, spendable * (cfg.callerFollowPct / 100) * quality);
      sol = Math.round(sol * 1000) / 1000;
    } catch { /* balance unreadable — floor size */ }

    const { tradeBuy } = await import("../chain/trader.js");
    const res = await tradeBuy(c.mint, symbol, sol, thesis, mc.mcSol ?? null, "callerfollow");
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
    log.info("follower", `FOLLOWED ${who} into $${symbol} (${sol} SOL @ quality ${quality}, ${room.toFixed(1)}x room)${res.dry ? " [dry]" : ""}`);
    // public callout 2s after the fill (the reward window is NOW) — and one
    // more try at ~25s if the first didn't land (earlyCallout is idempotent:
    // it skips itself when the call already posted).
    // NOTE: the callout gets a SANITIZED angle, never the strategy thesis —
    // the LLM quotes whatever it's given, and medians/entries/room-math in a
    // public callout is the strategy explaining how to front-run it.
    const calloutAngle = "my screens lit up on this one — early, still moving, and the right people are already in";
    void (async () => {
      const { earlyCallout, wasCalledEarly } = await import("./early.js");
      await new Promise((r) => setTimeout(r, 2_000));
      await earlyCallout(c.mint, symbol, calloutAngle);
      await new Promise((r) => setTimeout(r, 23_000));
      if (!wasCalledEarly(c.mint)) await earlyCallout(c.mint, symbol, calloutAngle);
    })().catch(() => {});
    hooks.reveal(c.mint, sol);
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
    if (r.ok) {
      log.info("follower", `EXITED $${pos.symbol}: ${reason}${r.dry ? " [dry]" : ""}`);
      hooks?.narrateExit(mint, pos.symbol, reason, r.solReceived ?? 0, pos.costSol);
      delete st.pos[mint];
      save();
    } else if (/no such position|already gone|ledger closed/.test(r.why ?? "")) {
      // the position is gone one way or another — stop watching, no ceremony
      log.info("follower", `watch closed $${pos.symbol}: ${r.why}`);
      delete st.pos[mint];
      save();
    } else {
      // bounded retries — an exit that fails forever must scream, not spin
      f.fails = (f.fails ?? 0) + 1;
      save();
      if (f.fails >= 8) {
        log.warn("follower", `GIVING UP on $${pos.symbol} exit after ${f.fails} failures (${r.why}) — position needs an operator-sell`);
        delete st.pos[mint];
        save();
      } else {
        log.warn("follower", `exit failed $${pos.symbol}: ${r.why} — retry ${f.fails}/8`);
      }
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
