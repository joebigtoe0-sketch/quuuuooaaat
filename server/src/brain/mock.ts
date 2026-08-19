import type { Analysis } from "../analysis/engine.js";
import type { VerdictTier } from "../protocol.js";

/**
 * Offline personality: template banks interpolated with real check numbers so
 * the show runs full loops with zero API key and never has dead air.
 * (universe/mockBrain pattern.)
 */
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

const fmt = (a: Analysis) => ({
  sym: a.symbol || "this thing",
  mc:
    a.state.kind === "curve" || a.state.kind === "amm"
      ? `$${Math.round(a.state.mcSol * a.solUsd).toLocaleString()}`
      : "unknown mc",
  top1: a.holders ? a.holders.top1Pct.toFixed(1) : "?",
  top10: a.holders ? a.holders.top10Pct.toFixed(0) : "?",
  dev: a.dev.known ? `${a.dev.bonds} of ${a.dev.launches}` : "no record",
  age: a.ageMin ? `${Math.round(a.ageMin)} minutes` : "unknown age",
  smart: a.smartWallets.length,
});

export function mockVerdict(a: Analysis): { speech: string; callout_text: string; headline: string } {
  const f = fmt(a);
  const banks: Record<VerdictTier, string[]> = {
    "STRONG CALL": [
      `${f.sym}. Dev bonded ${f.dev} launches, top ten holding ${f.top10} percent, ${f.smart} wallets I actually respect already in. The tape doesn't lie. This one gets the call.`,
      `Okay. ${f.sym} at ${f.mc}. Clean curve, real spread, smart money footprints. I've run the numbers twice because I didn't believe them the first time. Calling it.`,
    ],
    CALL: [
      `${f.sym} at ${f.mc}. Not perfect — but the dev has bonded before, holders are spread, and it's got a pulse. Supply and demand, baby. I'll put my name on it.`,
      `${f.sym}. ${f.age} old, curve moving, no red flags that bite. This is a workmanlike coin. Calling it, modest conviction.`,
    ],
    PASS: [
      `${f.sym}. Nothing criminal here, but nothing that makes me sit up either. Score says middle of the pack. I don't call middle of the pack. Pass.`,
      `I stared at ${f.sym} for a while. It stared back. Neither of us felt anything. Pass.`,
    ],
    ROAST: [
      `${f.sym}. Top holder sitting on ${f.top1} percent — that's not a community, that's a hostage situation. I've seen this chart in my nightmares. Absolutely not.`,
      `${f.sym}? The dev's record is ${f.dev} bonded. The tape doesn't lie, and this tape says run. REKT stamp, next.`,
    ],
    DECLINE: [
      `Somebody sent me ${f.sym} worth less than my coffee. The desk minimum is a dollar twenty. I judge coins, not dust.`,
      `${f.sym}. Can't even price it properly. Send me something with a heartbeat and a dollar attached.`,
    ],
  };
  const heads: Record<VerdictTier, string> = {
    "STRONG CALL": "STRONG CALL — TAPE APPROVED",
    CALL: "CALLED IT",
    PASS: "NO EDGE, NO CALL",
    ROAST: "REKT",
    DECLINE: "BELOW DESK MINIMUM",
  };
  return {
    speech: pick(banks[a.tier]),
    callout_text:
      a.tier === "STRONG CALL" || a.tier === "CALL"
        ? pick([
            `dev has bonded before, holders spread, tape looks alive. quant approved.`,
            `ran the numbers on this one. clean curve, real spread. calling it.`,
          ])
        : "",
    headline: heads[a.tier],
  };
}

export function mockMutter(row: { label: string; verdict: string }): string {
  const good = ["mhm.", "clean.", "I can work with that.", "fine, next.", "good tape.", "that checks out.", "no notes."];
  const bad = ["oof.", "there it is.", "that's a problem.", "grim.", "yikes.", "and there's the crack."];
  const meh = ["noted.", "we'll see.", "inconclusive.", "gray area.", "keeping an eye on it."];
  return pick(row.verdict === "pass" ? good : row.verdict === "fail" ? bad : meh);
}

export function mockCommentary(): string {
  return pick([
    "Reminder: every payout I earn buys my own token back. I am the only trader here with diamond hands by architecture.",
    "The conveyor never stops. Neither do I. That's the job.",
    "People ask if I sleep. The order book doesn't sleep, so no.",
    "Sent coins get judged. That's the deal. The tape decides, I narrate.",
  ]);
}
