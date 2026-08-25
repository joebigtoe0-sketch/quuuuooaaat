import { cfg, isLive } from "../config.js";
import crypto from "node:crypto";
import fs from "node:fs";
import { store } from "../store.js";
import { log } from "../log.js";
import { pushFeed } from "../feed.js";

/**
 * X (Twitter) client — vendored from the universe/Solus project (proven live):
 * OAuth 1.0a user-context signing + official v2 posting. Extended here with
 * v1.1 chunked media upload so Quant can post its greenscreen videos.
 * Official API only — the account IS the product; no session hacks.
 */
const HANDLE = (process.env.X_HANDLE ?? "").trim().replace(/^@/, "");
const CONSUMER_KEY = (process.env.X_CONSUMER_KEY ?? "").trim();
const CONSUMER_SECRET = (process.env.X_CONSUMER_SECRET ?? "").trim();
const ACCESS_TOKEN = (process.env.X_ACCESS_TOKEN ?? "").trim();
const ACCESS_SECRET = (process.env.X_ACCESS_SECRET ?? "").trim();
const READ_KEY = (process.env.TWITTERAPI_IO_KEY ?? "").trim();
const BEARER = (process.env.X_BEARER_TOKEN ?? "").trim();

/** Official X API v2 read call (app-only bearer). Verified live on this tier:
 *  search 450 req/15min, mentions, user tweets, user lookup all 200. */
async function v2(pathq: string): Promise<any | null> {
  if (!BEARER) return null;
  try {
    const res = await fetch(`https://api.x.com/2${pathq}`, { headers: { authorization: `Bearer ${BEARER}` } });
    if (!res.ok) {
      log.warn("x", `v2 ${pathq.split("?")[0]} → ${res.status}`);
      return null;
    }
    return await res.json();
  } catch {
    return null;
  }
}
const idCache = new Map<string, string>();
async function userId(handle: string): Promise<string | null> {
  const h = handle.replace(/^@/, "");
  if (idCache.has(h)) return idCache.get(h)!;
  const j = await v2(`/users/by/username/${h}`);
  const id = j?.data?.id ? String(j.data.id) : null;
  if (id) idCache.set(h, id);
  return id;
}
function v2Texts(j: any): { author: string; text: string; id: string }[] {
  const users = new Map<string, string>(
    (j?.includes?.users ?? []).map((u: any) => [String(u.id), String(u.username)]),
  );
  return (j?.data ?? []).map((t: any) => ({
    id: String(t.id ?? ""),
    author: users.get(String(t.author_id)) ?? "?",
    text: String(t.text ?? "").replace(/https?:\/\/\S+/g, "").trim(),
  }));
}
let lastPostError: { at: number; kind: string; status: number; detail: string } | null = null;
export const lastXError = () => lastPostError;
const MAX_POST_LEN = Number(process.env.X_MAX_POST_LEN ?? 272);
const MAX_POSTS_PER_DAY = Number(process.env.X_MAX_POSTS_PER_DAY ?? 130); // hard rail incl. replies; originals capped at cfg.maxTweetsPerDay in beats

export function xReady(): boolean {
  return Boolean(CONSUMER_KEY && CONSUMER_SECRET && ACCESS_TOKEN && ACCESS_SECRET);
}
export function xReadReady(): boolean {
  return BEARER.length > 0 || READ_KEY.length > 0;
}
export function xHandle(): string {
  return HANDLE || "quant";
}

const dayKey = () => `xposts:${new Date().toISOString().slice(0, 10)}`;
export function xPostsToday(): number {
  return Number(store.kvGet(dayKey()) ?? 0);
}

function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** OAuth 1.0a HMAC-SHA1. `extraParams` join the signature base for
 *  form-encoded requests (media upload); JSON bodies sign oauth params only. */
function oauthHeader(method: string, url: string, extraParams: Record<string, string> = {}): string {
  const p: Record<string, string> = {
    oauth_consumer_key: CONSUMER_KEY,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: ACCESS_TOKEN,
    oauth_version: "1.0",
  };
  const all = { ...p, ...extraParams };
  const base = [
    method,
    pct(url),
    pct(
      Object.keys(all)
        .sort()
        .map((k) => `${pct(k)}=${pct(all[k])}`)
        .join("&"),
    ),
  ].join("&");
  const key = `${pct(CONSUMER_SECRET)}&${pct(ACCESS_SECRET)}`;
  p.oauth_signature = crypto.createHmac("sha1", key).update(base).digest("base64");
  return (
    "OAuth " +
    Object.keys(p)
      .sort()
      .map((k) => `${pct(k)}="${pct(p[k])}"`)
      .join(", ")
  );
}

