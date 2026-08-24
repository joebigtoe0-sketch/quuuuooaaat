import { pushFeed } from "../feed.js";
import { callFreeform, FRAGMENT_MODEL, hasApiKey } from "../brain/adapter.js";

/**
 * RIKU's visible inner monologue — a "thought:" line pushed to the public
 * activity feed whenever a work cycle starts, so viewers see intent before
 * action. Cheap by design: a canned variation pool per context, with the
 * fragment model rephrasing SOME of them so the wording never goes stale.
 * Deeper/strategic thoughts are written by the producer via /admin/thought.
 */

const POOLS: Record<string, string[]> = {
  research: [
    "need a closer look at this one",
    "something's moving here. pulling the chart",
    "okay, let's see what this thing actually is",
    "running this one through the machine",
    "chart first, feelings never",
  ],
  timeline: [
    "checking the timeline, seeing what's going on",
    "mentions look noisy. let's see who wants something",
    "time to see what the timeline thinks it knows",
    "scrolling. purely for research purposes",
  ],
  kolfeed: [
    "let's see what the big accounts are shilling today",
    "reading the kol feed. bracing for nonsense",
    "checking which narratives are being manufactured this hour",
  ],
  investdesk: [
    "investment desk time. reading one grown-up chart",
    "half-hourly check on the serious book",
    "let's grade a mid-cap. slowly, like an adult",
  ],
  exit: [
    "position needs a decision. reading the exit",
    "the book just changed. let me explain it",
  ],
  commentary: [
    "taking stock of the desk for a second",
    "quick look at where everything stands",
  ],
  buyback: [
    "treasury work. the fun kind",
  ],
};

/** Fire-and-forget: push a thought line (canned, sometimes LLM-reworded). */
export function thinkAloud(context: string, detail?: string): void {
  void (async () => {
    const pool = POOLS[context] ?? POOLS.research;
    let line = pool[Math.floor(Math.random() * pool.length)];
    if (detail) line = `${line} — ${detail}`;
    // rephrase some of the time so the pool never reads canned; canned is the
    // fallback, never a failure
    if (hasApiKey() && Math.random() < 0.5) {
      const v = await Promise.race([
        callFreeform(
          "Rephrase this half-second inner thought of a cocky AI trader in his own words. Same meaning, different wording, lowercase, max 12 words, no emoji, no punctuation flourishes. Output only the thought.",
          line,
          40,
          FRAGMENT_MODEL,
        ),
        new Promise<null>((r) => setTimeout(() => r(null), 3000)),
      ]).catch(() => null);
      if (v && v.trim().length > 3) line = v.trim().replace(/^["']|["']$/g, "").slice(0, 120);
    }
    pushFeed("thought", line);
  })();
}

/** The clips that read as "thinking" on the rig. */
export const THINK_CLIPS = ["thoughtful", "chin_scratch", "arms_folded", "head_nod"] as const;
export function pickThinkClip(): string {
  return THINK_CLIPS[Math.floor(Math.random() * THINK_CLIPS.length)];
}
