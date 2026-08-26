import * as THREE from "three";
// avatar.js is the ported casino module (kept as JS for its seat-pose math).
// @ts-ignore - no types for the vendored module
import { Avatar } from "./avatar.js";
import { Net } from "./net.js";
import { buildStage } from "./stage/room.js";
import { Screens } from "./stage/screens.js";
import { Conveyor } from "./stage/conveyor.js";
import { Subtitles } from "./ui/subtitles.js";
import { Music } from "./ui/music.js";
import { mountDebug } from "./ui/debug.js";
import { Fx } from "./stage/fx.js";
import { StageRecorder } from "./media/recorder.js";
import { AgentTerminal } from "./ui/terminal.js";
import { mountPanels } from "./ui/panels.js";
import { mountCameraLook } from "./ui/cameraLook.js";
import type { Cue, ServerMsg, SnapshotMsg, TickMsg } from "./protocol.js";

const STAGE_W = 1920;
// browsers come in every size — scale the fixed 1920x1080 stage to FIT the
// window (up or down). OBS at exactly 1920x1080 gets scale 1, pixel-identical.
{
  const el = document.getElementById("stage")!;
  const fitStage = () => {
    const sc = Math.min(innerWidth / 1920, innerHeight / 1080);
    el.style.transform = `translate(-50%, -50%) scale(${sc})`;
  };
  addEventListener("resize", fitStage);
  fitStage();
}
const STAGE_H = 1080;
const SERVER_PORT = 8490; // dev: server; prod build is served same-origin
const wsUrl =
  location.port === "5199"
    ? `ws://127.0.0.1:${SERVER_PORT}/ws`
    : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
const httpBase = location.port === "5199" ? `http://127.0.0.1:${SERVER_PORT}` : "";

const stageEl = document.getElementById("stage")!;
const armEl = document.getElementById("arm")!;

// on-stage status line (top-right) so a black screen is never a mystery
const statusEl = document.createElement("div");
statusEl.style.cssText =
  "position:absolute;right:12px;top:12px;z-index:70;color:#8fb;background:rgba(6,10,18,.7);" +
  "font:12px 'Consolas',monospace;padding:5px 8px;border-radius:6px;max-width:520px;white-space:pre-wrap;";
stageEl.appendChild(statusEl);
// LIVE mode (GO LIVE armed): viewers get a clean broadcast — no debug panel,
// no status chatter. The producer can still get tools with ?producer=1.
const IS_PRODUCER = new URLSearchParams(location.search).has("producer");
let LIVE_MODE = false;
const setStatus = (s: string) => {
  if (LIVE_MODE && !IS_PRODUCER && !s.startsWith("STAGE ERROR")) return; // errors still surface
  statusEl.textContent = s;
};

// ---------- renderer ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(STAGE_W, STAGE_H, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
stageEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, STAGE_W / STAGE_H, 0.1, 100);

// camera presets → smooth lerp targets
const CAM = {
  wide: { pos: new THREE.Vector3(0, 4.2, 7.2), look: new THREE.Vector3(0, 1.2, -2) },
  terminal: { pos: new THREE.Vector3(2.6, 2.2, 1.8), look: new THREE.Vector3(1.0, 1.4, -3.2) },
  facecam: { pos: new THREE.Vector3(1.8, 1.9, 4.0), look: new THREE.Vector3(1.8, 1.5, 0) },
  vault: { pos: new THREE.Vector3(-2.4, 2.4, 2.2), look: new THREE.Vector3(-4.2, 1.4, -2.2) },
  film: { pos: new THREE.Vector3(4.0, 1.6, 1.6), look: new THREE.Vector3(5.6, 1.45, 0.2) },
  bigscreen: { pos: new THREE.Vector3(-3.4, 2.1, 1.6), look: new THREE.Vector3(-5.8, 1.7, -3.5) },
  // tiktok studio fallbacks — the glb TiktokCamera* nodes override these
  tiktok_front: { pos: new THREE.Vector3(6.5, 1.6, 5.2), look: new THREE.Vector3(6.5, 1.5, 3.0) },
  tiktok_left: { pos: new THREE.Vector3(5.2, 1.7, 4.6), look: new THREE.Vector3(6.5, 1.4, 3.0) },
  tiktok_right: { pos: new THREE.Vector3(7.8, 1.7, 4.6), look: new THREE.Vector3(6.5, 1.4, 3.0) },
  tiktok_face: { pos: new THREE.Vector3(6.5, 1.5, 4.0), look: new THREE.Vector3(6.5, 1.5, 3.0) },
  // podcast set — all three overridden by the glb cameras
  podcast_wide: { pos: new THREE.Vector3(-6.8, 2.0, 4.0), look: new THREE.Vector3(-6.8, 1.2, 1.0) },
  podcast_host: { pos: new THREE.Vector3(-5.2, 1.5, 2.4), look: new THREE.Vector3(-6.0, 1.25, 1.0) },
  podcast_guest: { pos: new THREE.Vector3(-8.4, 1.5, 2.4), look: new THREE.Vector3(-7.6, 1.25, 1.0) },
};
let camTarget = CAM.wide;
let camDolly = 0;
camera.position.copy(CAM.wide.pos);

