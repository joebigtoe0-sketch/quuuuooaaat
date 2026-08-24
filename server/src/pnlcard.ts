// PNL REPLAY (/pnl-card) — the trade-replay hype-video generator. (v1.1: frontend retries through reboot 502s)
// Frontend lives in client/public/pnl-card/ (served by the existing static
// middleware); these are its two data routes. Fully self-contained: public
// pump.fun endpoints only, no keys, no RIKU systems touched.
import type { Express } from "express";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

const UA = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) quantriku-pnl/1.0", accept: "application/json" };

// intervals swap-api accepts, ascending
const INTERVALS: [string, number][] = [
  ["1s", 1e3], ["15s", 15e3], ["30s", 30e3], ["1m", 60e3], ["5m", 300e3],
  ["15m", 900e3], ["30m", 1800e3], ["1h", 3600e3], ["4h", 14400e3], ["6h", 21600e3], ["12h", 43200e3],
];

async function fetchJson(url: string, tries = 4): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: UA });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 1200 * (i + 1))); continue; }
    if (!r.ok) throw new Error(`${r.status} from pump.fun`);
    return r.json();
  }
  throw new Error("pump.fun rate-limited, try again in a minute");
}

async function fetchWalletTrades(mint: string, wallet: string) {
  const trades: any[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 60; page++) {
    const u =
      `https://swap-api.pump.fun/v2/coins/${mint}/trades?limit=100&userAddress=${wallet}` +
      (cursor ? `&cursor=${cursor}` : "");
    const b = await fetchJson(u);
    for (const t of b.trades || []) {
      trades.push({
        t: Date.parse(t.timestamp),
        type: t.type,
        priceUsd: Number(t.fillPriceUsd || t.priceUsd),
        priceSol: Number(t.fillPriceSol || t.priceSol),
        usd: Number(t.amountUsd),
        sol: Number(t.amountSol),
        tokens: Number(t.baseAmount),
        tx: t.tx,
        program: t.program,
      });
    }
    if (!b.pagination?.hasMore || !b.pagination?.nextCursor) break;
    cursor = b.pagination.nextCursor;
  }
  trades.sort((a, b) => a.t - b.t); // API returns newest-first
  return trades;
}

async function fetchCandles(mint: string, t0: number, tEnd: number) {
  // latest ≤1000 sparse candles per call; grow the interval until we reach t0
  const now = Date.now();
  let idx = INTERVALS.findIndex(([, ms]) => (now - t0) / ms <= 900);
  if (idx === -1) idx = INTERVALS.length - 1;
  for (; idx < INTERVALS.length; idx++) {
    const [iv, ms] = INTERVALS[idx];
    const b = await fetchJson(
      `https://swap-api.pump.fun/v1/coins/${mint}/candles?interval=${iv}&limit=1000&currency=USD`,
    );
    if (!Array.isArray(b) || !b.length) continue;
    const covered = b.length < 1000 || b[0].timestamp <= t0 + ms;
    if (covered || idx === INTERVALS.length - 1) {
      return {
        interval: iv,
        candles: b
          .filter((c: any) => c.timestamp >= t0 - ms && c.timestamp <= tEnd + ms)
          .map((c: any) => ({ t: c.timestamp, o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: +c.volume })),
      };
    }
  }
  return { interval: null, candles: [] };
}

async function apiReplay(mintRaw: string, walletRaw: string) {
  const mint = (mintRaw || "").trim();
  const wallet = (walletRaw || "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new Error("invalid token address");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) throw new Error("invalid wallet address");

  const [meta, trades] = await Promise.all([
    fetchJson(`https://frontend-api-v3.pump.fun/coins/${mint}`).catch(() => null),
    fetchWalletTrades(mint, wallet),
  ]);
  if (!meta || !meta.mint) throw new Error("token not found on pump.fun (is it a pump.fun coin?)");
  if (!trades.length) throw new Error("this wallet has no trades on this token");

  // full token life: launch → now, so holdings are valued at CURRENT price
  const t0 = meta.created_timestamp || trades[0].t;
  const tEnd = Date.now();

  const [{ interval, candles }, solPrice] = await Promise.all([
    fetchCandles(mint, t0, tEnd),
    fetchJson("https://frontend-api-v3.pump.fun/sol-price").then((b) => b.solPrice).catch(() => null),
  ]);

  return {
    meta: {
      mint: meta.mint,
      name: meta.name,
      symbol: meta.symbol,
      image: meta.image_uri || null,
      created: meta.created_timestamp,
      bonded: !!meta.complete,
      usdMarketCap: meta.usd_market_cap ?? null,
    },
    range: { t0, tEnd },
    interval,
    candles,
    trades,
    solPrice,
  };
}

export function registerPnlCard(app: Express) {
  app.get("/pnl-card/api/replay", async (req, res) => {
    try {
      const data = await apiReplay(String(req.query.mint || ""), String(req.query.wallet || ""));
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // webm → mp4 for browsers whose MediaRecorder can't mux mp4 natively.
  // NOTE: this path must be in index.ts RAW_UPLOADS or the global text parser
  // eats the binary body. One job at a time — this box also runs the show.
  let converting = false;
  app.post("/pnl-card/api/mp4", async (req, res) => {
    if (converting) return res.status(429).json({ error: "busy" });
    if (!ffmpegPath) return res.status(501).json({ error: "no ffmpeg" });
    converting = true;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pnl-"));
    const inF = path.join(dir, "in.webm");
    const outF = path.join(dir, "out.mp4");
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} converting = false; };
    try {
      // collect raw body, capped at 120MB
      await new Promise<void>((resolve, reject) => {
        const ws = fs.createWriteStream(inF);
        let size = 0;
        req.on("data", (c: Buffer) => {
          size += c.length;
          if (size > 120e6) { req.destroy(); reject(new Error("too large")); }
        });
        req.pipe(ws);
        ws.on("finish", resolve);
        ws.on("error", reject);
        req.on("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        const p = spawn(ffmpegPath as string, [
          "-y", "-i", inF,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "160k",
          "-movflags", "+faststart",
          outF,
        ], { stdio: "ignore" });
        p.on("close", (code) => (code === 0 && fs.existsSync(outF) ? resolve() : reject(new Error("ffmpeg failed"))));
        p.on("error", reject);
      });
      res.set("content-type", "video/mp4");
      const rs = fs.createReadStream(outF);
      rs.pipe(res);
      rs.on("close", cleanup);
      rs.on("error", () => { cleanup(); res.end(); });
    } catch (e: any) {
      cleanup();
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // token images proxied same-origin so the canvas stays untainted for MediaRecorder
  app.get("/pnl-card/api/img", async (req, res) => {
    try {
      const u = String(req.query.u || "");
      if (!/^https:\/\//.test(u)) return res.status(400).end("https only");
      const r = await fetch(u, { headers: { "user-agent": UA["user-agent"] } });
      const ct = r.headers.get("content-type") || "";
      if (!r.ok || !ct.startsWith("image/")) return res.status(502).end("not an image");
      res.set("content-type", ct).set("cache-control", "max-age=3600");
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch {
      res.status(502).end();
    }
  });
}
