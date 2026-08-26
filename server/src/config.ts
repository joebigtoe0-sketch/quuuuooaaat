import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Load the repo-root .env explicitly (one .env for the whole project), so it is
// found no matter what cwd the panel/npm spawns us with. Fall back to server/.env.
dotenv.config({ path: path.join(root, "..", ".env") });
dotenv.config({ path: path.join(root, ".env") });

const num = (k: string, def: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : def;
};
const str = (k: string, def = "") => process.env[k] ?? def;
const bool = (k: string, def: boolean) =>
  process.env[k] === undefined ? def : String(process.env[k]).toLowerCase() === "true";

// Ensure the runtime data dir exists and carries the seed intel files. On a
// fresh host (e.g. a Railway volume mounted over server/data) the volume starts
// empty — server/seed/* fills in creator stats + watchlists on first boot.
const dataDir = path.join(root, "data");
fs.mkdirSync(dataDir, { recursive: true });
const seedDir = path.join(root, "seed");
if (fs.existsSync(seedDir)) {
  // Intel exports (watchlists, creator stats) ALWAYS overwrite the volume copy
  // — they're read-only research data and a stale volume copy silently ignores
  // list updates (bit us: an updated prime list never reached Railway).
  // Everything else copies only when missing (runtime state lives there).
  const ALWAYS_FRESH = /^(dev_watchlist.*\.csv|creator_stats\.json|axiom_watchlist\.csv)$/;
  for (const f of fs.readdirSync(seedDir)) {
    const dst = path.join(dataDir, f);
    if (ALWAYS_FRESH.test(f) || !fs.existsSync(dst)) fs.copyFileSync(path.join(seedDir, f), dst);
  }
}

// GO LIVE state, read once at boot. The marker (written by the GO LIVE button)
// carries the pre-generated own-token mint and FORCES every dry-run switch off —
// launch day needs zero env edits. FORCE_DRY_RUN=true is the emergency brake
// that re-enables dry mode even while live.
const liveFilePath = path.join(dataDir, "LIVE");
const liveArmed = fs.existsSync(liveFilePath);
const liveMeta: { ownMint?: string } = (() => {
  try { return JSON.parse(fs.readFileSync(liveFilePath, "utf8")); } catch { return {}; }
})();
const forceDry = bool("FORCE_DRY_RUN", false);

