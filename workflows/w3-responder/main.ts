/**
 * W3 Responder (PRD section 8): on `BreachRecorded` from the home ledger, applies QUARANTINE_APPLIED with the
 * tainted recipient to every ledger whose active incident is this one, then pages the issuer once per configured
 * channel through the HTTP capability with idempotency key = incident id. Webhook URLs and tokens come only from
 * CRE secrets; a channel whose secret is empty is skipped and logged.
 *
 * Trigger index: 0 = BreachRecorded on the home ledger.
 */
import {
  consensusIdenticalAggregation,
  EVMClient,
  type EVMLog,
  handler,
  hexToBase64,
  HTTPClient,
  type HTTPSendRequester,
  logTriggerConfig,
  Runner,
  type Runtime,
} from "@chainlink/cre-sdk";
import { MULTICALL3, type W3Config } from "@kirchhoff/engine";
import { stringToHex } from "viem";
import { ReadBudget } from "../src/budget.ts";
import { selectorMap } from "../src/chains.ts";
import { w3ConfigSchema, type W3ConfigInput } from "../src/config.ts";
import { creChainIo, fromCreLog } from "../src/cre-io.ts";
import { withBudget } from "../src/io.ts";
import { buildNotifications, runResponder, type Notification, type NotifySecrets } from "../src/w3.ts";

/** Secret ids, matching workflows/secrets.yaml and the compiler's notifySecrets. */
const SECRET_IDS = {
  telegramBotToken: "NOTIFY_TELEGRAM_BOT_TOKEN",
  telegramChatId: "NOTIFY_TELEGRAM_CHAT_ID",
  slackWebhookUrl: "NOTIFY_SLACK_WEBHOOK_URL",
} as const;

function readSecrets(runtime: Runtime<W3Config>): NotifySecrets {
  const wanted = new Set(runtime.config.notifySecrets);
  const read = (id: string): string => (wanted.has(id) ? runtime.getSecret({ id }).result().value.trim() : "");
  return {
    telegramBotToken: read(SECRET_IDS.telegramBotToken),
    telegramChatId: read(SECRET_IDS.telegramChatId),
    slackWebhookUrl: read(SECRET_IDS.slackWebhookUrl),
  };
}

/** Runs on every node; nodes share one cached response (10 minutes) so the receiver sees the POST once. */
const post = (requester: HTTPSendRequester, n: Notification): number =>
  requester
    .sendRequest({
      url: n.url,
      method: "POST",
      body: hexToBase64(stringToHex(n.body)),
      headers: { "Content-Type": "application/json", "Idempotency-Key": n.idempotencyKey },
      cacheSettings: { store: true, maxAge: "600s" },
    })
    .result().statusCode;

const onBreach = (runtime: Runtime<W3Config>, log: EVMLog): string => {
  const config = runtime.config;
  const budget = new ReadBudget();
  const io = withBudget(creChainIo(runtime, selectorMap(config.chains)), budget);
  const outcome = runResponder(io, config, MULTICALL3, fromCreLog(log));
  runtime.log(`W3 reads used ${budget.used}/15: ${budget.describe()}`);
  if (outcome.kind === "ignored") return `ignored: ${outcome.reason}`;

  if (!config.onBroken.includes("page_issuer")) return `${outcome.incidentId} contained; paging disabled by spec`;
  const { requests, skipped } = buildNotifications(config.token, outcome.incidentId, outcome.breach, readSecrets(runtime));
  for (const channel of skipped) runtime.log(`notify ${channel}: no webhook secret configured, skipped`);
  const http = new HTTPClient();
  for (const request of requests) {
    const status = http.sendRequest(runtime, post, consensusIdenticalAggregation<number>())(request).result();
    runtime.log(`notify ${request.channel}: HTTP ${status}${status >= 200 && status < 300 ? "" : " (not delivered)"}`);
  }
  return `${outcome.incidentId} quarantined on ${outcome.writes.length} chain(s); notified ${requests.length}`;
};

const initWorkflow = (config: W3Config) => {
  const selector = selectorMap(config.chains).get(config.breachTrigger.chain);
  if (selector === undefined) throw new Error(`no selector for ${config.breachTrigger.chain}`);
  return [
    handler(
      new EVMClient(selector).logTrigger(
        logTriggerConfig({ addresses: [config.breachTrigger.address], topics: [[config.breachTrigger.topic0]], confidence: config.breachTrigger.confidence }),
      ),
      onBreach,
    ),
  ];
};

export async function main(): Promise<void> {
  const runner = await Runner.newRunner<W3Config, W3ConfigInput>({ configSchema: w3ConfigSchema });
  await runner.run(initWorkflow);
}
