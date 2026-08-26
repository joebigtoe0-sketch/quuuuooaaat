import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { STATIONS } from "../protocol.js";

export interface CamView {
  pos: [number, number, number];
  look: [number, number, number];
}
export interface StageLayout {
  screens: Record<string, THREE.Mesh>;
  npc: { x: number; z: number; heading: number; model: string } | null;
  stations: Record<string, { x: number; z: number; face: number }> | null;
  cameras: Record<string, CamView> | null;
  conveyorPath: { start: [number, number, number]; end: [number, number, number] } | null;
  board: { set(lines: string[]): void } | null;
}

/** Scene-name → role mapping. Loose matching (case/space/parens ignored). */
const TV_ROLE: Record<string, "inspection" | "callouts" | "treasury" | "podcastchat"> = {
  TV_2: "inspection",
  TV_1: "callouts",
  TV_left: "treasury",
  podcasttv: "podcastchat", // the podcast set's live-chat screen
};
const SEAT_TERMINAL = "SM_Prop_Chair_07 (2)";
const OBJ_CONVEYOR = "SM_Prop_Roller_Track_01";
const OBJ_TALK = "SM_Prop_Desk_Standing_01";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// ---------- Synty prototype grid (yellow + dark seams, seamless tile) ----------
let protoTex: THREE.CanvasTexture | null = null;
function prototypeGridTexture(): THREE.CanvasTexture {
  if (protoTex) return protoTex;
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#e2a52f"; // the construction yellow from the Unity scene
  g.fillRect(0, 0, 256, 256);
  const grad = g.createLinearGradient(0, 0, 256, 256); // faint depth variation
  grad.addColorStop(0, "rgba(255,255,255,0.05)");
  grad.addColorStop(1, "rgba(0,0,0,0.05)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = "rgba(25,22,12,0.55)"; // dark seams — wrap to a full grid
  g.lineWidth = 8;
  g.strokeRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  protoTex = t;
  return t;
}

/** Rewrite UVs by world-space box projection (tileM meters per tile) so the
 *  grid tiles continuously across axis-aligned walls, floors, and ceilings. */
function boxProjectUVs(mesh: THREE.Mesh, tileM = 0.5): void {
  mesh.updateWorldMatrix(true, false);
  const geom = (mesh.geometry = mesh.geometry.clone());
  const pos = geom.attributes.position as THREE.BufferAttribute;
  const nrmAttr = geom.attributes.normal as THREE.BufferAttribute | undefined;
  const uvs = new Float32Array(pos.count * 2);
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    if (nrmAttr) n.fromBufferAttribute(nrmAttr, i).applyMatrix3(nm);
    else n.set(0, 1, 0);
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    let u: number, w: number;
    if (ay >= ax && ay >= az) { u = v.x; w = v.z; } // floor/ceiling
    else if (ax >= az) { u = v.z; w = v.y; } // x-facing wall
    else { u = v.x; w = v.y; } // z-facing wall
    uvs[i * 2] = u / tileM;
    uvs[i * 2 + 1] = w / tileM;
  }
  geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
}

function addLights(scene: THREE.Scene): void {
  scene.add(new THREE.AmbientLight(0x9aa4c0, 1.4));
  const key = new THREE.DirectionalLight(0xfff5e6, 1.6);
  key.position.set(4, 9, 6);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbfd0ff, 0.5);
  fill.position.set(-6, 6, -4);
  scene.add(fill);
}

export async function buildStage(scene: THREE.Scene): Promise<StageLayout> {
  scene.background = new THREE.Color(0x0a0d16);
  addLights(scene);
  try {
    const gltf = await new GLTFLoader().loadAsync("/room.glb");
    return adoptGlbRoom(scene, gltf.scene);
  } catch (e) {
    console.info("[stage] no /room.glb — greybox set", e);
    return buildGreybox(scene);
  }
}

// ---------- lookup helpers ----------
function findNode(root: THREE.Object3D, target: string): THREE.Object3D | null {
  const t = norm(target);
  let exact: THREE.Object3D | null = null;
  let contains: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!o.name) return;
    const n = norm(o.name);
    if (!exact && n === t) exact = o;
    if (!contains && n.includes(t)) contains = o;
  });
  return exact ?? contains;
}
/** All nodes whose normalized name contains the pattern (e.g. every roller
 *  track segment, every chair) — top-most matches only, no nested dupes. */
