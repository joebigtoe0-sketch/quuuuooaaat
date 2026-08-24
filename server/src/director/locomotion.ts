import { STATIONS, WALK_SPEED as WALK_SPEED_REAL } from "../stations.js";
import { cfg } from "../config.js";
const WALK_SPEED = WALK_SPEED_REAL * (cfg.simMode ? cfg.simSpeed : 1);
import type { StationId } from "../protocol.js";
import type { Hub } from "../hub.js";

/**
 * Server-authoritative avatar movement: straight-line segments between
 * authored waypoints, 10Hz ticks. The client only interpolates.
 */
export class Locomotion {
  x = STATIONS.idle_spot.x;
  z = STATIONS.idle_spot.z;
  heading = STATIONS.idle_spot.face;
  anim = "idle";
  seated = false;
  stateName = "BOOT";

  private target: { x: number; z: number; face: number } | null = null;
  private arriveResolve: (() => void) | null = null;

  constructor(private hub: Hub) {
    setInterval(() => this.tick(0.1), 100);
  }

  private tick(dt: number): void {
    if (this.target) {
      const dx = this.target.x - this.x;
      const dz = this.target.z - this.z;
      const dist = Math.hypot(dx, dz);
      const step = WALK_SPEED * dt;
      if (dist <= step) {
        this.x = this.target.x;
        this.z = this.target.z;
        this.heading = this.target.face;
        this.anim = "idle";
        this.target = null;
        this.arriveResolve?.();
        this.arriveResolve = null;
      } else {
        this.x += (dx / dist) * step;
        this.z += (dz / dist) * step;
        this.heading = Math.atan2(dx, dz);
        this.anim = "walk";
      }
    }
    this.hub.broadcast({
      t: "tick",
      x: Number(this.x.toFixed(3)),
      z: Number(this.z.toFixed(3)),
      heading: Number(this.heading.toFixed(3)),
      anim: this.anim,
      seated: this.seated,
      state: this.stateName,
    });
  }

  /** Walk to a station; resolves on arrival. */
  walkTo(station: StationId): Promise<void> {
    const s = STATIONS[station];
    this.seated = false;
    const dist = Math.hypot(s.x - this.x, s.z - this.z);
    if (dist < 0.05) {
      this.heading = s.face;
      return Promise.resolve();
    }
    this.hub.cue({ t: "walk", to: station, durMs: Math.round((dist / WALK_SPEED) * 1000) });
    this.target = s;
    // a new walk overrides the old target — resolve the old awaiter instead of
    // stranding it forever (an orphaned walk promise froze the whole stage:
    // postAnimBusy never cleared, ambient never ran again)
    this.arriveResolve?.();
    return new Promise((resolve) => {
      this.arriveResolve = resolve;
    });
  }

  sit(on: boolean): void {
    if (this.seated && !on) {
      // standing up: step back out of the chair (opposite his facing, which
      // points at the desk/TV) so idle fidgets don't play inside the seat.
      // A subsequent walkTo simply overrides this target.
      this.target = {
        x: this.x - Math.sin(this.heading) * 0.9,
        z: this.z - Math.cos(this.heading) * 0.9,
        face: this.heading,
      };
    }
    this.seated = on;
  }
}
