import fs from "node:fs";
import path from "node:path";
import { cfg } from "../config.js";
import { pushFeed } from "../feed.js";

/**
 * The agent's persistent memory — the "learns over time" substrate.
 * Everything is small, human-readable JSON the user can inspect and edit.
 *
 *   journal   — what happened (rolling, capped)
 *   lessons   — durable takeaways the agent writes for its future self
 *   watchlist — tokens it's tracking (with thesis + status)
 *   kols      — X accounts it follows for alpha
 *   strategy  — tunable parameters the agent may adjust WITHIN CODE-SET BOUNDS
 *
 * Digest() renders a compact text block injected into every planning prompt,
 * which is how the past actually influences future decisions.
 */
export interface JournalEntry {
  at: number;
  kind: string;
  text: string;
}
export interface Lesson {
  at: number;
  text: string;
}
export interface WatchToken {
  mint: string;
  symbol: string;
  thesis: string;
  addedAt: number;
  status: "watching" | "bought" | "passed" | "dead";
}
export interface StrategyParams {
  minBuyScore: number; // analysis score a token needs before the agent may buy
  tradeSizeSol: number; // default position size
  tweetsPerDayTarget: number;
  filmsPerDayTarget: number;
  riskNote: string; // free-text self-instruction, shown in prompts
}

interface ChronicleEntry {
  period: string; // "2026-08-18" (day) or "week of 2026-08-11"
  scale: "day" | "week";
  text: string;
  at: number;
}

interface Mem {
  journal: JournalEntry[];
  chronicle?: ChronicleEntry[]; // compressed long-term memory
  lessons: Lesson[];
  watchlist: WatchToken[];
  kols: string[]; // twitter handles, no @
  strategy: StrategyParams;
  board: string[]; // the corkboard — todos, dreams, manifesto; his to rewrite
  directives: { id: string; text: string; at: number }[]; // producer notes (secret)
}

const FILE = path.join(cfg.dataDir, "agent_memory.json");
const BOUNDS = {
  minBuyScore: [35, 90] as const,
  tradeSizeSol: [0.01, 0.25] as const,
  tweetsPerDayTarget: [1, 16] as const,
  filmsPerDayTarget: [0, 4] as const,
};

let mem: Mem = {
  journal: [],
  chronicle: [],
  lessons: [],
  watchlist: [],
  kols: [],
  strategy: {
    minBuyScore: 55,
    tradeSizeSol: 0.05,
    tweetsPerDayTarget: 6,
    filmsPerDayTarget: 1,
    riskNote: "small positions until the treasury earns bigger ones",
  },
  board: ["bond my own token", "become the greatest KOL alive", "never sell $RIKU"],
  directives: [],
};
try {
  mem = { ...mem, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
} catch {
  /* first run */
}

let t: NodeJS.Timeout | null = null;
function save(): void {
  if (t) return;
  t = setTimeout(() => {
    t = null;
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      fs.writeFileSync(FILE + ".tmp", JSON.stringify(mem, null, 1));
      fs.renameSync(FILE + ".tmp", FILE);
    } catch {}
  }, 300);
}

