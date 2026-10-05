/**
 * W3 Responder (PRD section 8): on `BreachRecorded` from the home ledger, applies QUARANTINE_APPLIED with the
 * tainted recipient to every ledger whose active incident is this one, then pages the issuer once per configured
 * channel through the HTTP capability with idempotency key = incident id. Webhook URLs and tokens come only from
 * CRE secrets; a channel whose secret is empty is skipped and logged.
 *
 * Trigger index: 0 = BreachRecorded on the home ledger.
 */
import { EVMClient, type EVMLog, handler, logTriggerConfig, Runner, type Runtime } from "@chainlink/cre-sdk";
import { MULTICALL3, type W3Config } from "@kirchhoff/engine";
import { ReadBudget } from "../src/budget.ts";
import { selectorMap } from "../src/chains.ts";
import { w3ConfigSchema, type W3ConfigInput } from "../src/config.ts";
import { creChainIo, fromCreLog } from "../src/cre-io.ts";
import { page, readNotifySecrets } from "../src/cre-notify.ts";
import { withBudget } from "../src/io.ts";
import { incidentText, runResponder } from "../src/w3.ts";

const onBreach = (runtime: Runtime<W3Config>, log: EVMLog): string => {
  const config = runtime.config;
  const budget = new ReadBudget();
  const io = withBudget(creChainIo(runtime, selectorMap(config.chains)), budget);
  const outcome = runResponder(io, config, MULTICALL3, fromCreLog(log));
  runtime.log(`W3 reads used ${budget.used}/15: ${budget.describe()}`);
  if (outcome.kind === "ignored") return `ignored: ${outcome.reason}`;

  if (!config.onBroken.includes("page_issuer")) return `${outcome.incidentId} contained; paging disabled by spec`;
  const sent = page(runtime, incidentText(config.token, outcome.incidentId, outcome.breach), outcome.incidentId, readNotifySecrets(runtime, config.notifySecrets));
  return `${outcome.incidentId} quarantined on ${outcome.writes.length} chain(s); notified ${sent}`;
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
