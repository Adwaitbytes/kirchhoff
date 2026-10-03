import type { BridgeSpec, ChainRef, TokenSpec } from "./types.ts";

type ChainRefJson = Omit<ChainRef, "selector"> & { selector: string };

type BridgeJson =
  | (Omit<Extract<BridgeSpec, { kind: "ccip_v2" }>, "searchWindowBlocks"> & { searchWindowBlocks: string })
  | (Omit<Extract<BridgeSpec, { kind: "custom" }>, "searchWindowBlocks"> & { searchWindowBlocks: string });

/**
 * JSON-safe TokenSpec: every bigint as a decimal string, otherwise identical.
 * This is what workflow configs and spec.resolved.json carry, because JSON
 * cannot hold a uint64 selector as a number.
 */
export type SpecJson = Omit<TokenSpec, "home" | "remotes" | "bridges" | "rules" | "response"> & {
  home: Omit<TokenSpec["home"], "chain"> & { chain: ChainRefJson };
  remotes: (Omit<TokenSpec["remotes"][number], "chain"> & { chain: ChainRefJson })[];
  bridges: BridgeJson[];
  rules: {
    junction: { matchWindowSeconds: string };
    loop: { toleranceWei: string; breachConfirmations: number };
    soft: { flowLimitPerHour: string | null };
    stalenessSeconds: string;
    onStale: TokenSpec["rules"]["onStale"];
  };
  response: Omit<TokenSpec["response"], "recoveryTimelockSeconds" | "onBroken"> & {
    onBroken: TokenSpec["response"]["onBroken"][number][];
    recoveryTimelockSeconds: string;
  };
};

const chainToJson = (c: ChainRef): ChainRefJson => ({ ...c, selector: c.selector.toString() });
const chainFromJson = (c: ChainRefJson): ChainRef => ({ ...c, selector: BigInt(c.selector) });

export function toSpecJson(spec: TokenSpec): SpecJson {
  return {
    ...spec,
    home: { ...spec.home, chain: chainToJson(spec.home.chain) },
    remotes: spec.remotes.map((r) => ({ ...r, minters: [...r.minters], chain: chainToJson(r.chain) })),
    bridges: spec.bridges.map((b) => ({ ...b, searchWindowBlocks: b.searchWindowBlocks.toString() })),
    rules: {
      junction: { matchWindowSeconds: spec.rules.junction.matchWindowSeconds.toString() },
      loop: { toleranceWei: spec.rules.loop.toleranceWei.toString(), breachConfirmations: spec.rules.loop.breachConfirmations },
      soft: { flowLimitPerHour: spec.rules.soft.flowLimitPerHour?.toString() ?? null },
      stalenessSeconds: spec.rules.stalenessSeconds.toString(),
      onStale: spec.rules.onStale,
    },
    response: {
      ...spec.response,
      onBroken: [...spec.response.onBroken],
      recoveryTimelockSeconds: spec.response.recoveryTimelockSeconds.toString(),
    },
  };
}

/**
 * Inverse of toSpecJson. Pure and dependency-free so it bundles into CRE
 * WASM; the JSON was produced by the compiler, so this only restores bigints
 * (BigInt throws on a non-integer string rather than guessing).
 */
export function reviveSpec(json: SpecJson): TokenSpec {
  return {
    ...json,
    home: { ...json.home, chain: chainFromJson(json.home.chain) },
    remotes: json.remotes.map((r) => ({ ...r, chain: chainFromJson(r.chain) })),
    bridges: json.bridges.map((b) => ({ ...b, searchWindowBlocks: BigInt(b.searchWindowBlocks) })),
    rules: {
      junction: { matchWindowSeconds: BigInt(json.rules.junction.matchWindowSeconds) },
      loop: { toleranceWei: BigInt(json.rules.loop.toleranceWei), breachConfirmations: json.rules.loop.breachConfirmations },
      soft: { flowLimitPerHour: json.rules.soft.flowLimitPerHour === null ? null : BigInt(json.rules.soft.flowLimitPerHour) },
      stalenessSeconds: BigInt(json.rules.stalenessSeconds),
      onStale: json.rules.onStale,
    },
    response: { ...json.response, recoveryTimelockSeconds: BigInt(json.response.recoveryTimelockSeconds) },
  };
}
