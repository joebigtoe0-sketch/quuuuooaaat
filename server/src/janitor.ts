import fs from "node:fs";
import path from "node:path";
import { cfg } from "./config.js";
import { log } from "./log.js";

/**
 * Disk janitor — the volume only grows without this. TTS audio is spoken
 * once (never replayed after ~minutes), clips/selfies are posted shortly
 * after recording — everything is dead weight after a day. Hourly sweep
 * deletes audio, clips and selfies older than 24h
 */

const RULES: { dir: () => string; maxAgeMs: number }[] = [
  { dir: () => cfg.audioDir, maxAgeMs: 24 * 3600_000 },
  { dir: () => cfg.clipsDir, maxAgeMs: 24 * 3600_000 },
  { dir: () => path.join(cfg.dataDir, "selfies"), maxAgeMs: 24 * 3600_000 },
];

function sweepDir(dir: string, maxAgeMs: number): { n: number; bytes: number } {
  let n = 0, bytes = 0;
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return { n, bytes }; }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of names) {
    const f = path.join(dir, name);
    try {
      const st = fs.statSync(f);
      if (!st.isFile() || st.mtimeMs > cutoff) continue;
      bytes += st.size;
      fs.unlinkSync(f);
      n++;
    } catch {}
  }
  return { n, bytes };
}

export function sweepDisk(): void {
  let totalN = 0, totalBytes = 0;
  for (const r of RULES) {
    const { n, bytes } = sweepDir(r.dir(), r.maxAgeMs);
    totalN += n;
    totalBytes += bytes;
  }
  if (totalN) log.info("janitor", `swept ${totalN} stale files, freed ${(totalBytes / 1e6).toFixed(1)} MB`);
}

/** Sizes per top-level entry of dataDir — the "what is eating the volume" view. */
export function diskUsage(): { entry: string; mb: number; files: number }[] {
  const out: { entry: string; mb: number; files: number }[] = [];
  const duDir = (dir: string): { bytes: number; files: number } => {
    let bytes = 0, files = 0;
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return { bytes, files }; }
    for (const name of names) {
      const f = path.join(dir, name);
      try {
        const st = fs.statSync(f);
        if (st.isDirectory()) {
          const sub = duDir(f);
          bytes += sub.bytes;
          files += sub.files;
        } else {
          bytes += st.size;
          files++;
        }
      } catch {}
    }
    return { bytes, files };
  };
  let names: string[] = [];
  try { names = fs.readdirSync(cfg.dataDir); } catch { return out; }
  for (const name of names) {
    const f = path.join(cfg.dataDir, name);
    try {
      const st = fs.statSync(f);
      const d = st.isDirectory() ? duDir(f) : { bytes: st.size, files: 1 };
      out.push({ entry: name + (st.isDirectory() ? "/" : ""), mb: +(d.bytes / 1e6).toFixed(1), files: d.files });
    } catch {}
  }
  return out.sort((a, b) => b.mb - a.mb);
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startJanitor(): void {
  if (timer) return;
  timer = setInterval(sweepDisk, 3600_000);
  setTimeout(sweepDisk, 30_000); // first sweep shortly after boot
  log.info("janitor", "disk janitor on — audio/clips/selfies >24h, hourly");
}