function findAll(root: THREE.Object3D, pattern: string, exclude?: RegExp): THREE.Object3D[] {
  const t = norm(pattern);
  const out: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (!o.name) return;
    if (exclude && exclude.test(o.name)) return;
    if (!norm(o.name).includes(t)) return;
    // skip if an ancestor already matched
    let p = o.parent;
    while (p) {
      if (p.name && norm(p.name).includes(t)) return;
      p = p.parent;
    }
    out.push(o);
  });
  return out;
}
/** Union bounding box over several nodes. */
function unionBox(nodes: THREE.Object3D[]): { c: THREE.Vector3; size: THREE.Vector3; box: THREE.Box3 } | null {
  if (!nodes.length) return null;
  const box = new THREE.Box3();
  for (const n of nodes) box.expandByObject(n);
  const c = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(c);
  box.getSize(size);
  return { c, size, box };
}
function worldBox(o: THREE.Object3D): { c: THREE.Vector3; size: THREE.Vector3; box: THREE.Box3 } {
  const box = new THREE.Box3().setFromObject(o);
  const c = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(c);
  box.getSize(size);
  return { c, size, box };
}
const yawTo = (from: THREE.Vector3, to: THREE.Vector3) => Math.atan2(to.x - from.x, to.z - from.z);
const flat = (v: THREE.Vector3) => new THREE.Vector3(v.x, 0, v.z);

// ---------- screen-on-model machinery ----------
/**
 * Find the display surface inside a TV prop and take it over: either a child
 * mesh (or material slot) whose name looks like a screen, or — failing that —
 * the thinnest large child mesh. Rewrites that surface's UVs to span [0,1]
 * across its face so our CanvasTexture maps 1:1 onto the model's display,
 * exactly like a real screen material swap.
 */
function takeOverScreen(tv: THREE.Object3D, roomCenter: THREE.Vector3): THREE.Mesh | null {
  const meshes: THREE.Mesh[] = [];
  tv.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  if (!meshes.length) return null;
  const screenRe = /screen|display|monitor|glass/i;

  // 1) material-slot match on any mesh
  for (const m of meshes) {
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (let slot = 0; slot < mats.length; slot++) {
      if (mats[slot] && screenRe.test(mats[slot].name ?? "")) {
        return convertSurface(m, Array.isArray(m.material) ? slot : null, roomCenter);
      }
    }
  }
  // 2) mesh-name match
  for (const m of meshes) {
    if (screenRe.test(m.name ?? "")) return convertSurface(m, null, roomCenter);
  }
  // 3) heuristic: thinnest child with the largest face area (the display panel)
  let best: THREE.Mesh | null = null;
  let bestScore = 0;
  for (const m of meshes) {
    const { size } = worldBox(m);
    const d = [size.x, size.y, size.z].sort((a, b) => b - a);
    const score = (d[0] * d[1]) / Math.max(d[2], 0.015);
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best ? convertSurface(best, null, roomCenter) : null;
}

/** Rewrite UVs of (mesh | one material group) to span its face, and give that
 *  surface a fresh MeshBasicMaterial the Screens class can paint on. */
function convertSurface(mesh: THREE.Mesh, slot: number | null, roomCenter: THREE.Vector3): THREE.Mesh {
  mesh.updateWorldMatrix(true, false);
  const geom = (mesh.geometry = mesh.geometry.clone());
  const posAttr = geom.attributes.position as THREE.BufferAttribute;

  // which vertex indices belong to the surface?
  let vertexIdx: Set<number> | null = null; // null = all
  if (slot !== null && geom.groups?.length) {
    vertexIdx = new Set();
    const index = geom.index;
    for (const g of geom.groups) {
      if (g.materialIndex !== slot) continue;
      for (let i = g.start; i < g.start + g.count; i++) {
        vertexIdx.add(index ? index.getX(i) : i);
      }
    }
  }

  // face normal: thinnest world dimension of the surface, pointed toward room
  const { c, size } = worldBox(mesh);
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  const dims = [size.x, size.y, size.z];
  let thin = 0;
  for (let i = 1; i < 3; i++) if (dims[i] < dims[thin]) thin = i;
  const n = axes[thin].clone();
  if (flat(roomCenter).sub(flat(c)).dot(n) < 0) n.negate();
  // basis on the face
  const up0 = Math.abs(n.y) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up0, n).normalize();
  const up = new THREE.Vector3().crossVectors(n, right).normalize();

  // project world-space vertices to (u,v)
  const v3 = new THREE.Vector3();
  const uvs = new Float32Array(posAttr.count * 2);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  const proj: [number, number][] = [];
  for (let i = 0; i < posAttr.count; i++) {
    v3.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
    const u = v3.dot(right);
    const vv = v3.dot(up);
    proj.push([u, vv]);
    if (!vertexIdx || vertexIdx.has(i)) {
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      minV = Math.min(minV, vv); maxV = Math.max(maxV, vv);
    }
  }
  const du = Math.max(maxU - minU, 1e-4);
  const dv = Math.max(maxV - minV, 1e-4);
  for (let i = 0; i < posAttr.count; i++) {
    uvs[i * 2] = (proj[i][0] - minU) / du;
    uvs[i * 2 + 1] = (proj[i][1] - minV) / dv;
  }
  geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));

  const screenMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  if (slot !== null && Array.isArray(mesh.material)) {
    const mats = mesh.material.slice();
    mats[slot] = screenMat;
    mesh.material = mats;
    // Screens class writes to (material as MeshBasicMaterial).map — hand it a
    // proxy mesh view whose .material is the screen slot.
    const proxy = new THREE.Mesh();
    Object.defineProperty(proxy, "material", { get: () => mats[slot], set: (m) => (mats[slot] = m) });
    return proxy as THREE.Mesh;
  }
  mesh.material = screenMat;
  return mesh;
}

