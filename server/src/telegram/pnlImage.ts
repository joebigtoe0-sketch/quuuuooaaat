import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { cfg } from "../config.js";
import { log } from "../log.js";

/**
 * The /pnl card — a shareable image, not a text block.
 *
 * The background art puts Riku on the RIGHT and leaves the left third dark, so
 * every element is laid out in a left column against that empty space. Anton
 * ships in the repo (client/public/fonts) and is registered explicitly rather
 * than trusted to exist: a Debian container has almost no fonts, and unnamed
 * font families there render as blank boxes or nothing at all.
 */

const W = 1731;
const H = 909;
const PAD = 110;

const GREEN = "#4ade80";
const RED = "#f87171";
const DIM = "#9ca3af";
const WHITE = "#f8fafc";

let bgCache: Awaited<ReturnType<typeof loadImage>> | null = null;
let fontsReady = false;
function ensureFonts(): void {
  if (fontsReady) return;
  const root = path.join(cfg.root, "..", "client", "public", "fonts");
  for (const [file, family] of [["Anton-Regular.ttf", "Anton"]] as const) {
    const p = path.join(root, file);
    try {
      if (fs.existsSync(p)) GlobalFonts.registerFromPath(p, family);
      else log.warn("tgpnl", `font missing: ${p}`);
    } catch (e) {
      log.warn("tgpnl", `font register failed: ${String(e).slice(0, 60)}`);
    }
  }
  fontsReady = true;
}

/** Anton for display, a system sans for body — with a stack, because the
 *  container's font set is not something to assume. */
const DISPLAY = (px: number) => `${px}px Anton, "DejaVu Sans", sans-serif`;
const BODY = (px: number, weight = "") => `${weight} ${px}px "DejaVu Sans", Arial, sans-serif`.trim();

function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "?";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(0)}`;
}

/** "38d 11h 35m" — the reference card's exact shape */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function roundRect(c: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

export interface PnlCardInput {
  symbol: string;
  multiple: number;
  calledAtMcUsd: number | null;
  calledAt: number;
  callerName: string;
  /** raw bytes of the caller's Telegram avatar, if we could fetch one */
  avatar?: Buffer | null;
  /** shown when the coin is still being tracked rather than final */
  live?: boolean;
}

export async function renderPnlCard(x: PnlCardInput): Promise<Buffer> {
  ensureFonts();
  const canvas = createCanvas(W, H);
  const c = canvas.getContext("2d");

  // ---- background art ----
  // decoded once: the source is 1.4MB and a card should not pay for that twice
  try {
    if (!bgCache) {
      bgCache = await loadImage(path.join(cfg.root, "..", "client", "public", "media", "tgpnlbackground.png"));
    }
    c.drawImage(bgCache, 0, 0, W, H);
  } catch (e) {
    // LOUD. The first deploy of this shipped without the art because the png
    // was never git-added, and a silent fallback made it look intentional.
    log.warn("tgpnl", `background art missing — flat fallback: ${String(e).slice(0, 100)}`);
    c.fillStyle = "#0b0d0a";
    c.fillRect(0, 0, W, H);
  }
  // darken the left column so text always reads, whatever the art does there
  const grad = c.createLinearGradient(0, 0, W * 0.62, 0);
  grad.addColorStop(0, "rgba(0,0,0,0.82)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = grad;
  c.fillRect(0, 0, W, H);

  const up = x.multiple >= 1;
  const accent = up ? GREEN : RED;

  // ---- brand, top left ----
  c.fillStyle = accent;
  roundRect(c, PAD, 76, 13, 44, 6);
  c.fill();
  c.fillStyle = WHITE;
  c.font = BODY(38, "bold");
  c.textBaseline = "alphabetic";
  c.fillText("QuantRIKUbot", PAD + 32, 112);

  // ---- ticker ----
  c.fillStyle = accent;
  c.font = DISPLAY(84);
  c.fillText(`$${x.symbol.toUpperCase()}`, PAD, 306);

  // ---- the number, the whole point of the card ----
  const mult = x.multiple >= 10 ? x.multiple.toFixed(0) : x.multiple.toFixed(2).replace(/0$/, "");
  c.font = DISPLAY(230);
  c.fillStyle = WHITE;
  c.shadowColor = up ? "rgba(74,222,128,0.45)" : "rgba(248,113,113,0.4)";
  c.shadowBlur = 44;
  c.fillText(`${mult}x`, PAD - 6, 566);
  c.shadowBlur = 0;

  // ---- called at / elapsed ----
  c.font = BODY(34);
  c.fillStyle = DIM;
  const calledText = `Called at ${money(x.calledAtMcUsd)}`;
  c.fillText(calledText, PAD, 646);
  const wCalled = c.measureText(calledText).width;
  // the little status dot from the reference
  c.beginPath();
  c.arc(PAD + wCalled + 34, 635, 9, 0, Math.PI * 2);
  c.fillStyle = x.live ? accent : DIM;
  c.fill();
  c.fillStyle = DIM;
  c.fillText(elapsed(Date.now() - x.calledAt), PAD + wCalled + 56, 646);

  // ---- caller pill, bottom ----
  const pillH = 96;
  const pillY = H - PAD - pillH + 20;
  c.font = BODY(38, "bold");
  const nameW = c.measureText(x.callerName).width;
  const pillW = Math.min(760, 40 + 64 + 24 + nameW + 40);
  c.fillStyle = "rgba(12,16,12,0.72)";
  roundRect(c, PAD, pillY, pillW, pillH, pillH / 2);
  c.fill();
  c.strokeStyle = "rgba(255,255,255,0.10)";
  c.lineWidth = 2;
  c.stroke();

  const avX = PAD + 20;
  const avY = pillY + 16;
  const avD = 64;
  let drew = false;
  if (x.avatar) {
    try {
      const img = await loadImage(x.avatar);
      c.save();
      c.beginPath();
      c.arc(avX + avD / 2, avY + avD / 2, avD / 2, 0, Math.PI * 2);
      c.clip();
      c.drawImage(img, avX, avY, avD, avD);
      c.restore();
      drew = true;
    } catch { /* fall through to the initial */ }
  }
  if (!drew) {
    c.beginPath();
    c.arc(avX + avD / 2, avY + avD / 2, avD / 2, 0, Math.PI * 2);
    c.fillStyle = accent;
    c.fill();
    c.fillStyle = "#0b0d0a";
    c.font = BODY(34, "bold");
    c.textAlign = "center";
    c.fillText(x.callerName.replace(/^@/, "").slice(0, 1).toUpperCase(), avX + avD / 2, avY + avD / 2 + 12);
    c.textAlign = "left";
  }
  c.fillStyle = WHITE;
  c.font = BODY(38, "bold");
  c.fillText(x.callerName, avX + avD + 24, pillY + pillH / 2 + 13);

  return canvas.toBuffer("image/png");
}

/** The caller's Telegram avatar, if they have one and it's reachable. */
export async function fetchAvatar(token: string, userId: string): Promise<Buffer | null> {
  try {
    const ps = await fetch(`https://api.telegram.org/bot${token}/getUserProfilePhotos?user_id=${userId}&limit=1`)
      .then((r) => r.json() as any);
    const sizes = ps?.result?.photos?.[0];
    if (!Array.isArray(sizes) || !sizes.length) return null;
    // smallest that is still >= 160px, else the largest available
    const pick = sizes.find((s: any) => s.width >= 160) ?? sizes[sizes.length - 1];
    const f = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${pick.file_id}`)
      .then((r) => r.json() as any);
    const p = f?.result?.file_path;
    if (!p) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${p}`);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}
