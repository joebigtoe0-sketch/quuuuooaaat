// Synty character avatars: skinned GLB bodies + shared animation clips +
// head attachments + swappable outfit textures. Used for remote players,
// the character creator preview, and dealers.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Models players can pick in the creator. NPC-only models (dealers) are
// valid for Avatar but not offered in the creator.
export const NPC_MODELS = ['SM_Chr_Dealer_Female_01', 'SM_Chr_Dealer_Male_01'];
export const CITY_MODELS = [
  'Character_Biker', 'Character_FastFoodGuy', 'Character_FireFighter',
  'Character_GamerGirl', 'Character_Gangster', 'Character_Grandma',
  'Character_Grandpa', 'Character_HipsterGirl', 'Character_HipsterGuy',
  'Character_Hobo', 'Character_Hotdog', 'Character_Jock',
  'Character_Paramedic', 'Character_PunkGirl', 'Character_PunkGuy',
  'Character_Roadworker', 'Character_ShopKeeper', 'Character_SummerGirl',
  'Character_Tourist',
];
export const CHAR_MODELS = [
  'SM_Chr_Player_Male_01', 'SM_Chr_Player_Female_01', 'SM_Chr_Suit_Male_01',
  'SM_Chr_Dress_Female_01', 'SM_Chr_Boss_Male_01', 'SM_Chr_Bride_01',
  'SM_Chr_DragQueen_01', 'SM_Chr_Performer_Male_01', 'SM_Chr_Showgirl_01',
  'SM_Chr_Old_Male_01', 'SM_Chr_Old_Female_01', 'SM_Chr_Staff_Male_01',
  'SM_Chr_Staff_Female_01', 'SM_Chr_Security_Guard_Male_01', 'SM_Chr_Security_Guard_Female_01',
  ...CITY_MODELS,
];
// Texture atlas family per model (variant naming is shared: 01_A .. 04_C).
export function texPrefix(model) {
  return model.startsWith('Character_') ? 'PolygonCityCharacters' : 'PolygonCasino';
}
export const OUTFIT_TEXTURES = [
  '01_A', '01_B', '01_C', '02_A', '02_B', '02_C',
  '03_A', '03_B', '03_C', '04_A', '04_B', '04_C',
];
export const HAIR_OPTIONS = ['none',
  ...Array.from({ length: 13 }, (_, i) => `SM_Chr_Attach_Hair_${String(i + 1).padStart(2, '0')}`)];
export const GLASSES_OPTIONS = ['none',
  ...Array.from({ length: 9 }, (_, i) => `SM_Chr_Attach_Glasses_${String(i + 1).padStart(2, '0')}`)];

const loader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();
const UP = new THREE.Vector3(0, 1, 0);

// Bump when chars/*.glb are re-exported: GLBs otherwise linger in the
// browser's heuristic cache even across hard refreshes.
const ASSET_V = '?v=14';

const cache = {
  buffers: new Map(),  // name -> Promise<ArrayBuffer> (raw GLB bytes)
  textures: new Map(), // variant -> THREE.Texture
  clips: null,         // Promise<Map<name, AnimationClip>>
  attach: null,        // Promise<Map<name, Mesh>>
};

function loadGltf(url) {
  return new Promise((res, rej) => loader.load(url, res, undefined, rej));
}

// The anim files carry only curated clips, so every clip in them is playable.
// These keep LOOPING; everything else is a one-shot that falls back to idle.
const LOOP_ANIMS = new Set(['idle', 'idle_f', 'idle2', 'walk', 'run', 'fall',
  'crouch_idle', 'crouch_walk', 'arms_folded', 'hands_on_hips', 'thoughtful',
  'drunk_sway', 'lean_back', 'pray', 'phone_scroll', 'phone_type', 'phone_selfie']);
const isOneShot = (n) => !!n && !LOOP_ANIMS.has(n);
// idle-variance menu: small human fidgets he does on his own while standing
const FIDGETS = ['foot_tap', 'kick_ground', 'slump', 'swing_arms', 'check_watch',
  'head_nod', 'inspect_hands', 'stretch_arms', 'stretch_shoulders', 'yawn',
  'weight_shift', 'chin_scratch', 'look_left', 'look_right', 'pick_nose'];