// ---------- the room adoption ----------
function adoptGlbRoom(scene: THREE.Scene, root: THREE.Object3D): StageLayout {
  root.updateMatrixWorld(true);
  scene.add(root);

  // Unity's Prototype materials pick their texture region via a _MainTex UV
  // offset that the glTF export drops — every wall/floor samples the raw atlas
  // and lands in its cork region. Recreate the authored look instead: the
  // Synty prototype YELLOW GRID, generated as a seamless tile and box-projected
  // in world space so squares tile per half-meter exactly like in Unity.
  const inStudioGroup = (o: THREE.Object3D): boolean => {
    let p: THREE.Object3D | null = o;
    while (p) {
      // the HomeOffice set inside the studio keeps its authored look —
      // only the bare studio shell is the chroma key
      if (/^homeoffice$/i.test(p.name?.trim() ?? "")) return false;
      if (/^tiktok$/i.test(p.name?.trim() ?? "")) return true; // ONLY the tiktok shell is chroma — the podcast set keeps its authored look
      p = p.parent;
    }
    return false;
  };
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.material) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    if (!mats.some((mat: any) => /PolygonPrototype/i.test(mat?.name ?? ""))) return;
    // the STUDIOS keep their authored look — walls/floor there are the
    // chroma key, and the yellow-grid swap was repainting them (takes 2+3)
    if (inStudioGroup(m)) {
      const green = mats.map((mat: any) =>
        /PolygonPrototype/i.test(mat?.name ?? "")
          ? new THREE.MeshStandardMaterial({ name: "ChromaGreen", color: 0x00b140, roughness: 1 })
          : mat);
      m.material = Array.isArray(m.material) ? green : green[0];
      return;
    }
    const allProto = mats.every((mat: any) => /PolygonPrototype/i.test(mat?.name ?? ""));
    if (allProto) boxProjectUVs(m, 0.5); // safe: no other material shares these UVs
    const isFloor = /floor/i.test(m.name);
    const isCeiling = isFloor && worldBox(m).c.y > 2.5;
    const swap = mats.map((mat: any) => {
      if (!/PolygonPrototype/i.test(mat?.name ?? "")) return mat;
      return new THREE.MeshStandardMaterial({
        name: mat.name,
        map: allProto ? prototypeGridTexture() : null,
        // texture is authored yellow; floors a touch deeper, ceilings dimmer
        color: allProto ? (isCeiling ? 0x8a8a8a : isFloor ? 0xc9c9c9 : 0xffffff)
                        : (isCeiling ? 0x9c6a17 : isFloor ? 0xc9962e : 0xe9ae35),
        roughness: 0.95,
      });
    });
    m.material = Array.isArray(m.material) ? swap : swap[0];
  });

  let npc: StageLayout["npc"] = null;
  root.traverse((o) => {
    if (!npc && o.name?.startsWith("NPC_")) {
      const wp = o.getWorldPosition(new THREE.Vector3());
      const we = new THREE.Euler().setFromQuaternion(o.getWorldQuaternion(new THREE.Quaternion()), "YXZ");
      npc = { x: wp.x, z: wp.z, heading: we.y, model: o.name.slice(4) };
      o.visible = false;
    }
  });

  const tvNodes: Record<string, THREE.Object3D> = {};
  for (const name of Object.keys(TV_ROLE)) {
    const nnode = findNode(root, name);
    if (nnode) tvNodes[name] = nnode;
  }
  const podium = findNode(root, OBJ_TALK);
  // the belt is MANY roller segments — union them into one long belt
  const beltSegs = findAll(root, "Roller_Track");
  const beltBox = unionBox(beltSegs);
  // chairs: don't trust "(2)" surviving glTF renames — collect all chairs and
  // assign by proximity: terminal chair = nearest TV_2, bigscreen chair = nearest TV_1
  const chairs = findAll(root, "Chair");
  const nearestChair = (to: THREE.Vector3 | null, not?: THREE.Object3D | null) => {
    if (!to) return null;
    let best: THREE.Object3D | null = null;
    let bd = Infinity;
    for (const ch of chairs) {
      if (ch === not) continue;
      const d = flat(worldBox(ch).c).distanceTo(flat(to));
      if (d < bd) {
        bd = d;
        best = ch;
      }
    }
    return best;
  };
  const tv2C = tvNodes.TV_2 ? worldBox(tvNodes.TV_2).c : null;
  const tv1C = tvNodes.TV_1 ? worldBox(tvNodes.TV_1).c : null;
  const seat = nearestChair(tv2C) ?? findNode(root, SEAT_TERMINAL);
  const seatBig = nearestChair(tv1C, seat);

  // interior reference: the podium (center of the floor) or npc spot
  const interior = podium
    ? flat(worldBox(podium).c)
    : npc
      ? new THREE.Vector3((npc as any).x, 0, (npc as any).z)
      : new THREE.Vector3();

  // "front" = perpendicular to the belt (the belt runs along the back wall),
  // pointing from the belt toward the podium. Robust against side-wall TVs.
  let front: THREE.Vector3;
  let along: THREE.Vector3;
  if (beltBox) {
    along = beltBox.size.x >= beltBox.size.z ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    front = new THREE.Vector3(along.z, 0, -along.x);
    if (interior.clone().sub(flat(beltBox.c)).dot(front) < 0) front.negate();
  } else {
    const wallAvg = [tv1C, tv2C].filter(Boolean).length
      ? [tv1C, tv2C].filter(Boolean).reduce((a, p) => a!.add(flat(p!)), new THREE.Vector3())!.multiplyScalar(1 / [tv1C, tv2C].filter(Boolean).length)
      : new THREE.Vector3(0, 0, -4);
    front = interior.clone().sub(wallAvg).setY(0).normalize();
    along = new THREE.Vector3(front.z, 0, -front.x);
    if (front.lengthSq() < 0.01) front.set(0, 0, 1);
  }

  // ---- screens ON the TV models ----
  const screens: Record<string, THREE.Mesh> = {};
  for (const [name, role] of Object.entries(TV_ROLE)) {
    const node = tvNodes[name];
    if (!node) continue;
    const surf = takeOverScreen(node, interior);
    if (surf) screens[role] = surf;
  }
  ensureScreens(scene, screens);

  // paint the corkboard (between the two back-wall TVs) — agent-writable
  let boardHandle: BoardHandle | null = null;
  if (tv1C && tv2C) {
    const mid = tv1C.clone().add(tv2C).multiplyScalar(0.5);
    boardHandle = paintTodoBoard(scene, mid, interior);
  }

  // audience-view right: viewer looks along -front; viewerRight = (-front) × up
  const viewerRight = new THREE.Vector3().crossVectors(front.clone().negate(), new THREE.Vector3(0, 1, 0)).normalize();

  // ---- stations ----
  const stations: Record<string, { x: number; z: number; face: number }> = {};
  const put = (id: string, p: THREE.Vector3, faceToward: THREE.Vector3) =>
    (stations[id] = { x: p.x, z: p.z, face: yawTo(flat(p), flat(faceToward)) });

  // terminal: sit AT the chair nearest TV_2, facing that TV
  if (seat) put("terminal", flat(worldBox(seat).c), tv2C ?? interior.clone().sub(front));
  // bigscreen: sit at the chair nearest TV_1 (the second work desk)
  if (seatBig) put("bigscreen", flat(worldBox(seatBig).c), tv1C ?? interior.clone().sub(front));
  else if (tv1C) put("bigscreen", flat(tv1C).add(front.clone().multiplyScalar(1.3)), tv1C);

  // conveyor: CENTERED on the belt, standing in front of it
  let conveyorPath: StageLayout["conveyorPath"] = null;
  if (beltBox) {
    const clear = Math.min(beltBox.size.x, beltBox.size.z) / 2 + 0.6;
    put("conveyor", flat(beltBox.c).add(front.clone().multiplyScalar(clear)), beltBox.c);
    // coins ride the FULL belt: from the right wall to the left wall (audience view)
    const half = Math.max(beltBox.size.x, beltBox.size.z) / 2 + 0.6; // poke into the walls
    const y = beltBox.box.max.y + 0.24;
    const dir = along.clone();
    if (dir.dot(viewerRight) < 0) dir.negate(); // dir now points to audience-right
    conveyorPath = {
      start: [beltBox.c.x + dir.x * half, y, beltBox.c.z + dir.z * half], // appears from right wall
      end: [beltBox.c.x - dir.x * half, y, beltBox.c.z - dir.z * half], // vanishes into left wall
    };
  }
  // inbox: right beside the terminal desk — he takes deliveries without
  // leaving the tape (falls back to mid-belt if there is no terminal chair)
  if (stations.terminal) {
    const t = stations.terminal;
    const p = new THREE.Vector3(t.x, 0, t.z)
      .add(viewerRight.clone().multiplyScalar(1.4))
      .add(front.clone().multiplyScalar(0.4));
    put("inbox", p, beltBox ? beltBox.c : p.clone().sub(front)); // face the belt
  } else if (beltBox) {
    const clear = Math.min(beltBox.size.x, beltBox.size.z) / 2 + 0.6;
    const inboxP = flat(beltBox.c).add(front.clone().multiplyScalar(clear));
    put("inbox", inboxP, inboxP.clone().sub(front));
  }
  // talk podium: stand BEHIND the desk (back-wall side), facing the audience —
  // the same direction the wide camera looks from
  if (podium) {
    const wb = worldBox(podium);
    const clear = Math.min(wb.size.x, wb.size.z) / 2 + 0.45;
    const behind = flat(wb.c).sub(front.clone().multiplyScalar(clear));
    put("camera_mark", behind, flat(wb.c).add(front.clone().multiplyScalar(6)));
  }
  // idle: hanging out by the facecam mark (the standing desk), one step to the
  // side so he's not ON the mark — facing the audience like the facecam does
  if (stations.camera_mark) {
    const m = stations.camera_mark;
    const p = new THREE.Vector3(m.x, 0, m.z).add(viewerRight.clone().multiplyScalar(1.2));
    put("idle_spot", p, p.clone().add(front));
  } else if (npc) {
    const p = new THREE.Vector3((npc as any).x, 0, (npc as any).z);
    put("idle_spot", p, p.clone().add(front));
  } else if (podium) {
    const wb = worldBox(podium);
    put("idle_spot", flat(wb.c).add(viewerRight.clone().multiplyScalar(-1.6)).add(front.clone().multiplyScalar(0.6)), flat(beltBox?.c ?? wb.c));
  }
  // vault: stand before TV_left (side-wall TV)
  if (tvNodes.TV_left) {
    const wb = worldBox(tvNodes.TV_left);
    const toRoom = interior.clone().sub(flat(wb.c)).setY(0).normalize();
    put("vault", flat(wb.c).add(toRoom.multiplyScalar(1.3)), wb.c);
  }
  // greenscreen film set. Find the prop by name, else by COLOR (the biggest
  // predominantly-green mesh in the room IS the green screen).
  let greenscreenNode: THREE.Object3D | null =
    findAll(root, "Greenscreen")[0] ?? findAll(root, "Green_Screen")[0] ?? findAll(root, "GreenScreen")[0] ?? null;
  if (!greenscreenNode) {
    let bestArea = 0.5;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const isGreen = mats.some((mat: any) => {
        const c = mat?.color as THREE.Color | undefined;
        if (!c) return false;
        const hsl = { h: 0, s: 0, l: 0 };
        c.getHSL(hsl);
        return hsl.h > 0.22 && hsl.h < 0.45 && hsl.s > 0.35 && hsl.l > 0.15 && hsl.l < 0.8;
      });
      if (!isGreen) return;
      const { size } = worldBox(m);
      const dims = [size.x, size.y, size.z].sort((a, b) => b - a);
      const area = dims[0] * dims[1];
      if (area > bestArea) {
        bestArea = area;
        greenscreenNode = m;
      }
    });
  }
  const tripodNode = findAll(root, "Tripod")[0] ?? findAll(root, "Camera", /TV|screen/i)[0] ?? null;
  let filmCam: CamView | null = null;
  if (greenscreenNode) {
    const gs = worldBox(greenscreenNode);
    // direction OFF the screen: toward the tripod if the scene has one (it is
    // the authored film setup), else toward the room interior
    const off = tripodNode
      ? flat(worldBox(tripodNode).c).sub(flat(gs.c)).setY(0).normalize()
      : interior.clone().sub(flat(gs.c)).setY(0).normalize();
    if (off.lengthSq() < 0.01) off.copy(front);
    // he stands hugging the cloth. The found node can be the whole film-set
    // prop (screen + frame + floor sweep), whose CENTER sits well into the
    // room — so anchor on the box's REAR face along the off-axis (that's the
    // wall-side cloth) and stand just 0.35m in front of it.
    const halfDepth = (Math.abs(off.x) * gs.size.x + Math.abs(off.z) * gs.size.z) / 2;
    const stand = flat(gs.c).sub(off.clone().multiplyScalar(halfDepth)).add(off.clone().multiplyScalar(1.0));
    // the film camera IS the tripod: shoot from its head at the stand
    const camPos = tripodNode
      ? flat(worldBox(tripodNode).c)
      : stand.clone().add(off.clone().multiplyScalar(1.9));
    put("greenscreen", stand, camPos); // he faces the lens
    filmCam = { pos: [camPos.x, 1.58, camPos.z], look: [stand.x, 1.4, stand.z] };
  }
  console.info(
    `[stage] greenscreen:${greenscreenNode ? (greenscreenNode as any).name || "by-color" : "NOT FOUND"} tripod:${tripodNode ? (tripodNode as any).name : "none"}`,
  );
  // tiktok studio: stand on the authored spot, facing the front tiktok camera
  {
    const spot = findAll(root, "tiktokstandingspot")[0] ?? null;
    if (spot) {
      spot.updateWorldMatrix(true, false);
      const p = spot.getWorldPosition(new THREE.Vector3());
      const camN = findAll(root, "TiktokCameraFront")[0] ?? null;
      const lookAt = camN
        ? camN.getWorldPosition(new THREE.Vector3())
        : p.clone().add(front.clone().multiplyScalar(2));
      put("tiktok", new THREE.Vector3(p.x, 0, p.z), new THREE.Vector3(lookAt.x, 0, lookAt.z));
    }
  }
  // podcast set: two seats facing each other, a kickoff mark and a guest door
  {
    const at = (n: string) => {
      const o = findAll(root, n)[0] ?? null;
      if (!o) return null;
      o.updateWorldMatrix(true, false);
      return o.getWorldPosition(new THREE.Vector3());
    };
    const hs = at("HostSeat"), gs = at("GuestSeat");
    const pi = at("podcastidle"), pe = at("podcastenter");
    if (hs && gs) {
      put("host_seat", new THREE.Vector3(hs.x, 0, hs.z), new THREE.Vector3(gs.x, 0, gs.z));
      put("guest_seat", new THREE.Vector3(gs.x, 0, gs.z), new THREE.Vector3(hs.x, 0, hs.z));
    }
    const wideCam = findAll(root, "PodcastCamera")[0] ?? null;
    const camPos = wideCam ? wideCam.getWorldPosition(new THREE.Vector3()) : null;
    if (pi) put("podcast_idle", new THREE.Vector3(pi.x, 0, pi.z),
      camPos ? new THREE.Vector3(camPos.x, 0, camPos.z) : new THREE.Vector3(pi.x, 0, pi.z + 2));
    if (pe) put("podcast_enter", new THREE.Vector3(pe.x, 0, pe.z),
      pi ? new THREE.Vector3(pi.x, 0, pi.z) : new THREE.Vector3(pe.x, 0, pe.z + 2));
  }
  for (const id of ["idle_spot", "inbox", "terminal", "bigscreen", "vault", "conveyor", "camera_mark", "tiktok",
                    "podcast_idle", "podcast_enter", "host_seat", "guest_seat"] as const) {
    if (!stations[id]) stations[id] = { ...STATIONS[id] };
  }

  // ---- cameras ----
  // wide: frame the CENTRAL action (between the two back-wall TVs), not the
  // whole wall — much closer, show-like
  let spanC: THREE.Vector3;
  let spanW: number;
  if (tv1C && tv2C) {
    spanC = flat(tv1C).add(flat(tv2C)).multiplyScalar(0.5);
    spanW = flat(tv1C).distanceTo(flat(tv2C)) + 3.0;
  } else if (beltBox) {
    spanC = flat(beltBox.c);
    spanW = Math.max(beltBox.size.x, beltBox.size.z) * 0.55;
  } else {
    spanC = interior.clone();
    spanW = 10;
  }
  const halfHfov = Math.atan(Math.tan((50 / 2) * (Math.PI / 180)) * (16 / 9)); // ≈39.6°
  // tight show shot: frame the central action, hard-capped close
  const wideDist = Math.min(spanW / 2 / Math.tan(halfHfov) + 0.5, 7.0);
  const widePos = spanC.clone().add(front.clone().multiplyScalar(wideDist));
  const cameras: Record<string, CamView> = {
    wide: { pos: [widePos.x, 2.3, widePos.z], look: [spanC.x, 1.3, spanC.z] },
    terminal: (() => {
      const t = stations.terminal;
      const tv = tv2C ?? new THREE.Vector3(spanC.x, 1.6, spanC.z);
      const p = new THREE.Vector3(t.x, 0, t.z).add(front.clone().multiplyScalar(2.1)).add(viewerRight.clone().multiplyScalar(0.7));
      return { pos: [p.x, 2.0, p.z], look: [tv.x, tv.y * 0.85, tv.z] } as CamView;
    })(),
    facecam: (() => {
      const m = stations.camera_mark;
      const p = new THREE.Vector3(m.x, 0, m.z).add(front.clone().multiplyScalar(3.0));
      return { pos: [p.x, 1.6, p.z], look: [m.x, 1.45, m.z] } as CamView;
    })(),
    vault: (() => {
      const tv = tvNodes.TV_left ? worldBox(tvNodes.TV_left).c : spanC;
      const s = stations.vault;
      const p = new THREE.Vector3(s.x, 0, s.z).add(interior.clone().sub(flat(tv)).setY(0).normalize().multiplyScalar(2.2));
      return { pos: [p.x, 2.0, p.z], look: [tv.x, tv.y, tv.z] } as CamView;
    })(),
    film: filmCam ?? ({ pos: [widePos.x, 2.0, widePos.z], look: [spanC.x, 1.4, spanC.z] } as CamView),
    bigscreen: (() => {
      const s = stations.bigscreen ?? stations.terminal;
      const tv = tv1C ?? spanC;
      const p = new THREE.Vector3(s.x, 0, s.z).add(front.clone().multiplyScalar(2.1)).add(viewerRight.clone().multiplyScalar(-0.7));
      return { pos: [p.x, 2.0, p.z], look: [tv.x, tv.y * 0.85, tv.z] } as CamView;
    })(),
  };

  // ---- Unity-authored cameras override the derived ones ----
  // Accepts both naming styles: Camera_<key> empties, or actual Unity camera
  // objects named WideCamera / CloseupCamera / GreenscreenCamera / VaultCamera
  // / TerminalCamera. Aim comes from CameraTarget_<key> if present, else the
  // node's own rotation (a real Unity camera points where you aimed it).
  const findByRegex = (re: RegExp): THREE.Object3D | null => {
    let hit: THREE.Object3D | null = null;
    root.traverse((o) => {
      if (!hit && re.test(o.name.trim())) hit = o;
    });
    return hit;
  };
  const CAM_ALIASES: Record<string, RegExp> = {
    wide: /^(Camera_wide|WideCamera)$/i,
    terminal: /^(Camera_terminal|TerminalCamera)$/i,
    facecam: /^(Camera_facecam|CloseupCamera|FaceCamera)$/i,
    vault: /^(Camera_vault|VaultCamera)$/i,
    film: /^(Camera_film|GreenscreenCamera|FilmCamera)$/i,
    bigscreen: /^(Camera_bigscreen|BigscreenCamera|BigScreenCamera)$/i,
    tiktok_front: /^(Camera_tiktok_front|TiktokCameraFront)$/i,
    tiktok_left: /^(Camera_tiktok_left|TiktokCameraLeft)$/i,
    tiktok_right: /^(Camera_tiktok_right|TiktokCameraRight)$/i,
    tiktok_face: /^(Camera_tiktok_face|TiktokCameraFace)$/i,
    podcast_wide: /^(Camera_podcast_wide|PodcastCamera)$/i,
    podcast_host: /^(Camera_podcast_host|HostCamera)$/i,
    podcast_guest: /^(Camera_podcast_guest|GuestCamera)$/i,
  };
  for (const key of ["wide", "terminal", "facecam", "vault", "film", "bigscreen", "tiktok_front", "tiktok_left", "tiktok_right", "tiktok_face",
                        "podcast_wide", "podcast_host", "podcast_guest"] as const) {
    const camNode = findByRegex(CAM_ALIASES[key]);
    if (!camNode) continue;
    camNode.updateWorldMatrix(true, false);
    const p = camNode.getWorldPosition(new THREE.Vector3());
    const tgtNode = findByRegex(new RegExp(`^CameraTarget_${key}$`, "i"));
    let look: THREE.Vector3;
    if (tgtNode) {
      look = tgtNode.getWorldPosition(new THREE.Vector3());
    } else {
      // Unity camera forward (+Z) survives the glTF conversion as the node's
      // local +Z (these export as plain nodes, not glTF cameras) — project 4m
      const fwd = new THREE.Vector3(0, 0, 1)
        .applyQuaternion(camNode.getWorldQuaternion(new THREE.Quaternion()))
        .normalize();
      look = p.clone().addScaledVector(fwd, 4);
      if (fwd.lengthSq() < 0.5) look = new THREE.Vector3(interior.x, 1.3, interior.z);
    }
    // tiktok cams aim at the TALENT, not their authored forward — Unity
    // camera objects export facing -Z while empties face +Z, and guessing
    // wrong films the wall behind the studio (take two taught this)
    if (key === "podcast_host" && stations.host_seat)
      look = new THREE.Vector3(stations.host_seat.x, 1.25, stations.host_seat.z);
    else if (key === "podcast_guest" && stations.guest_seat)
      look = new THREE.Vector3(stations.guest_seat.x, 1.25, stations.guest_seat.z);
    else if (key === "podcast_wide" && stations.host_seat && stations.guest_seat)
      look = new THREE.Vector3(
        (stations.host_seat.x + stations.guest_seat.x) / 2, 1.2,
        (stations.host_seat.z + stations.guest_seat.z) / 2);
    else if (key.startsWith("tiktok") && stations.tiktok) {
      // wide shots aim at BODY CENTER (~0.9m) so the full body frames up;
      // the face cam aims at the head — that is its whole job
      const aimY = key === "tiktok_face" ? 1.5 : 0.9;
      look = new THREE.Vector3(stations.tiktok.x, aimY, stations.tiktok.z);
    }
    cameras[key] = { pos: [p.x, p.y, p.z], look: [look.x, look.y, look.z] };
    console.info(`[stage] camera '${key}' ← Unity '${camNode.name}'${tgtNode ? " (+target)" : " (own rotation)"}`);
  }

  // face cam fallback when not authored in the model: the front tiktok cam
  // pulled in tight to head height, aimed at the head. An authored
  // TiktokCameraFace overrides this via the adoption loop above.
  if (!cameras.tiktok_face && cameras.tiktok_front && stations.tiktok) {
    const head = new THREE.Vector3(stations.tiktok.x, 1.5, stations.tiktok.z);
    const from = new THREE.Vector3(...cameras.tiktok_front.pos);
    const pos = from.clone().lerp(head, 0.62);
    pos.y = Math.max(1.42, pos.y);
    cameras.tiktok_face = { pos: [pos.x, pos.y, pos.z], look: [head.x, head.y, head.z] };
    console.info("[stage] camera 'tiktok_face' derived from tiktok_front (author TiktokCameraFace to override)");
  }

  // idle: dead-center of the FINAL wide shot — stand 55% of the way from the
  // lens to its look point, facing the camera. Beats any marker guesswork.
  if (cameras.wide) {
    const cpos = new THREE.Vector3(...cameras.wide.pos);
    const look = new THREE.Vector3(...cameras.wide.look);
    const p = flat(cpos).lerp(flat(look), 0.72); // deeper in the shot, near the belt
    stations.idle_spot = { x: p.x, z: p.z, face: yawTo(p, flat(cpos)) };
  }

  console.info(
    `[stage] room wired — tvs:${Object.keys(tvNodes).join(",")} chairs:${chairs.length} beltSegs:${beltSegs.length} podium:${!!podium}`,
  );
  return { screens, npc, stations, cameras, conveyorPath, board: boardHandle };
}

