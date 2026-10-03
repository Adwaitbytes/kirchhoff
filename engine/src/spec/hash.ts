import { keccak256, stringToBytes } from "viem";
import type { Hex, TokenSpec } from "../types.ts";

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

function toJson(value: unknown): Json {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value !== null && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) out[key] = toJson((value as Record<string, unknown>)[key]);
    return out;
  }
  return value as Json;
}

/**
 * Canonical JSON: keys sorted at every level, no whitespace, bigints as
 * decimal strings. Two specs that mean the same thing serialize identically
 * however the YAML was formatted or which defaults were written out.
 */
export function canonicalJson(spec: TokenSpec): string {
  return JSON.stringify(toJson(spec));
}

/** The hash proposed in KirchhoffRegistry and compared by the Judge's spec cache. */
export function specHash(spec: TokenSpec): Hex {
  return keccak256(stringToBytes(canonicalJson(spec)));
}
