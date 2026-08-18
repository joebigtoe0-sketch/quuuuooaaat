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
  if (cached && Date.now() < cached.expMs - 60_000) return cached.token;
  const refresh = (process.env.QUANT_CC_REFRESH_TOKEN || "").trim();
  if (!refresh) throw new Error("QUANT_CC_REFRESH_TOKEN is not set");

  const shapes: [string, Record<string, string>][] = [
    ["refreshToken", { refreshToken: refresh }],
    ["token", { token: refresh }],
    ["refresh_token", { refresh_token: refresh }],
  ];
  const errors: string[] = [];
  for (const [name, body] of shapes) {
    try {
      const j = await request("POST", "/api/v1/users/token/refresh", body);
      const token = j?.accessToken || j?.access_token || j?.token;
      if (!token) {
        errors.push(`${name}: 200 but no token`);
        continue;
      }
      cached = { token, expMs: jwtExpiryMs(token) || Date.now() + 30 * 60_000 };
      return token;
    } catch (e: any) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  throw new Error(`token refresh failed. Tried:\n  ${errors.join("\n  ")}`);
}

export async function whoAmI(): Promise<any> {
  return request("GET", "/api/v1/users/me", undefined, await getAccessToken());
}

export async function postCallout(mint: string, content: string, walletAddress: string): Promise<any> {
  return request(
    "POST",
    `/api/v1/communities/${mint}/callouts`,
    { chainId: "solana", walletAddress, content },
    await getAccessToken(),
  );
}
