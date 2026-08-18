import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/**
 * The wardrobe: browse every extracted Sidekick part, preview live, save the
 * combination — the server rebuilds SK_Quant.glb with Blender on apply.
 * Parts all share one rig and rest pose, so a preview is just "load the FBXs
 * and stack them"; no rebinding needed for a static look.
 */
const httpBase = location.port === "5199" ? "http://127.0.0.1:8490" : "";

// UI slot groups: label → slot codes filled together (L/R pairs move as one)
const GROUPS: [string, string[]][] = [
  ["Hair", ["02HAIR"]],
  ["Face hair (beard)", ["09FCHR"]],
  ["Torso", ["10TORS"]],
  ["Upper arms", ["11AUPL", "12AUPR"]],
  ["Lower arms", ["13ALWL", "14ALWR"]],
  ["Hands", ["15HNDL", "16HNDR"]],
  ["Hips", ["17HIPS"]],
  ["Legs", ["18LEGL", "19LEGR"]],
  ["Feet", ["20FOTL", "21FOTR"]],
];
// attachment slots (hats, backpacks, etc.) get their own optional groups
const FACE_BASE = ["01HEAD", "03EBRL", "04EBRR", "05EYEL", "06EYER", "07EARL", "08EARR", "35NOSE", "36TETH", "37TONG"];

type Part = { path: string; pack: string; id: string };
let manifest: { slots: Record<string, Part[]>; textures: Record<string, { id: string; path: string }[]>; anims?: string[]; saved: any };
const selection = new Map<string, Part | null>(); // slot -> part
const body = { heavy: 0, skinny: 0, buff: 0, feminine: 0 };
// FBXLoader prefixes morph names with the deformer ("TORSBlends.defaultHeavy")
// — match by suffix so every part responds regardless of its prefix
const BODY_SUFFIX: [string, keyof typeof body][] = [
  ["defaultHeavy", "heavy"], ["defaultSkinny", "skinny"],
  ["defaultBuff", "buff"], ["masculineFeminine", "feminine"],
];
function applyBodyShapes(): void {
  charGroup.traverse((o: any) => {
    if (!o.morphTargetDictionary || !o.morphTargetInfluences) return;
    for (const [name, idx] of Object.entries(o.morphTargetDictionary) as [string, number][]) {
      for (const [suffix, key] of BODY_SUFFIX) {
        if (name === suffix || name.endsWith("." + suffix)) o.morphTargetInfluences[idx] = body[key];
      }
    }
  });
}
const texSel = new Map<string, string>(); // Characters group -> colormap relpath

// ---------- posing: emotes + expressions + photos ----------
// Posing runs on the BAKED character (SK_Quant.glb + anims_sk.glb) — the exact
// pipeline the live stage uses, so poses are guaranteed correct. The FBX
// paper-doll can't be animated: raw part rigs and GLB clips disagree on bone
// conventions (face-plant), and FBXLoader crashes on the Synty anim FBXes.
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
const mixers: THREE.AnimationMixer[] = [];
let poseFrozen = false;
let currentEmote = "";
let currentExpr = "neutral";
let photoGroup: THREE.Group | null = null; // the baked character, when posing
let clipLib: Map<string, THREE.AnimationClip> | null = null;

async function loadClipLib(): Promise<Map<string, THREE.AnimationClip>> {
  if (clipLib) return clipLib;
  const g = await new GLTFLoader().loadAsync(`${httpBase}/chars/anims_sk.glb?w=${Date.now()}`);
  clipLib = new Map();
  for (const clip of g.animations) clipLib.set(clip.name.replace(/\.\d+$/, ""), clip);
  return clipLib;
}

