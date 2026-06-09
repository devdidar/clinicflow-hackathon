import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const source = path.join(repoRoot, "frontend", "dist");
const target = path.join(repoRoot, "dist");

if (!fs.existsSync(source)) {
  throw new Error(`Frontend build output not found: ${source}`);
}

fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });

console.log(`Synced Vercel output: ${path.relative(repoRoot, source)} -> ${path.relative(repoRoot, target)}`);
