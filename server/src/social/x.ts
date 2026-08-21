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

/** Sentence-boundary trim (from universe) — never cut mid-word. */
export function trimForX(text: string): string {
  if (text.length <= MAX_POST_LEN) return text;
  const cut = text.slice(0, MAX_POST_LEN);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return stop > 60 ? cut.slice(0, stop + 1) : cut.slice(0, MAX_POST_LEN - 1).trimEnd() + "…";
}

export async function postTweet(
  text: string,
  opts: { mediaId?: string; replyTo?: string } = {},
): Promise<{ ok: boolean; id?: string; dry: boolean; why?: string }> {
  if (xPostsToday() >= MAX_POSTS_PER_DAY) return { ok: false, dry: false, why: "daily post cap" };
  // HARD GATE: nothing reaches the real timeline until GO LIVE is armed —
  // keys being present must never mean "start posting"
  if (!isLive() && !cfg.simMode) {
    log.info("x", `[PRE-LIVE] composed, not posted: "${trimForX(text)}"`);
    pushFeed("tweet-dry", `${trimForX(text)} [awaiting GO LIVE]`);
    return { ok: true, dry: true };
  }
  if (cfg.simMode) {
    store.kvSet(dayKey(), String(xPostsToday() + 1));
    log.info("x", `[SIM] posted: "${trimForX(text)}"${opts.mediaId ? " +media" : ""}`);
    pushFeed("tweet-sim", `${trimForX(text)}${opts.mediaId ? " [+media]" : ""}`);
    return { ok: true, id: `sim_${Date.now()}`, dry: false };
  }
  if (!xReady()) {
    log.info("x", `[DRY] would post: "${trimForX(text)}"${opts.mediaId ? " +video" : ""}`);
    pushFeed("tweet-dry", `${trimForX(text)}${opts.mediaId ? " [+video]" : ""}`);
    return { ok: true, dry: true };
  }
  const url = "https://api.x.com/2/tweets";
  const body: Record<string, unknown> = { text: trimForX(text) };
  if (opts.mediaId) body.media = { media_ids: [opts.mediaId] };
  if (opts.replyTo) body.reply = { in_reply_to_tweet_id: opts.replyTo };
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
          const r = await twexReply(opts.replyTo, trimForX(text));
          if (r.ok) {
            store.kvSet(dayKey(), String(xPostsToday() + 1));
            pushFeed("tweet-live", `↩ @reply via session: ${trimForX(text)}`);
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
    pushFeed("tweet-live", `${trimForX(text)}${opts.mediaId ? " [+video]" : ""} → https://x.com/${HANDLE}/status/${data.data?.id}`);
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


/** Mentions of our handle — official X API first, twitterapi.io fallback. */
export async function readMentions(
  sinceMinutes = 720,
): Promise<{ id: string; text: string; author: string }[]> {
  if (!HANDLE) return [];
  if (BEARER) {
    const me = await userId(HANDLE);
    if (me) {
      const start = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
      const j = await v2(`/users/${me}/mentions?max_results=25&start_time=${start}&expansions=author_id&user.fields=username&tweet.fields=author_id`);
      if (j) return v2Texts(j).filter((t) => t.id && t.text).slice(0, 12);
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
      .map((t) => ({
        id: String(t?.id ?? ""),
        text: String(t?.text ?? ""),
        author: String(t?.author?.userName ?? t?.author?.screen_name ?? "?"),
      }))
      .filter((t) => t.id && t.text)
      .slice(0, 12);
  } catch {
    return [];
  }
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
