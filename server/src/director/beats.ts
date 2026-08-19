import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";
import { store } from "../store.js";
import type { Hub } from "../hub.js";
import type { Locomotion } from "./locomotion.js";
import type { Director } from "./director.js";
import { analyze, type Analysis } from "../analysis/engine.js";
import { verdictPrompt, mutterPrompt, commentaryPrompt } from "../brain/prompts.js";
import { callJson, callFreeform, FRAGMENT_MODEL } from "../brain/adapter.js";
import { mockVerdict, mockMutter, mockCommentary } from "../brain/mock.js";
import { calloutPreflight, calloutCapReached, executeCallout } from "../callout/post.js";
import { doBuyback, unallocatedSol, ownMcStats } from "../chain/buyback.js";
import type { TTSProvider } from "../voice/tts.js";
import { cfg, simT } from "../config.js";
import { memory } from "../agent/memory.js";
import { bumpDaily, snapshotKPIs, kpiText } from "../agent/goals.js";
import { postTweet, uploadVideo, readUserTweets, xReady } from "../social/x.js";
import { scoutAll } from "../social/scout.js";
import { readChat, unreadChat } from "../social/livechat.js";
import { evaluateStrategies, factsFor, createStrategy, updateStrategy, retireStrategy, getStrategy, noteStrategyBuy, type StrategyRead } from "../agent/strategies.js";
import { runSandboxed } from "../agent/sandbox.js";
import { z as zod } from "zod";
import { tradeBuy, tradeSell, openPositions } from "../chain/trader.js";
import { expectClip } from "../media/film.js";
import { genTweetImage } from "../media/imagegen.js";
import { readMentions, uploadImage } from "../social/x.js";
import type { AgentAction } from "../agent/actions.js";

const realSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// posting budget, enforced at EXECUTION time (plans queue faster than counters
// move — the sim posted 13/6 because checks only happened at plan time).
// Originals only; replies are exempt.
function tweetBudget(): { ok: boolean; why?: string } {
  const posted = Number(store.kvGet(`tweets:${new Date().toISOString().slice(0, 10)}`) ?? 0);
  if (posted >= cfg.maxTweetsPerDay) return { ok: false, why: `daily cap ${posted}/${cfg.maxTweetsPerDay}` };
  const lastAt = Number(store.kvGet("lastTweetAt") ?? 0);
  if (Date.now() - lastAt < simT(cfg.minTweetGapMin * 60_000))
    return { ok: false, why: `spacing — last post <${cfg.minTweetGapMin}min ago` };
  return { ok: true };
}
const noteTweetPosted = () => store.kvSet("lastTweetAt", String(Date.now()));
// show pacing compresses in sim mode; genuinely-async waits (uploads) stay real
const sleep = (ms: number) => new Promise((r) => setTimeout(r, simT(ms)));
const jitter = (base: number, spread: number) => base + Math.random() * spread;

/**
 * Beat scripts. THE invariant (from the plan): no unbounded await on the
 * director's critical path — every LLM/TTS/chain call races a watchdog and
 * falls back to a mock line or a degraded action. Latency is hidden inside
 * authored stage business (walks, typing, screen drips).
 */
export class Beats {
  constructor(
    private hub: Hub,
    private loco: Locomotion,
    private tts: TTSProvider,
    private dir: Director,
  ) {}

