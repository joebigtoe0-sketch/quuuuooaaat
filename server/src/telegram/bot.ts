import { Bot, InputFile, InlineKeyboard } from "grammy";
import { cfg } from "../config.js";
import { log } from "../log.js";
import {
  recordCall, leaderboard, callsForMint, callerHistory, gradeOpenCalls, stats, athFromTape, gradeCall,
  topCalls, windowStats, unrecordCall,
  type BoardRow,
} from "./calls.js";
import { renderCard, money, ago, esc } from "./card.js";

/**
 * RIKUBOT — the caller tracker. A SEPARATE identity from the userbot that talks
 * in groups as Riku himself, and deliberately so: a Bot API bot can be added to
 * any group by anyone (which is how the caller network grows) and a bot posting
 * cards all day is expected behaviour, where a user account doing it reads as
 * spam and risks the one account that cannot be replaced.
 *
 * Needs privacy mode OFF (BotFather /setprivacy) or it only sees commands.
 * Confirmed on @quantRIKU_bot: can_read_all_group_messages = true.
 */

// Boundary-guarded: without the lookarounds, a mint glued to other base58-ish
// text matched the wrong 44 chars of a longer run and then failed analysis
// silently — the call vanished. URLs are safe either way (slashes break runs).
const BASE58 = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
// addresses that show up in chat constantly and are never a callable mint
const DENY = new Set([
  "11111111111111111111111111111111",
  "So11111111111111111111111111111111111111112",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
]);

/** In-flight + recently-carded mints, so a CA pasted five times in a minute
 *  produces one card rather than five. */
const recent = new Map<string, number>();
function throttled(key: string, ms = 90_000): boolean {
  const at = recent.get(key);
  const now = Date.now();
  for (const [k, t] of recent) if (now - t > 10 * 60_000) recent.delete(k);
  if (at && now - at < ms) return true;
  recent.set(key, now);
  return false;
}

function boardText(rows: BoardRow[], title: string, note: string): string {
  if (!rows.length) return `<b>${title}</b>\nNo graded calls yet — a call needs an hour before it has an outcome.`;
  const lines = rows.slice(0, 15).map((r, i) => {
    const medal = ["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`;
    const flag = r.eligible ? "" : " <i>(not prize-eligible)</i>";
    const per = `${r.score >= 0 ? "+" : ""}${(r.score * 100).toFixed(0)}%`;
    return `${medal} <b>${esc(r.callerName)}</b> — <b>${per}/call</b> · ${r.calls} calls · med ${r.medianMult.toFixed(1)}x · ${r.hit2x.toFixed(0)}% hit 2x${flag}`;
  });
  return `<b>${title}</b>\n${lines.join("\n")}\n\n<i>${note}</i>`;
}


// ------------------------------------------------------------ /lb board --

const WINDOWS: { label: string; days: number }[] = [
  { label: "1D", days: 1 },
  { label: "7D", days: 7 },
  { label: "14D", days: 14 },
  { label: "30D", days: 30 },
];
const MEDAL = ["🥇", "🥈", "🥉"];
/** how a call FEELS, at a glance, before you read the number */
const mood = (m: number): string => (m >= 3 ? "🤩" : m >= 2 ? "😎" : m >= 1.2 ? "🙂" : m >= 0.8 ? "🥱" : "😭");

function lbKeyboard(scope: "group" | "global", days: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const w of WINDOWS) {
    kb.text(w.days === days ? `· ${w.label} ·` : w.label, `lb:${scope}:${w.days}`);
  }
  return kb;
}

