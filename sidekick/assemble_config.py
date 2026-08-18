# Config-driven Sidekick assembly: reads wardrobe.json (written by /wardrobe)
# and builds client/public/chars/SK_Quant.glb. Falls back to the classic
# default look when no config exists.
#   wardrobe.json: {
#     "parts":    { "<SLOT>": "<relpath under raw/>" | null, ... },
#     "textures": { "<CharactersGroup>": "<relpath of colormap under raw/>", ... },
#     "skin":     "<relpath of species colormap>"          (optional)
#   }
import bpy, os, json, colorsys

BASE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(BASE, "raw")
OUT = os.path.abspath(os.path.join(BASE, "..", "client", "public", "chars", "SK_Quant.glb"))
CONFIG = os.path.join(BASE, "wardrobe.json")

HUM = os.path.join(RAW, "Resources", "Meshes", "Species", "Humans")
FACE_SLOTS = ["01HEAD", "03EBRL", "04EBRR", "05EYEL", "06EYER", "07EARL", "08EARR", "35NOSE", "36TETH", "37TONG"]
BODY_SLOTS = ["02HAIR", "10TORS", "11AUPL", "12AUPR", "13ALWL", "14ALWR", "15HNDL", "16HNDR", "17HIPS", "18LEGL", "19LEGR", "20FOTL", "21FOTR"]

def find_part(folder, prefix, slot):
    if not os.path.isdir(folder): return None
    for f in sorted(os.listdir(folder)):
        if f.startswith(prefix) and f"_{slot}_" in f and f.endswith(".fbx"):
            return os.path.join(folder, f)
    return None

conf = {}
if os.path.exists(CONFIG):
    conf = json.load(open(CONFIG, encoding="utf-8"))
parts_conf = conf.get("parts", {})
tex_conf = conf.get("textures", {})
skin_rel = conf.get("skin") or os.path.join("Characters", "HumanSpecies", "HumanSpecies_01", "Textures", "T_HumanSpecies_01ColorMap.png")

# resolve the part list: config first, defaults fill the gaps
resolved = []  # (abs_path, kind)  kind: 'skin'|'outfit:<CharGroup>'
for slot in FACE_SLOTS:
    p = find_part(HUM, "SK_HUMN_BASE_01", slot)
    if p: resolved.append((p, "skin"))
# optional beard/extra face slots straight from config (e.g. 09FCHR)
for slot, rel in parts_conf.items():
    if slot in FACE_SLOTS or not rel: continue
    if slot in BODY_SLOTS: continue
    ap = os.path.join(RAW, rel.replace("/", os.sep))
    if os.path.exists(ap):
        kind = "skin" if os.sep + "Species" + os.sep in ap else "outfit:" + (rel.split("/")[3] if rel.startswith("Resources/Meshes/Outfits/") else "?")
        resolved.append((ap, kind))
for slot in BODY_SLOTS:
    rel = parts_conf.get(slot)
    if rel:
        ap = os.path.join(RAW, rel.replace("/", os.sep))
        if os.path.exists(ap):
            kind = "skin" if os.sep + "Species" + os.sep in ap else "outfit:" + (rel.split("/")[3] if rel.startswith("Resources/Meshes/Outfits/") else "?")
            resolved.append((ap, kind))
            continue
    if rel is None and slot in parts_conf:
        continue  # explicitly none (e.g. no hair)
    # defaults: Modern Civilians 01 body, bare human where missing
    p = find_part(os.path.join(RAW, "Resources", "Meshes", "Outfits", "ModernCivilians"), "SK_MDRN_CIVL_01", slot)
    if p: resolved.append((p, "outfit:ModernCivilians"))
    else:
        q = find_part(HUM, "SK_HUMN_BASE_01", slot)
        if q: resolved.append((q, "skin"))

print(f"[assemble] config parts: {len(resolved)}")

bpy.ops.wm.read_factory_settings(use_empty=True)

# palette repaints from the wardrobe's paint mode: exact palette cells swap to
# the picked color; "similar" shades (shadow ramps) carry the hue shift with
# scaled sat/light — mirrors repaint() in client/src/wardrobe/main.ts exactly.
recolor_conf = conf.get("recolor", {})
_recolored = set()

def _hex2rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))

def apply_recolor(img, relpath):
    key = relpath.replace("\\", "/")
    edits = [e for e in recolor_conf.get(key, []) if e.get("from") != e.get("to")]
    if not edits or img.name in _recolored:
        return
    _recolored.add(img.name)
    px = list(img.pixels)  # raw sRGB floats, no color management on byte images
    n = len(px) // 4
    for e in edits:
        fr, to = _hex2rgb(e["from"]), _hex2rgb(e["to"])
        sim = float(e.get("similar", 0) or 0)
        fh, fl, fs = colorsys.rgb_to_hls(*[c / 255 for c in fr])
        th, tl, ts = colorsys.rgb_to_hls(*[c / 255 for c in to])
        for i in range(n):
            r, g, b = px[4 * i] * 255, px[4 * i + 1] * 255, px[4 * i + 2] * 255
            dr, dg, db = r - fr[0], g - fr[1], b - fr[2]
            if abs(dr) < 2 and abs(dg) < 2 and abs(db) < 2:
                px[4 * i], px[4 * i + 1], px[4 * i + 2] = to[0] / 255, to[1] / 255, to[2] / 255
            elif sim > 0 and (dr * dr + dg * dg + db * db) ** 0.5 <= sim:
                h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
                h = (h + th - fh) % 1
                s = min(1, max(0, s * ts / fs)) if fs > 0.03 else ts
                l = min(1, max(0, l * tl / fl)) if fl > 0.03 else tl
                nr, ng, nb = colorsys.hls_to_rgb(h, l, s)
                px[4 * i], px[4 * i + 1], px[4 * i + 2] = nr, ng, nb
    img.pixels = px
    img.pack()  # embed the edited pixels so the glTF export uses them
    print(f"[assemble] repainted {key}: {len(edits)} edit(s)")

