/**
 * Viewer dock: WALLET / STATS / LOG as a bottom-center control strip with real
 * SVG icons. Wallet + stats open as centered terminal windows in the show's
 * branding; LOG toggles the agent terminal. Read-only, stream-safe.
 */
const fmtUsd = (v: number | null | undefined) =>
  v == null ? "—" : v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(2)}`;
const fmtAmt = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(n < 10 ? 2 : 0);

/**
 * THE CALL RECORD — every callout with entry mc, the peak it reached and the
 * multiple, windowed today / 7d / 30d / all, with the averages on top. This is
 * the number people actually judge a caller by, so it leads the section.
 */
type CallRange = "today" | "7d" | "30d" | "all";
let callRange: CallRange = "all";
const mult = (m: number | null | undefined) =>
  m == null ? "—" : m >= 10 ? `${m.toFixed(0)}x` : `${m.toFixed(1)}x`;
const multColor = (m: number | null | undefined) =>
  m == null ? "#5a7290" : m >= 2 ? "#39ff88" : m >= 1 ? "#e8f0ff" : "#ff4d6d";

async function callRecordHtml(httpBase: string): Promise<string> {
  let d: any;
  try {
    d = await (await fetch(`${httpBase}/public/callouts?range=${callRange}`)).json();
  } catch {
    return "";
  }
  const tabs = (["today", "7d", "30d", "all"] as CallRange[])
    .map(
      (r) =>
        `<button data-range="${r}" style="background:${r === callRange ? "#16324c" : "transparent"};` +
        `border:1px solid ${r === callRange ? "#2affd4" : "#1c2740"};color:${r === callRange ? "#2affd4" : "#7d8aa5"};` +
        `border-radius:6px;padding:3px 9px;font:11px 'Consolas',monospace;cursor:pointer;margin-right:4px">${r}</button>`,
    )
    .join("");
  const rows = (d.rows ?? [])
    .map(
      (r: any) =>
        `<div class="prow" style="font-size:12px">` +
        `<span style="color:#e8f0ff;font-weight:bold;min-width:78px">$${String(r.symbol).slice(0, 10)}</span>` +
        `<span style="color:#5a7290;min-width:62px">${ago(r.at)}</span>` +
        `<span style="color:#7d8aa5;margin-left:auto">${fmtUsd(r.entryMcUsd)} → ${fmtUsd(r.peakMcUsd)}</span>` +
        `<span style="color:${multColor(r.multiplier)};width:46px;text-align:right;font-weight:bold">${mult(r.multiplier)}</span>` +
        `</div>`,
    )
    .join("");
  return (
    `<div style="margin-top:16px;border-top:1px solid #12324a;padding-top:12px">` +
    `<div style="display:flex;align-items:center;margin-bottom:8px">` +
    `<span style="color:#2affd4;font-size:11px;letter-spacing:2px">CALL RECORD</span>` +
    `<span style="margin-left:auto">${tabs}</span></div>` +
    `<div class="pkv"><span>calls</span><span>${d.calls ?? 0}</span></div>` +
    `<div class="pkv"><span>avg peak multiple</span><span style="color:${multColor(d.avgMultiplier)};font-weight:bold">${mult(d.avgMultiplier)}</span></div>` +
    `<div class="pkv"><span>2x or better</span><span>${d.winners2x ?? 0}</span></div>` +
    (d.best ? `<div class="pkv"><span>best call</span><span style="color:#39ff88">$${d.best.symbol} ${mult(d.best.multiplier)}</span></div>` : "") +
    (rows ? `<div style="margin-top:10px;max-height:190px;overflow-y:auto">${rows}</div>` : `<div style="color:#5a7290;margin-top:8px;font-size:12px">no calls in this window yet</div>`) +
    `</div>`
  );
}

