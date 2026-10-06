import type { Hex, W1Config, W2Config, W3Config, W4Config } from "@kirchhoff/engine";
import { z } from "zod";

/**
 * Runtime schemas for the configs `engine/compile.ts` generates. The CRE runner validates the config JSON
 * against them before any handler runs. The `Same<>` checks below fail type-checking the moment the compiler's
 * output types and these schemas drift apart, so a config change can never be half-applied.
 */
const hex = z.string().regex(/^0x[0-9a-fA-F]*$/, "hex string").transform((s) => s as Hex);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "20-byte address").transform((s) => s as Hex);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "32-byte hex").transform((s) => s as Hex);
const uintString = z.string().regex(/^\d+$/, "decimal unsigned integer");

const chainEntry = z.object({
  name: z.string().min(1),
  selector: uintString,
  chainId: z.number().int().positive(),
  alias: z.string().min(1),
  isHome: z.boolean(),
  confidence: z.enum(["latest", "safe", "finalized"]),
  triggerConfidence: z.enum(["LATEST", "SAFE", "FINALIZED"]),
  readConfidence: z.enum(["latest", "finalized"]),
  decimals: z.number().int().min(0).max(77),
  token: address,
  ledger: address,
  quarantine: address,
  feed: address,
});

const pairedWatch = z.object({
  chain: z.string().min(1),
  bridgeId: z.string().min(1),
  adapter: z.string().min(1),
  address,
  event: z.string().min(1),
  topic0: bytes32,
  pairWith: z.object({ address, event: z.string().min(1), topic0: bytes32 }).nullable(),
});

const debitLookup = pairedWatch.extend({
  messageIdTopicIndex: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  searchWindowBlocks: uintString,
  registry: z.object({ debitOf: hex, creditOf: hex }).nullable(),
});

const header = { token: z.string().min(1), tokenId: bytes32, specHash: bytes32 };

const chainRef = z.object({ name: z.string().min(1), selector: uintString, alias: z.string().min(1) });
const fieldMap = z.object({ messageId: z.string(), amount: z.string(), recipient: z.string().nullable(), remoteChain: z.string() });
const addressMap = z.record(z.string(), address).readonly();
const bridge = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1),
    kind: z.literal("ccip_v2"),
    pools: addressMap,
    onramps: addressMap,
    offramps: addressMap,
    lockbox: address.nullable(),
    searchWindowBlocks: uintString,
    maxDeliverySeconds: z.number().int().min(0),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("custom"),
    contracts: addressMap,
    events: z.object({ debitEvent: z.string(), creditEvent: z.string(), debitFields: fieldMap, creditFields: fieldMap }),
    searchWindowBlocks: uintString,
    maxDeliverySeconds: z.number().int().min(0),
  }),
]);
const confidenceLevel = z.enum(["latest", "safe", "finalized"]);
const responseAction = z.enum(["freeze_ccip_lanes", "taint_recipient", "flip_feed", "page_issuer"]);

/** The resolved KIRCH-SPEC the compiler embeds in W1/W2 configs (engine `SpecJson`; `reviveSpec` restores bigints). */
const specJson = z.object({
  specVersion: z.literal(1),
  token: z.string().min(1),
  tokenId: bytes32,
  model: z.enum(["lock_release_home", "burn_mint_multi"]),
  unit: z.enum(["tokens", "shares"]),
  home: z.object({ chain: chainRef, canonical: address, escrow: address.nullable(), decimals: z.number().int().min(0).max(77) }),
  remotes: z.array(z.object({ chain: chainRef, token: address, minters: z.array(z.string()).readonly(), decimals: z.number().int().min(0).max(77) })),
  bridges: z.array(bridge),
  reserves: z.object({ porFeed: address.nullable(), decimals: z.number().int().min(0) }),
  confidence: z.object({ default: confidenceLevel, overrides: z.record(z.string(), confidenceLevel).readonly() }),
  rules: z.object({
    junction: z.object({ matchWindowSeconds: uintString }),
    loop: z.object({ toleranceWei: uintString, breachConfirmations: z.number().int().min(1) }),
    soft: z.object({ flowLimitPerHour: uintString.nullable() }),
    stalenessSeconds: uintString,
    onStale: z.enum(["fail_closed", "fail_open"]),
  }),
  response: z.object({ onBroken: z.array(responseAction), replayRequires: z.literal("issuer_multisig"), recoveryTimelockSeconds: uintString }),
});

