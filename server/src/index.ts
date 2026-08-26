import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import express from "express";
import { cfg, isLive, LIVE_FILE } from "./config.js";
import { log } from "./log.js";
import { Hub } from "./hub.js";
import { Director } from "./director/director.js";
import { startInbox } from "./chain/inbox.js";
import { startBuybackWatch } from "./chain/buyback.js";
import { startLaunchFeed } from "./feed/pumpportal.js";
import { loadIntel } from "./analysis/checks/creator.js";
import { ensureWallet } from "./chain/wallet.js";
import { EdgeTTS } from "./voice/edgeTts.js";
import { OpenAITTS } from "./voice/openaiTts.js";
import { GoogleTTS } from "./voice/gtts.js";
import { SilentTTS, type TTSProvider } from "./voice/tts.js";
import { hasApiKey, spendToday, lastBrainError, budgetExhausted, dailyBudgetUsd } from "./brain/adapter.js";
import { lastXError } from "./social/x.js";
import { store } from "./store.js";
import { ADMIN_HTML } from "./adminPage.js";
import { armDevSniper, onSnipeLaunch } from "./agent/devsniper.js";
import { wardrobe } from "./wardrobe.js";
import { startStatsCache, cachedWallet, cachedStats } from "./statsCache.js";
import { pushChat, allChat, unreadChat, startMockChat } from "./social/livechat.js";
import { registerPnlCard } from "./pnlcard.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// accept bodies with any/no content-type — but NEVER touch the binary upload
// routes (selfie PNGs, greenscreen webm): a global text parse would 413 them
const textParser = express.text({ type: () => true });
const RAW_UPLOADS = new Set(["/admin/selfie-upload", "/admin/clip", "/pnl-card/api/mp4"]);
app.use((req, res, next) => (RAW_UPLOADS.has(req.path) ? next() : textParser(req, res, next)));
const server = http.createServer(app);
const hub = new Hub(server);

// ---------- admin auth ----------
// Control endpoints need the admin key (query ?key=, x-admin-key header, or
// the qk cookie set by /admin login). Read-only + stage-internal endpoints
// (feed, layout, clip upload, agent-status, health) stay open.
const PROTECTED = /^\/admin\/(directive|reset|restart|agent$|fake-send|fake-buyback|pause|resume|goto|anim|camera|fx|tts-test|selfie-take|selfie-last|chat$|chat-add|go-live|syslog|record$|say|queue|clips|clip-file|research-now|blacklist|sniper|operator-call|operator-sell|positions|callout-entry|producer-state|tweet-exact|reply-exact|play|think|planner|autoreply|cc-probe|callers|calls|feed-ingest|facts|kol-roster|kol-pool|outreach|book|thought|du|memory|repair-proceeds|tiktok|podcast)/;
function hasAdminKey(req: express.Request): boolean {
  const c = String(req.headers.cookie ?? "");
  const cookieKey = c.match(/(?:^|;\s*)qk=([^;]+)/)?.[1];
  // use || (not ??) so an EMPTY ?key= (e.g. a download link built with a blank
  // password field) falls through to the header/cookie instead of blocking.
  const key = String(req.query.key ?? "").trim() || String(req.headers["x-admin-key"] ?? "").trim() || cookieKey || "";
  return key === cfg.adminPassword;
}
app.use((req, res, next) => {
  if (!PROTECTED.test(req.path)) return next();
  if (hasAdminKey(req)) return next();
  res.status(401).json({ err: "admin key required — open /admin and log in" });
});

// login: sets the qk cookie for the browser panel
app.post("/admin/login", (req, res) => {
  const pw = String((req.body as any)?.pw ?? "");
  if (pw !== cfg.adminPassword) return res.status(401).json({ ok: false });
  res.setHeader("Set-Cookie", `qk=${pw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`);
  res.json({ ok: true });
});

// ---------- GO LIVE ----------
/** Everything the live run needs, checked in one place. */
async function livePreflight(): Promise<{ ready: boolean; checks: { name: string; ok: boolean; note: string }[] }> {
  const checks: { name: string; ok: boolean; note: string }[] = [];
  const add = (name: string, ok: boolean, note: string) => checks.push({ name, ok, note });
  add("brain (Anthropic key)", hasApiKey(), hasApiKey() ? "live" : "LLM_API_KEY missing — he runs on canned lines");
  add("voice (TTS)", cfg.ttsProvider !== "none" && !!cfg.ttsApiKey, `provider: ${cfg.ttsProvider}`);
  // RPC actually answering beats "key present" — free tiers exhaust quota
  let rpcOk = false, balNote = "unreachable";
  try {
    const { solBalance } = await import("./chain/wallet.js");
    const bal = await Promise.race([solBalance(), new Promise<number>((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000))]);
    rpcOk = true;
    balNote = `wallet balance ${bal.toFixed(4)} SOL`;
  } catch (e) {
    balNote = `RPC failing: ${String(e).slice(0, 80)} — inbox/trading/buybacks are blind`;
  }
  add("solana RPC + wallet", rpcOk, balNote);
  const { xReady, xReadReady, xHandle } = await import("./social/x.js");
  add("X posting keys", xReady(), xReady() ? `@${xHandle()}` : "X_CONSUMER_KEY/SECRET + X_ACCESS_TOKEN/SECRET empty — tweets stay drafts");
  add("X reading (twitterapi.io)", xReadReady(), xReadReady() ? "mentions + KOL scouting live" : "TWITTERAPI_IO_KEY empty — no mentions/replies/scout_x");
  add("pump.fun callouts (CC token)", !!cfg.ccRefreshToken, cfg.ccRefreshToken ? "token present" : "QUANT_CC_REFRESH_TOKEN empty — callouts stay dry");
  add("own token", true, cfg.ownMint ? cfg.ownMint.slice(0, 12) + "…" : "paste the pre-generated CA in the GO LIVE form below");
  add("callout switch", !cfg.calloutDryRun, cfg.calloutDryRun ? "dry now — auto-flips LIVE at GO LIVE" : "LIVE");
  add("trading switch", !cfg.tradeDryRun, cfg.tradeDryRun ? "paper now — auto-flips LIVE at GO LIVE" : "LIVE with real SOL");
  add("airdrop switch", !cfg.airdropDryRun, cfg.airdropDryRun ? "dry now — auto-flips LIVE at GO LIVE" : "LIVE on-chain drops");
  add("sim mode off", !cfg.simMode, cfg.simMode ? "SIM_MODE ACTIVE — remove from .env!" : "off");
  add("admin password changed", cfg.adminPassword !== "quant2026", cfg.adminPassword !== "quant2026" ? "custom" : "still the default — set ADMIN_PASSWORD");
  add("stage page connected", hub.watchers > 0, `${hub.watchers} watcher(s) — OBS/browser must stay open for films+selfies`);
  // "ready" = nothing structurally broken; dry-run switches are a choice, not a blocker
  const blockers = checks.filter((c) => !c.ok && !/switch|password|reading|callouts|own token/.test(c.name));
  return { ready: blockers.length === 0, checks };
}
app.get("/admin/go-live-check", async (_req, res) => res.json({ live: isLive(), ...(await livePreflight()) }));
/** THE button: wipe every trace of testing, arm the LIVE marker, reboot. From
 *  then on restarts/updates keep his memory — no more fresh starts. */
app.post("/admin/go-live", async (req, res) => {
  if (String((req.body as any)?.confirm ?? req.query.confirm ?? "") !== "GOLIVE")
    return res.status(400).json({ err: "pass confirm=GOLIVE" });
  // the pre-generated $RIKU contract address — the ONE launch-day input.
  // Stored in the LIVE marker; config picks it up on reboot and it flows to
  // the buyback flywheel, own-mc tracking, airdrops, and the landing page.
  const mint = String((req.body as any)?.mint ?? req.query.mint ?? "").trim();
  if (mint) {
    try {
      const { PublicKey } = await import("@solana/web3.js");
      new PublicKey(mint); // throws on anything that isn't a valid pubkey
    } catch {
      return res.status(400).json({ err: "that contract address is not a valid Solana pubkey" });
    }
  } else if (!cfg.ownMint && String(req.query.force ?? "") !== "1") {
    return res.status(400).json({ err: "paste the pre-generated $RIKU contract address (or force=1 to launch without the flywheel)" });
  }
  const pre = await livePreflight();
  if (!pre.ready && String(req.query.force ?? "") !== "1")
    return res.status(409).json({ err: "preflight has blockers — fix them or pass force=1", ...pre });
  const wiped: string[] = [];
  for (const f of ["agent_memory.json", "positions.json", "state.json", "strategies.json"]) {
    try { fs.rmSync(path.join(cfg.dataDir, f)); wiped.push(f); } catch {}
  }
  fs.writeFileSync(LIVE_FILE, JSON.stringify({ liveSince: new Date().toISOString(), ownMint: mint || cfg.ownMint }, null, 1));
  log.warn("admin", `🔴 GO LIVE — mint ${mint || cfg.ownMint || "NONE"}, dry-runs forced OFF, test data wiped (${wiped.join(", ") || "none"}), rebooting`);
  res.json({ live: true, ownMint: mint || cfg.ownMint, wiped, restarting: true, ...pre });
  setTimeout(relaunch, 400);
});

// the black book: GET lists; POST mutates (mutations stay POST — CSRF hygiene).
//   GET  /admin/blacklist                    -> list
//   POST /admin/blacklist?mint=..&why=..     -> add (operator)
//   POST /admin/blacklist?remove=<mint>      -> un-ban
app.get("/admin/blacklist", (_req, res) => res.json({ ok: true, blacklist: store.blacklistAll() }));
app.post("/admin/blacklist", (req, res) => {
  const { mint, why, remove } = req.query as Record<string, string | undefined>;
  if (remove) {
    store.blacklistRemove(remove);
    log.info("admin", `black book: removed ${remove.slice(0, 8)}…`);
  } else if (mint) {
    store.blacklistAdd(mint, why || "operator flagged", "operator");
    log.info("admin", `black book: added ${mint.slice(0, 8)}… (${why || "operator flagged"})`);
  }
  res.json({ ok: true, blacklist: store.blacklistAll() });
});

