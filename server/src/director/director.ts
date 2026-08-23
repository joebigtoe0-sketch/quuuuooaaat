import { cfg, simT } from "../config.js";
import { log } from "../log.js";
import { store } from "../store.js";
import type { Hub } from "../hub.js";
import type {
  CalloutCard,
  ConveyorItem,
  InspectionState,
  SnapshotMsg,
  TakeoverView,
  TreasuryState,
} from "../protocol.js";

/** The investment desk's verdict payload — exactly the investdesk takeover. */
export type InvestNote = Extract<TakeoverView, { kind: "investdesk" }>;
import { Locomotion } from "./locomotion.js";
import { Beats } from "./beats.js";
import type { InboxEvent } from "../chain/inbox.js";
import type { PendingBuyback } from "../chain/buyback.js";
import { solBalance, walletHoldings } from "../chain/wallet.js";
import { ownTokenBalanceUi } from "../chain/buyback.js";
import { openPositions } from "../chain/trader.js";
import { memory } from "../agent/memory.js";
import type { ActionEvent } from "../protocol.js";
import type { TTSProvider } from "../voice/tts.js";
import { Planner, type QueuedAction } from "../agent/planner.js";

/**
 * The show director: one loop, one priority queue, beats run to completion
 * (never interrupt mid-sentence). Priorities:
 *   1. inbox coins  2. buyback ceremony  3. conveyor pick  4. commentary
 * Ambient filler runs when nothing is queued.
 */
type Job =
  | { kind: "inbox"; ev: InboxEvent; at: number }
  | { kind: "buyback"; p: PendingBuyback; at: number }
  | { kind: "agent"; qa: QueuedAction; at: number }
  | { kind: "conveyor"; item: ConveyorItem; at: number }
  | { kind: "reveal"; mint: string; sol: number; revealKind: "snipe" | "call" | "hold"; at: number }
  | { kind: "exitnote"; symbol: string; reason: string; solReceived: number; costSol: number; at: number }
  | { kind: "investnote"; p: InvestNote; at: number }
  | { kind: "kolfeed"; at: number }
  | { kind: "replyx"; at: number }
  | { kind: "commentary"; at: number };

export class Director {
  readonly loco: Locomotion;
  readonly beats: Beats;

  private inboxQ: Job[] = [];
  private buybackQ: Job[] = [];
  private agentQ: Job[] = [];
  readonly planner: Planner;
  private conveyor: ConveyorItem[] = [];
  private lastConveyorPick = Date.now();
  private lastCommentary = Date.now();
  private lastKolFeed = Date.now();
  private lastReplyX = Date.now();
  noteReplyX(): void { this.lastReplyX = Date.now(); }
  /** the agent can also trigger it; this is the floor so it ALWAYS happens */
  noteKolFeed(): void { this.lastKolFeed = Date.now(); }
  private running = false;
  paused = false;

  // renderer-visible state (mirrored into every snapshot)
  inspection: InspectionState = { mint: null, name: "", symbol: "", rows: [], score: null, tier: null };
  treasury: TreasuryState = { sol: 0, ownTokens: 0, buybacks: [], neverSoldDays: 0, holdings: [] };

  constructor(
    private hub: Hub,
    tts: TTSProvider,
  ) {
    this.loco = new Locomotion(hub);
    this.beats = new Beats(hub, this.loco, tts, this);
    this.planner = new Planner((qa) => {
      if (this.agentQ.length < 6) this.agentQ.push({ kind: "agent", qa, at: Date.now() });
    });
    hub.onSnapshot(() => this.snapshot());
    void this.refreshTreasury();
    setInterval(() => void this.refreshTreasury(), 60_000);
  }

  // ---------- inputs ----------
  onInboxCoin(ev: InboxEvent): void {
    if (store.seenAt(ev.mint) && Date.now() - store.seenAt(ev.mint)! < 86_400_000) {
      log.info("director", `mint ${ev.mint.slice(0, 8)}… seen in last 24h — ignoring`);
      return;
    }
    if (ev.sender) {
      const last = store.senderLastAt(ev.sender);
      if (last && Date.now() - last < simT(cfg.senderCooldownMin * 60_000)) {
        log.info("director", `sender ${ev.sender.slice(0, 8)}… on cooldown — ignoring`);
        return;
      }
      store.markSender(ev.sender);
    }
    if (this.inboxQ.length >= 5) {
      log.warn("director", "inbox queue full — dropping");
      return;
    }
    store.markSeen(ev.mint);
    this.inboxQ.push({ kind: "inbox", ev, at: Date.now() });
    this.hub.cue({ t: "fx", kind: "ding" });
  }

