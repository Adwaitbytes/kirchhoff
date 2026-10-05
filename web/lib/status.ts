import { CircleCheck, CircleDashed, Lock, OctagonX, RotateCcw, TriangleAlert, type LucideIcon } from "lucide-react";
import type { TokenStatus } from "@/lib/api/types";

export interface StatusStyle {
  icon: LucideIcon;
  /** Text color class with AA contrast. */
  text: string;
  /** Solid fill (dots, bars). */
  bg: string;
  /** Soft tinted surface. */
  soft: string;
  border: string;
  /** CSS variable for SVG strokes. */
  cssVar: string;
  /** Plain-English line for holders. */
  meaning: string;
}

export const STATUS_STYLE: Readonly<Record<TokenStatus, StatusStyle>> = {
  CONSERVED: {
    icon: CircleCheck,
    text: "text-conserved",
    bg: "bg-conserved",
    soft: "bg-conserved/10",
    border: "border-conserved/40",
    cssVar: "var(--status-conserved)",
    meaning: "Backing covers every claim on every chain.",
  },
  DRIFT: {
    icon: TriangleAlert,
    text: "text-drift",
    bg: "bg-drift",
    soft: "bg-drift/10",
    border: "border-drift/40",
    cssVar: "var(--status-drift)",
    meaning: "A soft rule tripped. No breach; transfers still pass and are flagged.",
  },
  BROKEN: {
    icon: OctagonX,
    text: "text-broken",
    bg: "bg-broken",
    soft: "bg-broken/10",
    border: "border-broken/50",
    cssVar: "var(--status-broken)",
    meaning: "The Junction or Loop Rule is breached. Every transfer of this token is refused.",
  },
  QUARANTINED: {
    icon: Lock,
    text: "text-quarantined",
    bg: "bg-quarantined",
    soft: "bg-quarantined/10",
    border: "border-quarantined/50",
    cssVar: "var(--status-quarantined)",
    meaning: "Breached and contained: CCIP lanes frozen, offending recipients tainted.",
  },
  RECOVERING: {
    icon: RotateCcw,
    text: "text-recovering",
    bg: "bg-recovering",
    soft: "bg-recovering/10",
    border: "border-recovering/40",
    cssVar: "var(--status-recovering)",
    meaning: "The issuer resolved the incident. Transfers resume after the timelock and a clean epoch.",
  },
  UNKNOWN: {
    icon: CircleDashed,
    text: "text-unknown-text",
    bg: "bg-unknown",
    soft: "bg-unknown/10",
    border: "border-unknown/40",
    cssVar: "var(--status-unknown)",
    meaning: "No fresh epoch inside the staleness window. Verdicts follow the stale policy.",
  },
};

export function isBreached(s: TokenStatus): boolean {
  return s === "BROKEN" || s === "QUARANTINED";
}

/**
 * A token with no epoch yet: the API reports epochId "0" and updatedAt at the Unix epoch.
 * Never render an age from that sentinel.
 */
export function hasEpoch(t: { epochId: string; updatedAt: string }): boolean {
  const at = Date.parse(t.updatedAt);
  return t.epochId !== "0" && Number.isFinite(at) && at > 0;
}

export const NO_EPOCH_BANNER = "No epoch recorded yet. Verdicts follow the token's stale policy";