function ago(ts: number): string {
  const m = Math.max(0, (Date.now() - ts) / 60000);
  if (m < 60) return `${Math.round(m)}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

function wireRangeButtons(bodyEl: HTMLElement, _httpBase: string, rerender: () => void): void {
  bodyEl.querySelectorAll<HTMLButtonElement>("button[data-range]").forEach((b) => {
    b.onclick = () => {
      callRange = (b.dataset.range as CallRange) ?? "all";
      rerender();
    };
  });
}

const ICONS: Record<string, string> = {
  wallet: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 7H5a2 2 0 0 1 0-4h13v4"/><path d="M20 7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5"/>
    <circle cx="16.5" cy="13.5" r="1.4" fill="currentColor" stroke="none"/></svg>`,
  stats: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
    <path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/></svg>`,
  log: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 9 3 3-3 3"/><path d="M12 15h6"/></svg>`,
};

export function mountPanels(stageEl: HTMLElement, httpBase: string, toggleLog?: () => void): void {
  const css = document.createElement("style");
  css.textContent = `
    .dock{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);z-index:80;display:flex;gap:5px;
      background:rgba(7,11,18,.72);border:1px solid #1c3350;border-radius:9px;padding:4px 6px;backdrop-filter:blur(6px)}
    .dockBtn{display:flex;flex-direction:column;align-items:center;gap:2px;width:38px;padding:4px 0 3px;cursor:pointer;
      background:transparent;border:1px solid transparent;border-radius:6px;color:#8fa4c8;transition:all .15s;font:600 7px 'Consolas',monospace;letter-spacing:1px}
    .dockBtn svg{width:13px;height:13px}
    .dockBtn:hover{color:#2affd4;border-color:#1c3350;background:rgba(42,255,212,.05)}
    .dockBtn.on{color:#2affd4;border-color:#2affd455;background:rgba(42,255,212,.08);box-shadow:0 0 18px rgba(42,255,212,.12)}
    .pwinBack{position:absolute;inset:0;z-index:84;background:rgba(4,6,10,.45);display:none}
    .pwin{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:85;width:min(860px,94vw);
      height:min(76vh,720px);display:none;flex-direction:column;background:rgba(6,10,17,.97);border:1px solid #1c3350;
      border-radius:10px;box-shadow:0 0 0 1px rgba(42,255,212,.07),0 30px 90px #000d;font:13px 'Consolas',monospace;color:#dfe8fa;overflow:hidden}
    .pwin .bar{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #14283f;
      background:linear-gradient(rgba(42,255,212,.05),transparent)}
    .pwin .dots{display:flex;gap:5px}
    .pwin .dots i{width:9px;height:9px;border-radius:50%;background:#1c3350;display:block}
    .pwin .dots i:first-child{background:#ff4d6d88}
    .pwin .title{color:#2affd4;font-weight:bold;letter-spacing:2px;font-size:12px}
    .pwin .bar button{margin-left:auto;background:none;border:none;color:#7d8aa5;font:bold 14px 'Consolas',monospace;cursor:pointer;padding:2px 6px}
    .pwin .bar button:hover{color:#ff4d6d}
    .pwin .body{padding:16px 20px;overflow-y:auto;position:relative;flex:1;font-size:14px}
    .pwin .body::after{content:"";position:fixed;inset:0;pointer-events:none;
      background:repeating-linear-gradient(0deg,rgba(0,0,0,.05) 0 1px,transparent 1px 3px)}
    .pwin .foot{padding:7px 14px;border-top:1px solid #14283f;color:#3d4a63;font-size:10.5px;letter-spacing:1px}
    .prow{display:flex;align-items:center;gap:8px;margin:5px 0}
    .pkv{display:flex;margin:7px 0} .pkv span:first-child{color:#7d8aa5} .pkv span:last-child{margin-left:auto}
    .pcur::after{content:"▮";color:#2affd4;animation:pblink 1.1s steps(2) infinite;margin-left:2px}
    @keyframes pblink{50%{opacity:0}}`;
  stageEl.appendChild(css);

  // ---- dock ----
  const dock = document.createElement("div");
  dock.className = "dock";
  stageEl.appendChild(dock);
  const mkBtn = (id: string, label: string) => {
    const b = document.createElement("button");
    b.className = "dockBtn";
    b.innerHTML = `${ICONS[id]}<span>${label}</span>`;
    dock.appendChild(b);
    return b;
  };
  const walletBtn = mkBtn("wallet", "WALLET");
  const statsBtn = mkBtn("stats", "STATS");
  const logBtn = mkBtn("log", "LOG");

  // ---- centered terminal window ----
  const back = document.createElement("div");
  back.className = "pwinBack";
  stageEl.appendChild(back);
  const win = document.createElement("div");
  win.className = "pwin";
  win.innerHTML = `
    <div class="bar"><span class="dots"><i></i><i></i><i></i></span>
      <span class="title" id="pwin-title">RIKU://WALLET</span><button id="pwin-x">✕</button></div>
    <div class="body" id="pwin-body"></div>
    <div class="foot" id="pwin-foot">READ-ONLY FEED · REFRESHES WHILE OPEN</div>`;
  stageEl.appendChild(win);
  const titleEl = win.querySelector<HTMLElement>("#pwin-title")!;
  const bodyEl = win.querySelector<HTMLElement>("#pwin-body")!;

  let open: "wallet" | "stats" | null = null;
  let timer: number | null = null;

  const render = async () => {
    if (!open) return;
    try {
      if (open === "wallet") {
        const w = await (await fetch(`${httpBase}/public/wallet`)).json();
        if (w.loading) {
          bodyEl.innerHTML = `<div style="color:#7d8aa5" class="pcur">warming up — first snapshot builds in a few seconds</div>`;
          return;
        }
        const rows = (w.items ?? [])
          .map((h: any) => {
            const price = (v: number) => (v >= 0.01 ? "$" + v.toFixed(3) : "$" + v.toPrecision(3));
            const pnl =
              h.pnlUsd == null
                ? ""
                : `<div style="margin-left:30px;font-size:11px;color:#5a7290">` +
                  (h.entryUsd != null ? `entry ${price(h.entryUsd)} · ` : "") +
                  `<span style="color:${h.pnlUsd >= 0 ? "#39ff88" : "#ff4d6d"}">${h.pnlUsd >= 0 ? "+" : "−"}$${Math.abs(h.pnlUsd).toFixed(2)}` +
                  (h.pnlPct != null ? ` (${h.pnlPct >= 0 ? "+" : ""}${h.pnlPct.toFixed(0)}%)` : " (house money)") +
                  `</span></div>`;
            return (
              `<div class="prow">` +
              (h.image
                ? // via the server's img-proxy: ipfs.io 403s browsers too, the proxy rewrites to live gateways
                  `<img src="${httpBase}/img-proxy?u=${encodeURIComponent(h.image)}" style="width:22px;height:22px;border-radius:50%;object-fit:cover">`
                : `<div style="width:22px;height:22px;border-radius:50%;background:#1c2740"></div>`) +
              `<span style="color:${h.paper ? "#8fd0ff" : "#e8f0ff"};font-weight:bold">$${String(h.symbol).slice(0, 10)}${h.paper ? " ᴾ" : ""}</span>` +
              `<span style="color:#7d8aa5;margin-left:auto">${fmtAmt(h.amount)}</span>` +
              `<span style="color:#39ff88;width:74px;text-align:right">${fmtUsd(h.valueUsd)}</span></div>` +
              pnl
            );
          })
          .join("");
        bodyEl.innerHTML =
          (w.totalUsd != null
            ? `<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid #12324a">` +
              `<span style="color:#7d8aa5;font-size:11px;letter-spacing:2px">TOTAL</span>` +
              `<span style="color:#39ff88;font-size:20px;font-weight:bold">${fmtUsd(w.totalUsd)}</span>` +
              `<span style="color:#5a7290;font-size:11px;margin-left:auto">${fmtUsd(w.solValueUsd)} SOL · ${fmtUsd(w.tokensUsd)} tokens` +
              `${w.unpricedCount ? ` · ${w.unpricedCount} unpriced` : ""}</span></div>`
            : "") +
          `<div class="prow" style="margin-bottom:10px">` +
          `<div style="width:22px;height:22px;border-radius:50%;background:#9945FF"></div>` +
          `<span style="font-weight:bold;font-size:15px">SOL</span>` +
          `<span style="color:#7d8aa5;margin-left:auto">${Number(w.sol).toFixed(3)}</span>` +
          `<span style="color:#39ff88;width:74px;text-align:right">${fmtUsd(w.solValueUsd)}</span></div>` +
          `<div style="color:#5a7290;margin:2px 0 8px;font-size:12px">${w.paperMode === false ? `bankroll: ${Number(w.paperBankSol).toFixed(3)} SOL` : `paper bankroll: ${Number(w.paperBankSol).toFixed(3)} SOL &nbsp;·&nbsp; ᴾ = paper position`}</div>` +
          rows +
          `<div style="color:#3d4a63;margin-top:12px;font-size:10.5px;overflow-wrap:anywhere">${w.address ?? ""}</div>`;
      } else {
        const s = await (await fetch(`${httpBase}/public/stats`)).json();
        if (s.loading) {
          bodyEl.innerHTML = `<div style="color:#7d8aa5" class="pcur">warming up — first snapshot builds in a few seconds</div>`;
          return;
        }
        const pnl = (v: number) =>
          `<span style="color:${v >= 0 ? "#39ff88" : "#ff4d6d"}">${v >= 0 ? "+" : ""}${v.toFixed(3)} SOL</span>`;
        bodyEl.innerHTML = [
          ["calls on the record", String(s.calls ?? 0)],
          ["X followers", s.xFollowers == null ? "— (keys pending)" : String(s.xFollowers)],
          ["posts today", String(s.xPostsToday ?? 0)],
          ["tweets / films today", `${s.tweetsToday ?? 0} / ${s.filmsToday ?? 0}`],
          ["own token mc", s.ownTokenMcUsd ? fmtUsd(s.ownTokenMcUsd) : "not launched"],
          [s.trading?.paperMode === false ? "bankroll" : "paper bankroll", `${Number(s.trading?.paperBankSol ?? 0).toFixed(3)} SOL`],
          ["open positions", String(s.trading?.openPositions ?? 0)],
          ["realized PnL", pnl(Number(s.trading?.realizedPnlSol ?? 0))],
          ["unrealized PnL", pnl(Number(s.trading?.unrealizedPnlSol ?? 0))],
        ]
          .map(([k, v]) => `<div class="pkv"><span>${k}</span><span>${v}</span></div>`)
          .join("") + await callRecordHtml(httpBase);
        wireRangeButtons(bodyEl, httpBase, () => void render());
      }
    } catch {
      bodyEl.innerHTML = `<div style="color:#ff4d6d">signal lost — server offline?</div>`;
    }
  };

  const toggle = (which: "wallet" | "stats" | null) => {
    open = open === which ? null : which;
    win.style.display = open ? "flex" : "none";
    back.style.display = open ? "block" : "none";
    walletBtn.classList.toggle("on", open === "wallet");
    statsBtn.classList.toggle("on", open === "stats");
    if (timer) { clearInterval(timer); timer = null; }
    if (open) {
      titleEl.textContent = open === "wallet" ? "RIKU://WALLET" : "RIKU://STATS";
      bodyEl.innerHTML = `<div style="color:#7d8aa5" class="pcur">connecting</div>`;
      void render();
      timer = window.setInterval(() => void render(), 20000);
    }
  };
  walletBtn.onclick = () => toggle("wallet");
  statsBtn.onclick = () => toggle("stats");
  logBtn.onclick = () => { toggle(null); toggleLog?.(); };
  win.querySelector<HTMLButtonElement>("#pwin-x")!.onclick = () => toggle(null);
  back.onclick = () => toggle(null);
}
