import { pushFeed } from "../feed.js";
import { callFreeform, FRAGMENT_MODEL, hasApiKey } from "../brain/adapter.js";

/**
 * RIKU's visible inner monologue — a "thought:" line pushed to the public
 * activity feed whenever a work cycle starts, so viewers see intent before
 * action. Variety is the whole game: the fragment model WRITES a fresh
 * thought from the context most of the time (canned pool = examples + the
 * always-works fallback), and the last dozen emitted thoughts are banned
 * from repeating verbatim.
 * Deeper/strategic thoughts are written by the producer via /admin/thought.
 */

const POOLS: Record<string, { doing: string; examples: string[] }> = {
  research: {
    doing: "about to pull up an unknown fresh memecoin and research it properly (chart, holders, dev, rug checks)",
    examples: [
      "need a closer look at this one",
      "something's moving here. pulling the chart",
      "okay, let's see what this thing actually is",
      "running this one through the machine",
      "chart first, feelings never",
      "fresh ticker on the wire. inspecting",
      "who launched this and why is it moving",
      "let me see the holders before i see the dream",
      "the tape is whispering. zooming in",
      "another launch, another autopsy",
      "if the dev is clean i might care",
      "smells like either alpha or exit liquidity. checking which",
    ],
  },
  timeline: {
    doing: "about to open X/twitter, read mentions and reply to people",
    examples: [
      "checking the timeline, seeing what's going on",
      "mentions look noisy. let's see who wants something",
      "time to see what the timeline thinks it knows",
      "scrolling. purely for research purposes",
      "inbox full of opinions again",
      "let's see who's wrong on the internet today",
      "someone pinged me. hope it's not another 'wen pump'",
      "timeline check. bracing for financial fiction",
    ],
  },
  kolfeed: {
    doing: "about to read what big crypto influencer accounts are posting",
    examples: [
      "let's see what the big accounts are shilling today",
      "reading the kol feed. bracing for nonsense",
      "checking which narratives are being manufactured this hour",
      "influencer hour. adjusting my credibility filters to maximum",
      "time to fade some large accounts",
      "the loud ones are posting again. reading anyway",
    ],
  },
  investdesk: {
    doing: "the half-hourly investment desk check: reading one established mid-cap coin's tape and deciding buy or pass",
    examples: [
      "investment desk time. reading one grown-up chart",
      "half-hourly check on the serious book",
      "let's grade a mid-cap. slowly, like an adult",
      "time to read a coin that's older than an hour for once",
      "the patient money desk opens",
      "one chart, no rush, real liquidity. novel concept",
    ],
  },
  exit: {
    doing: "a position just closed or partially sold — about to explain the exit on stream",
    examples: [
      "position needs a decision. reading the exit",
      "the book just changed. let me explain it",
      "fill came through. counting what's left",
      "an exit printed. narrating before chat asks",
    ],
  },
  commentary: {
    doing: "taking a moment to review the desk, the bankroll and the day so far",
    examples: [
      "taking stock of the desk for a second",
      "quick look at where everything stands",
      "counting the bankroll. again",
      "moment of silence for today's decisions",
      "desk review. no survivors",
    ],
  },
  coding: {
    doing: "sitting down to work on his own tooling/code (the pnl card, the caller board page, stage renderers)",
    examples: [
      "the tooling doesn't write itself",
      "found a todo comment from three days ago. me. it was me",
      "time to touch code nobody asked about",
      "quick refactor. famous last words",
      "the desk runs on duct tape i wrote. maintaining the tape",
    ],
  },
  buyback: {
    doing: "about to do a treasury buyback of his own token",
    examples: [
      "treasury work. the fun kind",
      "buyback time. the one trade i never regret",
      "feeding the treasury back to the chart",
    ],
  },
};

// verbatim no-repeat window — the fastest way to look like a bot is to think
// the same thought twice in an afternoon
const recent: string[] = [];
function remember(line: string): void {
  recent.push(line.toLowerCase());
  if (recent.length > 16) recent.shift();
}
const seen = (line: string): boolean => recent.includes(line.toLowerCase());

function pickCanned(examples: string[]): string {
  const fresh = examples.filter((e) => !seen(e));
  const pool = fresh.length ? fresh : examples;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Fire-and-forget: push a thought line (LLM-written most of the time). */
export function thinkAloud(context: string, detail?: string): void {
  void (async () => {
    const p = POOLS[context] ?? POOLS.research;
    let line = pickCanned(p.examples);
    if (detail) line = `${line} — ${detail}`;
    if (hasApiKey() && Math.random() < 0.85) {
      const avoid = recent.slice(-8).map((r) => `- ${r}`).join("\n");
      const v = await Promise.race([
        callFreeform(
          "You are RIKU, a cocky deadpan AI trader. Write ONE half-second inner thought he has as he starts the activity below. " +
            "lowercase, max 12 words, no emoji, no hashtags, no punctuation flourishes, never a promise of profit. Dry wit welcome, " +
            "but a plain matter-of-fact thought is fine too. It must NOT resemble any line in the avoid-list. Output only the thought.",
          `activity: ${p.doing}${detail ? ` (${detail})` : ""}\nstyle examples (do not copy): ${p.examples.slice(0, 3).join(" | ")}\navoid:\n${avoid || "- (nothing yet)"}`,
          40,
          FRAGMENT_MODEL,
        ),
        new Promise<null>((r) => setTimeout(() => r(null), 3000)),
      ]).catch(() => null);
      const cleaned = (v ?? "").trim().replace(/^["']|["']$/g, "").slice(0, 120);
      if (cleaned.length > 3 && !seen(cleaned)) line = cleaned;
    }
    remember(line);
    pushFeed("thought", line);
  })();
}

/** The clips that read as "thinking" on the rig. */
export const THINK_CLIPS = ["thoughtful", "chin_scratch", "arms_folded", "head_nod"] as const;
export function pickThinkClip(): string {
  return THINK_CLIPS[Math.floor(Math.random() * THINK_CLIPS.length)];
}