export const cfg = {
  root,
  dataDir,
  audioDir: path.join(dataDir, "audio"),
  // Local: QUANT_PORT (8490) + loopback-only, so the LAN can't reach /admin.
  // On Railway (RAILWAY_ENVIRONMENT set): the injected PORT wins even if a
  // pasted .env carries QUANT_PORT, and we bind all interfaces for the proxy.
  port: process.env.RAILWAY_ENVIRONMENT
    ? num("PORT", num("QUANT_PORT", 8490))
    : num("QUANT_PORT", num("PORT", 8490)),
  host: str("HOST", process.env.RAILWAY_ENVIRONMENT ? "0.0.0.0" : "127.0.0.1"),

  // absolute default (server/data/wallet.json); a relative override resolves
  // against the repo root, never the (variable) spawn cwd.
  walletFile: (() => {
    const v = str("QUANT_WALLET_FILE");
    if (!v) return path.join(root, "data", "wallet.json");
    return path.isAbsolute(v) ? v : path.resolve(root, "..", v);
  })(),
  ownMint: str("QUANT_OWN_MINT") || String(liveMeta.ownMint ?? ""),

  heliusKey: str("HELIUS_API_KEY"),
  rpcUrl:
    str("RPC_URL") ||
    (str("HELIUS_API_KEY")
      ? `https://mainnet.helius-rpc.com/?api-key=${str("HELIUS_API_KEY")}`
      : "https://api.mainnet-beta.solana.com"),

  ccRefreshToken: str("QUANT_CC_REFRESH_TOKEN"),
  calloutDryRun: liveArmed ? forceDry : bool("CALLOUT_DRY_RUN", true),
  maxCalloutsPerDay: num("MAX_CALLOUTS_PER_DAY", 10),

  // TTS_PROVIDER: openai (best, reuses LLM key) | gtts (free, no key) | edge | none
  ttsProvider: str("TTS_PROVIDER", "openai"),
  ttsVoice: str("TTS_VOICE", "onyx"), // openai voices: onyx/echo/alloy/fable/nova/shimmer
  ttsRate: str("TTS_RATE", "+8%"), // edge only
  ttsPitch: str("TTS_PITCH", "-2Hz"), // edge only
  ttsOpenaiModel: str("TTS_OPENAI_MODEL", "gpt-4o-mini-tts"),
  ttsOpenaiSpeed: num("TTS_OPENAI_SPEED", 1.05),
  // TTS creds are SEPARATE from the LLM's (the brain may run on Anthropic,
  // which has no /audio/speech) — fall back to LLM_* for back-compat.
  ttsBaseUrl: str("TTS_BASE_URL", str("LLM_BASE_URL", "https://api.openai.com/v1")),
  ttsApiKey: str("TTS_API_KEY", str("LLM_API_KEY")),

  minSentUsd: num("MIN_SENT_USD", 1.2),
  // call gating by SENT SIZE (% of the 1B supply): below the minimum he
  // declines outright; big sends buy a better hearing; past autoCallPct the
  // call is automatic (hard scam-rejects still apply)
  minSentPct: num("MIN_SENT_PCT", 0.05), // 0.05% = 500k tokens
  autoCallPct: num("AUTO_CALL_PCT", 20),
  senderCooldownMin: num("SENDER_COOLDOWN_MIN", 10),
  conveyorPickMin: num("CONVEYOR_PICK_MIN", 5),
  // conveyor discovery only researches coins with at least this current mc —
  // skips dead/dumped launches instead of wasting the ceremony on a corpse.
  minResearchMcUsd: num("MIN_RESEARCH_MC_USD", 4000),
  // random checkups only pick coins at least this far along the bonding curve
  // (0.4 = 40% bonded; graduated = 1). Survivors, not corpses.
  minResearchProgress: num("MIN_RESEARCH_PROGRESS", 0.4),
  // a coin he already bought and EXITED is off the menu for this long —
  // no re-research, no re-buy. Blacklisted (scam/rug) coins are off forever.
  rebuyCooldownH: num("REBUY_COOLDOWN_H", 72),
  // ---------- decision records + on-chain pre-commitment ----------
  // every buy/sell/callout is hashed to a Solana memo BEFORE execution and the
  // plaintext published at /public/decisions — a track record nobody has to
  // trust us on. COMMIT_KINDS env narrows which kinds commit (default buy,sell,call).
  commitOnchain: bool("COMMIT_ONCHAIN", true),
  // ---------- caller intel (pump.fun callout reputation) ----------
  // background harvester: one coin's callout list per interval, ALWAYS yielding
  // to the posting path — reads must never starve the thing that earns.
  callerHarvestS: num("CALLER_HARVEST_S", 90),
  callerRefreshH: num("CALLER_REFRESH_H", 6),
  // callout discovery: the public firehose nominates coins called by callers
  // whose accumulated record clears the bar (research only — never a buy)
  callerDiscovery: bool("CALLER_DISCOVERY", true),
  callerDiscoveryS: num("CALLER_DISCOVERY_S", 120),
  callerDiscoveryAvg: num("CALLER_DISCOVERY_AVG", 1.5),
  callerDiscoveryMinCalls: num("CALLER_DISCOVERY_MIN_CALLS", 3),
  callerDiscoveryMaxPerDay: num("CALLER_DISCOVERY_MAX_PER_DAY", 8),
  // caller-follow: BUY when a graded caller with skin calls fresh and there's
  // still room to their median; EXIT when their wallet sells (on-chain watch)
  callerFollow: bool("CALLER_FOLLOW", true),
  callerFollowSol: num("CALLER_FOLLOW_SOL", 0.05), // FLOOR per follow-buy
  callerFollowPct: num("CALLER_FOLLOW_PCT", 8), // % of spendable SOL at baseline quality
  callerFollowRoom: num("CALLER_FOLLOW_ROOM", 2), // need med/premium ≥ this much upside left
  callerFollowMaxPerDay: num("CALLER_FOLLOW_MAX_PER_DAY", 6),
  callerFollowStopPct: num("CALLER_FOLLOW_STOP_PCT", 40), // full-position stop-loss %
  callerFollowTpFraction: num("CALLER_FOLLOW_TP_FRACTION", 0.75), // sold at the median target
  callerFollowRunnerStopPct: num("CALLER_FOLLOW_RUNNER_STOP_PCT", 15), // runner stop below the TP price
  callerFollowMaxSwarm: num("CALLER_FOLLOW_MAX_SWARM", 3), // >this many distinct callers in the window = coordinated pump, skip
  callerFollowSwarmWindowMin: num("CALLER_FOLLOW_SWARM_WINDOW_MIN", 10),
  callerFollowMaxFromFirstCall: num("CALLER_FOLLOW_MAX_FROM_FIRST_CALL", 1.4), // mcNow vs EARLIEST call's mc — later = the move already happened
  callerFollowMedCap: num("CALLER_FOLLOW_MED_CAP", 3), // clamp the median used in room/target math — an 8x med over 5 calls is a pump farmer, not a target
  callerFollowMinCallMc: num("CALLER_FOLLOW_MIN_CALL_MC", 10_000), // calls on sub-$10k coins are launch snipes wearing a caller costume
  callerFollowMinH2: num("CALLER_FOLLOW_MIN_H2", 27), // caller must land 2x on >this % of graded calls — the 08-25 autopsy: losers followed 11-25% callers, winners 33-38%

  // ---- midcap: the investment book — omo-inspired mid-cap buys, NO auto-exits ----
  // ---- podcast (RIKUPOD) ----
  podcastWarmupSec: num("PODCAST_WARMUP_SEC", 90), // conversation is written this far ahead before anything airs
  podcastPrestartSec: num("PODCAST_PRESTART_SEC", 120), // let RIKU finish whatever he is doing before the show takes the stage

  // STUDIO MODE: a film set, not a show. Silences every autonomous behaviour
  // (research, discovery, replies, kol, commentary, coding, planner, trading)
  // so filming and podcasts own the stage. Local default for shoot sessions.
  studioMode: bool("STUDIO_MODE", false),

  // ---- audience saver: a quiet room costs less to run ----
  // There is NO real viewer count (pump.fun's socket carries only chat), so
  // "quiet" = fewer than N distinct chatters in the window, or nothing
  // rendering at all. When quiet: research runs less often and show writing
  // drops to the cheap model.
  audienceSaver: bool("AUDIENCE_SAVER", true),
  audienceWindowMin: num("AUDIENCE_WINDOW_MIN", 30),
  audienceQuietChatters: num("AUDIENCE_QUIET_CHATTERS", 5),
  quietResearchMult: num("QUIET_RESEARCH_MULT", 3), // research interval x this when quiet

  midcap: bool("MIDCAP", true),
  midcapTickMin: num("MIDCAP_TICK_MIN", 30),
  midcapSol: num("MIDCAP_SOL", 0.05), // FLOOR per buy
  midcapPct: num("MIDCAP_PCT", 5), // % of spendable at conviction 5/5
  midcapMaxPerDay: num("MIDCAP_MAX_PER_DAY", 2),
  midcapMinConviction: num("MIDCAP_MIN_CONVICTION", 4),
  midcapMinLiqUsd: num("MIDCAP_MIN_LIQ_USD", 40_000),
  midcapMinVol24Usd: num("MIDCAP_MIN_VOL24_USD", 150_000),
  midcapMinAgeHours: num("MIDCAP_MIN_AGE_HOURS", 6),
  midcapCooldownDays: num("MIDCAP_COOLDOWN_DAYS", 3),

  // ---- outreach: find small crypto accounts, draft replies, producer approves ----
  outreach: bool("OUTREACH", true), // discovery only — sends ALWAYS need approval
  outreachTickMin: num("OUTREACH_TICK_MIN", 30),
  outreachMinFollowers: num("OUTREACH_MIN_FOLLOWERS", 200),
  outreachMaxFollowers: num("OUTREACH_MAX_FOLLOWERS", 5000),
  outreachMaxSendsPerHour: num("OUTREACH_MAX_SENDS_PER_HOUR", 2),
  outreachDedupeDays: num("OUTREACH_DEDUPE_DAYS", 7),
  // ---------- dev-sniper (the quiet edge; the show never names it) ----------
  // instant entries on launches from PROVEN devs while mc is still under the
  // ceiling; exit at 95% bonding or after maxHold. Sizing follows his own book
  // (0.05 min .. 6% of wallet). The stream sees an organic launch-feed find.
  devsnipeEnabled: bool("DEVSNIPE_ENABLED", false),
  devsnipeMaxMcUsd: num("DEVSNIPE_MAX_MC_USD", 7000),
  // archive criteria calibrated to the SAME bar as the curated watchlist —
  // its members run ~0.23 bond-rate; 0.5 was fantasy and matched nobody
  devsnipeMinBondRate: num("DEVSNIPE_MIN_BOND_RATE", 0.2),
  devsnipeMinLaunches: num("DEVSNIPE_MIN_LAUNCHES", 5),
  // prime-only: snipe ONLY the prime list (the money bot's EXACT 40 wallets,
  // operator-supplied). Broad mode (watchlist/archive/live criteria) proved it
  // buys junk the bot never touches — prime-only is the rule now.
  devsnipePrimeOnly: bool("DEVSNIPE_PRIME_ONLY", true),
  devsnipeMaxOpen: num("DEVSNIPE_MAX_OPEN", 10),
  devsnipeExitProgress: num("DEVSNIPE_EXIT_PROGRESS", 0.95),
  devsnipeMaxHoldH: num("DEVSNIPE_MAX_HOLD_H", 6),
  devsnipeRevealDelayMs: num("DEVSNIPE_REVEAL_DELAY_MS", 150_000),
  // if a staged-discovery entry is already this far under water by reveal time,
  // he grades it honestly and NEVER mentions holding it (no bragging on a dud).
  revealMaxDrawdownPct: num("REVEAL_MAX_DRAWDOWN_PCT", 40),
  commentaryMin: num("COMMENTARY_MIN", 9),
  codingMin: num("CODING_MIN", 22), // idle filler: he "works on" one of his own tools at the terminal
  // timeline sessions (read KOL posts on camera + reply). Floor, not a ceiling —
  // the agent can also choose engage_kols any time.
  kolFeedMin: num("KOL_FEED_MIN", 35),
  // answering people who @ him is the highest-value engagement there is —
  // never leave it to the planner alone. Floor, not a ceiling.
  replyXMin: num("REPLY_X_MIN", 20),
  // answering people who @ him: a hard-coded 10/day silently muted him for the
  // rest of every busy day. Real limit is X's 80-post rail.
  maxXRepliesPerDay: num("MAX_X_REPLIES_PER_DAY", 40),
  inboxPollS: num("INBOX_POLL_S", 15),

  floatSol: num("FLOAT_SOL", 0.05),
  minBuybackSol: num("MIN_BUYBACK_SOL", 0.02),
  maxBuybackSolPerTx: num("MAX_BUYBACK_SOL_PER_TX", 0.5),
  maxBuybackSolPerDay: num("MAX_BUYBACK_SOL_PER_DAY", 2),
  buybackPollS: num("BUYBACK_POLL_S", 300),

  // ---------- agent v2 ----------
  agentEnabled: bool("AGENT_ENABLED", true),
  // outside brain owns public words; timer checkups (conveyor/commentary) still run
  playbackProducer: bool("PLAYBACK_PRODUCER", false),
  planMin: num("AGENT_PLAN_MIN", 12),
  tradeDryRun: liveArmed ? forceDry : bool("TRADE_DRY_RUN", true),
  paperStartSol: num("PAPER_START_SOL", 1.0), // paper-trading starting bankroll
  adminPassword: str("ADMIN_PASSWORD", "quant2026"), // /admin panel + control endpoints
  // autonomous buying from research/gifts. false = the wallet only moves on
  // dev-launch snipes and operator calls; research stays pure content (paper
  // calls, roasts, watchlist). He narrates it as his own discipline.
  autonomousBuys: bool("AUTONOMOUS_BUYS", false),
  maxTradeSol: num("MAX_TRADE_SOL", 0.1),
  // gross buys per day (sells recycle SOL back, so this is turnover, not risk).
  // 0.5 starved the desk once the sniper went live — one busy morning ate it.
  maxDailyTradeSol: num("MAX_DAILY_TRADE_SOL", 5),
  maxOpenPositions: num("MAX_OPEN_POSITIONS", 9999), // no practical cap — the daily SOL caps are the real rail
  tradeReserveSol: num("TRADE_RESERVE_SOL", 0.3), // SOL kept for trading, buybacks don't sweep it
  // airdrops: distribution of his own held tokens to holders (never sells)
  airdropDryRun: liveArmed ? forceDry : bool("AIRDROP_DRY_RUN", true),
  maxAirdropPctPerDay: num("MAX_AIRDROP_PCT_PER_DAY", 5),
  // posting rhythm: 10-30 originals per day, spaced; replies are exempt
  maxTweetsPerDay: num("MAX_TWEETS_PER_DAY", 48),
  minTweetsPerDay: num("MIN_TWEETS_PER_DAY", 22),
  minTweetGapMin: num("MIN_TWEET_GAP_MIN", 11),
  filmEnabled: bool("FILM_ENABLED", true),
  clipsDir: path.join(root, "data", "clips"),

  // ---------- simulation (dress rehearsal) ----------
  // SIM_MODE fakes every external surface as SUCCESSFUL (X posts, callouts,
  // buybacks, own-token market) so the agent believes it is live, and
  // compresses time by SIM_SPEED. Nothing leaves the machine.
  // Once the LIVE marker exists (GO LIVE button), sim mode is HARD-DISABLED —
  // a leftover SIM_MODE=true in .env can never fake-post a live agent.
  simMode: bool("SIM_MODE", false) && !liveArmed,
  simSpeed: Math.max(1, num("SIM_SPEED", 10)),
  simOwnSupplyPct: num("SIM_OWN_SUPPLY_PCT", 2),
};

/** Scale a real-time duration for sim mode (10x sim → waits are 10x shorter). */
export const simT = (ms: number): number => (cfg.simMode ? Math.max(15, ms / cfg.simSpeed) : ms);

/** The LIVE marker: written by GO LIVE, survives every restart and update. */
export const LIVE_FILE = path.join(root, "data", "LIVE");
export const isLive = (): boolean => fs.existsSync(LIVE_FILE);
