/**
 * JSON Schema (draft-07) for KIRCH-SPEC YAML, PRD section 6. Every field of the
 * PRD example is accepted verbatim; the optional extensions (`unit`,
 * `decimals`, `alias`, bridge `contracts`, event field maps, CCIP
 * `onramps` / `offramps` / `lockbox`, `max_delivery_seconds`,
 * `reserves.decimals`) carry what PRD section 10
 * requires but the example leaves implicit. `additionalProperties: false`
 * everywhere because a spec is hostile input until validated.
 */

export type RawFieldMap = {
  message_id: string;
  amount: string;
  recipient: string | null;
  remote_chain: string;
};

type RawBridgeCommon = {
  id: string;
  search_window_blocks?: number;
  max_delivery_seconds?: number;
};

export type RawCcipBridge = RawBridgeCommon & {
  kind: "ccip_v2";
  pools: Record<string, string>;
  onramps?: Record<string, string>;
  offramps?: Record<string, string>;
  lockbox?: string | null;
};

export type RawCustomBridge = RawBridgeCommon & {
  kind: "custom";
  contracts?: Record<string, string>;
  debit_event: string;
  credit_event: string;
  debit_fields?: RawFieldMap;
  credit_fields?: RawFieldMap;
};

export type RawSpec = {
  spec_version: 1;
  token: string;
  model: "lock_release_home" | "burn_mint_multi";
  unit?: "tokens" | "shares";
  home: { chain: string; canonical: string; escrow?: string | null; decimals?: number };
  remotes: { chain: string; token: string; minters: string[]; decimals?: number; alias?: string }[];
  bridges: (RawCcipBridge | RawCustomBridge)[];
  reserves?: { por_feed: string | null; decimals?: number };
  confidence: { default: "latest" | "safe" | "finalized"; overrides?: Record<string, "latest" | "safe" | "finalized"> };
  rules: {
    junction: { match_window_seconds: number };
    loop: { tolerance_wei: string; breach_confirmations: number };
    soft?: { flow_limit_per_hour?: string | null };
    staleness_seconds: number;
    on_stale: "fail_closed" | "fail_open";
  };
  response: {
    on_broken: ("freeze_ccip_lanes" | "taint_recipient" | "flip_feed" | "page_issuer")[];
    replay_requires: "issuer_multisig";
    recovery_timelock_seconds: number;
  };
};

const address = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } as const;
const amount = { type: "string", pattern: "^\\d+(\\.\\d+)?(e\\d+)?$" } as const;
const seconds = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const decimals = { type: "integer", minimum: 0, maximum: 77 } as const;
const identifier = { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" } as const;
const chainName = { type: "string", pattern: "^[a-z0-9-]{1,96}$" } as const;
const confidence = { enum: ["latest", "safe", "finalized"] } as const;
const eventSignature = { type: "string", minLength: 3, maxLength: 512 } as const;
const paramName = { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" } as const;
const addressMap = {
  type: "object",
  propertyNames: identifier,
  additionalProperties: address,
  maxProperties: 64,
} as const;

const fieldMap = {
  type: "object",
  additionalProperties: false,
  required: ["message_id", "amount", "recipient", "remote_chain"],
  properties: {
    message_id: paramName,
    amount: paramName,
    recipient: { anyOf: [paramName, { type: "null" }] },
    remote_chain: paramName,
  },
} as const;

const bridgeCommon = {
  id: identifier,
  search_window_blocks: seconds,
  max_delivery_seconds: seconds,
} as const;

export const KIRCH_SPEC_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://kirchhoff.xyz/schemas/kirch-spec-v1.json",
  title: "KIRCH-SPEC v1",
  type: "object",
  additionalProperties: false,
  required: ["spec_version", "token", "model", "home", "remotes", "bridges", "confidence", "rules", "response"],
  properties: {
    spec_version: { const: 1 },
    token: { type: "string", pattern: "^[A-Za-z0-9._-]{1,32}$" },
    model: { enum: ["lock_release_home", "burn_mint_multi"] },
    unit: { enum: ["tokens", "shares"] },
    home: {
      type: "object",
      additionalProperties: false,
      required: ["chain", "canonical"],
      properties: {
        chain: chainName,
        canonical: address,
        escrow: { anyOf: [address, { type: "null" }] },
        decimals,
      },
    },
    remotes: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["chain", "token", "minters"],
        properties: {
          chain: chainName,
          token: address,
          minters: { type: "array", items: identifier, uniqueItems: true, maxItems: 64 },
          decimals,
          alias: identifier,
        },
      },
    },
    bridges: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["id", "kind", "pools"],
            // Event ABIs are fixed by CCIP 2.0.0 (docs/research/ccip.md); the spec only names contracts.
            properties: {
              ...bridgeCommon,
              kind: { const: "ccip_v2" },
              pools: addressMap,
              onramps: addressMap,
              offramps: addressMap,
              lockbox: { anyOf: [address, { type: "null" }] },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["id", "kind", "debit_event", "credit_event"],
            properties: {
              ...bridgeCommon,
              kind: { const: "custom" },
              contracts: addressMap,
              debit_event: eventSignature,
              credit_event: eventSignature,
              debit_fields: fieldMap,
              credit_fields: fieldMap,
            },
          },
        ],
      },
    },
    reserves: {
      type: "object",
      additionalProperties: false,
      required: ["por_feed"],
      properties: { por_feed: { anyOf: [address, { type: "null" }] }, decimals },
    },
    confidence: {
      type: "object",
      additionalProperties: false,
      required: ["default"],
      properties: {
        default: confidence,
        overrides: { type: "object", propertyNames: chainName, additionalProperties: confidence },
      },
    },
    rules: {
      type: "object",
      additionalProperties: false,
      required: ["junction", "loop", "staleness_seconds", "on_stale"],
      properties: {
        junction: {
          type: "object",
          additionalProperties: false,
          required: ["match_window_seconds"],
          properties: { match_window_seconds: seconds },
        },
        loop: {
          type: "object",
          additionalProperties: false,
          required: ["tolerance_wei", "breach_confirmations"],
          properties: {
            tolerance_wei: amount,
            breach_confirmations: { type: "integer", minimum: 1, maximum: 1000 },
          },
        },
        soft: {
          type: "object",
          additionalProperties: false,
          properties: { flow_limit_per_hour: { anyOf: [amount, { type: "null" }] } },
        },
        staleness_seconds: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        on_stale: { enum: ["fail_closed", "fail_open"] },
      },
    },
    response: {
      type: "object",
      additionalProperties: false,
      required: ["on_broken", "replay_requires", "recovery_timelock_seconds"],
      properties: {
        on_broken: {
          type: "array",
          uniqueItems: true,
          items: { enum: ["freeze_ccip_lanes", "taint_recipient", "flip_feed", "page_issuer"] },
        },
        replay_requires: { const: "issuer_multisig" },
        recovery_timelock_seconds: seconds,
      },
    },
  },
} as const;
