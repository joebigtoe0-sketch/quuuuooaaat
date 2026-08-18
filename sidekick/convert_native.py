# Converts native Synty ANIMATION-pack clips (A_MOD_* = Sidekick rig, same
# bone names) into anims_sk.glb. No retargeting — direct action transfer.
# Run: blender --background --python convert_native.py
import bpy, os
from mathutils import Matrix

BASE = os.path.dirname(os.path.abspath(__file__))
ANIMS = os.path.join(BASE, "raw", "Anims")
CHARS = os.path.abspath(os.path.join(BASE, "..", "client", "public", "chars"))
OUT = os.path.join(CHARS, "anims_sk.glb")

# clip name (used by server cues) -> source file. Old names keep working;
# new emotes extend the menu.
CLIPS = {
    "idle": "A_MOD_BL_Idle_Standing_Masc.fbx",
    "walk": "A_MOD_BL_Walk_F_Masc.fbx",
    "run": "A_MOD_BL_Run_F_Masc.fbx",
    "jump": "A_MOD_BL_Jump_Idle_Masc.fbx",
    "crouch_idle": "A_MOD_BL_Idle_Crouching_Masc.fbx",
    "wave": "A_MOD_EMOT_Greet_Wave_Masc.fbx",
    "wave_over": "A_MOD_EMOT_Greet_WaveOver_Masc.fbx",
    "point": "A_MOD_EMOT_Taunt_LaughAndPoint_Masc.fbx",
    "clap": "A_MOD_EMOT_Celebrate_Clapping_Polite_Masc.fbx",
    "no_more": "A_MOD_EMOT_Reproach_WaveAway_Masc.fbx",
    "sip": "A_MOD_IDL_Drink_Sip_Masc.fbx",
    "cheer": "A_MOD_EMOT_Happy_ArmsRaised_Masc.fbx",
    "rage": "A_MOD_EMOT_Angry_Tantrum_Masc.fbx",
    "dance": "A_MOD_EMOT_Dance_Twist_Masc.fbx",
    "dance2": "A_MOD_EMOT_Dance_ChestPump_Masc.fbx",
    "dance3": "A_MOD_EMOT_Dance_GreasedLightnin_Masc.fbx",
    "dance4": "A_MOD_EMOT_Dance_Spin_Slick_Masc.fbx",
    "dab": "A_MOD_EMOT_Celebrate_Dab_Masc.fbx",
    "facepalm": "A_MOD_EMOT_Sad_Facepalm_Masc.fbx",
    "thumbs_down": "A_MOD_EMOT_Aggressive_ThumbsDown_Roman_Masc.fbx",
    "thumbs_up": "A_MOD_EMOT_Happy_ThumbsUp_Masc.fbx",
    "mock_cry": "A_MOD_EMOT_Taunt_MockCrying_Masc.fbx",
    "slow_clap": "A_MOD_EMOT_Taunt_SlowClap_Masc.fbx",
    "shhh": "A_MOD_EMOT_Taunt_Shhh_Masc.fbx",
    "fist_pump": "A_MOD_EMOT_Happy_FistPump_Masc.fbx",
    "flex": "A_MOD_EMOT_Sporty_Flex_Combo_Masc.fbx",
    "shrug": "A_MOD_EMOT_Sad_Shrug_Masc.fbx",
    "cry": "A_MOD_EMOT_Sad_Crying_Masc.fbx",
    "tired": "A_MOD_EMOT_Sad_Tired_Masc.fbx",
    "arms_folded": "A_MOD_IDL_ArmsFolded_Casual_Loop_Masc.fbx",
    "finger_guns": "A_MOD_EMOT_Celebrate_FingerGuns_Double_Masc.fbx",
    "salute": "A_MOD_EMOT_Greet_Salute_Masc.fbx",
    # -- full emote sweep --
    "blow_kiss": "A_MOD_EMOT_Affection_BlowKiss_Masc.fbx",
    "call_me": "A_MOD_EMOT_Affection_CallMe_Masc.fbx",
    "finger_heart": "A_MOD_EMOT_Affection_FingerHeart_Masc.fbx",
    "heart_hands": "A_MOD_EMOT_Affection_HeartHands_Masc.fbx",
    "menace": "A_MOD_EMOT_Aggressive_MenacingFists_Masc.fbx",
    "roar": "A_MOD_EMOT_Aggressive_Roar_High_Masc.fbx",
    "throat_slit": "A_MOD_EMOT_Aggressive_ThroatSlit_Masc.fbx",
    "shake_fist": "A_MOD_EMOT_Angry_ShakeFist_Masc.fbx",
    "strangle": "A_MOD_EMOT_Angry_StranglingMotion_Masc.fbx",
    "tantrum_stomp": "A_MOD_EMOT_Angry_TantrumStomp_Masc.fbx",
    "air_guitar": "A_MOD_EMOT_Celebrate_AirGuitar_Masc.fbx",
    "beat_chest": "A_MOD_EMOT_Celebrate_BeatChest_Masc.fbx",
    "dust_shoulder": "A_MOD_EMOT_Celebrate_DustShoulder_Masc.fbx",
    "hand_on_heart": "A_MOD_EMOT_Celebrate_HandOnHeart_Masc.fbx",
    "dance5": "A_MOD_EMOT_Dance_RunningStep_Masc.fbx",
    "beckon": "A_MOD_EMOT_Greet_Beckon_Finger_Masc.fbx",
    "bow": "A_MOD_EMOT_Greet_Bow_Masc.fbx",
    "nod_confident": "A_MOD_EMOT_Happy_Nodding_Confident_Masc.fbx",
    "two_thumbs": "A_MOD_EMOT_Happy_TwoThumbs_Bold_Masc.fbx",
    "calm_down": "A_MOD_EMOT_Reproach_CalmDown_Masc.fbx",
    "you_crazy": "A_MOD_EMOT_Reproach_HeadTap_YouCrazy_Masc.fbx",
    "shake_finger": "A_MOD_EMOT_Reproach_ShakeFinger_Masc.fbx",
    "faint": "A_MOD_EMOT_Sad_MelodramaticFaint_Masc.fbx",
    "backflip": "A_MOD_EMOT_Sporty_Backflip_Masc.fbx",
    "boxing": "A_MOD_EMOT_Sporty_Boxing_Masc.fbx",
    "flex_biceps": "A_MOD_EMOT_Sporty_Flex_Biceps_Masc.fbx",
    "handshake_reject": "A_MOD_EMOT_Taunt_HandShakeReject_Masc.fbx",
    "raspberry": "A_MOD_EMOT_Taunt_Raspberry_Masc.fbx",
    # -- idle variance / fidgets (IDL pack) --
    "idle2": "A_MOD_IDL_Base_Masc.fbx",
    "foot_tap": "A_MOD_IDL_Bored_FootTap_Masc.fbx",
    "kick_ground": "A_MOD_IDL_Bored_KickGround_Masc.fbx",
    "slump": "A_MOD_IDL_Bored_SlumpBack_Masc.fbx",
    "swing_arms": "A_MOD_IDL_Bored_SwingArms_Masc.fbx",
    "check_watch": "A_MOD_IDL_CheckWatch_Masc.fbx",
    "hands_on_hips": "A_MOD_IDL_HandsOnHips_Base_Loop_Masc.fbx",
    "head_nod": "A_MOD_IDL_HeadNod_Small_Masc.fbx",
    "head_shake": "A_MOD_IDL_HeadShake_Disappointed_Masc.fbx",
    "inspect_hands": "A_MOD_IDL_Inspect_Hands_Masc.fbx",
    "stretch_arms": "A_MOD_IDL_Stretch_Arms_Masc.fbx",
    "stretch_shoulders": "A_MOD_IDL_Stretch_Shoulders_Masc.fbx",
    "yawn": "A_MOD_IDL_Yawn_Masc.fbx",
    "weight_shift": "A_MOD_IDL_WeightShift_L_Masc.fbx",
    "thoughtful": "A_MOD_IDL_Thoughtful_R_Loop_Masc.fbx",
    "chin_scratch": "A_MOD_IDL_Thoughtful_R_ChinScratch_Masc.fbx",
    "drunk_sway": "A_MOD_IDL_Sway_Drunk_Loop_Masc.fbx",
    "pick_nose": "A_MOD_IDL_PickNose_Loop_Masc.fbx",
    "phone_scroll": "A_MOD_IDL_UsePhone_OneHand_Scrolling_Masc.fbx",
    "phone_selfie": "A_MOD_IDL_UsePhone_OneHand_Selfie_Loop_Masc.fbx",
    "phone_photo": "A_MOD_IDL_UsePhone_OneHand_Photo_Masc.fbx",
    "phone_type": "A_MOD_IDL_UsePhone_TwoHands_Typing_Masc.fbx",
    "pray": "A_MOD_IDL_Pray_Standing_Loop_Masc.fbx",
    "plead": "A_MOD_IDL_Plead_F_Masc.fbx",
    "look_left": "A_MOD_IDL_Look_L_Masc.fbx",
    "look_right": "A_MOD_IDL_Look_R_Masc.fbx",
    "look_up": "A_MOD_IDL_Look_Up_Masc.fbx",
    "look_down": "A_MOD_IDL_Look_Down_Masc.fbx",
    "drink_swig": "A_MOD_IDL_Drink_Swig_Masc.fbx",
    "lean_back": "A_MOD_IDL_Lean_B_Base_Loop_Masc.fbx",
}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.render.fps = 30

