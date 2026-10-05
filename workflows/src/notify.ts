import type { Hex } from "@kirchhoff/engine";

/** CRE secret ids, matching workflows/secrets.yaml and the compiler's `notifySecrets`. */
export const NOTIFY_SECRET_IDS = {
  telegramBotToken: "NOTIFY_TELEGRAM_BOT_TOKEN",
  telegramChatId: "NOTIFY_TELEGRAM_CHAT_ID",
  slackWebhookUrl: "NOTIFY_SLACK_WEBHOOK_URL",
} as const;

export type NotifySecrets = { telegramBotToken: string; telegramChatId: string; slackWebhookUrl: string };

export type Notification = { channel: "telegram" | "slack"; url: string; body: string; idempotencyKey: Hex };

/**
 * One request per configured channel; a channel whose secret is empty is skipped, never an error. Every DON node
 * sends the request, so the caller's idempotency key (incident id, or drift key) is what keeps a page single.
 */
export function buildNotifications(text: string, idempotencyKey: Hex, secrets: NotifySecrets): { requests: Notification[]; skipped: string[] } {
  const requests: Notification[] = [];
  const skipped: string[] = [];
  if (secrets.telegramBotToken !== "" && secrets.telegramChatId !== "") {
    requests.push({
      channel: "telegram",
      url: `https://api.telegram.org/bot${secrets.telegramBotToken}/sendMessage`,
      body: JSON.stringify({ chat_id: secrets.telegramChatId, text, disable_web_page_preview: true }),
      idempotencyKey,
    });
  } else skipped.push("telegram");
  if (secrets.slackWebhookUrl !== "") {
    requests.push({ channel: "slack", url: secrets.slackWebhookUrl, body: JSON.stringify({ text }), idempotencyKey });
  } else skipped.push("slack");
  return { requests, skipped };
}
