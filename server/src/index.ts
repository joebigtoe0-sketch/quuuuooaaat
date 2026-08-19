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
import { store } from "./store.js";
import { ADMIN_HTML } from "./adminPage.js";
import { armDevSniper, onSnipeLaunch } from "./agent/devsniper.js";
import { wardrobe } from "./wardrobe.js";
import { startStatsCache, cachedWallet, cachedStats } from "./statsCache.js";
import { pushChat, allChat, unreadChat, startMockChat } from "./social/livechat.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// accept bodies with any/no content-type — but NEVER touch the binary upload
// routes (selfie PNGs, greenscreen webm): a global text parse would 413 them
const textParser = express.text({ type: () => true });
const RAW_UPLOADS = new Set(["/admin/selfie-upload", "/admin/clip"]);
app.use((req, res, next) => (RAW_UPLOADS.has(req.path) ? next() : textParser(req, res, next)));
const server = http.createServer(app);
const hub = new Hub(server);

// ---------- admin auth ----------
// Control endpoints need the admin key (query ?key=, x-admin-key header, or
// the qk cookie set by /admin login). Read-only + stage-internal endpoints
// (feed, layout, clip upload, agent-status, health) stay open.
const PROTECTED = /^\/admin\/(directive|reset|restart|agent$|fake-send|fake-buyback|pause|resume|goto|anim|camera|fx|tts-test|selfie-take|selfie-last|chat$|chat-add|go-live|syslog|record$|say|queue|clips|clip-file|research-now|blacklist|sniper|operator-call|facts)/;
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
    const asked = Number(req.query.sol);
    const sol = Math.round(
      Math.max(minSol, Math.min(Number.isFinite(asked) && asked > 0 ? asked : (minSol + 0.8 * (maxSol - minSol)) * (0.88 + Math.random() * 0.24), maxSol, cfg.maxTradeSol)) * 1000,
    ) / 1000;
    // fresh quote each try — a moving price can blow the slippage window once
    let r = await tradeBuy(mint, mint.slice(0, 6), sol, "saw the setup early, took the entry before the checklist", null, "opcall");
    if (!r.ok && !/cap|holding|blacklist|already played/i.test(r.why ?? "")) {
      await new Promise((rs) => setTimeout(rs, 1200));
      r = await tradeBuy(mint, mint.slice(0, 6), sol, "saw the setup early, took the entry before the checklist", null, "opcall");
    }
    if (!r.ok) return res.json({ ok: false, why: (r.why ?? "").slice(0, 400) });
    director.queueReveal(mint, sol, "call");
    log.info("admin", `operator call filled: ${mint.slice(0, 8)}… ${sol} SOL${r.dry ? " [dry]" : ""} — staged discovery queued`);
    res.json({ ok: true, sol, dry: r.dry });
  } catch (e) {
    res.json({ ok: false, why: String(e).slice(0, 140) });
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
if (cfg.agentEnabled) director.planner.start();
startStatsCache();
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
app.get("/live", (_req, res) => {
  const f = path.resolve(cfg.root, "..", "client", "dist", "index.html");
  if (fs.existsSync(f)) res.sendFile(f);
  else res.status(200).send("client not built — run `npm run build` in client/");
});

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
  director.onAgentAction({ action: parsed.data, plannedAt: Date.now() });
  res.json({ queued: parsed.data });
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
});
