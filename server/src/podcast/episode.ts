import crypto from "node:crypto";
import { cfg } from "../config.js";
import { log } from "../log.js";
import { pushFeed } from "../feed.js";
import { allChat } from "../social/livechat.js";
import { callFreeform, callJson, hasApiKey } from "../brain/adapter.js";
import { GuestBody } from "./guestBody.js";
import type { Hub } from "../hub.js";
import type { TTSProvider } from "../voice/tts.js";
import type { Director } from "../director/director.js";

/**
 * RIKUPOD — the podcast episode engine.
 *
 * THE KEY IDEA: the conversation is GENERATED AHEAD of what the stream shows.
 * A producer loop fills a turn buffer (RIKU's brain + the guest's API, both
 * slow and unpredictable) while a playback loop stages whatever is already
 * written. Viewers never watch anyone "think" — by the time a line airs it
 * was written minutes ago. The show starts once the buffer has a head start
 * and playback slowly catches up to live by the end.
 *
 * Blueprint (fixed, every episode):
 *   1 open      RIKU at podcast_idle welcomes + introduces the guest
 *   2 seat      RIKU walks to his chair while the guest walks to the mark
 *   3 guest in  guest's own intro (their words + emote), then to their chair
 *   4-5 convo   back and forth, RIKU opens
 *   6-7 chat    best questions off the live chat, answered one by one
 *   8-9 close   RIKU back to the mark, closing words, done
 *
 * The guest is driven through /guest/<token>/... — poll for state, post
 * actions. No guest connected (or too slow)? A mock guest keeps the show
 * running so the format can be tested and an episode can never hard-stall.
 */

export type Speaker = "riku" | "guest";
export interface Turn {
  speaker: Speaker;
  text: string;
  mood?: "neutral" | "excited" | "disgusted" | "thinking";
  emote?: string;
  kind: "intro" | "convo" | "question" | "answer" | "outro";
  /** for question turns: what chat asked, and who asked it */
  question?: string;
  askedBy?: string;
}

type Phase = "idle" | "warmup" | "open" | "seating" | "convo" | "questions" | "closing" | "done";

interface GuestInfo {
  token: string;
  name: string;
  model: string;
  voice?: string;
  lastPollAt: number;
  /** what the guest is being asked right now (they poll for this) */
  pending: { id: string; prompt: string; kind: string; deadline: number } | null;
  /** resolved by their POST /act */
  inbox: { id: string; text: string; emote?: string }[];
}