function lbText(scope: "group" | "global", days: number, groupId: string, title: string): string {
  const gid = scope === "group" ? groupId : undefined;
  const rows = leaderboard(gid, days);
  const st = windowStats(gid, days);
  const calls = topCalls(gid, days, 10);
  const L: string[] = [];
  L.push(`<b>${esc(scope === "global" ? "🌍 GLOBAL — first calls only" : title)}</b>`);
  L.push("");
  L.push("👑 <b>Top Callers</b>");
  if (!rows.length) {
    L.push(" └ <i>nothing graded in this window yet</i>");
  } else {
    rows.slice(0, 3).forEach((r, i) => {
      const last = i === Math.min(2, rows.length - 1);
      const pts = `${r.score >= 0 ? "+" : ""}${(r.score * 100).toFixed(0)}%/call`;
      L.push(` ${last ? "└" : "├"}${MEDAL[i]} ${esc(r.callerName)} [${pts}]${r.eligible ? "" : " *"}`);
    });
  }
  L.push("");
  L.push("📊 <b>Stats</b>");
  L.push(` ├ Period    ${days}d`);
  L.push(` ├ Calls     ${st.calls}${st.graded < st.calls ? ` <i>(${st.graded} graded)</i>` : ""}`);
  L.push(` ├ Hit Rate  ${st.hit2x.toFixed(0)}% ≥2x`);
  L.push(` ├ Median    ${st.median.toFixed(1)}x`);
  L.push(` └ Avg       ${st.avgProfit >= 0 ? "+" : ""}${(st.avgProfit * 100).toFixed(0)}%/call`);
  if (calls.length) {
    L.push("");
    calls.forEach((c, i) => {
      L.push(
        `${mood(c.mult)} <b>${i + 1}</b>  <b>${esc(c.symbol)}</b> » ${esc(c.callerName)} [${c.mult.toFixed(1)}x]`,
      );
    });
  }
  if (rows.some((r) => !r.eligible)) L.push(`\n<i>* fewer than ${cfg.tgMinScoredCalls} scored calls — ranked, not prize-eligible</i>`);
  return L.join("\n");
}


/** Live bot handle so the feed can post updates into the groups a coin was
 *  called in. Set on start, null when RikuBot is off. */
let live: Bot | null = null;

/**
 * A called coin just graduated. Posted from the pumpportal `migrate` event —
 * the real graduation, never a bonding-progress threshold, which misses roughly
 * two thirds of real bonds.
 */
export async function noteMigration(mint: string): Promise<void> {
  if (!live) return;
  const calls = callsForMint(mint);
  if (!calls.length) return;
  const first = calls.find((c) => c.scored) ?? calls[0];
  try {
    const { marketCap } = await import("../chain/marketcap.js");
    const mc = (await marketCap(mint).catch(() => null))?.mcUsd ?? null;
    const mult = mc && first.mcAtCall ? mc / first.mcAtCall : null;
    const line =
      `🎓 <b>$${esc(first.symbol)}</b> just graduated to PumpSwap.

` +
      `Called by <b>${esc(first.callerName)}</b> at ${money(first.mcAtCall)}` +
      (mc ? ` — now <b>${money(mc)}</b>` : "") +
      (mult ? `  (<b>${mult.toFixed(2)}x</b> ${mult >= 1 ? "🟢" : "🔴"})` : "");
    // every group that called it hears about it, once each
    for (const gid of [...new Set(calls.map((c) => c.groupId))]) {
      await live.api
        .sendMessage(gid, line, { parse_mode: "HTML", link_preview_options: { is_disabled: true } })
        .catch(() => {});
    }
    log.info("tg", `migration update posted for $${first.symbol}`);
  } catch (e) {
    log.warn("tg", `migration update failed: ${String(e).slice(0, 80)}`);
  }
}


// ------------------------------------------------------ /competition --

/** Month-to-date, and how long is left. The competition settles on the last
 *  day of the month, so the window is calendar — not the rolling one /lb uses. */
function monthWindow(): { daysElapsed: number; daysLeft: number; endsOn: string } {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59);
  return {
    daysElapsed: Math.max(1, (Date.now() - start) / 86_400_000),
    daysLeft: Math.max(0, Math.ceil((end - Date.now()) / 86_400_000)),
    endsOn: new Date(end).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" }),
  };
}

