import fs from "node:fs";
import path from "node:path";
import { cfg } from "./config.js";

/**
 * One JSON file of show state. Small, human-readable, atomic writes
 * (tmp + rename) — the calloutbot convention, chosen over sqlite so a
 * Windows npm install never has to compile a native module.
 */
export interface CalloutRecord {
  mint: string;
  symbol: string;
  text: string;
  tier: string;
  at: number;
  dry: boolean;
  entryMcSol: number | null;
}
export interface BuybackRecord {
  sol: number;
  sig: string;
  at: number;
}
interface State {
  kv: Record<string, string>;
  seen: Record<string, number>; // mint -> last handled ts (dedupe)
  senders: Record<string, number>; // sender -> last accepted ts (cooldown)
  callouts: CalloutRecord[];
  buybacks: BuybackRecord[];
  verdicts: Record<string, { tier: string; score: number; at: number }>;
}

const FILE = path.join(cfg.dataDir, "state.json");
let state: State = { kv: {}, seen: {}, senders: {}, callouts: [], buybacks: [], verdicts: {} };

try {
  state = { ...state, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
} catch {
  /* first run */
}

let saveTimer: NodeJS.Timeout | null = null;
export function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      const tmp = FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
      fs.renameSync(tmp, FILE);
    } catch (e) {
      console.warn("[store] save failed:", e);
    }
  }, 250);
}

export const store = {
  kvGet: (k: string): string | undefined => state.kv[k],
  kvSet: (k: string, v: string): void => {
    state.kv[k] = v;
    save();
  },
  seenAt: (mint: string): number | undefined => state.seen[mint],
  markSeen: (mint: string): void => {
    state.seen[mint] = Date.now();
    save();
  },
  senderLastAt: (s: string): number | undefined => state.senders[s],
  markSender: (s: string): void => {
    state.senders[s] = Date.now();
    save();
  },
  addCallout: (r: CalloutRecord): void => {
    state.callouts.push(r);
    if (state.callouts.length > 200) state.callouts = state.callouts.slice(-200);
    save();
  },
  callouts: (): CalloutRecord[] => state.callouts,
  calloutsToday: (): number =>
    state.callouts.filter((c) => !c.dry && Date.now() - c.at < 86_400_000).length,
  addBuyback: (r: BuybackRecord): void => {
    state.buybacks.push(r);
    save();
  },
  buybacks: (): BuybackRecord[] => state.buybacks,
  buybackSolToday: (): number =>
    state.buybacks.filter((b) => Date.now() - b.at < 86_400_000).reduce((a, b) => a + b.sol, 0),
  setVerdict: (mint: string, tier: string, score: number): void => {
    state.verdicts[mint] = { tier, score, at: Date.now() };
    save();
  },
};
