import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEMO_ROOT = join(REPO_ROOT, "demo");
export const CONTRACTS_ROOT = join(REPO_ROOT, "contracts");
export const DEPLOYMENTS_DIR = join(REPO_ROOT, "deployments");

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Parses KEY=VALUE lines (no interpolation); `export` prefixes and surrounding quotes are tolerated. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0] ?? "")) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

let cached: Record<string, string> | undefined;

/**
 * Repo-root .env merged under the real environment (process env wins). Values are never logged.
 * KIRCHHOFF_DOTENV points at another file, or `none` to read no file at all (what a clean clone or CI sees).
 */
export function env(): Record<string, string> {
  if (cached !== undefined) return cached;
  const override = process.env.KIRCHHOFF_DOTENV;
  const path = override === undefined || override === "" ? join(REPO_ROOT, ".env") : override;
  const file = override !== "none" && existsSync(path) ? parseDotEnv(readFileSync(path, "utf8")) : {};
  const merged: Record<string, string> = { ...file };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && v !== "") merged[k] = v;
  cached = merged;
  return merged;
}

export function required(name: string): string {
  const value = env()[name];
  if (value === undefined || value === "") throw new ConfigError(`${name} is not set (repo .env)`);
  return value;
}

export function optional(name: string): string | undefined {
  const value = env()[name];
  return value === undefined || value === "" ? undefined : value;
}

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/** A 32-byte hex private key; the error names the variable, never the value. */
export function privateKey(name: string): Hex {
  const raw = required(name);
  const value = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!PRIVATE_KEY.test(value)) throw new ConfigError(`${name} is not a 32-byte hex private key`);
  return value as Hex;
}
