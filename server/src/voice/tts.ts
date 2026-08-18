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
  synthesize(text: string, id: string): Promise<Synthesis>;
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
  for (; i < buf.length - 4; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const ver = (buf[i + 1] >> 3) & 0x3;
    const bitrate = (ver === 3 ? V1L3 : V2L3)[(buf[i + 2] >> 4) & 0xf];
    const sr = (ver === 3 ? SR1 : ver === 2 ? SR2 : SR25)[(buf[i + 2] >> 2) & 0x3];
    if (!bitrate || !sr) continue;
    return Math.round(((buf.length - i) * 8) / bitrate); // ms = bytes*8 / kbps
  }
  return null;
}

/** Silent fallback: no audio, estimated pacing, subtitles do the work. */
export class SilentTTS implements TTSProvider {
  async synthesize(text: string): Promise<Synthesis> {
    const { durMs, words } = estimateTimings(text);
    return { audioUrl: null, durMs, words };
  }
}
