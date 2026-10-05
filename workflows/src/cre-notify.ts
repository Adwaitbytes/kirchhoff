import { consensusIdenticalAggregation, hexToBase64, HTTPClient, type HTTPSendRequester, type Runtime } from "@chainlink/cre-sdk";
import { stringToHex } from "viem";
import { buildNotifications, NOTIFY_SECRET_IDS, type Notification, type NotifySecrets } from "./notify.ts";

/** Reads the notify secrets this workflow is allowed to use (CRE `Secrets.CallLimit` is 5; this uses at most 3). */
export function readNotifySecrets<C>(runtime: Runtime<C>, allowed: readonly string[]): NotifySecrets {
  const wanted = new Set(allowed);
  const read = (id: string): string => (wanted.has(id) ? runtime.getSecret({ id }).result().value.trim() : "");
  return {
    telegramBotToken: read(NOTIFY_SECRET_IDS.telegramBotToken),
    telegramChatId: read(NOTIFY_SECRET_IDS.telegramChatId),
    slackWebhookUrl: read(NOTIFY_SECRET_IDS.slackWebhookUrl),
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

/** Pages every configured channel through the CRE HTTP capability; returns how many were sent. */
export function page<C>(runtime: Runtime<C>, text: string, idempotencyKey: Notification["idempotencyKey"], secrets: NotifySecrets): number {
  const { requests, skipped } = buildNotifications(text, idempotencyKey, secrets);
  for (const channel of skipped) runtime.log(`notify ${channel}: no webhook secret configured, skipped`);
  const http = new HTTPClient();
  for (const request of requests) {
    const status = http.sendRequest(runtime, post, consensusIdenticalAggregation<number>())(request).result();
    runtime.log(`notify ${request.channel}: HTTP ${status}${status >= 200 && status < 300 ? "" : " (not delivered)"}`);
  }
  return requests.length;
}
