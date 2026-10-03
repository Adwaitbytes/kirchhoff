import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCredentials, sign, stringToSign, verifyHmac, type HmacCredentials } from "../src/hmac.ts";
import { API_KEY, SECRET_HEX, kethRequest, post, startHarness, type Harness } from "./helpers/harness.ts";

/**
 * Produced by chainlink-ccv's own Go signer, protocol/common/hmac.SignHTTPRequest @ d7b7b63,
 * for body {"schema_version":"v1","message_id":"0x01"} at t=1759580000000 ms.
 */
const GO_VECTORS = [
  { target: "/v1/evaluate", signature: "b3f0602aacdc1a75805b18d83e61669a05da44d352d389bee35c7bf00f5616a0" },
  { target: "/compliance/v1/evaluate?x=1", signature: "83c44d27c5fcabe2643767130547be155d3492b76f5fb599328abee450ebbe02" },
] as const;
const GO_SECRET = "6f1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5061728394a5b6c7d8e9f";
const GO_BODY = Buffer.from(`{"schema_version":"v1","message_id":"0x01"}`);
const GO_TS = 1759580000000;

describe("HMAC scheme", () => {
  const creds: HmacCredentials = parseCredentials(API_KEY, GO_SECRET);

  it.each(GO_VECTORS)("matches the chainlink-ccv Go signer for $target", ({ target, signature }) => {
    expect(sign(creds.secret, stringToSign(target, GO_BODY, API_KEY, String(GO_TS)))).toBe(signature);
    const headers = { authorization: API_KEY, "x-authorization-timestamp": String(GO_TS), "x-authorization-signature-sha256": signature };
    expect(verifyHmac(creds, target, GO_BODY, headers, GO_TS + 1000)).toEqual({ ok: true });
  });

  it("binds the request target, body, key and timestamp", () => {
    const [vector] = GO_VECTORS;
    const headers = { authorization: API_KEY, "x-authorization-timestamp": String(GO_TS), "x-authorization-signature-sha256": vector.signature };
    expect(verifyHmac(creds, "/other/v1/evaluate", GO_BODY, headers, GO_TS)).toEqual({ ok: false, failure: "bad_signature" });
    expect(verifyHmac(creds, vector.target, Buffer.from(`${GO_BODY.toString()} `), headers, GO_TS)).toEqual({ ok: false, failure: "bad_signature" });
    expect(verifyHmac(creds, vector.target, GO_BODY, { ...headers, "x-authorization-timestamp": String(GO_TS + 1) }, GO_TS)).toEqual({
      ok: false,
      failure: "bad_signature",
    });
    expect(verifyHmac(creds, vector.target, GO_BODY, { ...headers, authorization: "00000000-0000-0000-0000-000000000000" }, GO_TS)).toEqual({
      ok: false,
      failure: "unknown_api_key",
    });
  });

  it("enforces the 15 s window in both directions", () => {
    const [vector] = GO_VECTORS;
    const headers = { authorization: API_KEY, "x-authorization-timestamp": String(GO_TS), "x-authorization-signature-sha256": vector.signature };
    expect(verifyHmac(creds, vector.target, GO_BODY, headers, GO_TS + 15_000).ok).toBe(true);
    expect(verifyHmac(creds, vector.target, GO_BODY, headers, GO_TS - 15_000).ok).toBe(true);
    expect(verifyHmac(creds, vector.target, GO_BODY, headers, GO_TS + 15_001)).toEqual({ ok: false, failure: "stale_timestamp" });
    expect(verifyHmac(creds, vector.target, GO_BODY, headers, GO_TS - 15_001)).toEqual({ ok: false, failure: "stale_timestamp" });
  });

  it("rejects malformed headers", () => {
    const [vector] = GO_VECTORS;
    expect(verifyHmac(creds, vector.target, GO_BODY, {}, GO_TS)).toEqual({ ok: false, failure: "missing_headers" });
    expect(
      verifyHmac(creds, vector.target, GO_BODY, { authorization: API_KEY, "x-authorization-timestamp": "12.5", "x-authorization-signature-sha256": vector.signature }, GO_TS),
    ).toEqual({ ok: false, failure: "bad_timestamp" });
    expect(
      verifyHmac(creds, vector.target, GO_BODY, { authorization: [API_KEY, API_KEY], "x-authorization-timestamp": String(GO_TS), "x-authorization-signature-sha256": vector.signature }, GO_TS),
    ).toEqual({ ok: false, failure: "missing_headers" });
  });

  it("validates credentials like the Go ValidateSecret/ValidateAPIKey", () => {
    expect(() => parseCredentials("not-a-uuid", GO_SECRET)).toThrow(/UUID/);
    expect(() => parseCredentials(API_KEY, "zz")).toThrow(/hex/);
    expect(() => parseCredentials(API_KEY, "ab".repeat(31))).toThrow(/32 bytes/);
  });
});

describe("HMAC on the wire", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ auth: { mode: "hmac", creds: parseCredentials(API_KEY, SECRET_HEX) }, basePath: "/compliance" });
  });
  afterAll(async () => {
    await h.close();
  });

  const path = "/compliance/v1/evaluate";

  it("accepts a correctly signed request on a prefixed base URL", async () => {
    const res = await post(h.url, kethRequest(h.token), { path, sign: { apiKey: API_KEY, secretHex: SECRET_HEX } });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("PASS");
  });

  it.each([
    ["no auth headers", {}],
    ["wrong secret", { sign: { apiKey: API_KEY, secretHex: "b2".repeat(32) } }],
    ["unknown api key", { sign: { apiKey: "00000000-0000-4000-8000-000000000000", secretHex: SECRET_HEX } }],
    ["stale timestamp", { sign: { apiKey: API_KEY, secretHex: SECRET_HEX, tsMs: Date.now() - 16_000 } }],
    ["future timestamp", { sign: { apiKey: API_KEY, secretHex: SECRET_HEX, tsMs: Date.now() + 16_000 } }],
  ] as const)("answers 401 for %s", async (_name, options) => {
    const res = await post(h.url, kethRequest(h.token), { path, ...options });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  it("answers 401 when the body changes after signing", async () => {
    const body = JSON.stringify(kethRequest(h.token));
    const ts = String(Date.now());
    const signature = sign(Buffer.from(SECRET_HEX, "hex"), stringToSign(path, Buffer.from(body), API_KEY, ts));
    const tampered = body.replace('"10000000000000000000"', '"10000000000000000001"');
    const res = await fetch(`${h.url}${path}`, {
      method: "POST",
      headers: { authorization: API_KEY, "x-authorization-timestamp": ts, "x-authorization-signature-sha256": signature },
      body: tampered,
    });
    expect(res.status).toBe(401);
  });

  it("answers 401 when the signature covers a different path", async () => {
    const body = JSON.stringify(kethRequest(h.token));
    const ts = String(Date.now());
    const signature = sign(Buffer.from(SECRET_HEX, "hex"), stringToSign("/v1/evaluate", Buffer.from(body), API_KEY, ts));
    const res = await fetch(`${h.url}${path}`, {
      method: "POST",
      headers: { authorization: API_KEY, "x-authorization-timestamp": ts, "x-authorization-signature-sha256": signature },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("counts auth failures in /metrics", async () => {
    const text = await (await fetch(`${h.url}/metrics`)).text();
    expect(text).toMatch(/judge_auth_failures_total\{failure="bad_signature"\} [1-9]/);
    expect(text).toMatch(/judge_auth_failures_total\{failure="missing_headers"\} [1-9]/);
    expect(text).toMatch(/judge_auth_failures_total\{failure="stale_timestamp"\} [1-9]/);
  });
});
