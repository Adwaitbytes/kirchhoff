import { decimalsOn } from "./chains.ts";
import { EngineInputError, type ChainSel, type TokenSpec } from "./types.ts";

/**
 * Rescales an integer amount between decimal precisions. Scaling down floors,
 * because sub-unit dust on a higher-precision chain cannot be redeemed at
 * canonical precision and must not count as backing or as a claim.
 */
export function rescale(amount: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return amount;
  if (fromDecimals < toDecimals) return amount * 10n ** BigInt(toDecimals - fromDecimals);
  const divisor = 10n ** BigInt(fromDecimals - toDecimals);
  const quotient = amount / divisor;
  // BigInt division truncates toward zero; floor negatives so a negative reserve never rounds up.
  return amount < 0n && quotient * divisor !== amount ? quotient - 1n : quotient;
}

/** Canonical base units are the home chain's base units. */
export function toCanonical(spec: TokenSpec, chain: ChainSel, amount: bigint): bigint {
  return rescale(amount, decimalsOn(spec, chain), spec.home.decimals);
}

const AMOUNT_PATTERN = /^(\d+)(?:\.(\d+))?(?:e(\d+))?$/;

/**
 * Parses spec amounts such as `"0"`, `"1200"` or `"50000e18"` into an exact
 * bigint. Rejects anything that would need rounding, so a typo can never
 * silently loosen a threshold.
 */
export function parseAmount(text: string): bigint {
  const match = AMOUNT_PATTERN.exec(text);
  if (match === null) throw new EngineInputError(`invalid amount "${text}"`);
  const [, whole = "", fraction = "", exponent = "0"] = match;
  const exp = Number(exponent);
  if (fraction.length > exp) throw new EngineInputError(`amount "${text}" is not an integer number of base units`);
  return BigInt(whole + fraction) * 10n ** BigInt(exp - fraction.length);
}
