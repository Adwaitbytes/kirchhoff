import { CHAINS, isChainKey } from "@kirchhoff/sdk";
import type { Queryable } from "./db.ts";

/**
 * Off-chain pager for the W3 path (PRD section 8): one message per incident per channel, ever.
 * The idempotency key is the incident id, held in the `notifications` table, so a crash between
 * send and commit, an indexer restart, or W3 retrying can never double-page.
 */
export type NotifierChannel = {
  name: "telegram" | "slack";
  send: (text: string, signal: AbortSignal) => Promise<void>;
};

export type IncidentNotice = {
  incidentId: string;
  token: string;
  reason: string;
  amount: string;
  decimals: number;
  chain: string | null;
  recipient: string;
  link: string | null;
};

const MAX_ATTEMPTS = 5;

class NotifyHttpError extends Error {
  override readonly name = "NotifyHttpError";
}

export function channelsFromEnv(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): NotifierChannel[] {
  const channels: NotifierChannel[] = [];
  const tgToken = env.TELEGRAM_BOT_TOKEN;
  const tgChat = env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) {
    channels.push({
      name: "telegram",
      send: async (text, signal) => {
        const res = await fetchImpl(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: tgChat, text, disable_web_page_preview: true }),
          signal,
        });
        // The URL embeds the bot token, so errors carry only the status.
        if (!res.ok) throw new NotifyHttpError(`telegram HTTP ${res.status}`);
      },
    });
  }
  const slack = env.SLACK_WEBHOOK_URL;
  if (slack) {
    channels.push({
      name: "slack",
      send: async (text, signal) => {
        const res = await fetchImpl(slack, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal });
        if (!res.ok) throw new NotifyHttpError(`slack HTTP ${res.status}`);
      },
    });
  }
  return channels;
}

function formatUnits(amount: string, decimals: number): string {
  const neg = amount.startsWith("-");
  const digits = (neg ? amount.slice(1) : amount).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "").slice(0, 4);
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Deterministic page text. House style: no em dashes; the demo is labeled as a simulation. */
export function incidentText(n: IncidentNotice): string {
  const where = n.chain && isChainKey(n.chain) ? CHAINS[n.chain].label : "an unknown chain";
  const lines = [
    `KIRCHHOFF: ${n.token} is BROKEN (${n.reason}).`,
    `Offending credit of ${formatUnits(n.amount, n.decimals)} ${n.token} on ${where} to ${n.recipient}.`,
    "Containment per spec: CCIP lanes frozen, recipient tainted, feed flipped.",
    `Incident ${n.incidentId}`,
    "Testnet simulation.",
  ];
  if (n.link) lines.push(n.link);
  return lines.join("\n");
}

export class Notifier {
  private readonly db: Queryable;
  private readonly channels: readonly NotifierChannel[];
  private readonly timeoutMs: number;

  constructor(db: Queryable, channels: readonly NotifierChannel[], timeoutMs = 5_000) {
    this.db = db;
    this.channels = channels;
    this.timeoutMs = timeoutMs;
  }

  get configured(): boolean {
    return this.channels.length > 0;
  }

  /** Sends once per channel. Returns the channels actually sent on this call (empty when already sent or unconfigured). */
  async notify(notice: IncidentNotice): Promise<string[]> {
    const sent: string[] = [];
    for (const ch of this.channels) {
      // Claim the (incident, channel) slot; only a fresh claim or a failed earlier attempt may send.
      const claim = await this.db.query(
        `insert into notifications (incident_id, channel, status, attempts) values ($1, $2, 'sending', 1)
         on conflict (incident_id, channel) do update set status = 'sending', attempts = notifications.attempts + 1
           where notifications.status = 'failed' and notifications.attempts < $3
         returning attempts`,
        [notice.incidentId, ch.name, MAX_ATTEMPTS],
      );
      if (claim.rowCount === 0) continue;
      try {
        await ch.send(incidentText(notice), AbortSignal.timeout(this.timeoutMs));
        await this.db.query("update notifications set status = 'sent', sent_at = now(), last_error = null where incident_id = $1 and channel = $2", [notice.incidentId, ch.name]);
        sent.push(ch.name);
      } catch (e) {
        const message = e instanceof NotifyHttpError ? e.message : `${ch.name} send failed`;
        await this.db.query("update notifications set status = 'failed', last_error = $3 where incident_id = $1 and channel = $2", [notice.incidentId, ch.name, message]);
        console.error(`kirchhoff notifier: ${message} for incident ${notice.incidentId}`);
      }
    }
    return sent;
  }

  /** Loads the incident from the read model and notifies. Skips silently when no channel is configured. */
  async notifyIncident(incidentId: string, linkBase: string | null): Promise<string[]> {
    if (!this.configured) return [];
    const r = await this.db.query<{ token_symbol: string; reason: string; amount: string; offending_chain: string | null; recipient: string; decimals: number }>(
      `select i.token_symbol, i.reason, i.amount, i.offending_chain, i.recipient, t.decimals
       from incidents i join tokens t on t.symbol = i.token_symbol where i.id = $1`,
      [incidentId],
    );
    const row = r.rows[0];
    if (!row) return [];
    return this.notify({
      incidentId,
      token: row.token_symbol,
      reason: row.reason,
      amount: row.amount,
      decimals: row.decimals,
      chain: row.offending_chain,
      recipient: row.recipient,
      link: linkBase ? `${linkBase.replace(/\/+$/, "")}/incidents/${incidentId}` : null,
    });
  }
}
