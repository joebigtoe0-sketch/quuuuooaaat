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
let smartWallets = new Set<string>();

export function loadIntel(): void {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, "creator_stats.json"), "utf8"));
    creatorStats = new Map(Object.entries(j) as [string, [number, number]][]);
    log.info("intel", `creator_stats: ${creatorStats.size.toLocaleString()} devs`);
  } catch {
    log.warn("intel", "creator_stats.json missing — dev history disabled");
  }
  for (const [file, set, col] of [
    ["dev_watchlist_std.csv", goodDevs, 0],
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

export function devHistory(creator: string | null): DevHistory {
  if (!creator) return { known: false, launches: 0, bonds: 0, bondRate: 0, onWatchlist: false };
  const s = creatorStats.get(creator);
  if (!s) return { known: false, launches: 0, bonds: 0, bondRate: 0, onWatchlist: goodDevs.has(creator) };
  return {
    known: true,
    launches: s[0],
    bonds: s[1],
    bondRate: s[0] > 0 ? s[1] / s[0] : 0,
    onWatchlist: goodDevs.has(creator),
  };
}

export function smartWalletsAmong(owners: string[]): string[] {
  return owners.filter((o) => smartWallets.has(o));
}
