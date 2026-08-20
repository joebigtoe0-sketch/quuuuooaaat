import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import express from "express";
import { cfg } from "./config.js";
import { log } from "./log.js";
import { Hub } from "./hub.js";
import { Locomotion } from "./director/locomotion.js";
import { OpenAITTS } from "./voice/openaiTts.js";
import { GoogleTTS } from "./voice/gtts.js";
import { EdgeTTS } from "./voice/edgeTts.js";
import { SilentTTS, type TTSProvider } from "./voice/tts.js";
import { PUPPET_HTML } from "./puppetPage.js";
import type { SnapshotMsg, StationId } from "./protocol.js";

/**
 * PUPPET MODE — the stage, hand-driven.
 *
 * The full show with the brain removed: no director loop, no agent, no chain,
 * no feeds, no trading, no posting. Just the room, the avatar and a control
 * board, so a human can direct a shot — walk him somewhere, play an emote,
 * put words in his mouth, pick a camera — and film it for marketing.
 *
 *   npm run puppet        (or start-puppet.bat)
 *   control board: http://127.0.0.1:8492/puppet
 *   the shot:      http://127.0.0.1:8492/stage?auto=1
 */
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
const server = http.createServer(app);
const hub = new Hub(server);
const loco = new Locomotion(hub);

const tts: TTSProvider =
  cfg.ttsProvider === "openai"
    ? new OpenAITTS()
    : cfg.ttsProvider === "gtts"
      ? new GoogleTTS()
      : cfg.ttsProvider === "edge"
        ? new EdgeTTS()
        : new SilentTTS();

// The client rebuilds from a snapshot on connect. Everything show-related is
// empty here — screens stay blank unless the operator puts something on them.
let board: string[] = [];
let inspection: any = { mint: null, name: "", symbol: "", rows: [], score: null, tier: null };
hub.onSnapshot(
  (): SnapshotMsg => ({
    t: "snapshot",
    now: Date.now(),
    inspection,
    treasury: { sol: 0, ownTokens: 0, buybacks: [], neverSoldDays: 0, holdings: [] },
    callouts: [],
    conveyor: [],
    board,
    actions: [],
    avatar: { x: loco.x, z: loco.z, heading: loco.heading, anim: loco.anim, seated: loco.seated },
    state: loco.stateName,
  }),
);

const root = path.resolve(cfg.root, "..");
app.use("/audio", express.static(cfg.audioDir, { maxAge: "1h" }));
app.use(express.static(path.join(root, "client", "dist")));
app.use(express.static(path.join(root, "client", "public")));

app.get("/", (_req, res) => res.redirect("/puppet"));
app.get("/puppet", (_req, res) => res.type("html").send(PUPPET_HTML));
app.get("/stage", (_req, res) => {
  const f = path.join(root, "client", "dist", "index.html");
  if (fs.existsSync(f)) res.sendFile(f);
  else res.status(200).send("client not built — run:  npm run build -w client");
});
app.get("/live", (_req, res) => res.redirect("/stage?auto=1"));

// ---------- the control surface ----------
const ok = (res: express.Response, extra: object = {}) => res.json({ ok: true, ...extra });

app.post("/p/walk", async (req, res) => {
  const to = String(req.query.to ?? "") as StationId;
  loco.stateName = "DIRECTED";
  void loco.walkTo(to); // don't block the panel on the walk
  ok(res, { to });
});
app.post("/p/anim", (req, res) => {
  const clip = String(req.query.clip ?? "").replace(/[^a-z0-9_]/gi, "");
  if (clip) hub.cue({ t: "anim", clip });
  ok(res, { clip });
});
app.post("/p/camera", (req, res) => {
  const preset = String(req.query.preset ?? "wide") as any;
  hub.cue({ t: "camera", preset });
  ok(res, { preset });
});
app.post("/p/mood", (req, res) => {
  const mood = String(req.query.mood ?? "neutral") as any;
  hub.cue({ t: "mood", mood });
  ok(res, { mood });
});
app.post("/p/fx", (req, res) => {
  const kind = String(req.query.kind ?? "ding") as any;
  hub.cue({ t: "fx", kind });
  ok(res, { kind });
});
app.post("/p/sit", (req, res) => {
  const on = String(req.query.on ?? "1") === "1";
  loco.sit(on);
  ok(res, { seated: on });
});
app.post("/p/state", (req, res) => {
  loco.stateName = String(req.query.name ?? "IDLE").slice(0, 24);
  ok(res, { state: loco.stateName });
});
app.post("/p/board", (req, res) => {
  const lines = String((req.body as any)?.lines ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 7);
  board = lines;
  hub.cue({ t: "board", lines } as any);
  ok(res, { lines });
});