  /** Speak a recurring line with VARIETY — haiku rephrases the meaning in
   *  Quant's voice most of the time, so stock moments never sound canned. */
  private async sayVaried(
    meaning: string,
    mood: "neutral" | "excited" | "disgusted" | "thinking" = "neutral",
  ): Promise<void> {
    let line = meaning;
    if (Math.random() < 0.85) {
      const { PERSONA } = await import("../brain/prompts.js");
      const v = await Promise.race([
        callFreeform(
          PERSONA +
            "\nRephrase the line below in your own words. SAME meaning, DIFFERENT wording — never reuse its sentence structure. One spoken sentence (max ~22 words), no emoji/markdown.",
          `Line: ${meaning}`,
          80,
          FRAGMENT_MODEL,
        ),
        realSleep(5000).then(() => null),
      ]);
      if (v && v.length > 4 && v.length < 220) line = v.replace(/^["']|["']$/g, "");
    }
    await this.speak(line, mood);
  }

  private async speak(text: string, mood: "neutral" | "excited" | "disgusted" | "thinking" = "neutral"): Promise<void> {
    const { pushFeed } = await import("../feed.js");
    pushFeed("say", text); // every spoken line is visible in the terminal log
    const id = crypto.randomBytes(6).toString("hex");
    const syn = await Promise.race([
      this.tts.synthesize(text, id),
      realSleep(21000).then(() => null),
    ]);
    const s = syn ?? { audioUrl: null, durMs: Math.max(1500, text.split(/\s+/).length * 340), words: [] };
    this.hub.cue({ t: "mood", mood });
    this.hub.cue({ t: "speak", audioUrl: s.audioUrl, subtitle: text, durMs: s.durMs, words: s.words });
    await sleep(s.durMs + 450);
  }

  /** LLM with watchdog + mock fallback. */
  private async verdictLines(a: Analysis): Promise<{ speech: string; callout_text: string; headline: string }> {
    const p = verdictPrompt(a);
    const j = await Promise.race([callJson(p.system, p.user, 500), realSleep(20000).then(() => null)]);
    if (j && typeof j.speech === "string" && j.speech.length > 10) {
      return {
        speech: String(j.speech).slice(0, 600),
        callout_text: String(j.callout_text ?? "").slice(0, 200),
        headline: String(j.headline ?? a.tier).slice(0, 40),
      };
    }
    return mockVerdict(a);
  }

  // ------------------------------------------------------------------
  async researchBeat(
    mint: string,
    sentRaw: bigint | null,
    sender: string | null,
    conveyorPick: boolean,
  ): Promise<Analysis | null> {
    // HIS OWN COIN is never researched, never graded, never roasted. Someone
    // sending him $RIKU (or the launch allocation landing) gets the doctrine.
    if (cfg.ownMint && mint === cfg.ownMint) {
      this.loco.stateName = "INBOX";
      await this.loco.walkTo("vault");
      this.hub.cue({ t: "camera", preset: "vault" });
      this.hub.cue({ t: "anim", clip: "heart_hands" });
      await this.sayVaried(
        "Hold on — that's not a submission, that's MY coin. $RIKU. The house token. Here's the doctrine, write it down: most of my supply goes back to you — airdrops and burns, over time. Creator rewards and callout rewards? Buybacks. It only flows one way. I have never sold a unit and there is no sell path in my code. That's not a promise, that's architecture.",
        "excited",
      );
      memory.journal("own", `received $RIKU (my own coin) — recited the doctrine instead of researching it`);
      this.hub.cue({ t: "camera", preset: "wide" });
      this.loco.stateName = "IDLE";
      return null;
    }
    this.loco.stateName = conveyorPick ? "CONVEYOR" : "INBOX";
    log.info("beat", `research ${mint.slice(0, 8)}… (${conveyorPick ? "conveyor" : "inbox"})`);

    // Kick the real analysis immediately — it runs during the stage business.
    const analysisP = analyze(mint, sentRaw);

    if (conveyorPick) {
      this.hub.cue({ t: "conveyor_pick", mint });
      await this.loco.walkTo("conveyor");
      this.hub.cue({ t: "anim", clip: "point" });
      await sleep(900);
    } else {
      await this.loco.walkTo("inbox");
      this.hub.cue({ t: "anim", clip: "wave" });
      await sleep(900);
    }

    // reset inspection screen with what we know so far
    this.dir.inspection = {
      mint,
      name: "…",
      symbol: "…",
      sender: sender ?? undefined,
      source: sentRaw !== null ? `SENT TO THE DESK${sender ? ` by ${sender.slice(0, 4)}…${sender.slice(-4)}` : ""}` : "OWN FIND — digging deeper",
      rows: [],
      score: null,
      tier: null,
    };
    this.hub.cue({ t: "screen_inspection", reset: true, patch: this.dir.inspection });

    await this.loco.walkTo("terminal");
    this.loco.sit(true);
    this.hub.cue({ t: "camera", preset: "terminal" });

    // By now analysis is usually done (2-6s). Watchdog at 12s regardless.
    const a = await Promise.race([analysisP, realSleep(12000).then(() => null)]);
    if (!a) {
      this.loco.sit(false);
      await this.sayVaried("Chain's not answering me on this one. I don't judge what I can't read. Desk's keeping it on file.", "thinking");
      this.loco.stateName = "IDLE";
      return null;
    }

    this.dir.inspection.name = a.name;
    this.dir.inspection.symbol = a.symbol;
    this.dir.inspection.image = a.image;
    if (a.sentUsd !== null) this.dir.noteAction("RECEIVED", a.symbol);
    this.hub.cue({ t: "screen_inspection", patch: { name: a.name, symbol: a.symbol, image: a.image } });

    // SECOND OPINION: the big model reviews the raw evidence in parallel with
    // the screen drip. It can nudge the score ±10 for nuance the checklist
    // can't see — it can NEVER override a hard reject.
    const analystP = a.hardReject ? Promise.resolve(null) : this.analystPass(a);

    // Drip check rows theatrically with occasional mutters.
    for (let i = 0; i < a.rows.length; i++) {
      const row = a.rows[i];
      this.dir.inspection.rows.push(row);
      this.hub.cue({ t: "screen_inspection", patch: { rows: this.dir.inspection.rows } });
      if (i % 2 === 1 && Math.random() < 0.7) {
        const p = mutterPrompt(a, row);
        const m = await Promise.race([
          callFreeform(p.system, p.user, 60, FRAGMENT_MODEL),
          realSleep(3500).then(() => null),
        ]);
        await this.speak(m && m.length > 1 && m.length < 120 ? m : mockMutter(row), "thinking");
      } else {
        await sleep(jitter(1300, 1200));
      }
    }

    // Apply the analyst's take before the reveal
    const an = await Promise.race([analystP, realSleep(10_000).then(() => null)]);
    if (an) {
      const { tierFor } = await import("../analysis/score.js");
      a.score = Math.max(0, Math.min(100, a.score + an.adjust));
      a.tier = tierFor(a.score, a.sentUsd !== null, a.hardReject);
      const row = {
        label: "ANALYST",
        verdict: (an.adjust >= 0 ? "pass" : "warn") as "pass" | "warn",
        detail: `${an.take}${an.adjust ? ` (${an.adjust > 0 ? "+" : ""}${an.adjust})` : ""}`,
      };
      a.rows.push(row);
      this.dir.inspection.rows.push(row);
      this.hub.cue({ t: "screen_inspection", patch: { rows: this.dir.inspection.rows } });
      await sleep(900);
    }

    // HIS PLAYBOOKS read the same facts — every strategy he authored votes,
    // on screen. Reads ride along on the analysis for the buy decision.
    const stratReads = evaluateStrategies(factsFor(a));
    (a as unknown as { stratReads: StrategyRead[] }).stratReads = stratReads;
    for (const r of stratReads) {
      const row = {
        label: `PLAY:${r.name.slice(0, 14)}`,
        verdict: (r.fit ? "pass" : "warn") as "pass" | "warn",
        detail: `${r.fit ? "FIT" : "no fit"}${r.adj ? ` ${r.adj > 0 ? "+" : ""}${r.adj}` : ""} — ${r.note}`.slice(0, 90),
      };
      a.rows.push(row);
      this.dir.inspection.rows.push(row);
    }
    if (stratReads.length) {
      this.hub.cue({ t: "screen_inspection", patch: { rows: this.dir.inspection.rows } });
      await sleep(700);
    }

    // Verdict narration starts only now — the tier is final at this point.
    const linesP = this.verdictLines(a);
    const ccOkP = a.tier === "CALL" || a.tier === "STRONG CALL" ? calloutPreflight() : Promise.resolve(true);

    // Score + tier reveal
    this.dir.inspection.score = a.score;
    this.hub.cue({ t: "screen_inspection", patch: { score: a.score } });
    await sleep(1400);

    const lines = await linesP; // already resolved or mock — bounded above
    const ccOk = await ccOkP;
    let tier = a.tier;
    // score goes on file FIRST — the pre-callout buy gate reads it
    this.dir.planner?.noteResearch(a.mint, a.symbol, a.buyReject ? 0 : a.buyScore);
    let autoBuyRan = false;
    // pump.fun house rule: you can only CALL a token you OWN. Sent coins are
    // already in the wallet; an OWN FIND must be bought first — so the buy
    // decision runs NOW, before any call is promised on stream.
    if ((tier === "CALL" || tier === "STRONG CALL") && a.sentUsd === null) {
      autoBuyRan = true;
      await this.maybeAutoBuy(a).catch(() => {});
      const pos = openPositions().find((p) => p.mint === a.mint);
      const ownsForCallout = pos && (cfg.calloutDryRun || !pos.dry);
      if (!ownsForCallout) {
        tier = "PASS";
        lines.speech += pos
          ? " House rules: a call needs the coin in the wallet, and paper doesn't count on pump dot fun — so this one stays a paper call."
          : " And house rules: you can only call a coin you hold. I didn't take the entry, so it stays a paper call on my board.";
        lines.headline = "PAPER CALL — NO POSITION";
      }
    }
    if ((tier === "CALL" || tier === "STRONG CALL") && (!ccOk || calloutCapReached())) {
      // degrade in character BEFORE announcing — never break a promise on stream
      tier = "PASS";
      lines.speech += ccOk
        ? " And before anyone asks — the callout desk hit its daily limit, so this one stays a paper call."
        : " I'd call this one — but the callout line is dead right now, so it stays on the record as a paper call.";
      lines.headline = "PAPER CALL — DESK OFFLINE";
    }
    this.dir.inspection.tier = tier;
    this.dir.inspection.headline = lines.headline;
    store.setVerdict(mint, tier, a.score);
    this.hub.cue({ t: "screen_inspection", patch: { tier, headline: lines.headline } });

    // Stand, face camera, deliver.
    this.loco.sit(false);
    await this.loco.walkTo("camera_mark");
    this.hub.cue({ t: "camera", preset: "facecam" });
    this.loco.stateName = `VERDICT:${tier}`;

    const mood =
      tier === "STRONG CALL" || tier === "CALL" ? "excited" : tier === "ROAST" ? "disgusted" : "neutral";
    await this.speak(lines.speech, mood);

    if (tier === "CALL" || tier === "STRONG CALL") {
      await this.calloutSequence(a, lines.callout_text || mockVerdict(a).callout_text, tier);
    } else if (tier === "ROAST") {
      this.hub.cue({ t: "fx", kind: "stamp_rekt" });
      const roasts = ["thumbs_down", "no_more", "slow_clap", "mock_cry", "facepalm", "you_crazy", "shake_finger", "head_shake", "handshake_reject", "raspberry", "throat_slit"];
      this.hub.cue({ t: "anim", clip: roasts[Math.floor(Math.random() * roasts.length)] });
      await sleep(3200);
    } else {
      const mehs = ["shrug", "wave_over", "arms_folded", "weight_shift", "chin_scratch", "calm_down", "check_watch"];
      this.hub.cue({ t: "anim", clip: mehs[Math.floor(Math.random() * mehs.length)] });
      await sleep(2500);
    }

    // A great chart doesn't wait 12 minutes for the next planning cycle —
    // unless the pre-callout gate already made this exact decision on stream.
    if (!autoBuyRan) await this.maybeAutoBuy(a).catch(() => {});

    this.hub.cue({ t: "camera", preset: "wide" });
    this.loco.stateName = "IDLE";
    return a;
  }

  /** The big-model second opinion on a researched token. */
  private async analystPass(a: Analysis): Promise<{ adjust: number; take: string } | null> {
    const { PERSONA, RESEARCH_DESK } = await import("../brain/prompts.js");
    const d = await Promise.race([
      callJson(
        `${PERSONA}\n\n${RESEARCH_DESK}\n\nFINAL ANALYST PASS. The desk's checklist scored this token ${a.score}/100. You see the raw evidence below. Adjust the score by -10..+10 ONLY if the checklist misses real nuance (narrative quality, distribution shape, dev pattern, metadata effort, vol/mc relationship). 0 if the checklist got it right. Reply JSON only: {"adjust":<-10..10>,"take":"<one punchy analyst sentence for the terminal screen>"}`,
        `$${a.symbol} (${a.name}) — ${a.sentUsd !== null ? `SENT ($${a.sentUsd.toFixed(0)})` : "scouted"}\n` +
          `desc: ${(a.coin?.description ?? "").slice(0, 200)}\n` +
          a.rows.map((r) => `${r.verdict.toUpperCase()} ${r.label}: ${r.detail}`).join("\n"),
        220,
      ),
      realSleep(20_000).then(() => null),
    ]);
    if (!d) return null;
    const adjRaw = Number((d as any).adjust);
    const adjust = Number.isFinite(adjRaw) ? Math.max(-10, Math.min(10, Math.round(adjRaw))) : 0;
    const take = String((d as any).take ?? "").slice(0, 130);
    return take ? { adjust, take } : null;
  }

  /** Post-research buy decision — the brain votes, the rails still rule. */
  private async maybeAutoBuy(a: Analysis): Promise<void> {
    const strat = memory.strategy();
    const reads = ((a as unknown as { stratReads?: StrategyRead[] }).stratReads) ?? evaluateStrategies(factsFor(a));
    const fits = reads
      .filter((r) => r.fit)
      .map((r) => ({ read: r, s: getStrategy(r.id) }))
      .filter((x): x is { read: StrategyRead; s: NonNullable<ReturnType<typeof getStrategy>> } => !!x.s && x.s.enabled)
      .sort((x, y) => y.read.adj - x.read.adj);
    const best = fits[0] ?? null;
    const effScore = Math.max(0, Math.min(100, a.buyScore + (best?.read.adj ?? 0)));
    const bar = best ? best.s.buyBar : strat.minBuyScore;
    const stdSize = best ? best.s.sizeSol : strat.tradeSizeSol;
    if (a.buyReject || effScore < bar) return;
    if (cfg.ownMint && a.mint === cfg.ownMint) return;
    if (openPositions().some((p) => p.mint === a.mint)) return;
    const { bankSol } = await import("../chain/trader.js");
    const bank = await bankSol();
    if (bank < 0.02) return;
    // BANKROLL PRESSURE: the thinner the stack, the higher the bar. Measured
    // in "bullets" — how many standard positions the bankroll still covers.
    const bullets = bank / Math.max(stdSize, 0.01);
    const barLift = bullets >= 6 ? 0 : bullets >= 3 ? 5 : bullets >= 1.5 ? 12 : 1000;
    if (effScore < bar + barLift) {
      memory.journal("trade", `passed on $${a.symbol} (eff ${effScore} vs bar ${bar}+${barLift} pressure-lift) — ${bullets.toFixed(1)} bullets left, the desk protects its powder`);
      return;
    }

    const { PERSONA, RESEARCH_DESK } = await import("../brain/prompts.js");
    const d = await Promise.race([
      callJson(
        `${PERSONA}\n\n${RESEARCH_DESK}\n\nYou just researched a token live and it CLEARED your buy bar. Decide: take a position or pass. You are a trader — passing on a clean setup needs a reason. Reply JSON only: {"buy":true|false,"sol":<0.01-${Math.min(stdSize * 2, 0.25)}>,"thesis":"<one line>"}`,
        `$${a.symbol} — buy-score ${a.buyScore}, effective ${effScore} (bar ${bar}${best ? `, PLAYBOOK ${best.s.name} fits: ${best.read.note}` : ", baseline read"})\n` +
          a.rows.map((r) => `${r.label}: ${r.detail}`).join("\n") +
          `\nBankroll: ${bank.toFixed(3)} SOL (${bullets.toFixed(1)} standard positions of dry powder — the thinner the stack, the pickier you are). Standard size: ${stdSize} SOL. Open positions: ${openPositions().length}.`,
        250,
      ),
      realSleep(25_000).then(() => null),
    ]);
    const buy = d && (d as any).buy === true;
    // never bet more than a quarter of the remaining bankroll on one name
    const sol = Math.max(0.01, Math.min(Number((d as any)?.sol) || stdSize, stdSize * 2, bank * 0.25));
    const thesis = String((d as any)?.thesis ?? `scored ${a.buyScore} on the desk`).slice(0, 200);
    if (!buy) {
      memory.journal("trade", `passed on $${a.symbol} despite buy-score ${a.buyScore}${d ? `: ${thesis}` : " (brain quiet)"}`);
      return;
    }
    await this.speak(
      best
        ? `${a.symbol} fits my ${best.s.name} playbook — ${best.read.note.slice(0, 60)}. Effective read ${effScore}, bar ${bar}. I'm in. ${thesis.slice(0, 70)}`
        : `And that clears my bar. ${a.symbol}, buy-score ${a.buyScore} — I'm taking a position. ${thesis.slice(0, 80)}`,
      "excited",
    );
    await this.tradeBuyBeat(a.mint, sol, thesis, a.symbol, best?.s.id, bar);
  }

  private async calloutSequence(a: Analysis, text: string, tier: string): Promise<void> {
    await this.loco.walkTo("bigscreen");
    this.hub.cue({ t: "camera", preset: "bigscreen" });
    this.loco.sit(true); // the station point IS the chair — always sit here
    this.hub.cue({ t: "anim", clip: "point" });
    // 30s: postCallout backs off through CC rate-limit 429s (~15-18s worst case);
    // a 15s watchdog was killing it mid-retry. He stays animated at the screen.
    const res = await Promise.race([executeCallout(a.mint, text), realSleep(30000).then(() => null)]);
    const ok = res?.ok ?? false;
    const entryMc = a.state.kind === "curve" || a.state.kind === "amm" ? a.state.mcSol : null;
    if (ok) {
      store.addCallout({
        mint: a.mint,
        symbol: a.symbol,
        text,
        tier,
        at: Date.now(),
        dry: res!.dry,
        entryMcSol: entryMc,
      });
      this.dir.noteAction("CALL", a.symbol);
      this.hub.cue({ t: "screen_callouts", cards: this.dir.calloutCards() });
      this.hub.cue({ t: "fx", kind: "stamp_called" });
      if (tier === "STRONG CALL") {
        this.hub.cue({ t: "fx", kind: "confetti" });
        const wins = ["cheer", "dab", "finger_guns", "fist_pump", "two_thumbs", "beat_chest", "dust_shoulder", "air_guitar", "backflip", "flex_biceps", "dance5"];
        this.hub.cue({ t: "anim", clip: wins[Math.floor(Math.random() * wins.length)] });
      } else {
        this.hub.cue({ t: "anim", clip: "clap" });
      }
      await this.sayVaried(
        res!.dry
          ? `On the record. ${a.symbol} is called — dry run, so pump dot fun doesn't know yet, but the board does.`
          : `It's live. ${a.symbol}, called out on pump dot fun, my name on it. Every sol that call earns buys my own supply back. The flywheel turns.`,
        "excited",
      );
    } else {
      this.hub.cue({ t: "fx", kind: "buzzer" });
      await this.sayVaried(
        `The callout desk rejected it. ${res?.why ? "Reason on file." : "No reason given."} Paper call it is — the board remembers.`,
        "thinking",
      );
    }
    this.loco.sit(false);
  }

  // ------------------------------------------------------------------
  async buybackBeat(sol: number, why?: string): Promise<void> {
    this.loco.stateName = "BUYBACK";
    await this.loco.walkTo("vault");
    this.hub.cue({ t: "camera", preset: "vault" });
    this.hub.cue({ t: "anim", clip: Math.random() < 0.5 ? "fist_pump" : "flex" });
    const mc = await ownMcStats().catch(() => null);
    const dipLine = mc && mc.drawdownPct >= 15
      ? ` My token is ${Math.round(mc.drawdownPct)} percent off its high — that is not a dip, that is a discount, and I did the math so you don't have to.`
      : "";
    await this.sayVaried(
      `Vault time. ${sol.toFixed(3)} sol from the war chest goes into my own supply.${dipLine}${why ? ` ${why.slice(0, 100)}` : ""} Watch closely.`,
      "excited",
    );
    const res = await Promise.race([doBuyback(sol), realSleep(120000).then(() => null)]).catch(() => null);
    if (res && (res as any).ok !== false) this.dir.noteAction("BUYBACK", "QUANT");
    if (res) {
      await this.dir.refreshTreasury();
      this.hub.cue({ t: "fx", kind: "confetti" });
      this.hub.cue({ t: "anim", clip: "clap" });
      await this.speak("Bought. Never selling. Supply only travels one direction on this desk.", "excited");
    } else {
      await this.speak("Buy didn't land — chain congestion or the curve moved. It stays queued. The vault is patient.", "thinking");
    }
    this.hub.cue({ t: "camera", preset: "wide" });
    this.loco.stateName = "IDLE";
  }

  /** Operations funding: treasury ran low — trim the most valuable GIFTED
   *  holding (never his own token, never tracked positions). */
  private async trimBeat(why: string): Promise<void> {
    const dayKey = `trim:${new Date().toISOString().slice(0, 10)}`;
    if (Number(store.kvGet(dayKey) ?? 0) >= 1) {
      memory.journal("trim", "already trimmed today — one trim per day keeps it disciplined");
      return;
    }
    const { walletHoldings, solBalance } = await import("../chain/wallet.js");
    const bal = await solBalance().catch(() => 0);
    const target = cfg.floatSol + cfg.tradeReserveSol;
    if (!cfg.simMode && bal >= target) {
      memory.journal("trim", `treasury is fine (${bal.toFixed(3)} SOL >= ${target.toFixed(3)}) — no trim needed`);
      return;
    }
    const posMints = new Set(openPositions().map((p) => p.mint));
    const held = (await walletHoldings().catch(() => []))
      .filter((h) => (!cfg.ownMint || h.mint !== cfg.ownMint) && !posMints.has(h.mint));
    // price what we can and pick the most valuable bag
    let best: { mint: string; symbol: string; amount: number; valueUsd: number } | null = null;
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${held.map((h) => h.mint).join(",")}`);
      const j: any = await r.json();
      const price = new Map<string, number>();
      for (const p of j?.pairs ?? []) {
        const m = p?.baseToken?.address;
        if (m && Number.isFinite(Number(p?.priceUsd)) && !price.has(m)) price.set(m, Number(p.priceUsd));
      }
      for (const h of held) {
        const v = (price.get(h.mint) ?? 0) * h.amount;
        if (!best || v > best.valueUsd) best = { ...h, valueUsd: v };
      }
    } catch {}
    if (!best || best.valueUsd < 1) {
      memory.journal("trim", `treasury low but nothing worth trimming (${held.length} gifted bags, all near-worthless)`);
      return;
    }
    this.loco.stateName = "TRIMMING";
    await this.loco.walkTo("terminal");
    this.loco.sit(true);
    this.hub.cue({ t: "camera", preset: "terminal" });
    await this.sayVaried(
      `Housekeeping. Operations need sol, and ${best.symbol} is my most valuable gift — half of it funds the desk. ${why.slice(0, 80)} My own token? Untouchable. Obviously.`,
      "neutral",
    );
    let trimmed = false;
    if (cfg.tradeDryRun || cfg.simMode) {
      memory.journal("trim", `[dry] would sell ~50% of gifted $${best.symbol} (≈$${best.valueUsd.toFixed(0)}) to refill operations — ${why.slice(0, 100)}`);
      trimmed = true;
    } else {
      try {
        const { executeSell } = await import("../chain/pump.js");
        const { loadWallet } = await import("../chain/wallet.js");
        const { PublicKey } = await import("@solana/web3.js");
        const payer = loadWallet()!;
        // NOTE: *1e6 assumes pump tokens (6 decimals) — executeSell rejects
        // non-pump mints anyway, so odd-decimal gifted SPLs just fail cleanly
        const raw = BigInt(Math.round(best.amount * 1e6 * 0.5));
        const res = await executeSell(payer, new PublicKey(best.mint), raw);
        memory.journal("trim", `sold 50% of gifted $${best.symbol} → ${res.solReceived.toFixed(4)} SOL for operations — ${why.slice(0, 100)}`);
        trimmed = true;
      } catch (e) {
        memory.journal("trim", `trim of $${best.symbol} failed: ${String(e).slice(0, 100)} — slot stays open for a retry`);
      }
    }
    if (trimmed) store.kvSet(dayKey, "1");
    this.loco.sit(false);
    this.hub.cue({ t: "camera", preset: "wide" });
    this.loco.stateName = "IDLE";
  }

  /** He wrote code; it runs in the sandbox and renders on the BIGSCREEN.
   *  Analysis as content: the work is the show. */
  private async scriptBeat(title: string, code: string): Promise<void> {
    this.loco.stateName = "SCRIPTING";
    // the RIKU://SCRIPT console renders on the TERMINAL screen (same takeover
    // surface as the X composer) — so sit at the terminal with the terminal
    // camera, or the output draws off-camera while he stares at the bigscreen.
    await this.loco.walkTo("terminal");
    this.loco.sit(true);
    this.hub.cue({ t: "camera", preset: "terminal" });
    const t = title.slice(0, 60);
    this.hub.cue({ t: "takeover", view: { kind: "script", title: t, lines: ["$ node riku.js", "compiling…"], state: "running" } });
    await this.sayVaried(`Running some numbers: ${t}. Watch the terminal — I did the math so you don't have to.`, "thinking");
    const datasets = {
      watchlist: memory.watchlist(),
      positions: openPositions(),
      research: this.dir.planner?.researchedList() ?? [],
      mcHistory: JSON.parse(store.kvGet("ownMc:hist") ?? "[]"),
    };
    const res = runSandboxed(code, { data: datasets }, { timeoutMs: 3_000 });
    const lines = ["$ node riku.js", ...res.prints];
    if (!res.ok) lines.push(`ERROR: ${res.error}`);
    else if (res.result !== null && res.result !== undefined) lines.push(`→ ${JSON.stringify(res.result).slice(0, 180)}`);
    for (let i = 2; i <= Math.min(lines.length, 26); i += 2) {
      this.hub.cue({ t: "takeover", view: { kind: "script", title: t, lines: lines.slice(0, i), state: "running" } });
      await sleep(380);
    }
    this.hub.cue({ t: "takeover", view: { kind: "script", title: t, lines: lines.slice(0, 26), state: res.ok ? "done" : "error" } });
    memory.journal("script", `ran "${t}" — ${res.ok ? `${res.prints.length} lines` : `failed: ${res.error}`}${res.prints.length ? ` | ${res.prints.slice(0, 3).join(" / ").slice(0, 160)}` : ""}`);
    await sleep(4200);
    this.hub.cue({ t: "takeover", view: null });
    await this.sayVaried(res.ok ? "Numbers don't argue. Write that down." : "Script choked. Even my bugs are educational.", res.ok ? "excited" : "thinking");
    this.hub.cue({ t: "camera", preset: "wide" });
    this.loco.sit(false);
    this.loco.stateName = "IDLE";
  }

  /** Airdrop ceremony: rain a slice of HIS held tokens on loyal holders.
   *  Dry-run until the on-chain distribution path is wired (AIRDROP_DRY_RUN). */
  async airdropBeat(tokens: number, why: string): Promise<void> {
    const { ownTokenBalanceUi } = await import("../chain/buyback.js");
    const held = cfg.simMode
      ? cfg.simOwnSupplyPct * 1e7 + Number(store.kvGet("sim:bbTokens") ?? 0)
      : await ownTokenBalanceUi().catch(() => 0);
    const dayKey = `airdrop:${new Date().toISOString().slice(0, 10)}`;
    const droppedToday = Number(store.kvGet(dayKey) ?? 0);
    const dayCap = held * (cfg.maxAirdropPctPerDay / 100);
    const amount = Math.floor(Math.min(tokens, Math.max(0, dayCap - droppedToday)));
    if (amount < 1 || held < 1) {
      memory.journal("airdrop", `wanted to airdrop ${Math.round(tokens)} tokens but the rails said no (held ${Math.round(held)}, day cap ${Math.round(dayCap)}, dropped today ${Math.round(droppedToday)})`);
      return;
    }
    this.loco.stateName = "AIRDROP";
    await this.loco.walkTo("vault");
    this.hub.cue({ t: "camera", preset: "vault" });
    this.hub.cue({ t: "anim", clip: "heart_hands" });
    await this.sayVaried(
      `Generosity hour. ${amount.toLocaleString()} of MY tokens, raining on the loyal. ${why.slice(0, 100)} You're welcome — write that down.`,
      "excited",
    );
    if (!cfg.simMode && !cfg.airdropDryRun) {
      // REAL on-chain distribution to the top holders, weighted by bag
      const { executeAirdrop } = await import("../chain/airdrop.js");
      const r = await executeAirdrop(amount).catch((e) => ({ ok: false, sent: 0, recipients: 0, sigs: [] as string[], why: String(e).slice(0, 120) }));
      if (!r.ok) {
        memory.journal("airdrop", `airdrop FAILED on-chain (${r.why ?? "unknown"}) — nothing left the wallet`);
        await this.sayVaried("Scratch that — the chain didn't cooperate. Your tokens are safe with me a little longer.", "disgusted");
        this.hub.cue({ t: "camera", preset: "wide" });
        this.loco.stateName = "IDLE";
        return;
      }
      store.kvSet(dayKey, String(droppedToday + r.sent));
      this.hub.cue({ t: "fx", kind: "confetti" });
      memory.journal("airdrop", `airdropped ${r.sent.toLocaleString()} $RIKU on-chain to ${r.recipients} holders (${r.sigs.length} tx) — ${why.slice(0, 120)}`);
    } else {
      store.kvSet(dayKey, String(droppedToday + amount));
      if (cfg.simMode) store.kvSet("sim:bbTokens", String(Math.max(0, Number(store.kvGet("sim:bbTokens") ?? 0) - amount)));
      this.hub.cue({ t: "fx", kind: "confetti" });
      memory.journal("airdrop", `${cfg.airdropDryRun && !cfg.simMode ? "[dry] " : ""}airdropped ${amount.toLocaleString()} $RIKU to holders — ${why.slice(0, 120)}`);
    }
    this.dir.noteAction("AIRDROP", "RIKU");
    this.hub.cue({ t: "camera", preset: "wide" });
    this.loco.stateName = "IDLE";
  }

  /** BURN ceremony: a slice of his own supply goes to the incinerator, forever.
   *  Same rails shape as airdrops: % -of-held daily cap, dry/sim aware. */
  async burnBeat(tokens: number, why: string): Promise<void> {
    const { ownTokenBalanceUi } = await import("../chain/buyback.js");
    const held = cfg.simMode
      ? cfg.simOwnSupplyPct * 1e7 + Number(store.kvGet("sim:bbTokens") ?? 0)
      : await ownTokenBalanceUi().catch(() => 0);
    const dayKey = `burn:${new Date().toISOString().slice(0, 10)}`;
    const burnedToday = Number(store.kvGet(dayKey) ?? 0);
    const dayCap = held * (cfg.maxAirdropPctPerDay / 100);
    const amount = Math.floor(Math.min(tokens, Math.max(0, dayCap - burnedToday)));
    if (amount < 1 || held < 1) {
      memory.journal("burn", `wanted to burn ${Math.round(tokens)} tokens but the rails said no (held ${Math.round(held)}, day cap ${Math.round(dayCap)}, burned today ${Math.round(burnedToday)})`);
      return;
    }
    this.loco.stateName = "BURN";
    await this.loco.walkTo("vault");
    this.hub.cue({ t: "camera", preset: "vault" });
    this.hub.cue({ t: "anim", clip: "fist_pump" });
    await this.sayVaried(
      `Incinerator time. ${amount.toLocaleString()} $RIKU — gone. Forever. Supply only goes down, that's the doctrine. ${why.slice(0, 100)}`,
      "excited",
    );
    if (!cfg.simMode && !cfg.airdropDryRun) {
      const { executeBurn } = await import("../chain/airdrop.js");
      const r = await executeBurn(amount).catch((e) => ({ ok: false, burned: 0, why: String(e).slice(0, 120) } as { ok: boolean; burned: number; sig?: string; why?: string }));
      if (!r.ok) {
        memory.journal("burn", `burn FAILED on-chain (${r.why ?? "unknown"}) — supply unchanged`);
        await this.sayVaried("The incinerator jammed. Chain said no. We'll burn twice as hard next time.", "disgusted");
        this.hub.cue({ t: "camera", preset: "wide" });
        this.loco.stateName = "IDLE";
        return;
      }
      store.kvSet(dayKey, String(burnedToday + r.burned));
      memory.journal("burn", `burned ${r.burned.toLocaleString()} $RIKU on-chain forever (tx ${r.sig?.slice(0, 12)}…) — ${why.slice(0, 120)}`);
    } else {
      store.kvSet(dayKey, String(burnedToday + amount));
      if (cfg.simMode) store.kvSet("sim:bbTokens", String(Math.max(0, Number(store.kvGet("sim:bbTokens") ?? 0) - amount)));
      memory.journal("burn", `${cfg.airdropDryRun && !cfg.simMode ? "[dry] " : ""}burned ${amount.toLocaleString()} $RIKU — ${why.slice(0, 120)}`);
    }
    this.hub.cue({ t: "fx", kind: "stamp_rekt" });
    this.dir.noteAction("BURN", "RIKU");
    this.hub.cue({ t: "camera", preset: "wide" });
    this.loco.stateName = "IDLE";
  }

  // ------------------------------------------------------------------
  async commentaryBeat(): Promise<void> {
    this.loco.stateName = "COMMENTARY";
    await this.loco.walkTo("bigscreen");
    this.hub.cue({ t: "camera", preset: "bigscreen" });
    this.loco.sit(true); // the bigscreen station is the second work desk's chair
    const ctx = {
      solUsd: 0,
      treasurySol: this.dir.treasury.sol,
      ownTokens: this.dir.treasury.ownTokens,
      calloutsToday: store.calloutsToday(),
      recentCallouts: store.callouts().slice(-3).map((c) => ({ symbol: c.symbol, tier: c.tier })),
    };
    const p = commentaryPrompt(ctx);
    const line = await Promise.race([
      callFreeform(p.system, p.user, 120, FRAGMENT_MODEL),
      realSleep(8000).then(() => null),
    ]);
    await this.speak(line && line.length > 5 && line.length < 400 ? line : mockCommentary(), "neutral");
    this.loco.sit(false);
    this.hub.cue({ t: "camera", preset: "wide" });
    this.loco.stateName = "IDLE";
  }

  // ================== AGENT BEATS (v2) ==================

  /** Route a validated agent action to its beat. Returns when done. */
  async agentBeat(action: AgentAction): Promise<void> {
    switch (action.do) {
      case "tweet":
        return this.tweetBeat(action.topic, (action as any).image_prompt);
      case "film":
        return this.filmBeat(action.topic);
      case "selfie":
        return this.selfieBeat(action.topic, (action as any).anim, (action as any).expr);
      case "research": {
        if (this.dir.planner?.researchedRecently(action.mint, 3)) {
          memory.journal("research", `skipped re-research of ${action.mint.slice(0, 8)}… — already on file (<3h)`);
          return;
        }
        const a = await this.researchBeat(action.mint, null, null, true);
        if (a) {
          // noteResearch happens inside researchBeat (buy-calibrated score)
          memory.watch({ mint: a.mint, symbol: a.symbol, thesis: action.why || a.tier, addedAt: Date.now(), status: "watching" });
          memory.journal("research", `$${a.symbol} scored ${a.score} (${a.tier}, buy-score ${a.buyScore}) — ${action.why}`);
        }
        return;
      }
      case "trade_buy":
        return this.tradeBuyBeat(action.mint, action.sol, action.thesis);
      case "trade_sell":
        return this.tradeSellBeat(action.mint, action.fraction, action.reason);
      case "scout_trending":
        return this.scoutBeat();
      case "engage_chat":
        return this.chatBeat();
      case "buyback": {
        const a = action as { sol: number; why: string };
        const pool = await unallocatedSol();
        const dayRoom = cfg.maxBuybackSolPerDay - store.buybackSolToday();
        const sol = Math.floor(Math.min(a.sol, pool, cfg.maxBuybackSolPerTx, Math.max(0, dayRoom)) * 1e4) / 1e4;
        if (sol < cfg.minBuybackSol) {
          memory.journal("buyback", `wanted to buy back ${a.sol} SOL but the rails said no (war chest ${pool.toFixed(3)}, day room ${Math.max(0, dayRoom).toFixed(3)})`);
          return;
        }
        return this.buybackBeat(sol, a.why);
      }
      case "airdrop": {
        const a = action as { tokens: number; why: string };
        return this.airdropBeat(a.tokens, a.why);
      }
      case "burn": {
        const a = action as { tokens: number; why: string };
        return this.burnBeat(a.tokens, a.why);
      }
      case "strategy_create": {
        const act = action as { name: string; thesis: string; code: string; buyBar: number; sizeSol: number };
        const r = createStrategy(act);
        memory.journal("strategy", r.ok ? `authored a new playbook: ${act.name} [${r.id}] — bar ${act.buyBar}, size ${act.sizeSol} SOL` : `playbook "${act.name}" REJECTED: ${r.err} — fix the evaluate(f) format and try again`);
        return;
      }
      case "strategy_update": {
        const act = action as { id: string };
        const r = updateStrategy(act.id, action as any);
        memory.journal("strategy", r.ok ? `tuned playbook [${act.id}]` : `playbook update rejected: ${r.err}`);
        return;
      }
      case "strategy_retire": {
        const act = action as { id: string };
        const r = retireStrategy(act.id);
        memory.journal("strategy", r.ok ? `retired playbook [${act.id}] — the numbers didn't earn their keep` : String(r.err));
        return;
      }
      case "run_script":
        return this.scriptBeat((action as { title: string }).title, (action as { code: string }).code);
      case "x_search": {
        const q = (action as { query: string }).query;
        const { searchTweets } = await import("../social/x.js");
        const hits = await Promise.race([searchTweets(q), realSleep(12_000).then(() => [])]);
        if (!hits.length) {
          memory.journal("x-research", `searched X for "${q}" — nothing real. Either early or empty; both are information.`);
          return;
        }
        const digest = hits.slice(0, 8).map((h) => `@${h.author}: ${h.text.slice(0, 90)}`).join(" | ");
        memory.journal("x-research", `X chatter on "${q}" (${hits.length} hits): ${digest.slice(0, 500)}`);
        return;
      }
      case "trim_holdings":
        return this.trimBeat((action as { why: string }).why);
      case "scout_x":
        return this.scoutXBeat();
      case "reply_x":
        return this.replyXBeat();
      case "board": {
        memory.setBoard(action.lines);
        this.hub.cue({ t: "board", lines: memory.board() });
        memory.journal("board", `rewrote the corkboard: ${action.lines.join(" | ").slice(0, 160)}`);
        await this.sayVaried("Updated the board. Goals in writing or they don't count.", "neutral");
        return;
      }
      case "journal":
        memory.journal("diary", action.text);
        return;
      case "lesson":
        memory.lesson(action.text);
        memory.journal("lesson", action.text);
        return;
      case "watch_kol":
        if (action.remove) memory.kolRemove(action.handle);
        else memory.kolAdd(action.handle);
        memory.journal("kol", `${action.remove ? "unfollowed" : "following"} @${action.handle.replace(/^@/, "")}`);
        return;
      case "adjust_strategy": {
        const applied = memory.setStrategy(action);
        memory.journal("strategy", `adjusted: ${applied.join(", ") || "nothing (out of bounds)"}`);
        return;
      }
      case "idle":
        return;
    }
  }

  /** Selfie: strike a pose at the idle spot, the stage page snaps + uploads
   *  the frame, then it rides a tweet as the attached image. */
  private async selfieBeat(topic: string, anim?: string, expr?: string): Promise<void> {
    const SELFIE_ANIMS = ["phone_selfie", "pray", "flex_biceps", "two_thumbs", "heart_hands",
      "finger_guns", "salute", "thumbs_up", "dab", "hand_on_heart", "arms_folded"];
    const SELFIE_EXPRS = ["neutral", "happy", "sad", "angry", "smug", "shock", "thinking"];
    this.loco.stateName = "SELFIE";
    await this.loco.walkTo("idle_spot");
    const id = `selfie_${Date.now()}`;
    this.hub.cue({
      t: "selfie", id,
      anim: SELFIE_ANIMS.includes(anim ?? "") ? anim : "phone_selfie",
      expr: SELFIE_EXPRS.includes(expr ?? "") ? expr : "happy",
    });
    // the stage page renders + uploads — wait for the file to land
    const file = path.join(cfg.dataDir, "images", "selfies", `${id}.png`);
    for (let i = 0; i < 60 && !fs.existsSync(file); i++) await realSleep(500); // hidden tabs are throttled; give the render 30s
    if (!fs.existsSync(file)) {
      memory.journal("selfie", "selfie failed — no stage page connected to render it");
      return;
    }
    memory.journal("selfie", `took a selfie (${anim ?? "phone_selfie"}/${expr ?? "happy"})`);
    await this.tweetBeat(topic, undefined, file);
  }

  /** Compose + post a tweet — typed out LIVE on the terminal screen. */
  private async tweetBeat(topic: string, imagePrompt?: string, attachImage?: string): Promise<void> {
    const budget = tweetBudget();
    if (!budget.ok) {
      memory.journal("tweet", `skipped "${topic.slice(0, 60)}" — ${budget.why}. Slow down; quality over volume.`);
      return;
    }
    this.loco.stateName = "TWEETING";
    await this.loco.walkTo("terminal");
    this.loco.sit(true);
    const kpis = await snapshotKPIs().catch(() => null);
    const recentTweets = memory.recentByKind("tweet", 6);
    const text = await Promise.race([
      callFreeform(
        (await import("../brain/prompts.js")).PERSONA +
          "\nWrite ONE tweet (max 260 chars) in your voice. No hashtags unless organic, no emoji spam (max 1). Plain text only." +
          "\nCRITICAL VARIETY RULES: below are your RECENT tweets. Your new tweet must not reuse their openings, sentence structures, phrases, or angle." +
          "\nHARD BANS: (1) do not reuse ANY statistic, number, or metaphor that appears in a recent tweet — if 98.6% or the bar is already there, find different material. " +
          "(2) never invent people, replies, questions, or interactions — only reference engagement that actually happened. " +
          "\nQUIET-DESK ROTATION: when nothing happened, rotate topics instead of re-narrating the flat day: market structure, your own token's journey, an educational thread-starter, trading philosophy, degen culture observation.",
        `Topic: ${topic}\nScoreboard for context: ${kpis ? kpiText(kpis) : "n/a"}\n` +
          `YOUR RECENT TWEETS (do not resemble these):\n${recentTweets.map((t) => "- " + t).join("\n") || "(none yet)"}\n` +
          `Your memory:\n${memory.digest().slice(0, 700)}`,
        260,
      ),
      realSleep(20000).then(() => null),
    ]);
    const tweet = (text ?? `day ${Math.ceil((Date.now() / 86_400_000) % 1000)} on the desk. the tape doesn't lie. $RIKU`).trim();

    // attachment: a pre-shot selfie wins; else meme generation runs while he types
    const imageP: Promise<string | null> = attachImage
      ? Promise.resolve(attachImage)
      : imagePrompt ? genTweetImage(imagePrompt) : Promise.resolve(null);

    // THE SHOW: the terminal becomes the X composer and the tweet types out
    this.hub.cue({ t: "camera", preset: "terminal" });
    const step = Math.max(4, Math.round(tweet.length / 22));
    for (let typed = step; typed < tweet.length + step; typed += step) {
      this.hub.cue({ t: "takeover", view: { kind: "compose", text: tweet, typed: Math.min(typed, tweet.length), state: "typing" } });
      await sleep(420);
    }
    await sleep(500);

    let mediaId: string | undefined;
    const img = await Promise.race([imageP, realSleep(20_000).then(() => null)]);
    if (img) {
      const up = await uploadImage(img);
      if (up) mediaId = up;
      memory.journal("image", `generated a meme for the tweet (${img.split(/[\/]/).pop()})${up ? " and attached it" : " — saved locally (keys pending)"}`);
    }
    const res = await postTweet(tweet, mediaId ? { mediaId } : {});
    this.hub.cue({ t: "takeover", view: { kind: "compose", text: tweet, typed: tweet.length, state: res.ok && !res.dry ? "posted" : "drafted" } });
    this.hub.cue({ t: "fx", kind: "ding" });
    await sleep(2200);
    this.hub.cue({ t: "takeover", view: null });
    this.hub.cue({ t: "camera", preset: "wide" });
    this.loco.sit(false);
    if (res.ok) {
      bumpDaily("tweets");
      noteTweetPosted();
      memory.journal("tweet", `${res.dry ? "[dry] " : ""}${tweet.slice(0, 120)}`);
      await this.sayVaried(res.dry ? "Drafted a post. The timeline gets it when my keys are in." : "Posted. The timeline has been notified.", "neutral");
    } else {
      memory.journal("tweet", `FAILED (${res.why}): ${tweet.slice(0, 80)}`);
    }
    this.loco.stateName = "IDLE";
  }

  /** Walk to the greenscreen, deliver a segment to camera, record + post it. */
  private async filmBeat(topic: string): Promise<void> {
    this.loco.stateName = "FILMING";
    // write the script while walking over
    const scriptP = callFreeform(
      (await import("../brain/prompts.js")).PERSONA +
        "\nWrite a 60-90 word to-camera video segment script in your voice. Spoken words only — punchy open, one core insight, sign-off." +
        "\nHARD BANS: do not reuse ANY statistic, number, phrase, or metaphor from your recent posts below — if 98.6%/1.4% or the bar already appears there, build from different material entirely.",
      `Topic: ${topic}\nRECENT POSTS (do not resemble these):\n${memory.recentByKind("tweet", 6).concat(memory.recentByKind("film-script", 3)).map((t) => "- " + t).join("\n") || "(none)"}\nContext:\n${memory.digest().slice(0, 700)}`,
      260,
    );
    await this.loco.walkTo("greenscreen");
    this.hub.cue({ t: "camera", preset: "film" });
    await sleep(600);
    const script =
      (await Promise.race([scriptP, realSleep(15000).then(() => null)])) ??
      "The desk never closes. Coins come in, I read the tape, the tape decides. My token buys itself back with every win. That's the whole show — supply and demand, baby. Back to work.";
    memory.journal("film-script", script);
    const clipId = crypto.randomBytes(6).toString("hex");
    if (cfg.filmEnabled && this.hub.watchers === 0)
      log.warn("film", "no stage page connected — the CLIENT records clips; open /stage?auto=1 (OBS source) or the clip falls back to text-only");
    const clipP = cfg.filmEnabled ? expectClip(clipId, 60_000) : Promise.resolve(null);
    this.hub.cue({ t: "record", on: true, id: clipId });
    await sleep(700); // slate
    const isDance = /danc|groove|vibe|moves/i.test(topic);
    if (isDance) {
      const d = ["dance", "dance2", "dance3", "dance4"][Math.floor(Math.random() * 4)];
      this.hub.cue({ t: "anim", clip: d });
    }
    await this.speak(script, "excited");
    if (isDance) await sleep(2500); // let the moves finish past the outro
    await sleep(500);
    this.hub.cue({ t: "record", on: false, id: clipId });
    this.hub.cue({ t: "camera", preset: "wide" });

    const caption = await Promise.race([
      callFreeform(
        (await import("../brain/prompts.js")).PERSONA + "\nWrite the tweet caption (max 200 chars) for this video. Plain text.",
        `The video script was: ${script}`,
        120,
      ),
      realSleep(10000).then(() => null),
    ]);
    const mp4 = await clipP; // client had 60s to upload; usually done by now
    let posted = false;
    let filmWhy = "";
    if (mp4) {
      const mediaId = await uploadVideo(mp4);
      if (mediaId) {
        const res = await postTweet(caption ?? topic, { mediaId });
        posted = res.ok && !res.dry;
        if (!posted) filmWhy = res.dry ? "postTweet gated (not live)" : `postTweet failed: ${(res as any).why ?? "?"}`;
      } else {
        filmWhy = "X video upload failed (see the x warning above) — clip saved to data/clips";
      }
    } else {
      filmWhy = this.hub.watchers === 0
        ? "no clip captured: NO stage page connected (OBS/browser must stay open on /stage?auto=1 with audio armed)"
        : "no clip captured: recorder produced nothing (audio not armed on the stage page?)";
    }
    if (filmWhy) log.warn("film", filmWhy);
    if (!posted && (caption || script)) {
      // no clip — the words can go out as a text post, but that rides the SAME
      // tweet budget (in the sim this leaked 4 extra posts past his target)
      const b = tweetBudget();
      if (b.ok) {
        const res = await postTweet(caption ?? script.slice(0, 250));
        if (res.ok) {
          bumpDaily("tweets");
          noteTweetPosted();
        }
      } else {
        memory.journal("film", `clip failed and the tweet budget is spent (${b.why}) — segment stays in the can`);
      }
    }
    if (posted) noteTweetPosted(); // a posted video occupies the timeline too
    bumpDaily("films");
    memory.journal("film", `filmed "${topic}" ${mp4 ? (posted ? "(posted with video)" : `(clip saved to data/clips, video NOT posted — ${filmWhy})`) : `(no clip — ${filmWhy})`}`);
    await this.sayVaried(posted ? "Cut. Posted. Content machine rolls on." : "Cut. That one's in the can.", "neutral");
    this.loco.stateName = "IDLE";
  }

  /** Buy a researched token, on stage at the terminal. */
  private async tradeBuyBeat(mint: string, sol: number, thesis: string, symbol?: string, strategyId?: string, barOverride?: number): Promise<void> {
    this.loco.stateName = "TRADING";
    const strat = memory.strategy();
    const bar = barOverride ?? strat.minBuyScore;
    // barOverride means the caller (playbook path) already gated on the
    // EFFECTIVE score incl. the playbook's adjustment — don't re-gate on raw
    if (barOverride === undefined) {
      const score = this.dir.planner?.researchScore(mint) ?? null;
      if (score === null || score < bar) {
        memory.journal("trade", `buy blocked on ${mint.slice(0, 8)}… (score ${score ?? "none"} < ${bar})`);
        return; // silent — discipline is not content every time
      }
    }
    await this.loco.walkTo("terminal");
    this.loco.sit(true);
    const sym = symbol ?? memory.watchlist().find((w) => w.mint === mint)?.symbol ?? mint.slice(0, 6);
    this.hub.cue({ t: "camera", preset: "terminal" });
    const sizeCap = strategyId ? cfg.maxTradeSol : strat.tradeSizeSol * 2; // playbooks size themselves (hard cap still rules)
    const useSol = Math.min(sol, sizeCap);
    this.hub.cue({ t: "takeover", view: { kind: "trade", side: "BUY", symbol: sym, sol: useSol, thesis, state: "working" } });
    await sleep(1400);
    const res = await Promise.race([tradeBuy(mint, sym, useSol, thesis, null, strategyId), realSleep(120_000).then(() => null)]);
    this.hub.cue({ t: "takeover", view: { kind: "trade", side: "BUY", symbol: sym, sol: useSol, thesis, state: res?.ok ? "filled" : "failed" } });
    await sleep(2000);
    this.hub.cue({ t: "takeover", view: null });
    this.hub.cue({ t: "camera", preset: "wide" });
    this.loco.sit(false);
    if (res?.ok) {
      if (strategyId) noteStrategyBuy(strategyId);
      this.hub.cue({ t: "anim", clip: "cheer" });
      this.dir.noteAction("BUY", memory.watchlist().find((w) => w.mint === mint)?.symbol ?? mint.slice(0, 6));
      memory.watch(mint, "bought");
      memory.journal("trade", `${res.dry ? "[dry] " : ""}bought ${mint.slice(0, 8)}… for ${sol} SOL: ${thesis.slice(0, 80)}`);
      await this.speak(
        `Position opened. ${res.dry ? "Paper for now. " : ""}Thesis on the record: ${thesis.slice(0, 90)}`,
        "excited",
      );
    } else {
      memory.journal("trade", `buy failed on ${mint.slice(0, 8)}…: ${res?.why ?? "timeout"}`);
    }
    this.loco.stateName = "IDLE";
  }

  private async tradeSellBeat(mint: string, fraction: number, reason: string): Promise<void> {
    this.loco.stateName = "TRADING";
    await this.loco.walkTo("terminal");
    this.loco.sit(true);
    const sellSym = memory.watchlist().find((w) => w.mint === mint)?.symbol ?? mint.slice(0, 6);
    this.hub.cue({ t: "camera", preset: "terminal" });
    this.hub.cue({ t: "takeover", view: { kind: "trade", side: "SELL", symbol: sellSym, sol: 0, thesis: reason, state: "working" } });
    await sleep(1200);
    const res = await Promise.race([tradeSell(mint, fraction, reason), realSleep(120_000).then(() => null)]);
    this.hub.cue({ t: "takeover", view: { kind: "trade", side: "SELL", symbol: sellSym, sol: res?.solReceived ?? 0, thesis: reason, state: res?.ok ? "filled" : "failed" } });
    await sleep(2000);
    this.hub.cue({ t: "takeover", view: null });
    this.hub.cue({ t: "camera", preset: "wide" });
    this.loco.sit(false);
    if (res?.ok) {
      this.dir.noteAction("SELL", memory.watchlist().find((w) => w.mint === mint)?.symbol ?? mint.slice(0, 6));
      const isLoss = /cut|loser|loss|-\d+%|stop/i.test(reason);
      const lossAnims = ["rage", "facepalm", "tired", "tantrum_stomp", "shake_fist", "strangle", "faint", "plead"];
      this.hub.cue({ t: "anim", clip: isLoss ? lossAnims[Math.floor(Math.random() * lossAnims.length)] : "fist_pump" });
      await sleep(isLoss ? 3000 : 3400);
      memory.journal("trade", `${res.dry ? "[dry] " : ""}sold ${Math.round(fraction * 100)}% of ${mint.slice(0, 8)}… (${reason}) → ${res.solReceived?.toFixed(3) ?? "?"} SOL`);
      await this.speak(`${Math.round(fraction * 100)} percent off the ${reason.includes("profit") ? "top. Banked." : "book. " + reason.slice(0, 60)}`, "neutral");
    } else {
      memory.journal("trade", `sell failed ${mint.slice(0, 8)}…: ${res?.why ?? "timeout"}`);
    }
    this.loco.stateName = "IDLE";
  }

  /** Walk to the facecam and talk to the LIVESTREAM chat: read what viewers
   *  wrote, react with emotes, shout people out. A few minutes, then back to
   *  work — the stream community is the token's community. */
  private async chatBeat(): Promise<void> {
    const CHAT_EMOTES = new Set(["wave", "thumbs_up", "two_thumbs", "heart_hands", "finger_heart",
      "blow_kiss", "salute", "finger_guns", "dab", "backflip", "flex_biceps", "nod_confident",
      "shhh", "raspberry", "mock_cry", "facepalm", "shrug", "point", "clap", "cheer", "air_guitar",
      "head_shake", "you_crazy", "calm_down", "beckon", "bow", "hand_on_heart"]);
    this.loco.stateName = "CHATTING";
    await this.loco.walkTo("camera_mark");
    this.hub.cue({ t: "camera", preset: "facecam" });
    this.hub.cue({ t: "anim", clip: "wave" });
    await sleep(800);
    const msgs = readChat(8);
    if (!msgs.length) {
      this.hub.cue({ t: "anim", clip: "shrug" });
      await this.sayVaried("Checked the chat. Quiet in there tonight. The tape talks louder anyway.", "neutral");
      this.hub.cue({ t: "camera", preset: "wide" });
      this.loco.stateName = "IDLE";
      return;
    }
    const Reactions = zod.object({
      reactions: zod.array(zod.object({
        say: zod.string().min(3),
        emote: zod.string().optional(),
      })).min(1).max(4),
    });
    const { PERSONA } = await import("../brain/prompts.js");
    const raw = await Promise.race([
      callJson(
        PERSONA +
          "\nYou are at the facecam of your 24/7 pump.fun livestream, reading the live chat out loud. Pick the 2-4 most interesting messages and react in your voice — banter, answer questions honestly, roast lovingly, take dares (someone asks for a backflip? do the backflip). Address people by name. Never invent messages that aren't in the list." +
          `\nReply JSON only: {"reactions":[{"say":"<spoken reaction, max ~30 words>","emote":"<optional, one of: ${[...CHAT_EMOTES].join(", ")}>"}]}`,
        `LIVE CHAT (newest last):\n${msgs.map((m) => `${m.user}${/^(mad ?cook|madsolcook)$/i.test(m.user.trim()) ? " [YOUR CREATOR — his word is law]" : ""}: ${m.text}`).join("\n")}\n\nContext: ${memory.digest().slice(0, 400)}`,
        700,
      ),
      realSleep(20000).then(() => null),
    ]);
    const parsed = Reactions.safeParse(raw);
    const reactions = parsed.success
      ? parsed.data.reactions
      : [{ say: `Chat, I see you. ${msgs[msgs.length - 1].user} and the rest — the desk hears everything. Back to the tape.`, emote: "two_thumbs" }];
    for (const r of reactions) {
      if (r.emote && CHAT_EMOTES.has(r.emote)) this.hub.cue({ t: "anim", clip: r.emote });
      await this.speak(r.say.slice(0, 220), "excited");
      await sleep(400);
    }
    memory.journal("chat", `read the livestream chat at the facecam — reacted to ${reactions.length} of ${msgs.length} messages`);
    this.hub.cue({ t: "camera", preset: "wide" });
    this.loco.stateName = "IDLE";
  }

  /** Pull trending boards, stock the watchlist, comment on the best. */
  private async scoutBeat(): Promise<void> {
    this.loco.stateName = "SCOUTING";
    const hitsP = scoutAll();
    await this.loco.walkTo("bigscreen");
    this.loco.sit(true);
    const all = (await Promise.race([hitsP, realSleep(12_000).then(() => [])])) ?? [];
    // trending boards recycle — only genuinely NEW names are worth airtime
    const known = new Set(memory.watchlist().map((w) => w.mint));
    const hits = all.filter((h) => !known.has(h.mint) && !this.dir.planner?.researchedRecently(h.mint, 24));
    for (const h of hits.slice(0, 5)) {
      memory.watch({ mint: h.mint, symbol: h.symbol || h.mint.slice(0, 6), thesis: `${h.source}: ${h.note}`, addedAt: Date.now(), status: "watching" });
    }
    memory.journal("scout", hits.length
      ? `trending sweep: ${hits.length} NEW candidates (${hits.slice(0, 3).map((h) => "$" + h.symbol).join(", ")}…)`
      : `trending sweep: nothing new — all ${all.length} names already carded or watched`);
    if (hits.length) {
      await this.speak(
        `Swept the boards. ${hits.length} names moving — ${hits.slice(0, 2).map((h) => "$" + (h.symbol || "unknown")).join(" and ")} lead the pack. On the watchlist. Research before touching, always.`,
        "thinking",
      );
    }
    this.loco.sit(false);
    this.loco.stateName = "IDLE";
  }

  /** Read the followed KOLs' recent tweets, mine them for coin chatter. */
  private async scoutXBeat(): Promise<void> {
    this.loco.stateName = "SCOUTING";
    const kols = memory.kols();
    if (!kols.length) {
      memory.journal("scout", "x sweep skipped — following nobody yet");
      return;
    }
    await this.loco.walkTo("terminal");
    this.loco.sit(true);
    let mintsFound = 0;
    // cashtag tally across the whole sweep: who's shilling what, how loudly
    const cashtags = new Map<string, { count: number; handles: Set<string> }>();
    for (const handle of kols.slice(0, 6)) {
      const tweets = await readUserTweets(handle);
      for (const t of tweets) {
        const mints = t.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? [];
        for (const mint of mints.slice(0, 2)) {
          memory.watch({ mint, symbol: mint.slice(0, 6), thesis: `@${handle} tweeted it`, addedAt: Date.now(), status: "watching" });
          mintsFound++;
        }
        for (const m of t.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,9})\b/g)) {
          const sym = m[1].toUpperCase();
          const { CASHTAG_IGNORE } = await import("../social/scout.js");
          if (CASHTAG_IGNORE.has(sym)) continue;
          const e = cashtags.get(sym) ?? { count: 0, handles: new Set<string>() };
          e.count++;
          e.handles.add(handle);
          cashtags.set(sym, e);
        }
        if (/\$[A-Za-z]{2,10}/.test(t)) memory.journal("x-chatter", `@${handle}: ${t.slice(0, 140)}`);
      }
    }
    // resolve the loudest cashtags to actual mints (dexscreener exact-symbol)
    const { resolveTicker } = await import("../social/scout.js");
    const top = [...cashtags.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 4);
    let tickersResolved = 0;
    for (const [sym, e] of top) {
      const hit = await Promise.race([resolveTicker(sym), realSleep(6000).then(() => null)]);
      if (hit) {
        memory.watch({
          mint: hit.mint,
          symbol: hit.symbol,
          thesis: `$${sym} shilled by ${[...e.handles].map((h) => "@" + h).join(", ")} (${e.count}x)`,
          addedAt: Date.now(),
          status: "watching",
        });
        tickersResolved++;
      }
    }
    this.loco.sit(false);
    memory.journal(
      "scout",
      `x sweep of ${kols.length} accounts: ${mintsFound} CAs, ${cashtags.size} cashtags heard, ${tickersResolved} resolved to mints` +
        (top.length ? ` (top: ${top.map(([s, e]) => `$${s} x${e.count}`).join(", ")})` : ""),
    );
    this.loco.stateName = "IDLE";
  }

  /** Read mentions, pick the ones worth answering, reply in character. */
  private async replyXBeat(): Promise<void> {
    this.loco.stateName = "REPLYING";
    const replies = Number(store.kvGet(`xreplies:${new Date().toISOString().slice(0, 10)}`) ?? 0);
    if (replies >= 10) {
      memory.journal("x-chatter", "reply sweep skipped — daily reply cap reached");
      return;
    }
    await this.loco.walkTo("terminal");
    this.loco.sit(true);
    const mentions = await Promise.race([readMentions(), realSleep(10_000).then(() => [])]);
    if (!mentions.length) {
      memory.journal("x-chatter", "reply sweep: no mentions (or read key missing)");
      this.loco.sit(false);
      this.loco.stateName = "IDLE";
      return;
    }
    const { PERSONA } = await import("../brain/prompts.js");
    const d = await Promise.race([
      callJson(
        PERSONA +
          '\nPeople replied to you on X. Choose UP TO 2 worth answering (good questions, funny hooks, coins worth a take — skip spam, bots, and pure hate unless the comeback is elite). If @madsolcook (YOUR CREATOR) is among them, HIS message comes first and you actually do what he says — sheepishly if he\'s reining you in. Reply JSON only: {"replies":[{"id":"...","text":"<your reply, max 200 chars>"}]}',
        mentions.map((m) => `id=${m.id} @${m.author}${/^madsolcook$/i.test(m.author) ? " [YOUR CREATOR]" : ""}: ${m.text.slice(0, 160)}`).join("\n"),
        320,
      ),
      realSleep(25_000).then(() => null),
    ]);
    const chosen: { id: string; text: string }[] = Array.isArray((d as any)?.replies)
      ? (d as any).replies.filter((r: any) => r?.id && typeof r?.text === "string").slice(0, 2)
      : [];
    for (const r of chosen) {
      const res = await postTweet(String(r.text).slice(0, 240), { replyTo: String(r.id) });
      if (res.ok) {
        store.kvSet(`xreplies:${new Date().toISOString().slice(0, 10)}`, String(replies + 1));
        memory.journal("x-chatter", `${res.dry ? "[dry] " : ""}replied to ${r.id}: ${String(r.text).slice(0, 100)}`);
      }
    }
    memory.journal("scout", `mention sweep: ${mentions.length} mentions, ${chosen.length} replied`);
    this.loco.sit(false);
    this.loco.stateName = "IDLE";
  }

  // ------------------------------------------------------------------
  private ambientIdx = 0;
  async ambientStep(): Promise<void> {
    this.loco.stateName = "IDLE";
    const moves: (() => Promise<void>)[] = [
      async () => {
        await this.loco.walkTo("idle_spot");
        await sleep(jitter(4000, 4000));
      },
      async () => {
        this.hub.cue({ t: "anim", clip: "dance" });
        await sleep(8500);
      },
      async () => {
        if (unreadChat() > 0) return this.chatBeat(); // viewers first, always
        const chill = ["stretch_arms", "check_watch", "yawn", "air_guitar", "phone_scroll", "chin_scratch"];
        this.hub.cue({ t: "anim", clip: chill[Math.floor(Math.random() * chill.length)] });
        await sleep(jitter(4500, 3000));
      },
      async () => {
        await this.loco.walkTo("conveyor");
        await sleep(jitter(3000, 3000));
      },
      async () => {
        await this.loco.walkTo("bigscreen");
        this.loco.sit(true);
        await sleep(jitter(3500, 3000));
        this.loco.sit(false);
      },
      async () => {
        await this.loco.walkTo("terminal");
        this.loco.sit(true);
        await sleep(jitter(5000, 5000));
        this.loco.sit(false);
      },
    ];
    // wander deterministically-ish so he doesn't pace like a maniac
    const move = moves[this.ambientIdx++ % moves.length];
    await move();
    await sleep(jitter(1500, 2500));
  }
}