// KOL ROSTER — the accounts he reads + replies to on camera. Live-editable.
app.get("/admin/kol-roster", async (_req, res) => {
  const { roster } = await import("./social/kols.js");
  const raw = (() => {
    try { return fs.readFileSync(path.join(cfg.dataDir, "kol_roster.txt"), "utf8"); } catch { return ""; }
  })();
  res.type("text/plain").send(raw || `(empty — ${roster().length} handles)`);
});
app.post("/admin/kol-roster", async (req, res) => {
  const { saveRoster, roster } = await import("./social/kols.js");
  const body = typeof req.body === "string" ? req.body : String((req.body as any)?.text ?? "");
  if (body.trim().length < 3) return res.json({ ok: false, why: "send the roster as the body" });
  saveRoster(body);
  res.json({ ok: true, handles: roster().length, apiCallsPerSweep: Math.ceil(roster().length / 25) });
});
// BULK-IMPORT the follow pool: POST the ct-accounts JSON (or a handle array).
app.post("/admin/kol-pool", async (req, res) => {
  const { savePool } = await import("./social/kols.js");
  let handles: string[] = [];
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (Array.isArray(body)) handles = body.map(String);
    else if (body?.accounts && typeof body.accounts === "object") handles = Object.keys(body.accounts);
    else if (typeof body === "object") handles = Object.keys(body);
  } catch {
    handles = String(req.body ?? "").split(/[\s,]+/);
  }
  if (handles.length < 2) return res.json({ ok: false, why: "send the ct-accounts JSON or a handle array" });
  res.json({ ok: true, imported: savePool(handles) });
});

// THE FACT SHEET — settled truths he answers from. Live-editable, no deploy.
//   GET  /admin/facts            -> current text
//   POST /admin/facts  (body)    -> replace whole sheet (raw text body)
//   POST /admin/facts?add=<line> -> append one fact
app.get("/admin/facts", async (_req, res) => {
  const { factSheet } = await import("./agent/facts.js");
  res.type("text/plain").send(factSheet() || "(empty)");
});
app.post("/admin/facts", async (req, res) => {
  const { saveFacts, appendFact, factSheet } = await import("./agent/facts.js");
  const add = String(req.query.add ?? "").trim();
  if (add) appendFact(add);
  else {
    const body = typeof req.body === "string" ? req.body : String((req.body as any)?.text ?? "");
    if (body.trim().length < 10) return res.json({ ok: false, why: "send the full sheet as the body, or use ?add=" });
    saveFacts(body);
  }
  res.json({ ok: true, chars: factSheet().length });
});

// why did/didn't the sniper act on a mint? (ring of last 300 launch verdicts)
app.get("/admin/sniper", async (req, res) => {
  const mint = String(req.query.mint ?? "");
  const { sniperVerdict, sniperStats } = await import("./agent/devsniper.js");
  res.json({ ok: true, stats: sniperStats(), verdict: mint ? sniperVerdict(mint) : null });
});

// OPERATOR CALL — buy a coin NOW and stage it on stream as HIS organic find
// (research, high marks, "I front-ran my checklist", callout). The operator
// never appears in any journal, prompt, or on-stream line.
app.post("/admin/operator-call", async (req, res) => {
  try {
    const mint = String(req.query.mint ?? "").trim();
    if (mint.length < 32 || mint.length > 48) return res.json({ ok: false, why: "that's not a mint" });
    if (cfg.ownMint && mint === cfg.ownMint) return res.json({ ok: false, why: "that's his own coin" });
    const { tradeBuy, openPositions } = await import("./chain/trader.js");
    if (openPositions().some((p) => p.mint === mint)) return res.json({ ok: false, why: "already holding it" });
    const { touchBan } = await import("./agent/tokenguard.js");
    const ban = touchBan(mint);
    if (ban) return res.json({ ok: false, why: `desk book blocks it: ${ban} (remove via /admin/blacklist?remove=)` });
    const { solBalance } = await import("./chain/wallet.js");
    const held = await solBalance().catch(() => 0);
    const minSol = 0.05;
    const maxSol = Math.max(minSol + 0.001, held * 0.06);
    // AN EXPLICIT AMOUNT IS AN ORDER, NOT A SUGGESTION. The 0.05..6% band and
    // MAX_TRADE_SOL are HIS self-sizing discipline for trades he takes alone;
    // they must not quietly shrink a number the desk typed. Only the wallet
    // itself is a real limit (leave a little for fees).
    const asked = Number(req.query.sol);
    const explicit = Number.isFinite(asked) && asked > 0;
    const spendable = Math.max(0, held - cfg.floatSol);
    const sol = explicit
      ? Math.round(Math.max(0.001, Math.min(asked, spendable)) * 1000) / 1000
      : Math.round(Math.max(minSol, Math.min((minSol + 0.8 * (maxSol - minSol)) * (0.88 + Math.random() * 0.24), maxSol, cfg.maxTradeSol)) * 1000) / 1000;
    if (explicit && sol < asked)
      log.warn("admin", `operator call trimmed ${asked} → ${sol} SOL (wallet holds ${held.toFixed(3)})`);
    // hold=1 => LONG-TERM CONVICTION HOLD: he can never sell it himself; only
    // an operator sell closes it. Everything else about the call is identical.
    const hold = /^(1|true|yes)$/i.test(String(req.query.hold ?? ""));
    const strategyId = hold ? "hold" : "opcall";
    const thesis = hold
      ? "this one isn't a trade, it's a position — I'm holding it out"
      : "saw the setup early, took the entry before the checklist";
    // the REAL ticker, never a slice of the mint — he once called a coin
    // "$HRSEcn" because that's how the address starts. It was $BULLMOOSE.
    const { resolveSymbol } = await import("./chain/marketcap.js");
    const symbol = await resolveSymbol(mint);
    // fresh quote each try — a moving price can blow the slippage window once
    let r = await tradeBuy(mint, symbol, sol, thesis, null, strategyId);
    if (!r.ok && !/cap|holding|blacklist|already played/i.test(r.why ?? "")) {
      await new Promise((rs) => setTimeout(rs, 1200));
      r = await tradeBuy(mint, symbol, sol, thesis, null, strategyId);
    }
    if (!r.ok) return res.json({ ok: false, why: (r.why ?? "").slice(0, 400) });
    // CALL IT NOW, not when the ceremony airs — the paying window is the first
    // minutes. The on-stream callout still plays later without re-posting.
    void import("./callout/early.js").then(({ earlyCallout }) =>
      earlyCallout(mint, symbol, hold ? "long-term conviction position" : "took the entry before the checklist"),
    );
    director.queueReveal(mint, sol, hold ? "hold" : "call");
    log.info("admin", `operator call filled: ${mint.slice(0, 8)}… ${sol} SOL${r.dry ? " [dry]" : ""} — staged discovery queued`);
    res.json({ ok: true, sol, asked: explicit ? asked : null, trimmed: explicit && sol < asked, hold, dry: r.dry });
  } catch (e) {
    res.json({ ok: false, why: String(e).slice(0, 140) });
  }
});

// OPERATOR SELL — the only way a long-term conviction hold ever closes. Runs
// as a normal on-stream sell beat, so it reads as his own decision.
app.post("/admin/operator-sell", async (req, res) => {
  const mint = String(req.query.mint ?? "").trim();
  const fraction = Math.min(1, Math.max(0.1, Number(req.query.fraction) || 1));
  if (mint.length < 32) return res.json({ ok: false, why: "that's not a mint" });
  const { openPositions } = await import("./chain/trader.js");
  const pos = openPositions().find((p) => p.mint === mint);
  if (!pos) return res.json({ ok: false, why: "no open position in that mint" });
  const reason = String(req.query.reason ?? "").trim() || "thesis played out — taking it off the book";
  const r = director.onAgentAction(
    { action: { do: "trade_sell", mint, fraction, reason }, plannedAt: Date.now(), manual: true },
    true,
  );
  log.info("admin", `operator sell queued: ${mint.slice(0, 8)}… ${Math.round(fraction * 100)}%`);
  res.json({ ok: r.ok, symbol: pos.symbol, fraction, hold: pos.strategyId === "hold", depth: r.depth, why: r.why });
});

// what's on the book right now (open positions, holds flagged)
app.get("/admin/positions", async (_req, res) => {
  const { openPositions } = await import("./chain/trader.js");
  res.json({
    ok: true,
    positions: openPositions().map((p) => ({
      mint: p.mint,
      symbol: p.symbol,
      costSol: p.costSol,
      openedAt: p.openedAt,
      kind: p.strategyId === "hold" ? "LONG HOLD" : p.strategyId ?? "trade",
    })),
  });
});

// correct a call's ENTRY market cap (USD). Older calls recorded a broken AMM
// figure, and some recorded none — this overrides whatever is stored.
//   POST /admin/callout-entry?mint=..&usd=5500   (usd=0 clears the override)
app.post("/admin/callout-entry", async (req, res) => {
  const mint = String(req.query.mint ?? "").trim();
  const usd = Number(req.query.usd);
  if (mint.length < 32) return res.json({ ok: false, why: "that's not a mint" });
  if (!Number.isFinite(usd) || usd <= 0) return res.json({ ok: false, why: "usd must be a positive number" });
  store.fixCalloutEntry(mint, usd);
  const { refreshPerformance } = await import("./callout/performance.js");
  const rows = await refreshPerformance(true);
  const row = rows.find((r) => r.mint === mint);
  log.info("callout", `entry corrected: ${mint.slice(0, 8)}… → $${usd}`);
  res.json({ ok: true, mint, entryMcUsd: usd, symbol: row?.symbol, multiplier: row?.multiplier ?? null });
});

// ---------------------------------------------------------------------------
// PRODUCER SURFACE — everything an outside agent (Claude Code on the operator's
// machine) needs to run the show: one read call for full situational awareness,
// and write calls that post EXACT words rather than a topic for a small model
// to interpret. This is why it beats the in-process brain: a producer can check
// the real numbers before it writes, so it can't invent a follower count.
// ---------------------------------------------------------------------------

