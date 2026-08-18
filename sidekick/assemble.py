# Assembles a Synty Sidekick character into one GLB (skinned + blendshapes).
# Run:  blender --background --python assemble.py -- [outfit_variant] [out.glb]
# All parts share the same skeleton, so: import every part FBX, keep the first
# armature, re-bind every mesh to it, texture from the pack colormaps, export.
import bpy, os, sys

RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "raw")
argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
VARIANT = (argv[0] if len(argv) > 0 else "01").zfill(2)
OUT = argv[1] if len(argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "client", "public", "chars", "SK_Quant.glb")

HUM = os.path.join(RAW, "Resources", "Meshes", "Species", "Humans")
OUT_DIR = os.path.join(RAW, "Resources", "Meshes", "Outfits", "ModernCivilians")
SKIN_TEX = os.path.join(RAW, "Characters", "HumanSpecies", "HumanSpecies_01", "Textures", "T_HumanSpecies_01ColorMap.png")
OUTFIT_TEX = os.path.join(RAW, "Characters", "ModernCivilians", f"ModernCivilian_{VARIANT}", "Textures", f"T_ModernCivilian_{VARIANT}ColorMap.png")

# base head/face always from the human base; body slots prefer the outfit
# 09FCHR = facial hair (the beard) — excluded; add back if Quant regrows it
FACE_SLOTS = ["01HEAD", "03EBRL", "04EBRR", "05EYEL", "06EYER", "07EARL", "08EARR", "35NOSE", "36TETH", "37TONG"]
BODY_SLOTS = ["02HAIR", "10TORS", "11AUPL", "12AUPR", "13ALWL", "14ALWR", "15HNDL", "16HNDR", "17HIPS", "18LEGL", "19LEGR", "20FOTL", "21FOTR"]

def find_part(folder, prefix, slot):
    if not os.path.isdir(folder):
        return None
    for f in sorted(os.listdir(folder)):
        if f.startswith(prefix) and f"_{slot}_" in f and f.endswith(".fbx"):
            return os.path.join(folder, f)
    return None

parts = []          # (path, is_skin)
for slot in FACE_SLOTS:
    p = find_part(HUM, "SK_HUMN_BASE_01", slot)
    if p: parts.append((p, True))
for slot in BODY_SLOTS:
    p = find_part(OUT_DIR, f"SK_MDRN_CIVL_{VARIANT}", slot)
    if p:
        parts.append((p, False))
    else:  # outfit variant lacks the slot -> bare human part fills it
        q = find_part(HUM, "SK_HUMN_BASE_01", slot)
        if q: parts.append((q, True))

print(f"[assemble] variant {VARIANT}: {len(parts)} parts")

# fresh scene
bpy.ops.wm.read_factory_settings(use_empty=True)

def img_material(name, path):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.85
    tex = m.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(path)
    m.node_tree.links.new(bsdf.inputs["Base Color"], tex.outputs["Color"])
    return m

skin_mat = img_material("SK_Skin", SKIN_TEX)
outfit_mat = img_material("SK_Outfit", OUTFIT_TEX)

master_arm = None
kept = 0
for path, is_skin in parts:
    before = {o.name for o in bpy.data.objects}
    bpy.ops.import_scene.fbx(filepath=path, ignore_leaf_bones=True)
    # operate strictly BY NAME — object references die across removals
    new_names = [o.name for o in bpy.data.objects if o.name not in before]
    arm_names = [n for n in new_names if bpy.data.objects[n].type == "ARMATURE"]
    mesh_names = [n for n in new_names if bpy.data.objects[n].type == "MESH"]
    if master_arm is None and arm_names:
        master_arm = bpy.data.objects[arm_names[0]]
        master_arm.name = "SK_Armature"
        arm_names = arm_names[1:]
    for n in mesh_names:
        me = bpy.data.objects[n]
        me.parent = master_arm
        me.matrix_parent_inverse.identity()
        for mod in me.modifiers:
            if mod.type == "ARMATURE":
                mod.object = master_arm
        me.data.materials.clear()
        me.data.materials.append(skin_mat if is_skin else outfit_mat)
        kept += 1
    for n in arm_names:  # duplicate skeletons out
        if n in bpy.data.objects:
            bpy.data.objects.remove(bpy.data.objects[n], do_unlink=True)
    for n in new_names:  # stray empties/lights
        if n in bpy.data.objects and bpy.data.objects[n].type not in ("MESH", "ARMATURE"):
            try: bpy.data.objects.remove(bpy.data.objects[n], do_unlink=True)
            except Exception: pass

shapes = sum(len(m.data.shape_keys.key_blocks) - 1 for m in bpy.data.objects
             if m.type == "MESH" and m.data.shape_keys)
print(f"[assemble] meshes: {kept}, total shape keys: {shapes}, armature: {master_arm.name if master_arm else 'NONE'}")

os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=os.path.abspath(OUT),
    export_format="GLB",
    export_morph=True,
    export_skins=True,
    export_yup=True,
    export_animations=False,
    export_apply=False,
)
print(f"[assemble] exported {os.path.abspath(OUT)}")
