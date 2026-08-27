import { log } from "../log.js";

export interface WordTiming {
  word: string;
  atMs: number;
}

export interface Synthesis {
  audioUrl: string | null; // null = silent mode (subtitles carry the show)
  durMs: number;
  words: WordTiming[];
}

export interface TTSProvider {
  /** `voice` overrides the configured voice — the podcast guest needs one. */
  synthesize(text: string, id: string, voice?: string): Promise<Synthesis>;
}

/** Estimate speech duration + word timings when the provider gives none.
 *  Default ~430ms/word ≈ 140 wpm, which matches gtts/openai narration far
 *  better than the old 340ms (that raced ahead of the audio). */
export function estimateTimings(text: string, totalMs?: number): { durMs: number; words: WordTiming[] } {
  const words = text.split(/\s+/).filter(Boolean);
  const durMs = totalMs ?? Math.max(1200, words.length * 430);
  return spreadWords(words, durMs);
}

/** Spread word highlights evenly across a known total duration. */
export function spreadWords(words: string[], durMs: number): { durMs: number; words: WordTiming[] } {
  const per = durMs / Math.max(1, words.length);
  return { durMs, words: words.map((w, i) => ({ word: w, atMs: Math.round(i * per) })) };
}

/** Accurate duration of a CBR mp3 from its first frame header (gtts + openai
 *  are CBR). Returns ms, or null if it can't parse — caller falls back to the
 *  word estimate. */
export function mp3DurationMs(buf: Buffer): number | null {
  let i = 0;
  if (buf.length > 10 && buf.slice(0, 3).toString("latin1") === "ID3") {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    i = 10 + size;
  }
  const V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  const SR1 = [44100, 48000, 32000];
  const SR2 = [22050, 24000, 16000];
  const SR25 = [11025, 12000, 8000];
  // Walk EVERY frame and sum real frame durations — a first-frame bitrate
  // shortcut under-reads VBR files, which made subtitles/beats cut the last
  // words of every line. Frame walk is exact for CBR and VBR alike.
  let ms = 0;
  let frames = 0;
  while (i < buf.length - 4) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const ver = (buf[i + 1] >> 3) & 0x3; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layer = (buf[i + 1] >> 1) & 0x3; // 1 = Layer III
    const bitrate = (ver === 3 ? V1L3 : V2L3)[(buf[i + 2] >> 4) & 0xf];
    const sr = (ver === 3 ? SR1 : ver === 2 ? SR2 : SR25)[(buf[i + 2] >> 2) & 0x3];
    const pad = (buf[i + 2] >> 1) & 0x1;
    if (layer !== 1 || !bitrate || !sr) { i++; continue; }
    const samples = ver === 3 ? 1152 : 576;
    const frameLen = Math.floor(((samples / 8) * bitrate * 1000) / sr) + pad;
    if (frameLen <= 0) { i++; continue; }
    ms += (samples / sr) * 1000;
    i += frameLen;
    frames++;
  }
  return frames > 10 ? Math.round(ms) : null;
}

/**
 * A CHAIN of providers, tried in order until one returns real audio.
 *
 * The old selector picked exactly ONE provider at boot, and a provider that
 * fails returns {audioUrl:null} rather than throwing — so when OpenAI's balance
 * hit zero, riku went silently mute for as long as it took a human to notice.
 * A live character needs a floor: local piper first (free, no key), a metered
 * API behind it, silence-with-subtitles only when everything is gone.
 */
export class ChainTTS implements TTSProvider {
  constructor(private readonly links: { name: string; provider: TTSProvider }[]) {}

  /** Whichever link last produced audio — surfaced on /health. */
  lastUsed: string | null = null;

  chainNames(): string[] {
    return this.links.map((l) => l.name);
  }

  async synthesize(text: string, id: string, voice?: string): Promise<Synthesis> {
    let fallback: Synthesis | null = null;
    for (const { name, provider } of this.links) {
      const out = await provider.synthesize(text, id, voice).catch(() => null);
      if (!out) continue;
      if (out.audioUrl) {
        if (this.lastUsed !== name) {
          log.info("tts", `voice is now coming from ${name}`);
          this.lastUsed = name;
        }
        return out;
      }
      // keep the first link's pacing estimate — they only differ cosmetically
      fallback ??= out;
    }
    if (this.lastUsed !== null) {
      log.warn("tts", "every TTS provider failed — running silent with subtitles");
      this.lastUsed = null;
    }
    return fallback ?? { audioUrl: null, ...estimateTimings(text) };
  }
}

/** Silent fallback: no audio, estimated pacing, subtitles do the work. */
export class SilentTTS implements TTSProvider {
  async synthesize(text: string): Promise<Synthesis> {
    const { durMs, words } = estimateTimings(text);
    return { audioUrl: null, durMs, words };
  }
}
