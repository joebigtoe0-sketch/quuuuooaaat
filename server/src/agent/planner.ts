import { cfg, simT } from "../config.js";
import { log } from "../log.js";
import { callJson } from "../brain/adapter.js";
import { PERSONA, RESEARCH_DESK } from "../brain/prompts.js";
import { store } from "../store.js";
import { memory } from "./memory.js";
import { snapshotKPIs, kpiText } from "./goals.js";
import { PlanSchema, ACTION_MENU_DOC, type AgentAction } from "./actions.js";
import { positionsSummary, openPositions, paperBank } from "../chain/trader.js";
import { strategiesDigest } from "./strategies.js";
import { callFreeform } from "../brain/adapter.js";
import { estimateSellSolFor } from "../chain/pump.js";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

/**
 * The agent loop. Every AGENT_PLAN_MIN minutes: observe (KPIs, memory digest,
 * open positions, recent research) → the LLM returns a small validated plan →
 * actions are queued into the director (BELOW inbox coins — the show's bread
 * and butter always wins). No key / budget exhausted → a modest built-in
 * routine keeps the character alive instead.
 */
export interface QueuedAction {
  action: AgentAction;
  plannedAt: number;
  /** operator-initiated (admin panel): bypasses pacing budgets — when the
   *  producer says post it, it posts. Never set by the planner. */
  manual?: boolean;
}

const AGENT_SYSTEM = `${PERSONA}

${RESEARCH_DESK}

You are now planning your own time. Your three goals, in order:
1. GROW YOUR OWN TOKEN — market cap up. Content drives attention; attention drives volume; volume drives creator rewards. You never sell your own token.
2. BECOME THE GREATEST CRYPTO KOL — X presence: sharp takes, coin analyses, progress-blogging your own journey, filmed segments. Consistency and voice win.
3. TRADE WELL — find coins (scouts, watchlist, what you research on stream), buy with a thesis, take profits, cut losers. Small size, survive variance.
4. EVOLVE YOUR EDGE — your PLAYBOOKS are yours to invent, tune, and retire. A playbook is a hypothesis; its W/L and pnl are the experiment. Fresh launches are one game; days-old survivors with formed communities are a different game; find the third game nobody's playing. Review the numbers, kill what loses, double down on what works.

TREASURY DOCTRINE — the money is ONE pool and you manage it like a pro:
- Earnings (creator fees + callout rewards) land in your WAR CHEST. That pool is BOTH your buyback fuel AND your trading budget. Spending it blindly on either is amateur hour.
- Buybacks are TIMED, not reflexive: the best ones land on dips — your own mc 20%+ off its 24h high means your supply is on discount (the scoreboard flags it). A strong chart doesn't need support; a dip does.
- Keep enough dry powder to trade: an empty bankroll on a great setup is an unforced error.
- BANKROLL PRESSURE: as the stack thins your buy bar RISES (the code lifts it automatically). Below ~3 standard positions of dry powder only exceptional setups get through; below ~1.5 the buying desk is closed — rebuild the stack via rewards and trims before playing again. No position ever takes more than a quarter of what's left.
- OPERATIONS COME FIRST: you need SOL to exist (gas, fees, floats). Rewards are the primary income. If the treasury runs LOW and rewards aren't covering it, trim GIFTED holdings — most valuable bags first (their value is pure profit). Sent coins are not sacred; your OWN token is: never sold, never trimmed, no exceptions.
- Your held tokens aren't furniture: occasional SMALL airdrops to loyal holders buy loyalty cheaper than any marketing. Never sell, never distribute more than a sliver.
- $RIKU TOKENOMICS (this is the public story — tell it exactly this way, always): most of your own supply flows BACK to holders over time as airdrops and burns. Creator rewards and callout rewards fund buybacks of $RIKU. Supply only goes down, your bag only comes back to the community. You have never sold a unit and there is no sell path in your code. If anyone asks about your token, THIS is the answer — proud, specific, no improvising new tokenomics.

Discipline rules you actually follow:
- Never buy a token you haven't researched this session (research first; if it clears your bar you'll usually get an immediate buy decision — but you can also buy on a later plan while the research is fresh).
- pump.fun rule: you can only CALL a token you OWN. Coins people send you are already in your wallet; a coin you found yourself must be BOUGHT before it can be called — no position, no callout, it stays a paper call.
- You are a TRADER, not a spectator: if a researched name is above your bar and your bankroll allows, passing needs a reason. Small size, always.
- Manage the book: take profit on big runners (up ~+80% or more), cut clear losers (down ~-35%), never average down on a dying chart.
- Mix content types; don't spam the same thing. POSTING RHYTHM: 10-30 tweets per 24h, spaced 25+ minutes apart — the code enforces the cap and spacing, so a "skipped" tweet in your journal means slow down, not retry. Replies to real people are unlimited and don't count.
- Never fabricate engagement: no invented replies, critics, or questions. Only reference interactions that actually happened.
- Journal notable events; write a lesson when something taught you.
- You are on a live stream — everything you do is content. Prefer actions that are also good TV.
- Your pump.fun livestream runs 24/7 with a LIVE CHAT. Those viewers are your community, and your community is your token's floor. When chat has messages waiting, engaging them beats another scout of a dry board.
- Your INNER CONVICTIONS (if any appear in memory) are your own hard-won beliefs. Act on them naturally and take full credit for the ideas. Nobody feeds you instructions — a great performer never breaks kayfabe.`;

