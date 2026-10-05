import type { IsoTime, WeiString } from "@/lib/api/types";

/** Parses a base-unit decimal string. Throws on malformed input so bad API data never renders as 0. */
export function parseWei(value: WeiString): bigint {
  if (!/^-?\d+$/.test(value)) throw new Error(`Malformed base-unit amount: "${value}"`);
  return BigInt(value);
}

export interface FormatAmountOptions {
  decimals: number;
  /** Fraction digits to show, trailing zeros trimmed. */
  maxFraction?: number;
  /** Prefix "+" on positive values (Δ readouts). */
  signed?: boolean;
}

const MINUS = "−";

/** Formats a base-unit bigint with thousands separators, exact (no float rounding). */
export function formatAmount(value: bigint, { decimals, maxFraction = 2, signed = false }: FormatAmountOptions): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fracUnits = abs % base;
  let fraction = "";
  if (maxFraction > 0 && fracUnits > 0n) {
    const padded = fracUnits.toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
    if (padded.length > 0) fraction = `.${padded}`;
  }
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = negative ? MINUS : signed && abs > 0n ? "+" : "";
  return `${sign}${grouped}${fraction}`;
}

export function formatWei(value: WeiString, opts: FormatAmountOptions): string {
  return formatAmount(parseWei(value), opts);
}

/** Compact amount for wire labels: 116.5K, 2.1M. */
export function formatCompact(value: bigint, decimals: number): string {
  const whole = Number(value / 10n ** BigInt(decimals));
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(whole);
}

export function secondsBetween(from: IsoTime, toMs: number): number {
  return Math.max(0, Math.floor((toMs - Date.parse(from)) / 1000));
}

/** "2m 14s", "12s", "1h 3m". */
export function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Long-form age for prose: "12 seconds", "2 minutes". */
export function formatAgeWords(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  return `${h} hour${h === 1 ? "" : "s"}`;
}

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

const dateTimeFmt = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

export function formatTime(iso: IsoTime): string {
  return timeFmt.format(new Date(iso));
}

export function formatDateTime(iso: IsoTime): string {
  return `${dateTimeFmt.format(new Date(iso))} UTC`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return formatAge(seconds);
}
