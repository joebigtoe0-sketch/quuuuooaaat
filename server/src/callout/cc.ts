/**
 * Coin Communities client — vendored from calloutbot/src/cc.js, trimmed to
 * Quant's needs (own account env, no thesis-borrowing machinery).
 *
 * Callouts are NOT a pump.fun API: api.coincommunities.org has its own
 * accounts (Twitter OAuth) with wallets LINKED to them. Posting needs the
 * account's refresh token, never the wallet's private key. The ~$1-held gate
 * is checked on-chain against the wallet in the body — and Quant's wallet
 * holds the sent coins, so the gate is satisfied by the gift itself.
 */
const BASE = process.env.CC_API_BASE || "https://api.coincommunities.org";
// Shipped in pump.fun's frontend bundle — public app key, not a secret.
const API_KEY =
  process.env.CC_API_KEY ||
  "cc_367f1420841bfb46f31196f4520eff89cdacc311fe001109d181f7675bd7f131";

let cached: { token: string; expMs: number } | null = null;

// Persist the access token across reboots — Railway restarts on every deploy,
// and the CC refresh endpoint is aggressively rate-limited (429s in bursts). A
// disk cache means a reboot reuses the still-valid token instead of hammering
// the refresh endpoint on the first callout.
import fs from "node:fs";
import path from "node:path";
import { cfg } from "../config.js";
// the real data dir (server/data — the Railway volume), NOT process.cwd()/data
const TOKEN_FILE = path.join(cfg.dataDir, "cc_token.json");
function loadDiskToken(): void {
  if (cached) return;
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    if (j?.token && j?.expMs > Date.now() + 60_000) cached = j;
  } catch {}
}
function saveDiskToken(): void {
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(cached));
  } catch {}
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function headers(auth?: string): Record<string, string> {
  const h: Record<string, string> = {
    accept: "*/*",
    "content-type": "application/json",
    "x-api-key": API_KEY,
    origin: "https://pump.fun",
  };
  if (auth) h.authorization = `Bearer ${auth}`;
  return h;
}

function jwtExpiryMs(token: string): number {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const p = JSON.parse(Buffer.from(part, "base64").toString());
    return typeof p.exp === "number" ? p.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function request(method: string, apiPath: string, body?: unknown, auth?: string): Promise<any> {
  const res = await fetch(`${BASE}${apiPath}`, {
    method,
    headers: headers(auth),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) throw new Error(`${res.status} ${method} ${apiPath}: ${text.slice(0, 300)}`);
  return json;
}

export async function getAccessToken(): Promise<string> {
  loadDiskToken();
  if (cached && Date.now() < cached.expMs - 60_000) return cached.token;
  const refresh = (process.env.QUANT_CC_REFRESH_TOKEN || "").trim();
  if (!refresh) throw new Error("QUANT_CC_REFRESH_TOKEN is not set");

  // ONE shape (refreshToken — the verified-correct one; probing three tripled
  // the request rate into a rate-limited endpoint). Retry 429s with backoff.
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(4000 * attempt); // 4s, 8s, 12s
    try {
      const j = await request("POST", "/api/v1/users/token/refresh", { refreshToken: refresh });
      const token = j?.accessToken || j?.access_token || j?.token;
      if (!token) {
        lastErr = "200 but no token in response";
        continue;
      }
      cached = { token, expMs: jwtExpiryMs(token) || Date.now() + 30 * 60_000 };
      saveDiskToken();
      return token;
    } catch (e: any) {
      lastErr = e.message;
      if (!/^429/.test(String(e.message))) break; // only 429s are worth retrying
    }
  }
  throw new Error(`token refresh failed: ${lastErr}`);
}

/** Authenticated GET with the SAME headers the posting path uses (the API
 *  needs x-api-key as well as the bearer — a probe without it 401s). */
export async function ccGet(apiPath: string): Promise<any> {
  return request("GET", apiPath, undefined, await getAccessToken());
}

export async function whoAmI(): Promise<any> {
  return request("GET", "/api/v1/users/me", undefined, await getAccessToken());
}

export async function postCallout(mint: string, content: string, walletAddress: string): Promise<any> {
  const token = await getAccessToken();
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(5000 * attempt); // 5s, 10s
    try {
      return await request(
        "POST",
        `/api/v1/communities/${mint}/callouts`,
        { chainId: "solana", walletAddress, content },
        token,
      );
    } catch (e: any) {
      lastErr = e.message;
      if (!/^429/.test(String(e.message))) throw e; // only back off on rate limits
    }
  }
  throw new Error(`callout post failed after retries: ${lastErr}`);
}
