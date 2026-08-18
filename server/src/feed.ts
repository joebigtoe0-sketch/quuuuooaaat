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

export function bindFeed(fn: (e: FeedEntry) => void): void {
  broadcast = fn;
}

/** sys/warn/error lines are INTERNAL: producer's log only, never the stream. */
export const isInternalKind = (kind: string): boolean => /^(sys|warn|error):/.test(kind);

export function pushFeed(kind: string, text: string): void {
  const e: FeedEntry = { at: Date.now(), kind, text: String(text).slice(0, 2000) };
  entries.push(e);
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