const conveyor = new Conveyor(scene);
const subtitles = new Subtitles(stageEl);
// background bed. The mute button is hidden in OBS (?auto=1) so it can never
// appear on the broadcast — viewers on /live and the producer locally get it.
const music = new Music(stageEl, !new URLSearchParams(location.search).has("auto"));
const fx = new Fx(stageEl);
const recorder = new StageRecorder(renderer.domElement, subtitles.audioElement, httpBase, stageEl);
const terminal = new AgentTerminal(stageEl, httpBase);
fetch(httpBase + "/health")
  .then((r) => r.json())
  .then((h) => {
    LIVE_MODE = !!h.live;
    if (!LIVE_MODE || IS_PRODUCER) mountDebug(stageEl, httpBase);
    else statusEl.textContent = ""; // clear anything that raced in before the flag
  })
  .catch(() => mountDebug(stageEl, httpBase));
mountPanels(stageEl, httpBase, () => terminal.toggle());
const cameraLook = mountCameraLook(stageEl);

// ---------- stage (Unity room.glb if present, else greybox) ----------
let screens: Screens | undefined;
let avatar: any;
const finite3 = (a: [number, number, number]) => a.every((n) => Number.isFinite(n));

/** Frame the whole loaded room robustly, independent of the derived camera. */
function fitWideToScene(): void {
  const box = new THREE.Box3();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry) box.expandByObject(m);
  });
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.z, 4);
  CAM.wide.pos.set(c.x, Math.min(c.y + size.y * 0.7 + 1.5, 12), c.z + maxDim * 1.15);
  CAM.wide.look.set(c.x, c.y * 0.35 + 0.9, c.z);
}

let boardHandle: { set(lines: string[]): void } | null = null;

async function buildAll(): Promise<void> {
  setStatus("loading room…");
  const layout = await buildStage(scene);
  screens = new Screens(layout.screens);
  boardHandle = layout.board;
  if (lastBoard.length) boardHandle?.set(lastBoard);

  // conveyor: ride the room's real roller track, or the greybox slab
  if (layout.conveyorPath) {
    const st = layout.stations?.conveyor;
    conveyor.setPath(layout.conveyorPath.start, layout.conveyorPath.end, st ? [st.x, st.z] : undefined);
  } else {
    conveyor.useDefaultSlab();
  }

  // adopt room-derived camera framing, guarding against NaN/Inf
  let gotWide = false;
  if (layout.cameras) {
    for (const key of ["wide", "terminal", "facecam", "vault", "film", "bigscreen", "tiktok_front", "tiktok_left", "tiktok_right", "tiktok_face",
                       "podcast_wide", "podcast_host", "podcast_guest"] as const) {
      const v = layout.cameras[key];
      if (v && finite3(v.pos) && finite3(v.look)) {
        CAM[key].pos.set(v.pos[0], v.pos[1], v.pos[2]);
        CAM[key].look.set(v.look[0], v.look[1], v.look[2]);
        if (key === "wide") gotWide = true;
      }
    }
  }
  // scene-box fit is a FALLBACK only — it frames the walls and lands way too
  // far out; the derived wide is the intended show shot
  if (!gotWide) fitWideToScene();
  camTarget = CAM.wide;
  camera.position.copy(CAM.wide.pos);
  setStatus(
    `room:${layout.npc ? "glb" : "greybox"} model:${layout.npc?.model ?? "suit"} ` +
      `stations:${layout.stations ? Object.keys(layout.stations).length : 0} ` +
      `cams:${layout.cameras ? "derived" : "default"}\n(press d for debug panel)`,
  );
  setTimeout(() => setStatus(""), 8000);

  // THE FLIP: Sidekick-Quant by default (88 face shapes, real emotes).
  // ?model=classic uses the room's NPC marker; ?model=<name> forces any model.
  const wanted = new URLSearchParams(location.search).get("model");
  const model =
    wanted === "classic"
      ? layout.npc?.model || "SM_Chr_Suit_Male_01"
      : wanted || "SK_Quant";
  avatar = new Avatar({ model, tex: "01_A" });
  scene.add(avatar.group);
  avatar.ready.then(() => avatar.play("idle")).catch(() => {});

  // push the room's station coordinates to the server so the (server-driven)
  // avatar walks to the right places in YOUR room
  if (layout.stations || layout.npc) {
    fetch(httpBase + "/admin/layout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stations: layout.stations ?? {}, npc: layout.npc ?? null }),
    }).catch(() => {});
  }
}

