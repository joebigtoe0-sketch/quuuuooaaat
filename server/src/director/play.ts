import type { Hub } from "../hub.js";
import type { Locomotion } from "./locomotion.js";
import type { Director } from "./director.js";
import type { StationId, VerdictTier, CheckRow } from "../protocol.js";
import { log } from "../log.js";
import { simT } from "../config.js";
import crypto from "node:crypto";

const STATIONS: StationId[] = [
  "idle_spot", "inbox", "terminal", "bigscreen", "vault", "conveyor", "camera_mark", "greenscreen", "tiktok",
  "podcast_idle", "podcast_enter", "host_seat", "guest_seat",
];

const SELFIE_ANIMS = [
  "phone_selfie", "pray", "flex_biceps", "two_thumbs", "heart_hands",
  "finger_guns", "salute", "thumbs_up", "dab", "hand_on_heart", "arms_folded",
];
const SELFIE_EXPRS = ["neutral", "happy", "sad", "angry", "smug", "shock", "thinking"];

export type PlayMood = "neutral" | "excited" | "disgusted" | "thinking";

export type PlayStep =
  | { do: "goto"; point: string }
  | { do: "camera"; preset: string }
  | { do: "sit"; on?: boolean }
  | { do: "say"; text: string; mood?: PlayMood }
  | { do: "anim"; clip: string }
  | { do: "fx"; kind: string }
  | {
      do: "inspect";
      mint?: string;
      name?: string;
      symbol?: string;
      score?: number;
      tier?: string;
      headline?: string;
      rows?: { label: string; verdict: string; detail: string }[];
    }
  | { do: "compose"; text: string; replyTo?: string }
  | { do: "callout"; text: string; symbol?: string }
  | { do: "think"; text?: string }
  | { do: "selfie"; anim?: string; expr?: string }
  | { do: "film"; spoken: string; dance?: boolean }
  // ---- tiktok studio (offline filming) ----
  | { do: "tiktok"; on: boolean; mode?: "studio" | "facecam"; bg?: string; pace?: "chill" | "hype"; autocut?: boolean; set?: "green" | "homeoffice" }
  | { do: "tiktokcam"; cam?: "front" | "left" | "right" | "face" }
  | { do: "record"; id: string; on: boolean }
  | { do: "wait"; ms: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, simT(ms)));