  onBuybackPending(p: PendingBuyback): void {
    if (this.buybackQ.length === 0) this.buybackQ.push({ kind: "buyback", p, at: Date.now() });
  }

  /** Admin: what's waiting to run — one line per queued job. */
  queueSnapshot(): { queue: string; i: number; summary: string; at: number }[] {
    const out: { queue: string; i: number; summary: string; at: number }[] = [];
    this.inboxQ.forEach((j: any, i) => out.push({ queue: "inbox", i, at: j.at, summary: `coin ${String(j.ev?.mint ?? "?").slice(0, 10)}… from ${String(j.ev?.sender ?? "?").slice(0, 8)}` }));
    this.buybackQ.forEach((j: any, i) => out.push({ queue: "buyback", i, at: j.at, summary: `buyback pending` }));
    this.agentQ.forEach((j: any, i) => {
      const a = j.qa?.action ?? {};
      out.push({ queue: "agent", i, at: j.at, summary: `${a.do ?? "?"} ${JSON.stringify(a).slice(0, 90)}` });
    });
    return out;
  }

  /** Admin: drop one queued job (by queue name + current index) or a whole queue. */
  removeQueued(queue: string, i?: number): number {
    const q = queue === "inbox" ? this.inboxQ : queue === "buyback" ? this.buybackQ : queue === "agent" ? this.agentQ : null;
    if (!q) return 0;
    if (i === undefined || i < 0) {
      const n = q.length;
      q.length = 0;
      return n;
    }
    return q.splice(i, 1).length;
  }

  /** Externally-injected agent action (admin/testing) — same queue the planner feeds. */
  onAgentAction(qa: QueuedAction, urgent = false): { ok: boolean; depth: number; why?: string } {
    // ADMIN presses jump the queue — pressing a button should do the thing
    // NEXT, not queue behind planner work. Silent drops are never acceptable:
    // the caller gets the truth so the panel can say so.
    if (urgent) {
      this.agentQ.unshift({ kind: "agent", qa, at: Date.now() });
      if (this.agentQ.length > 8) this.agentQ.length = 8;
      return { ok: true, depth: this.agentQ.length };
    }
    if (this.agentQ.length >= 6) return { ok: false, depth: this.agentQ.length, why: "agent queue full" };
    this.agentQ.push({ kind: "agent", qa, at: Date.now() });
    return { ok: true, depth: this.agentQ.length };
  }

  // a rolling pool of recent launches from the pumpportal feed — this is our
  // FRESH pump-token supply for research, since pump.fun's trending API is
  // Cloudflare-blocked server-side (scout returns "0 pump"). Timestamped so we
  // can research ones that have aged enough to be readable (candle + holders).
  private launchPool: { mint: string; at: number }[] = [];
  onLaunch(item: ConveyorItem): void {
    this.conveyor.push(item);
    if (this.conveyor.length > 12) this.conveyor.shift();
    this.hub.cue({ t: "conveyor_add", item });
    if (item.mint?.endsWith("pump") && !this.launchPool.some((l) => l.mint === item.mint)) {
      this.launchPool.push({ mint: item.mint, at: Date.now() });
      // keep 4 HOURS of launches — a coin needs time to bond 40%, and the
      // batched progress sweep makes checking hundreds of them cheap
      const cutoff = Date.now() - 4 * 3600_000;
      this.launchPool = this.launchPool.filter((l) => l.at > cutoff).slice(-600);
    }
  }

