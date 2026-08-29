/**
 * Callout client — pump.fun NATIVE.
 *
 * 2026-08-28: Coin Communities (api.coincommunities.org) was absorbed into
 * pump.fun; its whole /api/v1/* surface was removed. Callouts are now native
 * pump.fun endpoints on frontend-api-v3, authed by the account's pump COOKIE
 * (the same Riku PUMP_COOKIE the discovery follow-feed uses) — NOT a CC bearer
 * token and NOT the wallet private key. The ~$1-held gate still applies on-chain
 * against the posting account, and Quant's wallet holds the sent coins, so the
 * gate is satisfied by the gift itself.
 *
 * Exports are unchanged (getAccessToken / ccGet / whoAmI / postCallout /
 * ccQuietOk) so post.ts and index.ts need no edits — only the transport moved.
 *
 *   post:  POST /callout/create   { coinMint, thesis, version: 2 }   -> 201
 *   like:  POST /callout/{id}/like
 *   read:  GET  /home-feed?pageSize=&chain=all   (coins[].positions[] callouts)
 *
 * NOTE: `version: 2` is REQUIRED. Without it the server uses the old wallet-
 * resolution path and 403s NO_ELIGIBLE_WALLET even though the account holds the
 * coin; with it, it resolves the holding wallet (only the $1 gate remains). Works
 * with the existing PUMP_COOKIE — no userId in the token needed.
 */
const FE = process.env.PUMP_API_BASE || "https://frontend-api-v3.pump.fun";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Normalize a pasted cookie: strip quotes, and add the `auth_token=` name if a
 *  bare JWT was pasted. (Same rule as discovery.normCookie; inlined to avoid an
 *  import cycle with the discovery module.) */
function normCookie(v: string): string {
  v = (v ?? "").trim().replace(/^["']|["']$/g, "");
  if (!v) return "";
  if (/(^|;\s*)auth_token=/.test(v)) return v;
  if (/^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v)) return `auth_token=${v}`;
  return v;
}
function pumpCookie(): string {
  return normCookie(process.env.PUMP_COOKIE ?? "");
}

function headers(): Record<string, string> {
  return {
    accept: "*/*",
    "content-type": "application/json",
    "user-agent": UA,
    origin: "https://pump.fun",
    referer: "https://pump.fun/",
    cookie: pumpCookie(),
  };
}

// RATE AWARENESS — posting callouts is revenue; background reads must yield to it.
let lastPostAt = 0;
let last429At = 0;
export function ccQuietOk(): boolean {
  return Date.now() - lastPostAt > 60_000 && Date.now() - last429At > 10 * 60_000;
}

async function request(method: string, apiPath: string, body?: unknown): Promise<any> {
  const res = await fetch(`${FE}${apiPath}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (res.status === 429) last429At = Date.now();
  if (method === "POST" && apiPath.includes("/callout/create")) lastPostAt = Date.now();
  if (!res.ok) throw new Error(`${res.status} ${method} ${apiPath}: ${text.slice(0, 300)}`);
  return json;
}

/** "Auth" is now just having the pump cookie. post.ts calls this as a preflight
 *  before committing to a CALL on stream, so keep it throwing when unset. */
export async function getAccessToken(): Promise<string> {
  const c = pumpCookie();
  if (!c) throw new Error("PUMP_COOKIE is not set");
  return c;
}

/** Authenticated GET against pump's frontend-api (used by the admin debug proxy). */
export async function ccGet(apiPath: string): Promise<any> {
  return request("GET", apiPath);
}

export async function whoAmI(): Promise<any> {
  return request("GET", "/auth/my-profile");
}

export async function postCallout(mint: string, content: string, _walletAddress?: string): Promise<any> {
  // The pump COOKIE identifies the posting account, so no walletAddress in the
  // body (kept the arg for call-site parity with the old CC signature).
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(5000 * attempt); // 5s, 10s
    try {
      return await request("POST", "/callout/create", {
        coinMint: mint,
        thesis: content,
        version: 2,
      });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      lastErr = msg;
      // A repeat call on the same coin is a success upstream (post.ts maps
      // "duplicate_callout" -> ok). Normalize whatever pump returns for it.
      if (/duplicate|already\s+call|409/i.test(msg)) {
        throw new Error(`duplicate_callout: ${msg}`);
      }
      if (!/^429/.test(msg)) throw e; // only back off on rate limits
    }
  }
  throw new Error(`callout post failed after retries: ${lastErr}`);
}
