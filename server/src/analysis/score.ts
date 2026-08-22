import type { CheckRow, VerdictTier } from "../protocol.js";
import type { TokenState } from "../chain/pump.js";
import type { CoinInfo } from "./checks/frontendApi.js";
import type { HolderInfo } from "./checks/holders.js";
import type { DevHistory } from "./checks/creator.js";
import type { BubbleInfo } from "./checks/bubble.js";
import type { DexStats } from "./checks/dexstats.js";
import { cfg } from "../config.js";

/**
 * Verdict scoring, two DISTINCT postures:
 *
 * SENT coins (someone gifted it — Quant CALLS OUT, he doesn't buy):
 *   Much gentler bar. The job is only "don't call an obvious rug", so the
 *   heavy lifting is the BUBBLE screen (fresh burner wallets, identical bags,
 *   extreme concentration) — not pedigree. A fun young coin with an unknown
 *   dev deserves a call if it's clean and alive.
 *
 * SCOUTED coins (candidates the agent might BUY): the strict bar stands.
 *
 * Weights adapt to maturity: on a young, small-mc token, "unknown dev" and
 * "no smart wallets yet" mean almost nothing — nobody had time to show up.
 * The tier is decided by THIS code; the LLM only narrates it.
 */
interface Inputs {
  state: TokenState;
  coin: CoinInfo | null;
  holders: HolderInfo | null;
  dev: DevHistory;
  smart: string[];
  ageMin: number | null;
  sentUsd: number | null; // null = scouted/agent research; number = sent coin
  sentPct: number | null; // % of total supply that was sent
  dexPaid: boolean | null;
  bubble: BubbleInfo | null;
  dexStats: DexStats | null;
  /** Caller-intel cache read (callout/callers.ts) — who else called this coin
   *  and how their past calls ran. null = not harvested yet. */
  callerIntel?: import("../callout/callers.js").CallerSignal | null;
}

