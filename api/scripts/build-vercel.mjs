// Bundles the serverless entry (src/vercel.ts) into api/index.mjs for Vercel's Node runtime.
// Workspace packages are TypeScript sources, so they are bundled rather than resolved at runtime.
import process from "node:process";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await build({
  entryPoints: [join(root, "src", "vercel.ts")],
  outfile: join(root, "api", "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  legalComments: "none",
  external: ["pg-native"],
  banner: { js: "import { createRequire as __kirchhoffRequire } from 'node:module'; const require = __kirchhoffRequire(import.meta.url);" },
  logLevel: "warning",
});
process.stderr.write("built api/index.mjs\n");
