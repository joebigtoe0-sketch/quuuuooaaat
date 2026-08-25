import * as THREE from "three";
import type { ConveyorItem } from "../protocol.js";

/**
 * Fresh launches ride the belt as COINS — gold-rimmed cylinders with the
 * token's image on the face (falls back to its ticker). New arrivals queue
 * and release only when the previous coin has cleared MIN_GAP, so they never
 * overlap no matter how fast launches come in.
 */
interface Coin {
  group: THREE.Group;
  mint: string;
  t: number; // 0..1 along the path
}

const MIN_GAP = 0.85; // meters between coin centers at spawn
const COIN_R = 0.176; // 20% smaller per producer's eye

function tickerTexture(symbol: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#141b2e";
  g.beginPath();
  g.arc(128, 128, 128, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#e8f0ff";
  g.font = `bold ${symbol.length > 5 ? 52 : 68}px Consolas, monospace`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(`$${symbol.slice(0, 7)}`, 128, 132);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Conveyor {
  private coins: Coin[] = [];
  private pending: ConveyorItem[] = [];
  private root = new THREE.Group();
  private start = new THREE.Vector3(4.5, 0.95, -3.55);
  private end = new THREE.Vector3(-4.5, 0.95, -3.55);
  private speed = 0.35;
  private facing = 0;
  private texLoader = new THREE.TextureLoader();
  private rimMat = new THREE.MeshStandardMaterial({ color: 0xd4af37, roughness: 0.35, metalness: 0.85 });

  constructor(private scene: THREE.Scene) {
    scene.add(this.root);
    this.texLoader.setCrossOrigin("anonymous");
  }

  useDefaultSlab(): void {
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(9, 0.1, 0.7),
      new THREE.MeshStandardMaterial({ color: 0x0c1120, roughness: 0.8, metalness: 0.4 }),
    );
    slab.position.set(0, 0.85, -3.55);
    this.scene.add(slab);
  }

  setPath(start: [number, number, number], end: [number, number, number], faceToward?: [number, number]): void {
    this.start.set(...start);
    this.end.set(...end);
    if (faceToward) {
      const mid = this.start.clone().add(this.end).multiplyScalar(0.5);
      this.facing = Math.atan2(faceToward[0] - mid.x, faceToward[1] - mid.z);
    }
  }

  add(item: ConveyorItem): void {
    if (this.coins.find((b) => b.mint === item.mint) || this.pending.find((p) => p.mint === item.mint)) return;
    this.pending.push(item);
    if (this.pending.length > 20) this.pending.shift(); // firehose guard
  }

  /** Spawn is gated: only when the last coin has cleared MIN_GAP. */
  private trySpawn(): void {
    if (!this.pending.length) return;
    const len = Math.max(this.start.distanceTo(this.end), 0.01);
    const last = this.coins[this.coins.length - 1];
    if (last && last.t * len < MIN_GAP) return;
    const item = this.pending.shift()!;

    const group = new THREE.Group();
    // the coin: gold rim cylinder, face toward the room
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(COIN_R, COIN_R, 0.09, 40), this.rimMat);
    rim.rotation.x = Math.PI / 2; // face the ±Z of the group
    group.add(rim);

    const faceMat = new THREE.MeshBasicMaterial({ map: tickerTexture(item.symbol), toneMapped: false });
    const face = new THREE.Mesh(new THREE.CircleGeometry(COIN_R * 0.88, 40), faceMat);
    face.position.z = 0.051;
    group.add(face);
    const back = new THREE.Mesh(new THREE.CircleGeometry(COIN_R * 0.88, 40), faceMat);
    back.position.z = -0.051;
    back.rotation.y = Math.PI;
    group.add(back);

    // async: swap the ticker face for the real token image when it loads.
    // ipfs.io and gateway.pinata now 403/timeout, so the fallback is our own
    // server's img-proxy (same-origin: no CORS worries for the WebGL texture,
    // and it retries live gateways server-side).
    if (item.image) {
      const hash = item.image.match(/\/ipfs\/([^/?#]+)/)?.[1];
      const proxied = `/img-proxy?u=${encodeURIComponent(item.image)}`;
      const urls = hash
        ? [`https://pump.mypinata.cloud/ipfs/${hash}?img-width=256&img-dpr=1`, proxied]
        : [item.image, proxied];
      const tryLoad = (idx: number): void => {
        if (idx >= urls.length) return; // all failed → keep ticker face
        this.texLoader.load(
          urls[idx],
          (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            faceMat.map = tex;
            faceMat.needsUpdate = true;
          },
          undefined,
          () => tryLoad(idx + 1),
        );
      };
      tryLoad(0);
    }

    group.position.copy(this.start);
    group.rotation.y = this.facing;
    this.root.add(group);
    this.coins.push({ group, mint: item.mint, t: 0 });
  }

  pick(mint: string): void {
    const b = this.coins.find((x) => x.mint === mint);
    if (!b) return;
    b.group.position.y += 0.45;
    b.group.children.forEach((ch) => {
      const m = (ch as THREE.Mesh).material as THREE.MeshStandardMaterial;
      if (m && "emissive" in m) {
        m.emissive = new THREE.Color(0x0affd4);
        m.emissiveIntensity = 0.7;
      }
    });
  }

  update(dt: number): void {
    this.trySpawn();
    // adaptive belt speed: when launches pile up in the queue, the belt runs
    // faster so the stage always keeps pace with the live tape
    const targetSpeed = Math.min(1.3, 0.35 * (1 + this.pending.length * 0.35));
    this.speed += (targetSpeed - this.speed) * Math.min(1, dt * 2);
    const len = Math.max(this.start.distanceTo(this.end), 0.01);
    for (const b of this.coins) {
      b.t += (this.speed * dt) / len;
      b.group.position.lerpVectors(this.start, this.end, Math.min(b.t, 1));
      b.group.children[0].rotation.y += dt * 0.8; // slow rim spin, coin feel
    }
    const gone = this.coins.filter((b) => b.t >= 1.02);
    for (const b of gone) this.root.remove(b.group);
    this.coins = this.coins.filter((b) => b.t < 1.02);
  }
}
