import type { ServerMsg } from "./protocol.js";

/** Reconnecting WS client (adapted from casino net.js) for the Quant stage. */
export class Net {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, ((m: any) => void)[]>();
  connected = false;

  constructor(private url: string) {}

  on(type: string, fn: (m: any) => void): void {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type)!.push(fn);
  }
  private emit(type: string, m: any): void {
    for (const fn of this.handlers.get(type) ?? []) fn(m);
  }

  connect(): void {
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      return this.retry();
    }
    this.ws.onopen = () => {
      this.connected = true;
      this.emit("connected", {});
    };
    this.ws.onmessage = (ev) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.emit(m.t, m);
    };
    this.ws.onclose = () => {
      this.connected = false;
      this.emit("offline", {});
      this.retry();
    };
    this.ws.onerror = () => {};
  }

  private retry(): void {
    setTimeout(() => this.connect(), 2500);
  }
}