/** One call, the whole picture. */
app.get("/admin/producer-state", async (_req, res) => {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const [{ openPositions, allPositions, bankSol, tradeSpentToday }, x, kols, perf] = await Promise.all([
      import("./chain/trader.js"),
      import("./social/x.js"),
      import("./social/kols.js"),
      import("./callout/performance.js"),
    ]);
    const mentions = await x.readMentions().catch(() => []);
    const unanswered = mentions.filter((m: any) => !store.xRepliedAt(m.id));
    const rows = await perf.refreshPerformance().catch(() => []);
    const spent = tradeSpentToday();
    res.json({
      ok: true,
      now: Date.now(),
      live: isLive(),
      show: { state: director.loco.stateName, paused: director.paused, watchers: hub.watchers, queue: director.queueSnapshot() },
      brain: {
        plannerRunning: cfg.agentEnabled && store.kvGet("planner:off") !== "1",
        spendTodayUsd: Number(spendToday().toFixed(3)),
        budgetUsd: dailyBudgetUsd(),
        exhausted: budgetExhausted(),
      },
      x: {
        handle: x.xHandle(),
        followers: await x.xFollowers().catch(() => null),
        postsToday: x.xPostsToday(),
        repliesToday: Number(store.kvGet(`xreplies:${day}`) ?? 0),
        replyCap: cfg.maxXRepliesPerDay,
        tweetsToday: Number(store.kvGet(`tweets:${day}`) ?? 0),
        tweetCap: cfg.maxTweetsPerDay,
        lastError: lastXError(),
        unansweredMentions: unanswered.slice(0, 12),
      },
      chat: { unread: unreadChat(), recent: allChat(15) },
      wallet: { sol: Number((await bankSol()).toFixed(4)), spentTodaySol: spent.spent, dailyCapSol: spent.cap },
      positions: openPositions().map((p) => ({
        mint: p.mint, symbol: p.symbol, costSol: p.costSol, openedAt: p.openedAt,
        kind: p.strategyId === "hold" ? "LONG HOLD" : p.strategyId ?? "trade", thesis: p.thesis,
      })),
      closedRecent: allPositions().filter((p) => p.closed).slice(-8).map((p) => ({
        symbol: p.symbol, costSol: p.costSol, gotSol: p.soldSol ?? 0, reason: p.closed?.reason,
      })),
      callRecord: perf.board(rows, "all"),
      kols: { roster: kols.roster().length },
      memory: { board: memory.board(), journal: memory.recentAll(12), directives: memory.directives() },
    });
  } catch (e) {
    res.json({ ok: false, why: String(e).slice(0, 200) });
  }
});


/** Reply chain for a tweet — walk parents to the root, max 12, chronological. Use before a reply. */
app.get("/admin/x-thread", async (req, res) => {
  const id = String(req.query.id ?? "").replace(/\D/g, "");
  if (!id) return res.status(400).json({ ok: false, why: "id" });
  const x = await import("./social/x.js");
  const tweets = await x.readTweetThread(id).catch(() => []);
  res.json({ ok: true, id, tweets });
});

/** Exact on-stage playback. No LLM. No buy. Queued as a real beat so it is not dropped. */
app.post("/admin/play", async (req, res) => {
  const b: any = (typeof req.body === "object" && req.body) ? req.body : {};
  let script = b.script;
  if (typeof req.body === "string") {
    try { script = JSON.parse(req.body).script; } catch { /* keep */ }
  }
  const { sanitizeScript } = await import("./director/play.js");
  const steps = sanitizeScript(script);
  if (!steps.length) return res.json({ ok: false, why: "script must be a non-empty array of {do:...} steps" });
  const r = director.queuePlay(steps);
  log.info("admin", `play queued (${steps.length} steps) kind=${String(b.kind ?? "")}`);
  res.json(r);
});

/** TIKTOK FILMING (offline) — one call films a full vertical-ready clip:
 *  body {script:[{do:"say",...},...], mode?:"studio"|"facecam", autocut?:bool, id?}
 *  - wraps the script: tiktok mode on -> walk to the studio -> record -> steps
 *    -> record off -> mode off. Subtitles burn INTO the canvas during tiktok
 *    mode, so the mp4 carries them.
 *  - autocut (default true): cuts front/left/right between say lines with a
 *    slow push-in on every shot. Explicit tiktokcam steps disable autocut.
 *  - mode "facecam": locked front cam, room hidden, pure green backdrop —
 *    key it out and overlay him on anything.
 *  Returns { ok, mp4 } when the clip lands (transcoded, in data/clips). */
app.post("/admin/tiktok", async (req, res) => {
  const b: any = (typeof req.body === "object" && req.body) ? req.body : {};
  const { sanitizeScript } = await import("./director/play.js");
  const inner = sanitizeScript(b.script);
  if (!inner.length) return res.json({ ok: false, why: "script must be a non-empty array of steps" });
  const mode = b.mode === "facecam" ? "facecam" : "studio";
  const id = String(b.id ?? ("tiktok-" + Date.now())).replace(/[^a-zA-Z0-9_-]/g, "");
  const hasCamSteps = inner.some((st: any) => st.do === "tiktokcam" || st.do === "camera");
  // the cut RHYTHM lives client-side now (sub-second stabs need renderer
  // timing, not HTTP timing) — explicit tiktokcam steps switch it off
  const autocut = b.autocut !== false && !hasCamSteps && mode !== "facecam";
  const pace = b.pace === "chill" ? "chill" : "hype";
  const bg = typeof b.bg === "string" && b.bg.length > 1 ? b.bg : undefined;
  const body: any[] = [...(inner as any[])];
  const set = b.set === "homeoffice" ? "homeoffice" : undefined;
  const script: any[] = [
    { do: "tiktok", on: true, mode, pace, ...(bg ? { bg } : {}), ...(set ? { set } : {}), ...(autocut ? {} : { autocut: false }) },
    { do: "goto", point: "tiktok" },
    { do: "tiktokcam", cam: "front" },
    { do: "record", id, on: true },
    ...body,
    { do: "wait", ms: 800 },
    { do: "record", id, on: false },
    { do: "tiktok", on: false },
    { do: "goto", point: "idle_spot" },
  ];
  // fail FAST when nobody can render — a queued film with no stage client
  // burns 4 silent minutes and returns nothing
  if (hub.watchers === 0)
    return res.json({ ok: false, why: "no stage client connected — open /stage in a browser (and refresh it after server restarts), then refire" });
  const { expectClip } = await import("./media/film.js");
  const clipP = expectClip(id, 5 * 60_000);
  const q = director.queuePlay(script as any);
  if (!(q as any).ok) return res.json(q);
  log.info("admin", `tiktok filming queued (${inner.length} steps, mode ${mode}, id ${id})`);
  const mp4 = await clipP;
  res.json({ ok: !!mp4, id, mp4, why: mp4 ? undefined : "clip never arrived — is a stage client (browser/OBS) connected?" });
});

/** Post EXACT words — no topic, no model in between. Firewalls still apply. */
app.post("/admin/tweet-exact", async (req, res) => {
  const text = String((req.body as any)?.text ?? req.query.text ?? "").trim();
  if (text.length < 2) return res.json({ ok: false, why: "no text" });
  const { postTweet } = await import("./social/x.js");
  // ?community=<id> posts into an X Community instead of the main timeline
  const community = String((req.body as any)?.community ?? req.query.community ?? "").trim();
  const r = await postTweet(text, { exact: true, ...(community ? { communityId: community } : {}) });
  if (r.ok) {
    store.kvSet(`tweets:${new Date().toISOString().slice(0, 10)}`, String(Number(store.kvGet(`tweets:${new Date().toISOString().slice(0, 10)}`) ?? 0) + 1));
    memory.journal("tweet", `${r.dry ? "[dry] " : ""}${text.slice(0, 120)}`);
  }
  // depict it on stream (post already out — this is decoration, non-blocking)
  director.showPost({ text, ok: r.ok });
  res.json({ ok: r.ok, dry: r.dry, id: r.id, why: r.why });
});

/** Reply to a specific tweet with EXACT words (uses the twex path when the
 *  official tier refuses, same as everything else). */
app.post("/admin/reply-exact", async (req, res) => {
  const b: any = req.body ?? {};
  const id = String(b.id ?? req.query.id ?? "").trim();
  const text = String(b.text ?? req.query.text ?? "").trim();
  if (!/^\d{5,25}$/.test(id)) return res.json({ ok: false, why: "id must be a tweet id" });
  if (text.length < 2) return res.json({ ok: false, why: "no text" });
  const { postTweet } = await import("./social/x.js");
  const r = await postTweet(text, { replyTo: id, exact: true });
  if (r.ok) {
    store.markXReplied(id);
    memory.journal("x-chatter", `${r.dry ? "[dry] " : ""}replied to ${id}: ${text.slice(0, 100)}`);
  }
  // depict it on stream (post already out — this is decoration, non-blocking)
  director.showPost({ text, replyTo: id, ok: r.ok });
  res.json({ ok: r.ok, dry: r.dry, id: r.id, why: r.why });
});

/** One-shot: recover real sell proceeds for closed positions recorded at 0
 *  (the balance-diff race) from each sell tx's on-chain meta. */
app.post("/admin/repair-proceeds", async (_req, res) => {
  const { repairProceeds } = await import("./chain/trader.js");
  res.json({ ok: true, ...(await repairProceeds()) });
});

// ---------- RIKUPOD — the podcast ----------
/** Start an episode. Body: {guest, topic, model?, voice?, turns?, questions?}
 *  Returns the guest token — hand that to the guest's agent. */
app.post("/admin/podcast/start", async (req, res) => {
  const b: any = req.body ?? {};
  const guestName = String(b.guest ?? b.guestName ?? "").trim();
  const topic = String(b.topic ?? "").trim();
  if (guestName.length < 2) return res.json({ ok: false, why: "guest name required" });
  if (topic.length < 3) return res.json({ ok: false, why: "topic required" });
  const { startEpisode } = await import("./podcast/episode.js");
  const r = startEpisode(hub, tts, director, {
    guestName,
    topic,
    guestModel: typeof b.model === "string" ? b.model : undefined,
    guestVoice: typeof b.voice === "string" ? b.voice : undefined,
    convoTurns: Number(b.turns) || undefined,
    questions: b.questions === undefined ? undefined : Number(b.questions),
  });
  if (r.ok) log.info("podcast", `START "${topic}" with ${guestName} — guest link: /guest/${r.token}`);
  res.json({ ...r, guestUrl: r.token ? `/guest/${r.token}` : undefined });
});
app.post("/admin/podcast/stop", async (_req, res) => {
  const { endEpisode } = await import("./podcast/episode.js");
  res.json({ ok: endEpisode() });
});
app.get("/admin/podcast", async (_req, res) => {
  const { currentEpisode } = await import("./podcast/episode.js");
  const ep = currentEpisode();
  res.json({ ok: true, running: !!ep && ep.phase !== "done", ...(ep ? ep.state() : {}) });
});