  private recentlyResearched = new Set<string>();
  /** A pump token for a research checkup — trending boards first, then the fresh
   *  launch pool (aged 3-20 min so there's actual history to read). */
  private async pickTrendingMint(): Promise<string | null> {
    const { openPositions } = await import("../chain/trader.js");
    const held = new Set(openPositions().map((p) => p.mint));
    const { touchBan } = await import("../agent/tokenguard.js");
    const eligible = (mint: string) =>
      mint.endsWith("pump") &&
      mint !== cfg.ownMint &&
      !held.has(mint) &&
      !this.recentlyResearched.has(mint) &&
      !this.planner.researchedRecently(mint, 8) &&
      !(store.seenAt(mint) && Date.now() - store.seenAt(mint)! < 6 * 3600_000) &&
      !touchBan(mint);
    const take = (mint: string) => {
      this.recentlyResearched.add(mint);
      if (this.recentlyResearched.size > 300) this.recentlyResearched = new Set([...this.recentlyResearched].slice(-150));
      return mint;
    };
    const shuffle = (a: string[]) =>
      a.map((v) => [Math.random(), v] as const).sort((x, y) => x[0] - y[0]).map(([, v]) => v);
    try {
      const { scoutAll } = await import("../social/scout.js");
      const hits = await Promise.race([
        scoutAll(),
        new Promise<[]>((r) => setTimeout(() => r([]), 10_000)),
      ]);
      const now = Date.now();
      // trending first (they have momentum), then the launch pool aged 3 min -
      // 4 h (old enough to read, young enough to still be a story)
      const candidates = [
        ...shuffle((hits ?? []).map((h) => h.mint).filter(eligible)),
        ...shuffle(this.launchPool
          .filter((l) => now - l.at > 3 * 60_000 && eligible(l.mint))
          .map((l) => l.mint)),
      ];
      if (!candidates.length) return null;
      // SURVIVORS ONLY: one batched RPC sweep reads every candidate's bonding
      // progress. Random checkups only dig into coins that actually CLIMBED —
      // at least minResearchProgress bonded (graduated counts as done). Dead
      // launches never reach the desk again.
      const { curveProgressBatch } = await import("../chain/pump.js");
      const prog = await curveProgressBatch(candidates.slice(0, 200));
      const alive = candidates.filter((m) => (prog.get(m) ?? 0) >= cfg.minResearchProgress);
      if (alive.length) return take(alive[Math.floor(Math.random() * Math.min(alive.length, 6))]);
      // nothing at the bar this cycle — settle for the liveliest thing that's
      // at least MOVING (>=10% bonded), never a flatline
      let best: string | null = null;
      let bestP = 0.1;
      for (const [m, p] of prog) {
        if (p >= bestP && p < 1) { best = m; bestP = p; }
      }
      return best ? take(best) : null;
    } catch {
      return null;
    }
  }

