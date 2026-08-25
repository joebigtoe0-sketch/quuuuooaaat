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
    // tiktok clips: chop the dead lead-in (recorder warmup + TTS latency) —
    // silent opening seconds lose the scroll
    const startAt = id.startsWith("tiktok-") ? await detectFirstSound(webmPath) : 0;
    const ok = await transcode(webmPath, mp4Path, startAt);
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

/** First audible moment (s) via silencedetect — 0 if audio starts hot. */
function detectFirstSound(inPath: string): Promise<number> {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(0);
    const proc = spawn(ffmpegPath as unknown as string,
      ["-i", inPath, "-af", "silencedetect=noise=-40dB:d=0.3", "-f", "null", "-"],
      { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr!.on("data", (d) => (err += String(d)));
    const t = setTimeout(() => { proc.kill(); resolve(0); }, 30_000);
    proc.on("exit", () => {
      clearTimeout(t);
      // leading silence = a silence that STARTS at ~0; its end is our cut
      const m = err.match(/silence_start:\s*(-?[\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/);
      if (m && parseFloat(m[1]) < 0.4) return resolve(Math.max(0, parseFloat(m[2]) - 0.25));
      resolve(0);
    });
  });
}

function transcode(inPath: string, outPath: string, startAt = 0): Promise<boolean> {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(false);
    const args = [
      "-y",
      ...(startAt > 0.05 ? ["-ss", startAt.toFixed(2)] : []),
      "-i", inPath,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", // even dims for h264
      "-c:a", "aac",
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