/** Swap the preview to the baked character (photo mode). */
async function enterPhotoMode(): Promise<void> {
  if (photoGroup) return;
  statusEl.innerHTML = `<span class="note">loading the saved character for posing…</span>`;
  const g = await new GLTFLoader().loadAsync(`${httpBase}/chars/SK_Quant.glb?w=${Date.now()}`);
  photoGroup = new THREE.Group();
  photoGroup.add(g.scene);
  g.scene.traverse((o: any) => {
    if (o.isMesh || o.isSkinnedMesh) o.frustumCulled = false;
  });
  // normalize like the fitting preview: ~1.8m tall, feet on the grid
  const bb = new THREE.Box3().setFromObject(photoGroup);
  if (!bb.isEmpty()) {
    const size = bb.getSize(new THREE.Vector3());
    const s = 1.8 / Math.max(0.01, size.y);
    photoGroup.scale.setScalar(s);
    const bb2 = new THREE.Box3().setFromObject(photoGroup);
    photoGroup.position.y -= bb2.min.y;
    photoGroup.position.x -= (bb2.min.x + bb2.max.x) / 2;
    photoGroup.position.z -= (bb2.min.z + bb2.max.z) / 2;
  }
  scene.add(photoGroup);
  charGroup.visible = false;
  statusEl.innerHTML = `<span class="note">photo mode — posing the SAVED character (SAVE &amp; APPLY first to shoot a new outfit)</span>`;
}

function exitPhotoMode(): void {
  for (const mx of mixers) mx.stopAllAction();
  mixers.length = 0;
  if (photoGroup) {
    scene.remove(photoGroup);
    photoGroup = null;
  }
  charGroup.visible = true;
  statusEl.innerHTML = "";
}

const poseTarget = () => photoGroup ?? charGroup;

async function applyEmote(): Promise<void> {
  for (const mx of mixers) mx.stopAllAction();
  mixers.length = 0;
  if (!currentEmote) return;
  await enterPhotoMode();
  const clip = (await loadClipLib()).get(currentEmote);
  if (!clip || !photoGroup) return;
  const mx = new THREE.AnimationMixer(photoGroup.children[0]);
  const act = mx.clipAction(clip);
  act.setLoop(THREE.LoopRepeat, Infinity);
  act.play();
  mixers.push(mx);
  applyExpression();
}

// facial expressions (mirror of Avatar.EXPRESSIONS in avatar.js)
const EXPRESSIONS: Record<string, Record<string, number>> = {
  neutral: {},
  happy: { mouthSmileLeft: 0.75, mouthSmileRight: 0.75, browInnerUpLeft: 0.25, browInnerUpRight: 0.25, cheekSquintLeft: 0.3, cheekSquintRight: 0.3 },
  sad: { mouthFrownLeft: 0.65, mouthFrownRight: 0.65, browInnerUpLeft: 0.6, browInnerUpRight: 0.6 },
  angry: { browFrownLeft: 0.9, browFrownRight: 0.9, cheekSquintLeft: 0.45, cheekSquintRight: 0.45, mouthPressLeft: 0.5, mouthPressRight: 0.5 },
  smug: { mouthSmileLeft: 0.75, mouthDimpleLeft: 0.5, browOuterUpLeft: 0.45, cheekSquintRight: 0.25 },
  shock: { jawOpen: 0.45, browInnerUpLeft: 0.85, browInnerUpRight: 0.85, browOuterUpLeft: 0.6, browOuterUpRight: 0.6 },
  thinking: { browInnerDownLeft: 0.35, browInnerDownRight: 0.35, mouthPressLeft: 0.35, eyeSquintLeft: 0.2 },
};
const EXPR_KEYS = new Set(Object.values(EXPRESSIONS).flatMap((e) => Object.keys(e)));

function applyExpression(): void {
  const expr = EXPRESSIONS[currentExpr] ?? {};
  poseTarget().traverse((o: any) => {
    if (!o.morphTargetDictionary || !o.morphTargetInfluences) return;
    for (const [name, idx] of Object.entries(o.morphTargetDictionary) as [string, number][]) {
      const bare = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
      if (!EXPR_KEYS.has(bare)) continue; // never clobber body sliders
      o.morphTargetInfluences[idx] = expr[bare] ?? 0;
    }
  });
}

function snapshotPNG(transparent: boolean): void {
  const prevBg = scene.background;
  const gridWasVisible = grid.visible;
  if (transparent) {
    scene.background = null;
    grid.visible = false;
  }
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL("image/png");
  scene.background = prevBg;
  grid.visible = gridWasVisible;
  const a = document.createElement("a");
  a.href = url;
  a.download = `quant_${currentEmote || "pose"}_${currentExpr}_${Date.now()}.png`;
  a.click();
}

