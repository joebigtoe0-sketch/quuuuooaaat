/**
 * The broadcast "camera" look: viewfinder brackets, blinking REC, running
 * timecode, active-camera label, scanlines + vignette. Pure overlay — no
 * pointer events, sits under the UI but over the 3D canvas.
 */
const CAM_NO: Record<string, string> = {
  wide: "CAM 01 · WIDE",
  terminal: "CAM 02 · TERMINAL",
  facecam: "CAM 03 · FACECAM",
  vault: "CAM 04 · VAULT",
  film: "CAM 05 · FILM SET",
  bigscreen: "CAM 06 · BIGSCREEN",
};

export function mountCameraLook(parent: HTMLElement): { setCam(preset: string): void } {
  const o = document.createElement("div");
  o.style.cssText = "position:absolute;inset:0;z-index:40;pointer-events:none;font:12px 'Consolas',monospace;";
  o.innerHTML = `
    <style>
      .cl-scan{position:absolute;inset:0;background:repeating-linear-gradient(0deg,rgba(0,0,0,.09) 0 1px,transparent 1px 3px);mix-blend-mode:overlay}
      .cl-vig{position:absolute;inset:0;background:radial-gradient(ellipse 75% 70% at 50% 50%,transparent 62%,rgba(0,0,0,.38))}
      .cl-corner{position:absolute;width:34px;height:34px;border:2px solid rgba(223,232,250,.55)}
      .cl-tl{top:18px;left:18px;border-right:0;border-bottom:0}
      .cl-tr{top:18px;right:18px;border-left:0;border-bottom:0}
      .cl-bl{bottom:18px;left:18px;border-right:0;border-top:0}
      .cl-br{bottom:18px;right:18px;border-left:0;border-top:0}
      .cl-rec{position:absolute;top:26px;left:64px;display:flex;align-items:center;gap:8px;color:#ffb3c1;letter-spacing:2px;text-shadow:0 1px 3px #000}
      .cl-dot{width:10px;height:10px;border-radius:50%;background:#ff3a24;animation:clblink 1.2s steps(2) infinite}
      @keyframes clblink{50%{opacity:.15}}
      .cl-cam{position:absolute;top:26px;right:64px;color:rgba(223,232,250,.85);letter-spacing:2px;text-shadow:0 1px 3px #000}
      .cl-tc{position:absolute;bottom:26px;left:64px;color:rgba(223,232,250,.7);letter-spacing:2px;font-variant-numeric:tabular-nums;text-shadow:0 1px 3px #000}
      .cl-sig{position:absolute;bottom:26px;right:64px;color:rgba(223,232,250,.6);letter-spacing:2px;text-shadow:0 1px 3px #000}
    </style>
    <div class="cl-scan"></div>
    <div class="cl-vig"></div>
    <div class="cl-corner cl-tl"></div><div class="cl-corner cl-tr"></div>
    <div class="cl-corner cl-bl"></div><div class="cl-corner cl-br"></div>
    <div class="cl-rec"><span class="cl-dot"></span>REC</div>
    <div class="cl-cam" id="cl-cam">CAM 01 · WIDE</div>
    <div class="cl-tc" id="cl-tc">00:00:00:00</div>
    <div class="cl-sig">SDI · 1080p60 · LIVE</div>`;
  parent.appendChild(o);

  const camEl = o.querySelector<HTMLElement>("#cl-cam")!;
  const tcEl = o.querySelector<HTMLElement>("#cl-tc")!;
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = () => {
    const d = new Date();
    tcEl.textContent =
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} · ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
  };
  setInterval(clock, 250);
  clock();

  return {
    setCam(preset: string) {
      camEl.textContent = CAM_NO[preset] ?? `CAM ?? · ${preset.toUpperCase()}`;
    },
  };
}
