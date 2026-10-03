import { CONTRACT_EVENTS, incidentId, reasonName, ReportType, Status, toReason, type Hex, type W3Config } from "@kirchhoff/engine";
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, parseAbiItem, type AbiEvent } from "viem";
import { LEDGER_ABI } from "./abi.ts";
import { ledgerTargets, statusLabel, type ChainEntry } from "./chains.ts";
import type { ChainIo, ChainLog } from "./io.ts";
import { decodeAggregate3, encodeAggregate3, successful } from "./multicall.ts";
import { writeToLedgers, type WriteResult } from "./reports.ts";

const BREACH_RECORDED = parseAbiItem(`event ${CONTRACT_EVENTS.BreachRecorded}`) as AbiEvent;
const ZERO_ADDRESS: Hex = "0x0000000000000000000000000000000000000000";

export type BreachEvent = {
  tokenId: Hex;
  reason: number;
  evidenceHash: Hex;
  offendingChain: bigint;
  offendingTx: Hex;
  recipient: Hex;
  amount: bigint;
};

export function decodeBreach(log: ChainLog): BreachEvent {
  const { args } = decodeEventLog({ abi: [BREACH_RECORDED], data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
  const value = (name: string): unknown => (args as Readonly<Record<string, unknown>>)[name];
  const hex = (name: string): Hex => {
    const v = value(name);
    if (typeof v !== "string" || !v.startsWith("0x")) throw new Error(`BreachRecorded.${name} is not hex`);
    return v.toLowerCase() as Hex;
  };
  const int = (name: string): bigint => {
    const v = value(name);
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(v);
    throw new Error(`BreachRecorded.${name} is not an integer`);
  };
  return {
    tokenId: hex("tokenId"),
    reason: Number(int("reason")),
    evidenceHash: hex("evidenceHash"),
    offendingChain: int("offendingChain"),
    offendingTx: hex("offendingTx"),
    recipient: hex("recipient"),
    amount: int("amount"),
  };
}

export type ContainmentState = { chain: ChainEntry; status: number; activeIncident: Hex };

/** One aggregate3 per chain: status and active incident at the latest block. 3 reads for 3 chains. */
export function readContainment(io: ChainIo, config: W3Config, multicall3: Hex): ContainmentState[] {
  return config.chains.map((chain) => {
    const calls = [
      { target: chain.ledger, callData: encodeFunctionData({ abi: LEDGER_ABI, functionName: "statusOf", args: [config.tokenId] }) },
      { target: chain.ledger, callData: encodeFunctionData({ abi: LEDGER_ABI, functionName: "activeIncident", args: [config.tokenId] }) },
    ];
    const results = decodeAggregate3(io.call(chain.name, multicall3, encodeAggregate3(calls), { tag: "latest" }), calls.length);
    const [status] = decodeFunctionResult({ abi: LEDGER_ABI, functionName: "statusOf", data: successful(results[0], `${chain.name} statusOf`) });
    const active = decodeFunctionResult({ abi: LEDGER_ABI, functionName: "activeIncident", data: successful(results[1], `${chain.name} activeIncident`) });
    return { chain, status, activeIncident: active.toLowerCase() as Hex };
  });
}

export type ResponderOutcome =
  | { kind: "ignored"; reason: string }
  | { kind: "contained"; incidentId: Hex; breach: BreachEvent; writes: WriteResult[]; skipped: string[] };

/**
 * PRD section 8 W3: QUARANTINE_APPLIED to every ledger whose active incident is this one and is still BROKEN
 * (contracts/README.md decision 6: any other incident id reverts). Extra evidence on an already contained token
 * (status unchanged, different active incident) needs no new quarantine: its recipient was tainted by the BREACH.
 */
export function runResponder(io: ChainIo, config: W3Config, multicall3: Hex, log: ChainLog): ResponderOutcome {
  const breach = decodeBreach(log);
  if (breach.tokenId !== config.tokenId.toLowerCase()) return { kind: "ignored", reason: `breach for token ${breach.tokenId}, not ${config.token}` };
  const id = incidentId(breach.tokenId, breach.evidenceHash).toLowerCase() as Hex;
  io.log(`incident ${id}: reason ${breach.reason} recipient ${breach.recipient} amount ${breach.amount}`);

  const states = readContainment(io, config, multicall3);
  const tainted = breach.recipient === ZERO_ADDRESS ? [] : [breach.recipient];
  const targets = ledgerTargets(config.chains);
  const due = states.filter((s) => s.status === Status.BROKEN && s.activeIncident === id);
  const skipped = states
    .filter((s) => !due.includes(s))
    .map((s) => `${s.chain.name}: ${statusLabel(s.status)} with active incident ${s.activeIncident}`);
  for (const line of skipped) io.log(`skip QUARANTINE_APPLIED on ${line}`);
  const writes = writeToLedgers(
    io,
    targets.filter((t) => due.some((s) => s.chain.name === t.chain)),
    config.tokenId,
    { reportType: ReportType.QUARANTINE_APPLIED, payload: { incidentId: id, tainted } },
  );
  return { kind: "contained", incidentId: id, breach, writes, skipped };
}

export type NotifySecrets = { telegramBotToken: string; telegramChatId: string; slackWebhookUrl: string };

export type Notification = { channel: "telegram" | "slack"; url: string; body: string; idempotencyKey: Hex };

function reasonText(reason: number): string {
  try {
    return reasonName(toReason(reason));
  } catch {
    // An unknown code still pages; the number is the evidence.
    return `reason ${reason}`;
  }
}

export function incidentText(token: string, id: Hex, breach: BreachEvent): string {
  return [
    `KIRCHHOFF: ${token} BROKEN (${reasonText(breach.reason)})`,
    `incident ${id}`,
    `offending chain ${breach.offendingChain} tx ${breach.offendingTx}`,
    `recipient ${breach.recipient} amount ${breach.amount}`,
    "CCIP lanes frozen, recipient tainted, feed flipped. Replay requires the issuer Safe.",
  ].join("\n");
}

/**
 * One request per configured channel; a channel whose secret is empty is skipped, never an error. The
 * idempotency key is the incident id: every DON node sends the request, and retries must never double-page.
 */
export function buildNotifications(token: string, id: Hex, breach: BreachEvent, secrets: NotifySecrets): { requests: Notification[]; skipped: string[] } {
  const text = incidentText(token, id, breach);
  const requests: Notification[] = [];
  const skipped: string[] = [];
  if (secrets.telegramBotToken !== "" && secrets.telegramChatId !== "") {
    requests.push({
      channel: "telegram",
      url: `https://api.telegram.org/bot${secrets.telegramBotToken}/sendMessage`,
      body: JSON.stringify({ chat_id: secrets.telegramChatId, text, disable_web_page_preview: true }),
      idempotencyKey: id,
    });
  } else skipped.push("telegram");
  if (secrets.slackWebhookUrl !== "") {
    requests.push({ channel: "slack", url: secrets.slackWebhookUrl, body: JSON.stringify({ text }), idempotencyKey: id });
  } else skipped.push("slack");
  return { requests, skipped };
}
