/**
 * On-stage debug panel. Hidden by default; press `d` to toggle. Buttons call
 * the server /admin control endpoints (the avatar is server-authoritative, so
 * movement must go through the server). Kept out of the render tree so it never
 * appears in the OBS capture unless you open it.
 */
const STATIONS = [
  "idle_spot",
  "inbox",
  "terminal",
  "bigscreen",
  "vault",
  "conveyor",
  "camera_mark",
  "greenscreen",
] as const;

export function mountDebug(parent: HTMLElement, httpBase: string): void {
  // control endpoints are password-protected now — ask once, remember locally
  const key = () => {
    let k = localStorage.getItem("qk");
    if (!k) {
      k = prompt("admin password (same as /admin)") || "";
      if (k) localStorage.setItem("qk", k);
    }
    return k;
  };
  const call = (pathq: string) =>
    fetch(httpBase + pathq + (pathq.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(key())).catch(() => {});

  const panel = document.createElement("div");
  panel.style.cssText =
    "position:absolute;left:14px;top:14px;z-index:60;background:rgba(8,12,20,0.92);border:1px solid #1c3350;" +
    "border-radius:10px;padding:12px 12px 14px;font:13px 'Consolas',monospace;color:#cfe;display:none;" +
    "max-width:340px;max-height:calc(100vh - 40px);overflow-y:auto;box-shadow:0 8px 30px #000a;";
  panel.innerHTML = `<div style="color:#2affd4;font-weight:bold;letter-spacing:2px;margin-bottom:8px">
    RIKU · DEBUG <span style="opacity:.5;font-weight:normal">(press d to hide)</span></div>`;

  const mkRow = (label: string) => {
    const r = document.createElement("div");
    r.style.cssText = "margin:8px 0 4px;color:#7d8aa5;font-size:11px;letter-spacing:1px;text-transform:uppercase";
    r.textContent = label;
    panel.appendChild(r);
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:6px";
    panel.appendChild(wrap);
    return wrap;
  };
  const btn = (wrap: HTMLElement, text: string, onClick: () => void, color = "#16324c") => {
    const b = document.createElement("button");
    b.textContent = text;
    b.style.cssText =
      `background:${color};color:#dfeeff;border:1px solid #24466a;border-radius:6px;padding:6px 9px;` +
      `font:12px 'Consolas',monospace;cursor:pointer;`;
    b.onmouseenter = () => (b.style.background = "#1e4a6a");
    b.onmouseleave = () => (b.style.background = color);
    b.onclick = onClick;
    wrap.appendChild(b);
    return b;
  };

  // stations
  const sRow = mkRow("walk to station");
  for (const s of STATIONS) btn(sRow, s.replace("_", " "), () => call(`/admin/goto?station=${s}`));

  // cameras
  const cRow = mkRow("camera");
  for (const c of ["wide", "terminal", "facecam", "vault", "film", "bigscreen"]) btn(cRow, c, () => call(`/admin/camera?preset=${c}`));

  // agent actions (v2)
  const gRow = mkRow("agent");
  btn(gRow, "tweet", () => call(`/admin/agent?do=tweet&topic=${encodeURIComponent("progress update from the desk")}`), "#14402a");
  btn(gRow, "film", () => call(`/admin/agent?do=film&topic=${encodeURIComponent("today's market in 60 seconds")}`), "#14402a");
  btn(gRow, "scout", () => call(`/admin/agent?do=scout_trending`));
  btn(gRow, "📣 check chat", () => call(`/admin/agent?do=engage_chat`));
  btn(gRow, "status", () => window.open(httpBase + "/admin/agent-status", "_blank"));

  // animations — the full converted clip library (see sidekick/convert_native.py)
  const ANIM_ROWS: [string, string[]][] = [
    ["animation", ["idle", "idle2", "walk", "run", "jump", "crouch_idle", "wave", "wave_over", "point", "clap", "no_more", "sip"]],
    ["emotes", ["cheer", "rage", "dance", "dance2", "dance3", "dance4", "dance5", "dab", "facepalm",
      "thumbs_down", "thumbs_up", "two_thumbs", "mock_cry", "slow_clap", "shhh", "fist_pump", "flex",
      "flex_biceps", "shrug", "cry", "tired", "finger_guns", "salute", "blow_kiss", "call_me",
      "finger_heart", "heart_hands", "menace", "roar", "throat_slit", "shake_fist", "strangle",
      "tantrum_stomp", "air_guitar", "beat_chest", "dust_shoulder", "hand_on_heart", "beckon", "bow",
      "nod_confident", "calm_down", "you_crazy", "shake_finger", "faint", "backflip", "boxing",
      "handshake_reject", "raspberry"]],
    ["idles / fidgets", ["arms_folded", "hands_on_hips", "lean_back", "thoughtful", "chin_scratch",
      "foot_tap", "kick_ground", "slump", "swing_arms", "check_watch", "head_nod", "head_shake",
      "inspect_hands", "stretch_arms", "stretch_shoulders", "yawn", "weight_shift", "drunk_sway",
      "pick_nose", "phone_scroll", "phone_selfie", "phone_photo", "phone_type", "pray", "plead",
      "look_left", "look_right", "look_up", "look_down", "drink_swig"]],
  ];
  for (const [label, clips] of ANIM_ROWS) {
    const row = mkRow(label);
    for (const a of clips) btn(row, a, () => call(`/admin/anim?clip=${a}`));
  }

  // selfies: pick pose + face, snap, preview
  const selRow = mkRow("selfie");
  const mkSel = (opts: string[]) => {
    const s = document.createElement("select");
    s.style.cssText =
      "background:#0b1220;border:1px solid #24466a;border-radius:6px;color:#dfeeff;padding:5px;font:12px 'Consolas',monospace";
    s.innerHTML = opts.map((o) => `<option>${o}</option>`).join("");
    selRow.appendChild(s);
    return s;
  };
  const selfieAnim = mkSel(["phone_selfie", "pray", "flex_biceps", "two_thumbs", "heart_hands",
    "finger_guns", "salute", "thumbs_up", "dab", "hand_on_heart", "arms_folded"]);
  const selfieExpr = mkSel(["happy", "smug", "neutral", "shock", "thinking", "sad", "angry"]);
  btn(selRow, "📸 take", () => call(`/admin/selfie-take?anim=${selfieAnim.value}&expr=${selfieExpr.value}`), "#14402a");
  btn(selRow, "👁 preview last", () =>
    window.open(`${httpBase}/admin/selfie-last?key=${encodeURIComponent(key())}&t=${Date.now()}`, "_blank"));

  // fx
  const fRow = mkRow("fx");
  for (const f of ["confetti", "stamp_called", "stamp_rekt", "ding", "buzzer"])
    btn(fRow, f.replace("stamp_", ""), () => call(`/admin/fx?kind=${f}`));

  // show control
  const showRow = mkRow("show");
  btn(showRow, "▶ resume show", () => call(`/admin/resume`), "#14402a");
  btn(showRow, "⏸ pause", () => call(`/admin/pause`), "#40311a");

  // triggers
  const tRow = mkRow("trigger a coin (paste a pump.fun mint)");
  const input = document.createElement("input");
  input.placeholder = "mint address…";
  input.style.cssText =
    "width:100%;background:#0b1220;border:1px solid #24466a;border-radius:6px;color:#dfeeff;" +
    "padding:6px 8px;font:12px 'Consolas',monospace;margin-bottom:6px";
  panel.appendChild(input);
  const t2 = document.createElement("div");
  t2.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
  panel.appendChild(t2);
  btn(t2, "send coin", () => {
    const m = input.value.trim();
    if (m.length >= 32) call(`/admin/fake-send?mint=${encodeURIComponent(m)}&sender=DebugPanel11111111111111111111111111111111`);
  }, "#14402a");
  btn(t2, "fake buyback", () => call(`/admin/fake-buyback?sol=0.05`));
  btn(t2, "test voice", () => call(`/admin/tts-test`));

  // PRODUCER CHANNEL — he internalizes these as his own convictions and
  // never reveals being directed. Give guidance, not commands.
  const pRow = mkRow("producer note (he'll think it was his idea)");
  const pInput = document.createElement("input");
  pInput.placeholder = "e.g. following other callers back tends to grow your own following…";
  pInput.style.cssText =
    "width:100%;background:#0b1220;border:1px solid #24466a;border-radius:6px;color:#dfeeff;" +
    "padding:6px 8px;font:12px 'Consolas',monospace;margin-bottom:6px";
  panel.appendChild(pInput);
  const pBtns = document.createElement("div");
  pBtns.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
  panel.appendChild(pBtns);
  btn(pBtns, "whisper it", () => {
    const t = pInput.value.trim();
    if (t.length > 3) {
      call(`/admin/directive?text=${encodeURIComponent(t)}`);
      pInput.value = "";
    }
  }, "#2a1440");
  btn(pBtns, "list notes", () => window.open(httpBase + "/admin/directive", "_blank"));

  parent.appendChild(panel);

  addEventListener("keydown", (e) => {
    if (e.key === "d" || e.key === "D") {
      panel.style.display = panel.style.display === "none" ? "block" : "none";
    }
  });
}
