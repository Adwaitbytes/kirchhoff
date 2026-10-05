import { createHash } from "node:crypto";
import { CHAINS, PLAYBOOK_LABEL, type IncidentNarrative, type NarrativeSentence, type PlaybookStep } from "@kirchhoff/sdk";
import { UNTRUSTED_POLICY, houseStyle, parseModelJson, untrusted, validateJson } from "./guard.ts";
import type { JsonSchema, LlmProvider } from "./provider.ts";
import type { IncidentBundle } from "./types.ts";

/**
 * Incident Narrator (PRD section 11 feature 2). Input: the deterministic evidence bundle. Output: a
 * ~120-word summary, a timeline and next steps from the fixed playbook, every sentence citing
 * evidence ids. Any model failure or invalid output falls back to the deterministic template
 * (cut list item 7), so the Incident Room never waits on a model.
 */

export const NARRATIVE_LABEL = "AI summary. Verify against evidence." as const;
const PLAYBOOK = Object.keys(PLAYBOOK_LABEL) as PlaybookStep[];
const MAX_SUMMARY_WORDS = 160;

const SENTENCE = {
  type: "object",
  additionalProperties: false,
  required: ["text", "citations"],
  properties: {
    text: { type: "string", maxLength: 400 },
    citations: { type: "array", minItems: 1, maxItems: 6, items: { type: "string", pattern: "^ev-[0-9]{1,3}$" } },
  },
} as const;

export const NARRATIVE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "timeline", "nextSteps"],
  properties: {
    summary: { type: "array", minItems: 2, maxItems: 8, items: SENTENCE },
    timeline: { type: "array", minItems: 1, maxItems: 20, items: SENTENCE },
    nextSteps: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", enum: PLAYBOOK } },
  },
};

type ModelNarrative = { summary: NarrativeSentence[]; timeline: NarrativeSentence[]; nextSteps: PlaybookStep[] };

export function bundleKey(bundle: IncidentBundle): string {
  return createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
}

function units(amount: string, decimals = 18): string {
  const neg = amount.startsWith("-");
  const digits = (neg ? amount.slice(1) : amount).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "").slice(0, 4);
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

const short = (h: string): string => `${h.slice(0, 6)}...${h.slice(-4)}`;

function playbookFor(bundle: IncidentBundle): PlaybookStep[] {
  const custom = bundle.incident.offending.bridge !== "ccip" && bundle.incident.offending.bridge !== "unknown";
  const junction = ["DEBIT_NOT_FOUND", "RECIPIENT_MISMATCH", "AMOUNT_MISMATCH", "DOUBLE_CREDIT"].includes(bundle.incident.reason);
  return custom && junction
    ? ["rotate_bridge_verifier_key", "contact_dex_for_pool_pause", "prepare_holder_communication"]
    : ["contact_dex_for_pool_pause", "prepare_holder_communication"];
}

/** Deterministic narrative straight from the evidence bundle. Every sentence cites the items it states. */
export function templateNarrative(bundle: IncidentBundle, now: Date = new Date()): IncidentNarrative {
  const { incident, evidence } = bundle;
  const ids = (kind: string): string[] => evidence.filter((e) => e.kind === kind).map((e) => e.id);
  const off = incident.offending;
  const credit = ids("offending_credit");
  const search = ids("debit_search");
  const breach = ids("breach_report");
  const contain = ids("quarantine_tx");
  const refused = ids("refused_message");
  const guard = ids("guard_revert");
  const epoch = ids("epoch_report");
  const summary: NarrativeSentence[] = [];
  const bridge = off.bridge === "weakbridge" ? "WeakBridge" : off.bridge === "ccip" ? "CCIP" : off.bridge;
  const what =
    incident.reason === "DEBIT_NOT_FOUND"
      ? `with no matching debit on ${CHAINS[off.claimedSrcChain].label}`
      : incident.reason === "DOUBLE_CREDIT"
        ? "for a debit that had already been credited once"
        : incident.reason === "LOOP_DEFICIT"
          ? "and the Loop Rule found backing below claims"
          : `failing the Junction Rule with ${incident.reason}`;
  const loopOnly = (incident.reason === "LOOP_DEFICIT" || incident.reason === "RESERVE_SHORTFALL") && off.bridge === "unknown";
  if (loopOnly) {
    // A Loop Rule breach has no single offending credit: state the deficit, not a fabricated credit.
    summary.push({ text: `The Loop Rule found ${incident.token} backing below claims by ${units(off.amount)} ${incident.token} (${incident.reason}).`, citations: [...breach, ...credit].slice(0, 2) });
  } else {
    summary.push({
      text: `${bridge} credited ${units(off.amount)} ${incident.token} to ${short(off.recipient)} on ${CHAINS[off.chain].label} ${what}.`,
      citations: [...credit, ...search].slice(0, 2),
    });
  }
  if (breach.length > 0) {
    summary.push({
      text: `KIRCHHOFF wrote BROKEN (${incident.reason}) to the ConservationLedger on ${breach.length} ${breach.length === 1 ? "chain" : "chains"}, ${incident.timeToBrokenSeconds} seconds after the offending block.`,
      citations: breach.slice(0, 3),
    });
  }
  if (contain.length > 0) {
    summary.push({ text: `Containment ran onchain: CCIP lanes for ${incident.token} froze and the recipient was tainted.`, citations: contain.slice(0, 3) });
  }
  if (refused.length > 0) {
    summary.push({ text: `The Judge refused ${refused.length} CCIP ${refused.length === 1 ? "transfer" : "transfers"} of ${incident.token} after the breach, so the forged supply did not spread over CCIP.`, citations: refused.slice(0, 3) });
  }
  if (guard.length > 0) summary.push({ text: "KirchhoffGuard reverted onward transfers from the tainted address.", citations: guard.slice(0, 2) });
  summary.push({
    text: `Delta moved from ${units(incident.deltaBefore)} to ${units(incident.deltaAfter)} ${incident.token}.`,
    citations: (epoch.length > 0 ? epoch : breach.length > 0 ? breach : credit).slice(0, 2),
  });
  const timeline = [...evidence]
    .sort((a, b) => a.at.localeCompare(b.at) || Number(a.id.slice(3)) - Number(b.id.slice(3)))
    .map((e) => ({ text: houseStyle(`${e.at.slice(11, 19)} UTC: ${e.label}.`), citations: [e.id] }));
  return {
    model: "deterministic-template",
    generatedAt: now.toISOString(),
    label: NARRATIVE_LABEL,
    summary: summary.filter((s) => s.citations.length > 0).map((s) => ({ ...s, text: houseStyle(s.text) })),
    timeline,
    nextSteps: playbookFor(bundle),
    generator: "template",
  };
}

