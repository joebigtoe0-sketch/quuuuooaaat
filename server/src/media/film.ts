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
    const ok = await transcode(webmPath, mp4Path);
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

function transcode(inPath: string, outPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(false);
    const args = [
      "-y",
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
    const t = setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 120_000);
    proc.on("exit", (code) => {
      clearTimeout(t);
      resolve(code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 10_000);
    });
    proc.on("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}
