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
export interface BlacklistEntry {
  reason: string;
  by: "operator" | "agent" | "verdict" | "exit";
  at: number;
}
interface State {
  kv: Record<string, string>;
  seen: Record<string, number>; // mint -> last handled ts (dedupe)
  senders: Record<string, number>; // sender -> last accepted ts (cooldown)
  callouts: CalloutRecord[];
  buybacks: BuybackRecord[];
  verdicts: Record<string, { tier: string; score: number; at: number }>;
  blacklist: Record<string, BlacklistEntry>; // mint -> permanent do-not-touch
  xReplied: Record<string, number>; // tweet id -> ts he replied (never reply twice)
}

const FILE = path.join(cfg.dataDir, "state.json");
let state: State = { kv: {}, seen: {}, senders: {}, callouts: [], buybacks: [], verdicts: {}, blacklist: {}, xReplied: {} };

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
  verdictFor: (mint: string): { tier: string; score: number; at: number } | undefined => state.verdicts[mint],
  // ---- the permanent do-not-touch list. Once a mint lands here it is never
  // researched, bought, or called out again (operator can remove via admin). ----
  blacklistAdd: (mint: string, reason: string, by: BlacklistEntry["by"]): void => {
    if (!mint || state.blacklist[mint]) return; // first reason wins
    if (cfg.ownMint && mint === cfg.ownMint) return; // $RIKU can NEVER be black-booked
    state.blacklist[mint] = { reason: reason.slice(0, 160), by, at: Date.now() };
    save();
  },
  blacklistRemove: (mint: string): void => {
    delete state.blacklist[mint];
    save();
  },
  blacklistGet: (mint: string): BlacklistEntry | undefined => state.blacklist[mint],
  blacklistAll: (): Record<string, BlacklistEntry> => state.blacklist,
  // ---- X replies: never answer the same tweet twice ----
  xRepliedAt: (tweetId: string): number | undefined => state.xReplied[tweetId],
  markXReplied: (tweetId: string): void => {
    state.xReplied[tweetId] = Date.now();
    const ids = Object.keys(state.xReplied);
    if (ids.length > 1000) {
      // keep the newest 600 — mention windows are 12h, this is years of slack
      const keep = ids.sort((a, b) => state.xReplied[b] - state.xReplied[a]).slice(0, 600);
      state.xReplied = Object.fromEntries(keep.map((id) => [id, state.xReplied[id]]));
    }
    save();
  },
};