/** Quant's corkboard: TODO header + his own handwritten lines. He rewrites
 *  it over time via the agent `board` action. Returns the live updater. */
export interface BoardHandle {
  set(lines: string[]): void;
}
function paintTodoBoard(scene: THREE.Scene, at: THREE.Vector3, roomCenter: THREE.Vector3): BoardHandle {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 720;
  const g = c.getContext("2d")!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;

  const draw = (lines: string[]) => {
    g.clearRect(0, 0, 512, 720);
    g.fillStyle = "#f6f4ea";
    g.font = "900 76px 'Arial Black', Impact, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "top"; // header hugs the very top edge of the board
    g.shadowColor = "rgba(0,0,0,0.35)";
    g.shadowOffsetY = 4;
    g.shadowBlur = 6;
    g.fillText("TODO", 256, 6);
    g.shadowColor = "transparent";
    // handwritten notes, pinned under the header — word-wrapped to the board,
    // never clipped at the edge
    g.textAlign = "left";
    g.textBaseline = "middle";
    const FONT = "italic 30px 'Segoe Print', 'Comic Sans MS', cursive";
    const MAX_W = 512 - 62 - 16; // left text margin to right edge
    let y = 118;
    for (const line of lines.slice(0, 7)) {
      if (y > 690) break;
      // wrap into at most 2 lines; ellipsis if it still doesn't fit
      g.font = FONT;
      const words = line.split(/\s+/);
      const rows: string[] = [];
      let cur = "";
      for (const w of words) {
        const tryLine = cur ? cur + " " + w : w;
        if (g.measureText(tryLine).width <= MAX_W) cur = tryLine;
        else {
          if (cur) rows.push(cur);
          cur = w;
          if (rows.length === 2) break;
        }
      }
      if (rows.length < 2 && cur) rows.push(cur);
      if (rows.length === 2 && cur && rows[1] !== cur) {
        while (g.measureText(rows[1] + "…").width > MAX_W && rows[1].length > 1) rows[1] = rows[1].slice(0, -1);
        rows[1] += "…";
      }
      g.fillStyle = "#e0524d"; // pin
      g.beginPath();
      g.arc(38, y - 2, 7, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#fdf9ee";
      for (const r of rows.slice(0, 2)) {
        g.fillText(r, 62, y);
        y += 38;
      }
      y += 20;
    }
    tex.needsUpdate = true;
  };
  draw([]);

  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(1.15, 1.62),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }),
  );
  const toRoom = flat(roomCenter).sub(flat(at)).normalize();
  if (toRoom.lengthSq() < 0.01) toRoom.set(0, 0, 1);
  quad.position.copy(at).add(toRoom.clone().multiplyScalar(0.06));
  quad.rotation.y = Math.atan2(toRoom.x, toRoom.z);
  scene.add(quad);
  return { set: draw };
}