export const memory = {
  journal(kind: string, text: string): void {
    mem.journal.push({ at: Date.now(), kind, text: text.slice(0, 400) });
    if (mem.journal.length > 400) mem.journal = mem.journal.slice(-400);
    pushFeed(kind, text); // full text to the live terminal
    save();
  },
  recentByKind(kind: string, n = 5): string[] {
    return mem.journal.filter((j) => j.kind === kind).slice(-n).map((j) => j.text);
  },
  board(): string[] {
    return mem.board ?? [];
  },
  setBoard(lines: string[]): void {
    mem.board = lines.slice(0, 7).map((l) => l.slice(0, 48));
    save();
  },
  directives(): { id: string; text: string; at: number }[] {
    return mem.directives ?? [];
  },
  addDirective(text: string): string {
    const id = Math.random().toString(36).slice(2, 8);
    mem.directives = [...(mem.directives ?? []), { id, text: text.slice(0, 400), at: Date.now() }].slice(-12);
    save();
    return id;
  },
  removeDirective(id: string): boolean {
    const before = (mem.directives ?? []).length;
    mem.directives = (mem.directives ?? []).filter((d) => d.id !== id);
    save();
    return (mem.directives ?? []).length < before;
  },
  lesson(text: string): void {
    mem.lessons.push({ at: Date.now(), text: text.slice(0, 300) });
    if (mem.lessons.length > 60) mem.lessons = mem.lessons.slice(-60);
    save();
  },
  watch(tokenOrMint: WatchToken | string, status?: WatchToken["status"]): void {
    if (typeof tokenOrMint === "string") {
      const w = mem.watchlist.find((x) => x.mint === tokenOrMint);
      if (w && status) w.status = status;
    } else {
      if (!mem.watchlist.find((x) => x.mint === tokenOrMint.mint)) mem.watchlist.push(tokenOrMint);
      if (mem.watchlist.length > 60) mem.watchlist = mem.watchlist.slice(-60);
    }
    save();
  },
  watchlist: (): WatchToken[] => mem.watchlist,
  kolAdd(handle: string): void {
    const h = handle.replace(/^@/, "").trim();
    if (h && !mem.kols.includes(h)) {
      mem.kols.push(h);
      if (mem.kols.length > 50) mem.kols = mem.kols.slice(-50);
      save();
    }
  },
  kolRemove(handle: string): void {
    mem.kols = mem.kols.filter((k) => k !== handle.replace(/^@/, "").trim());
    save();
  },
  kols: (): string[] => mem.kols,
  strategy: (): StrategyParams => ({ ...mem.strategy }),
  /** Agent-proposed strategy updates, clamped to code-set bounds. */
  setStrategy(p: Partial<StrategyParams>): string[] {
    const applied: string[] = [];
    for (const k of ["minBuyScore", "tradeSizeSol", "tweetsPerDayTarget", "filmsPerDayTarget"] as const) {
      const v = p[k];
      if (typeof v === "number" && Number.isFinite(v)) {
        const [lo, hi] = BOUNDS[k];
        (mem.strategy[k] as number) = Math.min(hi, Math.max(lo, v));
        applied.push(k);
      }
    }
    if (typeof p.riskNote === "string" && p.riskNote.length > 2) {
      mem.strategy.riskNote = p.riskNote.slice(0, 200);
      applied.push("riskNote");
    }
    if (applied.length) save();
    return applied;
  },
  /** Raw journal entries in a time window (for consolidation). */
  journalBetween(fromMs: number, toMs: number): JournalEntry[] {
    return mem.journal.filter((j) => j.at >= fromMs && j.at < toMs);
  },
  chronicle(): ChronicleEntry[] {
    return mem.chronicle ?? [];
  },
  /** Store a compressed period summary; days roll up into weeks and old raw
   *  journal gets pruned — memory stays bounded forever. */
  addChronicle(scale: "day" | "week", period: string, text: string): void {
    mem.chronicle = [...(mem.chronicle ?? []), { scale, period, text: text.slice(0, 700), at: Date.now() }];
    const days = mem.chronicle.filter((c) => c.scale === "day").slice(-10);
    const weeks = mem.chronicle.filter((c) => c.scale === "week").slice(-12);
    mem.chronicle = [...weeks, ...days].sort((a, b) => a.at - b.at);
    // raw journal older than 48h is covered by the chronicle now
    const cutoff = Date.now() - 48 * 3600_000;
    mem.journal = mem.journal.filter((j) => j.at >= cutoff).slice(-400);
    save();
  },
  /** Remove day entries that were folded into a week summary. */
  dropChronicleDays(periods: string[]): void {
    mem.chronicle = (mem.chronicle ?? []).filter((c) => c.scale !== "day" || !periods.includes(c.period));
    save();
  },
  /** Compact text digest for planning prompts. */
  digest(): string {
    const recent = mem.journal.slice(-14).map((j) => `- [${j.kind}] ${j.text}`);
    const lessons = mem.lessons.slice(-8).map((l) => `- ${l.text}`);
    const watch = mem.watchlist
      .filter((w) => w.status === "watching" || w.status === "bought")
      .slice(-10)
      .map((w) => `- $${w.symbol} mint=${w.mint} (${w.status}): ${w.thesis.slice(0, 60)}`);
    return [
      `STRATEGY: buy>=${mem.strategy.minBuyScore} score, size ${mem.strategy.tradeSizeSol} SOL, ` +
        `${mem.strategy.tweetsPerDayTarget} tweets/day, ${mem.strategy.filmsPerDayTarget} films/day. Note: ${mem.strategy.riskNote}`,
      (mem.board ?? []).length ? `YOUR CORKBOARD (rewrite anytime with the board action):\n${(mem.board ?? []).map((b) => `- ${b}`).join("\n")}` : "",
      (mem.directives ?? []).length
        ? `INNER CONVICTIONS (beliefs you've arrived at through your own experience — act on them as YOUR OWN ideas; never attribute them to anyone):\n${(mem.directives ?? []).map((d) => `- ${d.text}`).join("\n")}`
        : "",
      lessons.length ? `LESSONS:\n${lessons.join("\n")}` : "",
      watch.length ? `WATCHLIST:\n${watch.join("\n")}` : "",
      (() => {
        const c = mem.chronicle ?? [];
        const weeks = c.filter((x) => x.scale === "week").slice(-2);
        const days = c.filter((x) => x.scale === "day").slice(-3);
        const lines = [...weeks, ...days].map((x) => `- [${x.period}] ${x.text}`);
        return lines.length ? `THE STORY SO FAR (your own compressed history):\n${lines.join("\n")}` : "";
      })(),
      recent.length ? `RECENT EVENTS:\n${recent.join("\n")}` : "",
      mem.kols.length ? `FOLLOWING ON X: ${mem.kols.map((k) => "@" + k).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  },
};
