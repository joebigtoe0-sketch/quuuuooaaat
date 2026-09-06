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
  // The on-screen ticker for his OWN token. One place, because the 2026-08-18
  // Quant->Riku rename left a hardcoded "QUANT" on the desk's buyback row that
  // survived until someone read it on stream.
  ownSymbol: str("QUANT_OWN_SYMBOL", "RIKU"),

  // ---------- TELEGRAM: RikuBot, the caller tracker ----------
  // Separate identity from the userbot that talks in groups as Riku himself:
  // a Bot API bot can be added to any group by anyone (that is how the caller
  // network grows) and a bot posting cards all day is expected behaviour,
  // whereas a user account doing it reads as spam and risks the real account.
  tgEnabled: bool("TG_ENABLED", false),
  tgBotToken: str("TG_BOT_TOKEN"),
  // scoring (see telegram/calls.ts for why each term exists)
  tgScoreWindowDays: num("TG_SCORE_WINDOW_DAYS", 28), // rolling, so one lucky week cannot take a prize
  tgScoreShrinkK: num("TG_SCORE_SHRINK_K", 5), // pseudo-calls of population mean mixed into a thin record
  // ONE call must not carry a caller. Uncapped, a single 50x (log 3.9) put a
  // 2-call account above a caller with eight clean 3x — the same failure the
  // trade side already fixed with CALLER_FOLLOW_MED_CAP ("an 8x med over 5
  // calls is a pump farmer, not a target"). 10x and 50x credit identically.
  tgMaxCreditMult: num("TG_MAX_CREDIT_MULT", 10),
  // ranked below this, but never paid: a thin record is not a track record
  tgMinScoredCalls: num("TG_MIN_SCORED_CALLS", 8),
  tgGradeAfterMin: num("TG_GRADE_AFTER_MIN", 60), // a call younger than this has no outcome yet
  tgGradeWindowH: num("TG_GRADE_WINDOW_H", 168), // 7 days, then the grade is final
  // Entry floors, DEFAULT OFF (0). They were 8k/4k and that was wrong: a floor
  // excludes the call entirely, so a caller who finds a real gem at $5k gets no
  // credit for a 1000x — while also carrying no downside if it rugs. A free
  // option on exactly the early calls the board should reward.
  //
  // The obvious replacement (only credit a peak that carried real volume) was
  // tested and FAILED: $retard's manufactured 7.5x pump had $63,083 in its peak
  // candle against $1,605 for a genuine run. Wash volume is real volume.
  //
  // What actually deters manufacturing is the economics already in the scoring:
  // mean (not sum) so each fake must beat your own average, credit capped at
  // TG_MAX_CREDIT_MULT, TG_MIN_SCORED_CALLS before a prize, and a 28-day window
  // — you would have to pay for the impact eight times over to place. Set these
  // above 0 only if abuse actually shows up in the data.
  tgMinCallMcUsd: num("TG_MIN_CALL_MC_USD", 0),
  tgMinLiqUsd: num("TG_MIN_LIQ_USD", 0),
  // adds the Fresh/Cluster security row to the card — the best rug tell it has,
  // at ~10 Helius calls per card. A card fires on every CA anyone posts, so this
  // is OFF until you decide the credits are worth it.
  tgBubbleOnCard: bool("TG_BUBBLE_ON_CARD", false),
  // 🔍 grace: how long after posting a CA you can say "I was only looking" and
  // have it not count as your call. Short on purpose — any longer and it is a
  // button for deleting the calls that went wrong.
  tgScanGraceS: num("TG_SCAN_GRACE_S", 10),
  // monthly global callout competition — paid in $RIKU at the USD value below,
  // settled on the last day of the month
  tgPrize1Usd: num("TG_PRIZE_1_USD", 100),
  tgPrize2Usd: num("TG_PRIZE_2_USD", 50),
  tgPrize3Usd: num("TG_PRIZE_3_USD", 25),

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
  // ---------- PIPER: neural TTS in-process, $0/day ----------
  // Baked into the image by the Dockerfile. TTS_PROVIDER=piper puts it first in
  // the chain; it stays as the free floor under every other provider regardless.
  piperBin: str("PIPER_BIN", "/opt/piper/piper"),
  piperVoiceDir: str("PIPER_VOICE_DIR", "/opt/piper/voices"),
  piperVoice: str("PIPER_VOICE", "en_US-ryan-medium"), // riku
  piperVoiceAlt: str("PIPER_VOICE_ALT", "en_US-amy-medium"), // podcast guests
  piperLengthScale: num("PIPER_LENGTH_SCALE", 0.95), // <1 = faster delivery
  piperSentenceSilence: num("PIPER_SENTENCE_SILENCE", 0.25),
  piperTimeoutMs: num("PIPER_TIMEOUT_MS", 20_000),
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
  callerHarvestS: num("CALLER_HARVEST_S", 360),
  callerRefreshH: num("CALLER_REFRESH_H", 6),
  // callout discovery: the public firehose nominates coins called by callers
  // whose accumulated record clears the bar (research only — never a buy)
  callerDiscovery: bool("CALLER_DISCOVERY", true),
  callerDiscoveryS: num("CALLER_DISCOVERY_S", 480),
  callerDiscoveryAvg: num("CALLER_DISCOVERY_AVG", 1.5),
  // 8, not 3. A caller with three or four graded calls has no record — "50%
  // hit 2x" over four calls is two successes, indistinguishable from a coin
  // flip or from someone grading their own pumps. $retard (08-29) was followed
  // into a revival pump on a FOUR-call caller and cost 1.099 SOL. Production
  // already ran 8 via Railway; this makes the safe value survive that variable
  // being cleared, instead of silently falling back to 3 with no log line.
  callerDiscoveryMinCalls: num("CALLER_DISCOVERY_MIN_CALLS", 8),
  callerDiscoveryMaxPerDay: num("CALLER_DISCOVERY_MAX_PER_DAY", 8),
  // auto-follow qualifying callers on pump.fun so their calls reach the fast
  // feed — the follow list IS the discovery funnel (see callout/autofollow.ts)
  pumpAutoFollow: bool("PUMP_AUTO_FOLLOW", true),
  pumpAutoFollowH: num("PUMP_AUTO_FOLLOW_H", 6),
  // caller-follow: BUY when a graded caller with skin calls fresh and there's
  // still room to their median; EXIT when their wallet sells (on-chain watch)
  callerFollow: bool("CALLER_FOLLOW", true),
  callerFollowSol: num("CALLER_FOLLOW_SOL", 0.05), // FLOOR per follow-buy
  callerFollowPct: num("CALLER_FOLLOW_PCT", 8), // % of spendable SOL at baseline quality
  callerFollowRoom: num("CALLER_FOLLOW_ROOM", 2), // need med/premium ≥ this much upside left
  callerFollowMaxPerDay: num("CALLER_FOLLOW_MAX_PER_DAY", 6),
  callerFollowStopPct: num("CALLER_FOLLOW_STOP_PCT", 40), // full-position stop-loss %, pre-TP1 only
  // THE SCALE-OUT LADDER — every level is priced off OUR ENTRY mc, never the
  // caller's median. The median target sat 2-3x above entry by construction,
  // so anything that peaked below it paid nothing at all.
  // TP1 fires at the CALLER'S MEDIAN TARGET (call mc x their clamped median),
  // not a fixed multiple: it self-calibrates per caller, and a fixed +120% sat
  // above where this population actually peaks — the 08-27 winners topped out
  // at +102% and +71%, so a flat TP1 would have banked neither.
  callerFollowTp1MinPct: num("CALLER_FOLLOW_TP1_MIN_PCT", 25), // floor under the median target, vs OUR entry
  // ...and a CEILING, vs our entry. The median target is an absolute mc anchored
  // to the CALLER'S call price, so a deep-dip entry can leave it 3x+ away — far
  // more than the 1.5x move that caller typically makes. $PUMP (09-01) was
  // bought at $37.5k against a $117,090 target: 3.12x, never reached, -0.474
  // SOL. At a 2.5x cap the target is $93,750, which it held above for 7
  // straight 15s closes. Verified not to move DAC (2.02x) or 中国黑牛 (1.71x).
  callerFollowTp1MaxMult: num("CALLER_FOLLOW_TP1_MAX_MULT", 2.5),
  callerFollowTp1Fraction: num("CALLER_FOLLOW_TP1_FRACTION", 0.6), // share of the FULL bag sold at TP1
  callerFollowTp2Pct: num("CALLER_FOLLOW_TP2_PCT", 400), // +% on entry mc that fires TP2 (400 => 5x)
  callerFollowTp2Fraction: num("CALLER_FOLLOW_TP2_FRACTION", 0.9), // share of WHAT REMAINS sold at TP2
  callerFollowRunnerStopPct: num("CALLER_FOLLOW_RUNNER_STOP_PCT", 20), // stop % below the anchor mc
  // false: the stop anchors at TP1's mc and stays there, so the moonbag can
  // actually moon. true: TP2 drags it up to its own mc (locks 5x, kills the ride).
  callerFollowStopReanchor: bool("CALLER_FOLLOW_STOP_REANCHOR", false),
  callerFollowMaxSwarm: num("CALLER_FOLLOW_MAX_SWARM", 3), // >this many distinct callers in the window = coordinated pump, skip
  callerFollowSwarmWindowMin: num("CALLER_FOLLOW_SWARM_WINDOW_MIN", 10),
  callerFollowMaxFromFirstCall: num("CALLER_FOLLOW_MAX_FROM_FIRST_CALL", 1.4), // mcNow vs EARLIEST call's mc — later = the move already happened
  callerFollowMedCap: num("CALLER_FOLLOW_MED_CAP", 3), // clamp the median used in room/target math — an 8x med over 5 calls is a pump farmer, not a target
  callerFollowMinCallMc: num("CALLER_FOLLOW_MIN_CALL_MC", 10_000), // calls on sub-$10k coins are launch snipes wearing a caller costume
  callerFollowMinH2: num("CALLER_FOLLOW_MIN_H2", 27),
  // THE VERTICAL GATE — do not buy a candle that already went. $retard (08-29)
  // sat dead for 14h at ~$3k, got pumped 7.5x to $22,395 in ten minutes, a
  // caller stamped it near the top, and we bought the back half at $11,029.
  callerFollowMax1hPct: num("CALLER_FOLLOW_MAX_1H_PCT", 100), // it just doubled in an hour = we are the exit
  // REVIVAL: a hard spike that is still deep underwater on the day is a dead
  // chart being walked back up, not a coin finding demand.
  callerFollowRevival1hPct: num("CALLER_FOLLOW_REVIVAL_1H_PCT", 50),
  callerFollowRevival24hPct: num("CALLER_FOLLOW_REVIVAL_24H_PCT", -50), // caller must land 2x on >this % of graded calls — the 08-25 autopsy: losers followed 11-25% callers, winners 33-38%

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
  // "quiet" = NOT ONE message in the window (lurkers outnumber typers, so a
  // single message calls the room live), or nothing rendering at all. When
  // quiet: research runs less often and show writing drops to the cheap model.
  audienceSaver: bool("AUDIENCE_SAVER", true),
  audienceWindowMin: num("AUDIENCE_WINDOW_MIN", 30),
  quietResearchMult: num("QUIET_RESEARCH_MULT", 3), // research interval x this when quiet

  midcap: bool("MIDCAP", true),
  midcapTickMin: num("MIDCAP_TICK_MIN", 120),
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
  outreachTickMin: num("OUTREACH_TICK_MIN", 120),
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
  // X's read quota is metered in POSTS RETRIEVED, not requests. The mention
  // sweep asked for 25 every 20 min = 1,800 posts/day for an account that
  // never sees anywhere near that many mentions. 6 is the real ceiling.
  xMentionsMax: num("X_MENTIONS_MAX", 6),
  // reads that twexapi can serve go there instead of the official API — its
  // key is billed separately and does not touch the X developer quota
  xPreferTwexReads: bool("X_PREFER_TWEX_READS", true),
  // answering people who @ him: a hard-coded 10/day silently muted him for the
  // rest of every busy day. Real limit is X's 80-post rail.
  maxXRepliesPerDay: num("MAX_X_REPLIES_PER_DAY", 40),
  inboxPollS: num("INBOX_POLL_S", 60),

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
