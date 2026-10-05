import type { ContainmentKind, EvidenceItem, IncidentResponse, ReasonCode } from "@/lib/api/types";
import { PLAYBOOK_LABEL } from "@/lib/api/types";
import { CHAINS } from "@/lib/chains";
import { blockUrl, ccipMessageUrl, readContractUrl, txRefUrl } from "@/lib/explorer";
import { formatAmount, formatDateTime, parseWei } from "@/lib/format";

export const CONTAINMENT_LABEL: Readonly<Record<ContainmentKind, string>> = {
  freeze_ccip_lanes: "CCIP lanes frozen",
  taint_recipient: "Recipient tainted",
  flip_feed: "Feed flipped to BROKEN",
  page_issuer: "Issuer paged",
};

/** Short headline per breach reason. Circuit vocabulary, no full stops. */
export function incidentHeadline(reason: ReasonCode): string {
  switch (reason) {
    case "DEBIT_NOT_FOUND":
      return "Credit with no debit";
    case "LOOP_DEFICIT":
      return "Loop deficit";
    case "DOUBLE_CREDIT":
      return "Double credit";
    case "AMOUNT_MISMATCH":
      return "Amount mismatch at the junction";
    case "RECIPIENT_MISMATCH":
      return "Recipient mismatch at the junction";
    case "RESERVE_SHORTFALL":
      return "Reserve shortfall";
    default:
      return reason;
  }
}

export function formatSeconds(s: number): string {
  if (s < 60) return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return `${m}m ${rest}s`;
}

export function sortedEvidence(items: readonly EvidenceItem[]): EvidenceItem[] {
  return [...items].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id, "en", { numeric: true }));
}

function evidenceLink(e: EvidenceItem): string | null {
  if (e.tx) return txRefUrl(e.tx);
  if (e.messageId && e.kind === "refused_message") return ccipMessageUrl(e.messageId);
  if (e.blocks) return blockUrl(e.chain, e.blocks.to);
  return null;
}