export async function runPlayScript(
  ctx: {
    hub: Hub;
    loco: Locomotion;
    dir: Director;
    speak: (text: string, mood?: PlayMood) => Promise<void>;
  },
  script: PlayStep[],
): Promise<void> {
  const { hub, loco, dir, speak } = ctx;
  loco.stateName = "PLAYBACK";
  try {
    for (const step of script) {
      if (!step || typeof (step as any).do !== "string") continue;
      switch (step.do) {
        case "goto": {
          const point = String(step.point ?? "");
          if ((STATIONS as string[]).includes(point)) await loco.walkTo(point as StationId);
          break;
        }
        case "camera": {
          hub.cue({ t: "camera", preset: String(step.preset ?? "wide") as any });
          await sleep(400);
          break;
        }
        case "sit": {
          loco.sit(step.on !== false);
          await sleep(300);
          break;
        }
        case "tiktok": {
          hub.cue({
            t: "tiktok", on: step.on !== false,
            ...(step.mode ? { mode: step.mode } : {}),
            ...(step.bg ? { bg: String(step.bg) } : {}),
            ...(step.pace ? { pace: step.pace } : {}),
            ...(step.autocut === false ? { autocut: false } : {}),
            ...(step.set ? { set: step.set } : {}),
          });
          await sleep(400);
          break;
        }
        case "tiktokcam": {
          hub.cue({ t: "camera", preset: ("tiktok_" + (step.cam ?? "front")) as any });
          await sleep(350);
          break;
        }
        case "record": {
          hub.cue({ t: "record", on: step.on !== false, id: String(step.id) });
          if (step.on !== false) await sleep(1000); // recorder warmup before action
          break;
        }
        case "wait": {
          await sleep(Math.min(15_000, Math.max(50, Number(step.ms) || 500)));
          break;
        }
        case "say": {
          const text = String(step.text ?? "").trim();
          if (text.length >= 2) await speak(text, step.mood ?? "neutral");
          break;
        }
        case "anim": {
          hub.cue({ t: "anim", clip: String(step.clip ?? "wave") });
          // short beat only — the emote keeps playing INTO the next line,
          // which reads natural; a full-clip wait was 2s of dead air per emote
          await sleep(450);
          break;
        }
        case "fx": {
          hub.cue({ t: "fx", kind: String(step.kind ?? "ding") as any });
          break;
        }
        case "inspect": {
          const rows: CheckRow[] = (step.rows ?? []).map((r) => ({
            label: String(r.label ?? "").slice(0, 40),
            verdict: (["pass", "fail", "warn", "unknown"].includes(r.verdict) ? r.verdict : "unknown") as CheckRow["verdict"],
            detail: String(r.detail ?? "").slice(0, 160),
          }));
          dir.inspection = {
            mint: step.mint ?? dir.inspection.mint,
            name: String(step.name ?? dir.inspection.name ?? ""),
            symbol: String(step.symbol ?? dir.inspection.symbol ?? ""),
            rows,
            score: typeof step.score === "number" ? step.score : dir.inspection.score,
            tier: (step.tier as VerdictTier) ?? dir.inspection.tier,
            headline: step.headline,
          };
          hub.cue({ t: "screen_inspection", reset: true, patch: dir.inspection });
          await sleep(600);
          for (let i = 1; i <= rows.length; i++) {
            hub.cue({ t: "screen_inspection", patch: { rows: rows.slice(0, i) } });
            await sleep(380);
          }
          break;
        }
        case "compose": {
          const text = String(step.text ?? "").trim();
          if (text.length < 2) break;
          await loco.walkTo("terminal");
          loco.sit(true);
          hub.cue({ t: "camera", preset: "terminal" });
          await sleep(400);
          const iterations = Math.min(22, Math.max(4, Math.ceil(text.length / 13)));
          const stepN = Math.max(1, Math.ceil(text.length / iterations));
          for (let typed = stepN; typed < text.length + stepN; typed += stepN) {
            hub.cue({
              t: "takeover",
              view: {
                kind: "compose",
                text,
                typed: Math.min(typed, text.length),
                state: "typing",
                ...(step.replyTo ? { replyTo: String(step.replyTo) } : {}),
              },
            });
            await sleep(420);
          }
          hub.cue({
            t: "takeover",
            view: {
              kind: "compose",
              text,
              typed: text.length,
              state: "posted",
              ...(step.replyTo ? { replyTo: String(step.replyTo) } : {}),
            },
          });
          hub.cue({ t: "fx", kind: "ding" });
          await sleep(2200);
          hub.cue({ t: "takeover", view: null });
          break;
        }
        case "think": {
          const text = String(step.text ?? "").trim();
          if (text.length >= 2) {
            const { pushFeed } = await import("../feed.js");
            const { pickThinkClip } = await import("./thoughts.js");
            hub.cue({ t: "mood", mood: "thinking" });
            hub.cue({ t: "anim", clip: pickThinkClip() });
            pushFeed("thought", text);
            await sleep(2200);
          } else {
            hub.cue({ t: "mood", mood: "thinking" });
            const clips = ["chin_scratch", "arms_folded", "weight_shift"];
            hub.cue({ t: "anim", clip: clips[Math.floor(Math.random() * clips.length)] });
            await sleep(2200);
          }
          break;
        }
        case "callout": {
          const text = String(step.text ?? "").trim();
          const symbol = String(step.symbol ?? "").trim();
          await loco.walkTo("bigscreen");
          hub.cue({ t: "camera", preset: "bigscreen" });
          loco.sit(true);
          await sleep(700);
          hub.cue({ t: "anim", clip: "point" });
          hub.cue({ t: "fx", kind: "stamp_called" });
          await sleep(400);
          if (text) await speak(symbol ? `$${symbol}. ${text}` : text, "excited");
          break;
        }
        case "selfie": {
          const anim = SELFIE_ANIMS.includes(String(step.anim ?? "")) ? String(step.anim) : "phone_selfie";
          const expr = SELFIE_EXPRS.includes(String(step.expr ?? "")) ? String(step.expr) : "happy";
          await loco.walkTo("idle_spot");
          loco.sit(false);
          await sleep(400);
          const id = `selfie_${Date.now()}`;
          hub.cue({ t: "selfie", id, anim, expr });
          await sleep(4500);
          break;
        }
        case "film": {
          const spoken = String(step.spoken ?? "").trim();
          if (spoken.length < 2) break;
          await loco.walkTo("greenscreen");
          hub.cue({ t: "camera", preset: "film" });
          await sleep(600);
          const clipId = crypto.randomBytes(6).toString("hex");
          hub.cue({ t: "record", on: true, id: clipId });
          await sleep(700);
          if (step.dance) {
            const d = ["dance", "dance2", "dance3", "dance4"][Math.floor(Math.random() * 4)];
            hub.cue({ t: "anim", clip: d });
          }
          await speak(spoken, "excited");
          if (step.dance) await sleep(2500);
          await sleep(500);
          hub.cue({ t: "record", on: false, id: clipId });
          break;
        }
        default:
          log.warn("play", `unknown step ${(step as any).do}`);
      }
    }
  } finally {
    hub.cue({ t: "takeover", view: null });
    loco.sit(false);
    hub.cue({ t: "camera", preset: "wide" });
    loco.stateName = "IDLE";
  }
}

export function sanitizeScript(raw: unknown): PlayStep[] {
  if (!Array.isArray(raw)) return [];
  const out: PlayStep[] = [];
  for (const s of raw.slice(0, 40)) {
    if (!s || typeof s !== "object" || typeof (s as any).do !== "string") continue;
    const do_ = String((s as any).do);
    if (!["goto", "camera", "sit", "say", "anim", "fx", "inspect", "compose", "callout", "think", "selfie", "film", "tiktok", "tiktokcam", "record", "wait"].includes(do_)) continue;
    out.push(s as PlayStep);
  }
  return out;
}