// ---------- fallbacks ----------
function makeScreenQuad(scene: THREE.Scene, w: number, h: number, x: number, y: number, z: number, ry = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: 0x0a0f18 }));
  mesh.position.set(x, y, z);
  mesh.rotation.y = ry;
  scene.add(mesh);
  return mesh;
}
function ensureScreens(scene: THREE.Scene, screens: Record<string, THREE.Mesh>): void {
  if (!screens.inspection) screens.inspection = makeScreenQuad(scene, 2.4, 1.5, STATIONS.terminal.x, 1.7, -3.9);
  if (!screens.callouts) screens.callouts = makeScreenQuad(scene, 2.6, 1.6, STATIONS.bigscreen.x, 1.9, -3.9);
  if (!screens.treasury) screens.treasury = makeScreenQuad(scene, 2.2, 1.5, -7.85, 2.0, -1.6, Math.PI / 2);
}

function buildGreybox(scene: THREE.Scene): StageLayout {
  scene.fog = new THREE.Fog(0x0a0d16, 14, 30);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(16, 12), new THREE.MeshStandardMaterial({ color: 0x11141f, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const grid = new THREE.GridHelper(16, 32, 0x1c2740, 0x141a2a);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.35;
  scene.add(grid);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x0d1120, roughness: 1 });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(16, 6), wallMat);
  back.position.set(0, 3, -4);
  scene.add(back);
  const screens: Record<string, THREE.Mesh> = {};
  ensureScreens(scene, screens);
  return { screens, npc: null, stations: null, cameras: null, conveyorPath: null, board: null };
}
