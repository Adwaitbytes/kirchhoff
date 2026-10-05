import type { Queryable } from "./db.ts";

/**
 * Off-chain pager for the W3 path (PRD section 8, section 3 story 5, section 11 feature 2): one page
 * per incident per channel, ever. The idempotency key is the incident id (PagerDuty dedup_key too),
 * held in the `notifications` table, so restarts and retries never double-page. Every page carries
 * the exact deficit, the offending transaction link, what is already contained, the Incident Room
 * link and the narrative summary. Channels that are not configured are skipped.
 */

export type IncidentNotice = {
  incidentId: string;
  token: string;
  reason: string;
  /** Signed Δ after the breach, base units. */
  deficit: string;
  decimals: number;
  /** e.g. "WeakBridge credit on Ethereum Sepolia" or "Loop Rule BREACH report on Ethereum Sepolia". */
  offendingLabel: string;
  offendingTxUrl: string | null;
  /** One line per containment fact, e.g. "CCIP lanes frozen on Ethereum Sepolia, Base Sepolia". */
  contained: string[];
  /** Incident Room URL. */
  link: string | null;
  /** Narrative summary sentences joined, and the label it must carry. */
  summary: string;
  summaryLabel: string;
  simulation: boolean;
};

export type NotifierChannel = {
  name: "telegram" | "slack" | "pagerduty";
  send: (notice: IncidentNotice, signal: AbortSignal) => Promise<void>;
};

const MAX_ATTEMPTS = 5;

class NotifyHttpError extends Error {
  override readonly name = "NotifyHttpError";
}

export function formatUnits(amount: string, decimals: number): string {
  const neg = amount.startsWith("-");
  const digits = (neg ? amount.slice(1) : amount).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "").slice(0, 4);
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Deterministic page text. House style: no em dashes; demo pages are labeled as a simulation. */
export function incidentText(n: IncidentNotice): string {
  const lines = [
    `KIRCHHOFF: ${n.token} is BROKEN (${n.reason}). Deficit: ${formatUnits(n.deficit, n.decimals)} ${n.token}.`,
    `Offending: ${n.offendingLabel}${n.offendingTxUrl ? ` ${n.offendingTxUrl}` : ""}`,
    n.contained.length > 0 ? `Already contained: ${n.contained.join("; ")}.` : "Containment: pending.",
    `${n.summaryLabel} ${n.summary}`,
    `Incident ${n.incidentId}`,
  ];
  if (n.link) lines.push(`Incident Room: ${n.link}`);
  if (n.simulation) lines.push("Testnet simulation.");
  return lines.join("\n");
}

/** PagerDuty Events API v2 body. dedup_key = incident id, so PagerDuty also collapses duplicates. */
export function pagerDutyEvent(routingKey: string, n: IncidentNotice): Record<string, unknown> {
  const summary = `KIRCHHOFF: ${n.token} BROKEN (${n.reason}), deficit ${formatUnits(n.deficit, n.decimals)} ${n.token}${n.simulation ? " [Testnet simulation]" : ""}`;
  return {
    routing_key: routingKey,
    event_action: "trigger",
    dedup_key: n.incidentId,
    payload: {
      summary: summary.slice(0, 1024),
      source: "kirchhoff",
      severity: "critical",
      component: n.token,
      class: n.reason,
      custom_details: {
        deficit: `${formatUnits(n.deficit, n.decimals)} ${n.token}`,
        deficit_base_units: n.deficit,
        offending: n.offendingLabel,
        offending_tx: n.offendingTxUrl,
        already_contained: n.contained,
        narrative_label: n.summaryLabel,
        narrative: n.summary,
        incident_id: n.incidentId,
      },
    },
    links: [
      ...(n.link ? [{ href: n.link, text: "Incident Room" }] : []),
      ...(n.offendingTxUrl ? [{ href: n.offendingTxUrl, text: "Offending transaction" }] : []),
    ],
  };
}

export function channelsFromEnv(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): NotifierChannel[] {
  const channels: NotifierChannel[] = [];
  const post = async (url: string, body: unknown, signal: AbortSignal, label: string): Promise<void> => {
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    // URLs can embed secrets (bot token, webhook path), so errors carry only the channel and status.
    if (!res.ok) throw new NotifyHttpError(`${label} HTTP ${res.status}`);
  };
  const tgToken = env.TELEGRAM_BOT_TOKEN;
  const tgChat = env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) {
    channels.push({
      name: "telegram",
      send: (n, signal) => post(`https://api.telegram.org/bot${tgToken}/sendMessage`, { chat_id: tgChat, text: incidentText(n), disable_web_page_preview: true }, signal, "telegram"),
    });
  }
  const slack = env.SLACK_WEBHOOK_URL;
  if (slack) channels.push({ name: "slack", send: (n, signal) => post(slack, { text: incidentText(n) }, signal, "slack") });
  const pd = env.PAGERDUTY_ROUTING_KEY;
  if (pd) channels.push({ name: "pagerduty", send: (n, signal) => post("https://events.pagerduty.com/v2/enqueue", pagerDutyEvent(pd, n), signal, "pagerduty") });
  return channels;
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

  get channelNames(): string[] {
    return this.channels.map((c) => c.name);
  }

  /** Incidents with at least one configured channel not yet paged (and not out of retries). */
  async pending(sinceHours = 24): Promise<string[]> {
    if (!this.configured) return [];
    const r = await this.db.query<{ id: string }>(
      `select i.id from incidents i
       where i.opened_at > now() - make_interval(hours => $2)
         and exists (select 1 from unnest($1::text[]) ch(name)
                     where not exists (select 1 from notifications n where n.incident_id = i.id and n.channel = ch.name
                                       and (n.status = 'sent' or n.attempts >= $3)))
       order by i.opened_at`,
      [this.channelNames, sinceHours, MAX_ATTEMPTS],
    );
    return r.rows.map((x) => x.id);
  }

  /** Sends once per channel. Returns the channels actually sent on this call. */
  async notify(notice: IncidentNotice): Promise<string[]> {
    const sent: string[] = [];
    for (const ch of this.channels) {
      // Claim the (incident, channel) slot; only a fresh claim or a failed earlier attempt may send.
      const claim = await this.db.query(
        `insert into notifications (incident_id, channel, status, attempts, claimed_at) values ($1, $2, 'sending', 1, now())
         on conflict (incident_id, channel) do update set status = 'sending', attempts = notifications.attempts + 1, claimed_at = now()
           where notifications.attempts < $3
             and (notifications.status = 'failed' or (notifications.status = 'sending' and notifications.claimed_at < now() - interval '2 minutes'))
         returning attempts`,
        [notice.incidentId, ch.name, MAX_ATTEMPTS],
      );
      if (claim.rowCount === 0) continue;
      try {
        await ch.send(notice, AbortSignal.timeout(this.timeoutMs));
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
}