# target skeleton from the assembled character (meshes stripped)
before = {o.name for o in bpy.data.objects}
bpy.ops.import_scene.gltf(filepath=os.path.join(CHARS, "SK_Quant.glb"))
tgt = next(o for o in bpy.data.objects if o.name not in before and o.type == "ARMATURE")
tgt.name = "TGT"
for o in [o for o in bpy.data.objects if o.name not in before and o.type == "MESH"]:
    bpy.data.objects.remove(o, do_unlink=True)
tgt.animation_data_create()
tgt_bones = {b.name for b in tgt.data.bones}
TGT_REST = {b.name: b.matrix_local.copy() for b in tgt.data.bones}
TGT_PARENT = {b.name: (b.parent.name if b.parent else None) for b in tgt.data.bones}
ORDER = [b.name for b in tgt.data.bones]

def bake_from(src_arm, src_action, clip_name):
    """Sample the source rig playing its action; write quaternion keys on TGT.
    Same skeleton on both sides, so this is rotation-mode-proof and exact."""
    src_arm.animation_data_create()
    src_arm.animation_data.action = src_action
    if getattr(src_action, "slots", None) and len(src_action.slots):
        src_arm.animation_data.action_slot = src_action.slots[0]
    f0, f1 = int(src_action.frame_range[0]), int(src_action.frame_range[1])
    frames = range(f0, min(f1, f0 + 900) + 1)
    shared = [n for n in ORDER if n in src_arm.pose.bones]
    act = bpy.data.actions.new(clip_name)
    tgt.animation_data.action = act
    for f in frames:
        bpy.context.scene.frame_set(f)
        kf = f - f0
        for name in shared:
            spb = src_arm.pose.bones[name]
            parent = TGT_PARENT.get(name)
            rel_rest = (TGT_REST[parent].inverted() @ TGT_REST[name]) if parent else TGT_REST[name]
            parent_m = src_arm.pose.bones[parent].matrix if (parent and parent in src_arm.pose.bones) else Matrix.Identity(4)
            basis = rel_rest.inverted() @ (parent_m.inverted() @ spb.matrix)
            pb = tgt.pose.bones[name]
            pb.rotation_mode = "QUATERNION"
            pb.rotation_quaternion = basis.to_quaternion()
            pb.keyframe_insert("rotation_quaternion", frame=kf)
            if name == "pelvis":
                pb.location = basis.to_translation()
                pb.keyframe_insert("location", frame=kf)
    track = tgt.animation_data.nla_tracks.new()
    track.name = clip_name
    track.strips.new(clip_name, 0, act)
    tgt.animation_data.action = None
    return len(list(frames))