/** Put words in his mouth — real TTS when a key is configured, subtitles always. */
app.post("/p/say", async (req, res) => {
  const text = String((req.body as any)?.text ?? req.query.text ?? "").trim();
  if (text.length < 1) return res.status(400).json({ err: "no text" });
  const moodRaw = String((req.body as any)?.mood ?? req.query.mood ?? "neutral");
  const mood = (["neutral", "excited", "disgusted", "thinking"] as const).includes(moodRaw as any)
    ? (moodRaw as any)
    : "neutral";
  try {
    const syn = await tts.synthesize(text, "puppet-" + Date.now());
    const durMs = syn?.durMs ?? Math.max(1500, text.split(/\s+/).length * 340);
    hub.cue({ t: "mood", mood });
    hub.cue({ t: "speak", audioUrl: syn?.audioUrl ?? null, subtitle: text, durMs, words: syn?.words ?? [] });
    ok(res, { durMs, voiced: !!syn?.audioUrl });
  } catch (e) {
    res.status(500).json({ err: String(e).slice(0, 160) });
  }
});

/** A SHOT: a list of steps run in order, so a whole take is one button.
 *  [{walk:"terminal"},{sit:true},{camera:"terminal"},{say:"..."},{anim:"dab"},{wait:800}] */
app.post("/p/shot", async (req, res) => {
  const steps: any[] = Array.isArray((req.body as any)?.steps) ? (req.body as any).steps : [];
  if (!steps.length) return res.status(400).json({ err: "no steps" });
  res.json({ ok: true, steps: steps.length }); // reply immediately; the take runs on
  for (const s of steps) {
    try {
      if (s.walk) await loco.walkTo(String(s.walk) as StationId);
      if (s.sit !== undefined) loco.sit(Boolean(s.sit));
      if (s.camera) hub.cue({ t: "camera", preset: s.camera });
      if (s.mood) hub.cue({ t: "mood", mood: s.mood });
      if (s.anim) hub.cue({ t: "anim", clip: String(s.anim) });
      if (s.fx) hub.cue({ t: "fx", kind: s.fx });
      if (s.say) {
        const syn = await tts.synthesize(String(s.say), "puppet-" + Date.now());
        const durMs = syn?.durMs ?? Math.max(1500, String(s.say).split(/\s+/).length * 340);
        hub.cue({ t: "speak", audioUrl: syn?.audioUrl ?? null, subtitle: String(s.say), durMs, words: syn?.words ?? [] });
        await new Promise((r) => setTimeout(r, durMs + 500));
      }
      if (s.wait) await new Promise((r) => setTimeout(r, Math.min(20000, Number(s.wait) || 0)));
    } catch (e) {
      log.warn("puppet", `step failed: ${String(e).slice(0, 100)}`);
    }
  }
  log.info("puppet", "shot complete");
});

app.get("/p/status", (_req, res) =>
  res.json({ watchers: hub.watchers, tts: cfg.ttsProvider, voiced: cfg.ttsProvider !== "none" && !!cfg.ttsApiKey, state: loco.stateName }),
);

const port = Number(process.env.PUPPET_PORT ?? 8492);
server.listen(port, "127.0.0.1", () => {
  log.info("puppet", `PUPPET MODE — no brain, no chain, no trading, nothing posts.`);
  log.info("puppet", `control board : http://127.0.0.1:${port}/puppet`);
  log.info("puppet", `the shot      : http://127.0.0.1:${port}/stage?auto=1`);
  log.info("puppet", `voice: ${cfg.ttsProvider}${cfg.ttsApiKey ? "" : " (no key — subtitles only)"}`);
});
