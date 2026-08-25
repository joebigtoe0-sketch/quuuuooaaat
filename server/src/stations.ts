import fs from "node:fs";
import path from "node:path";
import { cfg } from "./config.js";
import type { StationId } from "./protocol.js";

/**
 * The stage floor plan, in meters. Defaults match the greybox set; a Unity
 * room can override them at runtime (the client extracts Station_<id> marker
 * positions from room.glb and POSTs them to /admin/layout). Persisted so the
 * override survives a restart.
 */
const DEFAULTS: Record<StationId, { x: number; z: number; face: number }> = {
  conveyor: { x: 0.0, z: -3.2, face: Math.PI },
  vault: { x: -4.2, z: -2.2, face: Math.PI },
  bigscreen: { x: -1.4, z: -2.4, face: Math.PI },
  inbox: { x: 3.6, z: -2.0, face: Math.PI },
  terminal: { x: 1.2, z: -0.6, face: Math.PI },
  idle_spot: { x: -0.6, z: -0.8, face: 0 }, // ~2m back from the original 1.2 — wide cam wants him small
  camera_mark: { x: 1.8, z: 1.6, face: 0 },
  greenscreen: { x: 5.6, z: 0.2, face: Math.PI / 2 },
  tiktok: { x: 6.5, z: 3.0, face: 0 }, // placeholder — the glb tiktokstandingspot overrides via layout
};

export const STATIONS: Record<StationId, { x: number; z: number; face: number }> = { ...DEFAULTS };
export const WALK_SPEED = 1.5; // m/s

const LAYOUT_FILE = path.join(cfg.dataDir, "layout.json");

/** Merge a partial station map (unknown ids ignored) and persist. */
export function applyLayout(stations: Record<string, { x: number; z: number; face?: number }>): string[] {
  const applied: string[] = [];
  for (const [id, s] of Object.entries(stations ?? {})) {
    if (id in STATIONS && typeof s?.x === "number" && typeof s?.z === "number") {
      STATIONS[id as StationId] = { x: s.x, z: s.z, face: typeof s.face === "number" ? s.face : STATIONS[id as StationId].face };
      applied.push(id);
    }
  }
  if (applied.length) {
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      fs.writeFileSync(LAYOUT_FILE, JSON.stringify({ stations: STATIONS }, null, 1));
    } catch {}
  }
  return applied;
}

// load a persisted room layout at boot
try {
  const j = JSON.parse(fs.readFileSync(LAYOUT_FILE, "utf8"));
  if (j?.stations) applyLayout(j.stations);
} catch {
  /* no saved layout — use defaults */
}
