import type { CopilotTool, LineProvenance, SpecDraftLine } from "@/lib/api/types";

export type LineStatus = "ok" | "issuer" | "missing" | "blank";

export interface LineState {
  /** 1-based line number in the current text. */
  line: number;
  text: string;
  provenance: LineProvenance | null;
  status: LineStatus;
}

const ISSUER: LineProvenance = { kind: "issuer", toolCallId: null, tool: null, href: null, why: null };

/**
 * Re-derives provenance for the edited YAML (PRD section 11, principle 2).
 * A line identical to a draft line inherits that line's provenance, so a draft line without
 * evidence stays red until the issuer changes or removes it. Any other line was typed by a
 * human and is attributed to the issuer.
 */
export function computeLines(yaml: string, original: readonly SpecDraftLine[]): LineState[] {
  const byText = new Map<string, LineProvenance | null>();
  for (const l of original) {
    const prev = byText.get(l.text);
    if (prev === undefined || (prev === null && l.provenance !== null)) byText.set(l.text, l.provenance);
  }
  return yaml.split(/\r?\n/).map((text, i): LineState => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) return { line: i + 1, text, provenance: null, status: "blank" };
    if (byText.has(text)) {
      const p = byText.get(text) ?? null;
      return { line: i + 1, text, provenance: p, status: p === null ? "missing" : "ok" };
    }
    return { line: i + 1, text, provenance: ISSUER, status: "issuer" };
  });
}

export function missingLines(lines: readonly LineState[]): number[] {
  return lines.filter((l) => l.status === "missing").map((l) => l.line);
}

export const TOOL_LABEL: Readonly<Record<CopilotTool, string>> = {
  get_contract: "get_contract",
  list_role_grants: "role_grants",
  list_ccip_pools: "ccip_pools",
  list_oft_peers: "oft_peers",
  sample_events: "sample_events",
  validate_spec: "schema",
  backtest_spec: "backtest",
};

export function chipLabel(p: LineProvenance | null): string {
  if (!p) return "no evidence";
  if (p.kind === "issuer") return "issuer edit";
  if (p.kind === "schema") return "schema";
  return p.tool ? TOOL_LABEL[p.tool] : "tool";
}

export function formatLineList(lines: readonly number[]): string {
  if (lines.length === 1) return `Line ${lines[0]}`;
  return `Lines ${lines.slice(0, -1).join(", ")} and ${lines[lines.length - 1]}`;
}