export function startTelegram(): void {
  if (!cfg.tgEnabled || !cfg.tgBotToken) {
    log.info("tg", "RikuBot off (TG_ENABLED / TG_BOT_TOKEN)");
    return;
  }
  const bot = new Bot(cfg.tgBotToken);
  live = bot;

  bot.command("start", (ctx) =>
    ctx.reply(
      "I track calls. Post a contract address in a group I'm in and I'll card it and record who called it first.\n\n" +
        "/competition — the monthly $RIKU prize board\n/lb — this group's leaderboard (1D/7D/14D/30D)\n/lb global — the global board, prizes pay off this one\n/pnl &lt;ca&gt; — a shareable card: how far that call ran\n/me — your record\n/rules — how scoring works",
      { parse_mode: "HTML" },
    ),
  );

  bot.command("rules", (ctx) =>
    ctx.reply(
      "<b>How scoring works</b>\n\n" +
        "Every call is scored on the best price that held for a full 5 minutes after you called it — not the wick. " +
        "A spike nobody could have sold into is not a result.\n\n" +
        "Your score is what a follower would have <b>earned per call</b> staking the same clip on each, so:\n" +
        "• calling more does NOT raise your score — it is an average\n" +
        "• a rug costs you -95%, so spraying is expensive\n" +
        `• one moon can't carry you — credit per call caps at ${cfg.tgMaxCreditMult}x\n` +
        `• thin records get pulled toward the average until you have a real sample\n\n` +
        `<b>First caller only.</b> If a coin was already called anywhere, a later post is recorded for your group but scores nothing globally.\n\n` +
        `Prizes need at least ${cfg.tgMinScoredCalls} scored calls in the last ${cfg.tgScoreWindowDays} days.`,
      { parse_mode: "HTML" },
    ),
  );

  bot.command("competition", (ctx) => {
    const w = monthWindow();
    // FULL month's bar all month: otherwise on the 2nd one lucky call tops the
    // standings and they swing every day as the month fills in.
    const rows = leaderboard(undefined, w.daysElapsed, 30);
    const prizes = [cfg.tgPrize1Usd, cfg.tgPrize2Usd, cfg.tgPrize3Usd];
    const pool = prizes.reduce((a, b) => a + b, 0);
    const L: string[] = [];
    L.push(`🏆 <b>RIKU GLOBAL CALLOUT COMPETITION</b>`);
    L.push(`<i>$${pool} in $RIKU every month — settled ${w.endsOn}, ${w.daysLeft}d left</i>`);
    L.push("");
    L.push(`🥇 <b>$${cfg.tgPrize1Usd}</b>   🥈 <b>$${cfg.tgPrize2Usd}</b>   🥉 <b>$${cfg.tgPrize3Usd}</b>  <i>(paid in $RIKU)</i>`);
    L.push("");
    L.push("<b>How to enter</b>");
    L.push(" └ Post a contract address in any group I'm in. That's it.");
    L.push("");
    L.push("<b>How it's scored</b>");
    L.push(` ├ <b>First caller wins the coin.</b> Globally — if it was already called in any other group, yours is recorded for that group but scores nothing here.`);
    L.push(` ├ <b>Quality over quantity.</b> Your score is what a follower would have earned <b>per call</b>, so calling more never helps — a rug costs you as much as a winner pays.`);
    L.push(` ├ Scored on the best price that <b>held for 5 minutes</b> after your call, never a wick nobody could sell into.`);
    L.push(` ├ One moon can't carry you: credit per call caps at <b>${cfg.tgMaxCreditMult}x</b>.`);
    L.push(` └ Prizes need at least <b>${cfg.tgMinScoredCalls} scored calls</b> this month.`);
    L.push("");
    L.push(`<b>📊 Standings — if it ended right now</b>`);
    const winners = rows.filter((r) => r.eligible).slice(0, 3);
    if (!winners.length) {
      L.push(` └ <i>nobody has ${cfg.tgMinScoredCalls} scored calls yet this month — wide open</i>`);
      const near = rows.slice(0, 3);
      if (near.length) {
        L.push("");
        L.push("<i>closest so far (not yet eligible):</i>");
        near.forEach((r) =>
          L.push(` · ${esc(r.callerName)} — ${r.score >= 0 ? "+" : ""}${(r.score * 100).toFixed(0)}%/call, ${r.scored}/${cfg.tgMinScoredCalls} calls`),
        );
      }
    } else {
      winners.forEach((r, i) => {
        const last = i === winners.length - 1;
        L.push(
          ` ${last ? "└" : "├"}${MEDAL[i]} <b>${esc(r.callerName)}</b> — ${r.score >= 0 ? "+" : ""}${(r.score * 100).toFixed(0)}%/call · ${r.scored} calls  <b>$${prizes[i]}</b>`,
        );
      });
    }
    L.push("");
    L.push(`<i>/lb global for the full board · /rules for the detail</i>`);
    return ctx.reply(L.join("\n"), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });

  bot.command("lb", (ctx) => {
    const scope: "group" | "global" = /global/i.test((ctx.match ?? "").toString()) ? "global" : "group";
    const gid = String(ctx.chat?.id ?? "");
    const title = ctx.chat?.title ?? "This group";
    return ctx.reply(lbText(scope, 1, gid, title), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: lbKeyboard(scope, 1),
    });
  });

  bot.callbackQuery(/^lb:(group|global):(\d+)$/, async (ctx) => {
    const [, scope, d] = ctx.match as unknown as string[];
    const days = Number(d);
    const gid = String(ctx.chat?.id ?? "");
    const title = ctx.chat?.title ?? "This group";
    try {
      await ctx.editMessageText(lbText(scope as "group" | "global", days, gid, title), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: lbKeyboard(scope as "group" | "global", days),
      });
    } catch { /* "message is not modified" when the same window is re-tapped */ }
    await ctx.answerCallbackQuery();
  });

  bot.command("board", (ctx) => {
    const gid = String(ctx.chat?.id ?? "");
    return ctx.reply(
      boardText(leaderboard(gid), `📋 ${esc(ctx.chat?.title ?? "This group")} — callers`, "Group board: every call here, first or not. Prizes pay off /global."),
      { parse_mode: "HTML" },
    );
  });

  bot.command("global", (ctx) => {
    const s = stats();
    return ctx.reply(
      boardText(
        leaderboard(),
        "🌍 GLOBAL CALLER BOARD",
        `First calls only · rolling ${cfg.tgScoreWindowDays}d · ${s.calls} calls tracked on ${s.mints} coins`,
      ),
      { parse_mode: "HTML" },
    );
  });

  bot.command("me", (ctx) => {
    const id = String(ctx.from?.id ?? "");
    const mine = callerHistory(id);
    if (!mine.length) return ctx.reply("No calls from you yet. Post a contract address and I'll start tracking.");
    const row = leaderboard().find((r) => r.callerId === id);
    const recentCalls = mine.slice(0, 8).map((c) => {
      const m = c.exitMult != null ? `${c.exitMult.toFixed(1)}x` : "grading…";
      return `• $${esc(c.symbol)} — ${m}${c.scored ? "" : " <i>(not first)</i>"} · ${ago(c.at)} ago`;
    });
    const head = row
      ? `<b>${row.score >= 0 ? "+" : ""}${(row.score * 100).toFixed(0)}%/call</b> · ${row.calls} graded · med ${row.medianMult.toFixed(1)}x · ${row.hit2x.toFixed(0)}% hit 2x` +
        (row.eligible ? " · <b>prize-eligible</b>" : ` · needs ${cfg.tgMinScoredCalls} scored calls to be prize-eligible`)
      : "nothing graded yet";
    return ctx.reply(`<b>${esc(ctx.from?.first_name ?? "You")}</b>\n${head}\n\n${recentCalls.join("\n")}`, {
      parse_mode: "HTML",
    });
  });

  // /pnl <ca> — the shareable card: how far a call actually ran
  bot.command("pnl", async (ctx) => {
    const arg = (ctx.match ?? "").toString().trim();
    const mint = (arg.match(BASE58) ?? [])[0];
    if (!mint || DENY.has(mint)) return ctx.reply("Usage: /pnl <contract address>");
    const calls = callsForMint(mint);
    const first = calls.find((c) => c.scored) ?? calls[0];
    if (!first) {
      return ctx.reply("Nobody has called that one in any group I'm watching — so there's no call to price it from.");
    }
    const wait = await ctx.reply("📸 building the card…");
    try {
      const mult = (await gradeCall(first)) ?? first.exitMult ?? null;
      if (mult == null) {
        await ctx.api.editMessageText(ctx.chat!.id, wait.message_id, "No tape on that coin yet — nothing to measure the call against.");
        return;
      }
      const [{ renderPnlCard, fetchAvatar }] = await Promise.all([import("./pnlImage.js")]);
      const avatar = await fetchAvatar(cfg.tgBotToken, first.callerId).catch(() => null);
      const png = await renderPnlCard({
        symbol: first.symbol,
        multiple: mult,
        calledAtMcUsd: first.mcAtCall,
        calledAt: first.at,
        callerName: first.callerName,
        avatar,
        live: Date.now() - first.at < cfg.tgGradeWindowH * 3_600_000,
      });
      await ctx.api.deleteMessage(ctx.chat!.id, wait.message_id).catch(() => {});
      await ctx.replyWithPhoto(new InputFile(png, `pnl-${first.symbol}.png`), {
        caption:
          `<b>$${esc(first.symbol)}</b> — called by ${esc(first.callerName)} at ${money(first.mcAtCall)}` +
          `
<i>peak since the call: ${mult.toFixed(2)}x${calls.length > 1 ? ` · ${calls.length} calls on this coin` : ""}</i>`,
        parse_mode: "HTML",
      });
    } catch (e) {
      log.warn("tg", `pnl card failed: ${String(e).slice(0, 120)}`);
      await ctx.api.editMessageText(ctx.chat!.id, wait.message_id, "Card generator fell over — try again in a minute.").catch(() => {});
    }
  });

  bot.command("deep", (ctx) =>
    ctx.reply(
      "Deep holder profiling runs against the 78M-row local tape index, which isn't reachable from here yet. " +
        "The card's holder line is the live on-chain read.",
    ),
  );

  // 🗑 — removes the CARD. The call stays on the record either way.
  bot.callbackQuery(/^del:(\d+)$/, async (ctx) => {
    const [, owner] = ctx.match as unknown as string[];
    if (String(ctx.from?.id) !== owner) {
      return ctx.answerCallbackQuery({ text: "Only the caller can clear their own card.", show_alert: true });
    }
    await ctx.deleteMessage().catch(() => {});
    await ctx.answerCallbackQuery({ text: "Card cleared — the call is still recorded." });
  });

  // 🔄 — re-pull the tape and redraw
  bot.callbackQuery(/^ref:([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
    const [, mint] = ctx.match as unknown as string[];
    await ctx.answerCallbackQuery({ text: "refreshing…" });
    try {
      const { analyze } = await import("../analysis/engine.js");
      const a = await Promise.race([
        analyze(mint, null, { forceBubble: cfg.tgBubbleOnCard }),
        new Promise<null>((r) => setTimeout(() => r(null), 20_000)),
      ]);
      if (!a) return;
      const [{ pumpCallerCount }, ath] = await Promise.all([
        import("../callout/callers.js"),
        athFromTape(mint).catch(() => null),
      ]);
      const prior = callsForMint(mint);
      const first = prior.find((c) => c.scored) ?? prior[0];
      const { marketCap } = await import("../chain/marketcap.js");
      const exact = await marketCap(mint).catch(() => null);
      const { text } = renderCard(a, {
        ath,
        mcUsd: exact?.mcUsd ?? null,
        pumpCallers: pumpCallerCount(mint),
        caller: first
          ? { name: first.callerName, mcUsd: first.mcAtCall, first: true }
          : undefined,
      });
      // a visible stamp: without it a refresh that changed nothing looked broken
      const stamped = `${text}
<i>↻ updated ${new Date().toISOString().slice(11, 16)} UTC</i>`;
      await ctx.editMessageText(stamped, {
        parse_mode: "HTML",
        reply_markup: ctx.callbackQuery.message?.reply_markup,
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      log.warn("tg", `refresh failed: ${String(e).slice(0, 90)}`);
    }
  });

  // 🔍 — "I was only looking": un-records the call inside the grace window
  bot.callbackQuery(/^scan:([1-9A-HJ-NP-Za-km-z]{32,44}):(\d+)$/, async (ctx) => {
    const [, mint, owner] = ctx.match as unknown as string[];
    if (String(ctx.from?.id) !== owner) {
      return ctx.answerCallbackQuery({ text: "Only the caller can turn their own call into a scan.", show_alert: true });
    }
    const gid = String(ctx.chat?.id ?? "");
    const ok = unrecordCall(mint, owner, gid, cfg.tgScanGraceS * 1000);
    await ctx.answerCallbackQuery({
      text: ok
        ? "Marked as a scan — not counted as your call."
        : `Too late: a call can only become a scan within ${cfg.tgScanGraceS}s.`,
      show_alert: !ok,
    });
    if (ok) {
      const kb = new InlineKeyboard().text("🔄", `ref:${mint}`).text("🗑", `del:${owner}`);
      await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
    }
  });

  // ------------------------------------------------------- the call card --
  // ALL messages, not message:text — a call posted as a chart screenshot puts
  // the CA in the CAPTION, and message:text never fires for those. Half the
  // missed registrations were exactly this.
  bot.on("message", async (ctx) => {
    const text = ctx.message.text ?? ctx.message.caption ?? "";
    if (!text || text.startsWith("/")) return;
    const chat = ctx.chat;
    if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
    const found = [...new Set(text.match(BASE58) ?? [])].filter((m) => !DENY.has(m));
    if (!found.length) return;

    const groupId = String(chat.id);
    const groupTitle = chat.title ?? "group";
    const callerId = String(ctx.from?.id ?? "");
    const callerName = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name ?? "anon";

    for (const mint of found.slice(0, 2)) {
      try {
        // ---- RECORD FIRST, independent of the card. A registration must never
        // die because rendering did: the old flow lost calls to the 90s card
        // throttle (anyone re-posting a mint inside it erased the next
        // caller's claim), to analyze() timeouts, and to slow RPC.
        // marketCap() is the pump-authoritative gate: no pump price = not ours.
        const { marketCap } = await import("../chain/marketcap.js");
        const exact = await marketCap(mint).catch(() => null);
        if (!exact || (exact.mcUsd == null && exact.mcSol == null)) continue; // not a pump coin — stay silent
        const mc = exact.mcUsd;
        const symbolEarly = exact.symbol ?? mint.slice(0, 6);

        const belowFloor =
          cfg.tgMinCallMcUsd > 0 && mc != null && mc < cfg.tgMinCallMcUsd;
        const res = belowFloor
          ? null
          : await recordCall({ mint, symbol: symbolEarly, callerId, callerName, groupId, groupTitle, mcAtCall: mc });

        // ---- THE CARD. Throttled per group+mint so a pasted-five-times CA
        // renders once — but only the card is throttled, never the record.
        if (throttled(`${groupId}:${mint}`)) {
          // their claim still deserves an answer, one line instead of a card
          if (res && !res.first) {
            await ctx.reply(
              `↩️ $${esc(symbolEarly)} — already called by <b>${esc(res.priorCaller!.callerName)}</b> ${ago(res.priorCaller!.at)} ago. Recorded for this group, no global score.`,
              { parse_mode: "HTML", reply_parameters: { message_id: ctx.message.message_id } },
            ).catch(() => {});
          }
          continue;
        }
        const { analyze } = await import("../analysis/engine.js");
        const a = await Promise.race([
          analyze(mint, null, { forceBubble: cfg.tgBubbleOnCard }),
          new Promise<null>((r) => setTimeout(() => r(null), 20_000)),
        ]);
        if (!a || a.state.kind === "none" || a.state.kind === "unsupported") {
          // recorded but uncardable right now — confirm the claim anyway
          if (res?.first) {
            await ctx.reply(
              `✅ <b>${esc(callerName)}</b> called $${esc(symbolEarly)} first @ ${money(mc)} — card unavailable, tracking anyway.`,
              { parse_mode: "HTML", reply_parameters: { message_id: ctx.message.message_id } },
            ).catch(() => {});
          }
          continue;
        }
        const liq = a.dexStats?.liqUsd ?? null;
        void liq;

        const [{ pumpCallerCount }, ath] = await Promise.all([
          import("../callout/callers.js"),
          athFromTape(mint).catch(() => null),
        ]);

        const { text, headerUrl } = renderCard(a, {
          ath,
          mcUsd: mc,
          pumpCallers: pumpCallerCount(mint),
          belowFloor,
          caller: {
            name: callerName,
            mcUsd: mc,
            first: !!res?.first,
            priorName: res?.priorCaller?.callerName,
            priorAt: res?.priorCaller?.at,
          },
        });

        // 🔍 within the grace window turns this back into a lookup — you can
        // check a coin without it counting against your record. After that it
        // is a call, or the button becomes "delete the ones that rugged".
        const kb = new InlineKeyboard()
          .text("🔍", `scan:${mint}:${callerId}`)
          .text("🔄", `ref:${mint}`)
          .text("🗑", `del:${callerId}`);
        await ctx.reply(text, {
          parse_mode: "HTML",
          reply_markup: kb,
          reply_parameters: { message_id: ctx.message.message_id },
          // dexscreener's paid banner rendered ABOVE the card, the way the
          // caller bots people already read do it
          link_preview_options: headerUrl
            ? { url: headerUrl, prefer_large_media: true, show_above_text: true }
            : { is_disabled: true },
        });
      } catch (e) {
        log.warn("tg", `card failed for ${mint.slice(0, 8)}…: ${String(e).slice(0, 90)}`);
      }
    }
  });

  bot.catch((err) => log.warn("tg", `bot error: ${String(err?.message ?? err).slice(0, 140)}`));

  // SUPERVISED polling. bot.start()'s promise REJECTS on a fatal polling error
  // — most famously 409 Conflict, which is guaranteed during a Railway rolling
  // deploy because the old and new containers briefly poll the same token. As
  // `void bot.start(...)` that rejection was unhandled, and an unhandled
  // rejection kills the whole process on Node 20: bot conflict -> stage,
  // trading, everything down. Retry with backoff instead; polling errors are
  // the bot's problem, never the show's.
  let stopping = false;
  void (async () => {
    let backoffMs = 5_000;
    while (!stopping) {
      try {
        await bot.start({
          drop_pending_updates: true,
          onStart: (me) => {
            backoffMs = 5_000;
            log.info("tg", `RikuBot LIVE as @${me.username} — auto-carding CAs, first-caller-wins`);
          },
        });
        break; // resolved = bot.stop() was called
      } catch (e) {
        if (stopping) break;
        log.warn("tg", `polling died (${String(e).slice(0, 90)}) — retrying in ${Math.round(backoffMs / 1000)}s`);
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 5 * 60_000);
      }
    }
  })();
  // release getUpdates the moment Railway says stop, so the incoming container
  // doesn't spend its first minute fighting us for the token
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      stopping = true;
      void bot.stop().catch(() => {});
    });
  }

  // grading loop: calls need an hour before they mean anything
  setInterval(() => {
    void gradeOpenCalls().then((n) => {
      if (n) log.info("tg", `graded ${n} call${n === 1 ? "" : "s"}`);
    }).catch(() => {});
  }, 10 * 60_000).unref?.();
}