export function scoreToken(i: Inputs): {
  rows: CheckRow[];
  score: number;
  tier: VerdictTier;
  hardReject: string | null;
} {
  const rows: CheckRow[] = [];
  const row = (label: string, verdict: CheckRow["verdict"], detail: string) =>
    rows.push({ label, verdict, detail });
  const isSent = i.sentUsd !== null;

  let hardReject: string | null = null;
  const reject = (why: string) => {
    if (!hardReject) hardReject = why;
  };

  // ---------- hard gates ----------
  if (i.state.kind === "none" || i.state.kind === "unsupported") {
    row("VENUE", "fail", i.state.kind === "none" ? "not a pump.fun token" : (i.state as any).why);
    reject("not-pump");
  } else {
    row(
      "VENUE",
      "pass",
      i.state.kind === "curve"
        ? `bonding curve, ${(i.state.progress * 100).toFixed(0)}% to graduation`
        : "graduated — trades on PumpSwap",
    );
  }

  if (isSent) {
    const pct = i.sentPct ?? 0;
    if (pct < cfg.minSentPct) {
      row("SENT SIZE", "fail", `${Math.round(pct * 1e7).toLocaleString()} tokens — below the ${cfg.minSentPct}%-of-supply desk minimum (${Math.round(cfg.minSentPct * 1e7).toLocaleString()} tokens)`);
      reject("dust");
    } else {
      row("SENT SIZE", "pass", `${pct.toFixed(2)}% of supply ($${(i.sentUsd ?? 0).toFixed(2)}) on the desk`);
    }
  }

  if (i.state.kind === "curve") {
    if (i.state.mayhem) {
      row("CURVE TYPE", "fail", "MAYHEM MODE — a rigged house-rules casino curve, not a real market. Automatic zero, and I mean zero.");
      reject("mayhem");
    } else {
      row("CURVE TYPE", "pass", "standard curve");
    }
  }

  // pulse: sent coins get a longer leash (a gift 45min quiet is a warn, not a corpse)
  const lastTradeMin = i.coin?.lastTradeTs ? (Date.now() - i.coin.lastTradeTs) / 60000 : null;
  const deadAfter = isSent ? 90 : 30;
  if (lastTradeMin !== null) {
    if (lastTradeMin > deadAfter) {
      row("PULSE", "fail", `last trade ${Math.round(lastTradeMin)} min ago — flatlined`);
      reject("dead");
    } else if (lastTradeMin > 30) {
      row("PULSE", "warn", `last trade ${Math.round(lastTradeMin)} min ago — sleepy`);
    } else {
      row("PULSE", "pass", `last trade ${lastTradeMin < 1 ? "<1" : Math.round(lastTradeMin)} min ago`);
    }
  } else {
    row("PULSE", "unknown", "no trade data");
  }

  const age = i.ageMin ?? (i.coin?.createdTs ? (Date.now() - i.coin.createdTs) / 60000 : null);
  if (age !== null && age < 2) {
    row("AGE", "fail", `${age.toFixed(1)} min old — no candle yet`);
    reject("too-young");
  } else if (age !== null) {
    row("AGE", age < 120 ? "pass" : "warn", `${age < 60 ? `${Math.round(age)} min` : `${(age / 60).toFixed(1)} h`} old`);
  } else {
    row("AGE", "unknown", "age lookup failed");
  }

  // serial rugger dev: hard gate for UNBONDED coins only. Once a token has
  // graduated, it survived — the dev's rap sheet is commentary, not a verdict.
  const bonded = i.state.kind === "amm";
  if (!bonded && i.dev.known && i.dev.launches >= 8 && i.dev.bonds === 0) {
    row("DEV RECORD", "fail", `${i.dev.launches} launches, ZERO bonded — serial rugger`);
    reject("bad-dev");
  } else if (!bonded && i.dev.known && i.dev.launches >= 20 && i.dev.bondRate < 0.03) {
    row("DEV RECORD", "fail", `${i.dev.bonds}/${i.dev.launches} bonded (${(i.dev.bondRate * 100).toFixed(0)}%) — token mill`);
    reject("bad-dev");
  } else if (bonded && i.dev.known && i.dev.launches >= 8 && i.dev.bondRate < 0.03) {
    row("DEV RECORD", "warn", `${i.dev.bonds}/${i.dev.launches} bonded (${(i.dev.bondRate * 100).toFixed(0)}%) — mill dev, but THIS one graduated anyway`);
  } else if (i.dev.known) {
    const pct = (i.dev.bondRate * 100).toFixed(0);
    row(
      "DEV RECORD",
      i.dev.bondRate >= 0.15 ? "pass" : "warn",
      `${i.dev.bonds}/${i.dev.launches} prior launches bonded (${pct}%)${i.dev.onWatchlist ? " — ON MY WATCHLIST" : ""}`,
    );
  } else {
    row("DEV RECORD", "unknown", "first launch I've seen from this dev");
  }

  // concentration: strict for buys, only EXTREME kills a gift
  const t1kill = isSent ? 30 : 20;
  const t10kill = isSent ? 65 : 50;
  if (i.holders) {
    if (i.holders.top1Pct > t1kill) {
      row("TOP HOLDER", "fail", `one wallet holds ${i.holders.top1Pct.toFixed(1)}% — hostage situation`);
      reject("concentrated");
    } else if (i.holders.top10Pct > t10kill) {
      row("TOP 10", "fail", `top 10 wallets hold ${i.holders.top10Pct.toFixed(0)}% — cartel`);
      reject("concentrated");
    } else {
      row("HOLDERS", "pass", `top1 ${i.holders.top1Pct.toFixed(1)}%, top10 ${i.holders.top10Pct.toFixed(0)}%`);
    }
  } else {
    row("HOLDERS", "unknown", "holder scan failed");
  }

  // BUBBLE MAP screen — the real rug filter for sent coins
  if (i.bubble?.checked) {
    const b = i.bubble;
    const freshPct = b.topChecked ? b.freshTop / b.topChecked : 0;
    if (b.clusterMax >= 5 && b.clusterSharePct >= 4) {
      row("BUBBLE MAP", "fail", `${b.clusterMax} top wallets hold IDENTICAL bags (${b.clusterSharePct.toFixed(0)}% of supply) — one operator, many masks`);
      reject("bundled");
    } else if (freshPct >= 0.6 && (i.holders?.top10Pct ?? 0) > 30) {
      row("BUBBLE MAP", "fail", `${b.freshTop}/${b.topChecked} top holders are fresh burner wallets holding ${(i.holders?.top10Pct ?? 0).toFixed(0)}%`);
      reject("fresh-swarm");
    } else if (freshPct >= 0.4 || b.clusterMax >= 3) {
      row("BUBBLE MAP", "warn", `${b.freshTop}/${b.topChecked} fresh wallets, biggest identical-bag cluster ${b.clusterMax}`);
    } else {
      row("BUBBLE MAP", "pass", `${b.freshTop}/${b.topChecked} fresh wallets, no identical-bag clusters`);
    }
  }

  // market stats — what's the thing actually worth and does it trade
  const fmtUsd = (v: number) =>
    v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${v.toFixed(0)}`;
  const ds = i.dexStats;
  const mcUsd = ds?.mcUsd ?? i.coin?.usdMarketCap ?? null;
  if (mcUsd !== null) row("MARKET CAP", "pass", fmtUsd(mcUsd));
  if (ds?.vol24Usd != null)
    row(
      "24H VOLUME",
      ds.vol24Usd >= 5000 ? "pass" : "warn",
      `${fmtUsd(ds.vol24Usd)}${ds.chg24Pct != null ? ` — price ${ds.chg24Pct >= 0 ? "+" : ""}${ds.chg24Pct.toFixed(0)}% 24h` : ""}`,
    );
  // FAKE-CHART TELLS — ported from a live Solana trading bot's screener, whose
  // thresholds have been ground against real memecoin tape. Each one describes
  // a market that LOOKS traded but isn't: wash volume, one-sided books, paper
  // float, or a corpse still twitching. Any single hit is a hard reject.
  if (ds) {
    const liq = ds.liqUsd ?? 0;
    const v1h = ds.vol1hUsd;
    const v24 = ds.vol24Usd;
    const fdv = ds.fdvUsd ?? mcUsd;
    const buys = ds.buys24;
    const sells = ds.sells24;
    const tell = (why: string, detail: string) => {
      row("TAPE", "fail", detail);
      reject(why);
    };
    if (liq > 0 && v1h != null && v1h > liq * 20)
      tell("wash", `${fmtUsd(v1h)} traded in an hour against ${fmtUsd(liq)} of liquidity — that's the same money going in circles, not demand`);
    else if (liq > 0 && v24 != null && v24 > liq * 150)
      tell("wash", `${fmtUsd(v24)} of 24h volume on ${fmtUsd(liq)} of liquidity — wash trading, and not a subtle attempt`);
    else if (fdv != null && liq > 0 && fdv / liq > 30)
      tell("paper-float", `${fmtUsd(fdv)} "valuation" resting on ${fmtUsd(liq)} of real liquidity — paper float; the price is whatever the last buyer says it is`);
    else if (buys != null && sells != null && buys + sells > 40 && (buys === 0 || sells === 0))
      tell("one-sided", `${buys} buys, ${sells} sells — a one-sided book is somebody's script, not a market`);
    else if (ds.chg1hPct != null && ds.chg6hPct != null && ds.chg1hPct < -25 && ds.chg6hPct < -40)
      tell("collapsing", `down ${Math.abs(ds.chg1hPct).toFixed(0)}% this hour and ${Math.abs(ds.chg6hPct).toFixed(0)}% over six — I don't catch knives mid-fall`);
    else if (liq > 0 && v1h != null && v24 != null && v1h < liq * 0.15 && v24 < liq * 3)
      tell("dead-tape", `${fmtUsd(v1h)} in the last hour on ${fmtUsd(liq)} of liquidity — the chart has a pulse, the book doesn't`);
  }

  // THE DEAD-MARKET TELL: a coin under a day old whose market cap exceeds its
  // entire 24h volume has been valued without being traded — the supply sits
  // with whoever printed it and nobody is actually buying. On a fresh launch
  // that is a rug pattern, not a slow start. Hard reject, score zero.
  // (Only judged when volume is actually known; a missing feed proves nothing.)
  {
    const ageMinNow = i.ageMin ?? (i.coin?.createdTs ? (Date.now() - i.coin.createdTs) / 60000 : null);
    const fresh = ageMinNow !== null && ageMinNow < 24 * 60;
    if (fresh && mcUsd !== null && ds?.vol24Usd != null && mcUsd > ds.vol24Usd) {
      row(
        "MARKET vs TAPE",
        "fail",
        `${fmtUsd(mcUsd)} market cap on only ${fmtUsd(ds.vol24Usd)} of 24h volume, and it's ${
          ageMinNow < 60 ? `${Math.round(ageMinNow)} min` : `${Math.round(ageMinNow / 60)}h`
        } old — priced like a winner, traded like a ghost. Nobody is buying this; someone is holding it up.`,
      );
      reject("no-tape");
    }
  }

  // liquidity judged relative to mc, CALIBRATED FOR MEMECOINS — single-digit
  // liq/mc is the norm on pump.fun; only genuinely shallow books get flagged
  if (ds?.liqUsd != null) {
    const ratio = mcUsd ? ds.liqUsd / mcUsd : null;
    const deep = ratio !== null ? ratio >= 0.1 : ds.liqUsd >= 100_000;
    const normal = ratio !== null ? ratio >= 0.025 : ds.liqUsd >= 30_000;
    row(
      "LIQUIDITY",
      deep || normal ? "pass" : "warn",
      `${fmtUsd(ds.liqUsd)}${
        ratio !== null
          ? ` (${(ratio * 100).toFixed(0)}% of mc — ${deep ? "deep" : normal ? "normal for a memecoin" : "thin even by memecoin standards"})`
          : ""
      }`,
    );
  }

  if (i.dexPaid === true) row("DEX PAID", "pass", "paid dexscreener profile — team spends on it");
  else if (i.dexPaid === false) row("DEX PAID", "warn", "no paid dexscreener profile");

  // ---------- soft score ----------
  // maturity: on young/small tokens, pedigree (dev, smart money) can't have
  // shown up yet — scale those weights down instead of punishing the coin
  const ageFactor = age === null ? 0.7 : Math.min(1, age / 90); // full weight from ~1.5h
  const mcFactor = mcUsd === null ? 0.7 : Math.min(1, mcUsd / 20000); // full weight from ~$20k
  const maturity = Math.max(0.3, (ageFactor + mcFactor) / 2);

  let score = 0;
  // dev history (up to 16, maturity-scaled; watchlist +4 flat)
  if (i.dev.known && i.dev.bondRate > 0) {
    score += Math.min(12, i.dev.bondRate * 40) * maturity;
    if (i.dev.onWatchlist) score += 4;
  } else {
    score += 8 * (1 - maturity) + 4 * maturity; // unknown dev ≈ neutral, harmless when young
  }
  // smart money (up to 12, maturity-scaled)
  if (i.smart.length >= 2) score += 12 * maturity;
  else if (i.smart.length === 1) score += 8 * maturity;
  if (i.smart.length > 0)
    row("SMART MONEY", "pass", `${i.smart.length} wallet${i.smart.length > 1 ? "s" : ""} I respect in the top 20`);
  // holder shape (0-20)
  if (i.holders) {
    const t10 = i.holders.top10Pct;
    if (t10 >= 10 && t10 <= 35) score += 20;
    else if (t10 < 10) score += 13;
    else if (t10 <= 50) score += 8;
  } else {
    score += 6; // unknown — don't nuke the score on an RPC hiccup
  }
  // momentum / liveliness (0-26)
  if (lastTradeMin !== null && lastTradeMin < 2) score += 12;
  else if (lastTradeMin !== null && lastTradeMin < 10) score += 8;
  else if (lastTradeMin !== null && lastTradeMin < 30) score += 4;
  if (i.state.kind === "curve" && i.state.progress > 0.3) score += 6;
  if (i.state.kind === "curve" && i.state.progress > 0.6) score += 4;
  // GRADUATION IS THE SIGNAL — only ~1.4% of launches ever bond. A bonded,
  // living coin has already beaten the odds; a callout check respects that.
  if (bonded) score += isSent ? 16 : 8;
  // real size + real volume (0-18) — dexscreener stats
  if (mcUsd !== null) {
    if (mcUsd >= 1e6) score += 10;
    else if (mcUsd >= 100_000) score += 7;
    else if (mcUsd >= 30_000) score += 4;
  }
  if (ds?.vol24Usd != null) {
    if (ds.vol24Usd >= 100_000) score += 8;
    else if (ds.vol24Usd >= 10_000) score += 5;
    else if (ds.vol24Usd >= 1_000) score += 2;
  }
  // age sweet spot (0-8)
  if (age !== null && age >= 5 && age <= 180) score += 8;
  else if (age !== null && age <= 480) score += 4;
  // hygiene (0-10)
  const socials = [i.coin?.twitter, i.coin?.telegram, i.coin?.website].filter(Boolean).length;
  score += Math.min(6, socials * 3);
  if ((i.coin?.description ?? "").length > 30) score += 2;
  if (i.coin?.image) score += 2;
  row("SOCIALS", socials > 0 ? "pass" : "warn", socials > 0 ? `${socials} link${socials > 1 ? "s" : ""} — more to dig into` : "no socials yet — normal for a fresh meme, not a red flag");
  // paid dex profile (0-6)
  if (i.dexPaid === true) score += 6;
  // clean bubble map (0-6) — being verifiably NOT a rug is worth points
  if (i.bubble?.checked && !hardReject) {
    const freshPct = i.bubble.topChecked ? i.bubble.freshTop / i.bubble.topChecked : 0;
    if (freshPct < 0.3 && i.bubble.clusterMax < 3) score += 6;
  }
  // CALLER INTEL (0-8) — who ELSE called this coin, judged by pump.fun's own
  // grading of their past calls. He judges other callers; a proven runner-
  // caller showing up is signal, a crowd of nobodies is not.
  // judged on MEDIAN peak, not average — one lottery call makes a bad caller's
  // average look elite; the median doesn't move
  const ci = i.callerIntel;
  if (ci && ci.callers > 0) {
    if (ci.scored > 0 && ci.bestMed >= 1.8) {
      score += 8;
      row("CALLER INTEL", "pass", `${ci.callers} caller${ci.callers > 1 ? "s" : ""} on this — best is ${ci.bestName || "a proven one"}, ${ci.bestMed.toFixed(1)}x MEDIAN peak over ${ci.bestCalls} calls (not one lucky hit — the typical call)`);
    } else if (ci.scored > 0 && ci.bestMed >= 1.3) {
      score += 4;
      row("CALLER INTEL", "pass", `${ci.callers} caller${ci.callers > 1 ? "s" : ""} on this, best runs a ${ci.bestMed.toFixed(1)}x median peak — decent company`);
    } else {
      row("CALLER INTEL", "warn", `${ci.callers} caller${ci.callers > 1 ? "s" : ""} on this and none with a real record — tourists, not signal`);
    }
  }

  score = Math.round(Math.min(100, score));
  // MAYHEM MODE = automatic rock-bottom. A rigged casino curve earns nothing;
  // it doesn't get a number, it gets zero and a roasting.
  if (["mayhem","no-tape","wash","paper-float","one-sided","collapsing","dead-tape"].includes(hardReject ?? "")) score = 0;

  return { rows, score, tier: tierFor(score, isSent, hardReject), hardReject };
}

/** Tier from score — exported so an analyst adjustment can re-derive it.
 *  Gifts get a lower bar (call-outs, not buys); hard rejects are immovable. */
export function tierFor(score: number, isSent: boolean, hardReject: string | null): VerdictTier {
  if (hardReject === "dust" || hardReject === "not-pump" || hardReject === "too-young") return "DECLINE";
  if (hardReject) return "ROAST";
  if (isSent) {
    if (score >= 62) return "STRONG CALL";
    if (score >= 40) return "CALL";
    if (score >= 22) return "PASS";
    return "ROAST";
  }
  if (score >= 75) return "STRONG CALL";
  if (score >= 55) return "CALL";
  if (score >= 35) return "PASS";
  return "ROAST";
}
