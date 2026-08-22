/**
 * feed-bridge.mjs — residential poller for RIKU's caller-follow feed.
 *
 * WHY THIS EXISTS: pump.fun's authenticated follow-feed
 * (/following-positions/alerts) 401s from datacenter IPs (Railway, Hetzner),
 * but works fine from a residential connection. So this tiny script runs on a
 * home machine, polls the feed, and forwards the raw items to RIKU's server,
 * which does all the parsing / grading / nomination. This box is a dumb pipe —
 * no logic lives here, so nothing to maintain when the strategy changes.
 *
 * RUN:
 *   PUMP_COOKIE="auth_token=eyJ..."  \
 *   RIKU_URL="https://quantriku.fun" \
 *   ADMIN_KEY="<admin password>"     \
 *   node tools/feed-bridge.mjs
 *
 * or drop those in tools/feed-bridge.env (KEY=VALUE per line) next to this file.
 * Leave it running (Task Scheduler / pm2 / a terminal). It self-heals on
 * transient errors and prints one line per poll.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// load tools/feed-bridge.env if present (never committed)
const ENVFILE = join(HERE, "feed-bridge.env");
if (existsSync(ENVFILE)) {
  for (const line of readFileSync(ENVFILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}

const COOKIE = (process.env.PUMP_COOKIE || "").trim();
const RIKU_URL = (process.env.RIKU_URL || "https://quantriku.fun").replace(/\/$/, "");
const ADMIN_KEY = (process.env.ADMIN_KEY || "").trim();
const EVERY_MS = Number(process.env.EVERY_MS || 20000);

if (!COOKIE || !ADMIN_KEY) {
  console.error("need PUMP_COOKIE and ADMIN_KEY (env or tools/feed-bridge.env)");
  process.exit(1);
}

const FEED = "https://frontend-api-v3.pump.fun/following-positions/alerts?pageSize=50&kinds=callout";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const stamp = () => new Date().toISOString().slice(11, 19);

async function tick() {
  let items = [];
  try {
    const r = await fetch(FEED, {
      headers: { "user-agent": UA, origin: "https://pump.fun", accept: "*/*", "content-type": "application/json", cookie: COOKIE },
    });
    if (r.status === 401 || r.status === 403) {
      console.log(`${stamp()}  feed ${r.status} — cookie expired or IP blocked here; refresh PUMP_COOKIE`);
      return;
    }
    if (!r.ok) {
      console.log(`${stamp()}  feed ${r.status}`);
      return;
    }
    const j = await r.json();
    items = j?.items || [];
  } catch (e) {
    console.log(`${stamp()}  fetch failed: ${String(e).slice(0, 80)}`);
    return;
  }
  if (!items.length) {
    console.log(`${stamp()}  0 items`);
    return;
  }
  try {
    const r = await fetch(`${RIKU_URL}/admin/feed-ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": ADMIN_KEY },
      body: JSON.stringify({ items }),
    });
    const j = await r.json().catch(() => ({}));
    console.log(`${stamp()}  forwarded ${items.length} → seen ${j.seen ?? "?"}, nominated ${j.nominated ?? 0}`);
  } catch (e) {
    console.log(`${stamp()}  forward failed: ${String(e).slice(0, 80)}`);
  }
}

console.log(`feed-bridge → ${RIKU_URL}, every ${EVERY_MS / 1000}s`);
await tick();
setInterval(tick, EVERY_MS);
