// Mirror of server/src/protocol.ts (client-side copy; keep in sync).

export type StationId =
  | "idle_spot"
  | "inbox"
  | "terminal"
  | "bigscreen"
  | "vault"
  | "conveyor"
  | "camera_mark"
  | "greenscreen"
  | "tiktok";

export interface CheckRow {
  label: string;
  verdict: "pass" | "fail" | "warn" | "unknown";
  detail: string;
}
export type VerdictTier = "STRONG CALL" | "CALL" | "PASS" | "ROAST" | "DECLINE";

export interface InspectionState {
  mint: string | null;
  name: string;
  symbol: string;
  image?: string;
  sender?: string;
  source?: string; // 'sent by <addr>' | 'own find — digging deeper'
  rows: CheckRow[];
  score: number | null;
  tier: VerdictTier | null;
  headline?: string;
}
export interface TreasuryState {
  sol: number;
  ownTokens: number;
  buybacks: { sol: number; sig: string; at: number }[];
  neverSoldDays: number;
  holdings: { symbol: string; amount: number; paper?: boolean; image?: string; pnl?: number }[]; // full wallet vault (pnl = % vs entry)
}

/** Action ticker on the bigscreen: what the desk actually DID. */
export interface ActionEvent {
  kind: "CALL" | "BUY" | "SELL" | "RECEIVED" | "BUYBACK" | "AIRDROP" | "BURN";
  symbol: string;
  at: number;
}
export interface CalloutCard {
  mint: string;
  symbol: string;
  text: string;
  tier: string;
  at: number;
  mcNowSol?: number | null;
  entryMcSol?: number | null;
  dry?: boolean;
}
export interface ConveyorItem {
  mint: string;
  name: string;
  symbol: string;
  mcSol?: number;
  dev?: string; // creator wallet (from the launch feed)
  mayhem?: boolean; // house-rules curve flag straight off the launch message
  image?: string; // token image URL (ipfs gateway), for the coin face
}


/** Full-screen takeover of the research terminal for visual moments:
 *  the X composer while he types, the trade ticket while he trades. */
export type TakeoverView =
  | { kind: "compose"; text: string; typed: number; state: "typing" | "posted" | "drafted"; replyTo?: string }
  | { kind: "mention"; author: string; text: string }
  | { kind: "script"; title: string; lines: string[]; state: "running" | "done" | "error" }
  | {
      kind: "trade";
      side: "BUY" | "SELL";
      symbol: string;
      sol: number;
      thesis: string;
      state: "working" | "filled" | "failed";
    }
  // his graded caller index, shown when a caller-follow entry reveals
  | { kind: "leaderboard"; rows: { name: string; med: number; h2: number; calls: number }[]; highlight?: string }
  | {
      kind: "investdesk";
      symbol: string;
      name: string;
      mcUsd: number;
      liqUsd: number;
      vol24Usd: number;
      chg6hPct: number;
      ageDays: number;
      socials: string[];
      verdict: "buy" | "pass";
      conviction: number; // 1..5
      thesis: string;
      sizeSol: number | null; // set on buys
    };

export type Cue =
  | { t: "anim"; clip: string }
  | { t: "walk"; to: StationId; durMs: number }
  | { t: "speak"; audioUrl: string | null; subtitle: string; durMs: number; words?: { word: string; atMs: number }[] }
  | { t: "screen_inspection"; patch: Partial<InspectionState>; reset?: boolean }
  | { t: "screen_treasury"; state: TreasuryState }
  | { t: "screen_callouts"; cards: CalloutCard[] }
  | { t: "conveyor_add"; item: ConveyorItem }
  | { t: "conveyor_pick"; mint: string }
  | { t: "camera"; preset: "wide" | "terminal" | "facecam" | "vault" | "film" | "bigscreen" | "tiktok_front" | "tiktok_left" | "tiktok_right" }
  | { t: "fx"; kind: "stamp_rekt" | "stamp_called" | "confetti" | "ding" | "buzzer" }
  | { t: "mood"; mood: "neutral" | "excited" | "disgusted" | "thinking" }
  | { t: "record"; on: boolean; id: string }
  | { t: "tiktok"; on: boolean; mode?: "studio" | "facecam"; bg?: string; pace?: "chill" | "hype"; autocut?: boolean } // filming mode: burned subs, bg replace, client cut rhythm
  | { t: "selfie"; id: string; anim?: string; expr?: string }
  | { t: "feed"; entry: { at: number; kind: string; text: string } }
  | { t: "board"; lines: string[] }
  | { t: "actions"; list: ActionEvent[] }
  | { t: "takeover"; view: TakeoverView | null };

export interface TickMsg {
  t: "tick";
  x: number;
  z: number;
  heading: number;
  anim: string;
  seated: boolean;
  state: string;
}
export interface SnapshotMsg {
  t: "snapshot";
  now: number;
  inspection: InspectionState;
  treasury: TreasuryState;
  callouts: CalloutCard[];
  conveyor: ConveyorItem[];
  board: string[];
  actions: ActionEvent[];
  avatar: { x: number; z: number; heading: number; anim: string; seated: boolean };
  state: string;
}
export type ServerMsg = SnapshotMsg | TickMsg | { t: "cue"; cue: Cue; now: number };

// Station floor plan — mirror of server/src/stations.ts
export const STATIONS: Record<StationId, { x: number; z: number; face: number }> = {
  conveyor: { x: 0.0, z: -3.2, face: Math.PI },
  vault: { x: -4.2, z: -2.2, face: Math.PI },
  bigscreen: { x: -1.4, z: -2.4, face: Math.PI },
  inbox: { x: 3.6, z: -2.0, face: Math.PI },
  terminal: { x: 1.2, z: -0.6, face: Math.PI },
  idle_spot: { x: -0.6, z: 1.2, face: 0 },
  camera_mark: { x: 1.8, z: 1.6, face: 0 },
  greenscreen: { x: 5.6, z: 0.2, face: Math.PI / 2 },
  tiktok: { x: 6.5, z: 3.0, face: 0 },
};