done = 0
for clip, fname in CLIPS.items():
    p = os.path.join(ANIMS, fname)
    if not os.path.exists(p):
        print(f"[convert] MISSING {fname}")
        continue
    before = {o.name for o in bpy.data.objects}
    before_actions = set(bpy.data.actions)
    bpy.ops.import_scene.fbx(filepath=p, ignore_leaf_bones=True, automatic_bone_orientation=False)
    new_acts = [a for a in bpy.data.actions if a not in before_actions]
    if not new_acts:
        print(f"[convert] no action in {fname}")
        continue
    # multi-take FBXes: pick the action with the most on-skeleton pose curves
    def pose_hits(a):
        return sum(1 for fc in a.fcurves if fc.data_path.startswith('pose.bones["') and fc.data_path.split('"')[1] in tgt_bones)
    src_act = max(new_acts, key=pose_hits)
    src_arm = next((o for o in bpy.data.objects if o.name not in before and o.type == "ARMATURE"), None)
    if not src_arm:
        print(f"[convert] no armature in {fname}")
        continue
    nframes = bake_from(src_arm, src_act, clip)
    done += 1
    print(f"[convert] {clip}: {fname} ({nframes} frames baked)")
    # remove imported objects + their actions
    for o in [o for o in bpy.data.objects if o.name not in before]:
        try: bpy.data.objects.remove(o, do_unlink=True)
        except Exception: pass
    for a in new_acts:
        try: bpy.data.actions.remove(a)
        except Exception: pass

for o in bpy.data.objects:
    o.select_set(o == tgt)
bpy.context.view_layer.objects.active = tgt
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format="GLB", use_selection=True,
    export_animations=True, export_animation_mode="NLA_TRACKS",
    export_yup=True, export_skins=True, export_morph=False,
)
print(f"[convert] exported {done} clips -> {OUT}")