// server-authoritative pose, smoothed on the client
const pose = { x: -0.6, y: 0, z: 1.2, heading: 0, targetX: -0.6, targetY: 0, targetZ: 1.2, targetHeading: 0, anim: "idle", seated: false };
let oneShotUntil = 0;

// ---------- GUEST BODY (podcast) ----------
let guest: any = null;
let guestOneShotUntil = 0;
const guestPose = { x: 0, y: 0, z: 0, heading: 0, targetX: 0, targetY: 0, targetZ: 0, targetHeading: 0, anim: "idle", seated: false };
async function spawnGuest(model: string): Promise<void> {
  if (guest) despawnGuest();
  const { Avatar } = (await import("./avatar.js" as any)) as any;
  guest = new Avatar({ model, tex: "01_A" });
  scene.add(guest.group);
  guest.group.position.set(guestPose.x, guestPose.y, guestPose.z);
  guest.ready.then(() => guest?.play("idle")).catch(() => {});
}
function despawnGuest(): void {
  if (!guest) return;
  try { scene.remove(guest.group); } catch {}
  guest = null;
}

// ---------- TIKTOK MODE ----------
// Burned-in subtitles (drawn INTO the WebGL canvas so recordings carry them),
// green-key facecam mode (room hidden, pure green ground), and shot movement.
let tiktokMode: "studio" | "facecam" | null = null;
let tiktokPace: "chill" | "hype" = "hype";
let tiktokAutocut = true;
let tiktokNextCutAt = 0;
let tiktokCam: "front" | "left" | "right" | "face" = "front";
let tiktokBgVideo: HTMLVideoElement | null = null;
let tiktokSetRestore: { obj: THREE.Object3D; was: boolean }[] = [];

/** Studio set dressing: "green" hides the HomeOffice, "homeoffice" shows it
 *  and hides the chroma-green shell. Restored when filming ends. */
function setTiktokSet(set: "green" | "homeoffice"): void {
  for (const h of tiktokSetRestore) h.obj.visible = h.was;
  tiktokSetRestore = [];
  const flip = (obj: THREE.Object3D, vis: boolean) => {
    tiktokSetRestore.push({ obj, was: obj.visible });
    obj.visible = vis;
  };
  scene.traverse((o) => {
    if (/^homeoffice$/i.test(o.name?.trim() ?? "")) flip(o, set === "homeoffice");
    const m = o as THREE.Mesh;
    if (m.isMesh && m.material && !Array.isArray(m.material) && (m.material as any).name === "ChromaGreen")
      flip(m, set === "green");
  });
}
let tiktokPrevBg: THREE.Texture | THREE.Color | null | undefined = undefined;
let tiktokHidden: { obj: THREE.Object3D; was: boolean }[] = [];
let tiktokPrevClear = new THREE.Color(0x000000);
let camCutAt = 0; // shot clock, resets on every camera cut
let camPresetName = "wide";
// per-shot move rolled on every tiktok cut — tiktok grammar is CONSTANT motion
let shotMove: { type: "pushin" | "pullout" | "zoomin" | "zoomout" | "truck"; dir: number; speed: number } | null = null;
let baseFov = 0;
function rollShotMove(): void {
  const types = ["pushin", "pushin", "zoomin", "pullout", "zoomout", "truck", "truck"] as const;
  shotMove = {
    type: types[Math.floor(Math.random() * types.length)],
    dir: Math.random() < 0.5 ? -1 : 1,
    speed: 0.7 + Math.random() * 0.9,
  };
}
let burnLine: { words: { word: string; atMs: number }[]; text: string; startedAt: number; durMs: number } | null = null;

const burnCanvas = document.createElement("canvas");
burnCanvas.width = 1024; burnCanvas.height = 320;
const burnCtx = burnCanvas.getContext("2d")!;
const burnTex = new THREE.CanvasTexture(burnCanvas);
const burnMat = new THREE.MeshBasicMaterial({ map: burnTex, transparent: true, depthTest: false, depthWrite: false });
// sized to survive a 9:16 CENTER CROP of the 16:9 canvas — tiktok edits crop vertical
const burnPlane = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 0.2), burnMat);
burnPlane.position.set(0, -0.5, -1.35); // lower-center of the 9:16 frame
burnPlane.renderOrder = 999;
burnPlane.visible = false;
camera.add(burnPlane);
scene.add(camera); // camera must live in the scene for its children to render

