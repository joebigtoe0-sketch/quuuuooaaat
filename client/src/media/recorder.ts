/**
 * Records the stage (WebGL canvas + Quant's voice) during filming beats and
 * uploads the clip to the server, which transcodes + posts it to X.
 * Driven entirely by server `record` cues — the client stays dumb.
 */
export class StageRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private currentId: string | null = null;
  private recEl: HTMLDivElement;

  constructor(
    private canvas: HTMLCanvasElement,
    private audioEl: HTMLAudioElement,
    private httpBase: string,
    parent: HTMLElement,
  ) {
    this.recEl = document.createElement("div");
    this.recEl.innerHTML = `<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#ff3b30;margin-right:8px;animation:recblink 1s infinite"></span>REC`;
    this.recEl.style.cssText =
      "position:absolute;left:24px;top:24px;z-index:40;color:#fff;font:bold 22px 'Consolas',monospace;" +
      "letter-spacing:3px;display:none;align-items:center;text-shadow:0 2px 8px #000;";
    const style = document.createElement("style");
    style.textContent = "@keyframes recblink{50%{opacity:.25}}";
    document.head.appendChild(style);
    parent.appendChild(this.recEl);
  }

  private audioCtx?: AudioContext;
  private audioDest?: MediaStreamAudioDestinationNode;

  /** Route the voice through WebAudio so the recorder's audio track is ALWAYS
   *  live (silence when idle). A paused <audio> captureStream stalls the muxer
   *  and MediaRecorder emits ZERO chunks — the bug that ate our first clips. */
  private ensureAudioGraph(): void {
    if (this.audioCtx) return;
    try {
      this.audioCtx = new AudioContext();
      const src = this.audioCtx.createMediaElementSource(this.audioEl);
      this.audioDest = this.audioCtx.createMediaStreamDestination();
      src.connect(this.audioDest);
      src.connect(this.audioCtx.destination); // viewers keep hearing him
    } catch {
      this.audioCtx = undefined;
    }
  }

  async start(id: string): Promise<void> {
    if (this.recorder) this.stopInternal(false);
    this.currentId = id;
    this.chunks = [];
    try {
      const stream = this.canvas.captureStream(30);
      this.ensureAudioGraph();
      try { await this.audioCtx?.resume(); } catch {}
      if (this.audioCtx?.state === "running" && this.audioDest) {
        for (const t of this.audioDest.stream.getAudioTracks()) stream.addTrack(t);
      } // else: video-only — a capture with no audio still beats no capture
      const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus"
        : "video/webm";
      this.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
      this.recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          if (!this.chunks.length) void fetch(`${this.httpBase}/admin/recstat?ev=firstchunk&id=${id}&bytes=${e.data.size}`).catch(() => {});
          this.chunks.push(e.data);
        }
      };
      this.recorder.start(1000);
      this.recEl.style.display = "flex";
      console.info(`[rec] recording ${id}`);
      void fetch(`${this.httpBase}/admin/recstat?ev=started&id=${id}`).catch(() => {});
    } catch (e) {
      console.warn("[rec] start failed:", e);
      void fetch(`${this.httpBase}/admin/recstat?ev=startfail&id=${id}&err=${encodeURIComponent(String(e).slice(0, 120))}`).catch(() => {});
      this.recorder = null;
    }
  }

  stop(): void {
    this.stopInternal(true);
  }

  private stopInternal(upload: boolean): void {
    const rec = this.recorder;
    const id = this.currentId;
    this.recorder = null;
    this.recEl.style.display = "none";
    if (!rec) return;
    void fetch(`${this.httpBase}/admin/recstat?ev=stopping&id=${id}&state=${rec.state}&chunks=${this.chunks.length}`).catch(() => {});
    rec.onstop = async () => {
      if (!upload || !id || !this.chunks.length) {
        void fetch(`${this.httpBase}/admin/recstat?ev=nochunks&id=${id}&chunks=${this.chunks.length}&upload=${upload}`).catch(() => {});
        return;
      }
      const blob = new Blob(this.chunks, { type: "video/webm" });
      this.chunks = [];
      try {
        const res = await fetch(`${this.httpBase}/admin/clip?id=${encodeURIComponent(id)}`, {
          method: "POST",
          headers: { "content-type": "video/webm" },
          body: blob,
        });
        console.info(`[rec] uploaded ${id}: ${blob.size} bytes → ${res.status}`);
        void fetch(`${this.httpBase}/admin/recstat?ev=uploaded&id=${id}&bytes=${blob.size}&status=${res.status}`).catch(() => {});
      } catch (e) {
        console.warn("[rec] upload failed:", e);
        void fetch(`${this.httpBase}/admin/recstat?ev=uploadfail&id=${id}&err=${encodeURIComponent(String(e).slice(0, 120))}`).catch(() => {});
      }
    };
    try {
      rec.stop();
    } catch {}
  }
}
