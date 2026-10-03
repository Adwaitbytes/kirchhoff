import { readFileSync } from "node:fs";
import type { Hex } from "@kirchhoff/engine";

/** Reads KEY=VALUE lines of the repo .env (no interpolation, no quotes), the same file `cre -e ../.env` loads. */
export function loadEnv(path: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    env.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return env;
}

export function required(env: ReadonlyMap<string, string>, key: string): string {
  const value = env.get(key);
  if (value === undefined || value === "") throw new Error(`${key} is not set in .env`);
  return value;
}

/** Private keys in .env are stored with or without 0x. */
export function privateKey(env: ReadonlyMap<string, string>, key: string): Hex {
  const value = required(env, key);
  const hex = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${key} is not a 32-byte private key`);
  return hex as Hex;
}
