# TIKTOK STUDIO — offline filming

One POST films a finished clip (subtitles burned in, auto camera cuts,
mp4 in `data/clips/`). Works against the LOCAL offline server; a stage
client (browser tab on /stage) must be open — it does the rendering.

## Studio mode (green room, 3 cams, auto-cut)

```bash
curl -X POST http://localhost:8490/admin/tiktok -H "content-type: application/json" -d '{
  "script": [
    { "do": "say",  "text": "three coins died today. i watched all of them.", "mood": "neutral" },
    { "do": "anim", "clip": "shrug" },
    { "do": "say",  "text": "the first one had a dev with eleven previous rugs. eleven.", "mood": "disgusted" },
    { "do": "say",  "text": "follow for more autopsies.", "mood": "excited" }
  ]
}'
```

- Auto-cut rotates front → left → right between `say` lines, every shot has a
  slow push-in + micro-drift (constant movement, nothing static).
- Add explicit `{ "do": "tiktokcam", "cam": "left" }` steps to take manual
  control — autocut disables itself when you do.
- All play steps work inside: `anim`, `fx`, `think`, `sit`, `wait` {ms}.
- Subtitles burn INTO the canvas (word-karaoke, yellow active word), sized to
  survive a 9:16 center crop.

## Facecam mode (reaction overlay — key him onto anything)

```bash
curl -X POST http://localhost:8490/admin/tiktok -H "content-type: application/json" -d '{
  "mode": "facecam",
  "script": [ { "do": "say", "text": "chat. look at this chart. LOOK at it." } ]
}'
```

- Locked to the front camera, the whole room hidden, backdrop = pure chroma
  green (#00b140) — key it out in CapCut/Premiere and overlay him on the
  thing he's reacting to.

## Background replacement (facecam mode)

Pass `"bg"` with an image or video URL — it renders BEHIND him in-engine, so
the clip comes out finished, no keying needed:

```bash
curl -X POST http://localhost:8490/admin/tiktok -H "content-type: application/json" -d '{
  "mode": "facecam",
  "bg": "/media/bg/chart.mp4",
  "script": [ { "do": "say", "text": "chat. look at this chart. LOOK at it." } ]
}'
```

Drop bg files in `client/public/media/bg/` (mp4/webm loops autoplay muted;
png/jpg are static). No `bg` = pure chroma green for keying in the editor.

## Pace

`"pace": "hype"` (default) — front cam holds 1-2s, side stabs 0.4-0.7s,
fast zooms/moves. `"pace": "chill"` — roughly half the cut rate, gentler
moves. The rhythm runs client-side the whole time filming is on; explicit
tiktokcam steps in your script disable it (manual direction).

## Notes

- Response returns `{ ok, mp4 }` — the transcoded file path under data/clips.
- Output is 16:9 (the stage canvas); crop to 9:16 center in your editor —
  subtitles and RIKU are framed to survive it.
- The green walls in the studio are your keyable bg in studio mode too;
  swap-in backgrounds can be unhidden in the room model later.
- Cameras come from the room model (TiktokCameraFront/Left/Right), the
  standing mark from `tiktokstandingspot`. Re-export the glb, refresh the
  stage tab, and new framing applies.