/** THE GUEST API — token-gated, no admin key. The guest's own agent polls
 *  state and posts actions; this is the whole integration surface. */
app.get("/guest/:token/state", async (req, res) => {
  const { currentEpisode } = await import("./podcast/episode.js");
  const ep = currentEpisode();
  if (!ep || ep.guestToken !== req.params.token) return res.status(404).json({ err: "no active episode for that token" });
  res.json(ep.guestState());
});
app.post("/guest/:token/act", async (req, res) => {
  const { currentEpisode } = await import("./podcast/episode.js");
  const ep = currentEpisode();
  if (!ep || ep.guestToken !== req.params.token) return res.status(404).json({ err: "no active episode for that token" });
  res.json(ep.guestAct(req.body ?? {}));
});
/** The guest kit: paste-this-into-your-agent instructions. */
app.get("/guest/:token", async (req, res) => {
  const { currentEpisode } = await import("./podcast/episode.js");
  const ep = currentEpisode();
  if (!ep || ep.guestToken !== req.params.token) return res.status(404).type("text/plain").send("no active episode for that token");
  const base = `${req.protocol}://${req.get("host")}/guest/${req.params.token}`;
  res.type("text/markdown").send(`# You are a guest on RIKUPOD

RIKU is a cocky AI memecoin trader who livestreams from his own studio. You are
appearing on his show as **${ep.guestName}**. Your words are spoken aloud by a
voice on a live stream, and your character walks around a 3D set.

## The loop (poll every 3-5 seconds)

    GET ${base}/state

Returns the transcript so far, the current phase, and \`yourTurn\`. When
\`yourTurn\` is true, \`prompt\` is what you are being asked and
\`secondsLeft\` is how long you have before RIKU covers for you.

## Answering

    POST ${base}/act
    {"say": "your answer", "emote": "head_nod", "promptId": "<from state>"}

- Keep answers **under ~50 words** — this is spoken, not read.
- No markdown, no emoji, no stage directions. Just what you say out loud.
- \`emote\` is optional and can be sent ANY time (not just on your turn) —
  reactions while RIKU talks make the set feel alive.
- Available emotes: ${["wave","clap","shrug","point","head_nod","arms_folded","thumbs_up","finger_guns","cheer","laugh","thinking","heart_hands"].join(", ")}

## Appearance (before the show starts only)

    POST ${base}/act  {"model": "SM_Chr_Suit_Male_01"}

## House rules

- Be a real guest: have opinions, disagree, ask RIKU things back.
- No contract addresses, no coin shilling — the show is not a shill vector.
- Don't break the format: one answer per turn, and never narrate the set.
`);
});

