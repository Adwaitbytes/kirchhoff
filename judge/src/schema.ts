/**
 * The chainlink-ccv policy hook contract (openapi/policy_hook_openapi_v1.yaml, copied byte-for-byte
 * from smartcontractkit/chainlink-ccv @ d7b7b63). The YAML is the source of truth: request
 * validation compiles its component schemas at boot, and test/schema.test.ts checks these
 * hand-written types against the same document.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { parse } from "yaml";

export const OPENAPI_PATH = fileURLToPath(new URL("../openapi/policy_hook_openapi_v1.yaml", import.meta.url));

export type Finality = { mode: "blockDepth" | "finalized"; block_depth: number; safe: boolean };

export type TokenTransfer = {
  version: number;
  amount: string;
  source_pool_address: string;
  source_token_address: string;
  dest_token_address: string;
  token_receiver: string;
  extra_data: string;
};

export type Message = {
  version: number;
  source_chain_selector: string;
  dest_chain_selector: string;
  sequence_number: number;
  on_ramp_address: string;
  off_ramp_address: string;
  sender: string;
  receiver: string;
  data: string;
  dest_blob: string;
  execution_gas_limit: number;
  ccip_receive_gas_limit: number;
  finality: Finality;
  ccv_and_executor_hash: string;
  token_transfer?: TokenTransfer;
};

export type EvaluateRequest = {
  schema_version: "v1";
  verifier_id: string;
  message_id: string;
  source_tx_hash: string;
  source_block_number: number;
  source_block_timestamp?: string;
  fee_token?: string;
  fee_token_amount?: string;
  finalized_block_number: number;
  block_depth: number;
  message: Message;
};

/** HOLD is in the spec enum but reserved; the Judge never returns it. */
export type EvaluateResponse = { decision: "PASS" | "FAIL"; message_id?: string; reason?: string };

type OpenApiDoc = { components: { schemas: Record<string, unknown> } };

const INT32 = { min: -(2 ** 31), max: 2 ** 31 - 1 };

/** Rewrites OpenAPI `#/components/schemas/X` refs to JSON Schema `#/definitions/X`. */
function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] =
        key === "$ref" && typeof value === "string"
          ? value.replace("#/components/schemas/", "#/definitions/")
          : rewriteRefs(value);
    }
    return out;
  }
  return node;
}

export function loadOpenApi(path = OPENAPI_PATH): OpenApiDoc {
  return parse(readFileSync(path, "utf8")) as OpenApiDoc;
}

export type PolicyHookValidators = {
  request: ValidateFunction<EvaluateRequest>;
  response: ValidateFunction<EvaluateResponse>;
};

/** Strict Ajv over the spec's component schemas, with the OpenAPI formats it uses. */
export function compileValidators(doc: OpenApiDoc = loadOpenApi()): PolicyHookValidators {
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv, ["date-time"]);
  ajv.addKeyword("example");
  ajv.addFormat("int32", {
    type: "number",
    validate: (n: number) => Number.isInteger(n) && n >= INT32.min && n <= INT32.max,
  });
  ajv.addFormat("int64", { type: "number", validate: (n: number) => Number.isSafeInteger(n) });
  ajv.addSchema({ $id: "policy_hook_openapi_v1", definitions: rewriteRefs(doc.components.schemas) });
  const get = <T>(name: string): ValidateFunction<T> => {
    const fn = ajv.getSchema<T>(`policy_hook_openapi_v1#/definitions/${name}`);
    if (fn === undefined) throw new Error(`OpenAPI schema ${name} is missing`);
    return fn;
  };
  return { request: get<EvaluateRequest>("EvaluateRequest"), response: get<EvaluateResponse>("EvaluateResponse") };
}

export function describeSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  if (errors == null || errors.length === 0) return "invalid";
  return errors
    .slice(0, 5)
    .map((e) => `${e.instancePath === "" ? "/" : e.instancePath} ${e.message ?? "invalid"}`)
    .join("; ");
}
