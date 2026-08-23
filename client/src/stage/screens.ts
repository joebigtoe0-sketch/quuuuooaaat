import * as THREE from "three";
import type { ActionEvent, CalloutCard, CheckRow, InspectionState, TakeoverView, TreasuryState } from "../protocol.js";

/**
 * The live screens, each a 2D canvas → CanvasTexture on a room quad. All state
 * arrives from the server (cues + hello snapshot), so screens survive an OBS
 * refresh. Retro-terminal styling: monospace, teal on near-black.
 */
const W = 1024;
const H = 640;

const TIER_COLOR: Record<string, string> = {
  "STRONG CALL": "#39ff88",
  CALL: "#7fffd4",
  PASS: "#c8d0e0",
  ROAST: "#ff4d6d",
  DECLINE: "#ffb454",
};
const VERDICT_COLOR: Record<CheckRow["verdict"], string> = {
  pass: "#39ff88",
  fail: "#ff4d6d",
  warn: "#ffb454",
  unknown: "#6b7690",
};

class Screen {
  canvas = document.createElement("canvas");
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  constructor(mesh: THREE.Mesh) {
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    (mesh.material as THREE.MeshBasicMaterial).map = this.texture;
    (mesh.material as THREE.MeshBasicMaterial).color.set(0xffffff);
    (mesh.material as THREE.MeshBasicMaterial).needsUpdate = true;
  }
  bg(): void {
    const g = this.ctx;
    g.fillStyle = "#070b12";
    g.fillRect(0, 0, W, H);
    g.strokeStyle = "#12324a";
    g.lineWidth = 2;
    g.strokeRect(6, 6, W - 12, H - 12);
  }
  done(): void {
    this.texture.needsUpdate = true;
  }
}

export class Screens {
  private inspection: Screen;
  private callouts: Screen;
  private treasury: Screen;

  constructor(meshes: Record<string, THREE.Mesh>) {
    this.inspection = new Screen(meshes.inspection);
    this.callouts = new Screen(meshes.callouts);
    this.treasury = new Screen(meshes.treasury);
    this.drawInspection({ mint: null, name: "IDLE", symbol: "—", rows: [], score: null, tier: null });
    this.drawCallouts([]);
    this.drawTreasury({ sol: 0, ownTokens: 0, buybacks: [], neverSoldDays: 0, holdings: [] });
    // today's track record + PnL come from the server's public endpoints —
    // refresh on a slow loop so the screen stays truthful without cue traffic
    void this.refreshRecord();
    setInterval(() => void this.refreshRecord(), 120_000);
  }

  private takeover: TakeoverView | null = null;
  private lastInspection: InspectionState | null = null;

  /** Terminal takeover: X composer / trade ticket. null returns to research. */
  setTakeover(v: TakeoverView | null): void {
    this.takeover = v;
    if (v) this.drawTakeover(v);
    else if (this.lastInspection) this.drawInspection(this.lastInspection);
  }