function drawBurnSubs(): void {
  if (!tiktokMode || !burnLine) { burnPlane.visible = false; return; }
  const t = performance.now() - burnLine.startedAt;
  if (t > burnLine.durMs + 600) { burnPlane.visible = false; burnLine = null; return; }
  const words = burnLine.words.length
    ? burnLine.words
    : burnLine.text.split(/\s+/).map((w, i, arr) => ({ word: w, atMs: (i * burnLine!.durMs) / arr.length }));
  // active word + a rolling window of ~5 words (tiktok caption style)
  let active = 0;
  for (let i = 0; i < words.length; i++) if (t >= words[i].atMs) active = i;
  const start = Math.max(0, Math.min(active - 1, words.length - 5));
  const win = words.slice(start, start + 5);
  const g = burnCtx;
  g.clearRect(0, 0, burnCanvas.width, burnCanvas.height);
  g.textAlign = "center"; g.textBaseline = "middle";
  g.font = "900 92px Arial, sans-serif";
  // measure and lay the window out on up to 2 lines
  const lines: { word: string; idx: number }[][] = [[]];
  let width = 0;
  win.forEach((w, i) => {
    const wpx = g.measureText(w.word.toUpperCase() + " ").width;
    if (width + wpx > 940 && lines[lines.length - 1].length) { lines.push([]); width = 0; }
    lines[lines.length - 1].push({ word: w.word, idx: start + i });
    width += wpx;
  });
  lines.slice(0, 2).forEach((ln, li) => {
    const y = 110 + li * 108;
    let x = burnCanvas.width / 2 - ln.reduce((acc, w) => acc + g.measureText(w.word.toUpperCase() + " ").width, 0) / 2;
    for (const w of ln) {
      const up = w.word.toUpperCase() + " ";
      const wpx = g.measureText(up).width;
      g.lineWidth = 16; g.strokeStyle = "#000";
      g.strokeText(up, x + wpx / 2, y);
      g.fillStyle = w.idx === active ? "#ffe600" : "#ffffff";
      g.fillText(up, x + wpx / 2, y);
      x += wpx;
    }
  });
  burnTex.needsUpdate = true;
  burnPlane.visible = true;
}

/** Hard cut to a tiktok camera: teleport + fresh shot-move. */
function tiktokSnap(cam: "front" | "left" | "right" | "face"): void {
  tiktokCam = cam;
  const preset = ("tiktok_" + cam) as keyof typeof CAM;
  camTarget = CAM[preset];
  camPresetName = "tiktok_" + cam;
  camCutAt = performance.now();
  if (baseFov === 0) baseFov = camera.fov;
  camera.position.set(camTarget.pos.x, camTarget.pos.y, camTarget.pos.z);
  camera.lookAt(camTarget.look);
  rollShotMove();
}

/** The cut rhythm: front is home (1-2.2s holds), sides are fast stabs
 *  (0.4-0.7s), always back to front. chill pace roughly doubles the holds. */
function tiktokRhythm(now: number): void {
  if (!tiktokMode || !tiktokAutocut) return;
  if (now < tiktokNextCutAt) return;
  const mul = tiktokPace === "chill" ? 2.1 : 1;
  if (tiktokCam !== "front") {
    tiktokSnap("front");
    tiktokNextCutAt = now + (1000 + Math.random() * 1200) * mul;
  } else if (Math.random() < 0.2) {
    // face punch-in: the dramatic beat — held a touch longer than side stabs
    tiktokSnap("face");
    tiktokNextCutAt = now + (700 + Math.random() * 500) * mul;
  } else if (Math.random() < 0.45) {
    tiktokSnap(Math.random() < 0.5 ? "left" : "right");
    tiktokNextCutAt = now + (400 + Math.random() * 300) * mul;
  } else {
    tiktokSnap("front"); // same cam, fresh move — still reads as a cut
    tiktokNextCutAt = now + (900 + Math.random() * 900) * mul;
  }
}

function setTiktokBg(url: string | undefined): void {
  // restore previous background first
  if (tiktokPrevBg !== undefined) {
    scene.background = tiktokPrevBg as any;
    tiktokPrevBg = undefined;
  }
  if (tiktokBgVideo) { tiktokBgVideo.pause(); tiktokBgVideo.src = ""; tiktokBgVideo = null; }
  if (!url) return;
  tiktokPrevBg = scene.background as any;
  if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) {
    const v = document.createElement("video");
    v.src = url; v.muted = true; v.loop = true; v.playsInline = true; v.crossOrigin = "anonymous";
    void v.play().catch(() => {});
    const tex = new THREE.VideoTexture(v);
    tex.colorSpace = THREE.SRGBColorSpace;
    scene.background = tex;
    tiktokBgVideo = v;
  } else {
    new THREE.TextureLoader().load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      if (tiktokMode) scene.background = tex;
    });
  }
}

