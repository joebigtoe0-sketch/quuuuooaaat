import { cfg, simT } from "../config.js";
import { log } from "../log.js";
import { store } from "../store.js";
import type { Hub } from "../hub.js";
import type {
  CalloutCard,
  ConveyorItem,
  InspectionState,
  SnapshotMsg,
  TreasuryState,
} from "../protocol.js";
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
  onAgentAction(qa: QueuedAction): void {
    if (this.agentQ.length < 6) this.agentQ.push({ kind: "agent", qa, at: Date.now() });
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
      const cutoff = Date.now() - 30 * 60_000; // keep the last 30 min
      this.launchPool = this.launchPool.filter((l) => l.at > cutoff).slice(-400);
    }
  }

  private recentlyResearched = new Set<string>();
  /** A pump token for a research checkup — trending boards first, then the fresh
   *  launch pool (aged 3-20 min so there's actual history to read). */
  private async pickTrendingMint(): Promise<string | null> {
    const { openPositions } = await import("../chain/trader.js");
    const held = new Set(openPositions().map((p) => p.mint));
    const eligible = (mint: string) =>
      mint.endsWith("pump") &&
      mint !== cfg.ownMint &&
      !held.has(mint) &&
      !this.recentlyResearched.has(mint) &&
      !this.planner.researchedRecently(mint, 8) &&
      !(store.seenAt(mint) && Date.now() - store.seenAt(mint)! < 6 * 3600_000);
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
      // trending first (they have momentum), then the launch pool aged 3-20 min
      // (readable history, not seconds-old and unreadable)
      const candidates = [
        ...shuffle((hits ?? []).map((h) => h.mint).filter(eligible)),
        ...shuffle(this.launchPool
          .filter((l) => now - l.at > 3 * 60_000 && now - l.at < 20 * 60_000 && eligible(l.mint))
          .map((l) => l.mint)),
      ];
      if (!candidates.length) return null;
      // LIVENESS GATE: only research a coin that isn't dead — current mc above
      // the floor. Bounded RPC so we never hammer the chain.
      const { PublicKey } = await import("@solana/web3.js");
      const { getTokenState } = await import("../chain/pump.js");
      const { getSolUsd } = await import("../chain/solana.js");
      const solUsd = await getSolUsd().catch(() => 150);
      let checked = 0;
      for (const mint of candidates) {
        if (checked++ >= 8) break;
        try {
          const st = await getTokenState(new PublicKey(mint));
          const mcUsd = st.kind === "curve" || st.kind === "amm" ? st.mcSol * solUsd : 0;
          if (mcUsd >= cfg.minResearchMcUsd) return take(mint);
        } catch {}
      }
      return null;
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

  private nextJob(): Job | null {
    if (this.inboxQ.length) return this.inboxQ.shift()!;
    if (this.buybackQ.length) return this.buybackQ.shift()!;
    if (this.agentQ.length) return this.agentQ.shift()!;
    const idleMin = (Date.now() - this.lastConveyorPick) / simT(60_000);
    if (idleMin >= cfg.conveyorPickMin && this.conveyor.length) {
      // belt items are seconds old — the actual research target is resolved
      // at execution time (trending boards first, belt as fallback)
      const item = this.conveyor[this.conveyor.length - 1];
      this.conveyor = this.conveyor.filter((c) => c.mint !== item.mint);
      this.lastConveyorPick = Date.now();
      return { kind: "conveyor", item, at: Date.now() };
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
        if (job.kind === "inbox") await this.beats.researchBeat(job.ev.mint, job.ev.amountRaw, job.ev.sender, false);
        else if (job.kind === "conveyor") {
          // seconds-old launches are unreadable (no candle, no holders) —
          // random checkups use TRENDING tokens only; no candidate = skip
          const trending = await this.pickTrendingMint();
          if (trending) await this.beats.researchBeat(trending, null, null, true);
          else log.info("director", "random checkup skipped — no trending candidate this cycle");
        }
        else if (job.kind === "buyback") await this.beats.buybackBeat(job.p.sol);
        else if (job.kind === "agent") await this.beats.agentBeat(job.qa.action);
        else if (job.kind === "commentary") await this.beats.commentaryBeat();
      } catch (e) {
        log.error("director", `beat crashed: ${String(e).slice(0, 200)}`);
        this.loco.stateName = "RECOVER";
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
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
