import { Bot } from "grammy";
import { cfg } from "../config.js";
import { log } from "../log.js";
import {
  recordCall, leaderboard, callsForMint, callerHistory, gradeOpenCalls, stats, athFromTape,
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
    return `${medal} <b>${esc(r.callerName)}</b> — score ${r.score.toFixed(2)} · ${r.calls} calls · med ${r.medianMult.toFixed(1)}x · ${r.hit2x.toFixed(0)}% hit 2x${flag}`;
  });
  return `<b>${title}</b>\n${lines.join("\n")}\n\n<i>${note}</i>`;
}

export function startTelegram(): void {
  if (!cfg.tgEnabled || !cfg.tgBotToken) {
    log.info("tg", "RikuBot off (TG_ENABLED / TG_BOT_TOKEN)");
    return;
  }
  const bot = new Bot(cfg.tgBotToken);

  bot.command("start", (ctx) =>
    ctx.reply(
      "I track calls. Post a contract address in a group I'm in and I'll card it and record who called it first.\n\n" +
        "/board — this group's callers\n/global — the global board (prizes pay off this one)\n/me — your record\n/rules — how scoring works",
      { parse_mode: "HTML" },
    ),
  );

  bot.command("rules", (ctx) =>
    ctx.reply(
      "<b>How scoring works</b>\n\n" +
        "Every call is scored on the best price that held for a full 5 minutes after you called it — not the wick. " +
        "A spike nobody could have sold into is not a result.\n\n" +
        "Your score is the <b>average</b> of your calls, in log terms, so:\n" +
        "• calling more does NOT raise your score\n" +
        "• a loser subtracts as much as a winner adds\n" +
        `• one moon can't carry you — credit per call caps at ${cfg.tgMaxCreditMult}x\n` +
        `• thin records get pulled toward the average until you have a real sample\n\n` +
        `<b>First caller only.</b> If a coin was already called anywhere, a later post is recorded for your group but scores nothing globally.\n\n` +
        `Prizes need at least ${cfg.tgMinScoredCalls} scored calls in the last ${cfg.tgScoreWindowDays} days.`,
      { parse_mode: "HTML" },
    ),
  );

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
      ? `score <b>${row.score.toFixed(2)}</b> · ${row.calls} graded · med ${row.medianMult.toFixed(1)}x · ${row.hit2x.toFixed(0)}% hit 2x` +
        (row.eligible ? " · <b>prize-eligible</b>" : ` · needs ${cfg.tgMinScoredCalls} scored calls to be prize-eligible`)
      : "nothing graded yet";
    return ctx.reply(`<b>${esc(ctx.from?.first_name ?? "You")}</b>\n${head}\n\n${recentCalls.join("\n")}`, {
      parse_mode: "HTML",
    });
  });

  bot.command("deep", (ctx) =>
    ctx.reply(
      "Deep holder profiling runs against the 78M-row local tape index, which isn't reachable from here yet. " +
        "The card's holder line is the live on-chain read.",
    ),
  );

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
        const mc = a.dexStats?.mcUsd ?? a.state.mcSol * a.solUsd;
        const liq = a.dexStats?.liqUsd ?? null;

        // floors: a 3x on a $2k coin with $300 of volume is manufacturable for
        // pocket change, so it is carded but never scored
        const belowFloor = (mc != null && mc < cfg.tgMinCallMcUsd) || (liq != null && liq < cfg.tgMinLiqUsd);
        const res = belowFloor
          ? null
          : await recordCall({ mint, symbol: a.symbol, callerId, callerName, groupId, groupTitle, mcAtCall: mc });

        const [{ pumpCallerCount }, ath] = await Promise.all([
          import("../callout/callers.js"),
          athFromTape(mint).catch(() => null),
        ]);

        const { text, headerUrl } = renderCard(a, {
          ath,
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

        await ctx.reply(text, {
          parse_mode: "HTML",
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