function setStageAspect(vertical: boolean): void {
  // 9:16 drawing buffer while filming tiktoks — the recording IS the canvas.
  // CSS box stays 16:9 (the preview squishes; the file is correct).
  const w = vertical ? 1080 : 1920;
  const h = vertical ? 1920 : 1080;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// Each podcast camera sits ON a tripod, so it films its own leg — a big
// white streak across every shot. Hide whatever is basically inside the lens
// and restore it when the camera moves on.
let lensHidden: THREE.Object3D[] = [];
function hideLensBlockers(pos: THREE.Vector3): void {
  for (const o of lensHidden) o.visible = true;
  lensHidden = [];
  const p = new THREE.Vector3(pos.x, pos.y, pos.z);
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    if (!/tripod|camera_tripod/i.test(o.name ?? "") && !/tripod/i.test(o.parent?.name ?? "")) return;
    const c = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
    if (c.distanceTo(p) < 2.2) {
      m.visible = false;
      lensHidden.push(m);
    }
  });
}

function setTiktokMode(on: boolean, mode: "studio" | "facecam" = "studio"): void {
  setStageAspect(on);
  // restore anything a previous mode hid
  for (const h of tiktokHidden) h.obj.visible = h.was;
  tiktokHidden = [];
  if (tiktokMode === "facecam" || !on) renderer.setClearColor(tiktokPrevClear, 1);
  tiktokMode = on ? mode : null;
  if (!on) {
    burnPlane.visible = false; burnLine = null; setTiktokBg(undefined); tiktokNextCutAt = 0;
    for (const h of tiktokSetRestore) h.obj.visible = h.was;
    tiktokSetRestore = [];
    return;
  }
  tiktokNextCutAt = performance.now() + 800;
  tiktokCam = "front";
  if (mode === "facecam") {
    // hide EVERYTHING except the avatar and lights — pure green key backdrop
    renderer.getClearColor(tiktokPrevClear);
    renderer.setClearColor(0x00b140, 1); // chroma green
    scene.children.forEach((obj) => {
      if (obj === camera || obj === (avatar as any)?.group) return;
      if ((obj as any).isLight) return;
      let hasLight = false;
      obj.traverse((o) => { if ((o as any).isLight) hasLight = true; });
      if (hasLight) return; // keep light rigs so he stays lit
      tiktokHidden.push({ obj, was: obj.visible });
      obj.visible = false;
    });
  }
}

function applyTick(m: TickMsg): void {
  pose.targetX = m.x;
  pose.targetY = m.y ?? 0;
  pose.targetZ = m.z;
  pose.targetHeading = m.heading;
  pose.seated = m.seated;
  if (performance.now() > oneShotUntil) pose.anim = m.anim;
}