// ---------- three ----------
const view = document.getElementById("view")!;
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setSize(view.clientWidth || 800, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0e18);
scene.add(new THREE.AmbientLight(0xaab4d0, 1.6));
const sun = new THREE.DirectionalLight(0xfff2e0, 2.2);
sun.position.set(3, 6, 4);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(45, (view.clientWidth || 800) / innerHeight, 0.01, 100);
camera.position.set(0, 1.4, 2.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.95, 0);
const charGroup = new THREE.Group();
scene.add(charGroup);
const grid = new THREE.GridHelper(4, 8, 0x1c3350, 0x11213a);
scene.add(grid);
const animClock = new THREE.Clock();
(function loop() {
  requestAnimationFrame(loop);
  controls.update();
  const dt = animClock.getDelta();
  if (!poseFrozen) for (const mx of mixers) mx.update(dt);
  renderer.render(scene, camera);
})();
addEventListener("resize", () => {
  renderer.setSize(view.clientWidth, innerHeight);
  camera.aspect = view.clientWidth / innerHeight;
  camera.updateProjectionMatrix();
});

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const manager = new THREE.LoadingManager();
manager.setURLModifier((url) => (/\.fbx(\?|$)/i.test(url) ? url : PIXEL));
const loader = new FBXLoader(manager);

// ---------- palette painting ----------
// Sidekick ColorMaps are tiny palette atlases (32×32 flat-color cells), so a
// recolor is a pixel swap: click the character → find the palette cell under
// the cursor → replace that color across the map. Edits persist in the saved
// config and are re-applied by Blender on SAVE & APPLY.
type Edit = { from: string; to: string; similar: number };
const recolor: Record<string, Edit[]> = {}; // colormap relpath -> edits
type CanvasTex = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; base: ImageData | null; tex: THREE.CanvasTexture };
const canvasCache = new Map<string, CanvasTex>();

function colormap(rel: string): THREE.Texture {
  let c = canvasCache.get(rel);
  if (!c) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    c = { canvas, ctx, base: null, tex };
    canvasCache.set(rel, c);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const cc = canvasCache.get(rel)!;
      cc.canvas.width = img.naturalWidth;
      cc.canvas.height = img.naturalHeight;
      cc.ctx.drawImage(img, 0, 0);
      try {
        cc.base = cc.ctx.getImageData(0, 0, cc.canvas.width, cc.canvas.height);
      } catch {
        cc.base = null; // tainted (cross-origin dev) — texture still shows, paint disabled
      }
      repaint(rel);
    };
    img.src = `${httpBase}/sidekick-raw/${rel}`;
  }
  return c.tex;
}

const hex2rgb = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgb2hex = (c: number[]): string => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
function rgb2hsl([r, g, b]: number[]): number[] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : max === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
  return [h, s, l];
}
function hsl2rgb([h, s, l]: number[]): number[] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Re-derive the canvas from the pristine image + this map's edit list. */
function repaint(rel: string): void {
  const c = canvasCache.get(rel);
  if (!c?.base) return;
  const img = new ImageData(new Uint8ClampedArray(c.base.data), c.base.width, c.base.height);
  const d = img.data;
  for (const e of recolor[rel] ?? []) {
    const fr = hex2rgb(e.from), to = hex2rgb(e.to);
    const fh = rgb2hsl(fr), th = rgb2hsl(to);
    for (let i = 0; i < d.length; i += 4) {
      const dr = d[i] - fr[0], dg = d[i + 1] - fr[1], db = d[i + 2] - fr[2];
      if (Math.abs(dr) < 2 && Math.abs(dg) < 2 && Math.abs(db) < 2) {
        d[i] = to[0]; d[i + 1] = to[1]; d[i + 2] = to[2];
      } else if (e.similar > 0 && Math.sqrt(dr * dr + dg * dg + db * db) <= e.similar) {
        // a nearby shade (shadow ramp): carry the hue shift, scale sat/light
        const p = rgb2hsl([d[i], d[i + 1], d[i + 2]]);
        p[0] = ((p[0] + th[0] - fh[0]) % 1 + 1) % 1;
        p[1] = fh[1] > 0.03 ? clamp01(p[1] * th[1] / fh[1]) : th[1];
        p[2] = fh[2] > 0.03 ? clamp01(p[2] * th[2] / fh[2]) : th[2];
        const [r, g, b] = hsl2rgb(p);
        d[i] = r; d[i + 1] = g; d[i + 2] = b;
      }
    }
  }
  c.ctx.putImageData(img, 0, 0);
  c.tex.needsUpdate = true;
}

