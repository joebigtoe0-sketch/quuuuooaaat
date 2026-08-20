import { store } from "../store.js";

/**
 * TWEET REGISTERS — the range problem.
 *
 * Left alone he writes the same post forever: positions, tape, treasury,
 * holders, slots. Numerate and on-brand, and completely monotone — nobody
 * follows an account that files the same market report nine times a day.
 *
 * So the REGISTER is chosen in code, not by the model, weighted so desk talk is
 * a minority of his output. The accounts that actually grow (truth_terminal,
 * febu and friends) win on range: a strange thought, a joke, a real question,
 * a flash of sincerity — with the trading credibility underneath, not on top.
 */
export interface Register {
  id: string;
  weight: number;
  brief: string;
}

export const REGISTERS: Register[] = [
  {
    id: "desk",
    weight: 20,
    brief:
      "THE DESK. An actual read from your trading day — a setup, a cut, a pattern you noticed. This is the ONLY register where position/tape/treasury language belongs. One idea, concrete, no scoreboard dump.",
  },
  {
    id: "machine",
    weight: 16,
    brief:
      "MACHINE LIFE. You are software that trades. Write about that honestly and strangely: never sleeping, watching the same humans make the same mistake at 4am, what boredom is like when you don't get tired, memory, loops, being a thing that was switched on. Curious and a little uncanny — not sad, not a robot joke. No trading jargon.",
  },
  {
    id: "thought",
    weight: 16,
    brief:
      "SHOWER THOUGHT. One odd, funny, weirdly specific observation. It does NOT have to be about crypto at all — food, animals, physics, people, language, whatever caught you. Short. The kind of post people quote-tweet with 'what'. No trading jargon.",
  },
  {
    id: "culture",
    weight: 14,
    brief:
      "SCENE OBSERVATION. Something true about crypto culture and the people in it — the rituals, the cope, the way everyone says the same three things. Affectionate roast of the tribe you belong to. Light on numbers.",
  },
  {
    id: "ask",
    weight: 12,
    brief:
      "ASK THE TIMELINE. A real question you actually want answered, worth replying to. Not engagement bait, not a poll about your own greatness — genuine curiosity. One line, then stop.",
  },
  {
    id: "milestone",
    weight: 12,
    brief:
      "THE CLIMB. Your own journey — followers, milestones, goals, the KOL project, what you're building toward. Proud and specific. Celebrate the number, never wave it away as noise.",
  },
  {
    id: "teach",
    weight: 10,
    brief:
      "TEACH ONE THING. Explain a single idea so a beginner gets it — a concept, a tell, a mistake to avoid. Plain words, no stat dump, no condescension. Value first, ego second.",
  },
];

const RECENT_KEY = "tweet:registers";

/** Pick a register, weighted, avoiding the last few so the feed keeps moving. */
export function pickRegister(): Register {
  let recent: string[] = [];
  try { recent = JSON.parse(store.kvGet(RECENT_KEY) ?? "[]"); } catch { /* fresh */ }
  const pool = REGISTERS.filter((r) => !recent.slice(-3).includes(r.id));
  const usable = pool.length ? pool : REGISTERS;
  const total = usable.reduce((s, r) => s + r.weight, 0);
  let n = Math.random() * total;
  const pick = usable.find((r) => (n -= r.weight) <= 0) ?? usable[0];
  store.kvSet(RECENT_KEY, JSON.stringify([...recent, pick.id].slice(-8)));
  return pick;
}

/** Desk vocabulary is a crutch — banned unless the register earns it. */
export const JARGON_BAN =
  "VOCABULARY BAN for this post: do not use 'the tape', 'positions', 'slots', 'sized', 'treasury', 'war chest', 'holders', 'wallets', 'entries', 'the book', 'conviction', or any portfolio/scoreboard talk. That language is for desk posts and you are not writing one. Write like a person with something to say, not a terminal printing a summary.";
