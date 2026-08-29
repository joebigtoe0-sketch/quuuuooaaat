/**
 * Callout client — pump.fun NATIVE, self-authenticating.
 *
 * 2026-08-28/29: Coin Communities was absorbed into pump.fun; callouts are now native
 * pump.fun endpoints. Auth is the pump session cookie. TWO things were needed to make
 * posting work again after the migration:
 *   1. the create body is `{ coinMint, thesis, version: 2 }` — the `version: 2` flag is
 *      REQUIRED; without it (or with the old `chainId`) the server can't resolve the
 *      holding wallet and returns 403 NO_ELIGIBLE_WALLET even though the account holds
 *      the coin and eligibility says ELIGIBLE.
 *   2. the cookie must be a fresh login token (JWT with `userId`). Rather than depend on
 *      a hand-pasted PUMP_COOKIE that goes stale, this module MINTS ITS OWN cookie by
 *      signing the SIWS login with Riku's wallet key (QUANT_WALLET_SECRET) and caches it.
 *
 *   post:  POST /callout/create  { coinMint, thesis, version: 2 }  -> 201
 *   like:  POST /callout/{id}/like
 *   read:  GET  /home-feed?pageSize=&chain=all
 */
import nacl from "tweetnacl";
import bs58 from "bs58";
import { loadWallet } from "../chain/wallet.js";

const FE = process.env.PUMP_API_BASE || "https://frontend-api-v3.pump.fun";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function normCookie(v: string): string {
  v = (v ?? "").trim().replace(/^["']|["']$/g, "");
  if (!v) return "";
  if (/(^|;\s*)auth_token=/.test(v)) return v;
  if (/^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v)) return `auth_token=${v}`;
  return v;
}
function jwtExpMs(token: string): number {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    return typeof p.exp === "number" ? p.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

// ---- self-minted session cookie (SIWS login with Riku's key) ----
let cachedCookie: { cookie: string; expMs: number } | null = null;

async function mintCookie(): Promise<string> {
  const kp = loadWallet();
  if (!kp) {
    // no key available — fall back to a hand-pasted cookie if present
    const env = normCookie(process.env.PUMP_COOKIE ?? "");
    if (env) return env;
    throw new Error("no wallet key (QUANT_WALLET_SECRET) and no PUMP_COOKIE to authenticate callouts");
  }
  const address = kp.publicKey.toBase58();
  const timestamp = Date.now();
  const message = `Sign in to pump.fun: ${timestamp}`;
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
  const res = await fetch(`${FE}/auth/login`, {
    method: "POST",
    headers: { "user-agent": UA, origin: "https://pump.fun", "content-type": "application/json" },
    body: JSON.stringify({ address, signature, timestamp }),
  });
  if (!res.ok) throw new Error(`auth/login ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const setc = res.headers.get("set-cookie") || "";
  const at = (setc.match(/auth_token=([^;]+)/) || [])[1];
  if (!at) throw new Error("auth/login ok but no auth_token cookie");
  const cfb = (setc.match(/__cf_bm=([^;]+)/) || [])[1];
  let cookie = "auth_token=" + at;
  if (cfb) cookie += "; __cf_bm=" + cfb;
  cachedCookie = { cookie, expMs: jwtExpMs(at) || Date.now() + 25 * 24 * 3600_000 };
  return cookie;
}

async function sessionCookie(): Promise<string> {
  if (cachedCookie && Date.now() < cachedCookie.expMs - 24 * 3600_000) return cachedCookie.cookie;
  return mintCookie();
}

function baseHeaders(cookie: string): Record<string, string> {
  return { accept: "*/*", "content-type": "application/json", "user-agent": UA, origin: "https://pump.fun", referer: "https://pump.fun/", cookie };
}

// RATE AWARENESS — posting callouts is revenue; background reads must yield to it.
let lastPostAt = 0;
let last429At = 0;
export function ccQuietOk(): boolean {
  return Date.now() - lastPostAt > 60_000 && Date.now() - last429At > 10 * 60_000;
}

async function request(method: string, apiPath: string, body?: unknown): Promise<any> {
  const cookie = await sessionCookie();
  const res = await fetch(`${FE}${apiPath}`, {
    method,
    headers: baseHeaders(cookie),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (res.status === 429) last429At = Date.now();
  if (res.status === 401) cachedCookie = null; // stale — force a re-mint next call
  if (method === "POST" && apiPath.includes("/callout/create")) lastPostAt = Date.now();
  if (!res.ok) throw new Error(`${res.status} ${method} ${apiPath}: ${text.slice(0, 300)}`);
  return json;
}

/** Preflight for post.ts — confirms we can authenticate before committing to a CALL. */
export async function getAccessToken(): Promise<string> {
  return sessionCookie();
}

export async function ccGet(apiPath: string): Promise<any> {
  return request("GET", apiPath);
}

export async function whoAmI(): Promise<any> {
  return request("GET", "/auth/my-profile");
}

export async function postCallout(mint: string, content: string, _walletAddress?: string): Promise<any> {
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(5000 * attempt);
    try {
      // version:2 is REQUIRED — it's the newer wallet-resolution path. No chainId, no walletAddress.
      return await request("POST", "/callout/create", { coinMint: mint, thesis: content, version: 2 });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      lastErr = msg;
      if (/duplicate|already\s+call|DUPLICATE_CALLOUT|409/i.test(msg)) throw new Error(`duplicate_callout: ${msg}`);
      if (!/^429/.test(msg)) throw e;
    }
  }
  throw new Error(`callout post failed after retries: ${lastErr}`);
}
