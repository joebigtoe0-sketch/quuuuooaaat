# Renders every Modern Civilians outfit variant on the Quant base — one
# Blender run, stills into sidekick/catalog/. Pick a number, rebuild with it.
import bpy, os, math

BASE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(BASE, "raw")
OUT = os.path.join(BASE, "catalog")
os.makedirs(OUT, exist_ok=True)

HUM = os.path.join(RAW, "Resources", "Meshes", "Species", "Humans")
OUTF = os.path.join(RAW, "Resources", "Meshes", "Outfits", "ModernCivilians")
SKIN_TEX = os.path.join(RAW, "Characters", "HumanSpecies", "HumanSpecies_01", "Textures", "T_HumanSpecies_01ColorMap.png")

FACE_SLOTS = ["01HEAD", "03EBRL", "04EBRR", "05EYEL", "06EYER", "07EARL", "08EARR", "35NOSE", "36TETH", "37TONG"]
BODY_SLOTS = ["02HAIR", "10TORS", "11AUPL", "12AUPR", "13ALWL", "14ALWR", "15HNDL", "16HNDR", "17HIPS", "18LEGL", "19LEGR", "20FOTL", "21FOTR"]

def find_part(folder, prefix, slot):
    if not os.path.isdir(folder): return None
    for f in sorted(os.listdir(folder)):
        if f.startswith(prefix) and f"_{slot}_" in f and f.endswith(".fbx"):
            return os.path.join(folder, f)
    return None

def img_material(name, path):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.85
    tex = m.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(path, check_existing=True)
    m.node_tree.links.new(bsdf.inputs["Base Color"], tex.outputs["Color"])
    return m

def build_and_render(variant):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.display.shading.light = "STUDIO"
    sc.display.shading.color_type = "TEXTURE"
    sc.render.resolution_x = 300
    sc.render.resolution_y = 460

    outfit_tex = os.path.join(RAW, "Characters", "ModernCivilians", f"ModernCivilian_{variant}", "Textures", f"T_ModernCivilian_{variant}ColorMap.png")
    if not os.path.exists(outfit_tex): return False
    skin_mat = img_material("skin", SKIN_TEX)
    outfit_mat = img_material("outfit", outfit_tex)

    parts = [(find_part(HUM, "SK_HUMN_BASE_01", sl), True) for sl in FACE_SLOTS]
    for sl in BODY_SLOTS:
        p = find_part(OUTF, f"SK_MDRN_CIVL_{variant}", sl)
        if p: parts.append((p, False))
        else:
            q = find_part(HUM, "SK_HUMN_BASE_01", sl)
            if q: parts.append((q, True))

    master = None
    for path, is_skin in parts:
        if not path: continue
        before = {o.name for o in bpy.data.objects}
        bpy.ops.import_scene.fbx(filepath=path, ignore_leaf_bones=True)
        new = [n for n in (o.name for o in bpy.data.objects) if n not in before]
        arms = [n for n in new if bpy.data.objects[n].type == "ARMATURE"]
        if master is None and arms:
            master = bpy.data.objects[arms[0]]
            arms = arms[1:]
        for n in new:
            o = bpy.data.objects.get(n)
            if not o: continue
            if o.type == "MESH":
                o.parent = master
                o.matrix_parent_inverse.identity()
                for mod in o.modifiers:
                    if mod.type == "ARMATURE": mod.object = master
                o.data.materials.clear()
                o.data.materials.append(skin_mat if is_skin else outfit_mat)
        for n in arms:
            if n in bpy.data.objects:
                bpy.data.objects.remove(bpy.data.objects[n], do_unlink=True)

    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
    bpy.context.collection.objects.link(cam)
    cam.location = (0, -3.4, 1.05)
    cam.rotation_euler = (math.radians(87), 0, 0)
    sc.camera = cam
    sc.render.filepath = os.path.join(OUT, f"variant_{variant}.png")
    bpy.ops.render.render(write_still=True)
    print(f"[catalog] {variant} done")
    return True

for i in range(1, 19):
    build_and_render(str(i).zfill(2))
print("[catalog] all done")
