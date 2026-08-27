import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { cfg } from "../config.js";
import { log } from "../log.js";
import { estimateTimings, mp3DurationMs, spreadWords, type Synthesis, type TTSProvider } from "./tts.js";

/**
 * PIPER — neural TTS running INSIDE the container. No key, no credits, no rate
 * limit, no unofficial endpoint anyone can switch off. A character who talks
 * ~4.5 hours a day costs $0 here instead of ~$4/day on a metered API, and can
 * never again be silenced by a drained prepaid balance.
 *
 * The binary and voices are baked into the image (see Dockerfile). If either is
 * missing — a local Windows dev box, a build that skipped the download — this
 * provider reports unavailable at construction and the chain moves straight to
 * the next one, so a missing model never costs a spawn per line.
 *
 * piper emits raw 16-bit mono PCM on stdout; ffmpeg-static (already a dep for
 * films) turns it into the mp3 the rest of the stack expects.
 */

interface VoiceModel {
  onnx: string;
  sampleRate: number;
}

/** Map a requested voice name onto an installed model. Callers hand us OpenAI
 *  voice names ("onyx", "nova") and podcast guest voices — neither means
 *  anything to piper, and passing one straight through is exactly the bug that
 *  made TTS_PROVIDER=edge fail on every single line. */
function resolveModelFile(voice: string | undefined): string {
  const dir = cfg.piperVoiceDir;
  const want = (voice ?? "").toLowerCase();
  // an explicit model name or path wins, when it is actually installed
  if (want) {
    const direct = want.endsWith(".onnx") ? want : `${want}.onnx`;
    for (const cand of [direct, path.join(dir, path.basename(direct))]) {
      try { if (fs.existsSync(cand)) return cand; } catch {}
    }
  }
  // otherwise pick by timbre: the guest voice must not sound like the host
  const feminine = /amy|nova|shimmer|alloy|coral|sage|female|woman|girl/.test(want);
  const pick = feminine ? cfg.piperVoiceAlt : cfg.piperVoice;
  return path.isAbsolute(pick) ? pick : path.join(dir, pick.endsWith(".onnx") ? pick : `${pick}.onnx`);
}

function sampleRateOf(onnx: string): number {
  try {
    const meta = JSON.parse(fs.readFileSync(`${onnx}.json`, "utf8"));
    const sr = Number(meta?.audio?.sample_rate);
    if (Number.isFinite(sr) && sr > 0) return sr;
  } catch { /* medium-quality piper voices are 22.05k */ }
  return 22050;
}

export class PiperTTS implements TTSProvider {
  private failStreak = 0;
  private readonly models = new Map<string, VoiceModel>();
  readonly available: boolean;
  readonly why: string;

  constructor() {
    const bin = cfg.piperBin;
    const model = resolveModelFile(undefined);
    const hasBin = (() => { try { return fs.existsSync(bin); } catch { return false; } })();
    const hasModel = (() => { try { return fs.existsSync(model); } catch { return false; } })();
    this.available = hasBin && hasModel && !!ffmpegPath;
    this.why = !hasBin ? `no piper binary at ${bin}`
      : !hasModel ? `no voice model at ${model}`
      : !ffmpegPath ? "ffmpeg-static missing"
      : `${path.basename(model)} @ ${sampleRateOf(model)}Hz`;
  }

  private model(voice?: string): VoiceModel {
    const onnx = resolveModelFile(voice);
    let m = this.models.get(onnx);
    if (!m) {
      m = { onnx, sampleRate: sampleRateOf(onnx) };
      this.models.set(onnx, m);
    }
    return m;
  }

  async synthesize(text: string, id: string, voice?: string): Promise<Synthesis> {
    if (!this.available) return { audioUrl: null, ...estimateTimings(text) };
    const line = text.replace(/\s+/g, " ").trim();
    if (!line) return { audioUrl: null, ...estimateTimings(text) };
    const { onnx, sampleRate } = this.model(voice);
    fs.mkdirSync(cfg.audioDir, { recursive: true });
    const file = path.join(cfg.audioDir, `${id}.mp3`);

    try {
      await new Promise<void>((resolve, reject) => {
        const piper = spawn(cfg.piperBin, [
          "--model", onnx,
          "--output-raw",
          "--length_scale", String(cfg.piperLengthScale),
          "--sentence_silence", String(cfg.piperSentenceSilence),
        ], { stdio: ["pipe", "pipe", "pipe"] });
        const ff = spawn(ffmpegPath as string, [
          "-hide_banner", "-loglevel", "error",
          "-f", "s16le", "-ar", String(sampleRate), "-ac", "1", "-i", "pipe:0",
          "-codec:a", "libmp3lame", "-b:a", "64k", "-y", file,
        ], { stdio: ["pipe", "ignore", "pipe"] });

        // the show must never block on a wedged subprocess
        const timer = setTimeout(() => {
          try { piper.kill("SIGKILL"); } catch {}
          try { ff.kill("SIGKILL"); } catch {}
          reject(new Error(`timeout after ${cfg.piperTimeoutMs}ms`));
        }, cfg.piperTimeoutMs);

        let err = "";
        piper.stderr.on("data", (d) => { err += String(d).slice(0, 200); });
        ff.stderr.on("data", (d) => { err += String(d).slice(0, 200); });
        piper.stdout.pipe(ff.stdin);
        piper.on("error", (e) => { clearTimeout(timer); reject(e); });
        ff.on("error", (e) => { clearTimeout(timer); reject(e); });
        ff.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg exit ${code}${err ? `: ${err.slice(0, 160)}` : ""}`));
        });
        piper.stdin.write(line + "\n");
        piper.stdin.end();
      });

      const buf = fs.readFileSync(file);
      if (buf.length < 500) throw new Error("empty audio");
      this.failStreak = 0;
      const realMs = mp3DurationMs(buf);
      const words = line.split(/\s+/).filter(Boolean);
      const timed = realMs ? spreadWords(words, realMs) : estimateTimings(text);
      return { audioUrl: `/audio/${id}.mp3`, ...timed };
    } catch (e) {
      try { fs.rmSync(file, { force: true }); } catch {}
      if (this.failStreak++ < 3 || this.failStreak % 10 === 0)
        log.warn("tts", `piper synthesis failed (${this.failStreak}x): ${String(e).slice(0, 160)}`);
      return { audioUrl: null, ...estimateTimings(text) };
    }
  }
}
