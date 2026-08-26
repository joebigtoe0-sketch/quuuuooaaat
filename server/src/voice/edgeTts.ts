import fs from "node:fs";
import path from "node:path";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { cfg } from "../config.js";
import { log } from "../log.js";
import { estimateTimings, type Synthesis, type TTSProvider } from "./tts.js";

/**
 * Free Microsoft Edge neural TTS via msedge-tts. Unofficial endpoint —
 * Microsoft has broken client tokens before, which is why every failure
 * degrades to silent-with-subtitles instead of stopping the show, and why
 * the provider sits behind the TTSProvider interface (ElevenLabs drop-in later).
 */
export class EdgeTTS implements TTSProvider {
  private failStreak = 0;

  async synthesize(text: string, id: string, voice?: string): Promise<Synthesis> {
    try {
      const tts = new MsEdgeTTS();
      await tts.setMetadata(voice || cfg.ttsVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      fs.mkdirSync(cfg.audioDir, { recursive: true });
      const file = path.join(cfg.audioDir, `${id}.mp3`);

      const words: { word: string; atMs: number }[] = [];
      await new Promise<void>((resolve, reject) => {
        const stream = tts.toStream(text, {
          rate: cfg.ttsRate,
          pitch: cfg.ttsPitch,
        } as any);
        const out = fs.createWriteStream(file);
        stream.on("data", (chunk: Buffer) => out.write(chunk));
        // some msedge-tts versions emit word boundaries as metadata events
        (stream as any).on?.("metadata", (m: any) => {
          try {
            const meta = typeof m === "string" ? JSON.parse(m) : m;
            const wb = meta?.Metadata?.[0];
            if (wb?.Type === "WordBoundary") {
              words.push({
                word: wb.Data?.text?.Text ?? "",
                atMs: Math.round((wb.Data?.Offset ?? 0) / 10000),
              });
            }
          } catch {}
        });
        stream.on("end", () => out.end(() => resolve()));
        stream.on("error", (e: Error) => reject(e));
        setTimeout(() => reject(new Error("tts timeout")), 20000);
      });

      const stat = fs.statSync(file);
      if (stat.size < 500) throw new Error("empty audio");
      // 48kbit/s mono mp3: ~6000 bytes/sec
      const durMs = Math.max(800, Math.round((stat.size / 6000) * 1000));
      this.failStreak = 0;
      const timings = words.length > 3 ? { durMs, words } : estimateTimings(text, durMs);
      return { audioUrl: `/audio/${id}.mp3`, durMs: timings.durMs, words: timings.words };
    } catch (e) {
      this.failStreak++;
      if (this.failStreak <= 3 || this.failStreak % 10 === 0)
        log.warn("tts", `edge synthesis failed (${this.failStreak}x): ${String(e).slice(0, 100)}`);
      const { durMs, words } = estimateTimings(text);
      return { audioUrl: null, durMs, words };
    }
  }
}