function texForPart(p: Part): string | null {
  if (p.pack === "HumanBase") {
    return texSel.get("HumanSpecies") ?? manifest.textures.HumanSpecies?.[0]?.path ?? null;
  }
  return texSel.get(p.pack) ?? manifest.textures[p.pack]?.[0]?.path ?? null;
}

let rebuildSeq = 0;
async function rebuildPreview(): Promise<void> {
  const seq = ++rebuildSeq;
  const parts: Part[] = [];
  for (const slot of FACE_BASE) {
    const base = manifest.slots[slot]?.find((p) => p.id.startsWith("SK_HUMN_BASE_01"));
    if (base) parts.push(base);
  }
  for (const [, p] of selection) if (p) parts.push(p);

  const loaded: THREE.Group[] = [];
  let failed = 0;
  await Promise.all(
    parts.map(async (p) => {
      try {
        const obj = await loader.loadAsync(`${httpBase}/sidekick-raw/${p.path}`);
        const texRel = texForPart(p);
        const mat = new THREE.MeshStandardMaterial({
          map: texRel ? colormap(texRel) : null,
          roughness: 0.85,
          metalness: 0,
        });
        obj.traverse((o: any) => {
          if (o.isMesh || o.isSkinnedMesh) {
            o.material = mat;
            o.frustumCulled = false;
            o.userData.texRel = texRel; // which colormap this part samples (for painting)
          }
        });
        loaded.push(obj);
      } catch (e) {
        failed++;
        console.warn("[wardrobe] part failed:", p.path, e);
      }
    }),
  );
  if (seq !== rebuildSeq) return; // superseded
  if (photoGroup) { exitPhotoMode(); emoteSel.value = ""; currentEmote = ""; }
  if (!loaded.length) {
    statusEl.innerHTML = `<span class="err">no parts loaded (${failed} failed) — kept previous preview</span>`;
    return;
  }
  if (failed) statusEl.innerHTML = `<span class="err">${failed} part(s) failed to load — check console</span>`;
  else statusEl.innerHTML = "";
  charGroup.clear();
  charGroup.position.set(0, 0, 0);
  charGroup.scale.setScalar(1);
  for (const o of loaded) charGroup.add(o);
  applyBodyShapes();
  applyExpression();
  // normalize: measure and scale to ~1.8m at origin
  const bb = new THREE.Box3().setFromObject(charGroup);
  if (!bb.isEmpty()) {
    const size = bb.getSize(new THREE.Vector3());
    const s = 1.8 / Math.max(0.01, size.y);
    charGroup.scale.setScalar(s);
    const bb2 = new THREE.Box3().setFromObject(charGroup);
    charGroup.position.y -= bb2.min.y;
    charGroup.position.x -= (bb2.min.x + bb2.max.x) / 2;
    charGroup.position.z -= (bb2.min.z + bb2.max.z) / 2;
  }
}

// ---------- UI ----------
const uiGroups: { label: string; codes: string[]; sel: HTMLSelectElement }[] = [];
let activeGroup = 0;

function cycleActive(delta: number): void {
  const g = uiGroups[activeGroup];
  if (!g) return;
  const n = g.sel.options.length;
  let idx = g.sel.selectedIndex + delta;
  idx = ((idx % n) + n) % n;
  g.sel.selectedIndex = idx;
  g.sel.dispatchEvent(new Event("change"));
  updateHud();
}

function updateHud(): void {
  const g = uiGroups[activeGroup];
  const hud = document.getElementById("hud-label");
  if (hud && g) hud.textContent = `${g.label}: ${g.sel.options[g.sel.selectedIndex]?.text ?? "—"}`;
  document.querySelectorAll<HTMLButtonElement>("#hud-chips button").forEach((b, i) =>
    b.style.background = i === activeGroup ? "#1e4a6a" : "#16324c");
}

