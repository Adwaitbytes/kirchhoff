/**
 * W1 Junction Watch (PRD section 8): one EVM log trigger per chain on every credit event of the spec's bridges
 * (WeakBridge / HomeEscrowAdapter `Released`, CCIP OffRamp `ExecutionStateChanged` paired with the pool's
 * `ReleasedOrMinted`). A credit with no matching, unconsumed, confident debit is written as BREACH to the ledger
 * on every chain in this same run.
 *
 * Trigger indexes (`cre workflow simulate --trigger-index`): one per chain in config.chains order that has a credit
 * emitter; for kETH 0 = home, 1 = arb, 2 = base.
 */
import { EVMClient, type EVMLog, handler, logTriggerConfig, Runner, type Runtime } from "@chainlink/cre-sdk";
import { reviveSpec, type W1Config } from "@kirchhoff/engine";
import { ReadBudget } from "../src/budget.ts";
import { selectorMap, unixSeconds } from "../src/chains.ts";
import { w1ConfigSchema, type W1ConfigInput } from "../src/config.ts";
import { creChainIo, fromCreLog } from "../src/cre-io.ts";
import { withBudget } from "../src/io.ts";
import { creditTriggerGroups, runJunction } from "../src/w1.ts";

const onCredit =
  (chain: string) =>
  (runtime: Runtime<W1Config>, log: EVMLog): string => {
    const config = runtime.config;
    const budget = new ReadBudget();
    const io = withBudget(creChainIo(runtime, selectorMap(config.chains)), budget);
    const outcome = runJunction(io, config, reviveSpec(config.spec), chain, fromCreLog(log), unixSeconds(runtime.now()));
    runtime.log(`W1 reads used ${budget.used}/15: ${budget.describe()}`);
    if (outcome.kind === "ignored") return `ignored: ${outcome.reason}`;
    return `${outcome.credit.messageId} status=${outcome.verdict.status} reason=${outcome.verdict.reason} writes=${outcome.writes.length}`;
  };

const initWorkflow = (config: W1Config) =>
  creditTriggerGroups(config).map((group) => {
    const selector = selectorMap(config.chains).get(group.chain);
    if (selector === undefined) throw new Error(`no selector for ${group.chain}`);
    return handler(
      new EVMClient(selector).logTrigger(
        logTriggerConfig({ addresses: group.addresses, topics: [group.topic0s], confidence: group.confidence }),
      ),
      onCredit(group.chain),
    );
  });

export async function main(): Promise<void> {
  const runner = await Runner.newRunner<W1Config, W1ConfigInput>({ configSchema: w1ConfigSchema });
  await runner.run(initWorkflow);
}
