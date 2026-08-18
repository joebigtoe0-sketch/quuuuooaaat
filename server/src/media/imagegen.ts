import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { cfg } from "../config.js";
import { store } from "../store.js";
import { log } from "../log.js";

/**
 * Meme/image generation for tweets — OpenAI images API on the TTS key
 * (the brain runs on Anthropic, which doesn't do images). Daily cap so a
 * meme-happy day can't torch the budget.
 */
const MAX_IMAGES_PER_DAY = Number(process.env.IMAGES_PER_DAY ?? 2);
const dayKey = () => `images:${new Date().toISOString().slice(0, 10)}`;
export const imagesToday = () => Number(store.kvGet(dayKey()) ?? 0);
export const imagesLeftToday = () => Math.max(0, MAX_IMAGES_PER_DAY - imagesToday());

export async function genTweetImage(prompt: string): Promise<string | null> {
  if (!cfg.ttsApiKey) return null;
  if (imagesToday() >= MAX_IMAGES_PER_DAY) {
    log.info("image", `daily image cap reached (${MAX_IMAGES_PER_DAY})`);
    return null;
  }
  if (cfg.simMode) {
    const dir = path.join(cfg.dataDir, "images");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `sim_${crypto.randomBytes(4).toString("hex")}.png`);
    // 1x1 png placeholder — the point is the flow, not the pixels
    fs.writeFileSync(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
    store.kvSet(dayKey(), String(imagesToday() + 1));
    log.info("image", `[SIM] generated meme for: "${prompt.slice(0, 80)}"`);
    return file;
  }
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 90_000);
    const res = await fetch(`${cfg.ttsBaseUrl}/images/generations`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.ttsApiKey}` },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: prompt.slice(0, 900),
        size: "1024x1024",
        quality: "low",
        n: 1,
      }),
    });
    clearTimeout(t);
    if (!res.ok) {
      log.warn("image", `generation failed: http ${res.status}`);
      return null;
    }
    const j: any = await res.json();
    const b64 = j?.data?.[0]?.b64_json;
    if (!b64) return null;
    const dir = path.join(cfg.dataDir, "images");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${crypto.randomBytes(6).toString("hex")}.png`);
    fs.writeFileSync(file, Buffer.from(b64, "base64"));
    store.kvSet(dayKey(), String(imagesToday() + 1));
    log.info("image", `generated ${path.basename(file)} (${imagesToday()}/${MAX_IMAGES_PER_DAY} today)`);
    return file;
  } catch (e) {
    log.warn("image", `generation error: ${String(e).slice(0, 100)}`);
    return null;
  }
}
