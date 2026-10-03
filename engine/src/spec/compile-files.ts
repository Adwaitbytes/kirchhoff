import Ajv from "ajv";
import { compileWorkflows, resolveSpec, type Deployments, type WorkflowName } from "../compile.ts";
import { toSpecJson } from "../spec-json.ts";
import { describeError } from "../types.ts";
import { specHash } from "./hash.ts";
import { parseSpec, schemaErrors } from "./parse.ts";
import { validateSpec } from "./validate.ts";

const address = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } as const;

export const DEPLOYMENTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["network", "chains"],
  properties: {
    network: { type: "string", minLength: 1 },
    chains: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["chainId", "ledger", "quarantine", "feed", "tokens"],
        properties: {
          chainId: { type: "integer", minimum: 1 },
          ledger: address,
          quarantine: address,
          feed: address,
          registry: address,
          ccip: {
            type: "object",
            additionalProperties: false,
            required: ["onRamp", "offRamp"],
            properties: { onRamp: address, offRamp: address },
          },
          tokens: {
            type: "object",
            additionalProperties: {
              type: "object",
              additionalProperties: false,
              required: ["token"],
              properties: {
                token: address,
                escrow: address,
                lockbox: address,
                bridges: { type: "object", additionalProperties: address },
              },
            },
          },
        },
      },
    },
  },
} as const;

const validateDeployments = new Ajv({ allErrors: true, strict: true }).compile<Deployments>(DEPLOYMENTS_SCHEMA);

export const WORKFLOWS: readonly WorkflowName[] = ["w1-junction", "w2-loop", "w3-responder", "w4-topology"];

export type CompiledFiles =
  | { ok: true; files: Record<string, string>; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/** Stable, reviewable JSON: two-space indent and a trailing newline. Configs hold no bigints by construction. */
function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Spec YAML plus deployments JSON in, workflow config files out (paths
 * relative to the output directory). All IO stays in bin/compile.ts.
 */
export async function compileSpecDocuments(
  specYaml: string,
  deploymentsJson: string,
  target: string,
): Promise<CompiledFiles> {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(target)) return { ok: false, errors: [`invalid target "${target}"`], warnings: [] };
  const parsed = parseSpec(specYaml);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: [] };

  let deployments: unknown;
  try {
    deployments = JSON.parse(deploymentsJson);
  } catch (e) {
    return { ok: false, errors: [`deployments: ${describeError(e)}`], warnings: [] };
  }
  if (!validateDeployments(deployments)) {
    return { ok: false, errors: schemaErrors(validateDeployments.errors, "deployments"), warnings: [] };
  }

  const { spec, errors } = resolveSpec(parsed.spec, deployments);
  const resolved = await validateSpec(spec);
  if (errors.length > 0 || !resolved.ok) {
    return { ok: false, errors: [...errors, ...resolved.errors], warnings: resolved.warnings };
  }
  // Hash the resolved spec: that is the document the registry and the Judge's cache hold.
  const hash = specHash(spec);
  const compiled = compileWorkflows(spec, deployments, hash);
  if (!compiled.ok) return { ok: false, errors: compiled.errors, warnings: [] };

  const files: Record<string, string> = { "spec.resolved.json": pretty({ specHash: hash, spec: toSpecJson(compiled.spec) }) };
  for (const name of WORKFLOWS) files[`${name}/config.${target}.json`] = pretty(compiled.configs[name]);
  return { ok: true, files, warnings: [...resolved.warnings, ...compiled.warnings] };
}