function applyCue(cue: Cue): void {
  switch (cue.t) {
    case "anim": {
      const who = cue.actor === "guest" ? guest : avatar;
      who?.play(cue.clip);
      const real = who?.clipDuration?.(cue.clip) ?? 0;
      const DUR: Record<string, number> = { dance: 8000, cheer: 3400, rage: 3000 };
      const until = performance.now() + (real || DUR[cue.clip] || 1400);
      if (cue.actor === "guest") guestOneShotUntil = until;
      else oneShotUntil = until;
      break;
    }
    case "guest":
      if (cue.on) void spawnGuest(cue.model || "SM_Chr_Suit_Male_01");
      else despawnGuest();
      break;
    case "guest_pose":
      guestPose.targetX = cue.x;
      guestPose.targetY = cue.y ?? 0;
      guestPose.targetZ = cue.z;
      guestPose.targetHeading = cue.heading;
      guestPose.anim = cue.anim;
      guestPose.seated = cue.seated;
      break;
    case "podcast_chat":
      screens?.drawPodcastChat?.(cue.title, cue.lines);
      break;
    case "speak":
      if (tiktokMode) burnLine = { words: cue.words ?? [], text: cue.subtitle, startedAt: performance.now(), durMs: cue.durMs };
      if (cue.actor === "guest") {
        guest?.lipsync?.(cue.durMs, cue.words, () => subtitles.speechClock());
        subtitles.speak({
          audioUrl: cue.audioUrl ? httpBase + cue.audioUrl : null,
          subtitle: cue.speaker ? `${cue.speaker}: ${cue.subtitle}` : cue.subtitle,
          durMs: cue.durMs,
          words: cue.words,
        });
        break;
      }
      subtitles.speak({
        audioUrl: cue.audioUrl ? httpBase + cue.audioUrl : null,
        subtitle: cue.subtitle,
        durMs: cue.durMs,
        words: cue.words,
      });
      avatar?.lipsync?.(cue.durMs, cue.words, () => subtitles.speechClock());
      break;
    case "screen_inspection":
      inspectionState = cue.reset ? { ...cue.patch } as any : { ...inspectionState, ...cue.patch };
      screens?.drawInspection(inspectionState);
      break;
    case "screen_treasury":
      screens?.drawTreasury(cue.state);
      break;
    case "screen_callouts":
      screens?.drawCallouts(cue.cards);
      break;
    case "actions":
      screens?.drawCallouts(undefined, cue.list);
      break;
    case "board":
      boardHandle?.set(cue.lines);
      break;
    case "takeover":
      screens?.setTakeover(cue.view);
      break;
    case "conveyor_add":
      conveyor.add(cue.item);
      break;
    case "conveyor_pick":
      conveyor.pick(cue.mint);
      break;
    case "camera": {
      const wasTiktok = camPresetName.startsWith("tiktok");
      camTarget = CAM[cue.preset];
      camPresetName = cue.preset;
      camCutAt = performance.now();
      if (cue.preset.startsWith("podcast")) {
        camera.position.set(camTarget.pos.x, camTarget.pos.y, camTarget.pos.z);
        camera.lookAt(camTarget.look);
        shotMove = null;
        hideLensBlockers(camTarget.pos);
      } else if (cue.preset.startsWith("tiktok")) {
        // tiktok cuts are CUTS — teleport, never a dolly glide between cams
        if (baseFov === 0) baseFov = camera.fov;
        camera.position.set(camTarget.pos.x, camTarget.pos.y, camTarget.pos.z);
        camera.lookAt(camTarget.look);
        rollShotMove();
      } else if (!cue.preset.startsWith("podcast") && lensHidden.length) {
        for (const o of lensHidden) o.visible = true;
        lensHidden = [];
      }
      if (wasTiktok && baseFov > 0 && !cue.preset.startsWith("tiktok")) {
        camera.fov = baseFov;
        camera.updateProjectionMatrix();
        shotMove = null;
      }
      cameraLook.setCam(cue.preset);
      break;
    }
    case "fx":
      if (cue.kind === "stamp_rekt") fx.stamp("REKT", "#ff4d6d");
      else if (cue.kind === "stamp_called") fx.stamp("CALLED", "#39ff88");
      else if (cue.kind === "confetti") fx.confetti();
      else if (cue.kind === "ding") fx.flash("#2affd4");
      else if (cue.kind === "buzzer") fx.flash("#ff4d6d");
      break;
    case "mood": {
      const FACE: Record<string, string> = { excited: "happy", disgusted: "angry", thinking: "thinking", neutral: "neutral" };
      (cue.actor === "guest" ? guest : avatar)?.setExpression?.(FACE[cue.mood] ?? "neutral");
    }
      // reserved for facial/emissive tint; no-op in greybox
      break;
    case "record":
      if (cue.on) recorder.start(cue.id);
      else recorder.stop();
      break;
    case "tiktok":
      tiktokPace = cue.pace ?? "hype";
      tiktokAutocut = cue.autocut !== false;
      setTiktokMode(cue.on, cue.mode ?? "studio");
      if (cue.on) {
        setTiktokBg(cue.bg);
        if ((cue.mode ?? "studio") === "studio") setTiktokSet(cue.set ?? "green");
      }
      break;
    case "selfie":
      void takeSelfie(cue);
      break;
    case "feed":
      terminal.push(cue.entry);
      break;
  }
}

/** Selfie flow: strike the pose + face, swing the camera to arm's length,
 *  snap the canvas, upload the PNG — the server can tweet it. */