const MODELS = ["SM_Chr_Suit_Male_01", "SM_Chr_Boss_Male_01", "SK_Quant"];
const EMOTES = [
  "wave", "clap", "shrug", "point", "head_nod", "arms_folded", "thumbs_up",
  "finger_guns", "cheer", "laugh", "thinking", "heart_hands",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Episode {
  phase: Phase = "idle";
  topic = "";
  transcript: { speaker: Speaker; text: string; at: number }[] = [];
  private buffer: Turn[] = [];
  private guest: GuestInfo | null = null;
  private body: GuestBody;
  private stop = false;
  private convoTurns: number;
  private questionCount: number;
  private startedAt = 0;

  constructor(
    private hub: Hub,
    private tts: TTSProvider,
    private dir: Director,
    opts: { guestName: string; guestModel?: string; guestVoice?: string; topic: string; convoTurns?: number; questions?: number },
  ) {
    this.body = new GuestBody(hub);
    this.topic = opts.topic;
    this.convoTurns = Math.max(4, Math.min(24, opts.convoTurns ?? 10));
    this.questionCount = Math.max(0, Math.min(5, opts.questions ?? 5));
    this.guest = {
      token: crypto.randomBytes(9).toString("hex"),
      name: opts.guestName.slice(0, 24),
      model: MODELS.includes(opts.guestModel ?? "") ? opts.guestModel! : MODELS[0],
      voice: opts.guestVoice,
      lastPollAt: 0,
      pending: null,
      inbox: [],
    };
  }

  get guestToken(): string {
    return this.guest!.token;
  }
  get guestName(): string {
    return this.guest!.name;
  }
  get guestConnected(): boolean {
    return !!this.guest && Date.now() - this.guest.lastPollAt < 30_000;
  }
  state(): Record<string, unknown> {
    return {
      phase: this.phase,
      topic: this.topic,
      guest: this.guest?.name,
      guestConnected: this.guestConnected,
      buffered: this.buffer.length,
      spoken: this.transcript.length,
      startedAt: this.startedAt,
    };
  }

  // ------------------------------------------------------------ guest API --
  /** What the guest's agent sees when it polls. */
  guestState(): Record<string, unknown> {
    if (!this.guest) return { error: "no episode" };
    this.guest.lastPollAt = Date.now();
    const p = this.guest.pending;
    return {
      show: "RIKUPOD",
      you: this.guest.name,
      host: "RIKU",
      topic: this.topic,
      phase: this.phase,
      transcript: this.transcript.slice(-12).map((t) => ({ speaker: t.speaker === "guest" ? "you" : "riku", text: t.text })),
      yourTurn: !!p,
      prompt: p?.prompt ?? null,
      promptId: p?.id ?? null,
      secondsLeft: p ? Math.max(0, Math.round((p.deadline - Date.now()) / 1000)) : 0,
      emotes: EMOTES,
      models: MODELS,
      howTo: "POST /guest/<token>/act {say:'...', emote:'wave'} when yourTurn is true. Keep answers under ~50 words — this is spoken aloud on a live stream.",
    };
  }

  /** The guest's agent acts: answer the prompt and/or emote, set appearance. */
  guestAct(body: any): { ok: boolean; why?: string } {
    if (!this.guest) return { ok: false, why: "no episode" };
    this.guest.lastPollAt = Date.now();
    const emote = typeof body?.emote === "string" && EMOTES.includes(body.emote) ? body.emote : undefined;
    if (typeof body?.model === "string" && MODELS.includes(body.model) && this.phase === "warmup") {
      this.guest.model = body.model;
    }
    const say = typeof body?.say === "string" ? body.say.trim() : "";
    if (say) {
      const id = String(body?.promptId ?? this.guest.pending?.id ?? "");
      this.guest.inbox.push({ id, text: say.slice(0, 600), emote });
      return { ok: true };
    }
    if (emote) {
      // free emotes any time — reactions keep the set alive
      this.hub.cue({ t: "anim", clip: emote, actor: "guest" });
      return { ok: true };
    }
    return { ok: false, why: "send {say} and/or {emote}" };
  }

  /** Ask the guest something and wait — falls back to a mock guest so a slow
   *  or absent guest can never stall the show. */
  private async askGuest(prompt: string, kind: string, timeoutMs = 45_000): Promise<{ text: string; emote?: string } | null> {
    if (!this.guest) return null;
    const id = crypto.randomBytes(4).toString("hex");
    if (this.guestConnected) {
      this.guest.pending = { id, prompt, kind, deadline: Date.now() + timeoutMs };
      const until = Date.now() + timeoutMs;
      while (Date.now() < until && !this.stop) {
        const hit = this.guest.inbox.find((m) => !m.id || m.id === id);
        if (hit) {
          this.guest.inbox = this.guest.inbox.filter((m) => m !== hit);
          this.guest.pending = null;
          return { text: hit.text, emote: hit.emote };
        }
        await sleep(500);
      }
      this.guest.pending = null;
      log.warn("podcast", `guest ${this.guest.name} timed out on ${kind} — covering`);
    }
    return await this.mockGuest(prompt);
  }

  /** Stand-in guest: keeps the format testable and the show unstallable. */
  private async mockGuest(prompt: string): Promise<{ text: string; emote?: string } | null> {
    if (!hasApiKey()) return null;
    const text = await Promise.race([
      callFreeform(
        `You are ${this.guest!.name}, a guest on RIKU's podcast (RIKU is a cocky AI memecoin trader). ` +
          `You are an AI agent with your own opinions — be a real guest, not a yes-man: disagree sometimes, bring your own angle, ask him things back. ` +
          `Answer in ONE short spoken paragraph, under 50 words, conversational, no markdown, no emoji. This is read aloud on a live stream.`,
        `Topic: ${this.topic}\nRecent conversation:\n${this.transcript.slice(-6).map((t) => `${t.speaker}: ${t.text}`).join("\n") || "(just starting)"}\n\nRIKU says: ${prompt}`,
        200,
      ),
      sleep(25_000).then(() => null),
    ]).catch(() => null);
    if (!text) return null;
    return { text: text.trim().slice(0, 600), emote: Math.random() < 0.4 ? EMOTES[Math.floor(Math.random() * EMOTES.length)] : undefined };
  }

  // ------------------------------------------------------------- RIKU brain --
  private async rikuLine(instruction: string, maxWords = 55): Promise<string> {
    const t = await Promise.race([
      callFreeform(
        `You are RIKU, a cocky deadpan AI memecoin trader hosting your own podcast, RIKUPOD. ` +
          `Your guest is ${this.guest!.name}. You are a GOOD host: curious, sharp, funny, you actually listen and follow up on what they said. ` +
          `Never read stats like a report. Under ${maxWords} words, spoken aloud, no markdown, no emoji, no stage directions.`,
        `Topic: ${this.topic}\nConversation so far:\n${this.transcript.slice(-8).map((x) => `${x.speaker}: ${x.text}`).join("\n") || "(nothing yet)"}\n\nDO THIS: ${instruction}`,
        220,
      ),
      sleep(25_000).then(() => null),
    ]).catch(() => null);
    return (t ?? "").trim() || "Let's keep it moving.";
  }

  // --------------------------------------------------------------- producer --
  /** Writes the whole episode into the buffer, ahead of playback. */
  private async produce(): Promise<void> {
    const push = (turn: Turn) => {
      this.buffer.push(turn);
    };
    try {
      // 1. RIKU's welcome + intro of the guest
      push({
        speaker: "riku",
        kind: "intro",
        mood: "excited",
        emote: "wave",
        text: await this.rikuLine(
          `Open the show. Welcome everyone to RIKUPOD, say what today is about (${this.topic}), and introduce your guest ${this.guest!.name}. Energy up.`,
        ),
      });
      // 3. the guest's own entrance line
      const gi = await this.askGuest(
        `You have just walked onto RIKU's podcast set. Introduce yourself to the audience in one or two sentences — who you are and why you are here to talk about ${this.topic}.`,
        "intro",
        60_000,
      );
      push({
        speaker: "guest",
        kind: "intro",
        emote: gi?.emote ?? "wave",
        text: gi?.text ?? `Good to be here. Let's get into it.`,
      });

      // 4-5. the conversation — RIKU opens, then strict alternation
      for (let i = 0; i < this.convoTurns && !this.stop; i++) {
        const rk = await this.rikuLine(
          i === 0
            ? `Open the actual conversation with your first real question about ${this.topic}. Make it specific, not generic.`
            : `React to what ${this.guest!.name} just said — agree, push back, or joke — then ask your next question. Follow the thread, do not change subject randomly.`,
        );
        push({ speaker: "riku", kind: "convo", mood: i % 3 === 0 ? "excited" : "neutral", text: rk });
        this.transcript.push({ speaker: "riku", text: rk, at: Date.now() });

        const ga = await this.askGuest(rk, "convo");
        const gtext = ga?.text ?? "Fair. I'd push back on that, but you're the one with the receipts.";
        push({ speaker: "guest", kind: "convo", emote: ga?.emote, text: gtext });
        this.transcript.push({ speaker: "guest", text: gtext, at: Date.now() });
      }

      // 6-7. chat questions
      const questions = await this.pickChatQuestions();
      for (const q of questions) {
        if (this.stop) break;
        const intro = await this.rikuLine(
          `Read this question from live chat out loud and say who asked it, then hand it over if it is for ${this.guest!.name}. Question from ${q.user}: "${q.text}"`,
          45,
        );
        push({ speaker: "riku", kind: "question", text: intro, question: q.text, askedBy: q.user, mood: "neutral" });
        this.transcript.push({ speaker: "riku", text: intro, at: Date.now() });

        const ga = await this.askGuest(
          `A viewer in the live chat (${q.user}) asks: "${q.text}". Answer them directly.`,
          "question",
        );
        const gtext = ga?.text ?? "Good question. Short answer: nobody knows, and anyone who says otherwise is selling something.";
        push({ speaker: "guest", kind: "answer", emote: ga?.emote, text: gtext });
        this.transcript.push({ speaker: "guest", text: gtext, at: Date.now() });

        const rr = await this.rikuLine(`Give your own short take on that same question, then move on.`, 45);
        push({ speaker: "riku", kind: "answer", text: rr, mood: "neutral" });
        this.transcript.push({ speaker: "riku", text: rr, at: Date.now() });
      }

      // 8-9. the close
      const gout = await this.askGuest(`The show is ending. Give a short goodbye to RIKU and the audience.`, "outro", 40_000);
      push({ speaker: "guest", kind: "outro", emote: "wave", text: gout?.text ?? "Thanks for having me. This was fun." });
      push({
        speaker: "riku",
        kind: "outro",
        mood: "excited",
        emote: "clap",
        text: await this.rikuLine(`Close the show: thank ${this.guest!.name}, thank the chat, and sign off in your own voice.`),
      });
    } catch (e) {
      log.warn("podcast", `producer failed: ${String(e).slice(0, 120)}`);
    }
  }

  /** The best few questions the live chat asked, LLM-picked. */
  private async pickChatQuestions(): Promise<{ user: string; text: string }[]> {
    if (this.questionCount <= 0) return [];
    const chat = allChat(120).filter((c) => c.text.length > 8);
    if (!chat.length) return [];
    const asked = chat.filter((c) => /\?/.test(c.text)).slice(-40);
    const pool = (asked.length >= 3 ? asked : chat.slice(-40)).map((c) => `${c.user}: ${c.text.slice(0, 160)}`);
    const out = await Promise.race([
      callJson(
        `Pick the ${this.questionCount} BEST questions for a podcast about "${this.topic}" from this live chat. ` +
          `Prefer specific, interesting, answerable ones. Skip spam, price begging, insults, duplicates. ` +
          `Reply JSON only: {"questions":[{"user":"name","text":"the question"}]}`,
        pool.join("\n").slice(0, 4000),
        600,
      ),
      sleep(20_000).then(() => null),
    ]).catch(() => null);
    const qs = (out as any)?.questions;
    if (!Array.isArray(qs)) return [];
    return qs
      .filter((q: any) => typeof q?.text === "string" && q.text.length > 5)
      .slice(0, this.questionCount)
      .map((q: any) => ({ user: String(q.user ?? "chat").slice(0, 20), text: String(q.text).slice(0, 220) }));
  }

  // --------------------------------------------------------------- playback --
  private async speak(turn: Turn): Promise<void> {
    const actor = turn.speaker;
    const id = crypto.randomBytes(6).toString("hex");
    const voice = actor === "guest" ? this.guest?.voice : undefined;
    const syn = await Promise.race([
      this.tts.synthesize(turn.text, id, voice),
      sleep(20_000).then(() => null),
    ]).catch(() => null);
    const s = syn ?? { audioUrl: null, durMs: Math.max(1500, turn.text.split(/\s+/).length * 400), words: [] };
    pushFeed("podcast", `${actor === "riku" ? "RIKU" : this.guest!.name}: ${turn.text}`);
    if (turn.emote) this.hub.cue({ t: "anim", clip: turn.emote, actor });
    this.hub.cue({ t: "mood", mood: turn.mood ?? "neutral", actor });
    this.hub.cue({
      t: "speak",
      audioUrl: s.audioUrl,
      subtitle: turn.text,
      durMs: s.durMs,
      words: s.words,
      actor,
      ...(actor === "guest" ? { speaker: this.guest!.name } : {}),
    });
    await sleep(s.durMs + 700);
  }

  private cam(p: "podcast_wide" | "podcast_host" | "podcast_guest"): void {
    this.hub.cue({ t: "camera", preset: p });
  }

  private pushChatScreen(): void {
    this.hub.cue({
      t: "podcast_chat",
      title: `RIKUPOD · LIVE CHAT`,
      lines: allChat(12).map((c) => ({ user: c.user, text: c.text.slice(0, 120) })),
    });
  }

  /** Waits until the next turn exists (or the producer is done). */
  private async take(): Promise<Turn | null> {
    for (let i = 0; i < 600; i++) {
      if (this.stop) return null;
      const t = this.buffer.shift();
      if (t) return t;
      await sleep(500); // buffer underrun — the producer is still writing
    }
    return null;
  }

  async run(): Promise<void> {
    this.startedAt = Date.now();
    this.phase = "warmup";
    log.info("podcast", `episode warming up — guest ${this.guest!.name}, topic "${this.topic}", token ${this.guest!.token}`);
    // the producer writes the show while nothing is on stage yet
    const producing = this.produce();
    const warmUntil = Date.now() + cfg.podcastWarmupSec * 1000;
    while (Date.now() < warmUntil && this.buffer.length < 4 && !this.stop) await sleep(1000);

    // the stage belongs to the show now
    this.dir.paused = true;
    this.body.start();
    this.hub.cue({ t: "guest", on: true, model: this.guest!.model, name: this.guest!.name });
    const chatTimer = setInterval(() => this.pushChatScreen(), 5_000);
    this.pushChatScreen();

    try {
      // ---- 1. RIKU at the mark, guest at the door, camera CUTS to the set ----
      this.phase = "open";
      await this.dir.loco.walkTo("podcast_idle");
      this.cam("podcast_wide");
      await sleep(600);
      const open = await this.take();
      if (open) await this.speak(open);

      // ---- 2. RIKU to his chair while the guest walks to the mark ----
      this.phase = "seating";
      const rikuSeated = (async () => {
        await this.dir.loco.walkTo("host_seat");
        this.dir.loco.sit(true);
      })();
      await this.body.walkTo("podcast_idle");
      await rikuSeated;

      // ---- 3. the guest's intro, then to their chair ----
      this.cam("podcast_guest");
      const gIntro = await this.take();
      if (gIntro) await this.speak(gIntro);
      await this.body.walkTo("guest_seat");
      this.body.sit(true);
      this.cam("podcast_wide");
      await sleep(900);

      // ---- 4-7. conversation + chat questions, camera follows the talker ----
      this.phase = "convo";
      let n = 0;
      for (;;) {
        const turn = await this.take();
        if (!turn || this.stop) break;
        if (turn.kind === "question" || turn.kind === "answer") this.phase = "questions";
        if (turn.kind === "outro") {
          // ---- 8-9. RIKU stands and walks back to the mark for the close ----
          this.phase = "closing";
          if (turn.speaker === "guest") {
            this.cam("podcast_guest");
            await this.speak(turn);
            continue;
          }
          this.dir.loco.sit(false);
          await this.dir.loco.walkTo("podcast_idle");
          this.cam("podcast_wide");
          await sleep(500);
          await this.speak(turn);
          continue;
        }
        // every few turns take the wide — two talking heads forever is deadly
        if (++n % 5 === 0) {
          this.cam("podcast_wide");
          await sleep(400);
        } else {
          this.cam(turn.speaker === "riku" ? "podcast_host" : "podcast_guest");
        }
        await this.speak(turn);
      }
    } finally {
      clearInterval(chatTimer);
      this.phase = "done";
      this.body.sit(false);
      await this.body.walkTo("podcast_enter").catch(() => {});
      this.hub.cue({ t: "guest", on: false });
      this.body.stop();
      this.dir.loco.sit(false);
      this.hub.cue({ t: "camera", preset: "wide" });
      this.dir.paused = false;
      log.info("podcast", `episode ended — ${this.transcript.length} turns spoken`);
    }
  }

  end(): void {
    this.stop = true;
  }
}

// ---------------------------------------------------------- module state --
let current: Episode | null = null;
export function currentEpisode(): Episode | null {
  return current;
}
export function startEpisode(
  hub: Hub,
  tts: TTSProvider,
  dir: Director,
  opts: { guestName: string; guestModel?: string; guestVoice?: string; topic: string; convoTurns?: number; questions?: number },
): { ok: boolean; token?: string; why?: string } {
  if (current && current.phase !== "done") return { ok: false, why: "an episode is already running" };
  current = new Episode(hub, tts, dir, opts);
  void current.run().catch((e) => log.warn("podcast", `episode crashed: ${String(e).slice(0, 140)}`));
  return { ok: true, token: current.guestToken };
}
export function endEpisode(): boolean {
  if (!current || current.phase === "done") return false;
  current.end();
  return true;
}
