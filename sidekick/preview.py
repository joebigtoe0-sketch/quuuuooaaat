# Renders preview stills of retargeted clips on the assembled character.
import bpy, os, math
from mathutils import Vector

BASE = os.path.dirname(os.path.abspath(__file__))
CHARS = os.path.abspath(os.path.join(BASE, "..", "client", "public", "chars"))
OUT = os.path.join(BASE, "previews")
os.makedirs(OUT, exist_ok=True)

SHOTS = [("idle", 30)]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.render.fps = 30

bpy.ops.import_scene.gltf(filepath=os.path.join(CHARS, "SK_Quant.glb"))
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")

before_actions = set(bpy.data.actions)
bpy.ops.import_scene.gltf(filepath=os.path.join(CHARS, "anims_sk.glb"))
# remove the second (skeleton-only) armature; keep its actions
for o in list(bpy.data.objects):
    if o.type == "ARMATURE" and o is not arm:
        bpy.data.objects.remove(o, do_unlink=True)
acts = {a.name.split(".")[0]: a for a in bpy.data.actions}
print("[preview] actions:", sorted(acts.keys()))

# camera + light
cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
bpy.context.collection.objects.link(cam)
cam.location = (0, -3.2, 1.3)
cam.rotation_euler = (math.radians(84), 0, 0)
bpy.context.scene.camera = cam
sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
sun.data.energy = 4
bpy.context.collection.objects.link(sun)
sun.rotation_euler = (math.radians(50), math.radians(-20), 0)

sc = bpy.context.scene
sc.render.engine = "BLENDER_WORKBENCH"
sc.display.shading.light = "STUDIO"
sc.display.shading.color_type = "TEXTURE"
sc.render.resolution_x = 420
sc.render.resolution_y = 640

arm.animation_data_create()
for clip, frame in SHOTS:
    a = acts.get(clip)
    if not a:
        print("[preview] missing", clip)
        continue
    arm.animation_data.action = a
    # Blender 4.4+ layered actions: must bind a slot explicitly when the
    # action was authored on a different object
    if getattr(a, "slots", None) and len(a.slots):
        arm.animation_data.action_slot = a.slots[0]
    sc.frame_set(min(frame, int(a.frame_range[1]) - 1))
    sc.render.filepath = os.path.join(OUT, f"{clip}.png")
    bpy.ops.render.render(write_still=True)
    print("[preview] wrote", clip + ".png")
