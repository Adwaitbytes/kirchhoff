import type { Address, Bytes32, ChainKey, CopilotTool, SpecDraftLine } from "@/lib/api/types";

export const STEPS = [
  { key: "describe", label: "Describe", hint: "Token and home" },
  { key: "discover", label: "Discover", hint: "Copilot traces wiring" },
  { key: "review", label: "Review", hint: "Evidence per line" },
  { key: "backtest", label: "Backtest", hint: "Replay real history" },
  { key: "propose", label: "Propose", hint: "Issuer Safe" },
  { key: "timelock", label: "Timelock", hint: "Then active" },
] as const;

export type StepKey = (typeof STEPS)[number]["key"];

export interface DescribeInput {
  description: string;
  chain: ChainKey;
  address: string;
}

export type TraceItem =
  | { kind: "thinking"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      tool: CopilotTool;
      input: Record<string, string | number | boolean | null>;
      at: string;
      result: { ok: boolean; summary: string; href: string | null; durationMs: number } | null;
    };

export interface Draft {
  yaml: string;
  lines: SpecDraftLine[];
  specHash: Bytes32;
}

export interface Validation {
  ok: boolean;
  errors: { line: number | null; message: string }[];
}

export type DiscoveryPhase = "idle" | "running" | "done" | "error" | "stopped";

export interface DiscoveryState {
  phase: DiscoveryPhase;
  items: TraceItem[];
  draft: Draft | null;
  validation: Validation | null;
  error: string | null;
}

export const EMPTY_DISCOVERY: DiscoveryState = { phase: "idle", items: [], draft: null, validation: null, error: null };

export interface Approved {
  yaml: string;
  canonical: { chain: ChainKey; address: Address };
}
