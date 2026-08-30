import fs from "node:fs";
import path from "node:path";
import { cfg } from "../config.js";
import { log } from "../log.js";

/**
 * twexapi fallback for REPLIES the official API refuses.
 *
 * X's API tier only permits threaded replies to posts where he is mentioned or
 * is the author — replying to a KOL returns
 *   403 "You can only reply to or quote posts where you are mentioned…"
 * twexapi acts through the account's own session cookie (what a browser does),
 * so it can reply anywhere. Used ONLY as a fallback after the official API
 * refuses; every original tweet still goes out through the official API.
 *
 * Needs two secrets (both optional — absent = feature simply off):
 *   TWEXAPI_KEY      dashboard key from https://twexapi.io/dashboard
 *   TWEX_AUTH_TOKEN  RIKU's X auth_token cookie  (or TWEX_COOKIE for the full
 *                    "ct0=…; auth_token=…" string)
 */
const BASE = (process.env.TWEXAPI_BASE_URL ?? "https://api.twexapi.io").replace(/\/+$/, "");
const KEY = (process.env.TWEXAPI_KEY ?? "").trim();
const AUTH_TOKEN = (process.env.TWEX_AUTH_TOKEN ?? "").trim();
const COOKIE_ENV = (process.env.TWEX_COOKIE ?? "").trim();
const COOKIE_CACHE = () => path.join(cfg.dataDir, "twex_cookie.txt");

export function twexReady(): boolean {
  return Boolean(KEY && (COOKIE_ENV || AUTH_TOKEN));
}

/** READS need only the dashboard key — no session cookie. Kept separate from
 *  twexReady() so read offloading works even when the cookie has expired. */
export function twexReadReady(): boolean {
  return Boolean(KEY);
}

async function twexPost(path: string, body: unknown, timeoutMs = 9_000): Promise<any | null> {
  if (!KEY) return null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = (await res.json()) as any;
    return j?.data ?? j?.tweets ?? (Array.isArray(j) ? j : null);
  } catch {
    return null;
  }
}

const num = (...v: any[]): number | null => {
  for (const x of v) if (typeof x === "number" && Number.isFinite(x)) return x;
  return null;
};
const cleanText = (t: any): string => String(t ?? "").replace(/https?:\/\/\S+/g, "").trim();

export interface TwexTweet {
  id: string;
  author: string;
  authorFollowers: number | null;
  authorPosts: number | null;
  authorCreatedAt: number | null;
  text: string;
  at: number | null;
}

function toTweet(t: any): TwexTweet | null {
  const a = t?.author ?? t?.user ?? {};
  const text = cleanText(t?.full_text ?? t?.text);
  const id = String(t?.tweet_id ?? t?.id ?? "");
  if (!id || text.length < 5) return null;
  const ts = Date.parse(String(t?.created_at ?? ""));
  const ats = Date.parse(String(a?.created_at ?? ""));
  return {
    id,
    author: String(a?.screen_name ?? a?.username ?? "").replace(/^@/, ""),
    authorFollowers: num(a?.followers_count, a?.followers, a?.public_metrics?.followers_count),
    authorPosts: num(a?.statuses_count, a?.tweet_count, a?.public_metrics?.tweet_count),
    authorCreatedAt: Number.isFinite(ats) ? ats : null,
    text,
    at: Number.isFinite(ts) ? ts : null,
  };
}

/** Search, off the official read quota entirely. Yield is ~20% of maxItems
 *  (asked 20 -> got 4, asked 50 -> got 10), so ask for more than you need. */
export async function twexSearch(query: string, maxItems = 20): Promise<TwexTweet[]> {
  const rows = await twexPost("/twitter/advanced_search", {
    searchTerms: [query],
    maxItems: Math.max(10, maxItems),
    sortBy: "Latest",
  });
  if (!Array.isArray(rows)) return [];
  return rows.map(toTweet).filter((t): t is TwexTweet => t !== null);
}

/** One KOL's recent posts. This is the read that was costing the most on the
 *  official API — 6 handles x 10 posts every 35 min, ~2,469 posts/day — and
 *  twexapi returns MORE rows than asked (count 10 -> 21) for zero X quota. */
export async function twexTimeline(handle: string, count = 10): Promise<TwexTweet[]> {
  const h = handle.replace(/^@/, "").trim();
  if (!h) return [];
  const rows = await twexPost(`/twitter/${encodeURIComponent(h)}/timeline/page`, { count: Math.max(5, count) });
  if (!Array.isArray(rows)) return [];
  return rows.map(toTweet).filter((t): t is TwexTweet => t !== null);
}

let cookieCache = "";
/** The session cookie: env string wins, else exchange the auth_token once and
 *  cache it to disk (the exchange puts the token in a URL — never log it). */
async function resolveCookie(): Promise<string> {
  if (COOKIE_ENV) return COOKIE_ENV;
  if (cookieCache) return cookieCache;
  try {
    cookieCache = fs.readFileSync(COOKIE_CACHE(), "utf8").trim();
    if (cookieCache) return cookieCache;
  } catch { /* no cache yet */ }
  if (!AUTH_TOKEN) return "";
  try {
    const res = await fetch(`${BASE}/twitter/${encodeURIComponent(AUTH_TOKEN)}/cookie`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    if (!res.ok) {
      log.warn("twex", `cookie exchange failed: ${res.status}`);
      return "";
    }
    const j: any = await res.json();
    const c = typeof j?.data === "string" ? j.data : "";
    if (c) {
      cookieCache = c;
      try { fs.writeFileSync(COOKIE_CACHE(), c); } catch {}
      log.info("twex", "session cookie resolved and cached");
    }
    return c;
  } catch (e) {
    log.warn("twex", `cookie exchange error: ${String(e).slice(0, 100)}`);
    return "";
  }
}

/** Reply to ANY tweet through the account session. Returns the new id. */
export async function twexReply(replyToId: string, text: string): Promise<{ ok: boolean; id?: string; why?: string }> {
  if (!twexReady()) return { ok: false, why: "twexapi not configured" };
  const cookie = await resolveCookie();
  if (!cookie) return { ok: false, why: "no session cookie" };
  try {
    const res = await fetch(`${BASE}/twitter/tweets/create`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ tweet_content: text, cookie, reply_tweet_id: replyToId }),
    });
    const body = await res.text();
    if (!res.ok) {
      log.warn("twex", `reply ${res.status}: ${body.slice(0, 160)}`);
      // a rejected cookie is usually expired — drop the cache so the next
      // attempt re-exchanges instead of failing forever
      if (res.status === 401 || res.status === 403) {
        cookieCache = "";
        try { fs.rmSync(COOKIE_CACHE()); } catch {}
      }
      return { ok: false, why: `http ${res.status}: ${body.slice(0, 140)}` };
    }
    let id: string | undefined;
    try {
      const j = JSON.parse(body);
      id = String(j?.data?.id ?? j?.data?.tweet_id ?? j?.id ?? "") || undefined;
    } catch { /* posted but unparsable — still a success */ }
    log.info("twex", `replied via session${id ? ` (${id})` : ""}`);
    return { ok: true, id };
  } catch (e) {
    return { ok: false, why: String(e).slice(0, 120) };
  }
}
