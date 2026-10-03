import { Status, type Hex, type ReadConfidence, type W1Config } from "@kirchhoff/engine";
import type { BlockRef } from "./io.ts";
import type { LedgerTarget } from "./reports.ts";

export type ChainEntry = W1Config["chains"][number];

/** CRE chain reads accept latest or finalized only; the compiler already maps a spec `safe` to finalized. */
export function readBlock(confidence: ReadConfidence): BlockRef {
  return confidence === "latest" ? { tag: "latest" } : { tag: "finalized" };
}

export function selectorMap(chains: readonly ChainEntry[]): Map<string, bigint> {
  return new Map(chains.map((c) => [c.name, BigInt(c.selector)]));
}

export function chainBySelector(chains: readonly ChainEntry[], selector: bigint): ChainEntry | undefined {
  return chains.find((c) => BigInt(c.selector) === selector);
}

export function chainByName(chains: readonly ChainEntry[], name: string): ChainEntry {
  const entry = chains.find((c) => c.name === name);
  if (entry === undefined) throw new Error(`chain ${name} is not in the workflow config`);
  return entry;
}

export function ledgerTargets(chains: readonly ChainEntry[]): LedgerTarget[] {
  return chains.map((c) => ({ chain: c.name, selector: BigInt(c.selector), ledger: c.ledger }));
}

export const sameAddress = (a: Hex, b: Hex): boolean => a.toLowerCase() === b.toLowerCase();

/** Seconds since the epoch from the runtime's consensus clock (never `Date.now()`). */
export function unixSeconds(now: Date): bigint {
  return BigInt(Math.floor(now.getTime() / 1000));
}

/** Name of a raw on-chain Status value, tolerating values this build does not know. */
export function statusLabel(status: number): string {
  for (const [name, value] of Object.entries(Status)) if (value === status) return name;
  return `status ${status}`;
}