// stances: alternate standing loops he can settle into for a while before
// returning to plain idle (base-idle variety, robot doesn't just T-stand)
const IDLE_STANCES = ['idle2', 'arms_folded', 'hands_on_hips', 'lean_back', 'thoughtful'];
// dance/cheer/rage fall back to PROCEDURAL poses only when the model's clip
// library lacks the real one (classic rig).
const CLIP_ALIAS = {};
const PROC_ANIMS = { dance: 8.0, cheer: 3.4, rage: 3.0 }; // seconds

export function loadClips(file = '/chars/anims.glb') {
  if (!cache.clips) cache.clips = new Map();
  if (!cache.clips.has(file)) {
    cache.clips.set(file, loadGltf(file + ASSET_V).then((g) => {
      const map = new Map();
      for (const clip of g.animations) {
        const name = clip.name.replace(/\.\d+$/, '');
        map.set(name, clip);
      }
      return map;
    }));
  }
  return cache.clips.get(file);
}

function loadAttachLib() {
  if (!cache.attach) {
    cache.attach = loadGltf('/chars/attach.glb' + ASSET_V).then((g) => {
      // Bake each attachment's full transform into its geometry so it lives
      // in character model space (meters, positioned at the head).
      g.scene.updateMatrixWorld(true);
      const map = new Map();
      g.scene.traverse((o) => {
        if (!o.isMesh) return;
        const geo = o.geometry.clone();
        geo.applyMatrix4(o.matrixWorld);
        map.set(o.name.replace(/\.\d+$/, ''), geo);
      });
      return map;
    });
  }
  return cache.attach;
}

// Each Avatar parses its OWN scene from cached bytes. SkeletonUtils.clone
// mis-rebinds this rig (duplicate ".001" bone names), leaving meshes bound to
// the original, never-animated skeleton â€” so we don't share parsed scenes.
function loadModel(name) {
  if (!cache.buffers.has(name)) {
    cache.buffers.set(name, fetch(`/chars/${name}.glb` + ASSET_V).then((r) => {
      if (!r.ok) throw new Error(`${name}.glb ${r.status}`);
      return r.arrayBuffer();
    }));
  }
  return cache.buffers.get(name).then((buf) =>
    new Promise((res, rej) => loader.parse(buf, '', res, rej)));
}

export function outfitTexture(variant, prefix = 'PolygonCasino') {
  const key = prefix + '_' + variant;
  if (!cache.textures.has(key)) {
    const tex = texLoader.load(`/chars/tex/${key}.png` + ASSET_V);
    tex.flipY = false; // glTF UV convention
    tex.colorSpace = THREE.SRGBColorSpace;
    cache.textures.set(key, tex);
  }
  return cache.textures.get(key);
}

export class Avatar {
  // appearance: { model, tex, hair, glasses }
  constructor(appearance = {}) {
    this.group = new THREE.Group();
    this.mixer = null;
    this.actions = new Map();
    this.current = null;
    this.ready = this.build(appearance);
  }

