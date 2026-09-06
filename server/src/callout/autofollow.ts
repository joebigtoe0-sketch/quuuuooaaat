import fs from "node:fs";
import path from "node:path";
import { cfg } from "../config.js";
import { log } from "../log.js";
import { normCookie } from "./discovery.js";

/**
 * AUTO-FOLLOW — the fix for a starving funnel.
 *
 * The fast discovery feed is following-positions/alerts: callouts from accounts
 * RIKU'S PUMP.FUN ACCOUNT FOLLOWS. That list IS the funnel. On 09-06 the index
 * held 77 callers who passed every reputation gate end to end (h2 to 69%, one
 * with 61 graded calls) while the follow feed delivered the same five names at
 * h2 19-20% over and over — because those five were who the account followed.
 * The bars were fine; the phone book was wrong.
 *
 * So: periodically follow every caller the index says is worth following, with
 * the SAME bars the runtime gates apply — a caller worth buying from is a
 * caller worth following, by construction. Write endpoint confirmed in the
 * calloutfollow tooling: POST frontend-api-v3.pump.fun/following/v2/{wallet}.
 *
 * pump.fun's authed routes have 401'd from datacenter IPs before (the feed
 * comment says so), so every run reports its status codes — if Railway can
 * read the feed with this cookie it can probably write follows, but that is a
 * finding for the log, not an assumption.
 */

const FILE = () => path.join(cfg.dataDir, "pumpfollowed.json");
let done: Record<string, number> = {};
try {
  const j = JSON.parse(fs.readFileSync(FILE(), "utf8"));
  if (j && typeof j === "object") done = j;
} catch { /* first run */ }
function save(): void {
  try {
    const tmp = `${FILE()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(done));
    fs.renameSync(tmp, FILE());
  } catch {}
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function followWallet(wallet: string, cookie: string): Promise<number> {
  const res = await fetch(`https://frontend-api-v3.pump.fun/following/v2/${wallet}`, {
    method: "POST",
    headers: {
      "user-agent": UA,
      origin: "https://pump.fun",
      accept: "*/*",
      "content-type": "application/json",
      cookie,
    },
  });
  return res.status;
}

export interface FollowRunResult {
  qualifying: number;
  alreadyFollowed: number;
  attempted: number;
  ok: number;
  statuses: Record<string, number>;
}

/** One pass: follow every qualifying caller not yet followed, gently paced. */
export async function runAutoFollow(maxPerRun = 30): Promise<FollowRunResult> {
  const cookie = normCookie(process.env.PUMP_COOKIE ?? "");
  const out: FollowRunResult = { qualifying: 0, alreadyFollowed: 0, attempted: 0, ok: 0, statuses: {} };
  if (!cookie) {
    log.warn("autofollow", "PUMP_COOKIE not set — cannot follow anyone");
    return out;
  }
  const { allCallerReps } = await import("./callers.js");
  // the runtime gates' own bars: worth buying from = worth following
  const q = allCallerReps().filter(
    (r) =>
      r.h2 > cfg.callerFollowMinH2 &&
      r.med >= 1.2 &&
      r.avg >= cfg.callerDiscoveryAvg &&
      r.calls >= cfg.callerDiscoveryMinCalls,
  );
  out.qualifying = q.length;
  const todo = q.filter((r) => !done[r.userId]);
  out.alreadyFollowed = q.length - todo.length;
  for (const r of todo.slice(0, maxPerRun)) {
    out.attempted++;
    try {
      const status = await followWallet(r.userId, cookie);
      out.statuses[String(status)] = (out.statuses[String(status)] ?? 0) + 1;
      if (status >= 200 && status < 300) {
        out.ok++;
        done[r.userId] = Date.now();
        log.info("autofollow", `followed ${r.username || r.userId.slice(0, 8)} (h2 ${r.h2}%, ${r.calls} calls)`);
      } else if (status === 401 || status === 403) {
        log.warn("autofollow", `pump.fun refused the follow write (${status}) — datacenter block or stale cookie; stopping this run`);
        break;
      }
    } catch (e) {
      log.warn("autofollow", `follow failed for ${r.username}: ${String(e).slice(0, 60)}`);
    }
    // gently: this is a residential-shaped action, not a firehose
    await new Promise((res) => setTimeout(res, 2_500 + Math.random() * 2_000));
  }
  if (out.ok) save();
  log.info(
    "autofollow",
    `run done: ${out.qualifying} qualify, ${out.alreadyFollowed} already followed, ${out.ok}/${out.attempted} new follows ok`,
  );
  return out;
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startAutoFollow(): void {
  if (!cfg.pumpAutoFollow) {
    log.info("autofollow", "off (PUMP_AUTO_FOLLOW)");
    return;
  }
  if (timer) return;
  timer = setInterval(() => void runAutoFollow().catch(() => {}), cfg.pumpAutoFollowH * 3_600_000);
  setTimeout(() => void runAutoFollow().catch(() => {}), 120_000);
  log.info("autofollow", `auto-follow LIVE — every ${cfg.pumpAutoFollowH}h, bars: h2>${cfg.callerFollowMinH2} med>=1.2 avg>=${cfg.callerDiscoveryAvg} calls>=${cfg.callerDiscoveryMinCalls}`);
}
