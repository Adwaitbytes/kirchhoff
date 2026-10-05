import type { Incident } from "@/lib/api/types";

/** An all-zero address or bytes32 is a placeholder, never a fact: the UI renders it as n/a. */
export function isZeroHex(v: string | null | undefined): boolean {
  return !v || /^0x0*$/i.test(v);
}

/** A Loop Rule (W2) incident has no single offending credit, recipient or message id. */
export function isLoopRule(i: Incident): boolean {
  return i.offending.bridge === "loop_rule";
}

export const LOOP_NOTE =
  "Loop Rule breach: value appeared with no message, so there is no single recipient or message id. W2 read every chain at pinned blocks";

/** Display value for an address or id that may be a placeholder. */
export function orNa(v: string | null | undefined, format: (s: string) => string): string {
  return isZeroHex(v) || !v ? "n/a" : format(v);
}

/** Replaces zero-address and zero-id placeholders inside server-built prose with "n/a". */
export function scrubZeros(text: string): string {
  return text.replace(/0x0{64}(?![0-9a-f])|0x0{40}(?![0-9a-f])|0x0{2,6}(?:…|\.\.\.)0{2,6}/gi, "n/a");
}
