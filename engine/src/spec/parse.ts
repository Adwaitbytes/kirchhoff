import Ajv, { type ErrorObject } from "ajv";
import { parse as parseYaml } from "yaml";
import { knownChainByName } from "../chains.ts";
import { tokenId } from "../encoding.ts";
import { WEAKBRIDGE_EVENTS } from "../adapters/weakbridge.ts";
import { parseAmount } from "../units.ts";
import { describeError, type BridgeEvents, type BridgeSpec, type ChainRef, type EventFieldMap, type Hex, type TokenSpec } from "../types.ts";
import { KIRCH_SPEC_SCHEMA, type RawCcipBridge, type RawCustomBridge, type RawFieldMap, type RawSpec } from "./schema.ts";

export type SpecParseResult = { ok: true; spec: TokenSpec; raw: RawSpec } | { ok: false; errors: string[] };

const ajv = new Ajv({ allErrors: true, strict: true });
const validateRaw = ajv.compile<RawSpec>(KIRCH_SPEC_SCHEMA);

const DEFAULT_DECIMALS = 18;
/** CRE caps filterLogs at 100 blocks per query (docs/research/cre.md). */
const DEFAULT_SEARCH_WINDOW_BLOCKS = 100;
/** Spec documents are small; refuse anything large enough to be an attack on the parser. */
const MAX_SPEC_BYTES = 256 * 1024;

/** One line per schema violation, e.g. `spec/remotes/0/token must match pattern ...`. */
export function schemaErrors(errors: ErrorObject[] | null | undefined, dataVar = "spec"): string[] {
  return ajv.errorsText(errors, { dataVar, separator: "\n" }).split("\n");
}

function toFields(raw: RawFieldMap): EventFieldMap {
  return { messageId: raw.message_id, amount: raw.amount, recipient: raw.recipient, remoteChain: raw.remote_chain };
}

function customEvents(raw: RawCustomBridge): BridgeEvents {
  return {
    debitEvent: raw.debit_event,
    creditEvent: raw.credit_event,
    // Custom bridges default to the WeakBridge parameter names, the only custom bridge PRD section 10 defines.
    debitFields: raw.debit_fields === undefined ? WEAKBRIDGE_EVENTS.debitFields : toFields(raw.debit_fields),
    creditFields: raw.credit_fields === undefined ? WEAKBRIDGE_EVENTS.creditFields : toFields(raw.credit_fields),
  };
}

function toBridge(raw: RawCcipBridge | RawCustomBridge, matchWindowSeconds: number): BridgeSpec {
  const common = {
    id: raw.id,
    searchWindowBlocks: BigInt(raw.search_window_blocks ?? DEFAULT_SEARCH_WINDOW_BLOCKS),
    maxDeliverySeconds: raw.max_delivery_seconds ?? matchWindowSeconds,
  };
  if (raw.kind === "ccip_v2") {
    return {
      ...common,
      kind: "ccip_v2",
      pools: raw.pools as Record<string, Hex>,
      onramps: (raw.onramps ?? {}) as Record<string, Hex>,
      offramps: (raw.offramps ?? {}) as Record<string, Hex>,
      lockbox: (raw.lockbox ?? null) as Hex | null,
    };
  }
  return { ...common, kind: "custom", contracts: (raw.contracts ?? {}) as Record<string, Hex>, events: customEvents(raw) };
}

function resolveChain(name: string, alias: string | undefined, fallbackAlias: string | null, errors: string[]): ChainRef {
  const known = knownChainByName(name);
  if (known === undefined) {
    errors.push(`unknown chain "${name}": no CCIP selector registered for it`);
    return { name, selector: 0n, alias: alias ?? name };
  }
  return { name, selector: known.selector, alias: alias ?? fallbackAlias ?? known.defaultAlias };
}

/** Converts a schema-valid raw document into the typed TokenSpec. */
export function normalizeSpec(raw: RawSpec): SpecParseResult {
  const errors: string[] = [];
  const amountOf = (text: string, field: string): bigint => {
    try {
      return parseAmount(text);
    } catch (e) {
      errors.push(`${field}: ${describeError(e)}`);
      return 0n;
    }
  };
  const flowLimit = raw.rules.soft?.flow_limit_per_hour;
  const spec: TokenSpec = {
    specVersion: 1,
    token: raw.token,
    tokenId: tokenId(raw.token),
    model: raw.model,
    unit: raw.unit ?? "tokens",
    home: {
      chain: resolveChain(raw.home.chain, undefined, "home", errors),
      canonical: raw.home.canonical as Hex,
      escrow: (raw.home.escrow ?? null) as Hex | null,
      decimals: raw.home.decimals ?? DEFAULT_DECIMALS,
    },
    remotes: raw.remotes.map((r) => ({
      chain: resolveChain(r.chain, r.alias, null, errors),
      token: r.token as Hex,
      minters: r.minters,
      decimals: r.decimals ?? DEFAULT_DECIMALS,
    })),
    bridges: raw.bridges.map((b) => toBridge(b, raw.rules.junction.match_window_seconds)),
    reserves: {
      porFeed: (raw.reserves?.por_feed ?? null) as Hex | null,
      decimals: raw.reserves?.decimals ?? raw.home.decimals ?? DEFAULT_DECIMALS,
    },
    confidence: { default: raw.confidence.default, overrides: raw.confidence.overrides ?? {} },
    rules: {
      junction: { matchWindowSeconds: BigInt(raw.rules.junction.match_window_seconds) },
      loop: {
        toleranceWei: amountOf(raw.rules.loop.tolerance_wei, "rules.loop.tolerance_wei"),
        breachConfirmations: raw.rules.loop.breach_confirmations,
      },
      soft: {
        flowLimitPerHour:
          flowLimit === undefined || flowLimit === null ? null : amountOf(flowLimit, "rules.soft.flow_limit_per_hour"),
      },
      stalenessSeconds: BigInt(raw.rules.staleness_seconds),
      onStale: raw.rules.on_stale,
    },
    response: {
      onBroken: raw.response.on_broken,
      replayRequires: raw.response.replay_requires,
      recoveryTimelockSeconds: BigInt(raw.response.recovery_timelock_seconds),
    },
  };
  return errors.length > 0 ? { ok: false, errors } : { ok: true, spec, raw };
}

/** Parses KIRCH-SPEC YAML, validates it against the JSON Schema and normalizes it. */
export function parseSpec(yamlText: string): SpecParseResult {
  if (yamlText.length > MAX_SPEC_BYTES) return { ok: false, errors: [`spec exceeds ${MAX_SPEC_BYTES.toString()} bytes`] };
  let doc: unknown;
  try {
    doc = parseYaml(yamlText, { schema: "core", uniqueKeys: true, maxAliasCount: 0, prettyErrors: false });
  } catch (e) {
    return { ok: false, errors: [`YAML: ${describeError(e)}`] };
  }
  if (!validateRaw(doc)) return { ok: false, errors: schemaErrors(validateRaw.errors) };
  return normalizeSpec(doc);
}
