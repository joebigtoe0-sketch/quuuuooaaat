/**
 * "The line has actually finished playing" — reported by the stage client.
 *
 * The server knows exactly how long an mp3 IS (frame-walked, accurate to a few
 * ms). What it cannot know is when the browser actually STARTED it: fetch,
 * decode and autoplay latency all sit between the cue and the first sample.
 * Every previous fix for "the last words get cut off" was a bigger fixed pad
 * (900ms, 1100ms, 1200ms), which is a guess that fails whenever the client is
 * momentarily slower than the guess. The client knows the true end, so it
 * tells us, and playback waits for that instead.
 */
const waiters = new Map<string, () => void>();

/** Called by the stage client when a spoken line finished (or was skipped). */
export function markSpoken(id: string): void {
  const done = waiters.get(id);
  if (done) {
    waiters.delete(id);
    done();
  }
}

/** Resolves on the client's ack, or at capMs if the ack never arrives (no
 *  stage connected, a reload mid-line) so a show can never hang on a promise. */
export function waitSpoken(id: string, capMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      resolve();
    }, Math.max(1000, capMs));
    waiters.set(id, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
