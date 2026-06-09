import fs from "node:fs";
import path from "node:path";

const source = path.join(process.cwd(), "frontend", "dist");
const target = path.join(process.cwd(), "dist");

if (!fs.existsSync(source)) {
  throw new Error(`Frontend build output not found: ${source}`);
}

fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });

console.log(`Synced Vercel output: ${path.relative(process.cwd(), source)} -> ${path.relative(process.cwd(), target)}`);
