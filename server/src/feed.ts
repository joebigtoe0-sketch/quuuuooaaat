/**
 * The agent activity feed — everything Quant does or WOULD do (dry-run tweets,
 * plans, trades, films, lessons) with full untruncated text. Broadcast live to
 * the stage's terminal overlay and served at /admin/feed for history.
 * Deliberately import-free (besides types) so memory/x/planner can all push
 * without cycles.
 */
export interface FeedEntry {
  at: number;
  kind: string;
  text: string;
}

const entries: FeedEntry[] = [];
let broadcast: ((e: FeedEntry) => void) | null = null;

// ---- persistence: the log survives restarts (we deploy a lot) ----
// Append-only JSONL, flushed every 2s; loaded (tail) at boot; rewritten
// compact when it grows past ~2MB. Uses lazy imports so this module keeps
// its no-imports-at-top-level cycle safety.
let feedFile: string | null = null;
let pendingWrites: FeedEntry[] = [];
void (async () => {
  try {
    const [{ cfg }, fs, path] = await Promise.all([
      import("./config.js"),
      import("node:fs"),
      import("node:path"),
    ]);
    feedFile = path.join(cfg.dataDir, "feed.jsonl");
    try {
      const lines = fs.readFileSync(feedFile, "utf8").split("\n").filter(Boolean).slice(-600);
      const loaded: FeedEntry[] = [];
      for (const l of lines) {
        try {
          const e = JSON.parse(l);
          if (e && typeof e.at === "number" && typeof e.kind === "string") loaded.push(e);
        } catch {}
      }
      // history goes BEFORE anything pushed during boot
      entries.unshift(...loaded);
    } catch { /* first run — no file yet */ }
    setInterval(() => {
      if (!feedFile || !pendingWrites.length) return;
      const batch = pendingWrites;
      pendingWrites = [];
      try {
        fs.appendFileSync(feedFile, batch.map((e) => JSON.stringify(e)).join("\n") + "\n");
        if (fs.statSync(feedFile).size > 2_000_000) {
          fs.writeFileSync(feedFile, entries.slice(-600).map((e) => JSON.stringify(e)).join("\n") + "\n");
        }
      } catch {}
    }, 2_000).unref?.();
  } catch { /* persistence is best-effort; the live feed works regardless */ }
})();

export function bindFeed(fn: (e: FeedEntry) => void): void {
  broadcast = fn;
}

/** sys/warn/error lines are INTERNAL: producer's log only, never the stream. */
export const isInternalKind = (kind: string): boolean => /^(sys|warn|error):/.test(kind);

export function pushFeed(kind: string, text: string): void {
  const e: FeedEntry = { at: Date.now(), kind, text: String(text).slice(0, 2000) };
  entries.push(e);
  pendingWrites.push(e);
  if (entries.length > 600) entries.splice(0, entries.length - 600);
  try {
    if (!isInternalKind(kind)) broadcast?.(e); // viewers only see HIS activity
  } catch {}
}

/** The viewer-facing feed: his actions, nothing operational. */
export function feedHistory(limit = 150): FeedEntry[] {
  return entries.filter((e) => !isInternalKind(e.kind)).slice(-limit);
}

/** The producer's system log: layout/sys chatter, warnings, errors. */
export function systemLog(limit = 200): FeedEntry[] {
  return entries.filter((e) => isInternalKind(e.kind)).slice(-limit);
}
