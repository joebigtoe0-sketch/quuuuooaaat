import fs from "node:fs";
import path from "node:path";
import { cfg } from "../config.js";
import { log } from "../log.js";
import { estimateTimings, mp3DurationMs, spreadWords, type Synthesis, type TTSProvider } from "./tts.js";

/**
 * Google Translate TTS — completely free, no API key. The endpoint caps input
 * at ~200 chars, so we split on sentence boundaries and concatenate the mp3
 * chunks (raw mp3 frames concatenate cleanly). Robotic but reliable; a good
 * zero-cost default when no LLM key is available.
 */
function chunk(text: string, max = 180): string[] {
  const parts: string[] = [];
  let cur = "";
  for (const sentence of text.split(/(?<=[.!?,])\s+/)) {
    if ((cur + " " + sentence).trim().length > max) {
      if (cur) parts.push(cur.trim());
      // hard-split any single oversize sentence
      if (sentence.length > max) {
        for (let i = 0; i < sentence.length; i += max) parts.push(sentence.slice(i, i + max));
        cur = "";
      } else cur = sentence;
    } else {
      cur = (cur + " " + sentence).trim();
    }
  }
  if (cur) parts.push(cur.trim());
  return parts.length ? parts : [text.slice(0, max)];
}

export class GoogleTTS implements TTSProvider {
  private failStreak = 0;

  async synthesize(text: string, id: string): Promise<Synthesis> {
    try {
      const parts = chunk(text);
      const buffers: Buffer[] = [];
      for (const p of parts) {
        const url =
          `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&total=${parts.length}` +
          `&idx=0&textlen=${p.length}&q=${encodeURIComponent(p)}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", referer: "https://translate.google.com/" },
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`http ${res.status}`);
        buffers.push(Buffer.from(await res.arrayBuffer()));
      }
      const buf = Buffer.concat(buffers);
      if (buf.length < 500) throw new Error("empty audio");
      fs.mkdirSync(cfg.audioDir, { recursive: true });
      fs.writeFileSync(path.join(cfg.audioDir, `${id}.mp3`), buf);
      this.failStreak = 0;
      const realMs = mp3DurationMs(buf);
      const words = text.split(/\s+/).filter(Boolean);
      const timed = realMs ? spreadWords(words, realMs) : estimateTimings(text);
      return { audioUrl: `/audio/${id}.mp3`, ...timed };
    } catch (e) {
      if (this.failStreak++ < 3 || this.failStreak % 10 === 0)
        log.warn("tts", `gtts synthesis failed (${this.failStreak}x): ${String(e).slice(0, 140)}`);
      return { audioUrl: null, ...estimateTimings(text) };
    }
  }
}
