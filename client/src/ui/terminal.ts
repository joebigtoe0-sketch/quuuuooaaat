/**
 * QUANT://LOG — the agent terminal overlay. Shows everything the agent does or
 * WOULD do (dry tweets, plans, trades, film scripts, lessons) with full text.
 * Toggle: the ▤ button (bottom-right, subtle) or the `t` key. History loads
 * from /admin/feed on first open; live entries stream in over the socket.
 */
interface FeedEntry {
  at: number;
  kind: string;
  text: string;
}

const KIND_COLOR: Record<string, string> = {
  "tweet-dry": "#7fffd4",
  "tweet-live": "#39ff88",
  tweet: "#7fffd4",
  plan: "#c792ea",
  trade: "#ffb454",
  research: "#82aaff",
  "film-script": "#a5e075",
  film: "#a5e075",
  scout: "#89ddff",
  "x-chatter": "#89ddff",
  lesson: "#ffd700",
  diary: "#aab6d0",
  strategy: "#ff9e64",
  kol: "#89ddff",
  callout: "#39ff88",
  buyback: "#ffd700",
  say: "#ffffff",
  thought: "#b8a7ff",
};

function kindColor(kind: string): string {
  if (KIND_COLOR[kind]) return KIND_COLOR[kind];
  if (kind.startsWith("error")) return "#ff4d6d";
  if (kind.startsWith("warn")) return "#ff9e64";
  if (kind.startsWith("sys")) return "#5a7290";
  return "#8a97b3";
}

export class AgentTerminal {
  private panel: HTMLDivElement;
  private back: HTMLDivElement;
  private list: HTMLDivElement;
  private open = false;
  private loaded = false;

  constructor(parent: HTMLElement, private httpBase: string) {
    // same centered terminal-window chrome as wallet/stats (classes from panels.ts)
    this.back = document.createElement("div");
    this.back.className = "pwinBack";
    parent.appendChild(this.back);
    this.panel = document.createElement("div");
    this.panel.className = "pwin";
    this.panel.innerHTML =
      `<div class="bar"><span class="dots"><i></i><i></i><i></i></span>` +
      `<span class="title">RIKU://LOG</span><button id="term-x">✕</button></div>` +
      `<div class="body" id="term-body" style="display:flex;flex-direction:column;gap:9px"></div>` +
      `<div class="foot">LIVE AGENT FEED · EVERYTHING HE DOES OR WOULD DO · T TO CLOSE</div>`;
    parent.appendChild(this.panel);
    this.list = this.panel.querySelector<HTMLDivElement>("#term-body")!;
    this.panel.querySelector<HTMLButtonElement>("#term-x")!.onclick = () => this.toggle();
    this.back.onclick = () => this.toggle();

    addEventListener("keydown", (e) => {
      if ((e.key === "t" || e.key === "T") && !(e.target instanceof HTMLInputElement)) this.toggle();
    });
  }

  toggle(): void {
    this.open = !this.open;
    this.panel.style.display = this.open ? "flex" : "none";
    this.back.style.display = this.open ? "block" : "none";
    if (this.open && !this.loaded) {
      this.loaded = true;
      fetch(this.httpBase + "/admin/feed")
        .then((r) => r.json())
        .then((j: { entries: FeedEntry[] }) => {
          for (const e of j.entries ?? []) this.append(e, false);
          this.scrollDown();
        })
        .catch(() => {});
    }
    if (this.open) this.scrollDown();
  }

  /** Live entry from the socket — always appended, even while closed. */
  push(e: FeedEntry): void {
    if (!this.loaded) return; // history will include it on first open
    this.append(e, true);
  }

  private append(e: FeedEntry, live: boolean): void {
    const row = document.createElement("div");
    const color = kindColor(e.kind);
    const time = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    row.innerHTML =
      `<div style="display:flex;gap:8px;align-items:baseline">` +
      `<span style="color:#4a5a78;font-size:11px;white-space:nowrap">${time}</span>` +
      `<span style="color:${color};font-weight:bold;font-size:11px;letter-spacing:1px;white-space:nowrap">${e.kind.toUpperCase()}</span></div>` +
      `<div style="color:#dfe8fa;margin:2px 0 0 0;white-space:pre-wrap;word-break:break-word;line-height:1.4">${escapeHtml(e.text)}</div>`;
    row.style.cssText = `border-left:2px solid ${color};padding:4px 10px;background:rgba(255,255,255,0.015);border-radius:0 6px 6px 0;`;
    this.list.appendChild(row);
    while (this.list.children.length > 250) this.list.removeChild(this.list.firstChild!);
    if (live && this.open) this.scrollDown();
  }

  private scrollDown(): void {
    this.list.scrollTop = this.list.scrollHeight;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}
