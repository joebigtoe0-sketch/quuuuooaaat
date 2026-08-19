import fs from "node:fs";
import path from "node:path";
import { cfg } from "../../config.js";
import { log } from "../../log.js";

/**
 * Dev-history intel, loaded from the pumpmoney research exports:
 *  - creator_stats.json  {creator: [n_launches, n_graduated]} — 4.3MB archive
 *  - dev_watchlist_std.csv — 130 devs with proven standard-curve bond records
 *  - axiom_watchlist.csv  — 1,066 smart wallets (win-rate persistence r=0.52)
 *
 * These are point-in-time archive snapshots, refreshed whenever the research
 * pipeline reruns — good enough for a show's "I know this guy" moments.
 */
let creatorStats = new Map<string, [number, number]>();
let goodDevs = new Set<string>();
let primeDevs = new Set<string>(); // the ELITE list — the exact wallets the money bot snipes
let smartWallets = new Set<string>();

// LIVE overlay — the archive is a frozen snapshot; these counters update in
// real time from the launch feed (create -> launches++, migration -> bonds++),
// exactly like the money bot's causal counters. Persisted so reboots keep it.
let liveStats = new Map<string, [number, number]>(); // dev -> [launches, bonds] since snapshot
const mintDev = new Map<string, string>(); // mint -> dev (bounded)
const LIVE_FILE = () => path.join(cfg.dataDir, "creator_live.json");
let liveTimer: NodeJS.Timeout | null = null;
function saveLive(): void {
  if (liveTimer) return;
  liveTimer = setTimeout(() => {
    liveTimer = null;
    try {
      fs.writeFileSync(LIVE_FILE() + ".tmp", JSON.stringify({ stats: [...liveStats], mints: [...mintDev].slice(-20000) }));
      fs.renameSync(LIVE_FILE() + ".tmp", LIVE_FILE());
    } catch {}
  }, 2000);
}

export function noteLaunch(mint: string, dev: string | undefined): void {
  if (!dev || !mint) return;
  mintDev.set(mint, dev);
  if (mintDev.size > 25000) mintDev.delete(mintDev.keys().next().value!);
  const s = liveStats.get(dev) ?? [0, 0];
  s[0]++;
  liveStats.set(dev, s);
  saveLive();
}
export function noteMigration(mint: string): void {
  const dev = mintDev.get(mint);
  if (!dev) return;
  const s = liveStats.get(dev) ?? [0, 0];
  s[1]++;
  liveStats.set(dev, s);
  log.info("intel", `live bond counted for dev ${dev.slice(0, 8)}… (${s[1]}/${s[0]} since snapshot)`);
  saveLive();
}

export function loadIntel(): void {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, "creator_stats.json"), "utf8"));
    creatorStats = new Map(Object.entries(j) as [string, [number, number]][]);
    log.info("intel", `creator_stats: ${creatorStats.size.toLocaleString()} devs`);
  } catch {
    log.warn("intel", "creator_stats.json missing — dev history disabled");
  }
  try {
    const l = JSON.parse(fs.readFileSync(LIVE_FILE(), "utf8"));
    liveStats = new Map(l.stats ?? []);
    for (const [m, d] of l.mints ?? []) mintDev.set(m, d);
    log.info("intel", `live creator overlay: ${liveStats.size} devs tracked since snapshot`);
  } catch { /* fresh overlay */ }
  for (const [file, set, col] of [
    ["dev_watchlist_std.csv", goodDevs, 0],
    ["dev_watchlist_prime.csv", primeDevs, 0],
    ["axiom_watchlist.csv", smartWallets, 0],
  ] as const) {
    try {
      const lines = fs.readFileSync(path.join(cfg.dataDir, file), "utf8").split("\n").slice(1);
      for (const line of lines) {
        const v = line.split(",")[col]?.trim();
        if (v && v.length >= 32) set.add(v);
      }
      log.info("intel", `${file}: ${set.size} entries`);
    } catch {
      log.warn("intel", `${file} missing`);
    }
  }
}

export interface DevHistory {
  known: boolean;
  launches: number;
  bonds: number;
  bondRate: number;
  onWatchlist: boolean;
}

/** Is this creator on the ELITE prime list (the money bot's exact wallets)? */
export function primeDev(creator: string | null): boolean {
  return !!creator && primeDevs.has(creator);
}

export function devHistory(creator: string | null): DevHistory {
  if (!creator) return { known: false, launches: 0, bonds: 0, bondRate: 0, onWatchlist: false };
  const s = creatorStats.get(creator);
  const l = liveStats.get(creator);
  // archive snapshot + live overlay = the dev's record as of RIGHT NOW
  const launches = (s?.[0] ?? 0) + (l?.[0] ?? 0);
  const bonds = (s?.[1] ?? 0) + (l?.[1] ?? 0);
  if (launches === 0) return { known: false, launches: 0, bonds: 0, bondRate: 0, onWatchlist: goodDevs.has(creator) };
  return {
    known: true,
    launches,
    bonds,
    bondRate: bonds / launches,
    onWatchlist: goodDevs.has(creator),
  };
}

export function smartWalletsAmong(owners: string[]): string[] {
  return owners.filter((o) => smartWallets.has(o));
}
