import { STATIONS, WALK_SPEED } from "../stations.js";
import type { StationId } from "../protocol.js";
import type { Hub } from "../hub.js";

/**
 * The guest's body — a second server-authoritative avatar, same movement model
 * as RIKU's Locomotion but broadcast as `guest_pose` cues so the client can
 * drive a separate Avatar instance. Only alive during an episode.
 */
export class GuestBody {
  x = STATIONS.podcast_enter.x;
  y = STATIONS.podcast_enter.y ?? 0;
  z = STATIONS.podcast_enter.z;
  heading = STATIONS.podcast_enter.face;
  anim = "idle";
  seated = false;

  private target: { x: number; z: number; face: number; y?: number } | null = null;
  private arriveResolve: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private hub: Hub) {}

  start(): void {
    if (this.timer) return;
    // snap to the door before the first tick so he never slides in from 0,0
    this.x = STATIONS.podcast_enter.x;
    this.y = STATIONS.podcast_enter.y ?? 0;
    this.z = STATIONS.podcast_enter.z;
    this.heading = STATIONS.podcast_enter.face;
    this.timer = setInterval(() => this.tick(0.1), 100);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.target = null;
    this.arriveResolve?.();
    this.arriveResolve = null;
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
        this.y = this.target.y ?? 0;
        this.heading = this.target.face;
        this.anim = "idle";
        this.target = null;
        this.arriveResolve?.();
        this.arriveResolve = null;
      } else {
        this.x += (dx / dist) * step;
        this.z += (dz / dist) * step;
        const ty = this.target.y ?? 0;
        this.y += (ty - this.y) * Math.min(1, dt * 3);
        this.heading = Math.atan2(dx, dz);
        this.anim = "walk";
      }
    }
    this.hub.cue({
      t: "guest_pose",
      x: Number(this.x.toFixed(3)),
      y: Number(this.y.toFixed(3)),
      z: Number(this.z.toFixed(3)),
      heading: Number(this.heading.toFixed(3)),
      anim: this.anim,
      seated: this.seated,
    });
  }

  walkTo(station: StationId): Promise<void> {
    const s = STATIONS[station];
    this.seated = false;
    const dist = Math.hypot(s.x - this.x, s.z - this.z);
    if (dist < 0.05) {
      this.heading = s.face;
      return Promise.resolve();
    }
    this.target = s;
    // an overridden walk resolves its old awaiter instead of stranding it
    this.arriveResolve?.();
    return new Promise((resolve) => {
      this.arriveResolve = resolve;
    });
  }

  sit(on: boolean): void {
    this.seated = on;
  }
}