async function takeSelfie(cue: { id: string; anim?: string; expr?: string }): Promise<void> {
  if (!avatar) return;
  avatar.play(cue.anim || "phone_selfie");
  avatar.setExpression?.(cue.expr || "happy");
  oneShotUntil = performance.now() + 4200;
  // arm's-length framing: in front of his facing, a touch high and to his right.
  // Use the TARGET heading/position, not the current one — he's usually still
  // mid-turn when the selfie fires, and by capture (1.7s later) he's settled on
  // the target. Using the live heading placed the camera at his side.
  const h = pose.targetHeading, cx = pose.targetX, cz = pose.targetZ;
  const fwd = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
  const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
  const p = new THREE.Vector3(cx, 0, cz).addScaledVector(fwd, 1.15).addScaledVector(right, 0.35);
  const prevCam = camTarget;
  camTarget = { pos: new THREE.Vector3(p.x, 1.85, p.z), look: new THREE.Vector3(cx, 1.5, cz) };
  await new Promise((r) => setTimeout(r, 1700)); // camera lerp + pose settle
  // sync capture: render then read the canvas IMMEDIATELY — the WebGL buffer
  // is cleared after compositing, so async toBlob reads back blank
  renderer.render(scene, camera);
  let blob: Blob | null = null;
  try {
    blob = await (await fetch(renderer.domElement.toDataURL("image/png"))).blob();
  } catch { /* capture failed — skip upload */ }
  if (blob) {
    try {
      await fetch(`${httpBase}/admin/selfie-upload?id=${encodeURIComponent(cue.id)}`, { method: "POST", body: blob });
    } catch { /* stage keeps running */ }
  }
  await new Promise((r) => setTimeout(r, 900)); // hold the pose a beat
  camTarget = prevCam;
  avatar.setExpression?.("neutral");
}

let inspectionState: any = { mint: null, name: "IDLE", symbol: "—", rows: [], score: null, tier: null };

let lastBoard: string[] = [];

function applySnapshot(m: SnapshotMsg): void {
  pose.x = pose.targetX = m.avatar.x;
  pose.z = pose.targetZ = m.avatar.z;
  pose.heading = pose.targetHeading = m.avatar.heading;
  pose.seated = m.avatar.seated;
  inspectionState = m.inspection;
  screens?.drawInspection(m.inspection);
  screens?.drawTreasury(m.treasury);
  screens?.drawCallouts(m.callouts, m.actions);
  lastBoard = m.board ?? [];
  boardHandle?.set(lastBoard);
  for (const item of m.conveyor) conveyor.add(item);
}

// ---------- net ----------
const net = new Net(wsUrl);
net.on("tick", (m: TickMsg) => applyTick(m));
net.on("cue", (m: { cue: Cue }) => applyCue(m.cue));
net.on("snapshot", (m: SnapshotMsg) => applySnapshot(m));

