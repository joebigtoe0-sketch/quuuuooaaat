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

const BASE58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
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
        "/lb — this group's leaderboard (1D/7D/14D/30D)\n/lb global — the global board, prizes pay off this one\n/pnl &lt;ca&gt; — a shareable card: how far that call ran\n/me — your record\n/rules — how scoring works",
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
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text ?? "";
    if (text.startsWith("/")) return;
    const chat = ctx.chat;
    if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;
    const found = [...new Set(text.match(BASE58) ?? [])].filter((m) => !DENY.has(m));
    if (!found.length) return;

    const groupId = String(chat.id);
    const groupTitle = chat.title ?? "group";
    const callerId = String(ctx.from?.id ?? "");
    const callerName = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name ?? "anon";

    for (const mint of found.slice(0, 2)) {
      if (throttled(`${groupId}:${mint}`)) continue;
      try {
        const { analyze } = await import("../analysis/engine.js");
        const a = await Promise.race([
          analyze(mint, null, { forceBubble: cfg.tgBubbleOnCard }),
          new Promise<null>((r) => setTimeout(() => r(null), 20_000)),
        ]);
        if (!a || a.state.kind === "none" || a.state.kind === "unsupported") continue; // not ours — say nothing
        // pump.fun's own number, chain second, dexscreener last — this is also
        // what gets RECORDED as the call price, so a 3-4% low feed would bias
        // every score on the board, not just the display.
        const { marketCap } = await import("../chain/marketcap.js");
        const exact = await marketCap(mint).catch(() => null);
        const mc = exact?.mcUsd ?? a.state.mcSol * a.solUsd;
        const liq = a.dexStats?.liqUsd ?? null;

        // Floors default to 0 — see config. An early call is the valuable kind,
        // and excluding it removed its downside too.
        const belowFloor =
          (cfg.tgMinCallMcUsd > 0 && mc != null && mc < cfg.tgMinCallMcUsd) ||
          (cfg.tgMinLiqUsd > 0 && liq != null && liq < cfg.tgMinLiqUsd);
        const res = belowFloor
          ? null
          : await recordCall({ mint, symbol: a.symbol, callerId, callerName, groupId, groupTitle, mcAtCall: mc });

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

  void bot.start({
    drop_pending_updates: true,
    onStart: (me) => log.info("tg", `RikuBot LIVE as @${me.username} — auto-carding CAs, first-caller-wins`),
  });

  // grading loop: calls need an hour before they mean anything
  setInterval(() => {
    void gradeOpenCalls().then((n) => {
      if (n) log.info("tg", `graded ${n} call${n === 1 ? "" : "s"}`);
    }).catch(() => {});
  }, 10 * 60_000).unref?.();
}
