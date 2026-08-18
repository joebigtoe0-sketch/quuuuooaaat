import * as THREE from "three";
// avatar.js is the ported casino module (kept as JS for its seat-pose math).
// @ts-ignore - no types for the vendored module
import { Avatar } from "./avatar.js";
import { Net } from "./net.js";
import { buildStage } from "./stage/room.js";
import { Screens } from "./stage/screens.js";
import { Conveyor } from "./stage/conveyor.js";
import { Subtitles } from "./ui/subtitles.js";
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
    : `ws://${location.host}/ws`;
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
};
let camTarget = CAM.wide;
let camDolly = 0;
camera.position.copy(CAM.wide.pos);

const conveyor = new Conveyor(scene);
const subtitles = new Subtitles(stageEl);
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
    for (const key of ["wide", "terminal", "facecam", "vault", "film", "bigscreen"] as const) {
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
const pose = { x: -0.6, z: 1.2, heading: 0, targetX: -0.6, targetZ: 1.2, targetHeading: 0, anim: "idle", seated: false };
let oneShotUntil = 0;

function applyTick(m: TickMsg): void {
  pose.targetX = m.x;
  pose.targetZ = m.z;
  pose.targetHeading = m.heading;
  pose.seated = m.seated;
  if (performance.now() > oneShotUntil) pose.anim = m.anim;
}

function applyCue(cue: Cue): void {
  switch (cue.t) {
    case "anim": {
      avatar?.play(cue.clip);
      const real = avatar?.clipDuration?.(cue.clip) ?? 0;
      const DUR: Record<string, number> = { dance: 8000, cheer: 3400, rage: 3000 };
      oneShotUntil = performance.now() + (real || DUR[cue.clip] || 1400);
      break;
    }
    case "speak":
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
    case "camera":
      camTarget = CAM[cue.preset];
      cameraLook.setCam(cue.preset);
      break;
    case "fx":
      if (cue.kind === "stamp_rekt") fx.stamp("REKT", "#ff4d6d");
      else if (cue.kind === "stamp_called") fx.stamp("CALLED", "#39ff88");
      else if (cue.kind === "confetti") fx.confetti();
      else if (cue.kind === "ding") fx.flash("#2affd4");
      else if (cue.kind === "buzzer") fx.flash("#ff4d6d");
      break;
    case "mood": {
      const FACE: Record<string, string> = { excited: "happy", disgusted: "angry", thinking: "thinking", neutral: "neutral" };
      avatar?.setExpression?.(FACE[cue.mood] ?? "neutral");
    }
      // reserved for facial/emissive tint; no-op in greybox
      break;
    case "record":
      if (cue.on) recorder.start(cue.id);
      else recorder.stop();
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
  // arm's-length framing: in front of his facing, a touch high and to his right
  const fwd = new THREE.Vector3(Math.sin(pose.heading), 0, Math.cos(pose.heading));
  const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
  const p = new THREE.Vector3(pose.x, 0, pose.z).addScaledVector(fwd, 1.15).addScaledVector(right, 0.35);
  const prevCam = camTarget;
  camTarget = { pos: new THREE.Vector3(p.x, 1.85, p.z), look: new THREE.Vector3(pose.x, 1.5, pose.z) };
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
  avatar.group.position.set(pose.x, 0, pose.z);
  avatar.group.rotation.y = pose.heading;
  avatar.setSeated?.(pose.seated);
  if (performance.now() > oneShotUntil && !avatar.busy) avatar.play(pose.anim === "walk" ? "walk" : pose.seated ? "idle" : "idle");
  avatar.update(dt);

  conveyor.update(dt);

  // camera dolly + lerp (guard against any NaN making the screen black)
  camDolly += dt;
  const safe =
    Number.isFinite(camTarget.pos.x) && Number.isFinite(camTarget.pos.y) && Number.isFinite(camTarget.pos.z)
      ? camTarget
      : CAM.wide;
  const sway = safe === CAM.wide ? Math.sin(camDolly * 0.3) * 0.4 : 0;
  camera.position.lerp(
    new THREE.Vector3(safe.pos.x + sway, safe.pos.y, safe.pos.z),
    Math.min(1, dt * 1.8),
  );
  camera.lookAt(safe.look);

  renderer.render(scene, camera);
}

// ---------- arm audio (one click before going live) ----------
armEl.addEventListener("click", () => {
  // unlock autoplay
  const a = new Audio();
  a.play().catch(() => {});
  armEl.style.display = "none";
  frame(); // start rendering IMMEDIATELY — never block on the room load
  net.connect();
  buildAll().catch((err) => {
    console.error("[stage] buildAll failed:", err);
    setStatus("STAGE ERROR: " + String(err?.message ?? err).slice(0, 300));
  });
});

// auto-arm: ?auto=1 (OBS browser sources allow autoplay-with-audio, and a
// permanently-open armed page is what makes FILM CLIPS possible) — or any
// prior user activation on normal browsers
if (new URLSearchParams(location.search).has("auto") || navigator.userActivation?.hasBeenActive) {
  armEl.dispatchEvent(new Event("click"));
}

// the landing page embeds this feed and arms it with ITS click (same-origin,
// so the parent's user activation covers our audio unlock)
addEventListener("message", (e) => {
  if (e.origin === location.origin && e.data === "riku-arm") armEl.dispatchEvent(new Event("click"));
});