export const w1ConfigSchema = z.object({
  workflow: z.literal("w1-junction"),
  ...header,
  spec: specJson,
  chains: z.array(chainEntry).min(1),
  creditTriggers: z.array(pairedWatch),
  debitLookups: z.array(debitLookup),
  matchWindowSeconds: uintString,
});

export const w2ConfigSchema = z.object({
  workflow: z.literal("w2-loop"),
  ...header,
  spec: specJson,
  model: z.enum(["lock_release_home", "burn_mint_multi"]),
  unit: z.enum(["tokens", "shares"]),
  schedule: z.string().min(1),
  multicall3: address,
  chains: z.array(chainEntry).min(1),
  reads: z.object({ supply: z.string().min(1), balance: z.string().min(1) }),
  escrowHolders: z.array(address),
  supplyTriggers: z.array(
    z.object({
      chain: z.string().min(1),
      address,
      side: z.enum(["mint", "burn", "escrow_in", "escrow_out"]),
      topics: z.tuple([z.array(bytes32), z.array(bytes32), z.array(bytes32)]),
    }),
  ),
  debitEvents: z.array(pairedWatch.extend({ registry: z.object({ debitOf: hex, creditOf: hex }).nullable() })),
  creditEvents: z.array(pairedWatch),
  logQueryBlockLimit: uintString,
  porFeed: address.nullable(),
  reserveDecimals: z.number().int().min(0),
  toleranceWei: uintString,
  breachConfirmations: z.number().int().min(1),
  flowLimitPerHour: uintString.nullable(),
  matchWindowSeconds: uintString,
});

export const w3ConfigSchema = z.object({
  workflow: z.literal("w3-responder"),
  ...header,
  home: z.string().min(1),
  breachTrigger: z.object({ chain: z.string().min(1), address, topic0: bytes32, confidence: z.enum(["LATEST", "SAFE", "FINALIZED"]) }),
  chains: z.array(chainEntry).min(1),
  onBroken: z.array(responseAction).readonly(),
  notifySecrets: z.array(z.string().min(1)),
});

export const w4ConfigSchema = z.object({
  workflow: z.literal("w4-topology"),
  ...header,
  schedule: z.string().min(1),
  registry: z.object({ chain: z.string().min(1), address, specActivatedTopic0: bytes32 }),
  roleGrantedTopic0: bytes32,
  minterRole: bytes32,
  spec: specJson,
  chains: z.array(chainEntry.extend({ expectedMinters: z.array(address), ccipPools: z.array(address), tokenAdminRegistry: address.nullable() })).min(1),
  notifySecrets: z.array(z.string().min(1)),
});

export type W1ConfigInput = z.input<typeof w1ConfigSchema>;
export type W2ConfigInput = z.input<typeof w2ConfigSchema>;
export type W3ConfigInput = z.input<typeof w3ConfigSchema>;
export type W4ConfigInput = z.input<typeof w4ConfigSchema>;

/** Compile-time mutual assignability between the schema output and the compiler's config type. */
const sameShape = <A, B>(toB: (a: A) => B, toA: (b: B) => A): [typeof toB, typeof toA] => [toB, toA];
const id = <T>(x: T): T => x;
sameShape<z.output<typeof w1ConfigSchema>, W1Config>(id, id);
sameShape<z.output<typeof w2ConfigSchema>, W2Config>(id, id);
sameShape<z.output<typeof w3ConfigSchema>, W3Config>(id, id);
sameShape<z.output<typeof w4ConfigSchema>, W4Config>(id, id);
