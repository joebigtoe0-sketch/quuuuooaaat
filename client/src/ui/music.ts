/**
 * Background music bed. Deliberately quiet (default 10%) — it should sit UNDER
 * RIKU's voice, never compete with it. Starts on the same user gesture that
 * arms the stage audio, so it never trips autoplay blocking.
 *
 * Drop a track at client/public/media/bg.mp3 (any name in TRACKS works).
 * Missing file = silently no music; nothing else breaks.
 */
const TRACKS = ["/media/bg.mp3", "/media/ambient.mp3", "/media/music.mp3"];
const VOL_KEY = "riku.musicVol";
const MUTE_KEY = "riku.musicMuted";
const DEFAULT_VOL = 0.1; // 10% — background, not foreground

export class Music {
  private audio = new Audio();
  private btn: HTMLButtonElement | null = null;
  private muted = localStorage.getItem(MUTE_KEY) === "1";
  private vol = Number(localStorage.getItem(VOL_KEY) ?? DEFAULT_VOL);

  constructor(parent: HTMLElement, showButton: boolean) {
    this.audio.loop = true;
    this.audio.preload = "auto";
    this.audio.volume = this.muted ? 0 : this.vol;
    void this.pickTrack();
    if (showButton) this.mountButton(parent);
  }

  /** First track that actually exists. */
  private async pickTrack(): Promise<void> {
    for (const src of TRACKS) {
      try {
        const res = await fetch(src, { method: "HEAD" });
        if (res.ok) {
          this.audio.src = src;
          return;
        }
      } catch { /* try the next name */ }
    }
  }

  /** Called from the stage's arm gesture — autoplay is unlocked by then. */
  start(): void {
    if (!this.audio.src) {
      // track list may still be resolving on a cold load
      void this.pickTrack().then(() => {
        if (this.audio.src) this.audio.play().catch(() => {});
      });
      return;
    }
    this.audio.play().catch(() => {});
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.audio.volume = m ? 0 : this.vol;
    localStorage.setItem(MUTE_KEY, m ? "1" : "0");
    if (this.btn) this.btn.textContent = m ? "🔇" : "🎵";
    if (!m) this.audio.play().catch(() => {});
  }

  /** Duck under speech would go here if we ever want it; volume is already low. */
  setVolume(v: number): void {
    this.vol = Math.max(0, Math.min(1, v));
    localStorage.setItem(VOL_KEY, String(this.vol));
    if (!this.muted) this.audio.volume = this.vol;
  }

  private mountButton(parent: HTMLElement): void {
    const b = document.createElement("button");
    b.textContent = this.muted ? "🔇" : "🎵";
    b.title = "background music on/off";
    b.style.cssText =
      "position:absolute;right:14px;bottom:14px;z-index:40;width:38px;height:38px;border-radius:10px;" +
      "background:rgba(8,14,24,.62);border:1px solid rgba(42,255,212,.35);color:#dfeeff;font-size:17px;" +
      "cursor:pointer;line-height:1;padding:0;backdrop-filter:blur(4px);opacity:.55;transition:opacity .15s";
    b.onmouseenter = () => (b.style.opacity = "1");
    b.onmouseleave = () => (b.style.opacity = ".55");
    b.onclick = (e) => {
      e.stopPropagation();
      this.setMuted(!this.muted);
    };
    parent.appendChild(b);
    this.btn = b;
  }
}