  // ---------- the loop ----------
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
    log.info("director", "show loop started");
  }

  private forcedResearch = 0;
  /** Admin: research a freshly-discovered coin NOW (jumps the timer). */
  forceResearch(): void { this.forcedResearch = Math.min(3, this.forcedResearch + 1); }

  // a filled quiet-edge entry waiting for its on-stream "discovery" — top
  // priority, the reveal must land while the coin is still fresh
  private revealQ: { mint: string; sol: number; revealKind: "snipe" | "call" | "hold" }[] = [];
  queueReveal(mint: string, sol: number, revealKind: "snipe" | "call" | "hold" = "snipe"): void {
    if (this.revealQ.length < 4 && !this.revealQ.some((r) => r.mint === mint)) this.revealQ.push({ mint, sol, revealKind });
  }

  // exits already HAPPENED (the desk sells instantly) — the stage narrates
  // them right after any pending reveal, while the fill is still news
  private exitQ: { symbol: string; reason: string; solReceived: number; costSol: number }[] = [];
  queueExitNote(symbol: string, reason: string, solReceived: number, costSol: number): void {
    if (this.exitQ.length < 4) this.exitQ.push({ symbol, reason, solReceived, costSol });
  }

  // the investment desk's half-hourly verdicts — pass or buy, both are a
  // segment (the passes are half the content)
  private investQ: InvestNote[] = [];
  queueInvestNote(p: InvestNote): void {
    if (this.investQ.length < 2) this.investQ.push(p);
  }

  private nextJob(): Job | null {
    const rv = this.revealQ.shift();
    if (rv) return { kind: "reveal", mint: rv.mint, sol: rv.sol, revealKind: rv.revealKind, at: Date.now() };
    const ex = this.exitQ.shift();
    if (ex) return { kind: "exitnote", ...ex, at: Date.now() };
    const inv = this.investQ.shift();
    if (inv) return { kind: "investnote", p: inv, at: Date.now() };
    if (this.inboxQ.length) return this.inboxQ.shift()!;
    if (this.buybackQ.length) return this.buybackQ.shift()!;
    if (this.agentQ.length) return this.agentQ.shift()!;
    const idleMin = (Date.now() - this.lastConveyorPick) / simT(60_000);
    // research a DISCOVERED coin on the timer, or immediately when forced from
    // admin. The target is resolved at execution (trending + fresh launch pool),
    // so we no longer gate on the visual belt having items.
    if (this.forcedResearch > 0 || idleMin >= cfg.conveyorPickMin) {
      if (this.forcedResearch > 0) this.forcedResearch--;
      const item = this.conveyor[this.conveyor.length - 1] ?? { mint: "", name: "", symbol: "" };
      if (item.mint) this.conveyor = this.conveyor.filter((c) => c.mint !== item.mint);
      this.lastConveyorPick = Date.now();
      return { kind: "conveyor", item, at: Date.now() };
    }
    const autoReplyOff = store.kvGet("autoreply:off") === "1";
    if (!autoReplyOff && (Date.now() - this.lastReplyX) / simT(60_000) >= cfg.replyXMin) {
      this.lastReplyX = Date.now();
      return { kind: "replyx", at: Date.now() };
    }
    if (!autoReplyOff && (Date.now() - this.lastKolFeed) / simT(60_000) >= cfg.kolFeedMin) {
      this.lastKolFeed = Date.now();
      return { kind: "kolfeed", at: Date.now() };
    }
    if ((Date.now() - this.lastCommentary) / simT(60_000) >= cfg.commentaryMin) {
      this.lastCommentary = Date.now();
      return { kind: "commentary", at: Date.now() };
    }
    return null;
  }

  private async loop(): Promise<void> {
    // small boot pause so a first client can connect
    await new Promise((r) => setTimeout(r, 2500));
    for (;;) {
      try {
        if (this.paused) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        const job = this.nextJob();
        if (!job) {
          await this.beats.ambientStep();
          continue;
        }
        this.runningBeat = job.kind; // beats own the screen + camera while set
        if (job.kind === "inbox") await this.beats.researchBeat(job.ev.mint, job.ev.amountRaw, job.ev.sender, false);
        else if (job.kind === "reveal") {
          // a quiet-edge fill gets its on-stream discovery: staged as a normal
          // launch-feed find — research, high marks, position reveal, callout
          await this.beats.researchBeat(job.mint, null, null, true, { sol: job.sol, kind: job.revealKind });
        }
        else if (job.kind === "exitnote") { await this.beats.exitNoteBeat(job.symbol, job.reason, job.solReceived, job.costSol); }
        else if (job.kind === "investnote") { await this.beats.investDeskBeat(job.p); }
        else if (job.kind === "replyx") { await this.beats.runReplyX(); }
        else if (job.kind === "kolfeed") { await this.beats.runKolFeed(); }
        else if (job.kind === "conveyor") {
          // seconds-old launches are unreadable (no candle, no holders) —
          // random checkups use TRENDING tokens only; no candidate = skip
          const trending = await this.pickTrendingMint();
          if (trending) await this.beats.researchBeat(trending, null, null, true);
          else log.info("director", "random checkup skipped — no trending candidate this cycle");
        }
        else if (job.kind === "buyback") await this.beats.buybackBeat(job.p.sol);
        else if (job.kind === "agent") await this.beats.agentBeat(job.qa.action, job.qa.manual === true);
        else if (job.kind === "commentary") await this.beats.commentaryBeat();
      } catch (e) {
        log.error("director", `beat crashed: ${String(e).slice(0, 200)}`);
        this.loco.stateName = "RECOVER";
        await new Promise((r) => setTimeout(r, 2000));
      } finally {
        this.runningBeat = null;
      }
    }
  }

  // ---------- producer post visibility ----------
  // beats own the terminal + camera; decoration must never steal them
  private runningBeat: string | null = null;
  private postAnimBusy = false;
  private postAnimQueued = 0;

  /** Animate a producer post/reply on the terminal — the post ALREADY went
   *  out; this is pure depiction. Never blocks the caller, never interrupts a
   *  beat, serialises with itself (extras beyond a short queue are dropped —
   *  it's decoration), and skips when no stage page is connected. */
  showPost(opts: { text: string; replyTo?: string; ok: boolean }): void {
    if (this.hub.watchers === 0) return; // nobody's watching — don't perform
    if (this.postAnimQueued >= 2) return; // three-in-a-row replies: drop extras
    this.postAnimQueued++;
    void (async () => {
      try {
        // wait briefly for the terminal to free up; give up rather than steal
        const until = Date.now() + 20_000;
        while ((this.postAnimBusy || this.runningBeat) && Date.now() < until)
          await new Promise((r) => setTimeout(r, 500));
        if (this.postAnimBusy || this.runningBeat) return;
        this.postAnimBusy = true;
        try {
          const text = opts.text;
          this.hub.cue({ t: "camera", preset: "terminal" });
          // cap the animation: long-form (300-1000 chars) types in the same
          // ~9s wall clock as a normal tweet, just with bigger chunks
          const iterations = Math.min(22, Math.max(4, Math.ceil(text.length / 13)));
          const step = Math.max(1, Math.ceil(text.length / iterations));
          for (let typed = step; typed < text.length + step; typed += step) {
            if (this.runningBeat) return; // a beat started — vanish quietly
            this.hub.cue({
              t: "takeover",
              view: { kind: "compose", text, typed: Math.min(typed, text.length), state: "typing", ...(opts.replyTo ? { replyTo: opts.replyTo } : {}) },
            });
            await new Promise((r) => setTimeout(r, 420));
          }
          await new Promise((r) => setTimeout(r, 500));
          this.hub.cue({
            t: "takeover",
            view: { kind: "compose", text, typed: text.length, state: opts.ok ? "posted" : "drafted", ...(opts.replyTo ? { replyTo: opts.replyTo } : {}) },
          });
          if (opts.ok) this.hub.cue({ t: "fx", kind: "ding" });
          await new Promise((r) => setTimeout(r, 2200));
        } finally {
          this.postAnimBusy = false;
          // release the screen — but never clobber a camera a beat just set
          this.hub.cue({ t: "takeover", view: null });
          if (!this.runningBeat) this.hub.cue({ t: "camera", preset: "wide" });
        }
      } catch { /* decoration must never throw into the void */ }
      finally {
        this.postAnimQueued--;
      }
    })();
  }

  // ---------- state for renderer ----------
  /** What the desk DID — rendered as the bigscreen ticker. */
  private actionsLog: ActionEvent[] = [];
  noteAction(kind: ActionEvent["kind"], symbol: string): void {
    this.actionsLog.push({ kind, symbol, at: Date.now() });
    if (this.actionsLog.length > 12) this.actionsLog.shift();
    this.hub.cue({ t: "actions", list: this.actionsLog });
  }
  actions(): ActionEvent[] {
    return this.actionsLog;
  }

  async refreshTreasury(): Promise<void> {
    try {
      const firstBuyback = store.buybacks()[0]?.at ?? Date.now();
      // the vault shows EVERYTHING he holds. Paper positions are appended only
      // in dry mode — live buys are real token accounts already in the wallet.
      const { estimateSellSolFor } = await import("../chain/pump.js");
      const { PublicKey } = await import("@solana/web3.js");
      const pnlFor = async (p: { mint: string; tokensRaw: string; costSol: number; soldSol?: number }) => {
        try {
          const nowSol = await estimateSellSolFor(new PublicKey(p.mint), BigInt(p.tokensRaw));
          const basis = Math.max(0, p.costSol - (p.soldSol ?? 0));
          return basis > 0.001 ? ((nowSol - basis) / basis) * 100 : undefined;
        } catch {
          return undefined;
        }
      };
      const posByMint = new Map(openPositions().map((p) => [p.mint, p]));
      const real: { symbol: string; amount: number; paper?: boolean; image?: string; pnl?: number }[] = [];
      for (const h of await walletHoldings()) {
        const p = posByMint.get(h.mint);
        real.push({ symbol: h.symbol, amount: h.amount, image: h.image, pnl: p ? await pnlFor(p) : undefined });
      }
      const { tokenDisplay } = await import("../chain/wallet.js");
      const paper: { symbol: string; amount: number; paper: boolean; image?: string; pnl?: number }[] = [];
      if (cfg.tradeDryRun) {
        for (const p of openPositions()) {
          const looksLikeMint = p.mint.startsWith(p.symbol);
          const d = await tokenDisplay(p.mint).catch(() => null);
          paper.push({
            symbol: looksLikeMint && d ? d.symbol : p.symbol,
            amount: Number(p.tokensRaw) / 1e6,
            paper: true,
            image: d?.image,
            pnl: await pnlFor(p),
          });
        }
      }
      this.treasury = {
        sol: await solBalance(),
        ownTokens: await ownTokenBalanceUi(),
        buybacks: store.buybacks().slice(-8),
        neverSoldDays: Math.floor((Date.now() - firstBuyback) / 86_400_000),
        holdings: [...real, ...paper].slice(0, 12),
      };
      this.hub.cue({ t: "screen_treasury", state: this.treasury });
    } catch {}
  }

  calloutCards(): CalloutCard[] {
    return store
      .callouts()
      .slice(-8)
      .map((c) => ({
        mint: c.mint,
        symbol: c.symbol,
        text: c.text,
        tier: c.tier,
        at: c.at,
        entryMcSol: c.entryMcSol,
        dry: c.dry,
      }));
  }

  snapshot(): SnapshotMsg {
    return {
      t: "snapshot",
      now: Date.now(),
      inspection: this.inspection,
      treasury: this.treasury,
      callouts: this.calloutCards(),
      conveyor: this.conveyor,
      board: memory.board(),
      actions: this.actionsLog,
      avatar: {
        x: this.loco.x,
        z: this.loco.z,
        heading: this.loco.heading,
        anim: this.loco.anim,
        seated: this.loco.seated,
      },
      state: this.loco.stateName,
    };
  }
}