/** Markdown postmortem built only from the incident response. Every figure carries its link. */
export function buildMarkdown(r: IncidentResponse, decimals: number): string {
  const i = r.incident;
  const amt = (v: string) => `${formatAmount(parseWei(v), { decimals, signed: false })} ${i.token}`;
  const signed = (v: string) => `${formatAmount(parseWei(v), { decimals, signed: true })} ${i.token}`;
  const ledgerRead = readContractUrl(r.ledger.chain, r.ledger.address);
  const firstBreach = r.evidence.find((e) => e.kind === "breach_report" && e.tx);
  const lines: string[] = [];
  lines.push(`# Postmortem: ${i.token} ${incidentHeadline(i.reason)}`);
  lines.push("");
  lines.push(`Testnet simulation. Source: onchain mirror of ConservationLedger ${r.ledger.address} on ${CHAINS[r.ledger.chain].name}, block ${r.block.number}.`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Field | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Incident | \`${i.id}\` |`);
  lines.push(`| Severity | ${i.severity} |`);
  lines.push(`| Reason | ${i.reason} |`);
  lines.push(`| Token status now | ${r.tokenStatus} |`);
  lines.push(`| Incident status | ${i.status} |`);
  lines.push(`| Δ before | [${signed(i.deltaBefore)}](${ledgerRead}) |`);
  lines.push(`| Δ after | [${signed(i.deltaAfter)}](${ledgerRead}) |`);
  lines.push(`| Offending credit | [${amt(i.offending.amount)} on ${CHAINS[i.offending.chain].name}](${txRefUrl(i.offending.tx)}) via ${i.offending.bridge}, claimed source ${CHAINS[i.offending.claimedSrcChain].name} |`);
  lines.push(`| Recipient | \`${i.offending.recipient}\` |`);
  lines.push(`| Offending block time | ${formatDateTime(i.offendingBlockAt)} |`);
  lines.push(`| BROKEN onchain | ${firstBreach?.tx ? `[${formatDateTime(i.brokenAt)}](${txRefUrl(firstBreach.tx)})` : formatDateTime(i.brokenAt)} |`);
  lines.push(`| Time to BROKEN | ${formatSeconds(i.timeToBrokenSeconds)} |`);
  lines.push(`| Evidence hash | \`${i.evidenceHash}\` |`);
  lines.push("");
  lines.push("## Evidence timeline");
  lines.push("");
  for (const e of sortedEvidence(r.evidence)) {
    const link = evidenceLink(e);
    const range = e.blocks ? ` (blocks ${e.blocks.from} to ${e.blocks.to}, ${e.blocks.matches} matches)` : "";
    lines.push(`- **${e.id}** ${formatDateTime(e.at)}, ${CHAINS[e.chain].name}: ${e.label}${range}${link ? ` [link](${link})` : ""}`);
  }
  lines.push("");
  lines.push("## Containment");
  lines.push("");
  for (const a of r.actions) {
    const txs = a.txs.map((t) => `[${CHAINS[t.chain].short}](${txRefUrl(t)})`).join(", ");
    lines.push(`- [${a.applied ? "x" : " "}] ${CONTAINMENT_LABEL[a.kind]}${txs ? `: ${txs}` : ""}`);
  }
  lines.push("");
  lines.push("## Blast radius");
  lines.push("");
  lines.push("| Chain | Exposure | Tainted | Frozen lanes |");
  lines.push("| --- | --- | --- | --- |");
  for (const b of r.blastRadius) {
    lines.push(`| ${CHAINS[b.chain].name} | ${amt(b.exposure)} | ${b.taintedAddresses.map((a) => `\`${a}\``).join(", ") || "none"} | ${b.frozenLanes.length} |`);
  }
  lines.push("");
  lines.push(`## Held messages (${r.heldMessages.length})`);
  lines.push("");
  if (r.heldMessages.length === 0) lines.push("None.");
  for (const h of r.heldMessages) {
    lines.push(`- [${h.messageId}](${ccipMessageUrl(h.messageId)}): ${amt(h.amount)} ${CHAINS[h.srcChain].name} to ${CHAINS[h.dstChain].name}, ${h.reason}, held ${formatDateTime(h.heldAt)}`);
  }
  if (r.narrative) {
    lines.push("");
    lines.push("## AI summary. Verify against evidence.");
    lines.push("");
    lines.push(`Generator: ${r.narrative.generator === "model" ? r.narrative.model : `template (${r.narrative.model})`}, ${formatDateTime(r.narrative.generatedAt)}.`);
    lines.push("");
    for (const s of r.narrative.summary) lines.push(`- ${s.text} [${s.citations.join(", ")}]`);
    lines.push("");
    lines.push("### Next steps (fixed playbook)");
    lines.push("");
    for (const n of r.narrative.nextSteps) lines.push(`- ${PLAYBOOK_LABEL[n]}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Standard PDF fonts are WinAnsi: replace glyphs they cannot draw. */
function pdfSafe(s: string): string {
  return s.replace(/−/g, "-").replace(/Δ/g, "Delta ").replace(/[→]/g, "to").replace(/[^\x20-\x7E -ÿ…]/g, "");
}

export async function buildPdf(r: IncidentResponse, decimals: number): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const i = r.incident;
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 56;
  let y = M;

  const ensure = (h: number) => {
    if (y + h > H - M) {
      doc.addPage();
      y = M;
    }
  };
  const text = (s: string, size: number, opts: { bold?: boolean; color?: [number, number, number]; mono?: boolean; gap?: number } = {}) => {
    doc.setFont(opts.mono ? "courier" : "helvetica", opts.bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(...(opts.color ?? [20, 22, 26]));
    const wrapped = doc.splitTextToSize(pdfSafe(s), W - M * 2) as string[];
    const lh = size * 1.4;
    for (const line of wrapped) {
      ensure(lh);
      doc.text(line, M, y + size);
      y += lh;
    }
    y += opts.gap ?? 0;
  };
  const rule = () => {
    ensure(16);
    doc.setDrawColor(214, 217, 222);
    doc.line(M, y + 6, W - M, y + 6);
    y += 16;
  };
  const amt = (v: string) => `${formatAmount(parseWei(v), { decimals })} ${i.token}`;
  const signed = (v: string) => `${formatAmount(parseWei(v), { decimals, signed: true })} ${i.token}`;

  text("KIRCHHOFF POSTMORTEM  ·  TESTNET SIMULATION", 9, { color: [107, 114, 128], gap: 6 });
  text(`${i.token}: ${incidentHeadline(i.reason)}`, 22, { bold: true, gap: 4 });
  text(`${i.severity}  ·  ${i.reason}  ·  token ${r.tokenStatus}  ·  incident ${i.status}`, 10, { color: [75, 85, 99], gap: 10 });
  rule();

  const rows: [string, string][] = [
    ["Incident", i.id],
    ["Delta before", signed(i.deltaBefore)],
    ["Delta after", signed(i.deltaAfter)],
    ["Offending credit", `${amt(i.offending.amount)} on ${CHAINS[i.offending.chain].name} via ${i.offending.bridge}`],
    ["Offending tx", i.offending.tx.hash],
    ["Claimed source", CHAINS[i.offending.claimedSrcChain].name],
    ["Recipient", i.offending.recipient],
    ["Offending block", formatDateTime(i.offendingBlockAt)],
    ["BROKEN onchain", formatDateTime(i.brokenAt)],
    ["Time to BROKEN", formatSeconds(i.timeToBrokenSeconds)],
    ["Evidence hash", i.evidenceHash],
    ["Mirror", `${r.ledger.address} on ${CHAINS[r.ledger.chain].name}, block ${r.block.number}`],
  ];
  for (const [k, v] of rows) {
    ensure(16);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(107, 114, 128);
    doc.text(k, M, y + 9);
    doc.setFont("courier", "normal");
    doc.setTextColor(20, 22, 26);
    const wrapped = doc.splitTextToSize(pdfSafe(v), W - M * 2 - 120) as string[];
    wrapped.forEach((line, idx) => {
      if (idx > 0) ensure(13);
      doc.text(line, M + 120, y + 9 + idx * 13);
    });
    y += Math.max(16, wrapped.length * 13 + 3);
  }
  rule();

  text("Evidence timeline", 13, { bold: true, gap: 4 });
  for (const e of sortedEvidence(r.evidence)) {
    const range = e.blocks ? ` Blocks ${e.blocks.from} to ${e.blocks.to}, ${e.blocks.matches} matches.` : "";
    text(`${e.id}  ${formatDateTime(e.at)}  ${CHAINS[e.chain].name}`, 9, { color: [107, 114, 128], mono: true });
    text(`${e.label}.${range}`, 10, { gap: 1 });
    if (e.tx) text(txRefUrl(e.tx), 8, { mono: true, color: [15, 118, 110], gap: 5 });
    else y += 5;
  }
  rule();

  text("Containment", 13, { bold: true, gap: 4 });
  for (const a of r.actions) text(`${a.applied ? "[x]" : "[ ]"} ${CONTAINMENT_LABEL[a.kind]}${a.txs.length ? `  (${a.txs.length} tx)` : ""}`, 10, { gap: 2 });
  y += 6;

  text("Blast radius", 13, { bold: true, gap: 4 });
  for (const b of r.blastRadius) {
    text(`${CHAINS[b.chain].name}: exposure ${amt(b.exposure)}, ${b.taintedAddresses.length} tainted, ${b.frozenLanes.length} frozen lanes`, 10, { gap: 2 });
  }
  y += 6;

  text(`Held messages (${r.heldMessages.length})`, 13, { bold: true, gap: 4 });
  for (const h of r.heldMessages) text(`${h.messageId}  ${amt(h.amount)}  ${CHAINS[h.srcChain].short} to ${CHAINS[h.dstChain].short}  ${h.reason}`, 9, { mono: true, gap: 2 });

  if (r.narrative) {
    rule();
    text("AI summary. Verify against evidence.", 13, { bold: true, gap: 2 });
    text(`Generator: ${r.narrative.generator === "model" ? r.narrative.model : `template (${r.narrative.model})`}`, 9, { color: [107, 114, 128], gap: 6 });
    for (const s of r.narrative.summary) text(`${s.text} [${s.citations.join(", ")}]`, 10, { gap: 3 });
    y += 4;
    text("Next steps (fixed playbook)", 11, { bold: true, gap: 2 });
    for (const n of r.narrative.nextSteps) text(`- ${PLAYBOOK_LABEL[n]}`, 10, { gap: 1 });
  }

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p += 1) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text(`KIRCHHOFF · ${i.id.slice(0, 18)}… · page ${p} of ${pages}`, M, H - 28);
  }
  return doc.output("blob");
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
