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
