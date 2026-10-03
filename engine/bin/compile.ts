/**
 * Spec compiler CLI (PRD section 8): the only way workflow config is produced.
 *
 *   pnpm --filter @kirchhoff/engine compile <spec.yaml> <deployments.json> <outDir> [target]
 *
 * Writes <outDir>/<workflow>/config.<target>.json for all four workflows
 * (target defaults to "staging") plus <outDir>/spec.resolved.json.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { compileSpecDocuments } from "../src/spec/compile-files.ts";

const [specPath, deploymentsPath, outDir, target = "staging"] = process.argv.slice(2);

if (specPath === undefined || deploymentsPath === undefined || outDir === undefined) {
  process.stderr.write("usage: compile <spec.yaml> <deployments.json> <outDir> [target]\n");
  process.exit(2);
}

const result = await compileSpecDocuments(
  await readFile(resolve(specPath), "utf8"),
  await readFile(resolve(deploymentsPath), "utf8"),
  target,
);

for (const line of result.warnings) process.stderr.write(`warning: ${line}\n`);
if (!result.ok) {
  for (const line of result.errors) process.stderr.write(`error: ${line}\n`);
  process.exit(1);
}
for (const [relative, content] of Object.entries(result.files)) {
  const path = join(resolve(outDir), relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  process.stdout.write(`wrote ${path}\n`);
}