def img_material(name, relpath):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.85
    tex = m.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(os.path.join(RAW, relpath.replace("/", os.sep)), check_existing=True)
    apply_recolor(tex.image, relpath)
    m.node_tree.links.new(bsdf.inputs["Base Color"], tex.outputs["Color"])
    return m

skin_mat = img_material("SK_Skin", skin_rel)
outfit_mats = {}
def outfit_mat(group):
    if group not in outfit_mats:
        rel = tex_conf.get(group)
        if not rel:
            # first colormap available for the group
            gdir = os.path.join(RAW, "Characters", group)
            rel = None
            if os.path.isdir(gdir):
                for v in sorted(os.listdir(gdir)):
                    tdir = os.path.join(gdir, v, "Textures")
                    if os.path.isdir(tdir):
                        maps = [t for t in sorted(os.listdir(tdir)) if t.lower().endswith("colormap.png")]
                        if maps:
                            rel = os.path.join("Characters", group, v, "Textures", maps[0])
                            break
        outfit_mats[group] = img_material(f"SK_{group}", rel) if rel else skin_mat
    return outfit_mats[group]

def merge_missing_bones(src_arm, dst_arm):
    """Attachments (antennas, masks…) carry extra dynamic bones (ahed_dyn_*)
    that the base skeleton lacks — copy them over before the source armature is
    deleted, or their vertices freeze in rest pose while the head animates."""
    import mathutils
    missing = [b.name for b in src_arm.data.bones if b.name not in dst_arm.data.bones]
    if not missing:
        return 0
    src = {b.name: (b.matrix_local.copy(), b.parent.name if b.parent else None,
                    max(0.01, (b.tail_local - b.head_local).length)) for b in src_arm.data.bones}
    bpy.context.view_layer.objects.active = dst_arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = dst_arm.data.edit_bones
    for n in missing:
        ml, parent, blen = src[n]
        b = eb.new(n)
        b.head = (0, 0, 0)
        b.tail = (0, blen, 0)
        b.matrix = ml  # sets head/orientation/roll from the rest matrix
        if parent and parent in eb:
            b.parent = eb[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    print(f"[assemble] merged {len(missing)} attachment bones: {missing}")
    return len(missing)

master_arm = None
kept = 0
for path_abs, kind in resolved:
    before = {o.name for o in bpy.data.objects}
    bpy.ops.import_scene.fbx(filepath=path_abs, ignore_leaf_bones=True)
    new_names = [o.name for o in bpy.data.objects if o.name not in before]
    arm_names = [n for n in new_names if bpy.data.objects[n].type == "ARMATURE"]
    mesh_names = [n for n in new_names if bpy.data.objects[n].type == "MESH"]
    if master_arm is None and arm_names:
        master_arm = bpy.data.objects[arm_names[0]]
        master_arm.name = "SK_Armature"
        arm_names = arm_names[1:]
    mat = skin_mat if kind == "skin" else outfit_mat(kind.split(":", 1)[1])
    for n in mesh_names:
        me = bpy.data.objects[n]
        me.parent = master_arm
        me.matrix_parent_inverse.identity()
        for mod in me.modifiers:
            if mod.type == "ARMATURE":
                mod.object = master_arm
        me.data.materials.clear()
        me.data.materials.append(mat)
        kept += 1
    for n in arm_names:
        if n in bpy.data.objects:
            if master_arm is not None:
                merge_missing_bones(bpy.data.objects[n], master_arm)
            bpy.data.objects.remove(bpy.data.objects[n], do_unlink=True)
    for n in new_names:
        if n in bpy.data.objects and bpy.data.objects[n].type not in ("MESH", "ARMATURE"):
            try: bpy.data.objects.remove(bpy.data.objects[n], do_unlink=True)
            except Exception: pass

# body shape: heavy / skinny / feminine blends exist on every part — set the
# chosen mix as the shape-key VALUES; the glTF exporter writes them as default
# morph weights, so the character loads pre-shaped (face morphs untouched)
body = conf.get("body", {})
BODY_KEYS = {"defaultHeavy": float(body.get("heavy", 0) or 0),
             "defaultSkinny": float(body.get("skinny", 0) or 0),
             "defaultBuff": float(body.get("buff", 0) or 0),
             "masculineFeminine": float(body.get("feminine", 0) or 0)}
applied = 0
for o in bpy.data.objects:
    if o.type != "MESH" or not o.data.shape_keys: continue
    for kb in o.data.shape_keys.key_blocks:
        if kb.name in BODY_KEYS and BODY_KEYS[kb.name] > 0:
            kb.value = min(1.0, BODY_KEYS[kb.name])
            applied += 1
print(f"[assemble] body blend applied on {applied} shape keys: {BODY_KEYS}")

shapes = sum(len(m.data.shape_keys.key_blocks) - 1 for m in bpy.data.objects
             if m.type == "MESH" and m.data.shape_keys)
print(f"[assemble] meshes: {kept}, shape keys: {shapes}")

os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format="GLB", export_morph=True, export_skins=True,
    export_yup=True, export_animations=False, export_apply=False,
)
print(f"[assemble] exported {OUT}")
