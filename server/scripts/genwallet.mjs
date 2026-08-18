import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
const out = process.argv[2] || path.resolve("server/data/wallet.json");
if (fs.existsSync(out)) { console.error("refusing to overwrite", out); process.exit(1); }
const kp = Keypair.generate();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ publicKey: kp.publicKey.toBase58(), secretKey: Array.from(kp.secretKey), createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
console.log("Quant wallet:", kp.publicKey.toBase58());
console.log("written to", out);
