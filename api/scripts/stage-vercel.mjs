// Stages a self-contained Vercel project in .vercel-stage/: the esbuild bundle (no install needed),
// vercel.json (region sin1) and a minimal package.json. Deploy with: cd .vercel-stage && vercel deploy --prod
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, ".vercel-stage");
mkdirSync(join(stage, "api"), { recursive: true });
copyFileSync(join(root, "api", "index.mjs"), join(stage, "api", "index.mjs"));
const config = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
delete config.installCommand;
config.buildCommand = "";
config.installCommand = "";
config.framework = null;
writeFileSync(join(stage, "vercel.json"), `${JSON.stringify(config, null, 2)}\n`);
writeFileSync(join(stage, "package.json"), `${JSON.stringify({ name: "kirchhoff-api", private: true, type: "module", engines: { node: "22.x" } }, null, 2)}\n`);
process.stderr.write(`staged ${stage}\n`);
