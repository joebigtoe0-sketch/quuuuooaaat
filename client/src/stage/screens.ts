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
      g.fillText("@quant · drafting", 88, 140);
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
    g.fillStyle = "#2affd4";
    g.font = "bold 34px 'Consolas', monospace";
    g.fillText("◢ RESEARCH TERMINAL", 28, 24);
    g.fillStyle = "#e8f0ff";
    g.font = "bold 40px 'Consolas', monospace";
    g.fillText(`$${(s.symbol || "—").slice(0, 12)}`, 28, 74);
    g.fillStyle = "#7d8aa5";
    g.font = "20px 'Consolas', monospace";
    g.fillText((s.name || "").slice(0, 40), 28, 124);
    if (s.source) {
      g.fillStyle = s.source.startsWith("SENT") ? "#89ddff" : "#ffd700";
      g.fillText(`${s.source.startsWith("SENT") ? "📨" : "🔍"} ${s.source.slice(0, 44)}`, 28, 150);
    }

    let y = 194;
    g.font = "22px 'Consolas', monospace";
    for (const r of s.rows.slice(-11)) {
      g.fillStyle = VERDICT_COLOR[r.verdict];
      const mark = r.verdict === "pass" ? "✓" : r.verdict === "fail" ? "✗" : r.verdict === "warn" ? "!" : "?";
      g.fillText(mark, 30, y);
      g.fillStyle = "#aab6d0";
      g.fillText(r.label.padEnd(12).slice(0, 12), 62, y);
      g.fillStyle = "#dfe8fa";
      g.fillText(r.detail.slice(0, 44), 220, y);
      y += 30;
    }

    if (s.score !== null) {
      g.fillStyle = "#7d8aa5";
      g.font = "20px 'Consolas', monospace";
      g.fillText("SCORE", 30, H - 78);
      // score bar
      g.fillStyle = "#132033";
      g.fillRect(120, H - 80, 500, 26);
      const col = s.score >= 55 ? "#39ff88" : s.score >= 35 ? "#ffb454" : "#ff4d6d";
      g.fillStyle = col;
      g.fillRect(120, H - 80, 5 * s.score, 26);
      g.fillStyle = "#fff";
      g.font = "bold 22px 'Consolas', monospace";
      g.fillText(String(s.score), 636, H - 80);
    }
    if (s.tier) {
      g.fillStyle = TIER_COLOR[s.tier] ?? "#fff";
      g.font = "bold 40px 'Consolas', monospace";
      g.textAlign = "right";
      g.fillText(s.tier, W - 30, H - 46);
      g.textAlign = "left";
    }
    this.inspection.done();
  }

  private lastCards: CalloutCard[] = [];
  private lastActions: ActionEvent[] = [];

  drawCallouts(cards?: CalloutCard[], actions?: ActionEvent[]): void {
    if (cards) this.lastCards = cards;
    if (actions) this.lastActions = actions;
    const g = this.callouts.ctx;
    this.callouts.bg();
    g.textBaseline = "top";
    g.fillStyle = "#2affd4";
    g.font = "bold 34px 'Consolas', monospace";
    g.fillText("◢ CALLS ON THE RECORD", 28, 24);
    let y = 86;
    if (!this.lastCards.length) {
      g.fillStyle = "#6b7690";
      g.font = "22px 'Consolas', monospace";
      g.fillText("no calls yet — send Riku a coin", 30, y);
      y += 40;
    }
    for (const c of this.lastCards.slice().reverse().slice(0, 6)) {
      g.fillStyle = TIER_COLOR[c.tier] ?? "#c8d0e0";
      g.font = "bold 24px 'Consolas', monospace";
      g.fillText(`$${c.symbol.slice(0, 10)}`, 30, y);
      g.fillStyle = "#7d8aa5";
      g.font = "18px 'Consolas', monospace";
      g.fillText(c.dry ? "[dry]" : c.tier, 210, y + 3);
      g.fillStyle = "#aeb9d2";
      g.fillText(c.text.slice(0, 52), 320, y + 3);
      y += 40;
    }

    // ---- action ticker: what the desk DID ----
    const AK: Record<string, string> = {
      CALL: "#39ff88", BUY: "#7fffd4", SELL: "#ffb454", RECEIVED: "#89ddff", BUYBACK: "#ffd700",
    };
    y = Math.max(y + 14, 350);
    g.fillStyle = "#5a7290";
    g.font = "bold 20px 'Consolas', monospace";
    g.fillText("── DESK ACTIONS ──", 30, y);
    y += 34;
    const ago = (at: number) => {
      const m = Math.max(0, Math.round((Date.now() - at) / 60000));
      return m < 1 ? "now" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
    };
    for (const a of this.lastActions.slice().reverse().slice(0, 6)) {
      g.fillStyle = AK[a.kind] ?? "#c8d0e0";
      g.font = "bold 20px 'Consolas', monospace";
      g.fillText(a.kind.padEnd(9), 30, y);
      g.fillStyle = "#dfe8fa";
      g.fillText(`$${a.symbol.slice(0, 12)}`, 172, y);
      g.fillStyle = "#5a6680";
      g.fillText(ago(a.at), 360, y);
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
