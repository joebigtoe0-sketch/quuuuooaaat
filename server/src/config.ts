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
  for (const f of fs.readdirSync(seedDir)) {
    const dst = path.join(dataDir, f);
    if (!fs.existsSync(dst)) fs.copyFileSync(path.join(seedDir, f), dst);
  }
}

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
  ownMint: str("QUANT_OWN_MINT"),

  heliusKey: str("HELIUS_API_KEY"),
  rpcUrl:
    str("RPC_URL") ||
    (str("HELIUS_API_KEY")
      ? `https://mainnet.helius-rpc.com/?api-key=${str("HELIUS_API_KEY")}`
      : "https://api.mainnet-beta.solana.com"),

  ccRefreshToken: str("QUANT_CC_REFRESH_TOKEN"),
  calloutDryRun: bool("CALLOUT_DRY_RUN", true),
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
  commentaryMin: num("COMMENTARY_MIN", 9),
  inboxPollS: num("INBOX_POLL_S", 15),

  floatSol: num("FLOAT_SOL", 0.05),
  minBuybackSol: num("MIN_BUYBACK_SOL", 0.02),
  maxBuybackSolPerTx: num("MAX_BUYBACK_SOL_PER_TX", 0.5),
  maxBuybackSolPerDay: num("MAX_BUYBACK_SOL_PER_DAY", 2),
  buybackPollS: num("BUYBACK_POLL_S", 300),

  // ---------- agent v2 ----------
  agentEnabled: bool("AGENT_ENABLED", true),
  planMin: num("AGENT_PLAN_MIN", 12),
  tradeDryRun: bool("TRADE_DRY_RUN", true),
  paperStartSol: num("PAPER_START_SOL", 1.0), // paper-trading starting bankroll
  adminPassword: str("ADMIN_PASSWORD", "quant2026"), // /admin panel + control endpoints
  maxTradeSol: num("MAX_TRADE_SOL", 0.1),
  maxDailyTradeSol: num("MAX_DAILY_TRADE_SOL", 0.5),
  maxOpenPositions: num("MAX_OPEN_POSITIONS", 9999), // no practical cap — the daily SOL caps are the real rail
  tradeReserveSol: num("TRADE_RESERVE_SOL", 0.3), // SOL kept for trading, buybacks don't sweep it
  // airdrops: distribution of his own held tokens to holders (never sells)
  airdropDryRun: bool("AIRDROP_DRY_RUN", true),
  maxAirdropPctPerDay: num("MAX_AIRDROP_PCT_PER_DAY", 5),
  // posting rhythm: 10-30 originals per day, spaced; replies are exempt
  maxTweetsPerDay: num("MAX_TWEETS_PER_DAY", 30),
  minTweetsPerDay: num("MIN_TWEETS_PER_DAY", 10),
  minTweetGapMin: num("MIN_TWEET_GAP_MIN", 25),
  filmEnabled: bool("FILM_ENABLED", true),
  clipsDir: path.join(root, "data", "clips"),

  // ---------- simulation (dress rehearsal) ----------
  // SIM_MODE fakes every external surface as SUCCESSFUL (X posts, callouts,
  // buybacks, own-token market) so the agent believes it is live, and
  // compresses time by SIM_SPEED. Nothing leaves the machine.
  // Once the LIVE marker exists (GO LIVE button), sim mode is HARD-DISABLED —
  // a leftover SIM_MODE=true in .env can never fake-post a live agent.
  simMode: bool("SIM_MODE", false) && !fs.existsSync(path.join(root, "data", "LIVE")),
  simSpeed: Math.max(1, num("SIM_SPEED", 10)),
  simOwnSupplyPct: num("SIM_OWN_SUPPLY_PCT", 2),
};

/** Scale a real-time duration for sim mode (10x sim → waits are 10x shorter). */
export const simT = (ms: number): number => (cfg.simMode ? Math.max(15, ms / cfg.simSpeed) : ms);

/** The LIVE marker: written by GO LIVE, survives every restart and update. */
export const LIVE_FILE = path.join(root, "data", "LIVE");
export const isLive = (): boolean => fs.existsSync(LIVE_FILE);