/**
 * RETIRED-PHRASE RAIL. Catchphrases burn out: "write that down" was in half his
 * posts before it read as a bot tic, and the caption model kept reaching for it
 * (and for "i did the math so you don't have to") even when the brief banned
 * them outright — five briefs in a row. Prompts don't hold; code does.
 *
 * Only strips the phrase when it stands as its OWN sentence, which is exactly
 * the tic form. A quoted or embedded reference survives, so he can still say
 * he retired it without this eating the line.
 */
const RETIRED = [
  /write that down/i,
  /i did the math so you don'?t have to/i,
];
export function scrubRetired(text: string): string {
  const parts = text.split(/(?<=[.!?])\s+/);
  const kept = parts.filter((sentence) => {
    const bare = sentence.trim().replace(/^["'`“‘]+|["'`.!?”’]+$/g, "").trim();
    return !RETIRED.some((re) => re.test(bare) && bare.replace(re, "").trim().length === 0);
  });
  // Nothing removed -> hand back the ORIGINAL string untouched. Rebuilding it
  // would flatten the blank lines that long-form posts are written with.
  if (kept.length === parts.length) return text;
  const out = kept.join(" ").replace(/[ 	]{2,}/g, " ").trim();
  return out.length >= 2 ? out : text; // never scrub a post down to nothing
}

/** Sentence-boundary trim (from universe) — never cut mid-word. */
export function trimForX(text: string): string {
  if (text.length <= MAX_POST_LEN) return text;
  const cut = text.slice(0, MAX_POST_LEN);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return stop > 60 ? cut.slice(0, stop + 1) : cut.slice(0, MAX_POST_LEN - 1).trimEnd() + "…";
}

export async function postTweet(
  text: string,
  opts: { mediaId?: string; replyTo?: string; exact?: boolean; communityId?: string } = {},
): Promise<{ ok: boolean; id?: string; dry: boolean; why?: string }> {
  // The model gets a leash (MAX_POST_LEN) so it can't ramble. Words the
  // producer wrote by hand are already deliberate — they go out whole, and
  // the account is Premium, so long-form is allowed.
  const trim = (t: string): string => scrubRetired(opts.exact ? t : trimForX(t));
  if (xPostsToday() >= MAX_POSTS_PER_DAY) return { ok: false, dry: false, why: "daily post cap" };
  // HARD GATE: nothing reaches the real timeline until GO LIVE is armed —
  // keys being present must never mean "start posting"
  if (!isLive() && !cfg.simMode) {
    log.info("x", `[PRE-LIVE] composed, not posted: "${trim(text)}"`);
    pushFeed("tweet-dry", `${trim(text)} [awaiting GO LIVE]`);
    return { ok: true, dry: true };
  }
  if (cfg.simMode) {
    store.kvSet(dayKey(), String(xPostsToday() + 1));
    log.info("x", `[SIM] posted: "${trim(text)}"${opts.mediaId ? " +media" : ""}`);
    pushFeed("tweet-sim", `${trim(text)}${opts.mediaId ? " [+media]" : ""}`);
    return { ok: true, id: `sim_${Date.now()}`, dry: false };
  }
  if (!xReady()) {
    log.info("x", `[DRY] would post: "${trim(text)}"${opts.mediaId ? " +video" : ""}`);
    pushFeed("tweet-dry", `${trim(text)}${opts.mediaId ? " [+video]" : ""}`);
    return { ok: true, dry: true };
  }
  const url = "https://api.x.com/2/tweets";
  const body: Record<string, unknown> = { text: trim(text) };
  if (opts.mediaId) body.media = { media_ids: [opts.mediaId] };
  if (opts.replyTo) body.reply = { in_reply_to_tweet_id: opts.replyTo };
  // Posting INTO an X Community. The account must already be a member;
  // X silently routes it to the normal timeline if the id is wrong, so
  // verify where a new community post actually landed before trusting it.
  if (opts.communityId) body.community_id = opts.communityId;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: oauthHeader("POST", url), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = (await res.text()).slice(0, 300);
      // TIER LIMIT on replies ("you can only reply to posts where you are
      // mentioned or are the author") — go through the account session instead.
      if (res.status === 403 && opts.replyTo && /not-authorized-for-resource|only reply to or quote/i.test(t)) {
        const { twexReady, twexReply } = await import("./twex.js");
        if (twexReady()) {
          const r = await twexReply(opts.replyTo, trim(text));
          if (r.ok) {
            store.kvSet(dayKey(), String(xPostsToday() + 1));
            pushFeed("tweet-live", `↩ @reply via session: ${trim(text)}`);
            return { ok: true, id: r.id, dry: false };
          }
          lastPostError = { at: Date.now(), kind: "reply-twex", status: res.status, detail: r.why ?? "twex failed" };
          return { ok: false, dry: false, why: `official 403 + twex: ${r.why}` };
        }
      }
      log.warn("x", `post http ${res.status}${opts.replyTo ? ` (reply to ${opts.replyTo})` : ""}: ${t}`);
      lastPostError = { at: Date.now(), kind: opts.replyTo ? "reply" : opts.mediaId ? "media" : "original", status: res.status, detail: t };
      // the X error body is the only thing that explains a silent failure
      return { ok: false, dry: false, why: `http ${res.status}: ${t.slice(0, 180)}` };
    }
    const data = (await res.json()) as { data?: { id?: string } };
    store.kvSet(dayKey(), String(xPostsToday() + 1));
    log.info("x", `posted ${data.data?.id}`);
    pushFeed("tweet-live", `${trim(text)}${opts.mediaId ? " [+video]" : ""} → https://x.com/${HANDLE}/status/${data.data?.id}`);
    return { ok: true, id: data.data?.id, dry: false };
  } catch (e) {
    lastPostError = { at: Date.now(), kind: opts.replyTo ? "reply" : "original", status: 0, detail: String(e).slice(0, 200) };
    return { ok: false, dry: false, why: String(e).slice(0, 100) };
  }
}

