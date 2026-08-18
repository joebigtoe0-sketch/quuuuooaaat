# Retargets animation clips onto the Sidekick rig — headless, no Unity.
#   sources: client/public/chars/anims.glb   (classic Synty rig, 15 clips)
#            Downloads/biped/*_Dance/Groove  (Mixamo-style rig, the dances)
#   target:  client/public/chars/SK_Quant.glb (Sidekick skeleton)
#   output:  client/public/chars/anims_sk.glb
#
# Method: per mapped bone pair, desired_world(t) = src_world(t) @ offset where
# offset = src_rest_world^-1 @ dst_rest_world (captured at rest). Pose-space
# math is done manually (no scene-update-per-bone), pelvis gets scaled root
# motion, unmapped helper bones (twists/IK/sockets) stay at rest.
import bpy, os, sys
from mathutils import Matrix

BASE = os.path.dirname(os.path.abspath(__file__))
CHARS = os.path.abspath(os.path.join(BASE, "..", "client", "public", "chars"))
BIPED = r"C:\Users\nikos\Downloads\biped"
OUT = os.path.join(CHARS, "anims_sk.glb")

CLASSIC_MAP = {
    "Hips": "pelvis", "Spine_01": "spine_01", "Spine_02": "spine_02", "Spine_03": "spine_03",
    "Neck": "neck_01", "Head": "head", "Jaw": "jaw",
    "Clavicle_L": "clavicle_l", "Shoulder_L": "upperarm_l", "Elbow_L": "lowerarm_l", "Hand_L": "hand_l",
    "Clavicle_R": "clavicle_r", "Shoulder_R": "upperarm_r", "Elbow_R": "lowerarm_r", "Hand_R": "hand_r",
    "UpperLeg_L": "thigh_l", "LowerLeg_L": "calf_l", "Ankle_L": "foot_l",
    "UpperLeg_R": "thigh_r", "LowerLeg_R": "calf_r", "Ankle_R": "foot_r",
}
MIXAMO_MAP = {
    "Hips": "pelvis", "Spine": "spine_01", "Spine01": "spine_02", "Spine02": "spine_03",
    "neck": "neck_01", "Neck": "neck_01", "Head": "head",
    "LeftShoulder": "clavicle_l", "LeftArm": "upperarm_l", "LeftForeArm": "lowerarm_l", "LeftHand": "hand_l",
    "RightShoulder": "clavicle_r", "RightArm": "upperarm_r", "RightForeArm": "lowerarm_r", "RightHand": "hand_r",
    "LeftUpLeg": "thigh_l", "LeftLeg": "calf_l", "LeftFoot": "foot_l",
    "RightUpLeg": "thigh_r", "RightLeg": "calf_r", "RightFoot": "foot_r",
}
DANCES = [
    ("Animation_All_Night_Dance_withSkin.fbx", "dance"),
    ("Animation_Boom_Dance_withSkin.fbx", "dance2"),
    ("Animation_You_Groove_withSkin.fbx", "dance3"),
    ("Animation_Walking_withSkin.fbx", "walk"),
    ("Animation_Running_withSkin.fbx", "run"),
    ("Animation_Agree_Gesture_withSkin.fbx", "agree"),
    ("Animation_Alert_withSkin.fbx", "alert"),
    ("Animation_Boxing_Practice_withSkin.fbx", "boxing"),
    ("Animation_Attack_withSkin.fbx", "attack"),
    ("Animation_Arise_withSkin.fbx", "arise"),
    ("Animation_BeHit_FlyUp_withSkin.fbx", "behit"),
]
# Any mixamo-rig FBX dropped into Downloads/biped/extra/ is converted too,
# named after its file (idle.fbx → clip "idle"). This is the easy way to add
# the basics: download from mixamo.com (any character, FBX, with/without skin).
EXTRA_DIR = os.path.join(BIPED, "extra")

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.render.fps = 30

# ---------- target ----------
before = {o.name for o in bpy.data.objects}
bpy.ops.import_scene.gltf(filepath=os.path.join(CHARS, "SK_Quant.glb"))
tgt = next(o for o in bpy.data.objects if o.name not in before and o.type == "ARMATURE")
tgt.name = "TGT"
# strip meshes — we only need the skeleton in the anims file
for o in [o for o in bpy.data.objects if o.name not in before and o.type == "MESH"]:
    bpy.data.objects.remove(o, do_unlink=True)

TGT_REST = {b.name: b.matrix_local.copy() for b in tgt.data.bones}         # armature space
TGT_PARENT = {b.name: (b.parent.name if b.parent else None) for b in tgt.data.bones}

