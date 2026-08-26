import fs from "node:fs";
import path from "node:path";
import { cfg } from "../config.js";
import { log } from "../log.js";
import { estimateTimings, mp3DurationMs, spreadWords, type Synthesis, type TTSProvider } from "./tts.js";

/**
 * OpenAI (or any OpenAI-compatible) /audio/speech. High quality, reliable, and
 * reuses the LLM credentials — the recommended voice. Returns mp3 directly.
 * No word-boundary metadata, so subtitle timings are estimated from word count
 * (provider-independent, good enough for pacing; audio plays its natural length
 * and the director waits durMs + padding).
 */
export class OpenAITTS implements TTSProvider {
  private failStreak = 0;

  async synthesize(text: string, id: string, voice?: string): Promise<Synthesis> {
    if (!cfg.ttsApiKey) {
      if (this.failStreak++ === 0)
        log.warn("tts", "TTS_PROVIDER=openai but TTS_API_KEY is empty — falling back to subtitles");
      return { audioUrl: null, ...estimateTimings(text) };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(`${cfg.ttsBaseUrl}/audio/speech`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.ttsApiKey}` },
        body: JSON.stringify({
          model: cfg.ttsOpenaiModel,
          voice: voice || cfg.ttsVoice,
          input: text.slice(0, 900),
          response_format: "mp3",
          speed: cfg.ttsOpenaiSpeed,
        }),
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`http ${res.status}: ${(await res.text()).slice(0, 140)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500) throw new Error("empty audio");
      fs.mkdirSync(cfg.audioDir, { recursive: true });
      fs.writeFileSync(path.join(cfg.audioDir, `${id}.mp3`), buf);
      this.failStreak = 0;
      const realMs = mp3DurationMs(buf);
      const words = text.split(/\s+/).filter(Boolean);
      const timed = realMs
        ? spreadWords(words, realMs)
        : (() => {
            const est = estimateTimings(text);
            return { durMs: Math.round(est.durMs / cfg.ttsOpenaiSpeed), words: est.words };
          })();
      return { audioUrl: `/audio/${id}.mp3`, ...timed };
    } catch (e) {
      if (this.failStreak++ < 3 || this.failStreak % 10 === 0)
        log.warn("tts", `openai synthesis failed (${this.failStreak}x): ${String(e).slice(0, 140)}`);
      return { audioUrl: null, ...estimateTimings(text) };
    }
  }
}