// ---------- render loop ----------
const clock = new THREE.Clock();
function frame(): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, clock.getDelta());
  if (!avatar) {
    renderer.render(scene, camera);
    return;
  }

  // smooth avatar toward server pose
  pose.x += (pose.targetX - pose.x) * Math.min(1, dt * 10);
  pose.z += (pose.targetZ - pose.z) * Math.min(1, dt * 10);
  let dh = pose.targetHeading - pose.heading;
  while (dh > Math.PI) dh -= Math.PI * 2;
  while (dh < -Math.PI) dh += Math.PI * 2;
  pose.heading += dh * Math.min(1, dt * 10);
  pose.y += ((pose.targetY ?? 0) - (pose.y ?? 0)) * Math.min(1, dt * 8);
  avatar.group.position.set(pose.x, pose.y ?? 0, pose.z);
  avatar.group.rotation.y = pose.heading;
  avatar.setSeated?.(pose.seated);
  if (performance.now() > oneShotUntil && !avatar.busy) avatar.play(pose.anim === "walk" ? "walk" : pose.seated ? "idle" : "idle");
  avatar.update(dt);

  if (guest) {
    guestPose.x += (guestPose.targetX - guestPose.x) * Math.min(1, dt * 10);
    guestPose.z += (guestPose.targetZ - guestPose.z) * Math.min(1, dt * 10);
    let gdh = guestPose.targetHeading - guestPose.heading;
    while (gdh > Math.PI) gdh -= Math.PI * 2;
    while (gdh < -Math.PI) gdh += Math.PI * 2;
    guestPose.heading += gdh * Math.min(1, dt * 10);
    guestPose.y += (guestPose.targetY - guestPose.y) * Math.min(1, dt * 8);
    guest.group.position.set(guestPose.x, guestPose.y, guestPose.z);
    guest.group.rotation.y = guestPose.heading;
    guest.setSeated?.(guestPose.seated);
    if (performance.now() > guestOneShotUntil && !guest.busy)
      guest.play(guestPose.anim === "walk" ? "walk" : "idle");
    guest.update(dt);
  }

  conveyor.update(dt);

  // camera dolly + lerp (guard against any NaN making the screen black)
  camDolly += dt;
  const safe =
    Number.isFinite(camTarget.pos.x) && Number.isFinite(camTarget.pos.y) && Number.isFinite(camTarget.pos.z)
      ? camTarget
      : CAM.wide;
  const sway = safe === CAM.wide ? Math.sin(camDolly * 0.3) * 0.4 : 0;
  let goal = new THREE.Vector3(safe.pos.x + sway, safe.pos.y, safe.pos.z);
  tiktokRhythm(performance.now());
  if (camPresetName.startsWith("tiktok") && shotMove) {
    // tiktok grammar: every shot MOVES — push, pull, zoom or truck, plus
    // handheld micro-shake. dead-static frames get scrolled past
    const tShot = (performance.now() - camCutAt) / 1000;
    const view = new THREE.Vector3().subVectors(safe.look, safe.pos).normalize();
    const side = new THREE.Vector3().crossVectors(view, new THREE.Vector3(0, 1, 0)).normalize();
    const paceMul = tiktokPace === "hype" ? 2.2 : 1;
    const amt = Math.min(0.6, tShot * 0.09 * shotMove.speed * paceMul);
    if (shotMove.type === "pushin") goal.addScaledVector(view, amt);
    else if (shotMove.type === "pullout") goal.addScaledVector(view, -amt * 0.7);
    else if (shotMove.type === "truck") goal.addScaledVector(side, Math.sin(tShot * 0.55) * 0.3 * shotMove.dir);
    if (shotMove.type === "zoomin" || shotMove.type === "zoomout") {
      const zMul = tiktokPace === "hype" ? 2.4 : 1;
      const fovGoal = shotMove.type === "zoomin"
        ? baseFov - Math.min(18, tShot * 3.4 * shotMove.speed * zMul)
        : baseFov + Math.min(11, tShot * 2.6 * shotMove.speed * zMul);
      camera.fov += (fovGoal - camera.fov) * Math.min(1, dt * 5);
      camera.updateProjectionMatrix();
    }
    // handheld: quick multi-frequency jitter, small but alive
    goal.x += (Math.sin(tShot * 1.7) * 0.028 + Math.sin(tShot * 4.3) * 0.012) * shotMove.speed;
    goal.y += (Math.sin(tShot * 2.1 + 1) * 0.02 + Math.sin(tShot * 5.1) * 0.009) * shotMove.speed;
  }
  if (camPresetName.startsWith("podcast")) {
    // podcast grammar: a SLOW push and a lazy drift — alive, never frantic
    const tShot = (performance.now() - camCutAt) / 1000;
    const view = new THREE.Vector3().subVectors(safe.look, safe.pos).normalize();
    goal.addScaledVector(view, Math.min(0.22, tShot * 0.012));
    goal.x += Math.sin(tShot * 0.22) * 0.035;
    goal.y += Math.sin(tShot * 0.17 + 1) * 0.02;
  }
  camera.position.lerp(goal, Math.min(1, dt * (camPresetName.startsWith("tiktok") ? 6 : 1.8)));
  camera.lookAt(safe.look);
  drawBurnSubs();

  renderer.render(scene, camera);
}

// ---------- arm audio (one click before going live) ----------
let stageStarted = false;
function startStage(): void {
  if (stageStarted) return;
  stageStarted = true;
  music.start(); // same gesture that unlocked audio starts the bed
  frame(); // start rendering IMMEDIATELY — never block on the room load
  net.connect();
  buildAll().catch((err) => {
    console.error("[stage] buildAll failed:", err);
    setStatus("STAGE ERROR: " + String(err?.message ?? err).slice(0, 300));
  });
}
armEl.addEventListener("click", () => {
  // a real click is a user gesture — it unlocks autoplay for the whole page
  new Audio().play().catch(() => {});
  armEl.style.display = "none";
  startStage();
});

// auto-arm: OBS browser sources allow autoplay-with-audio, so ?auto=1 goes
// straight in. A NORMAL browser tab BLOCKS autoplay — so we still render the
// visuals, but KEEP the ARM overlay up so one click can unlock the sound
// (instead of the old silent dead-end where the button was hidden with no audio).
if (new URLSearchParams(location.search).has("auto") || navigator.userActivation?.hasBeenActive) {
  const probe = new Audio();
  probe
    .play()
    .then(() => {
      armEl.style.display = "none"; // autoplay works (OBS) — hide overlay, go
      startStage();
    })
    .catch(() => {
      startStage(); // render visuals; leave the ARM overlay for a click to get sound
    });
}

// the landing page embeds this feed and arms it with ITS click (same-origin,
// so the parent's user activation covers our audio unlock)
addEventListener("message", (e) => {
  if (e.origin === location.origin && e.data === "riku-arm") armEl.dispatchEvent(new Event("click"));
});