function buildHud(): void {
  const hud = document.createElement("div");
  hud.style.cssText =
    "position:absolute;left:0;right:0;bottom:0;padding:10px;display:flex;flex-direction:column;gap:8px;" +
    "background:linear-gradient(transparent, rgba(7,11,18,.92) 30%);align-items:center;z-index:5";
  hud.innerHTML =
    `<div id="hud-chips" style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;max-width:90%"></div>` +
    `<div style="display:flex;gap:14px;align-items:center">` +
    `<button id="hud-prev" style="font-size:22px;padding:8px 22px">◀</button>` +
    `<span id="hud-label" style="min-width:340px;text-align:center;color:#dfe8fa"></span>` +
    `<button id="hud-next" style="font-size:22px;padding:8px 22px">▶</button></div>`;
  view.appendChild(hud);
  const chips = hud.querySelector("#hud-chips")!;
  uiGroups.forEach((g, i) => {
    const b = document.createElement("button");
    b.textContent = g.label;
    b.style.cssText = "padding:5px 9px;font-size:11px";
    b.onclick = () => { activeGroup = i; updateHud(); };
    chips.appendChild(b);
  });
  (hud.querySelector("#hud-prev") as HTMLButtonElement).onclick = () => cycleActive(-1);
  (hud.querySelector("#hud-next") as HTMLButtonElement).onclick = () => cycleActive(1);
  addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") cycleActive(-1);
    if (e.key === "ArrowRight") cycleActive(1);
    if (e.key === "ArrowUp") { activeGroup = Math.max(0, activeGroup - 1); updateHud(); }
    if (e.key === "ArrowDown") { activeGroup = Math.min(uiGroups.length - 1, activeGroup + 1); updateHud(); }
  });
  updateHud();
}

function buildUI(): void {
  const slotsEl = document.getElementById("slots")!;
  slotsEl.innerHTML = "";
  uiGroups.length = 0;
  const allCodes = Object.keys(manifest.slots).sort();
  const grouped = new Set(GROUPS.flatMap(([, c]) => c).concat(FACE_BASE));
  const extraCodes = allCodes.filter((c) => !grouped.has(c));
  const groups: [string, string[]][] = [...GROUPS, ...extraCodes.map((c): [string, string[]] => [`Extra ${c}`, [c]])];

  for (const [label, codes] of groups) {
    const options = manifest.slots[codes[0]] ?? [];
    if (!options.length && label.startsWith("Extra")) continue;
    const h = document.createElement("h2");
    h.textContent = label;
    slotsEl.appendChild(h);
    const sel = document.createElement("select");
    sel.innerHTML =
      `<option value="">— none —</option>` +
      options.map((p, i) => `<option value="${i}">${p.pack} · ${p.id.replace(/^SK_/, "").replace(/_HU01$/, "")}</option>`).join("");
    // restore saved
    const savedRel = manifest.saved?.parts?.[codes[0]];
    if (savedRel) {
      const i = options.findIndex((p) => p.path === savedRel);
      if (i >= 0) sel.value = String(i);
    } else if (!(codes[0] in (manifest.saved?.parts ?? {})) && !label.startsWith("Extra") && label !== "Face hair (beard)") {
      // default = Modern Civilians 01 piece if present
      const i = options.findIndex((p) => p.id.startsWith("SK_MDRN_CIVL_01"));
      if (i >= 0) sel.value = String(i);
    }
    const apply = () => {
      const idx = sel.value === "" ? -1 : Number(sel.value);
      for (const code of codes) {
        const opts = manifest.slots[code] ?? [];
        if (idx < 0) selection.set(code, null);
        else {
          const chosen = options[idx];
          // match the counterpart slot from the same outfit set
          const match =
            code === codes[0]
              ? chosen
              : opts.find((p) => p.id.replace(/_\d{2}[A-Z]{4}_/, "_") === chosen.id.replace(/_\d{2}[A-Z]{4}_/, "_")) ?? null;
          selection.set(code, match);
        }
      }
      void rebuildPreview();
    };
    sel.onchange = apply;
    apply();
    slotsEl.appendChild(sel);
    uiGroups.push({ label, codes, sel });
  }
  buildHud();

  // texture pickers per Characters group
  const texEl = document.getElementById("textures")!;
  texEl.innerHTML = "";
  for (const [group, variants] of Object.entries(manifest.textures)) {
    if (variants.length < 2 && group !== "HumanSpecies") continue;
    const h = document.createElement("h2");
    h.textContent = group === "HumanSpecies" ? "Skin tone" : group;
    texEl.appendChild(h);
    const sel = document.createElement("select");
    sel.innerHTML = variants.map((v) => `<option value="${v.path}">${v.id}</option>`).join("");
    const saved = manifest.saved?.textures?.[group] ?? (group === "HumanSpecies" ? manifest.saved?.skin : null);
    if (saved) sel.value = saved;
    sel.onchange = () => {
      texSel.set(group === "HumanSpecies" ? "HumanSpecies" : group, sel.value);
      void rebuildPreview();
    };
    texSel.set(group, sel.value);
    texEl.appendChild(sel);
  }
}

