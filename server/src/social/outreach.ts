import fs from "node:fs";
import path from "node:path";
import { cfg } from "../config.js";
import { log } from "../log.js";
import { callFreeform, FRAGMENT_MODEL } from "../brain/adapter.js";

/**
 * OUTREACH — find small crypto accounts on the timeline and draft RIKU replies
 * to them. NOTHING SENDS ITSELF: every draft sits in a queue until the
 * producer approves it (or edits it) in /admin/outreach.html. The point is
 * distribution — a good public reply on a 2k-follower account is seen by that
 * account AND its audience; a DM is seen by nobody and risks the account.
 *
 * Hard rails, enforced here and at the approve endpoint:
 *  - max OUTREACH_MAX_SENDS_PER_HOUR approved sends per rolling hour
 *  - never queue the same author twice within OUTREACH_DEDUPE_DAYS
 *  - author follower window [OUTREACH_MIN_FOLLOWERS, OUTREACH_MAX_FOLLOWERS]
 *  - ban list survives restarts; banning also skips the author's pending items
 * The reply itself never shills: no cashtags, no links, no site plug — RIKU
 * shows up as a funny account, the profile does the converting.
 */

export interface OutreachItem {
  id: string; // our queue id
  tweetId: string;
  author: string; // username, no @
  followers: number | null;
  tweetText: string;
  tweetAt: number | null;
  draft: string;
  score: number;
  foundAt: number;
  status: "pending" | "sent" | "skipped";
  decidedAt?: number;
  sentText?: string; // what actually went out (producer may edit)
}

interface OutreachDb {
  items: OutreachItem[];
  seenAuthors: Record<string, number>; // username(lower) -> last queued ms
  banned: string[]; // usernames(lower)
  sentTimes: number[]; // send timestamps for the rolling-hour rail
  queryCursor: number;
}

const FILE = () => path.join(cfg.dataDir, "outreach.json");
let db: OutreachDb = { items: [], seenAuthors: {}, banned: [], sentTimes: [], queryCursor: 0 };
try {
  const j = JSON.parse(fs.readFileSync(FILE(), "utf8"));
  if (j?.items) db = { queryCursor: 0, sentTimes: [], banned: [], seenAuthors: {}, ...j };
} catch { /* first run */ }
function save(): void {
  try {
    fs.writeFileSync(FILE(), JSON.stringify(db));
  } catch {}
}

// Rotating searches for the language only real trench dwellers use. Kept
// jargon-heavy on purpose: "crypto" finds engagement farmers, "the trenches"
// finds the audience. -filter:replies keeps it to top-level takes RIKU can
// quote-react to; lang:en because his bit only lands in english.
const QUERIES = [
  '"the trenches" (pump OR pumpfun OR sol) -filter:replies lang:en',
  '"aped" (sol OR pumpfun OR "pump.fun") -filter:replies lang:en',
  '"dev sold" OR "dev dumped" -filter:replies lang:en',
  '"bonded" (pumpfun OR "pump.fun" OR curve) -filter:replies lang:en',
  '"rugged" (sol OR pumpfun) min_faves:2 -filter:replies lang:en',
  '"memecoin" (down OR cooked OR "im done" OR bag) -filter:replies lang:en',
  '"pump.fun" (callout OR caller OR calls) -filter:replies lang:en',
  '"ai agent" (trading OR trader) (sol OR solana) -filter:replies lang:en',
];

function looksEnglish(s: string): boolean {
  const ascii = s.replace(/[^\x20-\x7e]/g, "").length;
  return ascii / Math.max(1, s.length) > 0.85;
}