def retarget_action(src_arm, src_action, bone_map, clip_name):
    src_arm.animation_data_create()
    src_arm.animation_data.action = src_action
    f0, f1 = (int(src_action.frame_range[0]), int(src_action.frame_range[1]))
    frames = range(f0, min(f1, f0 + 900) + 1)

    # rest offsets in WORLD space on both sides — the source object often
    # carries import scale/rotation (glTF Y-up, FBX cm), so armature-space
    # rests don't line up with world-space pose matrices otherwise
    src_rest = {b.name: (src_arm.matrix_world @ b.matrix_local) for b in src_arm.data.bones}
    tgt_rest_world = {n: (tgt.matrix_world @ m) for n, m in TGT_REST.items()}
    offsets, pairs = {}, []
    for s, t in bone_map.items():
        if s in src_rest and t in tgt_rest_world:
            offsets[t] = src_rest[s].inverted() @ tgt_rest_world[t]
            pairs.append((s, t))
    hip_s = next((s for s, t in pairs if t == "pelvis"), None)
    scale = 1.0
    if hip_s:
        sh = abs(src_rest[hip_s].translation.z) or src_rest[hip_s].translation.length or 1
        th = abs(tgt_rest_world["pelvis"].translation.z) or tgt_rest_world["pelvis"].translation.length or 1
        scale = th / sh

    act = bpy.data.actions.new(clip_name)
    tgt.animation_data_create()
    tgt.animation_data.action = act

    mapped_targets = {t for _, t in pairs}
    order = [b.name for b in tgt.data.bones]  # data.bones is hierarchy-sorted

    TW_INV = tgt.matrix_world.inverted()
    src_of = dict((t, s) for s, t in pairs)
    for f in frames:
        bpy.context.scene.frame_set(f)
        src_world = {s: (src_arm.matrix_world @ src_arm.pose.bones[s].matrix) for s, _ in pairs}
        # 1) desired matrices in WORLD frame
        desired_w = {}
        for name in order:
            s = src_of.get(name)
            parent = TGT_PARENT[name]
            if s:
                desired_w[name] = src_world[s] @ offsets[name]
            else:
                # unmapped helper: ride the parent with its rest-relative offset
                rel = (TGT_REST[parent].inverted() @ TGT_REST[name]) if parent else TGT_REST[name]
                pw = desired_w.get(parent) if parent else None
                desired_w[name] = (pw @ rel) if pw is not None else (tgt.matrix_world @ TGT_REST[name])
        # 2) convert to target ARMATURE frame — basis math must be single-frame
        desired = {n: TW_INV @ m for n, m in desired_w.items()}
        kf = f - f0
        for name in order:
            parent = TGT_PARENT[name]
            parent_arm = desired[parent] if parent else Matrix.Identity(4)
            rel_rest = (TGT_REST[parent].inverted() @ TGT_REST[name]) if parent else TGT_REST[name]
            basis = rel_rest.inverted() @ (parent_arm.inverted() @ desired[name])
            pb = tgt.pose.bones[name]
            pb.rotation_mode = "QUATERNION"
            pb.rotation_quaternion = basis.to_quaternion()
            pb.keyframe_insert("rotation_quaternion", frame=kf)
            if name == "pelvis":
                pb.location = basis.to_translation() * scale
                pb.keyframe_insert("location", frame=kf)
    # stash into NLA so every clip survives into the export
    track = tgt.animation_data.nla_tracks.new()
    track.name = clip_name
    track.strips.new(clip_name, 0, act)
    tgt.animation_data.action = None
    print(f"[retarget] {clip_name}: {len(list(frames))} frames, {len(pairs)} bones")

# ---------- mixamo-style FBX sources (the retarget path that WORKS) ----------
sources = [(os.path.join(BIPED, f), c) for f, c in DANCES]
if os.path.isdir(EXTRA_DIR):
    for f in sorted(os.listdir(EXTRA_DIR)):
        if f.lower().endswith(".fbx"):
            clip = os.path.splitext(f)[0].lower().replace(" ", "_").replace("animation_", "").replace("_withskin", "")
            sources.append((os.path.join(EXTRA_DIR, f), clip))

for p, clip in sources:
    if not os.path.exists(p):
        continue
    before = {o.name for o in bpy.data.objects}
    existing_actions = set(bpy.data.actions)
    bpy.ops.import_scene.fbx(filepath=p, ignore_leaf_bones=True)
    arm = next((o for o in bpy.data.objects if o.name not in before and o.type == "ARMATURE"), None)
    new_acts = [a for a in bpy.data.actions if a not in existing_actions]
    if arm and new_acts:
        retarget_action(arm, new_acts[0], MIXAMO_MAP, clip)
    # tidy
    for o in [o for o in bpy.data.objects if o.name not in before]:
        try: bpy.data.objects.remove(o, do_unlink=True)
        except Exception: pass

# ---------- export skeleton + clips ----------
for o in bpy.data.objects:
    o.select_set(o == tgt)
bpy.context.view_layer.objects.active = tgt
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format="GLB", use_selection=True,
    export_animations=True, export_animation_mode="NLA_TRACKS",
    export_yup=True, export_skins=True, export_morph=False,
)
print(f"[retarget] exported {OUT}")