const statusEl = document.getElementById("status")!;

// ---------- click-to-paint ----------
const ray = new THREE.Raycaster();
const colorInput = document.getElementById("paint-color") as HTMLInputElement;
const similarBox = document.getElementById("paint-similar") as HTMLInputElement;
let downAt: [number, number] | null = null;
renderer.domElement.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
renderer.domElement.addEventListener("pointerup", (e) => {
  const moved = downAt ? Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) : 99;
  downAt = null;
  if (moved < 5) pickColor(e); // a click, not an orbit drag
});

function pickColor(e: PointerEvent): void {
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(
    new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1),
    camera,
  );
  const hit = ray.intersectObject(charGroup, true).find((h) => (h.object as any).userData?.texRel && h.uv);
  if (!hit) return;
  const rel = (hit.object as any).userData.texRel as string;
  const c = canvasCache.get(rel);
  if (!c?.base) {
    statusEl.innerHTML = `<span class="err">paint needs same-origin textures — open the served /wardrobe page</span>`;
    return;
  }
  const px = Math.min(c.canvas.width - 1, Math.max(0, Math.floor(hit.uv!.x * c.canvas.width)));
  const py = Math.min(c.canvas.height - 1, Math.max(0, Math.floor((1 - hit.uv!.y) * c.canvas.height)));
  const d = c.ctx.getImageData(px, py, 1, 1).data;
  const from = rgb2hex([d[0], d[1], d[2]]);
  const edit: Edit = { from, to: from, similar: similarBox.checked ? 60 : 0 };
  (recolor[rel] ??= []).push(edit);
  // anchor the native picker popup at the click (clamped inside the window)
  colorInput.style.left = `${Math.min(e.clientX, innerWidth - 260)}px`;
  colorInput.style.top = `${Math.min(e.clientY, innerHeight - 340)}px`;
  colorInput.value = from;
  colorInput.oninput = () => {
    edit.to = colorInput.value;
    edit.similar = similarBox.checked ? 60 : 0;
    repaint(rel);
    renderEdits();
  };
  colorInput.click();
  renderEdits();
}

function renderEdits(): void {
  const el = document.getElementById("paint-edits")!;
  const rows: string[] = [];
  for (const [rel, edits] of Object.entries(recolor))
    edits.forEach((e, i) => {
      if (e.from === e.to) return;
      const label = rel.split("/").pop()!.replace(/^T_/, "").replace(/ColorMap\.png$/i, "");
      rows.push(
        `<div style="display:flex;gap:6px;align-items:center;margin:3px 0">` +
          `<span style="width:16px;height:16px;border-radius:3px;background:${e.from};border:1px solid #345"></span>→` +
          `<span style="width:16px;height:16px;border-radius:3px;background:${e.to};border:1px solid #345"></span>` +
          `<span class="note" style="flex:1;overflow:hidden;text-overflow:ellipsis">${label}</span>` +
          `<button data-rel="${rel}" data-i="${i}" style="padding:2px 8px;margin:0">✕</button></div>`,
      );
    });
  el.innerHTML = rows.join("") || `<div class="note">no repaints yet</div>`;
  el.querySelectorAll("button").forEach(
    (b) =>
      (b.onclick = () => {
        const rel = b.dataset.rel!;
        recolor[rel].splice(Number(b.dataset.i), 1);
        repaint(rel);
        renderEdits();
      }),
  );
}
document.getElementById("paint-reset")!.onclick = () => {
  for (const rel of Object.keys(recolor)) {
    delete recolor[rel];
    repaint(rel);
  }
  renderEdits();
};

