import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OPENAPI_PATH, compileValidators, loadOpenApi, type EvaluateRequest } from "../src/schema.ts";
import { MAX_REASON_CHARS } from "../src/server.ts";

const doc = loadOpenApi() as unknown as {
  openapi: string;
  info: { version: string };
  paths: Record<string, Record<string, { operationId: string }>>;
  components: { schemas: Record<string, { required?: string[]; properties: Record<string, unknown> }> };
};
const validators = compileValidators();
const FIXTURES = fileURLToPath(new URL("./fixtures/crafted/", import.meta.url));

/** Keys of a hand-written type, spelled out so the compiler checks them against the type. */
const REQUEST_KEYS = [
  "schema_version",
  "verifier_id",
  "message_id",
  "source_tx_hash",
  "source_block_number",
  "source_block_timestamp",
  "fee_token",
  "fee_token_amount",
  "finalized_block_number",
  "block_depth",
  "message",
] as const satisfies readonly (keyof EvaluateRequest)[];
const MESSAGE_KEYS = [
  "version",
  "source_chain_selector",
  "dest_chain_selector",
  "sequence_number",
  "on_ramp_address",
  "off_ramp_address",
  "sender",
  "receiver",
  "data",
  "dest_blob",
  "execution_gas_limit",
  "ccip_receive_gas_limit",
  "finality",
  "ccv_and_executor_hash",
  "token_transfer",
] as const satisfies readonly (keyof EvaluateRequest["message"])[];

describe("OpenAPI v1 policy hook spec", () => {
  it("is the verbatim chainlink-ccv file (single operation, v1.0.0)", () => {
    expect(OPENAPI_PATH).toMatch(/policy_hook_openapi_v1\.yaml$/);
    expect(doc.openapi).toBe("3.0.3");
    expect(doc.info.version).toBe("1.0.0");
    expect(Object.keys(doc.paths)).toEqual(["/v1/evaluate"]);
    expect(doc.paths["/v1/evaluate"]?.post?.operationId).toBe("policy-evaluate");
  });

  it("matches the hand-written request types field for field", () => {
    expect([...REQUEST_KEYS].sort()).toEqual(Object.keys(doc.components.schemas.EvaluateRequest?.properties ?? {}).sort());
    expect([...MESSAGE_KEYS].sort()).toEqual(Object.keys(doc.components.schemas.Message?.properties ?? {}).sort());
  });

  it("only allows the decisions the Judge may send: PASS and FAIL, never HOLD", () => {
    expect(validators.response({ decision: "PASS" })).toBe(true);
    expect(validators.response({ decision: "FAIL", reason: "x".repeat(MAX_REASON_CHARS), message_id: "0x01" })).toBe(true);
    expect(validators.response({ reason: "missing decision" })).toBe(false);
    expect(validators.response({ decision: "pass" })).toBe(false);
  });
});

describe("crafted fixtures (from the spec examples)", () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));

  it("exist", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it.each(files)("%s validates against EvaluateRequest", (file) => {
    const body: unknown = JSON.parse(readFileSync(`${FIXTURES}${file}`, "utf8"));
    expect(validators.request(body), JSON.stringify(validators.request.errors)).toBe(true);
  });

  it("rejects what the spec forbids", () => {
    const base = JSON.parse(readFileSync(`${FIXTURES}spec-example-token-transfer.json`, "utf8")) as Record<string, unknown>;
    const message = base.message as Record<string, unknown>;
    const variants: [string, unknown][] = [
      ["schema_version v2", { ...base, schema_version: "v2" }],
      ["negative block_depth", { ...base, block_depth: -1 }],
      ["numeric selector", { ...base, message: { ...message, dest_chain_selector: 1 } }],
      ["hex selector", { ...base, message: { ...message, dest_chain_selector: "0x01" } }],
      ["finality mode", { ...base, message: { ...message, finality: { mode: "safe", block_depth: 0, safe: true } } }],
      ["finality depth > 65535", { ...base, message: { ...message, finality: { mode: "blockDepth", block_depth: 65536, safe: false } } }],
      ["bad timestamp", { ...base, source_block_timestamp: "yesterday" }],
      ["fee amount not decimal", { ...base, fee_token_amount: "-1" }],
    ];
    for (const [name, body] of variants) expect(validators.request(body), name).toBe(false);
  });
});
