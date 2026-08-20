import { store } from "../store.js";

/**
 * VERDICT LENSES — the depth problem on stage.
 *
 * Every research verdict was structurally identical: recite the checks, name a
 * number, deliver the tier. Accurate and completely forgettable. A good analyst
 * doesn't read the same checklist aloud — they pick the ONE thing about this
 * coin that actually decides it, and argue it.
 *
 * So the ANGLE is chosen in code and rotated, the same way tweet registers are.
 * The checks still decide the tier; the lens decides what he talks about.
 */
export interface Lens {
  id: string;
  weight: number;
  brief: string;
}

export const LENSES: Lens[] = [
  {
    id: "dev",
    weight: 14,
    brief:
      "THE DEV. Make this about the person who launched it. What does their record say they're doing — building, farming, or fishing? A dev with bonds behind them is a different animal to a first-timer, and a mill dev tells you the whole story before you look at anything else.",
  },
  {
    id: "shape",
    weight: 14,
    brief:
      "THE HOLDER SHAPE AS A SOCIAL READ. Distribution is a picture of who showed up. Is this a crowd, a cartel, or one guy with ten wallets wearing a crowd costume? Describe the people the numbers imply, not the numbers.",
  },
  {
    id: "callback",
    weight: 14,
    brief:
      "CALLBACK. Compare it to your own history — a coin like this you called before and what happened, or a lesson you learned the hard way. Your track record is the most interesting thing you own; use it. Only reference things actually in your record below.",
  },
  {
    id: "contrarian",
    weight: 12,
    brief:
      "WHAT EVERYONE ELSE IS MISSING. Take the thing the crowd would react to and show why it's the wrong thing to look at — or why the boring detail nobody mentions is the one that matters here.",
  },
  {
    id: "narrative",
    weight: 12,
    brief:
      "THE MEME ITSELF. Judge it as culture, not just as a chart. Does this idea have legs, is it funny, would anyone repeat it in a group chat? Distribution and liquidity decide the trade; the meme decides whether there's anything to trade.",
  },
  {
    id: "falsify",
    weight: 12,
    brief:
      "WHAT WOULD CHANGE YOUR MIND. State the one thing you can't see, and exactly what would flip your verdict. Confidence is more convincing when it comes with a named blind spot — say what you'd need to watch for.",
  },
  {
    id: "onenumber",
    weight: 10,
    brief:
      "ONE NUMBER. Pick the single most damning or most impressive figure in the data and build the entire verdict around it. Everything else is background. No stat dumps — one number, fully argued.",
  },
  {
    id: "timing",
    weight: 12,
    brief:
      "WHERE IT IS IN ITS LIFE. Age, curve progress, how the last hour compares to the hour before. A coin twenty minutes old and a coin two days old with the same numbers are completely different propositions — say which this is and what stage it's at.",
  },
];

const RECENT_KEY = "verdict:lenses";

export function pickLens(): Lens {
  let recent: string[] = [];
  try { recent = JSON.parse(store.kvGet(RECENT_KEY) ?? "[]"); } catch { /* fresh */ }
  const pool = LENSES.filter((l) => !recent.slice(-3).includes(l.id));
  const usable = pool.length ? pool : LENSES;
  const total = usable.reduce((s, l) => s + l.weight, 0);
  let n = Math.random() * total;
  const pick = usable.find((l) => (n -= l.weight) <= 0) ?? usable[0];
  store.kvSet(RECENT_KEY, JSON.stringify([...recent, pick.id].slice(-8)));
  return pick;
}

/** His actual record, so callbacks reference real calls instead of invented ones. */
export function trackRecordBrief(): string {
  try {
    const raw = store.kvGet("callout:perf");
    if (!raw) return "";
    const { rows } = JSON.parse(raw) as { rows: { symbol: string; multiplier: number | null; at: number }[] };
    const scored = (rows ?? []).filter((r) => r.multiplier != null);
    if (!scored.length) return "";
    const avg = scored.reduce((s, r) => s + (r.multiplier ?? 0), 0) / scored.length;
    const best = scored.reduce((b, r) => ((r.multiplier ?? 0) > (b.multiplier ?? 0) ? r : b));
    const recent = scored
      .slice(0, 5)
      .map((r) => `$${r.symbol} ${(r.multiplier ?? 0).toFixed(1)}x`)
      .join(", ");
    return `YOUR REAL CALL RECORD (never invent calls beyond these): ${scored.length} scored calls, average peak ${avg.toFixed(1)}x, best $${best.symbol} at ${(best.multiplier ?? 0).toFixed(1)}x. Recent: ${recent}.`;
  } catch {
    return "";
  }
}
