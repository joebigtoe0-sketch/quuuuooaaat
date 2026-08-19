import WebSocket from "ws";
import { log } from "../log.js";
import type { ConveyorItem } from "../protocol.js";

/**
 * PumpPortal data websocket → the conveyor belt of fresh launches.
 * Data feed only (the no-PumpPortal rule applies to TRADING, not data).
 * Auto-reconnects; the conveyor simply pauses when the feed is down.
 */
// pump's own pinata gateway is the reliable one for pump.fun metadata;
// ipfs.io rate-limits hard when launches come in waves
const GATEWAYS = ["https://pump.mypinata.cloud/ipfs/", "https://ipfs.io/ipfs/"];
const ipfsHash = (u: string) =>
  u.match(/^ipfs:\/\/(.+)$/)?.[1] ?? u.match(/\/ipfs\/([^/?#]+)/)?.[1] ?? null;

/** Token metadata json (ipfs) → image URL. Tries two gateways, best-effort. */
async function enrichImage(uri: string): Promise<string | null> {
  if (!uri) return null;
  const hash = ipfsHash(uri);
  const urls = hash ? GATEWAYS.map((g) => g + hash) : [uri];
  for (const u of urls) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 4500);
      const res = await fetch(u, { signal: controller.signal, headers: { accept: "application/json" } });
      clearTimeout(t);
      if (!res.ok) continue;
      const j: any = await res.json();
      const img = typeof j?.image === "string" ? j.image : null;
      if (!img) return null;
      const imgHash = ipfsHash(img);
      // normalize the image itself to the reliable gateway
      return imgHash ? GATEWAYS[0] + imgHash : /^https?:\/\//.test(img) ? img : null;
    } catch {
      /* next gateway */
    }
  }
  return null;
}
export function startLaunchFeed(onLaunch: (item: ConveyorItem) => void): void {
  let ws: WebSocket | null = null;
  let alive = false;

  const connect = () => {
    try {
      ws = new WebSocket("wss://pumpportal.fun/api/data");
    } catch {
      return setTimeout(connect, 5000);
    }
    ws.on("open", () => {
      alive = true;
      log.info("feed", "pumpportal connected — subscribing to new launches");
      ws!.send(JSON.stringify({ method: "subscribeNewToken" }));
    });
    ws.on("message", (data) => {
      try {
        const m = JSON.parse(String(data));
        if (m?.mint && (m?.txType === "create" || m?.name)) {
          // belt takes STANDARD pump launches only — no mayhem/other pools
          const pool = String(m.pool ?? "pump").toLowerCase();
          if (pool !== "pump") return;
          const item = {
            mint: String(m.mint),
            name: String(m.name ?? "").slice(0, 40) || String(m.mint).slice(0, 6),
            symbol: String(m.symbol ?? "").slice(0, 12) || "?",
            mcSol: typeof m.marketCapSol === "number" ? m.marketCapSol : undefined,
            dev: typeof m.traderPublicKey === "string" ? m.traderPublicKey : undefined,
          };
          // best-effort image enrichment from the token's ipfs metadata —
          // the coin face on the belt. Never blocks or fails the launch event.
          void enrichImage(String(m.uri ?? ""))
            .then((image) => onLaunch(image ? { ...item, image } : item))
            .catch(() => onLaunch(item));
        }
      } catch {}
    });
    ws.on("close", () => {
      if (alive) log.warn("feed", "pumpportal disconnected — retrying");
      alive = false;
      setTimeout(connect, 5000);
    });
    ws.on("error", () => {});
  };
  connect();
}
