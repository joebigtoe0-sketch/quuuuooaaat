import path from "node:path";
import fs from "node:fs";
import express from "express";
import { cfg } from "./config.js";
import { log } from "./log.js";
import { wardrobe } from "./wardrobe.js";

/**
 * STANDALONE wardrobe — the dress-up / part-library tool ONLY. Boots just the
 * static files + wardrobe routes (Blender rebuild on save), NONE of the show
 * (no director, chain, feeds, brain, TTS, pump chat). Run it to fiddle with the
 * character and export looks without spinning up the whole system:
 *   cd server && npx tsx src/wardrobe-server.ts   (or use start-wardrobe.bat)
 * Then open http://127.0.0.1:8490/wardrobe  (build the client once first).
 */
const app = express();
app.use(express.json({ limit: "5mb" }));

const root = path.resolve(cfg.root, "..");
app.use(express.static(path.join(root, "client", "dist")));
app.use(express.static(path.join(root, "client", "public")));
app.use("/sidekick-raw", express.static(path.join(root, "sidekick", "raw"), { maxAge: "1h" }));
app.use(wardrobe);

app.get("/", (_req, res) => res.redirect("/wardrobe"));
app.get("/wardrobe", (_req, res) => {
  const f = path.join(root, "client", "dist", "wardrobe.html");
  if (fs.existsSync(f)) res.sendFile(f);
  else res.status(200).send("wardrobe not built — run:  npm run build -w client");
});

const port = Number(process.env.WARDROBE_PORT ?? 8490);
app.listen(port, "127.0.0.1", () => {
  log.info("wardrobe", `standalone wardrobe on http://127.0.0.1:${port}/wardrobe`);
  log.info("wardrobe", `(no show running — just the dress-up tool)`);
});
