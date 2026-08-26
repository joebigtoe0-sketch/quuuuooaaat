import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { cfg } from "../config.js";
import { log } from "../log.js";

/**
 * The greenscreen film pipeline. The stage client records its own canvas +
 * Quant's voice during the filming beat (MediaRecorder → webm), uploads it
 * here; ffmpeg (bundled ffmpeg-static, no system install) transcodes to the
 * mp4 X requires. Clips always land in data/clips as an archive; posting is
 * the X layer's problem.
 */
interface Pending {
  resolve: (file: string | null) => void;
  timer: NodeJS.Timeout;
}
const pending = new Map<string, Pending>();

export function expectClip(id: string, timeoutMs = 45_000): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, timeoutMs);
    pending.set(id, { resolve, timer });
  });
}

/** Express handler body: raw webm arrives from the stage client. */
export async function receiveClip(id: string, webm: Buffer): Promise<string | null> {
  try {
    fs.mkdirSync(cfg.clipsDir, { recursive: true });
    const webmPath = path.join(cfg.clipsDir, `${id}.webm`);
    fs.writeFileSync(webmPath, webm);
    const mp4Path = path.join(cfg.clipsDir, `${id}.mp4`);
    // tiktok + film clips: trim dead air on BOTH ends (recorder warmup and
    // the stop-lag after the last word)
    const trim = /^(tiktok|film|podcast)-/.test(id) ? await detectTrim(webmPath) : { startAt: 0, endAt: 0 };
    const ok = await transcode(webmPath, mp4Path, trim.startAt, trim.endAt);
    // the webm is only worth keeping when the transcode failed (it's the
    // sole copy then) — otherwise it just doubles clip disk
    if (ok) try { fs.unlinkSync(webmPath); } catch {}
    const finalPath = ok ? mp4Path : null;
    const p = pending.get(id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.resolve(finalPath);
    }
    log.info("film", `clip ${id}: ${webm.length} bytes webm → ${ok ? "mp4 ready" : "transcode FAILED (webm archived)"}`);
    return finalPath;
  } catch (e) {
    log.warn("film", `receive failed: ${String(e).slice(0, 120)}`);
    return null;
  }
}

/** Lead-in cut point and tail cut point (s) via silencedetect.
 *  startAt: end of a silence that begins at ~0 (recorder warmup + TTS lag).
 *  endAt:   start of a trailing silence that runs to EOF (stop-lag) — 0 = none. */
function detectTrim(inPath: string): Promise<{ startAt: number; endAt: number }> {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve({ startAt: 0, endAt: 0 });
    const proc = spawn(ffmpegPath as unknown as string,
      ["-i", inPath, "-af", "silencedetect=noise=-40dB:d=0.3", "-f", "null", "-"],
      { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr!.on("data", (d) => (err += String(d)));
    const t = setTimeout(() => { proc.kill(); resolve({ startAt: 0, endAt: 0 }); }, 30_000);
    proc.on("exit", () => {
      clearTimeout(t);
      let startAt = 0, endAt = 0;
      const starts = [...err.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => parseFloat(m[1]));
      const ends = [...err.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
      if (starts.length && starts[0] < 0.4 && ends.length) startAt = Math.max(0, ends[0] - 0.25);
      // trailing silence: one more start than ends means it runs to EOF
      if (starts.length > ends.length) endAt = starts[starts.length - 1] + 0.35;
      resolve({ startAt, endAt });
    });
  });
}

function transcode(inPath: string, outPath: string, startAt = 0, endAt = 0): Promise<boolean> {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(false);
    const args = [
      "-y",
      ...(startAt > 0.05 ? ["-ss", startAt.toFixed(2)] : []),
      ...(endAt > startAt + 1 ? ["-t", (endAt - startAt).toFixed(2)] : []),
      "-i", inPath,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", // even dims for h264
      // MediaRecorder canvas capture is VARIABLE framerate — when the GPU
      // stutters mid-take the timestamps go uneven and playback judders even
      // though no frame is missing. Resample to a hard 30fps CFR and keep
      // audio glued to it.
      "-r", "30",
      "-fps_mode", "cfr",
      "-c:a", "aac",
      "-af", "aresample=async=1:first_pts=0",
      "-b:a", "128k",
      "-movflags", "+faststart",
      outPath,
    ];
    const proc = spawn(ffmpegPath as unknown as string, args, { stdio: "ignore" });
    // long takes on a busy machine encode slower than realtime — 120s was
    // killing ffmpeg mid-write on a ~90s tiktok (the "corrupted file")
    const t = setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 300_000);
    proc.on("exit", (code) => {
      clearTimeout(t);
      const ok = code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 10_000;
      // a killed/failed run leaves an unfinalized mp4 (no moov atom — looks
      // big, plays nowhere): delete it so only real clips ever sit in clips/
      if (!ok) try { fs.unlinkSync(outPath); } catch {}
      resolve(ok);
    });
    proc.on("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}
