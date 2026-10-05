import { CHAIN_KEYS, type Address, type Bytes32, type ChainKey } from "@kirchhoff/sdk";
import { badRequest } from "./errors.ts";

/** Boundary validation for untrusted request input. Each helper throws a 400 naming the field. */

export type Obj = Record<string, unknown>;

export function object(v: unknown, field = "body"): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw badRequest(`${field} must be a JSON object`);
  return v as Obj;
}

export function str(v: unknown, field: string, opts: { max?: number; min?: number; pattern?: RegExp } = {}): string {
  if (typeof v !== "string") throw badRequest(`${field} must be a string`);
  if (v.length < (opts.min ?? 0)) throw badRequest(`${field} is too short`);
  if (v.length > (opts.max ?? 10_000)) throw badRequest(`${field} is too long`);
  if (opts.pattern && !opts.pattern.test(v)) throw badRequest(`${field} has an invalid format`);
  return v;
}

export function chainKey(v: unknown, field: string): ChainKey {
  if (typeof v === "string" && (CHAIN_KEYS as readonly string[]).includes(v)) return v as ChainKey;
  throw badRequest(`${field} must be one of ${CHAIN_KEYS.join(", ")}`);
}

export function address(v: unknown, field: string): Address {
  return str(v, field, { pattern: /^0x[0-9a-fA-F]{40}$/ }).toLowerCase() as Address;
}

export function bytes32(v: unknown, field: string): Bytes32 {
  return str(v, field, { pattern: /^0x[0-9a-fA-F]{64}$/ }).toLowerCase() as Bytes32;
}

/** Base-unit decimal string, no sign, no exponent, at most uint256. */
export function wei(v: unknown, field: string): bigint {
  const s = str(v, field, { pattern: /^\d{1,78}$/ });
  const n = BigInt(s);
  if (n >= 2n ** 256n) throw badRequest(`${field} exceeds uint256`);
  return n;
}

export function tokenSymbol(v: unknown, field = "token"): string {
  return str(v, field, { pattern: /^[A-Za-z0-9]{1,16}$/ });
}

export function intInRange(v: unknown, field: string, min: number, max: number, fallback: number): number {
  if (v === undefined || v === null || v === "") return fallback;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw badRequest(`${field} must be an integer ${min}..${max}`);
  return n;
}

export function isoTime(v: unknown, field: string): Date | null {
  if (v === undefined || v === null || v === "") return null;
  const s = str(v, field, { max: 40 });
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw badRequest(`${field} must be an ISO-8601 timestamp`);
  return new Date(t);
}

/** Opaque pagination cursor: base64url of a small JSON tuple. */
export function encodeCursor(parts: readonly (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

export function decodeCursor(v: unknown, arity: number): (string | number)[] | null {
  if (v === undefined || v === null || v === "") return null;
  const s = str(v, "cursor", { max: 400, pattern: /^[A-Za-z0-9_-]+$/ });
  try {
    const parsed: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === arity && parsed.every((p) => typeof p === "string" || typeof p === "number")) return parsed;
  } catch {
    // fall through to the 400 below
  }
  throw badRequest("cursor is invalid");
}
