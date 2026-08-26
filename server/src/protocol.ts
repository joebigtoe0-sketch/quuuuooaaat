/**
 * Server → client protocol. The client is a dumb renderer: it applies
 * 10Hz avatar ticks and one-shot cues, and can rebuild everything from the
 * hello snapshot (OBS refresh mid-show must recover cleanly).
 */

export type StationId =
  | "idle_spot"
  | "inbox"
  | "terminal"
  | "bigscreen"
  | "vault"
  | "conveyor"
  | "camera_mark"
  | "greenscreen"
  | "tiktok"
  | "podcast_idle"
  | "podcast_enter"
  | "host_seat"
  | "guest_seat";

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
  ownTokens: number; // UI amount of own token held
  buybacks: { sol: number; sig: string; at: number }[];
  neverSoldDays: number;
  holdings: { symbol: string; amount: number; paper?: boolean; image?: string; pnl?: number }[]; // full wallet vault (pnl = % vs entry, bought bags only)
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
  // his graded caller index, shown when a caller-follow entry reveals —
  // the caller he followed gets the highlight row
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
  | { t: "anim"; clip: string; actor?: "riku" | "guest" }
  | { t: "walk"; to: StationId; durMs: number } // informational; positions come via tick
  | {
      t: "speak";
      audioUrl: string | null;
      subtitle: string;
      durMs: number;
      words?: { word: string; atMs: number }[];
      actor?: "riku" | "guest";
      speaker?: string; // display name under the subtitle (guest handle)
    }
  | { t: "screen_inspection"; patch: Partial<InspectionState>; reset?: boolean }
  | { t: "screen_treasury"; state: TreasuryState }
  | { t: "screen_callouts"; cards: CalloutCard[] }
  | { t: "conveyor_add"; item: ConveyorItem }
  | { t: "conveyor_pick"; mint: string }
  | { t: "camera"; preset: "wide" | "terminal" | "facecam" | "vault" | "film" | "bigscreen" | "tiktok_front" | "tiktok_left" | "tiktok_right" | "tiktok_face" | "podcast_wide" | "podcast_host" | "podcast_guest" }
  | { t: "fx"; kind: "stamp_rekt" | "stamp_called" | "confetti" | "ding" | "buzzer" }
  | { t: "mood"; mood: "neutral" | "excited" | "disgusted" | "thinking"; actor?: "riku" | "guest" }
  // ---- podcast: the second body + the chat TV ----
  | { t: "guest"; on: boolean; model?: string; name?: string }
  | { t: "guest_pose"; x: number; z: number; heading: number; anim: string; seated: boolean }
  | { t: "podcast_chat"; title: string; lines: { user: string; text: string }[] }
  | { t: "record"; on: boolean; id: string }
  | { t: "tiktok"; on: boolean; mode?: "studio" | "facecam"; bg?: string; pace?: "chill" | "hype"; autocut?: boolean; set?: "green" | "homeoffice" } // filming mode: burned subs, bg replace, client cut rhythm
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
  anim: string; // current locomotion loop: idle | walk
  seated: boolean;
  state: string; // director state name, for the debug HUD
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