  private drawTakeover(v: TakeoverView): void {
    const g = this.inspection.ctx;
    this.inspection.bg();
    g.textBaseline = "top";
    if (v.kind === "compose") {
      // X-style composer
      g.fillStyle = "#e8f0ff";
      g.font = "bold 34px 'Consolas', monospace";
      g.fillText("𝕏  New post", 28, 26);
      g.fillStyle = "#1c2740";
      g.fillRect(28, 80, W - 56, 8);
      // avatar circle + handle
      g.fillStyle = "#2affd4";
      g.beginPath();
      g.arc(52, 132, 22, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#0a0f18";
      g.font = "bold 24px 'Consolas', monospace";
      g.fillText("Q", 44, 120);
      g.fillStyle = "#e8f0ff";
      g.font = "bold 24px 'Consolas', monospace";
      g.fillText("RIKU", 88, 112);
      g.fillStyle = "#5a7290";
      g.font = "20px 'Consolas', monospace";
      g.fillText(v.replyTo ? "@QuantRiku · replying ↩" : "@QuantRiku · drafting", 88, 140);
      // the tweet, typed so far, wrapped + caret
      const text = v.text.slice(0, v.typed);
      g.fillStyle = "#dfe8fa";
      g.font = "26px 'Consolas', monospace";
      const maxW = W - 96;
      let x = 48, y = 190;
      for (const word of text.split(/(\s+)/)) {
        const w = g.measureText(word).width;
        if (x + w > 48 + maxW) { x = 48; y += 36; }
        g.fillText(word, x, y);
        x += w;
      }
      if (v.state === "typing" && Math.floor(Date.now() / 400) % 2 === 0) {
        g.fillStyle = "#2affd4";
        g.fillRect(x + 2, y, 3, 28);
      }
      if (v.state !== "typing") {
        g.fillStyle = v.state === "posted" ? "#39ff88" : "#ffb454";
        g.font = "bold 28px 'Consolas', monospace";
        g.fillText(v.state === "posted" ? "✓ POSTED" : "✓ DRAFTED (keys pending)", 48, H - 70);
      }
    } else if (v.kind === "mention") {
      // incoming X reply/mention he's reading on camera
      g.fillStyle = "#5a7290";
      g.font = "bold 22px 'Consolas', monospace";
      g.fillText("𝕏  INCOMING REPLY", 28, 26);
      g.fillStyle = "#1c2740";
      g.fillRect(28, 62, W - 56, 4);
      // avatar circle + handle
      g.fillStyle = "#89ddff";
      g.beginPath();
      g.arc(56, 116, 24, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#0a0f18";
      g.font = "bold 24px 'Consolas', monospace";
      g.fillText((v.author[0] || "?").toUpperCase(), 48, 104);
      g.fillStyle = "#e8f0ff";
      g.font = "bold 26px 'Consolas', monospace";
      g.fillText("@" + v.author.slice(0, 22), 94, 104);
      g.fillStyle = "#5a7290";
      g.font = "18px 'Consolas', monospace";
      g.fillText("replied to you", 94, 132);
      // their message, wrapped
      g.fillStyle = "#dfe8fa";
      g.font = "28px 'Consolas', monospace";
      const maxW = W - 96;
      let x = 48, y = 196;
      for (const word of v.text.split(/(\s+)/)) {
        const w = g.measureText(word).width;
        if (x + w > 48 + maxW) { x = 48; y += 38; }
        if (y > H - 60) break;
        g.fillText(word, x, y);
        x += w;
      }
    } else if (v.kind === "script") {
      // RIKU://SCRIPT — his own code running on the bigscreen
      g.fillStyle = "#2affd4";
      g.font = "bold 30px 'Consolas', monospace";
      g.fillText("RIKU://SCRIPT — " + v.title.toUpperCase().slice(0, 44), 28, 24);
      g.fillStyle = "#1c2740";
      g.fillRect(28, 66, W - 56, 4);
      g.font = "22px 'Consolas', monospace";
      let sy = 92;
      for (const line of v.lines.slice(-26)) {
        g.fillStyle = line.startsWith("$") ? "#7fffd4" : line.startsWith("ERROR") ? "#ff4d6d" : line.startsWith("→") ? "#ffd700" : "#dfe8fa";
        g.fillText(line.slice(0, 92), 28, sy);
        sy += 30;
        if (sy > H - 70) break;
      }
      if (v.state === "running" && Math.floor(Date.now() / 400) % 2 === 0) {
        g.fillStyle = "#2affd4";
        g.fillRect(28, sy, 14, 24);
      }
      if (v.state !== "running") {
        g.fillStyle = v.state === "done" ? "#39ff88" : "#ff4d6d";
        g.font = "bold 24px 'Consolas', monospace";
        g.fillText(v.state === "done" ? "✓ DONE" : "✗ FAILED", 28, H - 44);
      }
    } else if (v.kind === "leaderboard") {
      // HIS caller index — shown when a caller-follow entry reveals
      const PX = 56; // TV mesh crops the edges — safe margin
      g.fillStyle = "#2affd4";
      g.font = "bold 30px 'Consolas', monospace";
      g.fillText("◢ THE CALLER INDEX", PX, 32);
      g.fillStyle = "#5a7290";
      g.font = "18px 'Consolas', monospace";
      g.fillText("graded by results — median peak · % hit 2x · calls", PX, 68);
      g.fillStyle = "#1c2740";
      g.fillRect(PX, 94, W - 2 * PX, 3);
      // column heads
      g.fillStyle = "#5a7290";
      g.font = "bold 18px 'Consolas', monospace";
      g.fillText("#", PX + 8, 108);
      g.fillText("CALLER", PX + 52, 108);
      g.fillText("MED", PX + 420, 108);
      g.fillText("2X%", PX + 550, 108);
      g.fillText("CALLS", PX + 660, 108);
      let y = 142;
      v.rows.slice(0, 8).forEach((r, i) => {
        const hot = v.highlight && r.name === v.highlight;
        if (hot) {
          g.fillStyle = "rgba(42,255,212,0.12)";
          g.fillRect(PX - 12, y - 6, W - 2 * (PX - 12), 46);
          g.strokeStyle = "#2affd4";
          g.lineWidth = 2;
          g.strokeRect(PX - 12, y - 6, W - 2 * (PX - 12), 46);
        }
        g.fillStyle = "#5a6680";
        g.font = "bold 24px 'Consolas', monospace";
        g.fillText(String(i + 1), PX + 8, y);
        g.fillStyle = hot ? "#eafffa" : "#dfe8fa";
        g.fillText(r.name.slice(0, 16), PX + 52, y);
        g.fillStyle = r.med >= 1.8 ? "#39ff88" : r.med >= 1.3 ? "#7fffd4" : "#aab6d0";
        g.fillText(`${r.med.toFixed(2)}x`, PX + 420, y);
        g.fillStyle = "#aab6d0";
        g.fillText(`${r.h2}%`, PX + 550, y);
        g.fillText(String(r.calls), PX + 660, y);
        if (hot) {
          g.fillStyle = "#2affd4";
          g.font = "bold 20px 'Consolas', monospace";
          g.textAlign = "right";
          g.fillText("→ FOLLOWING", W - PX, y + 2);
          g.textAlign = "left";
        }
        y += 48;
      });
      g.fillStyle = "#5a7290";
      g.font = "italic 20px 'Consolas', monospace";
      g.fillText("pump.fun grades every call. i read the grades.", PX, H - 72);
    } else if (v.kind === "investdesk") {
      // THE INVESTMENT DESK — deliberately NOT the research terminal look:
      // a gold-on-charcoal portfolio memo, stamped like paper
      const PX = 56;
      const GOLD = "#e8c268", DIM = "#8a7a52", INK = "#e9e2d0";
      // warm charcoal wash over the default bg so the segment reads different at a glance
      g.fillStyle = "#171310";
      g.fillRect(0, 0, W, H);
      g.strokeStyle = GOLD;
      g.lineWidth = 3;
      g.strokeRect(PX - 16, 20, W - 2 * (PX - 16), H - 40);
      g.fillStyle = GOLD;
      g.font = "bold 26px 'Consolas', monospace";
      g.fillText("RIKU CAPITAL", PX, 44);
      g.fillStyle = DIM;
      g.font = "18px 'Consolas', monospace";
      g.textAlign = "right";
      g.fillText("INVESTMENT DESK — THE BOOK", W - PX, 50);
      g.textAlign = "left";
      g.fillStyle = "#3a3020";
      g.fillRect(PX, 78, W - 2 * PX, 2);
      // the name
      g.fillStyle = INK;
      g.font = "bold 52px 'Consolas', monospace";
      g.fillText(`$${v.symbol.slice(0, 12)}`, PX, 100);
      g.fillStyle = DIM;
      g.font = "20px 'Consolas', monospace";
      g.fillText(v.name.slice(0, 34), PX, 158);
      // stat grid, tabular
      const money = (n: number) =>
        n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : `$${Math.round(n / 1_000)}K`;
      const stats: [string, string][] = [
        ["MKT CAP", money(v.mcUsd)],
        ["LIQUIDITY", money(v.liqUsd)],
        ["VOL 24H", money(v.vol24Usd)],
        ["6H", `${v.chg6hPct >= 0 ? "+" : ""}${v.chg6hPct.toFixed(1)}%`],
        ["AGE", `${v.ageDays.toFixed(1)}d`],
        ["IDENTITY", v.socials.slice(0, 2).join("+") || "—"],
      ];
      let sx = PX, sy = 196;
      stats.forEach(([k, val], i) => {
        g.fillStyle = DIM;
        g.font = "bold 16px 'Consolas', monospace";
        g.fillText(k, sx, sy);
        g.fillStyle = k === "6H" ? (v.chg6hPct >= 0 ? "#9fd68a" : "#d68a8a") : INK;
        g.font = "bold 26px 'Consolas', monospace";
        g.fillText(val, sx, sy + 20);
        sx += 218;
        if (i % 3 === 2) { sx = PX; sy += 66; }
      });
      // thesis, wrapped
      g.fillStyle = "#c9bfa6";
      g.font = "italic 21px 'Consolas', monospace";
      let tx = PX, ty = 340;
      for (const word of v.thesis.split(/(\s+)/)) {
        const w = g.measureText(word).width;
        if (tx + w > W - PX - 250) { tx = PX; ty += 30; }
        if (ty > H - 70) break;
        g.fillText(word, tx, ty);
        tx += w;
      }
      // conviction dots
      g.font = "bold 18px 'Consolas', monospace";
      g.fillStyle = DIM;
      g.fillText("CONVICTION", PX, H - 64);
      for (let i = 0; i < 5; i++) {
        g.fillStyle = i < v.conviction ? GOLD : "#3a3020";
        g.beginPath();
        g.arc(PX + 130 + i * 26, H - 54, 8, 0, Math.PI * 2);
        g.fill();
      }
      // the STAMP — rotated, like it was pressed onto the memo
      g.save();
      g.translate(W - 200, H - 150);
      g.rotate(-0.16);
      const buyStamp = v.verdict === "buy";
      g.strokeStyle = buyStamp ? "#7fce6a" : "#ce6a6a";
      g.fillStyle = buyStamp ? "rgba(127,206,106,0.14)" : "rgba(206,106,106,0.12)";
      g.lineWidth = 5;
      const stampW = buyStamp ? 190 : 170;
      g.fillRect(-stampW / 2, -40, stampW, 80);
      g.strokeRect(-stampW / 2, -40, stampW, 80);
      g.fillStyle = buyStamp ? "#7fce6a" : "#ce6a6a";
      g.font = "bold 44px 'Consolas', monospace";
      g.textAlign = "center";
      g.fillText(buyStamp ? "BUY" : "PASS", 0, -22);
      if (buyStamp && v.sizeSol) {
        g.font = "bold 17px 'Consolas', monospace";
        g.fillText(`${v.sizeSol} SOL — NO STOP`, 0, 46);
      }
      g.textAlign = "left";
      g.restore();
    } else {
      // trade ticket
      const buy = v.side === "BUY";
      g.fillStyle = buy ? "#39ff88" : "#ffb454";
      g.font = "bold 34px 'Consolas', monospace";
      g.fillText(`◢ ${v.side} TICKET`, 28, 26);
      g.fillStyle = "#e8f0ff";
      g.font = "bold 44px 'Consolas', monospace";
      g.fillText(`$${v.symbol.slice(0, 12)}`, 28, 92);
      g.font = "bold 30px 'Consolas', monospace";
      g.fillStyle = "#dfe8fa";
      g.fillText(`${v.sol.toFixed(3)} SOL`, 28, 152);
      g.fillStyle = "#7d8aa5";
      g.font = "22px 'Consolas', monospace";
      let y = 210;
      for (let i = 0; i < v.thesis.length; i += 42) {
        g.fillText(v.thesis.slice(i, i + 42), 28, y);
        y += 30;
        if (y > 300) break;
      }
      g.font = "bold 32px 'Consolas', monospace";
      if (v.state === "working") {
        g.fillStyle = "#89ddff";
        g.fillText("submitting" + ".".repeat(1 + (Math.floor(Date.now() / 350) % 3)), 28, 330);
      } else if (v.state === "filled") {
        g.fillStyle = "#39ff88";
        g.fillText("✓ FILLED", 28, 330);
      } else {
        g.fillStyle = "#ff4d6d";
        g.fillText("✗ REJECTED", 28, 330);
      }
    }
    this.inspection.done();
  }

  drawInspection(s: InspectionState): void {
    this.lastInspection = s;
    if (this.takeover) return; // composer/ticket owns the screen right now
    const g = this.inspection.ctx;
    this.inspection.bg();
    g.textBaseline = "top";

    // the TV mesh crops the canvas edges — everything lives inside a safe area
    const PX = 56; // left/right safe margin
    const PB = 40; // extra bottom margin

    // ---- header band: eyebrow, ticker + name on one line, source chip ----
    g.fillStyle = "#0b1524";
    g.fillRect(PX - 24, 20, W - 2 * (PX - 24), 118);
    g.fillStyle = "#2affd4";
    g.font = "bold 20px 'Consolas', monospace";
    g.fillText("◢ RESEARCH TERMINAL", PX, 34);
    g.fillStyle = "#3a4a66";
    g.font = "20px 'Consolas', monospace";
    const clock = new Date().toISOString().slice(11, 16) + " UTC";
    g.textAlign = "right";
    g.fillText(clock, W - PX, 34);
    g.textAlign = "left";
    g.fillStyle = "#e8f0ff";
    g.font = "bold 44px 'Consolas', monospace";
    const sym = `$${(s.symbol || "—").slice(0, 12)}`;
    g.fillText(sym, PX, 64);
    const symW = g.measureText(sym).width;
    g.fillStyle = "#66779a";
    g.font = "22px 'Consolas', monospace";
    g.fillText((s.name || "").slice(0, Math.max(4, Math.floor((W - 2 * PX - 40 - symW) / 13))), PX + 16 + symW, 80);
    if (s.source) {
      const sent = s.source.startsWith("SENT");
      g.fillStyle = sent ? "#89ddff" : "#ffd700";
      g.font = "bold 18px 'Consolas', monospace";
      g.fillText(`● ${s.source.slice(0, 54)}`, PX, 112);
    }

    // ---- checks: zebra rows, aligned columns, color only where it means ----
    let y = 156;
    const rows = s.rows.slice(-10);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (i % 2 === 0) {
        g.fillStyle = "#0a111d";
        g.fillRect(PX - 24, y - 4, W - 2 * (PX - 24), 30);
      }
      g.font = "bold 22px 'Consolas', monospace";
      g.fillStyle = VERDICT_COLOR[r.verdict];
      const mark = r.verdict === "pass" ? "✓" : r.verdict === "fail" ? "✗" : r.verdict === "warn" ? "!" : "·";
      g.fillText(mark, PX, y);
      g.fillStyle = r.verdict === "fail" ? "#ff8ca0" : r.verdict === "warn" ? "#ffcf8a" : "#93a3c2";
      g.font = "bold 20px 'Consolas', monospace";
      g.fillText(r.label.slice(0, 13), PX + 34, y + 1);
      g.fillStyle = "#dfe8fa";
      g.font = "21px 'Consolas', monospace";
      g.fillText(r.detail.slice(0, 47), PX + 214, y + 1);
      y += 30;
    }
    if (!rows.length) {
      g.fillStyle = "#3a4a66";
      g.font = "22px 'Consolas', monospace";
      g.fillText("reading the chain" + ".".repeat(1 + (Math.floor(Date.now() / 400) % 3)), PX, y + 6);
    }

    // ---- verdict band: score bar left, tier right ----
    g.fillStyle = "#0b1524";
    g.fillRect(PX - 24, H - PB - 92, W - 2 * (PX - 24), 92);
    if (s.score !== null) {
      g.fillStyle = "#66779a";
      g.font = "bold 18px 'Consolas', monospace";
      g.fillText("SCORE", PX, H - PB - 76);
      g.fillStyle = "#101c2e";
      g.fillRect(PX, H - PB - 48, 480, 22);
      const col = s.score >= 55 ? "#39ff88" : s.score >= 35 ? "#ffb454" : "#ff4d6d";
      g.fillStyle = col;
      g.fillRect(PX, H - PB - 48, Math.max(4, 4.8 * s.score), 22);
      // threshold ticks at the tier lines
      g.fillStyle = "#22314a";
      g.fillRect(PX + 4.8 * 35, H - PB - 52, 2, 30);
      g.fillRect(PX + 4.8 * 55, H - PB - 52, 2, 30);
      g.fillStyle = col;
      g.font = "bold 30px 'Consolas', monospace";
      g.fillText(String(s.score), PX + 496, H - PB - 54);
    }
    if (s.tier) {
      g.fillStyle = TIER_COLOR[s.tier] ?? "#fff";
      g.font = "bold 40px 'Consolas', monospace";
      g.textAlign = "right";
      g.fillText(s.tier, W - PX, H - PB - 62);
      g.textAlign = "left";
    }
    this.inspection.done();
  }

  private lastCards: CalloutCard[] = [];
  private lastActions: ActionEvent[] = [];
  // today's TRACK RECORD (entry → peak → multiple) + today PnL, fetched from
  // the server's own public endpoints — same numbers the website shows
  private todayBoard: {
    calls: number;
    avgMultiplier: number | null;
    winners2x: number;
    rows: { symbol: string; entryMcUsd: number | null; peakMcUsd: number | null; multiplier: number | null; at: number; dry: boolean }[];
  } | null = null;
  private todayPnlSol: number | null = null;

  private async refreshRecord(): Promise<void> {
    try {
      const b = await fetch("/public/callouts?range=today").then((r) => r.json());
      if (b?.ok !== false && b?.rows) this.todayBoard = b;
    } catch { /* keep the last board */ }
    try {
      const s: any = await fetch("/public/stats").then((r) => r.json());
      const t = s?.trading;
      if (t && t.realizedTodaySol != null) this.todayPnlSol = Number(t.realizedTodaySol);
    } catch { /* keep the last number */ }
    this.drawCallouts();
  }

  drawCallouts(cards?: CalloutCard[], actions?: ActionEvent[]): void {
    if (cards) this.lastCards = cards;
    if (actions) this.lastActions = actions;
    const g = this.callouts.ctx;
    this.callouts.bg();
    g.textBaseline = "top";
    const PX = 56; // TV mesh crops the edges — safe margin
    const PB = 36;

    // ---- header: title left, TODAY PNL right ----
    g.fillStyle = "#2affd4";
    g.font = "bold 30px 'Consolas', monospace";
    g.fillText("◢ THE RECORD — TODAY", PX, 30);
    if (this.todayPnlSol != null) {
      const up = this.todayPnlSol >= 0;
      g.textAlign = "right";
      g.fillStyle = "#66779a";
      g.font = "bold 16px 'Consolas', monospace";
      g.fillText("PNL TODAY", W - PX, 26);
      g.fillStyle = up ? "#39ff88" : "#ff4d6d";
      g.font = "bold 28px 'Consolas', monospace";
      g.fillText(`${up ? "+" : ""}${this.todayPnlSol.toFixed(3)} SOL`, W - PX, 46);
      g.textAlign = "left";
    }
    const b = this.todayBoard;
    g.fillStyle = "#66779a";
    g.font = "20px 'Consolas', monospace";
    g.fillText(
      b && b.calls
        ? `${b.calls} call${b.calls === 1 ? "" : "s"}  ·  avg peak ${b.avgMultiplier != null ? b.avgMultiplier.toFixed(2) + "x" : "—"}  ·  ${b.winners2x} hit 2x`
        : "no calls yet today — the tape decides when",
      PX,
      72,
    );
    g.fillStyle = "#1c2740";
    g.fillRect(PX, 102, W - 2 * PX, 3);

    // ---- the record table: SYM | ENTRY | PEAK | X ----
    const fmtMc = (n: number | null) =>
      n == null ? "—" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(0)}`;
    const ago = (at: number) => {
      const m = Math.max(0, Math.round((Date.now() - at) / 60000));
      return m < 1 ? "now" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
    };
    const C = { sym: PX, entry: PX + 220, peak: PX + 370, x: PX + 520, age: PX + 640 };
    g.fillStyle = "#5a7290";
    g.font = "bold 17px 'Consolas', monospace";
    g.fillText("CALL", C.sym, 116);
    g.fillText("ENTRY", C.entry, 116);
    g.fillText("PEAK", C.peak, 116);
    g.fillText("X", C.x, 116);
    g.fillText("AGE", C.age, 116);
    let y = 146;
    const rows = b?.rows ?? [];
    for (const r of rows.slice(0, 6)) {
      g.fillStyle = "#e8f0ff";
      g.font = "bold 23px 'Consolas', monospace";
      g.fillText(`$${r.symbol.slice(0, 9)}${r.dry ? " ᴰ" : ""}`, C.sym, y);
      g.fillStyle = "#93a3c2";
      g.font = "22px 'Consolas', monospace";
      g.fillText(fmtMc(r.entryMcUsd), C.entry, y);
      g.fillText(fmtMc(r.peakMcUsd), C.peak, y);
      if (r.multiplier != null) {
        g.fillStyle = r.multiplier >= 2 ? "#39ff88" : r.multiplier >= 1.2 ? "#7fffd4" : "#ff8ca0";
        g.font = "bold 23px 'Consolas', monospace";
        g.fillText(`${r.multiplier.toFixed(2)}x`, C.x, y);
      } else {
        g.fillStyle = "#5a6680";
        g.fillText("…", C.x, y);
      }
      g.fillStyle = "#5a6680";
      g.font = "20px 'Consolas', monospace";
      g.fillText(ago(r.at), C.age, y);
      y += 36;
    }

    // ---- action ticker: what the desk DID ----
    const AK: Record<string, string> = {
      CALL: "#39ff88", BUY: "#7fffd4", SELL: "#ffb454", RECEIVED: "#89ddff", BUYBACK: "#ffd700", BURN: "#ff5c33",
    };
    y = Math.max(y + 10, 396);
    g.fillStyle = "#5a7290";
    g.font = "bold 18px 'Consolas', monospace";
    g.fillText("── DESK ACTIONS ──", PX, y);
    y += 32;
    for (const a of this.lastActions.slice().reverse().slice(0, 5)) {
      if (y > H - PB - 24) break;
      g.fillStyle = AK[a.kind] ?? "#c8d0e0";
      g.font = "bold 20px 'Consolas', monospace";
      g.fillText(a.kind.padEnd(9), PX, y);
      g.fillStyle = "#dfe8fa";
      g.fillText(`$${a.symbol.slice(0, 12)}`, PX + 142, y);
      g.fillStyle = "#5a6680";
      g.fillText(ago(a.at), PX + 330, y);
      y += 30;
    }
    this.callouts.done();
  }

  private lastTreasury: TreasuryState | null = null;
  private tokenImgs = new Map<string, HTMLImageElement | null>();

  private tokenImg(url: string): HTMLImageElement | null {
    if (this.tokenImgs.has(url)) return this.tokenImgs.get(url) ?? null;
    this.tokenImgs.set(url, null);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      this.tokenImgs.set(url, img);
      if (this.lastTreasury) this.drawTreasury(this.lastTreasury); // repaint with the art
    };
    img.onerror = () => this.tokenImgs.set(url, null);
    img.src = url;
    return null;
  }

  drawTreasury(t: TreasuryState): void {
    this.lastTreasury = t;
    // this TV's visible area starts inset from the canvas edge — keep a fat margin
    const X = 74;
    const g = this.treasury.ctx;
    this.treasury.bg();
    g.textBaseline = "top";
    g.fillStyle = "#ffb454";
    g.font = "bold 34px 'Consolas', monospace";
    g.fillText("◢ THE VAULT", X, 34);

    g.fillStyle = "#e8f0ff";
    g.font = "bold 30px 'Consolas', monospace";
    g.fillText(`${t.sol.toFixed(3)} SOL float`, X, 98);
    g.fillStyle = "#39ff88";
    g.fillText(`${Math.round(t.ownTokens).toLocaleString()} $RIKU held`, X, 142);
    g.fillStyle = "#7fffd4";
    g.font = "22px 'Consolas', monospace";
    g.fillText(`NEVER SOLD — day ${t.neverSoldDays}`, X, 190);

    // ---- the full vault: every token held, with its art (ᴾ = paper) ----
    g.fillStyle = "#7d8aa5";
    g.font = "20px 'Consolas', monospace";
    g.fillText("holdings", X, 238);
    let y = 272;
    const fmtAmt = (n: number) =>
      n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(0);
    if (!(t.holdings ?? []).length) {
      g.fillStyle = "#5a6680";
      g.fillText("(vault empty — for now)", X, y);
      y += 30;
    }
    for (const h of (t.holdings ?? []).slice(0, 6)) {
      if (y > H - 170) break; // leave room for the buybacks block
      const img = h.image ? this.tokenImg(h.image) : null;
      if (img) {
        g.save();
        g.beginPath();
        g.arc(X + 14, y + 12, 14, 0, Math.PI * 2);
        g.clip();
        g.drawImage(img, X, y - 2, 28, 28);
        g.restore();
      } else {
        g.fillStyle = "#1c2740";
        g.beginPath();
        g.arc(X + 14, y + 12, 14, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = h.paper ? "#8fd0ff" : "#e8f0ff";
      g.font = "bold 20px 'Consolas', monospace";
      g.fillText(`$${h.symbol.slice(0, 10)}${h.paper ? " ᴾ" : ""}`, X + 40, y + 3);
      g.fillStyle = "#7d8aa5";
      g.font = "20px 'Consolas', monospace";
      g.fillText(fmtAmt(h.amount), X + 250, y + 3);
      if (h.pnl != null) {
        g.fillStyle = h.pnl >= 0 ? "#39ff88" : "#ff4d6d";
        g.fillText(`${h.pnl >= 0 ? "+" : ""}${h.pnl.toFixed(0)}%`, X + 360, y + 3);
      }
      y += 34;
    }

    g.fillStyle = "#7d8aa5";
    g.font = "20px 'Consolas', monospace";
    g.fillText("recent buybacks", X, y + 10);
    y += 44;
    for (const b of t.buybacks.slice().reverse().slice(0, 4)) {
      if (y > H - 26) break;
      g.fillStyle = "#39ff88";
      g.font = "20px 'Consolas', monospace";
      g.fillText(`+${b.sol.toFixed(3)} SOL`, X, y);
      g.fillStyle = "#5a6680";
      g.fillText(`${b.sig.slice(0, 8)}…`, X + 190, y);
      y += 30;
    }
    this.treasury.done();
  }
}
