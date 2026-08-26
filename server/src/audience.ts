import { cfg } from "./config.js";
import { allChat } from "./social/livechat.js";

/**
 * HOW BUSY IS THE ROOM — the honest version.
 *
 * There is no real viewer count available: pump.fun's livechat socket only
 * carries messages, and `hub.watchers` counts WebSocket clients (OBS plus any
 * open tab), not people. So the audience signal is built from what we can
 * actually observe:
 *   - distinct chatters in the last AUDIENCE_WINDOW_MIN minutes
 *   - whether anything is even rendering the stream (watchers > 0)
 *
 * QUIET = nobody has said anything for AUDIENCE_WINDOW_MIN minutes. People
 * lurk far more than they type, so ONE message is enough to call the room
 * live again — the saver is for genuinely dead hours, not slow ones.
 *
 * Quiet room → the show costs less: research runs less often and the brain
 * drops to the cheap model. Nobody is watching the expensive verdict.
 *
 * NOTE: RIKU must never state a viewer number out loud — we do not have one.
 * This gates spending, it is not a stat for the script.
 */

let watchersFn: (() => number) | null = null;
export function bindWatchers(fn: () => number): void {
  watchersFn = fn;
}

export interface Audience {
  chatters: number; // distinct people who spoke in the window
  messages: number;
  watchers: number; // rendering clients (OBS/tabs) — presence, not people
  quiet: boolean;
}

export function audience(): Audience {
  const since = Date.now() - cfg.audienceWindowMin * 60_000;
  const recent = allChat(200).filter((m) => m.at >= since);
  const chatters = new Set(recent.map((m) => m.user.toLowerCase())).size;
  const watchers = watchersFn?.() ?? 0;
  // ONE message in the window wakes the room up; silence for the whole
  // window (or nothing rendering at all) means save.
  const quiet = watchers === 0 || recent.length === 0;
  return { chatters, messages: recent.length, watchers, quiet };
}

export const isQuiet = (): boolean => cfg.audienceSaver && audience().quiet;

/** Model to use for a piece of show writing: the cheap one when nobody's in. */
export function showModel(normal: string, cheap: string): string {
  return isQuiet() ? cheap : normal;
}
