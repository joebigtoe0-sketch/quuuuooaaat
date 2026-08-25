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
 * Plus two anti-swarm gates (see attemptFollowBuy): no buying a mint that a
 * crowd of callers stamped inside minutes, and no buying above
 * CALLER_FOLLOW_MAX_FROM_FIRST_CALL × the earliest call's mc.
 *
 * EXIT: priced off the SAME data as the entry — the caller's graded median,
 * not their sell button (callers are often wrong about exits; their call
 * data isn't). Three rules, checked every ~30s:
 *   TP    — current mc ≥ call mc × caller median → sell CALLER_FOLLOW_TP_FRACTION
 *           (75%), keep the rest as a runner ("the target the trade was
 *           priced against just printed").
 *   RUNNER— fixed stop CALLER_FOLLOW_RUNNER_STOP_PCT (15%) below the mc where
 *           the TP fired; otherwise the runner rides forever.
 *   STOP  — full position marks −CALLER_FOLLOW_STOP_PCT% (40%) → all out.
 * The caller HOLDING at entry stays required (conviction filter), but their
 * wallet is no longer watched after the buy.
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
    balAtEntry?: string; // legacy (old caller-sell watch) — no longer written
    boughtAt: number;
    callMcUsd: number;
    med: number;
    phase?: "full" | "runner"; // absent = "full"
    mcAtPartial?: number; // mc when the TP fraction sold — runner stop anchors here
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
let capLogAt = 0;

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
    if (st.count >= cfg.callerFollowMaxPerDay) {
      // say it (throttled) — a capped day and a dead pipeline look identical
      // from the outside, and that cost us hours of "is something broken?"
      if (Date.now() - capLogAt > 30 * 60_000) {
        capLogAt = Date.now();
        log.info("follower", `day cap ${st.count}/${cfg.callerFollowMaxPerDay} — passing on everything until UTC midnight (CALLER_FOLLOW_MAX_PER_DAY raises it)`);
      }
      return false;
    }
    if (st.pos[c.mint]) return false;
    // no skin, no trade — their wallet IS our exit signal
    if (!c.skin || c.skin.costUsd < 10) return false;
    if (!(c.mcAtCall > 0) || !(rep.med > 1)) return false;

    // sub-$10k "calls" are launch snipes wearing a caller costume — NEEDLE
    // (called at $2,890 by a 5-call "8.1x median" farmer) taught this gate
    if (c.mcAtCall < cfg.callerFollowMinCallMc) {
      log.info("follower", `pass ${c.mint.slice(0, 8)}… — call mc $${Math.round(c.mcAtCall)} below $${cfg.callerFollowMinCallMc} floor (launch snipe, not a call)`);
      return false;
    }

    // entry premium: how much of their median move is left from HERE?
    // The median is CLAMPED for all math: a tiny-sample 8x median is a
    // lottery artifact (or a farmer grading their own pumps), and pricing a
    // target off it buys garbage with extra size.
    const med = Math.min(rep.med, cfg.callerFollowMedCap);
    const { marketCap } = await import("../chain/marketcap.js");
    const mc = await marketCap(c.mint);
    const mcNowUsd = mc.mcUsd;
    if (!mcNowUsd || mcNowUsd <= 0) return false;
    const targetUsd = c.mcAtCall * med; // where their TYPICAL call peaks
    const room = targetUsd / mcNowUsd;
    if (room < cfg.callerFollowRoom) {
      log.info("follower", `pass ${c.mint.slice(0, 8)}… — ${c.username || "caller"} called at $${Math.round(c.mcAtCall)}, now $${Math.round(mcNowUsd)}, med ${med.toFixed(1)}x (raw ${rep.med.toFixed(1)}x) leaves only ${room.toFixed(1)}x room`);
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

    // SWARM + POSITION-IN-MOVE — checked after the gauntlet on purpose:
    // analyze() awaits harvestFresh(), so the mint's call rows are current.
    // The night of 08-23 (5 straight −40% stops in 30 min) taught both rules:
    // a wave of callers stamping the same mint inside minutes IS the pump
    // (they farm their own grades on it), and a caller's median is measured
    // from THEIR call price — if the mc already ran past the earliest call,
    // the move we'd be pricing off has already happened and we're the exit.
    try {
      const { mintCallCrowd } = await import("./callers.js");
      const crowd = mintCallCrowd(c.mint, cfg.callerFollowSwarmWindowMin * 60_000);
      if (crowd.recent > cfg.callerFollowMaxSwarm) {
        log.info("follower", `pass ${c.mint.slice(0, 8)}… — swarm: ${crowd.recent} callers in ${cfg.callerFollowSwarmWindowMin}min (max ${cfg.callerFollowMaxSwarm}); the wave is the pump`);
        return false;
      }
      if (crowd.earliestMc && mcNowUsd > crowd.earliestMc * cfg.callerFollowMaxFromFirstCall) {
        log.info("follower", `pass ${c.mint.slice(0, 8)}… — late: mc $${Math.round(mcNowUsd)} is ${(mcNowUsd / crowd.earliestMc).toFixed(1)}x the first call ($${Math.round(crowd.earliestMc)}); the move already happened`);
        return false;
      }
    } catch { /* crowd data unreadable — the room gate already passed, proceed */ }

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
    // quality sizing uses the CLAMPED med — a lottery median must never size up
    const quality = med >= 2 && rep.h2 >= 45 ? 1.5 : med >= 1.6 ? 1.0 : 0.75;
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
      wallet: c.wallet, who,
      // the CLAMPED med is what the exit target is priced off — storing the
      // raw one would set an 8x TP that never prints
      boughtAt: Date.now(), callMcUsd: c.mcAtCall, med, phase: "full",
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

/** Exits priced off the caller's graded median — TP at the target (partial),
 *  fixed runner stop under the TP price, stop-loss on the full position. */
async function watchTick(): Promise<void> {
  const mints = Object.keys(st.pos);
  if (!mints.length) return;
  const { openPositions, tradeSell } = await import("../chain/trader.js");
  const { marketCap } = await import("../chain/marketcap.js");
  for (const mint of mints) {
    const f = st.pos[mint];
    const pos = openPositions().find((p) => p.mint === mint);
    if (!pos) {
      delete st.pos[mint]; // closed some other way (operator, rails)
      save();
      continue;
    }
    // live mc — the same yardstick the entry used. Unreadable = hold.
    let mcUsd: number | null = null;
    try {
      mcUsd = (await marketCap(mint)).mcUsd;
    } catch { /* RPC/API hiccup — next tick retries */ }
    if (!mcUsd || mcUsd <= 0) continue;

    const phase = f.phase ?? "full";
    let reason = "";
    let fraction = 1;
    let toRunner = false;

    if (phase === "runner") {
      // fixed stop below where the TP sold — otherwise the runner just rides
      if (f.mcAtPartial && mcUsd <= f.mcAtPartial * (1 - cfg.callerFollowRunnerStopPct / 100))
        reason = `runner stopped — gave back ${cfg.callerFollowRunnerStopPct}% from where I took profit`;
    } else {
      const targetUsd = f.callMcUsd * f.med;
      if (mcUsd >= targetUsd) {
        // the median target the trade was PRICED against just printed
        reason = `median target hit ($${Math.round(targetUsd).toLocaleString("en-US")} mc) — ${Math.round(cfg.callerFollowTpFraction * 100)}% off the table, the rest rides`;
        fraction = cfg.callerFollowTpFraction;
        toRunner = true;
      } else {
        // stop-loss on our own mark, independent of anyone's opinion
        try {
          const { estimateSellSolFor } = await import("../chain/pump.js");
          const val = await estimateSellSolFor(new PublicKey(mint), BigInt(pos.tokensRaw));
          if (pos.costSol > 0 && val < pos.costSol * (1 - cfg.callerFollowStopPct / 100))
            reason = `stop loss — down ${cfg.callerFollowStopPct}%+, the call didn't work`;
        } catch {}
      }
    }
    if (!reason) continue;

    const r = await tradeSell(mint, fraction, reason);
    if (r.ok) {
      if (toRunner) {
        f.phase = "runner";
        f.mcAtPartial = mcUsd;
        f.fails = 0;
        save();
        log.info("follower", `TP $${pos.symbol}: ${reason}${r.dry ? " [dry]" : ""} — runner armed, stop at $${Math.round(mcUsd * (1 - cfg.callerFollowRunnerStopPct / 100)).toLocaleString("en-US")} mc`);
        // honest pnl read for the partial: compare against the SOLD share's cost
        hooks?.narrateExit(mint, pos.symbol, reason, r.solReceived ?? 0, pos.costSol * cfg.callerFollowTpFraction);
      } else {
        log.info("follower", `EXITED $${pos.symbol}: ${reason}${r.dry ? " [dry]" : ""}`);
        // round trip: 75% TP + runner stop is one trade. Scoring only the
        // last slice against 25% of cost calls a winner a loser.
        const totalGot = pos.soldSol ?? r.solReceived ?? 0;
        hooks?.narrateExit(mint, pos.symbol, reason, totalGot, pos.costSol);
        delete st.pos[mint];
        save();
      }
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
    `caller-follow LIVE — ${cfg.callerFollowPct}% of spendable (floor ${cfg.callerFollowSol} SOL), need ${cfg.callerFollowRoom}x room to caller's median; ` +
      `anti-swarm: max ${cfg.callerFollowMaxSwarm} callers/${cfg.callerFollowSwarmWindowMin}min, entry ≤${cfg.callerFollowMaxFromFirstCall}x first call; ` +
      `exits: TP ${Math.round(cfg.callerFollowTpFraction * 100)}% at median target, runner stop −${cfg.callerFollowRunnerStopPct}% from TP, stop-loss −${cfg.callerFollowStopPct}%; max ${cfg.callerFollowMaxPerDay}/day` +
      (cfg.tradeDryRun ? " [DRY RUN]" : " [REAL SOL]"),
  );
}