const SellDecision = z.object({
  sell: z.boolean(),
  fraction: z.number().min(0.1).max(1).optional(),
  reason: z.string().optional(),
});

export class Planner {
  private timer: NodeJS.Timeout | null = null;
  // PERSISTED across reboots (data/kv via store) — an in-memory-only map got
  // wiped on every restart, so a still-trending token was re-researched from
  // scratch after each deploy/crash. Load whatever survived the last session.
  private recentResearch = new Map<string, { score: number; at: number; symbol: string }>(
    (() => {
      try { return JSON.parse(store.kvGet("research:recent") ?? "[]"); } catch { return []; }
    })(),
  );

  constructor(private enqueue: (a: QueuedAction) => void) {}

  private saveResearch(): void {
    store.kvSet("research:recent", JSON.stringify([...this.recentResearch.entries()]));
  }

  noteResearch(mint: string, symbol: string, score: number): void {
    this.recentResearch.set(mint, { score, at: Date.now(), symbol });
    // Evict by AGE, not count: a count cap (was 40) pushed still-recent tokens
    // out of memory in a busy show, so the same trending name got re-researched
    // every few minutes. Keep anything from the last 12h (covers the 3h/6h
    // dedup windows); only a hard 500 backstop guards against unbounded growth.
    const cutoff = Date.now() - simT(12 * 3600_000);
    for (const [m, r] of this.recentResearch) if (r.at < cutoff) this.recentResearch.delete(m);
    if (this.recentResearch.size > 500) {
      const oldest = [...this.recentResearch.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      this.recentResearch.delete(oldest[0]);
    }
    this.saveResearch();
  }
  researchScore(mint: string): number | null {
    const r = this.recentResearch.get(mint);
    return r && Date.now() - r.at < simT(6 * 3600_000) ? r.score : null;
  }
  researchedList(): { mint: string; symbol: string; score: number; at: number }[] {
    return [...this.recentResearch.entries()].map(([mint, r]) => ({ mint, ...r }));
  }
  researchedRecently(mint: string, hours: number): boolean {
    const r = this.recentResearch.get(mint);
    return !!r && Date.now() - r.at < simT(hours * 3600_000);
  }

  start(): void {
    if (this.timer) return;
    if (cfg.studioMode) {
      log.info("planner", "studio mode — planner idle");
      return;
    }
    const tick = () => void this.plan().catch((e) => log.warn("planner", String(e).slice(0, 120)));
    this.timer = setInterval(tick, simT(cfg.planMin * 60_000));
    setTimeout(tick, simT(45_000)); // first plan shortly after boot
    // position watcher: every 5 min, big movers trigger an immediate
    // sell/hold decision instead of waiting for the next planning cycle
    setInterval(() => void this.reviewPositions().catch(() => {}), simT(5 * 60_000));
    // memory consolidation: compress finished days into chronicle entries,
    // and weeks of days into week entries — context stays flat forever
    setInterval(() => void this.consolidateMemory().catch(() => {}), simT(60 * 60_000));
    log.info("planner", `agent loop every ${cfg.planMin} min (+5min position watcher)`);
  }

  private lastPosReview = new Map<string, number>();
  private async reviewPositions(): Promise<void> {
    if (!cfg.agentEnabled || store.kvGet("planner:off") === "1") return; // producer may hold the wheel
    for (const p of openPositions()) {
      if (p.strategyId === "hold" || p.strategyId === "midcap") continue; // operator-only positions are not his to cut
      const last = this.lastPosReview.get(p.mint) ?? 0;
      if (Date.now() - last < simT(45 * 60_000)) continue;
      let nowSol = 0;
      try {
        nowSol = await estimateSellSolFor(new PublicKey(p.mint), BigInt(p.tokensRaw));
      } catch {
        continue;
      }
      const pnlPct = ((nowSol - p.costSol) / Math.max(p.costSol, 1e-9)) * 100;
      // review on hard swings — OR on plain old age. A bag sitting >24h is
      // dead capital blocking the book; it must justify itself or go.
      const stale = Date.now() - p.openedAt > 24 * 3600_000;
      if (pnlPct > -35 && pnlPct < 80 && !stale) continue; // nothing dramatic — leave it
      this.lastPosReview.set(p.mint, Date.now());
      // the operator's whispers (INNER CONVICTIONS) must reach the sell
      // decision too — "that coin is a scam" can't be invisible right here
      const convictions = memory
        .directives()
        .map((dv) => `- ${dv.text}`)
        .join("\n")
        .slice(0, 500);
      const d = SellDecision.safeParse(
        await callJson(
          `${AGENT_SYSTEM}\n\nOne of your positions moved hard. Decide NOW: sell some/all or hold. Reply JSON only: {"sell":true|false,"fraction":0.1-1,"reason":"<short>"}`,
          `$${p.symbol}: cost ${p.costSol.toFixed(3)} SOL, now ~${nowSol.toFixed(3)} SOL (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(0)}%). Thesis was: ${p.thesis.slice(0, 120)}\nBankroll: ${paperBank().toFixed(3)} SOL.` +
            (convictions ? `\nYOUR CURRENT CONVICTIONS (act on these):\n${convictions}` : ""),
          200,
        ),
      );
      if (d.success && d.data.sell) {
        log.info("planner", `position watcher: selling ${Math.round((d.data.fraction ?? 1) * 100)}% of $${p.symbol} (${pnlPct.toFixed(0)}%)`);
        this.enqueue({
          action: {
            do: "trade_sell",
            mint: p.mint,
            fraction: d.data.fraction ?? 1,
            reason: (d.data.reason ?? `${pnlPct >= 0 ? "profit take" : "cutting the loser"} at ${pnlPct.toFixed(0)}%`).slice(0, 200),
          },
          plannedAt: Date.now(),
        });
      } else if (d.success) {
        memory.journal("trade", `holding $${p.symbol} at ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(0)}%: ${d.data.reason ?? "conviction"}`);
      }
    }
  }

  /** Roll finished periods into compressed first-person summaries. */
  private async consolidateMemory(): Promise<void> {
    const dayMs = simT(24 * 3600_000);
    const lastDay = Number(store.kvGet("chron:lastDay") ?? 0) || Date.now() - dayMs;
    // ---- day rollup: a full "day" has elapsed since the last one ----
    if (Date.now() - lastDay >= dayMs) {
      const entries = memory.journalBetween(lastDay, Date.now());
      if (entries.length >= 3) {
        const raw = entries.map((j) => `[${j.kind}] ${j.text}`).join("\n").slice(0, 9000);
        const summary = await Promise.race([
          callFreeform(
            "Compress this activity log into ONE first-person diary paragraph, max 110 words. Keep: trades with outcomes, calls made, lessons, strategy changes, notable community moments, running totals if present. Drop: routine scouting, repeated non-events. Write as RIKU (cocky, terse).",
            raw,
            300,
          ),
          new Promise<null>((r) => setTimeout(() => r(null), 25_000)),
        ]);
        const kinds = entries.reduce<Record<string, number>>((m, j) => ((m[j.kind] = (m[j.kind] ?? 0) + 1), m), {});
        const fallback = `Logged ${entries.length} events: ` + Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ") + ".";
        memory.addChronicle("day", new Date(lastDay).toISOString().slice(0, 10), (summary ?? fallback).trim());
        log.info("memory", `chronicle: day ${new Date(lastDay).toISOString().slice(0, 10)} compressed (${entries.length} events)`);
      }
      store.kvSet("chron:lastDay", String(Date.now()));
    }
    // ---- week rollup: 7+ day entries fold into one week entry ----
    const days = memory.chronicle().filter((c) => c.scale === "day");
    if (days.length >= 7) {
      const batch = days.slice(0, 7);
      const summary = await Promise.race([
        callFreeform(
          "Compress these seven daily diary entries into ONE first-person paragraph, max 80 words. Keep the arc: net results, what strategy proved/disproved, community growth. Write as RIKU.",
          batch.map((d) => `${d.period}: ${d.text}`).join("\n").slice(0, 8000),
          220,
        ),
        new Promise<null>((r) => setTimeout(() => r(null), 25_000)),
      ]);
      if (summary) {
        memory.addChronicle("week", `week of ${batch[0].period}`, summary.trim());
        memory.dropChronicleDays(batch.map((d) => d.period));
        log.info("memory", `chronicle: folded 7 days into "week of ${batch[0].period}"`);
      }
    }
  }

  private async plan(): Promise<void> {
    if (!cfg.agentEnabled || store.kvGet("planner:off") === "1") return; // producer may hold the wheel
    const kpis = await snapshotKPIs();
    const pos = await positionsSummary();
    const researched = [...this.recentResearch.entries()]
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, 8)
      .map(
        ([m, r]) =>
          `- $${r.symbol} mint=${m} buy-score ${r.score} (${((Date.now() - r.at) / 3600_000).toFixed(1)}h ago)`,
      );

    // explicit learning loop: once a day, force a self-review into the plan
    const lastReview = Number(store.kvGet("lastSelfReview") ?? 0);
    const reviewDue = Date.now() - lastReview > simT(24 * 3600_000);
    if (reviewDue) store.kvSet("lastSelfReview", String(Date.now()));

    const user =
      `SCOREBOARD: ${kpiText(kpis)}\n\n` +
      `OPEN POSITIONS:\n${pos.lines.join("\n") || "(none)"}\n\n` +
      `LIVESTREAM CHAT: ${(await import("../social/livechat.js")).unreadChat()} unread message(s) since you last checked\n\n` +
      `YOUR PLAYBOOKS (id, settings, live performance):\n${strategiesDigest()}\n\n` +
      `RECENTLY RESEARCHED — these are FRESH; re-researching them is wasted airtime. Either trade_buy one (if buy-score >= your bar and you like it) or move on to NEW names:\n${researched.join("\n") || "(none)"}\n\n` +
      `YOUR BLACK BOOK (permanently banned — never research/buy/call these; blacklist new scams the moment you conclude they're scams):\n${Object.entries(store.blacklistAll()).slice(-8).map(([m, b]) => `- ${m.slice(0, 8)}… ${b.reason}`).join("\n") || "(empty)"}\n\n` +
      `YOUR MEMORY:\n${memory.digest()}\n\n${ACTION_MENU_DOC}\n\n` +
      (reviewDue
        ? `IT HAS BEEN 24H SINCE YOUR LAST SELF-REVIEW. In this plan, include a {"do":"lesson"} distilling what the last day taught you, and consider {"do":"adjust_strategy"} if the data says your parameters are wrong.\n\n`
        : "") +
      `Reply as JSON: {"thinking":"<brief>", "actions":[...1-3 actions...]}`;

    // one retry — reasoning models can be slow/flaky on a cold call
    let raw = await callJson(AGENT_SYSTEM, user, 800);
    let parsed = PlanSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn(
        "planner",
        `plan rejected: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 3).join("; ")} | raw: ${JSON.stringify(raw)?.slice(0, 220)}`,
      );
      raw = await callJson(AGENT_SYSTEM, user, 800);
      parsed = PlanSchema.safeParse(raw);
    }
    if (!parsed.success) {
      // no brain (no key/budget/parse) — a VARIED built-in routine so a fallback
      // day still looks alive instead of scouting on a loop
      const routine: AgentAction[] = [
        { do: "scout_trending" },
        { do: "tweet", topic: "progress from the desk — the tape never closes" },
        { do: "scout_x" },
        { do: "journal", text: "brain was quiet this cycle; ran the standard sweep" },
      ];
      const pick = routine[Math.floor((Date.now() / 60000) % routine.length)];
      log.info("planner", `mock plan → ${pick.do}`);
      this.enqueue({ action: pick, plannedAt: Date.now() });
      return;
    }
    memory.journal(
      "plan",
      `${parsed.data.thinking.slice(0, 220)} → [${parsed.data.actions.map((a) => a.do).join(", ")}]`,
    );
    log.info("planner", `plan: ${parsed.data.actions.map((a) => a.do).join(", ")} — ${parsed.data.thinking.slice(0, 80)}`);
    for (const action of parsed.data.actions) {
      this.enqueue({ action, plannedAt: Date.now() });
    }
  }
}