const SYSTEM = [
  "You are the KIRCHHOFF Incident Narrator. You explain a cross-chain conservation breach to an on-call engineer in 30 seconds.",
  UNTRUSTED_POLICY,
  "Rules for the narrative:",
  "- Use only facts stated in the evidence items. Do not infer amounts, addresses, times or causes that are not there.",
  "- Every sentence must cite one or more evidence ids (ev-N) that directly support it.",
  "- summary: 3 to 6 sentences, about 120 words in total. timeline: one sentence per key event in time order.",
  "- nextSteps: choose only from the playbook enum. Never invent steps.",
  "- Plain, precise English. No em dashes. No speculation about attackers. Say \"Testnet simulation\" facts as given.",
  "Reply with JSON only, matching the schema.",
].join("\n");

function sanitize(raw: ModelNarrative, bundle: IncidentBundle): ModelNarrative | null {
  const valid = new Set(bundle.evidence.map((e) => e.id));
  const clean = (list: NarrativeSentence[]): NarrativeSentence[] =>
    list
      .map((s) => ({ text: houseStyle(s.text), citations: [...new Set(s.citations.filter((c) => valid.has(c)))] }))
      // Principle 2: a sentence without valid evidence is dropped, never shown.
      .filter((s) => s.citations.length > 0 && s.text.length > 0);
  const summary = clean(raw.summary);
  const timeline = clean(raw.timeline);
  const nextSteps = [...new Set(raw.nextSteps.filter((s) => PLAYBOOK.includes(s)))];
  const words = summary.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
  if (summary.length < 2 || timeline.length === 0 || nextSteps.length === 0 || words > MAX_SUMMARY_WORDS) return null;
  return { summary, timeline, nextSteps };
}

export type NarrateOptions = { provider: LlmProvider | null; model: string; signal?: AbortSignal; now?: Date; onError?: (e: unknown) => void };

/** Model narrative with citation checks; the template on any failure. Never throws. */
export async function narrateIncident(bundle: IncidentBundle, opts: NarrateOptions): Promise<IncidentNarrative> {
  const now = opts.now ?? new Date();
  if (!opts.provider) return templateNarrative(bundle, now);
  try {
    const facts = {
      incident: bundle.incident,
      evidence: bundle.evidence.map((e) => ({ id: e.id, kind: e.kind, chain: e.chain, at: e.at, label: e.label, tx: e.tx?.hash ?? null, blocks: e.blocks })),
      actions: bundle.actions.map((a) => ({ kind: a.kind, applied: a.applied, chains: a.txs.map((t) => t.chain) })),
      blastRadius: bundle.blastRadius,
      heldMessages: bundle.heldMessages.length,
      playbook: PLAYBOOK_LABEL,
    };
    const res = await opts.provider.chat(
      {
        model: opts.model,
        temperature: 0,
        maxTokens: 2_000,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Evidence bundle for incident ${bundle.incident.id}:\n${untrusted(facts)}` },
        ],
        responseSchema: { name: "incident_narrative", schema: NARRATIVE_SCHEMA },
      },
      opts.signal,
    );
    const parsed = parseModelJson(res.content);
    const checked = validateJson<ModelNarrative>(NARRATIVE_SCHEMA, parsed);
    if (!checked.ok) throw new Error(`narrative failed schema: ${checked.errors}`);
    const safe = sanitize(checked.value, bundle);
    if (!safe) throw new Error("narrative failed citation or length checks");
    return { model: res.model, generatedAt: now.toISOString(), label: NARRATIVE_LABEL, ...safe, generator: "model" };
  } catch (e) {
    opts.onError?.(e);
    return templateNarrative(bundle, now);
  }
}

/** Share of sentences with at least one valid evidence citation (eval metric). */
export function citationCoverage(n: IncidentNarrative, bundle: IncidentBundle): number {
  const valid = new Set(bundle.evidence.map((e) => e.id));
  const all = [...n.summary, ...n.timeline];
  if (all.length === 0) return 0;
  return all.filter((s) => s.citations.length > 0 && s.citations.every((c) => valid.has(c))).length / all.length;
}