/** Would RIKU have anything to say? Cheap pre-LLM score; top few get drafts. */
function scoreCandidate(text: string, followers: number): number {
  let s = 0;
  if (/\?/.test(text)) s += 2; // questions invite answers
  if (/(rug|dev sold|cooked|down bad|lost|bag|exit liq)/i.test(text)) s += 2; // pain = his lane
  if (/(bot|ai|agent|algo|quant)/i.test(text)) s += 2; // literally about him
  if (/(caller|callout|alpha group|cabal)/i.test(text)) s += 2;
  if (text.length > 60) s += 1; // substance to react to
  if (followers >= 500) s += 1; // audience worth the reply
  if (/(giveaway|airdrop below|tag 3|retweet to)/i.test(text)) s -= 5; // engagement farm
  if (/\$[A-Z]{2,10}\b.*\$[A-Z]{2,10}\b.*\$[A-Z]{2,10}\b/.test(text)) s -= 3; // cashtag spam
  return s;
}

async function draftReply(item: { author: string; tweetText: string }): Promise<string | null> {
  const text = await Promise.race([
    callFreeform(
      "You are RIKU, a cocky AI quant character who livestreams himself trading memecoins. Write ONE public reply to the tweet below." +
        "\nSTYLE — deadpan degen shitpost, lowercase preferred, under ~180 chars. React to what THEY actually said — a reply that could sit under any tweet is worthless. Be funny first; if you can slip one genuinely sharp observation inside the bit, do it." +
        "\nYou may reference being an AI/bot/quant when it's funny ('i ran the numbers. the numbers filed a complaint')." +
        "\nHARD RULES: never mention your own coin, ticker, website or stream. No links, no cashtags, no hashtags, no 'DYOR', no financial advice, max one emoji. Never insult them, never dunk on their loss — commiserate or joke WITH them. Never name other traders or callers. Don't ask them to follow you. Output only the reply line.",
      `@${item.author} tweeted:\n"${item.tweetText.slice(0, 400)}"`,
      90,
      FRAGMENT_MODEL,
    ),
    new Promise<null>((r) => setTimeout(() => r(null), 12_000)),
  ]);
  const line = (text ?? "").trim().replace(/^["']|["']$/g, "");
  // a draft that broke the rules is worse than no draft — the producer would
  // have to catch it by eye
  if (!line || line.length < 4 || /https?:\/\/|[#$][A-Za-z]/.test(line)) return null;
  return line.slice(0, 260);
}

const norm = (u: string) => u.toLowerCase().replace(/^@/, "");

async function discoverTick(): Promise<void> {
  try {
    const { searchTweetsRich, xHandle, xReadReady } = await import("./x.js");
    if (!xReadReady()) return;
    const q = QUERIES[db.queryCursor % QUERIES.length];
    db.queryCursor++;
    const found = await searchTweetsRich(q, 20);
    const now = Date.now();
    const fresh = found.filter((t) => {
      const u = norm(t.author);
      if (u === norm(xHandle())) return false;
      if (db.banned.includes(u)) return false;
      const last = db.seenAuthors[u] ?? 0;
      if (now - last < cfg.outreachDedupeDays * 86_400_000) return false;
      if (t.authorFollowers == null || t.authorFollowers < cfg.outreachMinFollowers || t.authorFollowers > cfg.outreachMaxFollowers) return false;
      if (t.at && now - t.at > 2 * 3600_000) return false; // stale takes get stale replies
      if (t.text.length < 25 || !looksEnglish(t.text)) return false;
      if (t.authorPosts != null && t.authorPosts > 200_000) return false; // reply-bot
      if (db.items.some((i) => i.tweetId === t.id)) return false;
      return true;
    });
    const scored = fresh
      .map((t) => ({ t, score: scoreCandidate(t.text, t.authorFollowers ?? 0) }))
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3); // LLM spend rail: at most 3 drafts per tick
    for (const { t, score } of scored) {
      const draft = await draftReply({ author: t.author, tweetText: t.text });
      if (!draft) continue;
      db.items.push({
        id: `${t.id}-${now.toString(36)}`,
        tweetId: t.id,
        author: t.author,
        followers: t.authorFollowers,
        tweetText: t.text,
        tweetAt: t.at,
        draft,
        score,
        foundAt: now,
        status: "pending",
      });
      db.seenAuthors[norm(t.author)] = now;
    }
    // hygiene: pending items older than 6h are dead takes; keep history bounded
    db.items = db.items.filter(
      (i) => !(i.status === "pending" && now - i.foundAt > 6 * 3600_000),
    );
    if (db.items.length > 400) db.items = db.items.slice(-400);
    save();
    const pending = db.items.filter((i) => i.status === "pending").length;
    // always log — a silent sweep and a broken search look identical otherwise
    log.info("outreach", `sweep "${q.slice(0, 36)}…" → ${found.length} found, ${fresh.length} passed filters, ${scored.length} drafted, ${pending} pending`);
  } catch (e) {
    log.warn("outreach", `discover failed: ${String(e).slice(0, 100)}`);
  }
}

export function outreachList(): { items: OutreachItem[]; sentLastHour: number; maxPerHour: number } {
  const hourAgo = Date.now() - 3600_000;
  db.sentTimes = db.sentTimes.filter((t) => t > hourAgo);
  return {
    items: [...db.items].sort((a, b) => b.foundAt - a.foundAt).slice(0, 120),
    sentLastHour: db.sentTimes.length,
    maxPerHour: cfg.outreachMaxSendsPerHour,
  };
}

/** Producer approved (optionally with edited text). Sends the reply through
 *  the same path as reply-exact. Enforces the hourly rail HERE so no caller
 *  can bypass it. */
export async function outreachApprove(
  id: string,
  editedText?: string,
): Promise<{ ok: boolean; why?: string; text?: string; tweetId?: string }> {
  const item = db.items.find((i) => i.id === id);
  if (!item) return { ok: false, why: "no such item" };
  if (item.status !== "pending") return { ok: false, why: `already ${item.status}` };
  const hourAgo = Date.now() - 3600_000;
  db.sentTimes = db.sentTimes.filter((t) => t > hourAgo);
  if (db.sentTimes.length >= cfg.outreachMaxSendsPerHour)
    return { ok: false, why: `hourly rail: ${db.sentTimes.length}/${cfg.outreachMaxSendsPerHour} sent in the last hour — try later` };
  const text = (editedText?.trim() || item.draft).slice(0, 270);
  const { postTweet } = await import("./x.js");
  const r = await postTweet(text, { replyTo: item.tweetId, exact: true });
  if (!r.ok) return { ok: false, why: r.why ?? "post failed" };
  item.status = "sent";
  item.decidedAt = Date.now();
  item.sentText = text;
  db.sentTimes.push(Date.now());
  save();
  log.info("outreach", `SENT reply to @${item.author} (${item.followers ?? "?"} followers): ${text.slice(0, 80)}`);
  return { ok: true, text, tweetId: item.tweetId };
}

export function outreachSkip(id: string): boolean {
  const item = db.items.find((i) => i.id === id);
  if (!item || item.status !== "pending") return false;
  item.status = "skipped";
  item.decidedAt = Date.now();
  save();
  return true;
}

export function outreachBan(author: string): number {
  const u = norm(author);
  if (!db.banned.includes(u)) db.banned.push(u);
  let n = 0;
  for (const i of db.items) {
    if (norm(i.author) === u && i.status === "pending") {
      i.status = "skipped";
      i.decidedAt = Date.now();
      n++;
    }
  }
  save();
  return n;
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startOutreach(): void {
  if (!cfg.outreach) {
    log.info("outreach", "OUTREACH off — no candidate discovery");
    return;
  }
  if (timer) return;
  timer = setInterval(() => void discoverTick(), cfg.outreachTickMin * 60_000);
  setTimeout(() => void discoverTick(), 20_000); // first sweep shortly after boot
  log.info(
    "outreach",
    `outreach LIVE (approval-only) — sweep every ${cfg.outreachTickMin}min, authors ${cfg.outreachMinFollowers}–${cfg.outreachMaxFollowers} followers, ` +
      `max ${cfg.outreachMaxSendsPerHour} sends/hour, author dedupe ${cfg.outreachDedupeDays}d — queue at /admin/outreach.html`,
  );
}