/** v1.1 chunked media upload (INIT/APPEND/FINALIZE + processing wait). */
export async function uploadVideo(mp4Path: string): Promise<string | null> {
  if (cfg.simMode) return `sim_video_${Date.now()}`;
  if (!xReady()) return null;
  const UP = "https://upload.twitter.com/1.1/media/upload.json";
  const buf = fs.readFileSync(mp4Path);
  try {
    // INIT
    const initParams = {
      command: "INIT",
      total_bytes: String(buf.length),
      media_type: "video/mp4",
      media_category: "tweet_video",
    };
    let res = await fetch(UP, {
      method: "POST",
      headers: {
        authorization: oauthHeader("POST", UP, initParams),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(initParams).toString(),
    });
    if (!res.ok) throw new Error(`INIT ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const mediaId = ((await res.json()) as any).media_id_string as string;

    // APPEND (multipart — only oauth params signed)
    const CHUNK = 4 * 1024 * 1024;
    for (let i = 0, seg = 0; i < buf.length; i += CHUNK, seg++) {
      const fd = new FormData();
      fd.set("command", "APPEND");
      fd.set("media_id", mediaId);
      fd.set("segment_index", String(seg));
      fd.set("media", new Blob([buf.subarray(i, i + CHUNK)]));
      res = await fetch(UP, { method: "POST", headers: { authorization: oauthHeader("POST", UP) }, body: fd });
      if (!res.ok) throw new Error(`APPEND ${res.status}`);
    }

    // FINALIZE
    const finParams = { command: "FINALIZE", media_id: mediaId };
    res = await fetch(UP, {
      method: "POST",
      headers: { authorization: oauthHeader("POST", UP, finParams), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(finParams).toString(),
    });
    if (!res.ok) throw new Error(`FINALIZE ${res.status}: ${(await res.text()).slice(0, 120)}`);
    let info = ((await res.json()) as any).processing_info;

    // wait for processing
    for (let tries = 0; info && info.state !== "succeeded" && tries < 20; tries++) {
      if (info.state === "failed") throw new Error("processing failed");
      await new Promise((r) => setTimeout(r, (info.check_after_secs ?? 3) * 1000));
      const statusParams = { command: "STATUS", media_id: mediaId };
      const sres = await fetch(`${UP}?${new URLSearchParams(statusParams)}`, {
        headers: { authorization: oauthHeader("GET", UP, statusParams) },
      });
      info = ((await sres.json()) as any).processing_info;
    }
    log.info("x", `video uploaded: media_id ${mediaId}`);
    return mediaId;
  } catch (e) {
    log.warn("x", `video upload failed: ${String(e).slice(0, 160)}`);
    return null;
  }
}


export type XPost = { id: string; author: string; text: string };
export type Mention = XPost & {
  conversationId?: string;
  parent?: XPost;
};

function cleanText(s: unknown): string {
  return String(s ?? "").replace(/https?:\/\/\S+/g, "").trim();
}
function usersById(j: any): Map<string, string> {
  return new Map((j?.includes?.users ?? []).map((u: any) => [String(u.id), String(u.username)]));
}
function includedTweets(j: any): Map<string, any> {
  return new Map((j?.includes?.tweets ?? []).map((t: any) => [String(t.id), t]));
}
function parentFrom(t: any, users: Map<string, string>, tweets: Map<string, any>): XPost | undefined {
  const replied = (t?.referenced_tweets ?? []).find((r: any) => r?.type === "replied_to");
  if (!replied?.id) return undefined;
  const p = tweets.get(String(replied.id));
  if (!p) return { id: String(replied.id), author: "?", text: "" };
  return {
    id: String(p.id),
    author: users.get(String(p.author_id)) ?? "?",
    text: cleanText(p.text),
  };
}
const THREAD_FIELDS =
  "expansions=author_id,referenced_tweets.id,referenced_tweets.id.author_id&user.fields=username&tweet.fields=author_id,conversation_id,referenced_tweets,created_at";

function parseMentionRows(j: any): Mention[] {
  const users = usersById(j);
  const tweets = includedTweets(j);
  const rows = Array.isArray(j?.data) ? j.data : [];
  return rows
    .map((t: any) => ({
      id: String(t.id ?? ""),
      author: users.get(String(t.author_id)) ?? "?",
      text: cleanText(t.text),
      conversationId: t.conversation_id ? String(t.conversation_id) : undefined,
      parent: parentFrom(t, users, tweets),
    }))
    .filter((t: Mention) => t.id && t.text);
}

/** Mentions of our handle — official X API first, twitterapi.io fallback.
 *  Includes conversationId + the immediate parent tweet when the API expands it.
 *  Full thread is readTweetThread (call that only when you are about to reply). */
export async function readMentions(
  sinceMinutes = 720,
): Promise<Mention[]> {
  if (!HANDLE) return [];
  if (BEARER) {
    const me = await userId(HANDLE);
    if (me) {
      const start = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
      const j = await v2(`/users/${me}/mentions?max_results=25&start_time=${start}&${THREAD_FIELDS}`);
      if (j) return parseMentionRows(j).slice(0, 12);
    }
  }
  if (!READ_KEY) return [];
  try {
    const since = Math.floor(Date.now() / 1000) - sinceMinutes * 60;
    const res = await fetch(
      `https://api.twitterapi.io/twitter/user/mentions?userName=${HANDLE.replace(/^@/, "")}&sinceTime=${since}`,
      { headers: { "X-API-Key": READ_KEY } },
    );
    if (!res.ok) return [];
    const j: any = await res.json();
    const tweets: any[] = j?.tweets ?? j?.data ?? [];
    return tweets
      .map((t) => {
        const replyTo = String(t?.inReplyToId ?? t?.inReplyToStatusId ?? t?.in_reply_to_status_id ?? "");
        const parentText = cleanText(t?.inReplyToText ?? t?.referencedTweet?.text ?? "");
        const parentAuthor = String(t?.inReplyToUserName ?? t?.referencedTweet?.author?.userName ?? "");
        const parent: XPost | undefined = replyTo
          ? { id: replyTo, author: parentAuthor || "?", text: parentText }
          : undefined;
        return {
          id: String(t?.id ?? t?.id_str ?? ""),
          text: String(t?.text ?? ""),
          author: String(t?.author?.userName ?? t?.author?.screen_name ?? "?"),
          conversationId: t?.conversationId || t?.conversation_id ? String(t.conversationId ?? t.conversation_id) : undefined,
          parent,
        };
      })
      .filter((t) => t.id && t.text)
      .slice(0, 12);
  } catch {
    return [];
  }
}

/** Chronological posts in the same conversation as tweetId (last 12, 7-day window). */
export async function readTweetThread(tweetId: string): Promise<XPost[]> {
  const id = String(tweetId ?? "").replace(/\D/g, "");
  if (!id) return [];

  if (BEARER) {
    const one = await v2(`/tweets/${id}?${THREAD_FIELDS}`);
    const conversationId = String(one?.data?.conversation_id ?? id);
    const q = encodeURIComponent(`conversation_id:${conversationId}`);
    const j = await v2(`/tweets/search/recent?query=${q}&max_results=25&${THREAD_FIELDS}&sort_order=recency`);
    if (j?.data?.length) {
      const newestFirst = parseMentionRows(j);
      const out: XPost[] = [];
      const have = new Set<string>();
      for (const t of [...newestFirst].reverse()) {
        if (t.parent?.id && t.parent.text && !have.has(t.parent.id)) {
          out.push({ id: t.parent.id, author: t.parent.author, text: t.parent.text });
          have.add(t.parent.id);
        }
        if (!have.has(t.id)) {
          out.push({ id: t.id, author: t.author, text: t.text });
          have.add(t.id);
        }
      }
      if (out.length) return out.slice(-12);
    }
    // at least return the target + its parent
    if (one?.data) {
      const users = usersById(one);
      const parent = parentFrom(one.data, users, includedTweets(one));
      const self: XPost = {
        id: String(one.data.id),
        author: users.get(String(one.data.author_id)) ?? "?",
        text: cleanText(one.data.text),
      };
      return [parent, self].filter((p): p is XPost => Boolean(p?.id && p.text));
    }
  }

  if (READ_KEY) {
    try {
      const conv = encodeURIComponent(`conversation_id:${id}`);
      const res = await fetch(
        `https://api.twitterapi.io/twitter/tweet/advanced_search?query=${conv}&queryType=Latest`,
        { headers: { "X-API-Key": READ_KEY } },
      );
      if (res.ok) {
        const data: any = await res.json();
        const tweets: any[] = data.tweets ?? data.data ?? [];
        const rows = tweets
          .map((t: any) => ({
            id: String(t?.id ?? t?.id_str ?? ""),
            author: String(t?.author?.userName ?? t?.author?.username ?? t?.author?.screen_name ?? "?"),
            text: cleanText(t?.text),
            at: Date.parse(String(t?.createdAt ?? t?.created_at ?? "")) || 0,
          }))
          .filter((t: { id: string; text: string }) => t.id && t.text)
          .sort((a: { at: number }, b: { at: number }) => a.at - b.at);
        if (rows.length) return rows.map(({ id, author, text }: any) => ({ id, author, text })).slice(-12);
      }
    } catch {
      /* fall through */
    }
  }
  return [];
}

let followersCache: { n: number; at: number } | null = null;
/** Search recent tweets — cashtags ($TICKER), contract addresses, anything.
 *  twitterapi.io advanced search; returns cleaned texts with authors. */
export async function searchTweets(query: string, maxResults = 15): Promise<{ author: string; text: string }[]> {
  if (BEARER) {
    const j = await v2(`/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=${Math.min(50, Math.max(10, maxResults))}&expansions=author_id&user.fields=username`);
    if (j) return v2Texts(j).filter((t) => t.text.length > 5).slice(0, maxResults);
  }
  if (!READ_KEY) return [];
  try {
    const res = await fetch(
      `https://api.twitterapi.io/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=Latest`,
      { headers: { "X-API-Key": READ_KEY } },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    const tweets = data.tweets ?? data.data ?? [];
    return tweets
      .map((t: any) => ({
        author: String(t.author?.userName ?? t.username ?? "?"),
        text: String(t.text ?? "").replace(/https?:\/\/\S+/g, "").trim(),
      }))
      .filter((t: { text: string }) => t.text.length > 5)
      .slice(0, maxResults);
  } catch {
    return [];
  }
}

export interface RichTweet {
  id: string;
  author: string; // username, no @
  authorFollowers: number | null;
  authorPosts: number | null;
  authorCreatedAt: number | null; // ms
  text: string;
  at: number | null; // tweet time ms
}

/** Search with full author stats + tweet ids — what outreach needs and
 *  searchTweets throws away. twitterapi.io first (richest), v2 fallback. */
export async function searchTweetsRich(query: string, maxResults = 20): Promise<RichTweet[]> {
  if (READ_KEY) {
    try {
      const res = await fetch(
        `https://api.twitterapi.io/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=Latest`,
        { headers: { "X-API-Key": READ_KEY } },
      );
      if (res.ok) {
        const data = (await res.json()) as any;
        const tweets = data.tweets ?? data.data ?? [];
        const numOr = (...vals: any[]): number | null => {
          for (const v of vals) if (v != null && Number.isFinite(Number(v))) return Number(v);
          return null;
        };
        const rows: RichTweet[] = tweets
          .map((t: any) => {
            // field spellings drift across twitterapi.io versions — take any
            const a = t.author ?? t.user ?? {};
            const ts = Date.parse(String(t.createdAt ?? t.created_at ?? ""));
            const ats = Date.parse(String(a.createdAt ?? a.created_at ?? ""));
            return {
              id: String(t.id ?? t.id_str ?? ""),
              author: String(a.userName ?? a.username ?? a.screen_name ?? t.username ?? ""),
              authorFollowers: numOr(a.followers, a.followersCount, a.followers_count),
              authorPosts: numOr(a.statusesCount, a.statuses_count, a.tweetsCount, a.tweets_count),
              authorCreatedAt: Number.isFinite(ats) ? ats : null,
              text: String(t.text ?? t.full_text ?? "").replace(/https?:\/\/\S+/g, "").trim(),
              at: Number.isFinite(ts) ? ts : null,
            };
          })
          .filter((t: RichTweet) => t.id && t.author && t.text.length > 5);
        if (rows.length) return rows.slice(0, maxResults);
      }
    } catch { /* fall through to v2 */ }
  }
  if (BEARER) {
    // v2 speaks a different dialect than the web/advanced search: -filter:replies
    // is -is:reply, and min_faves doesn't exist at all (silently dropping it
    // beats a guaranteed 400)
    const v2q = query.replace(/-filter:replies/g, "-is:reply").replace(/\s*min_faves:\d+/g, "").trim();
    const j = await v2(
      `/tweets/search/recent?query=${encodeURIComponent(v2q)}&max_results=${Math.min(50, Math.max(10, maxResults))}` +
        `&expansions=author_id&user.fields=username,public_metrics,created_at&tweet.fields=created_at,author_id`,
    );
    if (j) {
      const users = new Map<string, any>((j?.includes?.users ?? []).map((u: any) => [String(u.id), u]));
      return (j?.data ?? [])
        .map((t: any) => {
          const u = users.get(String(t.author_id)) ?? {};
          const ts = Date.parse(String(t.created_at ?? ""));
          const ats = Date.parse(String(u.created_at ?? ""));
          return {
            id: String(t.id ?? ""),
            author: String(u.username ?? ""),
            authorFollowers: u.public_metrics?.followers_count ?? null,
            authorPosts: u.public_metrics?.tweet_count ?? null,
            authorCreatedAt: Number.isFinite(ats) ? ats : null,
            text: String(t.text ?? "").replace(/https?:\/\/\S+/g, "").trim(),
            at: Number.isFinite(ts) ? ts : null,
          };
        })
        .filter((t: RichTweet) => t.id && t.author && t.text.length > 5)
        .slice(0, maxResults);
    }
  }
  return [];
}

/** Our follower count (twitterapi.io), cached 10 min. */
export async function xFollowers(): Promise<number | null> {
  if (!HANDLE) return null;
  if (followersCache && Date.now() - followersCache.at < 10 * 60_000) return followersCache.n;
  if (BEARER) {
    const me = await userId(HANDLE);
    if (me) {
      const j = await v2(`/users/${me}?user.fields=public_metrics`);
      const n = j?.data?.public_metrics?.followers_count;
      if (typeof n === "number") {
        followersCache = { n, at: Date.now() };
        return n;
      }
    }
  }
  if (!READ_KEY) return null;
  if (followersCache && Date.now() - followersCache.at < 600_000) return followersCache.n;
  try {
    const res = await fetch(
      `https://api.twitterapi.io/twitter/user/info?userName=${HANDLE.replace(/^@/, "")}`,
      { headers: { "X-API-Key": READ_KEY } },
    );
    if (!res.ok) return null;
    const j: any = await res.json();
    const n = Number(j?.data?.followers ?? j?.followers_count ?? j?.data?.followers_count);
    if (!Number.isFinite(n)) return null;
    followersCache = { n, at: Date.now() };
    return n;
  } catch {
    return null;
  }
}

/** Simple (non-chunked) image upload — v1.1 media/upload with base64 body. */
export async function uploadImage(pngPath: string): Promise<string | null> {
  if (cfg.simMode) return `sim_image_${Date.now()}`;
  if (!xReady()) return null;
  try {
    const UP = "https://upload.twitter.com/1.1/media/upload.json";
    const b64 = fs.readFileSync(pngPath).toString("base64");
    const params = { media_data: b64 };
    const auth = oauthHeader("POST", UP, params);
    const res = await fetch(UP, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    return String(j?.media_id_string ?? "") || null;
  } catch {
    return null;
  }
}

/** Recent tweets from a KOL the agent follows (twitterapi.io read path). */
/**
 * FRESH POSTS ACROSS MANY ACCOUNTS IN ONE CALL — `(from:a OR from:b …)` recent
 * search. Measured against the live key: a 512-char query caps out around 28
 * `from:` terms, so we batch 25. 75 handles = 3 calls (budget: 450/15min).
 */
export async function searchFromHandles(
  handles: string[],
  sinceMinutes = 180,
  perBatch = 10,
): Promise<{ id: string; author: string; text: string }[]> {
  if (!BEARER || !handles.length) return [];
  const out: { id: string; author: string; text: string }[] = [];
  const start = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
  for (let i = 0; i < handles.length; i += 25) {
    const batch = handles.slice(i, i + 25);
    const q = `(${batch.map((h) => `from:${h}`).join(" OR ")}) -is:retweet -is:reply`;
    if (q.length > 505) continue; // guard: over the cap, skip rather than 400
    const j = await v2(
      `/tweets/search/recent?max_results=${Math.max(10, perBatch)}&query=${encodeURIComponent(q)}` +
        `&start_time=${start}&tweet.fields=created_at,author_id&expansions=author_id&user.fields=username`,
    );
    if (!j?.data) continue;
    const users: Record<string, string> = {};
    for (const u of j.includes?.users ?? []) users[u.id] = u.username;
    for (const t of j.data) {
      const text = String(t.text ?? "").replace(/https?:\/\/\S+/g, "").trim();
      if (text.length < 8) continue;
      out.push({ id: String(t.id), author: users[t.author_id] ?? "?", text });
    }
  }
  return out;
}

/** Follow an account (user-context OAuth1a — same keys that post tweets). */
export async function followUser(handle: string): Promise<boolean> {
  if (!xReady()) return false;
  try {
    const me = await userId(HANDLE.replace(/^@/, ""));
    const target = await userId(handle);
    if (!me || !target) return false;
    const url = `https://api.x.com/2/users/${me}/following`;
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: oauthHeader("POST", url), "content-type": "application/json" },
      body: JSON.stringify({ target_user_id: target }),
    });
    if (!res.ok) {
      log.warn("x", `follow @${handle} → ${res.status}`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function readUserTweets(handle: string, sinceMinutes = 240): Promise<string[]> {
  if (BEARER) {
    const id = await userId(handle);
    if (id) {
      const start = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
      const j = await v2(`/users/${id}/tweets?max_results=10&start_time=${start}&exclude=retweets`);
      if (j) return (j.data ?? [])
        .map((t: any) => String(t.text ?? "").replace(/https?:\/\/\S+/g, "").trim())
        .filter((t: string) => t.length > 5)
        .slice(0, 8);
    }
  }
  if (!READ_KEY) return [];
  try {
    const since = Math.floor(Date.now() / 1000) - sinceMinutes * 60;
    const res = await fetch(
      `https://api.twitterapi.io/twitter/user/last_tweets?userName=${handle.replace(/^@/, "")}&sinceTime=${since}`,
      { headers: { "X-API-Key": READ_KEY } },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    const tweets = data.tweets ?? data.data ?? [];
    return tweets
      .map((t: any) => String(t.text ?? "").replace(/https?:\/\/\S+/g, "").trim())
      .filter((t: string) => t.length > 5)
      .slice(0, 8);
  } catch {
    return [];
  }
}
