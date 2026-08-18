import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import express from "express";
import { cfg } from "./config.js";
import { log } from "./log.js";

/**
 * The wardrobe backend: scans the (gitignored) Sidekick part library, saves
 * outfit configs, and rebuilds SK_Quant.glb via headless Blender on apply.
 */
const SIDEKICK = path.resolve(cfg.root, "..", "sidekick");
const RAW = path.join(SIDEKICK, "raw");
const CONFIG = path.join(SIDEKICK, "wardrobe.json");
const BLENDER = process.env.BLENDER_PATH || "C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe";

export const wardrobe = express.Router();

let applyState: { running: boolean; ok?: boolean; note?: string; at: number } = { running: false, at: 0 };

/** Everything wearable, grouped by slot code, plus texture variants per pack. */
wardrobe.get("/wardrobe/manifest", (_req, res) => {
  try {
    const slots: Record<string, { path: string; pack: string; id: string }[]> = {};
    const scanDir = (dir: string, pack: string) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".fbx")) continue;
        const m = f.match(/_(\d{2}[A-Z]{4})_/);
        if (!m) continue;
        const slot = m[1];
        (slots[slot] ??= []).push({
          path: path.relative(RAW, path.join(dir, f)).replace(/\\/g, "/"),
          pack,
          id: f.replace(".fbx", ""),
        });
      }
    };
    const outfits = path.join(RAW, "Resources", "Meshes", "Outfits");
    for (const pack of fs.existsSync(outfits) ? fs.readdirSync(outfits) : [])
      scanDir(path.join(outfits, pack), pack);
    scanDir(path.join(RAW, "Resources", "Meshes", "Species", "Humans"), "HumanBase");

    // texture variants: Characters/<group>/<variant>/Textures/*ColorMap.png
    const textures: Record<string, { id: string; path: string }[]> = {};
    const chars = path.join(RAW, "Characters");
    for (const group of fs.existsSync(chars) ? fs.readdirSync(chars) : []) {
      const gdir = path.join(chars, group);
      if (!fs.statSync(gdir).isDirectory()) continue;
      for (const variant of fs.readdirSync(gdir)) {
        const tdir = path.join(gdir, variant, "Textures");
        if (!fs.existsSync(tdir)) continue;
        for (const t of fs.readdirSync(tdir)) {
          if (!/ColorMap\.png$/i.test(t)) continue;
          (textures[group] ??= []).push({
            id: variant,
            path: path.relative(RAW, path.join(tdir, t)).replace(/\\/g, "/"),
          });
        }
      }
    }
    // pose-able animations for the preview: the ORIGINAL Synty FBX clips (same
    // rig conventions as the part FBXes — GLB-baked clips would face-plant him)
    const animDir = path.join(RAW, "Anims");
    const anims = (fs.existsSync(animDir) ? fs.readdirSync(animDir) : [])
      .filter((f) => /^A_MOD_(EMOT|IDL)_.*_Masc\.fbx$/.test(f) || /^A_MOD_BL_Idle_Standing_Masc\.fbx$/.test(f))
      .sort();

    const saved = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, "utf8")) : null;
    res.json({ slots, textures, anims, saved });
  } catch (e) {
    res.status(500).json({ err: String(e).slice(0, 300) });
  }
});

/** Save the outfit and rebuild the live character (headless Blender). */
wardrobe.post("/wardrobe/save", (req, res) => {
  const conf = req.body;
  if (!conf || typeof conf !== "object" || !conf.parts)
    return res.status(400).json({ err: "body must be the wardrobe config {parts, textures, skin}" });
  if (applyState.running) return res.status(409).json({ err: "an apply is already running" });
  fs.writeFileSync(CONFIG, JSON.stringify(conf, null, 2));
  applyState = { running: true, at: Date.now() };
  const script = path.join(SIDEKICK, "assemble_config.py");
  const child = spawn(BLENDER, ["--background", "--python", script], { cwd: SIDEKICK });
  let outBuf = "";
  child.stdout.on("data", (d) => (outBuf += String(d)));
  child.stderr.on("data", (d) => (outBuf += String(d)));
  child.on("close", (code) => {
    const ok = code === 0 && /\[assemble\] exported/.test(outBuf);
    applyState = { running: false, ok, note: ok ? "applied — refresh the stage" : outBuf.slice(-400), at: Date.now() };
    log[ok ? "info" : "warn"]("wardrobe", ok ? "new outfit applied to SK_Quant.glb" : `apply FAILED: ${outBuf.slice(-200)}`);
  });
  res.json({ saved: true, applying: true });
});

wardrobe.get("/wardrobe/status", (_req, res) => res.json(applyState));