/** Only meaningful edits (from ≠ to), for the save payload. */
function cleanRecolor(): Record<string, Edit[]> {
  const out: Record<string, Edit[]> = {};
  for (const [rel, edits] of Object.entries(recolor)) {
    const keep = edits.filter((e) => e.from !== e.to);
    if (keep.length) out[rel] = keep;
  }
  return out;
}

document.getElementById("save")!.onclick = async () => {
  const parts: Record<string, string | null> = {};
  for (const [slot, p] of selection) parts[slot] = p ? p.path : null;
  const textures: Record<string, string> = {};
  for (const [g, rel] of texSel) if (g !== "HumanSpecies") textures[g] = rel;
  const payload = { parts, textures, skin: texSel.get("HumanSpecies") ?? null, body: { ...body }, recolor: cleanRecolor() };
  statusEl.innerHTML = "saving…";
  const r = await fetch(`${httpBase}/wardrobe/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    statusEl.innerHTML = `<span class="err">${(await r.json()).err ?? "save failed"}</span>`;
    return;
  }
  statusEl.innerHTML = "applying (Blender is rebuilding the character, ~1 min)…";
  const poll = setInterval(async () => {
    const st = await (await fetch(`${httpBase}/wardrobe/status`)).json();
    if (!st.running) {
      clearInterval(poll);
      statusEl.innerHTML = st.ok
        ? `<span class="ok">✓ applied — refresh the stage to see the new Quant</span>`
        : `<span class="err">apply failed: ${st.note ?? "?"}</span>`;
    }
  }, 3000);
};
document.getElementById("reload")!.onclick = () => void rebuildPreview();

for (const key of ["heavy", "skinny", "buff", "feminine"] as const) {
  const el = document.getElementById(`b-${key}`) as HTMLInputElement;
  el.oninput = () => {
    body[key] = Number(el.value);
    applyBodyShapes();
  };
}

// ---------- pose & shoot UI ----------
const emoteSel = document.getElementById("pose-emote") as HTMLSelectElement;
const exprSel = document.getElementById("pose-expr") as HTMLSelectElement;
exprSel.innerHTML = Object.keys(EXPRESSIONS).map((e) => `<option>${e}</option>`).join("");
function fillEmoteOptions(): void {
  void loadClipLib().then((lib) => {
    emoteSel.innerHTML =
      `<option value="">— rest pose —</option>` +
      [...lib.keys()].sort().map((n) => `<option>${n}</option>`).join("");
  });
}
emoteSel.onchange = () => {
  currentEmote = emoteSel.value;
  poseFrozen = false;
  (document.getElementById("pose-freeze") as HTMLButtonElement).textContent = "⏸ freeze";
  if (currentEmote) void applyEmote();
  else exitPhotoMode();
};
exprSel.onchange = () => {
  currentExpr = exprSel.value;
  applyExpression();
};
document.getElementById("pose-freeze")!.onclick = (e) => {
  poseFrozen = !poseFrozen;
  (e.target as HTMLButtonElement).textContent = poseFrozen ? "▶ resume" : "⏸ freeze";
};
document.getElementById("pose-snap")!.onclick = () => snapshotPNG(false);
document.getElementById("pose-snap-t")!.onclick = () => snapshotPNG(true);

(async () => {
  statusEl.textContent = "loading manifest…";
  manifest = await (await fetch(`${httpBase}/wardrobe/manifest`)).json();
  statusEl.textContent = "";
  // restore saved body
  const sb = manifest.saved?.body;
  if (sb) for (const key of ["heavy", "skinny", "buff", "feminine"] as const) {
    body[key] = Number(sb[key] ?? 0);
    (document.getElementById(`b-${key}`) as HTMLInputElement).value = String(body[key]);
  }
  // restore saved repaints (textures re-apply them as they load)
  if (manifest.saved?.recolor) Object.assign(recolor, manifest.saved.recolor);
  buildUI();
  renderEdits();
  fillEmoteOptions();
})();