  async build(app) {
    const isSidekick = String(app.model || '').startsWith('SK_');
    this.isSidekick = isSidekick;
    const model = (isSidekick || CHAR_MODELS.includes(app.model) || NPC_MODELS.includes(app.model))
      ? app.model : CHAR_MODELS[0];
    const tex = OUTFIT_TEXTURES.includes(app.tex) ? app.tex : '01_A';
    this.texPrefix = texPrefix(isSidekick ? CHAR_MODELS[0] : model);
    const clipsFile = isSidekick ? '/chars/anims_sk.glb' : '/chars/anims.glb';
    const [gltf, clips, attachLib] = await Promise.all([
      loadModel(model), loadClips(clipsFile), loadAttachLib()]);

    const root = gltf.scene; // freshly parsed, exclusively ours
    const material = new THREE.MeshStandardMaterial({
      map: outfitTexture(tex, this.texPrefix), roughness: 0.85, metalness: 0,
    });
    root.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) {
        // sidekick GLBs carry their OWN baked materials/textures — keep them;
        // the classic atlas material is only for the classic characters
        if (!isSidekick) o.material = material;
        o.frustumCulled = false;
      }
    });

    // Normalize to ~1.75 m tall, feet at y=0. Union the bind-pose bounds of
    // EVERY skinned mesh — sidekick characters are 24 separate parts, so a
    // single mesh (e.g. the head) gives a wrong height and floor level.
    let smesh = null;
    const bb = new THREE.Box3();
    root.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      if (!smesh) smesh = o;
      // hair sits ON TOP of the head — counting it makes the BODY shorter
      if (/hair/i.test(o.name)) return;
      o.geometry.computeBoundingBox();
      bb.union(o.geometry.boundingBox);
    });
    let s = 1, minY = 0;
    if (smesh && !bb.isEmpty()) {
      // normalize BODY height (classic Boss presence ≈ 1.9 with headroom)
      s = (isSidekick ? 1.9 : 1.75) / Math.max(0.01, bb.max.y - bb.min.y);
      minY = bb.min.y;
    }
    root.scale.setScalar(s);
    root.position.y = -minY * s;
    this.group.add(root);
    this.root = root;
    this.material = material;

    // Animation mixer on the armature root.
    this.mixer = new THREE.AnimationMixer(root);
    for (const [name, clip] of clips) {
      this.actions.set(name, this.mixer.clipAction(clip));
    }
    // One-shot clips (jump/land/wave) fall back to the idle loop when done.
    this.mixer.addEventListener('finished', () => {
      this.current = null;
      this.play(this.idleName || 'idle');
    });

    // Head attachments. Their geometry lives in the same model space as the
    // body's skinned geometry, which renders through smesh.matrixWorld in
    // bind pose â€” so head-local = head.matrixWorldâ»Â¹ Ã— smesh.matrixWorld.
    let head = null;
    root.traverse((o) => { if (!head && o.isBone && (o.name === 'Head' || o.name === 'head')) head = o; });
    this.head = head;
    if (head && smesh) {
      // Attachment FBXs are authored with their pivot at the head joint
      // (Synty convention: parent them to the Head bone directly). Mount =
      // translate the attachment origin onto the head joint in group space
      // (normalized meters), then map group space into head-bone space —
      // unit-independent, so cm-scale rigs (bone world scale 0.01) work too.
      this.group.updateMatrixWorld(true);
      const headPos = head.getWorldPosition(new THREE.Vector3());
      this.group.worldToLocal(headPos);
      const toHeadLocal = new THREE.Matrix4()
        .copy(head.matrixWorld).invert()
        .multiply(this.group.matrixWorld)
        .multiply(new THREE.Matrix4().makeTranslation(headPos.x, headPos.y, headPos.z));
      // hair/glasses come from the creator; app.attach carries any extra
      // attachment names (moustache, hat, ...) e.g. from scene-placed NPCs.
      for (let id of [app.hair, app.glasses, ...(app.attach || [])]) {
        if (!id || id === 'none') continue;
        if (!attachLib.has(id)) {
          id = id.replace(/_\d+$/, ''); // glTF duplicate-name suffix
          if (!attachLib.has(id)) continue;
        }
        const mesh = new THREE.Mesh(attachLib.get(id), material);
        mesh.applyMatrix4(toHeadLocal);
        head.add(mesh);
      }
      this._attachMount = { lib: attachLib, toHeadLocal: toHeadLocal.clone() };
    }

    if (window.__avatarDebug) {
      const boneNames = [];
      root.traverse((o) => { if (o.isBone) boneNames.push(o.name); });
      console.log('[avatar]', model, 'clips:', [...clips.keys()].join(','),
        'head:', !!head, 'smesh:', !!smesh, 'bones:', boneNames.slice(0, 6).join(','),
        'track0:', clips.get('idle')?.tracks?.[0]?.name);
    }
    this.play(app.anim || 'idle', 0);
    return this;
  }

  setOutfit(tex) {
    if (this.material) this.material.map = outfitTexture(tex, this.texPrefix);
  }

  // A one-shot (sip, wave, ...) is playing: looped movement states should wait.
  get busy() {
    return this.current !== null && isOneShot(this.current);
  }

  // Seated pose: there is no sit clip in the packs, so after every mixer tick
  // we pose the legs on top of the idle loop. Corrections are computed in
  // WORLD space from the bones' actual child-direction vectors (bone-local
  // axes on this rig are unreliable), then mapped into each bone's parent.
  static SEAT = { seatH: 0.52, thighUp: 0.12, shinFwd: 0.12 };

  setSeated(on) {
    this.seated = !!on;
  }

  // Rotate `bone` by the world-space quaternion R.
  _worldRotate(bone, R) {
    const pq = bone.parent.getWorldQuaternion(this._tmpQ2);
    const local = this._tmpQ3.copy(pq).invert().multiply(R).multiply(pq);
    bone.quaternion.premultiply(local);
  }

  applySeatPose() {
    if (!this._seatBones) {
      const find = (n) => {
        let b = null;
        this.root.traverse((o) => { if (!b && o.isBone && o.name === n) b = o; });
        return b;
      };
      const chain = (n) => {
        const bone = find(n);
        const child = bone && bone.children.find((c) => c.isBone);
        return bone && child ? { bone, child } : null;
      };
      this._seatBones = {
        hips: find('Hips') || find('pelvis'),
        thighs: [chain('UpperLeg_L') || chain('thigh_l'), chain('UpperLeg_R') || chain('thigh_r')].filter(Boolean),
        shins: [chain('LowerLeg_L') || chain('calf_l'), chain('LowerLeg_R') || chain('calf_r')].filter(Boolean),
      };
      this._tmpQ = new THREE.Quaternion();
      this._tmpQ2 = new THREE.Quaternion();
      this._tmpQ3 = new THREE.Quaternion();
      this._tmpV = new THREE.Vector3();
      this._tmpV2 = new THREE.Vector3();
    }
    const S = Avatar.SEAT;
    const B = this._seatBones;
    if (!B.hips) return;
    this.group.updateMatrixWorld(true);

    // Drop the hips to seat height above the group origin (the floor).
    const groupY = this.group.getWorldPosition(this._tmpV).y;
    const hw = B.hips.getWorldPosition(this._tmpV2);
    hw.y = groupY + S.seatH;
    B.hips.position.copy(B.hips.parent.worldToLocal(hw));
    this.group.updateMatrixWorld(true);

    // Character forward in world (models face +Z in group space).
    const fwd = this._tmpV.set(0, 0, 1)
      .applyQuaternion(this.group.getWorldQuaternion(this._tmpQ)).setY(0).normalize();

    for (const { bone, child } of B.thighs) {
      const d = child.getWorldPosition(new THREE.Vector3())
        .sub(bone.getWorldPosition(new THREE.Vector3())).normalize();
      const target = fwd.clone().setY(S.thighUp).normalize();
      this._worldRotate(bone, this._tmpQ.setFromUnitVectors(d, target));
      bone.updateWorldMatrix(false, true);
    }
    for (const { bone, child } of B.shins) {
      const d = child.getWorldPosition(new THREE.Vector3())
        .sub(bone.getWorldPosition(new THREE.Vector3())).normalize();
      const target = fwd.clone().multiplyScalar(S.shinFwd).setY(-1).normalize();
      this._worldRotate(bone, this._tmpQ.setFromUnitVectors(d, target));
      bone.updateWorldMatrix(false, true);
    }

    // Seated look-around: the body stays planted, the head tracks the view.
    if (this.headTurn && this.head) {
      this._worldRotate(this.head,
        this._tmpQ.setFromAxisAngle(UP, THREE.MathUtils.clamp(this.headTurn, -1.2, 1.2)));
    }
  }

  play(name, fade = 0.22) {
    if (!this.mixer || this.current === name) return;
    const needsProc = PROC_ANIMS[name] && !this.actions.has(name);
    if (needsProc) this._proc = { name, t: 0, dur: PROC_ANIMS[name] };
    else if (this._proc) this._proc = null;
    const next = this.actions.get(CLIP_ALIAS[name] || name) || this.actions.get('idle');
    if (needsProc && !this.actions.has(name)) { /* rides idle */ }
    if (!next) return;
    const prev = this.current ? this.actions.get(CLIP_ALIAS[this.current] || this.current) : null;
    // Hard-stop everything except the two actions involved in this fade â€”
    // rapid state flips otherwise accumulate half-weighted zombie actions.
    for (const action of this.actions.values())
      if (action !== next && action !== prev) action.stop();
    next.reset();
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    // procedural moves loop idle underneath for their whole session
    next.setLoop(isOneShot(name) && !needsProc ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = true;
    next.play();
    if (prev && prev !== next) next.crossFadeFrom(prev, fade, false);
    this.current = name;
  }

  /** Real duration of a clip in ms (0 when unknown). */
  clipDuration(name) {
    if (PROC_ANIMS[name] && !this.actions.has(name)) return PROC_ANIMS[name] * 1000;
    const a = this.actions.get(CLIP_ALIAS[name] || name);
    return a ? a.getClip().duration * 1000 : 0;
  }

  // ------------- face: blendshape expressions + lipsync -------------

  _collectMorphs() {
    if (this._morphs && this._morphs.size) return this._morphs;
    if (!this.root) return new Map(); // model still loading — retry next frame
    this._morphs = new Map(); // shape name -> [{mesh, idx}]
    this.root?.traverse((o) => {
      if (!o.morphTargetDictionary || !o.morphTargetInfluences) return;
      for (const [nm, idx] of Object.entries(o.morphTargetDictionary)) {
        if (!this._morphs.has(nm)) this._morphs.set(nm, []);
        this._morphs.get(nm).push({ mesh: o, idx });
      }
    });
    this._morphState = new Map();
    return this._morphs;
  }

  _setMorph(name, v) {
    const list = this._morphs?.get(name);
    if (list) for (const { mesh, idx } of list) mesh.morphTargetInfluences[idx] = v;
  }

  static EXPRESSIONS = {
    neutral: {},
    happy: { mouthSmileLeft: 0.75, mouthSmileRight: 0.75, browInnerUpLeft: 0.25, browInnerUpRight: 0.25, cheekSquintLeft: 0.3, cheekSquintRight: 0.3 },
    sad: { mouthFrownLeft: 0.65, mouthFrownRight: 0.65, browInnerUpLeft: 0.6, browInnerUpRight: 0.6 },
    angry: { browFrownLeft: 0.9, browFrownRight: 0.9, cheekSquintLeft: 0.45, cheekSquintRight: 0.45, mouthPressLeft: 0.5, mouthPressRight: 0.5 },
    smug: { mouthSmileLeft: 0.75, mouthDimpleLeft: 0.5, browOuterUpLeft: 0.45, cheekSquintRight: 0.25 },
    shock: { jawOpen: 0.45, browInnerUpLeft: 0.85, browInnerUpRight: 0.85, browOuterUpLeft: 0.6, browOuterUpRight: 0.6 },
    thinking: { browInnerDownLeft: 0.35, browInnerDownRight: 0.35, mouthPressLeft: 0.35, eyeSquintLeft: 0.2 },
  };

  setExpression(name) {
    this._expr = Avatar.EXPRESSIONS[name] || {};
  }

  /** Mouth movement synced to TTS word timings while a line plays.
   *  `clock` (optional) returns {ms, scale} from the ACTUAL audio position —
   *  this is what keeps the jaw locked to the voice, not the wall clock. */
  lipsync(durMs, words, clock) {
    this._talk = { t0: performance.now(), durMs, words: words || [], clock };
  }

  _updateFace(dt) {
    if (!this._collectMorphs().size) return;
    if (!this._morphState) this._morphState = new Map();
    const targets = Object.assign({}, this._expr || {});
    const talk = this._talk;
    if (talk) {
      let el = performance.now() - talk.t0;
      let scale = 1;
      if (talk.clock) {
        const c = talk.clock();
        if (c && Number.isFinite(c.ms)) { el = c.ms; scale = c.scale || 1; }
      }
      const wallEl = performance.now() - talk.t0;
      if (wallEl > talk.durMs * Math.max(scale, 1) + 400) this._talk = null;
      else {
        // inside a word window? open the jaw with a per-word pulse
        let inWord = talk.words.length === 0; // no timings -> talk the whole time
        for (const w of talk.words) {
          const at = w.atMs * scale;
          if (el >= at && el <= at + Math.max(180, (w.word?.length ?? 3) * 55) * scale) { inWord = true; break; }
        }
        const pulse = inWord ? 0.12 + 0.3 * Math.abs(Math.sin(el * 0.022)) : 0;
        targets.jawOpen = Math.max(targets.jawOpen || 0, pulse);
        targets.mouthShrugUpper = Math.max(targets.mouthShrugUpper || 0, pulse * 0.3);
      }
    }
    // lerp every touched shape toward its target (untouched decay to 0)
    const seen = new Set([...(this._morphState?.keys() || []), ...Object.keys(targets)]);
    for (const nm of seen) {
      const cur = this._morphState.get(nm) || 0;
      const tgt = targets[nm] || 0;
      const nv = cur + (tgt - cur) * Math.min(1, dt * 9);
      this._morphState.set(nm, nv);
      this._setMorph(nm, nv);
      if (Math.abs(nv) < 0.004 && tgt === 0) this._morphState.delete(nm);
    }
  }

  update(dt) {
    if (this.mixer) this.mixer.update(dt);
    if (this.seated && this.root) this.applySeatPose();
    this._updateFidget();
    this._updateProc(dt);
    this._updateFace(dt);
  }

  /** Idle variance: standing around plain-idle, every ~10–30s he either does a
   *  quick fidget (stretch, yawn, check watch…) or settles into a different
   *  stance loop (arms folded, hands on hips…) for a while, then back to idle. */
  _updateFidget() {
    const now = performance.now();
    // a held stance runs its course, then he returns to plain idle
    if (this._stanceUntil) {
      if (IDLE_STANCES.includes(this.current)) {
        if (now >= this._stanceUntil) { this._stanceUntil = 0; this.play('idle'); }
        return;
      }
      this._stanceUntil = 0; // something else took over mid-stance
    }
    const idling = (this.current === 'idle' || this.current === 'idle2') &&
      !this.seated && !this._proc;
    if (!idling) { this._fidgetAt = 0; return; }
    if (!this._fidgetAt) { this._fidgetAt = now + 9000 + Math.random() * 16000; return; }
    if (now < this._fidgetAt) return;
    this._fidgetAt = 0;
    if (Math.random() < 0.35) {
      const stances = IDLE_STANCES.filter((n) => this.actions.has(n) && n !== this.current);
      if (stances.length) {
        this._stanceUntil = now + 8000 + Math.random() * 12000;
        this.play(stances[(Math.random() * stances.length) | 0]);
        return;
      }
    }
    const menu = FIDGETS.filter((n) => this.actions.has(n));
    if (menu.length) this.play(menu[(Math.random() * menu.length) | 0]);
  }

  // ------------- procedural moves: dance / cheer / rage -------------
  // Built with the same world-space bone technique as the seat pose, so they
  // work on the Synty rig without any retargeted animation data.

  _armBones() {
    if (this._arms !== undefined) return this._arms;
    if (!this._tmpQ) {
      this._tmpQ = new THREE.Quaternion();
      this._tmpQ2 = new THREE.Quaternion();
      this._tmpQ3 = new THREE.Quaternion();
    }
    const find = (re) => {
      let hit = null;
      this.root?.traverse((o) => {
        if (!hit && o.isBone && re.test(o.name)) hit = o;
      });
      return hit;
    };
    const mk = (side) => {
      const sh = find(new RegExp(`^(shoulder|upperarm)[._-]?${side}$`, 'i'));
      const el = find(new RegExp(`^(elbow|lowerarm|forearm)[._-]?${side}$`, 'i'));
      const ha = find(new RegExp(`^hand[._-]?${side}$`, 'i'));
      return sh && el && ha ? { sh, el, ha } : null;
    };
    this._arms = { L: mk('l'), R: mk('r') };
    if (this._rootBaseY === undefined && this.root) this._rootBaseY = this.root.position.y;
    return this._arms;
  }

  _aimArm(arm, upperDir, foreDir) {
    // rotate upper arm so shoulder→elbow matches upperDir, then the forearm
    const d1 = arm.el.getWorldPosition(new THREE.Vector3())
      .sub(arm.sh.getWorldPosition(new THREE.Vector3())).normalize();
    this._worldRotate(arm.sh, this._tmpQ.setFromUnitVectors(d1, upperDir.clone().normalize()));
    arm.sh.updateWorldMatrix(false, true);
    const d2 = arm.ha.getWorldPosition(new THREE.Vector3())
      .sub(arm.el.getWorldPosition(new THREE.Vector3())).normalize();
    this._worldRotate(arm.el, this._tmpQ.setFromUnitVectors(d2, foreDir.clone().normalize()));
    arm.el.updateWorldMatrix(false, true);
  }

  _updateProc(dt) {
    const p = this._proc;
    if (!p || !this.root) return;
    p.t += dt;
    if (p.t >= p.dur) {
      this._proc = null;
      if (this._rootBaseY !== undefined) this.root.position.y = this._rootBaseY;
      this.current = null;
      this.play('idle');
      return;
    }
    const arms = this._armBones();
    if (!arms?.L || !arms?.R) return;
    const UP = new THREE.Vector3(0, 1, 0);
    const fwd = new THREE.Vector3(Math.sin(this.group.rotation.y), 0, Math.cos(this.group.rotation.y));
    const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
    const t = p.t;

    if (p.name === 'dance') {
      const w = Math.sin(t * Math.PI * 2 * 1.15); // the groove
      this.root.position.y = this._rootBaseY + Math.abs(w) * 0.055;
      // alternating arm pumps, elbows up on the beat
      this._aimArm(arms.L,
        right.clone().multiplyScalar(-0.8).addScaledVector(UP, 0.15 + 0.3 * w),
        UP.clone().multiplyScalar(0.7 + 0.5 * w).addScaledVector(fwd, 0.3));
      this._aimArm(arms.R,
        right.clone().multiplyScalar(0.8).addScaledVector(UP, 0.15 - 0.3 * w),
        UP.clone().multiplyScalar(0.7 - 0.5 * w).addScaledVector(fwd, 0.3));
      if (this.head) {
        this._worldRotate(this.head, this._tmpQ.setFromAxisAngle(fwd, w * 0.13));
        this._worldRotate(this.head, this._tmpQ.setFromAxisAngle(UP, Math.sin(t * Math.PI * 2 * 0.57) * 0.22));
      }
    } else if (p.name === 'cheer') {
      const pump = 0.85 + Math.sin(t * Math.PI * 2 * 2.1) * 0.15;
      this.root.position.y = this._rootBaseY + Math.abs(Math.sin(t * Math.PI * 2 * 1.6)) * 0.07;
      // both arms in a V, pulsing
      this._aimArm(arms.L,
        UP.clone().multiplyScalar(pump).addScaledVector(right, -0.45).addScaledVector(fwd, 0.1),
        UP.clone().multiplyScalar(1).addScaledVector(right, -0.2));
      this._aimArm(arms.R,
        UP.clone().multiplyScalar(pump).addScaledVector(right, 0.45).addScaledVector(fwd, 0.1),
        UP.clone().multiplyScalar(1).addScaledVector(right, 0.2));
      if (this.head) this._worldRotate(this.head, this._tmpQ.setFromAxisAngle(right, -0.14));
    } else if (p.name === 'rage') {
      const tremble = Math.sin(t * 42) * 0.07;
      // fists up in front, shaking; head shakes no-no fast
      this._aimArm(arms.L,
        fwd.clone().multiplyScalar(0.55).addScaledVector(UP, -0.5 + tremble).addScaledVector(right, -0.35),
        UP.clone().multiplyScalar(0.9).addScaledVector(fwd, 0.45 + tremble));
      this._aimArm(arms.R,
        fwd.clone().multiplyScalar(0.55).addScaledVector(UP, -0.5 - tremble).addScaledVector(right, 0.35),
        UP.clone().multiplyScalar(0.9).addScaledVector(fwd, 0.45 - tremble));
      if (this.head) {
        this._worldRotate(this.head, this._tmpQ.setFromAxisAngle(UP, Math.sin(t * 26) * 0.12));
        this._worldRotate(this.head, this._tmpQ.setFromAxisAngle(right, 0.1));
      }
    }
  }

  dispose(scene) {
    if (scene) scene.remove(this.group);
  }
}