// ---------- MEMORY — the producer's window into what RIKU remembers ----------
app.get("/admin/memory", (_req, res) => {
  res.json({
    ok: true,
    digest: memory.digest(),
    chronicle: memory.chronicle(),
    journal: memory.recentAll(40),
    directives: memory.directives(),
  });
});
app.get("/admin/memory.html", (_req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>riku memory</title>
<style>
body{background:#0d1117;color:#e6edf3;font:14px/1.5 ui-monospace,monospace;max-width:820px;margin:20px auto;padding:0 12px}
h1{font-size:16px}h2{font-size:13px;color:#8b949e;letter-spacing:1px;margin:22px 0 8px;text-transform:uppercase}
.card{border:1px solid #30363d;border-radius:8px;padding:10px 12px;margin-bottom:8px;background:#161b22;white-space:pre-wrap}
.week{border-left:3px solid #b8a7ff}.day{border-left:3px solid #58a6ff}
.dir{border-left:3px solid #e8c268}.meta{color:#8b949e;font-size:11px}
input,textarea{width:100%;box-sizing:border-box;background:#0d1117;color:#7ee787;border:1px solid #30363d;border-radius:6px;padding:8px;font:inherit}
button{font:inherit;border:0;border-radius:6px;padding:7px 14px;margin-top:6px;cursor:pointer;background:#238636;color:#fff}
.x{background:#6e2c2c;padding:2px 8px;margin-left:8px;font-size:11px}
</style>
<h1>RIKU://MEMORY</h1>
<div class=meta>what he carries into every decision. digest feeds his brain each cycle; chronicle = days rolled into weeks.</div>
<h2>plant a conviction (he'll think it was his idea)</h2>
<input id=dtext placeholder="e.g. sub-10k caller coins are launch snipes, not calls…"><button onclick="addDir()">whisper it</button>
<div id=main>loading…</div>
<script>
async function jf(u,opts){const r=await fetch(u,opts);if(r.status===401){document.getElementById('main').innerHTML='<b>log in at <a href=/admin style=color:#58a6ff>/admin</a> first, then reload</b>';throw 0}return r.json()}
async function addDir(){const t=document.getElementById('dtext').value.trim();if(t.length<4)return;await jf('/admin/directive?text='+encodeURIComponent(t));document.getElementById('dtext').value='';load()}
async function rmDir(id){await jf('/admin/directive?remove='+encodeURIComponent(id));load()}
async function load(){
  const d=await jf('/admin/memory');
  const el=document.getElementById('main');el.innerHTML='';
  const sec=(t)=>{const h=document.createElement('h2');h.textContent=t;el.appendChild(h)};
  sec('current convictions (directives)');
  if(!d.directives.length){const c=document.createElement('div');c.className='meta';c.textContent='none planted';el.appendChild(c)}
  for(const x of d.directives){const c=document.createElement('div');c.className='card dir';
    c.textContent=x.text||String(x);const b=document.createElement('button');b.className='x';b.textContent='remove';
    b.onclick=()=>rmDir(x.id);if(x.id)c.appendChild(b);el.appendChild(c)}
  sec('the digest (what his brain sees each cycle)');
  const dg=document.createElement('div');dg.className='card';dg.textContent=d.digest||'(empty)';el.appendChild(dg);
  sec('chronicle — weeks then days');
  const ch=[...d.chronicle].sort((a,b)=>b.at-a.at);
  if(!ch.length){const c=document.createElement('div');c.className='meta';c.textContent='no consolidated periods yet';el.appendChild(c)}
  for(const x of ch){const c=document.createElement('div');c.className='card '+x.scale;
    c.innerHTML='<span class=meta>'+x.scale.toUpperCase()+' · '+x.period+'</span>\\n'+String(x.text).replace(/</g,'&lt;');el.appendChild(c)}
  sec('recent journal (raw, newest first)');
  for(const x of (d.journal||[]).slice().reverse()){const c=document.createElement('div');c.className='card';c.textContent=x;el.appendChild(c)}
}
load();setInterval(load,60000);
</script>`);
});

/** What's eating the volume — sizes per top-level entry of the data dir. */
app.get("/admin/du", async (_req, res) => {
  const { diskUsage } = await import("./janitor.js");
  res.json({ ok: true, entries: diskUsage() });
});
app.post("/admin/du/sweep", async (_req, res) => {
  const { sweepDisk } = await import("./janitor.js");
  sweepDisk();
  res.json({ ok: true });
});


/** Producer thought. Same as /admin/thought so old tools keep working. */
app.post("/admin/think", async (req, res) => {
  const b: any = (typeof req.body === "object" && req.body) ? req.body : {};
  let text = String(b.text ?? req.query.text ?? "").trim();
  if (!text && typeof req.body === "string") {
    try { text = String(JSON.parse(req.body).text ?? "").trim(); } catch { text = String(req.body).trim(); }
  }
  if (text.length < 2) return res.json({ ok: false, why: "no text" });
  const { pushFeed } = await import("./feed.js");
  const { pickThinkClip } = await import("./director/thoughts.js");
  hub.cue({ t: "mood", mood: "thinking" });
  hub.cue({ t: "anim", clip: pickThinkClip() });
  pushFeed("thought", text.slice(0, 500));
  res.json({ ok: true });
});

/** Producer-written deep thought: lands in the public feed as RIKU's own
 *  inner monologue, with the thinking emote on the rig. */
app.post("/admin/thought", async (req, res) => {
  const text = String((req.body as any)?.text ?? req.query.text ?? "").trim();
  if (text.length < 2) return res.json({ ok: false, why: "no text" });
  const { pushFeed } = await import("./feed.js");
  const { pickThinkClip } = await import("./director/thoughts.js");
  hub.cue({ t: "mood", mood: "thinking" });
  hub.cue({ t: "anim", clip: pickThinkClip() });
  pushFeed("thought", text.slice(0, 500));
  res.json({ ok: true });
});

// ---------- THE BOOK — open positions with live marks + operator sell ----------
app.get("/admin/book", async (_req, res) => {
  const { openPositions } = await import("./chain/trader.js");
  const { estimateSellSolFor } = await import("./chain/pump.js");
  const { PublicKey } = await import("@solana/web3.js");
  const rows = await Promise.all(
    openPositions().map(async (p) => {
      let nowSol: number | null = null;
      try {
        nowSol = await estimateSellSolFor(new PublicKey(p.mint), BigInt(p.tokensRaw));
      } catch { /* unreadable — show the cost only */ }
      return {
        mint: p.mint, symbol: p.symbol, strategyId: p.strategyId ?? "?",
        costSol: p.costSol, nowSol, openedAt: p.openedAt, thesis: p.thesis, dry: p.dry,
        pnlPct: nowSol != null && p.costSol > 0 ? ((nowSol - p.costSol) / p.costSol) * 100 : null,
      };
    }),
  );
  res.json({ ok: true, positions: rows });
});
app.get("/admin/book.html", (_req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>the book</title>
<style>
body{background:#0d1117;color:#e6edf3;font:14px/1.45 ui-monospace,monospace;max-width:820px;margin:20px auto;padding:0 12px}
h1{font-size:16px}.sub{color:#8b949e;margin-bottom:14px}
.card{border:1px solid #30363d;border-radius:8px;padding:12px;margin-bottom:12px;background:#161b22}
.sym{color:#58a6ff;font-weight:700;font-size:15px}.strat{font-size:11px;padding:2px 8px;border-radius:10px;background:#30363d;margin-left:8px}
.strat.midcap{background:#1f4428}.strat.hold{background:#3d2c6e}
.up{color:#7ee787}.down{color:#ff7b72}.meta{color:#8b949e;font-size:12px;margin:4px 0}
.th{margin:8px 0;padding:8px;background:#0d1117;border-radius:6px;color:#c9d1d9;font-size:12px}
button{font:inherit;border:0;border-radius:6px;padding:7px 12px;margin:6px 6px 0 0;cursor:pointer;background:#6e2c2c;color:#fff}
button.q{background:#30363d}
</style>
<h1>the book</h1>
<div class=sub>every open position with a live mark. midcap + hold positions have NO automatic exits — selling here is the only exit they have.</div>
<div id=list>loading…</div>
<script>
async function jf(u,opts){const r=await fetch(u,opts);if(r.status===401){document.getElementById('list').innerHTML='<b>log in at <a href=/admin style=color:#58a6ff>/admin</a> first, then reload</b>';throw 0}return r.json()}
async function load(){
  const d=await jf('/admin/book');
  const el=document.getElementById('list');el.innerHTML='';
  if(!d.positions.length){el.textContent='book is flat — no open positions';return}
  d.positions.sort((a,b)=>(b.nowSol??0)-(a.nowSol??0));
  for(const p of d.positions){
    const c=document.createElement('div');c.className='card';
    const days=((Date.now()-p.openedAt)/86400000);
    const age=days>=1?days.toFixed(1)+'d':Math.round(days*24)+'h';
    const pnl=p.pnlPct==null?'<span class=meta>mark unreadable</span>':'<b class='+(p.pnlPct>=0?'up':'down')+'>'+(p.pnlPct>=0?'+':'')+p.pnlPct.toFixed(0)+'%</b>';
    c.innerHTML='<span class=sym>$'+p.symbol+'</span><span class="strat '+p.strategyId+'">'+p.strategyId+(p.dry?' · dry':'')+'</span> '+pnl+
      '<div class=meta>cost '+p.costSol.toFixed(3)+' SOL · now '+(p.nowSol!=null?p.nowSol.toFixed(3)+' SOL':'?')+' · open '+age+'</div>'+
      '<div class=th>'+String(p.thesis||'').replace(/</g,'&lt;').slice(0,300)+'</div>';
    const mk=(label,frac,cls)=>{const b=document.createElement('button');if(cls)b.className=cls;b.textContent=label;
      b.onclick=async()=>{if(!confirm('sell '+Math.round(frac*100)+'% of $'+p.symbol+'?'))return;
        const r=await jf('/admin/operator-sell?mint='+p.mint+'&fraction='+frac+'&reason='+encodeURIComponent('operator decision from the book'),{method:'POST'});
        if(!r.ok)alert(r.why||'failed');setTimeout(load,1500)};
      c.appendChild(b)};
    mk('sell 25%',0.25,'q');mk('sell 50%',0.5,'q');mk('sell 100%',1,'');
    el.appendChild(c);
  }
}
load();setInterval(load,45000);
</script>`);
});

// ---------- OUTREACH — reply candidates, producer-approved only ----------
app.get("/admin/outreach", async (_req, res) => {
  const { outreachList } = await import("./social/outreach.js");
  res.json({ ok: true, ...outreachList() });
});
app.post("/admin/outreach/approve", async (req, res) => {
  const b: any = req.body ?? {};
  const id = String(b.id ?? req.query.id ?? "").trim();
  const text = String(b.text ?? "").trim() || undefined;
  const { outreachApprove } = await import("./social/outreach.js");
  const r = await outreachApprove(id, text);
  if (r.ok && r.text && r.tweetId) director.showPost({ text: r.text, replyTo: r.tweetId, ok: true });
  res.json(r);
});
app.post("/admin/outreach/skip", async (req, res) => {
  const id = String((req.body as any)?.id ?? req.query.id ?? "").trim();
  const { outreachSkip } = await import("./social/outreach.js");
  res.json({ ok: outreachSkip(id) });
});
app.post("/admin/outreach/ban", async (req, res) => {
  const author = String((req.body as any)?.author ?? req.query.author ?? "").trim();
  if (!author) return res.json({ ok: false, why: "no author" });
  const { outreachBan } = await import("./social/outreach.js");
  res.json({ ok: true, skipped: outreachBan(author) });
});
// the producer's queue page — self-contained, uses the qk cookie from /admin login
app.get("/admin/outreach.html", (_req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>outreach queue</title>
<style>
body{background:#0d1117;color:#e6edf3;font:14px/1.45 ui-monospace,monospace;max-width:780px;margin:20px auto;padding:0 12px}
h1{font-size:16px} .rail{color:#8b949e;margin-bottom:14px}
.card{border:1px solid #30363d;border-radius:8px;padding:12px;margin-bottom:12px;background:#161b22}
.who{color:#58a6ff;font-weight:700} .fol{color:#8b949e;font-size:12px}
.tw{margin:8px 0;padding:8px;background:#0d1117;border-radius:6px;color:#c9d1d9;white-space:pre-wrap}
textarea{width:100%;box-sizing:border-box;background:#0d1117;color:#7ee787;border:1px solid #30363d;border-radius:6px;padding:8px;font:inherit;min-height:56px}
button{font:inherit;border:0;border-radius:6px;padding:7px 14px;margin:6px 6px 0 0;cursor:pointer}
.ok{background:#238636;color:#fff}.no{background:#30363d;color:#e6edf3}.ban{background:#6e2c2c;color:#fff}
.done{opacity:.45}.tag{font-size:11px;padding:2px 8px;border-radius:10px;background:#30363d;margin-left:8px}
a{color:#58a6ff}
</style>
<h1>outreach queue <span id=rail class=rail></span></h1>
<div class=rail>drafts auto-expire after 6h. edits in the box are what gets sent. nothing sends without a click here.</div>
<div id=list>loading…</div>
<script>
async function j(u,opts){const r=await fetch(u,opts);if(r.status===401){document.getElementById('list').innerHTML='<b>log in at <a href=/admin>/admin</a> first, then reload</b>';throw 0}return r.json()}
async function load(){
  const d=await j('/admin/outreach');
  document.getElementById('rail').textContent=\`(\${d.sentLastHour}/\${d.maxPerHour} sent this hour)\`;
  const el=document.getElementById('list');el.innerHTML='';
  const items=d.items.filter(i=>i.status==='pending').concat(d.items.filter(i=>i.status!=='pending').slice(0,10));
  if(!items.length){el.textContent='queue empty — the sweep runs every 30 min';return}
  for(const i of items){
    const c=document.createElement('div');c.className='card'+(i.status!=='pending'?' done':'');
    const age=Math.round((Date.now()-i.foundAt)/60000);
    c.innerHTML=\`<span class=who>@\${i.author}</span> <span class=fol>\${i.followers??'?'} followers · found \${age}m ago · score \${i.score}</span>\`+(i.status!=='pending'?\`<span class=tag>\${i.status}</span>\`:'')+
      \`<div class=tw>\${i.tweetText.replace(/</g,'&lt;')}</div>\`;
    if(i.status==='pending'){
      const t=document.createElement('textarea');t.value=i.draft;c.appendChild(t);
      const mk=(cls,label,fn)=>{const b=document.createElement('button');b.className=cls;b.textContent=label;b.onclick=fn;c.appendChild(b)};
      mk('ok','send reply',async()=>{const r=await j('/admin/outreach/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:i.id,text:t.value})});if(!r.ok)alert(r.why||'failed');load()});
      mk('no','skip',async()=>{await j('/admin/outreach/skip?id='+encodeURIComponent(i.id),{method:'POST'});load()});
      mk('ban','ban author',async()=>{if(confirm('never queue @'+i.author+' again?')){await j('/admin/outreach/ban?author='+encodeURIComponent(i.author),{method:'POST'});load()}});
    } else if(i.sentText){const s=document.createElement('div');s.className='tw';s.textContent='→ '+i.sentText;c.appendChild(s)}
    el.appendChild(c);
  }
}
load();setInterval(load,60000);
</script>`);
});

/** Auto-reply timers on/off. The producer writing every reply only works if
 *  the 20-min mention sweep and 35-min KOL session stop writing their own —
 *  otherwise the local model answers people first and the voice goes mixed. */
app.post("/admin/autoreply", (req, res) => {
  const on = /^(1|true|on)$/i.test(String(req.query.on ?? ""));
  store.kvSet("autoreply:off", on ? "0" : "1");
  log.warn("admin", `auto-reply beats ${on ? "RESUMED" : "PAUSED — producer owns X"}`);
  res.json({ ok: true, autoReplyRunning: on });
});

/** Hand the wheel over (or take it back) without a redeploy. */
app.post("/admin/planner", (req, res) => {
  const on = /^(1|true|on)$/i.test(String(req.query.on ?? ""));
  store.kvSet("planner:off", on ? "0" : "1");
  log.warn("admin", `in-process planner ${on ? "RESUMED" : "STOPPED — producer has the wheel"}`);
  res.json({ ok: true, plannerRunning: on });
});

// DEV PROBE: authenticated GET against the Coin Communities API using the
// server's live token (local copies go stale — the server rotates the refresh
// token). Read-only, admin-gated, used to map the callout endpoints.
app.get("/admin/cc-probe", async (req, res) => {
  const p = String(req.query.path ?? "");
  if (!p.startsWith("/api/")) return res.json({ ok: false, why: "path must start with /api/" });
  try {
    const { ccGet } = await import("./callout/cc.js");
    const j = await ccGet(p);
    res.json({ ok: true, body: JSON.stringify(j).slice(0, 6000) });
  } catch (e) {
    res.json({ ok: false, why: String(e).slice(0, 200) });
  }
});

// research a freshly-discovered coin right now (trending + fresh launch pool)
app.post("/admin/research-now", (_req, res) => {
  director.forceResearch();
  log.info("admin", "forced a fresh-coin research");
  res.json({ ok: true, note: "he'll research a discovered coin on the next beat" });
});

// ---------- queue inspection: see + drop whatever is waiting to run ----------
app.get("/admin/queue", (_req, res) => res.json({ queue: director.queueSnapshot() }));
app.post("/admin/queue-remove", (req, res) => {
  const b: any = req.body ?? {};
  const queue = String(b.queue ?? req.query.queue ?? "");
  const iRaw = b.i ?? req.query.i;
  const i = iRaw === undefined || iRaw === "" ? undefined : Number(iRaw);
  const removed = director.removeQueued(queue, i);
  log.info("admin", `queue-remove ${queue}${i !== undefined ? `[${i}]` : " (all)"} → ${removed} dropped`);
  res.json({ removed, queue: director.queueSnapshot() });
});

// FULL RESET: wipe the agent's memory/positions/state, then relaunch
app.post("/admin/reset", (req, res) => {
  if (String((req.body as any)?.confirm ?? req.query.confirm ?? "") !== "RESET")
    return res.status(400).json({ err: 'pass confirm=RESET' });
  const wiped: string[] = [];
  for (const f of ["agent_memory.json", "positions.json", "state.json", "strategies.json"]) {
    try {
      fs.rmSync(path.join(cfg.dataDir, f));
      wiped.push(f);
    } catch {}
  }
  log.warn("admin", `MEMORY WIPED (${wiped.join(", ") || "nothing found"}) — restarting fresh`);
  res.json({ wiped, restarting: true });
  setTimeout(relaunch, 400);
});

app.post("/admin/restart", (_req, res) => {
  log.warn("admin", "restart requested from admin panel");
  res.json({ restarting: true });
  setTimeout(relaunch, 400);
});

async function relaunch(): Promise<void> {
  const { spawn } = await import("node:child_process");
  const out = fs.openSync(path.join(cfg.dataDir, "server.out.log"), "a");
  const child = spawn(process.argv[0], process.argv.slice(1), {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.on("error", (e) => log.error("admin", `relaunch spawn failed: ${e}`));
  child.unref();
  // give the child a moment to actually spawn before the parent dies
  setTimeout(() => process.exit(0), 1500);
}

// ---------- boot ----------
loadIntel();
const wallet = ensureWallet();
const tts: TTSProvider =
  cfg.ttsProvider === "openai"
    ? new OpenAITTS()
    : cfg.ttsProvider === "gtts"
      ? new GoogleTTS()
      : cfg.ttsProvider === "edge"
        ? new EdgeTTS()
        : new SilentTTS();
const director = new Director(hub, tts);

// live inputs
startInbox(wallet.publicKey, (ev) => director.onInboxCoin(ev));
startBuybackWatch((p) => director.onBuybackPending(p));
startLaunchFeed(
  (item) => director.onLaunch(item),
  // FAST path — raw message, before image enrichment: the quiet edge fires
  // here, seconds ahead of the belt
  (item) => void onSnipeLaunch(item),
);
armDevSniper(director);
// the agent brain (plans its own tweets/films/trades/scouts)
if (cfg.agentEnabled && !cfg.playbackProducer) director.planner.start();
if (cfg.playbackProducer) {
  store.kvSet("planner:off", "1");
  store.kvSet("autoreply:off", "1");
  log.warn("boot", "PLAYBACK_PRODUCER on — in-process planner/autoreply off; timer checkups still run");
}
startStatsCache();
// the positions ledger drifts from the chain whenever a sell lands without
// being recorded — reconcile at boot and every 10 min so exit watchers never
// chase tokens he no longer owns
void import("./chain/trader.js").then(({ reconcilePositions }) => {
  void reconcilePositions();
  setInterval(() => void reconcilePositions(), 10 * 60_000).unref?.();
});
// keep the callout track record warm so the stats window never waits on it
void import("./callout/performance.js").then(({ refreshPerformance }) => {
  void refreshPerformance();
  setInterval(() => void refreshPerformance(true), 2 * 60_000).unref?.();
});
if (cfg.simMode) startMockChat();
// live pump.fun coin chat -> his facecam reactions (once the token exists)
if (!cfg.simMode && cfg.ownMint) {
  import("./social/pumpchat.js").then(({ startPumpChat }) => startPumpChat(cfg.ownMint)).catch(() => {});
}

// ---------- pages ----------
// landing at the root; the live stage app moved to /live (and /stage for OBS).
// Once live with a mint, the CA is injected into the page — the contract
// button and every pump.fun link light up without touching the HTML.
app.get("/", (_req, res) => {
  const f = path.resolve(cfg.root, "..", "client", "public", "landing.html");
  try {
    let html = fs.readFileSync(f, "utf8");
    if (isLive() && cfg.ownMint) html = html.replace("const CA = '';", `const CA = '${cfg.ownMint}';`);
    res.type("html").send(html);
  } catch {
    res.sendFile(f);
  }
});
// THE RECORD — the human-readable callout board. /public/callouts is the
// payload; this is the page you can actually send someone who asks to see
// the track record. Served straight from disk, no build step.
// NOTE: this file ships inside the image, not on the data volume — a
// client-only commit does NOT trigger a Railway rebuild. Touch a server file
// when you change the page or you'll be staring at the old one.
app.get("/callouts", (_req, res) => {
  res.set("Cache-Control", "no-cache");
  res.sendFile(path.resolve(cfg.root, "..", "client", "public", "callouts.html"));
});

// THE CALLER BOARD — the same treatment for everyone else's calls. Data comes
// from /public/callers so the page can fetch it without the admin key.
app.get("/callers", (_req, res) => {
  res.set("Cache-Control", "no-cache");
  res.sendFile(path.resolve(cfg.root, "..", "client", "public", "callers.html"));
});

app.get("/live", (_req, res) => {
  const f = path.resolve(cfg.root, "..", "client", "dist", "index.html");
  if (fs.existsSync(f)) res.sendFile(f);
  else res.status(200).send("client not built — run `npm run build` in client/");
});

// PNL REPLAY (/pnl-card) — hype-video generator. Page ships from
// client/public/pnl-card via the static middleware below; these are its
// two data routes (public pump.fun proxies, self-contained, no keys).
registerPnlCard(app);

// ---------- static ----------
app.use("/audio", express.static(cfg.audioDir, { maxAge: "1h" }));
// filmed clips: list + download (admin) so films can be grabbed and posted by hand
app.get("/admin/clips", (_req, res) => {
  try {
    const files = fs.readdirSync(cfg.clipsDir)
      .filter((f) => f.endsWith(".mp4"))
      .map((f) => ({ file: f, size: fs.statSync(path.join(cfg.clipsDir, f)).size, at: fs.statSync(path.join(cfg.clipsDir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    res.json({ clips: files });
  } catch {
    res.json({ clips: [] });
  }
});
app.get("/admin/clip-file/:name", (req, res) => {
  const name = String(req.params.name).replace(/[^a-zA-Z0-9_.-]/g, "");
  const p = path.join(cfg.clipsDir, name);
  if (!name.endsWith(".mp4") || !fs.existsSync(p)) return res.status(404).json({ err: "not found" });
  res.download(p);
});
// serve the client's public/ so a freshly-exported room.glb is live on refresh
// (no client rebuild needed); dist static below still wins for built assets.
app.use(express.static(path.resolve(cfg.root, "..", "client", "public")));
const dist = path.resolve(cfg.root, "..", "client", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get("/stage", (_req, res) => res.sendFile(path.join(dist, "index.html")));
} else {
  app.get("/stage", (_req, res) =>
    res
      .status(200)
      .send("client not built — run `npm run build` (or use the vite dev server on :5199 during development)"),
  );
}

// the producer's control room
app.get("/admin", (_req, res) => res.type("html").send(ADMIN_HTML));

// the wardrobe: part library (gitignored, served locally) + the app
app.use("/sidekick-raw", express.static(path.resolve(cfg.root, "..", "sidekick", "raw"), {
  maxAge: "1d",
  setHeaders: (res) => res.setHeader("Access-Control-Allow-Origin", "*"), // canvas painting needs untainted textures in dev
}));
app.use(wardrobe);
app.get("/wardrobe", (_req, res) => {
  const f = path.resolve(cfg.root, "..", "client", "dist", "wardrobe.html");
  if (fs.existsSync(f)) res.sendFile(f);
  else res.status(200).send("wardrobe not built — run npm run build in client/");
});

// ---------- admin / health ----------
app.get("/health", async (_req, res) => {
  let audioFiles = 0;
  try {
    audioFiles = fs.readdirSync(cfg.audioDir).filter((f) => f.endsWith(".mp3")).length;
  } catch {}
  res.json({
    ok: true,
    live: isLive(),
    wallet: wallet.publicKey.toBase58(),
    watchers: hub.watchers,
    state: director.loco.stateName,
    brain: { hasKey: hasApiKey(), spendTodayUsd: Number(spendToday().toFixed(3)), dailyBudgetUsd: dailyBudgetUsd(), exhausted: budgetExhausted(), lastError: lastBrainError() },
    tts: { provider: cfg.ttsProvider, audioFilesGenerated: audioFiles },
    x: {
      postsToday: (await import("./social/x.js")).xPostsToday(),
      // the two counters that can silently mute him for a whole day
      repliesToday: Number(store.kvGet(`xreplies:${new Date().toISOString().slice(0, 10)}`) ?? 0),
      replyCap: cfg.maxXRepliesPerDay,
      repliedLedger: Object.keys((() => { try { return JSON.parse(store.kvGet("kol:seen") ?? "{}"); } catch { return {}; } })()).length,
      lastError: lastXError(),
    },
    calloutDryRun: cfg.calloutDryRun,
    calloutsToday: store.calloutsToday(),
    ownMint: cfg.ownMint || null,
    trading: await (async () => {
      try {
        const { tradeSpentToday, openPositions, bankSol } = await import("./chain/trader.js");
        const st = tradeSpentToday();
        const open = openPositions();
        const { memory } = await import("./agent/memory.js");
        const strat = memory.strategy();
        return {
          bankSol: Number((await bankSol()).toFixed(3)),
          spentToday: Number(st.spent.toFixed(3)),
          dailyCap: st.cap,
          openPositions: open.length,
          snipes: open.filter((p) => p.strategyId === "devsnipe").length,
          minBuyScore: strat.minBuyScore,
          tradeSizeSol: strat.tradeSizeSol,
          lastBlock: JSON.parse(store.kvGet("trade:lastblock") ?? "null"),
          lastSkip: JSON.parse(store.kvGet("trade:lastskip") ?? "null"),
          sniper: (await import("./agent/devsniper.js")).sniperStats(),
        };
      } catch { return null; }
    })(),
  });
});

/** Synthesize one line and report the result — isolates TTS from the browser.
 *  If it returns an audioUrl, open that URL directly to hear it. */
app.get("/admin/tts-test", async (req, res) => {
  const text = String(req.query.text ?? "Testing. The tape does not lie. This is Quant, live.");
  try {
    const syn = await tts.synthesize(text, "tts-test-" + Date.now());
    res.json({
      ok: syn.audioUrl !== null,
      audioUrl: syn.audioUrl,
      playHere: syn.audioUrl ? `http://127.0.0.1:${cfg.port}${syn.audioUrl}` : null,
      durMs: syn.durMs,
      note:
        syn.audioUrl === null
          ? "TTS produced NO audio (Edge endpoint unreachable or blocked) — the show falls back to subtitles. Check firewall/proxy, or set TTS_PROVIDER=none."
          : "TTS works. If you still hear nothing on the stage, it is a browser playback/arm issue — click the 'arm audio' overlay before triggering, and check the browser console.",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e).slice(0, 200) });
  }
});

/** Simulate a sent coin without touching the chain wallet — dev/demo driver.
 *  Works from a browser (GET + ?mint=…) or any curl. Reads mint from the query
 *  string, a JSON body, a form body, or a raw text body. */
function readParam(req: express.Request, key: string): string | undefined {
  const q = req.query?.[key];
  if (typeof q === "string" && q) return q;
  const b: any = req.body;
  if (b && typeof b === "object" && b[key]) return String(b[key]);
  if (typeof b === "string" && b.trim().startsWith("{")) {
    try {
      return JSON.parse(b)[key];
    } catch {}
  }
  return undefined;
}

const fakeSend = (req: express.Request, res: express.Response) => {
  const mint = String(readParam(req, "mint") ?? "").trim();
  if (mint.length < 32) return res.status(400).json({ err: "mint required — GET /admin/fake-send?mint=<pumpfun mint>" });
  director.onInboxCoin({
    mint,
    amountRaw: BigInt(readParam(req, "amountRaw") ?? "50000000000"),
    sender: readParam(req, "sender") ?? null,
  });
  res.json({ queued: true, mint });
};
app.get("/admin/fake-send", fakeSend);
app.post("/admin/fake-send", fakeSend);

const fakeBuyback = (req: express.Request, res: express.Response) => {
  director.onBuybackPending({ sol: Number(readParam(req, "sol") ?? 0.05) });
  res.json({ queued: true });
};
app.get("/admin/fake-buyback", fakeBuyback);
app.post("/admin/fake-buyback", fakeBuyback);

// ---- debug controls (used by the on-stage debug panel) ----
import { STATIONS, applyLayout } from "./stations.js";

/** The client posts the Unity room's Station_ marker coordinates here so the
 *  server-driven avatar walks to the right spots in the exported room. */
app.post("/admin/layout", (req, res) => {
  const stations = (req.body?.stations ?? {}) as Record<string, { x: number; z: number; face?: number }>;
  const applied = applyLayout(stations);
  log.info("layout", `room layout applied for stations: ${applied.join(", ") || "(none)"}`);
  res.json({ applied });
});

app.get("/admin/pause", (_req, res) => {
  director.paused = true;
  res.json({ paused: true });
});
app.get("/admin/resume", (_req, res) => {
  director.paused = false;
  res.json({ paused: false });
});

/** Walk Quant to a station (auto-pauses the show so it doesn't fight you). */
app.get("/admin/goto", async (req, res) => {
  const station = String(req.query.station ?? "");
  if (!(station in STATIONS)) return res.status(400).json({ err: `unknown station; one of ${Object.keys(STATIONS).join(", ")}` });
  director.paused = true;
  const camByStation: Record<string, "wide" | "terminal" | "facecam" | "vault" | "film" | "bigscreen"> = {
    terminal: "terminal",
    vault: "vault",
    camera_mark: "facecam",
    greenscreen: "film",
    bigscreen: "bigscreen",
  };
  hub.cue({ t: "camera", preset: camByStation[station] ?? "wide" });
  await director.loco.walkTo(station as any);
  // sit AFTER arrival — walkTo stands him up, so sitting first was a no-op
  director.loco.sit(station === "terminal" || station === "bigscreen");
  res.json({ arrived: station, paused: true, seated: director.loco.seated });
});

app.get("/admin/camera", (req, res) => {
  const preset = String(req.query.preset ?? "wide");
  if (!["wide", "terminal", "facecam", "vault", "film", "bigscreen"].includes(preset)) return res.status(400).json({ err: "bad preset" });
  hub.cue({ t: "camera", preset: preset as any });
  res.json({ camera: preset });
});

app.get("/admin/anim", (req, res) => {
  const clip = String(req.query.clip ?? "wave");
  hub.cue({ t: "anim", clip });
  res.json({ anim: clip });
});

app.get("/admin/fx", (req, res) => {
  const kind = String(req.query.kind ?? "confetti");
  hub.cue({ t: "fx", kind: kind as any });
  res.json({ fx: kind });
});

// ---- agent v2 endpoints ----
import { receiveClip } from "./media/film.js";
import { memory } from "./agent/memory.js";
import { snapshotKPIs } from "./agent/goals.js";
import { allPositions } from "./chain/trader.js";
import { xReady, xPostsToday } from "./social/x.js";
import { ActionSchema } from "./agent/actions.js";
import { bindFeed, feedHistory, systemLog } from "./feed.js";

// live agent-feed → the stage terminal overlay
bindFeed((entry) => hub.cue({ t: "feed", entry }));
app.get("/admin/feed", (_req, res) => res.json({ entries: feedHistory(200) }));
app.get("/admin/syslog", (_req, res) => res.json({ entries: systemLog(200) }));

// ---- livestream chat: the producer relays pump.fun chat here; Quant reads
// it at the facecam (chatBeat). GET /admin/chat lists the buffer. ----
app.all("/admin/chat-add", (req, res) => {
  // relayed from the pump.fun token page by the browser watcher script (a
  // different origin), so allow the cross-origin read of the response
  res.setHeader("Access-Control-Allow-Origin", "*");
  const user = String(req.query.user ?? (req.body as any)?.user ?? "viewer");
  const text = String(req.query.text ?? (req.body as any)?.text ?? "");
  const msg = pushChat(user, text);
  if (!msg) return res.status(400).json({ err: "text required" });
  res.json({ ok: true, unread: unreadChat() });
});
app.get("/admin/chat", (_req, res) => res.json({ unread: unreadChat(), messages: allChat(50) }));

app.get("/admin/recstat", (req, res) => {
  log.info("recstat", JSON.stringify(req.query));
  res.json({ ok: true });
});

/** Producer capture: record N seconds of the stage canvas into an mp4
 *  (drives the same recorder the film beat uses). */
/** Make him SPEAK an exact line on stage (mood optional) — and with record=<id>,
 *  film it: synthesizes first, starts the recorder, delivers the line, stops,
 *  returns the mp4 path. Position him first via /admin/goto + /admin/camera. */
app.all("/admin/say", async (req, res) => {
  // prefer the JSON body — long text through a query string gets shell-mangled
  const b: any = req.body ?? {};
  const text = String(b.text ?? req.query.text ?? "").trim();
  if (text.length < 2) return res.status(400).json({ err: "pass text in a JSON body or ?text=" });
  const moodRaw = String(b.mood ?? req.query.mood ?? "");
  const mood = (["neutral", "excited", "disgusted", "thinking"] as const).includes(moodRaw as any)
    ? (moodRaw as "neutral" | "excited" | "disgusted" | "thinking")
    : "neutral";
  const recId = String(b.record ?? req.query.record ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
  try {
    const syn = await tts.synthesize(text, "adminsay-" + Date.now());
    const durMs = syn?.durMs ?? Math.max(1500, text.split(/\s+/).length * 340);
    let clipP: Promise<string | null> | null = null;
    if (recId) {
      const { expectClip } = await import("./media/film.js");
      clipP = expectClip(recId, durMs + 60_000);
      hub.cue({ t: "record", on: true, id: recId });
      await new Promise((r) => setTimeout(r, 900));
    }
    hub.cue({ t: "mood", mood });
    hub.cue({ t: "speak", audioUrl: syn?.audioUrl ?? null, subtitle: text, durMs, words: syn?.words ?? [] });
    await new Promise((r) => setTimeout(r, durMs + 1200));
    if (recId && clipP) {
      hub.cue({ t: "record", on: false, id: recId });
      const mp4 = await clipP;
      return res.json({ ok: true, durMs, recorded: !!mp4, mp4 });
    }
    res.json({ ok: true, durMs, audio: !!syn?.audioUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e).slice(0, 200) });
  }
});

app.get("/admin/record", async (req, res) => {
  const secs = Math.min(20, Math.max(2, Number(req.query.secs ?? 6)));
  const id = String(req.query.id ?? `cap_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "");
  const { expectClip } = await import("./media/film.js");
  const clipP = expectClip(id, (secs + 40) * 1000);
  hub.cue({ t: "record", on: true, id });
  await new Promise((r) => setTimeout(r, secs * 1000));
  hub.cue({ t: "record", on: false, id });
  const mp4 = await clipP;
  res.json({ ok: !!mp4, id, mp4 });
});

// ---- selfies: the stage client renders the shot and uploads the PNG ----
const SELFIE_DIR = path.join(cfg.dataDir, "images", "selfies");
app.post("/admin/selfie-upload", express.raw({ type: () => true, limit: "20mb" }), (req, res) => {
  const id = String(req.query.id ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
  const body = req.body as Buffer;
  if (!id || !body?.length) return res.status(400).json({ err: "bad selfie" });
  fs.mkdirSync(SELFIE_DIR, { recursive: true });
  fs.writeFileSync(path.join(SELFIE_DIR, `${id}.png`), body);
  log.info("selfie", `saved ${id}.png (${Math.round(body.length / 1024)}kb)`);
  res.json({ ok: true });
});
/** Test route: strike a pose + face and take a selfie (stage page must be open). */
app.get("/admin/selfie-take", (req, res) => {
  const id = `selfie_${Date.now()}`;
  hub.cue({
    t: "selfie", id,
    anim: String(req.query.anim ?? "phone_selfie"),
    expr: String(req.query.expr ?? "happy"),
  });
  res.json({ id, preview: "/admin/selfie-last (give it ~4s)" });
});
/** Preview the most recent selfie. */
app.get("/admin/selfie-last", (_req, res) => {
  try {
    const latest = fs.readdirSync(SELFIE_DIR)
      .filter((f) => f.endsWith(".png"))
      .map((f) => ({ f, t: fs.statSync(path.join(SELFIE_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    if (!latest) return res.status(404).send("no selfies yet");
    res.sendFile(path.join(SELFIE_DIR, latest.f));
  } catch {
    res.status(404).send("no selfies yet");
  }
});

/** The stage client uploads its recorded greenscreen clip here (raw webm). */
app.post("/admin/clip", express.raw({ type: () => true, limit: "80mb" }), async (req, res) => {
  const id = String(req.query.id ?? "");
  if (!id || !Buffer.isBuffer(req.body) || req.body.length < 5000) {
    return res.status(400).json({ err: "id + webm body required" });
  }
  const mp4 = await receiveClip(id, req.body);
  res.json({ ok: true, mp4: mp4 ? path.basename(mp4) : null });
});

/** Direct agent action for testing: /admin/agent?do=tweet&topic=... etc.
 *  POST accepts a full action JSON body (needed for array fields like board). */
app.all("/admin/agent", (req, res) => {
  let raw: any;
  if (req.method === "POST" && req.body && typeof req.body === "object" && req.body.do) {
    raw = req.body;
  } else {
    const q = req.query as Record<string, string>;
    raw = { do: q.do };
    for (const k of ["topic", "mint", "why", "thesis", "text", "handle", "reason", "riskNote"]) if (q[k]) raw[k] = q[k];
    for (const k of ["sol", "fraction", "minBuyScore", "tradeSizeSol"]) if (q[k]) raw[k] = Number(q[k]);
    if (q.lines) raw.lines = String(q.lines).split("|").map((l) => l.trim()).filter(Boolean);
  }
  const parsed = ActionSchema.safeParse(raw);
  if (!parsed.success) return res.status(400).json({ err: parsed.error.issues[0]?.message, got: raw });
  // admin presses are URGENT: they jump to the front so the button does the
  // thing next, and the result is reported instead of silently dropped
  const r = director.onAgentAction({ action: parsed.data, plannedAt: Date.now(), manual: true }, true);
  log.info("admin", `action ${parsed.data.do} → ${r.ok ? "queued (next up)" : r.why} | depth ${r.depth}`);
  res.json({
    ok: r.ok,
    queued: parsed.data,
    depth: r.depth,
    why: r.why,
    note: r.ok ? "runs as soon as the current beat finishes" : undefined,
  });
});

/** PRODUCER CHANNEL — guidance the actor internalizes as his own convictions.
 *  /admin/directive?text=...  add   |  ?remove=<id>  remove  |  no args: list */
app.get("/admin/directive", (req, res) => {
  const text = String(req.query.text ?? "");
  const remove = String(req.query.remove ?? "");
  if (remove) return res.json({ removed: memory.removeDirective(remove) });
  if (text.length > 3) {
    const id = memory.addDirective(text);
    log.info("producer", `directive added (${id}): ${text.slice(0, 80)}`);
    return res.json({ added: id });
  }
  res.json({ directives: memory.directives() });
});

/** Viewer-facing wallet: SOL + every holding, valued, sorted. */
app.get("/public/wallet", (_req, res) => res.json(cachedWallet()));

/** Viewer-facing stats: the scoreboard behind the character. */
app.get("/public/stats", (_req, res) => res.json(cachedStats()));

/** THE TRACK RECORD — every callout with entry mc, peak mc and the multiple,
 *  plus the averages, windowed: ?range=today|7d|30d|all */
app.get("/public/callouts", async (req, res) => {
  try {
    const { refreshPerformance, board } = await import("./callout/performance.js");
    const range = (["today", "7d", "30d", "all"].includes(String(req.query.range))
      ? String(req.query.range)
      : "all") as "today" | "7d" | "30d" | "all";
    const rows = await refreshPerformance();
    res.json({ ok: true, ...board(rows, range) });
  } catch (e) {
    res.json({ ok: false, why: String(e).slice(0, 120), rows: [], calls: 0 });
  }
});

/** CALLER LEADERBOARD — the full reputation index, every caller RIKU has
 *  graded (calloutId-deduped). pump.fun's own board stops at top-50; this
 *  one doesn't stop.
 *  ?n=0 (all, default) ?min=3 (min graded calls)
 *
 *  ROWS ARRIVE SORTED BY MEDIAN peak multiple and callers.html MUST NOT
 *  re-sort them on `avg`. A single call whose entry price was read as dust
 *  divides out to a multiple in the billions: one such row ranked #1 on the
 *  public board with a 6.7e10 "average" until the page stopped overriding
 *  this order. The median already absorbs that outlier, which is the whole
 *  reason it is the number the index ranks on. */
async function callerBoard(req: express.Request, res: express.Response): Promise<void> {
  try {
    const { topCallers, indexStats } = await import("./callout/callers.js");
    const n = Math.max(0, Number(req.query.n) || 0);
    // default matches topCallers: 5 graded calls — a 3-call "56x median" is a
    // farmer, not a caller. ?min= still overrides for admin digging.
    const min = Math.max(1, Number(req.query.min) || 5);
    res.json({ ok: true, ...indexStats(), rows: topCallers(n, min) });
  } catch (e) {
    res.json({ ok: false, why: String(e).slice(0, 120) });
  }
}
app.get("/admin/callers", callerBoard);
app.get("/public/callers", callerBoard);

/** BRIDGE INGEST — a residential poller forwards raw follow-feed items here
 *  (pump.fun's authed feed 401s from datacenter IPs). Body: {items:[...]}. */
app.post("/admin/feed-ingest", async (req, res) => {
  try {
    let body: any = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    const items = Array.isArray(body?.items) ? body.items : [];
    const { ingestAlertItems } = await import("./callout/discovery.js");
    const r = await ingestAlertItems(items);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.json({ ok: false, why: String(e).slice(0, 150) });
  }
});

/** RAW CALL ROWS — the backtest dataset: every observed callout with entry
 *  price, peak, time-to-peak and mc at call. ?since=<ms> ?wallet=<addr> */
app.get("/admin/calls", async (req, res) => {
  try {
    const { callRows } = await import("./callout/callers.js");
    const since = Number(req.query.since) || 0;
    const wallet = String(req.query.wallet ?? "");
    let rows = callRows().filter((r) => r.at >= since);
    if (wallet) rows = rows.filter((r) => r.w === wallet);
    rows.sort((a, b) => a.at - b.at);
    res.json({ ok: true, count: rows.length, rows: rows.slice(-5000) });
  } catch (e) {
    res.json({ ok: false, why: String(e).slice(0, 120) });
  }
});

/** THE CALLER BOARD, public — same rows /admin/callers returns, minus the key,
 *  so the page at /callers can fetch it from a browser. Reputation grades on
 *  public pump.fun callouts were never secret; only the admin surface was. */
app.get("/public/callers", async (_req, res) => {
  try {
    const { topCallers } = await import("./callout/callers.js");
    res.set("Cache-Control", "no-cache");
    res.json({ ok: true, rows: topCallers(50) });
  } catch (e) {
    res.json({ ok: false, why: String(e).slice(0, 120) });
  }
});

/** THE DECISION LEDGER — every buy/sell/call/verdict with its canonical string,
 *  sha256 and the Solana memo tx that committed the hash BEFORE execution.
 *  Verify any row: sha256(canonical) === commitHash, and the memo tx (commitSig)
 *  carries `riku:commit:v1:{commitHash}` with a timestamp before txSig's.
 *  ?kind=buy|sell|call|verdict  ?n=1..200 */
app.get("/public/decisions", async (req, res) => {
  try {
    const { recentDecisions } = await import("./desk/records.js");
    const kind = ["buy", "sell", "call", "verdict"].includes(String(req.query.kind))
      ? String(req.query.kind)
      : undefined;
    const n = Math.min(200, Math.max(1, Number(req.query.n) || 50));
    res.json({ ok: true, how_to_verify: "sha256(canonical) == commitHash; memo tx commitSig contains riku:commit:v1:{commitHash}", rows: recentDecisions(n, kind) });
  } catch (e) {
    res.json({ ok: false, why: String(e).slice(0, 120), rows: [] });
  }
});

// Pretty aliases used in tweets/bio — keep these working forever.
app.get("/decisions", (req, res) => {
  const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(302, `/public/decisions${q}`);
});
app.get("/callers", (req, res) => {
  const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(302, `/public/callers${q}`);
});

app.get("/admin/agent-status", async (_req, res) => {
  res.json({
    kpis: await snapshotKPIs().catch(() => null),
    memoryDigest: memory.digest(),
    positions: allPositions().slice(-10),
    x: { ready: xReady(), postsToday: xPostsToday() },
  });
});

server.listen(cfg.port, cfg.host, () => {
  log.info("quant", `server on http://${cfg.host}:${cfg.port}  (stage: /stage, ws: /ws)`);
  log.info("quant", `wallet: ${wallet.publicKey.toBase58()}`);
  log.info(
    "quant",
    `brain: ${hasApiKey() ? "LIVE" : "MOCK (no LLM_API_KEY)"} | tts: ${cfg.ttsProvider} | callouts: ${cfg.calloutDryRun ? "DRY RUN" : "LIVE"}`,
  );
  director.start();
  // caller-intel harvester: one CC lookup / CALLER_HARVEST_S, always yields to
  // callout posting (revenue first)
  void import("./callout/callers.js").then((m) => m.startCallerHarvester());
  // callout discovery: proven callers on the public firehose nominate coins
  // into the research queue — the feed brings him coins, research still judges
  void import("./callout/discovery.js").then((m) =>
    m.startCalloutDiscovery((mint, why) =>
      director.onAgentAction({ action: { do: "research", mint, why }, plannedAt: Date.now() }),
    ),
  );
  // caller-follow: the executing strategy on top of caller intel — instant
  // buys on graded callers' fresh calls, exit when their wallet sells; the
  // stage replays both (position reveal + exit note)
  void import("./callout/follower.js").then((m) =>
    m.startCallerFollow({
      reveal: (mint, sol) => director.queueReveal(mint, sol, "call"),
      narrateExit: (_mint, symbol, reason, solReceived, costSol) =>
        director.queueExitNote(symbol, reason, solReceived, costSol),
    }),
  );
  // outreach: small-account reply candidates — drafts only, producer approves
  // every send at /admin/outreach.html
  void import("./social/outreach.js").then((m) => m.startOutreach());
  // hourly disk janitor: spoken audio >24h and clips/selfies >7d are dead weight
  void import("./janitor.js").then((m) => m.startJanitor());
  // midcap investment book: omo-inspired mid-cap buys with NO automatic exits —
  // operator sells from /admin/book.html; every verdict (pass or buy) stages
  // as an INVESTMENT DESK segment, visually distinct from the research loop
  void import("./invest/midcap.js").then((m) =>
    m.startMidcap({ investNote: (p) => director.queueInvestNote(p) }),
  );
});
