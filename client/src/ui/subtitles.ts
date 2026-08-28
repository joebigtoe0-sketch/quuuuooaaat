/**
 * Karaoke subtitles + audio playback. Bottom-third DOM overlay (drawn over the
 * WebGL canvas), current word highlighted from server-provided word timings —
 * cheap and hugely improves watchability with a robot voice.
 */
export class Subtitles {
  private el: HTMLDivElement;
  private nameEl: HTMLDivElement;
  private audio = new Audio();
  private timer: number | null = null;

  constructor(parent: HTMLElement) {
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "position:absolute;left:0;right:0;bottom:70px;display:flex;flex-direction:column;align-items:center;gap:10px;pointer-events:none;z-index:10;";
    this.nameEl = document.createElement("div");
    this.nameEl.style.cssText =
      "color:#2affd4;font:bold 22px 'Consolas',monospace;letter-spacing:3px;text-shadow:0 2px 10px #000;opacity:0;";
    this.nameEl.textContent = "RIKU";
    this.el = document.createElement("div");
    this.el.style.cssText =
      "max-width:1400px;text-align:center;color:#eef4ff;font:600 40px 'Segoe UI',system-ui,sans-serif;" +
      "line-height:1.25;text-shadow:0 3px 14px #000,0 0 3px #000;padding:0 40px;";
    wrap.appendChild(this.nameEl);
    wrap.appendChild(this.el);
    parent.appendChild(wrap);
    this.audio.volume = 1.0;
  }

  /** The voice element — the stage recorder taps this for filmed clips. */
  get audioElement(): HTMLAudioElement {
    return this.audio;
  }

  private speakStart = 0;
  private speakDurMs = 0;
  /** The TRUE speech clock: audio position when audio drives, wall clock
   *  otherwise — plus the factor that maps server word times to real audio
   *  duration. The avatar's mouth syncs to this, same as the karaoke. */
  speechClock(): { ms: number; scale: number } {
    const hasAudio = !!this.audio.src && this.audio.duration > 0 && !this.audio.paused;
    const ms = hasAudio ? this.audio.currentTime * 1000 : performance.now() - this.speakStart;
    const scale = hasAudio && this.speakDurMs > 0 ? (this.audio.duration * 1000) / this.speakDurMs : 1;
    return { ms, scale };
  }

  speak(opts: { audioUrl: string | null; subtitle: string; durMs: number; words?: { word: string; atMs: number }[]; onEnd?: () => void }): void {
    // THE TAIL GUARD — assigning .src cuts whatever is still playing, and the
    // server's wait (its duration estimate + pad) expires slightly before the
    // audio actually finishes, because the client starts playing a few hundred
    // ms late (fetch + decode). That difference ate the last word of nearly
    // every line. If the current line is nearly done, let it finish first.
    const a = this.audio;
    const left = a && a.duration > 0 && !a.paused && !a.ended ? a.duration - a.currentTime : 0;
    if (left > 0.05 && left < 2.5) {
      const wait = Math.min(2600, left * 1000 + 90);
      this.pending = window.setTimeout(() => this.speakNow(opts), wait);
      return;
    }
    this.speakNow(opts);
  }

  private pending: number | null = null;

  private speakNow(opts: { audioUrl: string | null; subtitle: string; durMs: number; words?: { word: string; atMs: number }[]; onEnd?: () => void }): void {
    this.clear();
    this.speakStart = performance.now();
    this.speakDurMs = opts.durMs;
    this.nameEl.style.opacity = "1";
    const words = opts.words && opts.words.length ? opts.words : opts.subtitle.split(/\s+/).map((w, i) => ({ word: w, atMs: (i * opts.durMs) / Math.max(1, opts.subtitle.split(/\s+/).length) }));
    const render = (upto: number) => {
      this.el.innerHTML = words
        .map((w, i) => {
          const on = i <= upto;
          return `<span style="color:${on ? "#ffffff" : "#8792a8"};transition:color .1s">${escapeHtml(w.word)}</span>`;
        })
        .join(" ");
    };
    render(-1);

    const hasAudio = !!opts.audioUrl;
    if (hasAudio) {
      this.audio.src = opts.audioUrl!;
      this.audio.currentTime = 0;
      void this.audio.play().catch(() => {});
    }

    const start = performance.now();
    // Scale word highlights to the AUDIO's real duration once known, so the
    // captions track the voice exactly instead of a server estimate.
    const tick = () => {
      // elapsed = actual audio position when we have audio, else wall clock
      const t = hasAudio && this.audio.duration > 0 && !this.audio.paused
        ? this.audio.currentTime * 1000
        : performance.now() - start;
      // if audio has a real duration, rescale word times proportionally
      const scale =
        hasAudio && this.audio.duration > 0 && opts.durMs > 0
          ? (this.audio.duration * 1000) / opts.durMs
          : 1;
      let upto = -1;
      for (let i = 0; i < words.length; i++) if (words[i].atMs * scale <= t) upto = i;
      render(upto);

      const done = hasAudio
        ? this.audio.ended || (this.audio.duration > 0 && this.audio.currentTime >= this.audio.duration - 0.05)
        : t >= opts.durMs + 200;
      if (!done) this.timer = requestAnimationFrame(tick);
      // the TRUE end of the line — the server waits for this instead of
      // guessing a pad, which is what used to clip the last words
      else { opts.onEnd?.(); this.fade(); }
    };
    this.timer = requestAnimationFrame(tick);
  }

  private fade(): void {
    setTimeout(() => {
      this.nameEl.style.opacity = "0";
      this.el.textContent = "";
    }, 600);
  }
  private clear(): void {
    if (this.timer) cancelAnimationFrame(this.timer);
    this.timer = null;
    if (this.pending) window.clearTimeout(this.pending);
    this.pending = null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}
