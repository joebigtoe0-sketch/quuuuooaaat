// Dump world-space positions/boxes of the interesting nodes in room.glb —
// ground truth for stage wiring, no browser needed. Plain Node, no deps:
// GLB = 12-byte header + JSON chunk; accessor min/max gives mesh bounds.
import fs from "node:fs";

const path = process.argv[2] || new URL("../../client/public/room.glb", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const buf = fs.readFileSync(path);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));

// --- minimal mat math ---
const I = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function compose(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const xform = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
];

const nodes = gltf.nodes ?? [];
const world = new Array(nodes.length).fill(null);
function walk(i, parent) {
  const n = nodes[i];
  const local = n.matrix ? n.matrix : compose(n.translation, n.rotation, n.scale);
  world[i] = mul(parent, local);
  for (const c of n.children ?? []) walk(c, world[i]);
}
for (const scene of gltf.scenes ?? []) for (const r of scene.nodes ?? []) walk(r, I());

// box of a node = union of its subtree's primitive accessor min/max, world-transformed
function nodeBox(i) {
  let box = null;
  const visit = (j) => {
    const n = nodes[j];
    if (n.mesh !== undefined) {
      for (const prim of gltf.meshes[n.mesh].primitives ?? []) {
        const acc = gltf.accessors[prim.attributes?.POSITION];
        if (!acc?.min || !acc?.max) continue;
        // 8 corners
        for (const cx of [acc.min[0], acc.max[0]])
          for (const cy of [acc.min[1], acc.max[1]])
            for (const cz of [acc.min[2], acc.max[2]]) {
              const p = xform(world[j], [cx, cy, cz]);
              if (!box) box = { min: [...p], max: [...p] };
              else
                for (let k = 0; k < 3; k++) {
                  box.min[k] = Math.min(box.min[k], p[k]);
                  box.max[k] = Math.max(box.max[k], p[k]);
                }
            }
      }
    }
    for (const c of n.children ?? []) visit(c);
  };
  visit(i);
  return box;
}

const fmt = (v) => v.map((x) => x.toFixed(2)).join(",");
const interesting = /TV|Green|Tripod|Camera|Chair|Roller|Desk_Standing|NPC_|Screen|Cork|Notice/i;
const out = [];
nodes.forEach((n, i) => {
  if (!n.name || !interesting.test(n.name)) return;
  // skip nested dupes whose parent also matches
  const b = nodeBox(i);
  const w = world[i];
  const pos = [w[12], w[13], w[14]];
  out.push({
    name: n.name,
    pos: fmt(pos),
    box: b ? `c=${fmt([(b.min[0]+b.max[0])/2,(b.min[1]+b.max[1])/2,(b.min[2]+b.max[2])/2])} size=${fmt([b.max[0]-b.min[0],b.max[1]-b.min[1],b.max[2]-b.min[2]])}` : "(no mesh)",
  });
});
for (const o of out) console.log(o.name.padEnd(36), "pos", o.pos.padEnd(22), o.box);
