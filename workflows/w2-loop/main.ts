/**
 * W2 Loop Ledger (PRD section 8): every 30 s, and immediately on any supply change, pins one block per chain,
 * reads backing and supply with one Multicall3 call per chain, derives in-flight value by message matching, runs
 * the engine Loop Rule and writes EPOCH (or BREACH, or RECOVERY_CHECK) to the ledger on every chain.
 *
 * Trigger indexes: 0 = cron; then the supply triggers of `supplyTriggerFilters` in config.chains order, two per
 * chain (kETH: 1-2 home escrow in/out, 3-4 arb mint/burn, 5-6 base mint/burn).
 */
import { CronCapability, EVMClient, handler, logTriggerConfig, Runner, type Runtime } from "@chainlink/cre-sdk";
import { reviveSpec, type W2Config } from "@kirchhoff/engine";
import { ReadBudget } from "../src/budget.ts";
import { selectorMap, unixSeconds } from "../src/chains.ts";
import { w2ConfigSchema, type W2ConfigInput } from "../src/config.ts";
import { creChainIo } from "../src/cre-io.ts";
import { withBudget } from "../src/io.ts";
import { runLoop, supplyTriggerFilters } from "../src/w2.ts";

const onEpoch = (runtime: Runtime<W2Config>): string => {
  const config = runtime.config;
  const budget = new ReadBudget();
  const io = withBudget(creChainIo(runtime, selectorMap(config.chains)), budget);
  const outcome = runLoop(io, config, reviveSpec(config.spec), unixSeconds(runtime.now()));
  runtime.log(`W2 reads used ${budget.used}/15: ${budget.describe()}`);
  return `epoch ${outcome.epochId} status=${outcome.result.status} reason=${outcome.result.reason} delta=${outcome.result.delta} writes=${outcome.writes.length}`;
};

const initWorkflow = (config: W2Config) => {
  const selectors = selectorMap(config.chains);
  return [
    handler(new CronCapability().trigger({ schedule: config.schedule }), onEpoch),
    ...supplyTriggerFilters(config).map((t) => {
      const selector = selectors.get(t.chain);
      if (selector === undefined) throw new Error(`no selector for ${t.chain}`);
      return handler(
        new EVMClient(selector).logTrigger(logTriggerConfig({ addresses: [t.address], topics: t.topics, confidence: t.confidence })),
        onEpoch,
      );
    }),
  ];
};

export async function main(): Promise<void> {
  const runner = await Runner.newRunner<W2Config, W2ConfigInput>({ configSchema: w2ConfigSchema });
  await runner.run(initWorkflow);
}
