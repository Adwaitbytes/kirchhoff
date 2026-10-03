/**
 * HMAC-SHA256 verification exactly as chainlink-ccv signs policy hook calls
 * (protocol/common/hmac/http_auth.go SignHTTPRequest, docs/research/ccv.md section 2):
 *
 *   POST <request-target> <sha256-hex(raw body)> <api-key> <timestamp-ms>
 *
 * keyed by the hex-decoded shared secret, hex-encoded, compared in constant time,
 * with a 15 s clock window in either direction.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const HEADER_API_KEY = "authorization";
export const HEADER_TIMESTAMP = "x-authorization-timestamp";
export const HEADER_SIGNATURE = "x-authorization-signature-sha256";
export const TIME_WINDOW_MS = 15_000;
const MIN_SECRET_BYTES = 32;

export type HmacCredentials = { apiKey: string; secret: Buffer };

export type HmacFailure = "missing_headers" | "unknown_api_key" | "bad_timestamp" | "stale_timestamp" | "bad_signature";

export type HmacResult = { ok: true } | { ok: false; failure: HmacFailure };

/** Validates and decodes the credential pair at boot, with the same rules as the Go ValidateSecret/ValidateAPIKey. */
export function parseCredentials(apiKey: string, secretHex: string): HmacCredentials {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(apiKey)) {
    throw new Error("JUDGE_HMAC_API_KEY must be a UUID");
  }
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(secretHex)) throw new Error("JUDGE_HMAC_SECRET must be hex-encoded");
  const secret = Buffer.from(secretHex, "hex");
  if (secret.length < MIN_SECRET_BYTES) {
    throw new Error(`JUDGE_HMAC_SECRET must be at least ${MIN_SECRET_BYTES} bytes (${MIN_SECRET_BYTES * 2} hex chars)`);
  }
  return { apiKey, secret };
}

export function stringToSign(requestTarget: string, rawBody: Buffer, apiKey: string, timestamp: string): string {
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  return `POST ${requestTarget} ${bodyHash} ${apiKey} ${timestamp}`;
}

export function sign(secret: Buffer, toSign: string): string {
  return createHmac("sha256", secret).update(toSign).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

type HeaderValue = string | string[] | undefined;

function single(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

export function verifyHmac(
  creds: HmacCredentials,
  requestTarget: string,
  rawBody: Buffer,
  headers: Readonly<Record<string, HeaderValue>>,
  nowMs: number,
): HmacResult {
  const apiKey = single(headers[HEADER_API_KEY]);
  const timestamp = single(headers[HEADER_TIMESTAMP]);
  const signature = single(headers[HEADER_SIGNATURE]);
  if (apiKey === undefined || timestamp === undefined || signature === undefined) {
    return { ok: false, failure: "missing_headers" };
  }
  if (!constantTimeEqual(apiKey, creds.apiKey)) return { ok: false, failure: "unknown_api_key" };
  if (!/^\d{1,16}$/.test(timestamp)) return { ok: false, failure: "bad_timestamp" };
  if (Math.abs(nowMs - Number(timestamp)) > TIME_WINDOW_MS) return { ok: false, failure: "stale_timestamp" };
  const expected = sign(creds.secret, stringToSign(requestTarget, rawBody, apiKey, timestamp));
  if (!constantTimeEqual(expected, signature.toLowerCase())) return { ok: false, failure: "bad_signature" };
  return { ok: true };
}
