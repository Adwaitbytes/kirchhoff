/**
 * W4 Topology Watch (PRD section 8): on `SpecActivated`, every 10 minutes, and on every minter-role grant of the
 * protected token, checks that every account able to mint is listed in the spec. An unlisted minter raises EPOCH
 * DRIFT with reason SPEC_MISMATCH.
 *
 * Trigger indexes: 0 = SpecActivated on the home registry, 1 = cron, then one RoleGranted(MINTER_ROLE) trigger per
 * remote chain in config.chains order (kETH: 2 = arb, 3 = base).
 *
 * Production deploys W4's handlers inside W2 (CRE allows 3 workflows per org, INTERFACES.md Revision 2 item 6),
 * so its EPOCH is sent under W2's workflow id, which the ledger authorizes for EPOCH.
 */
import { CronCapability, EVMClient, type EVMLog, handler, logTriggerConfig, Runner, type Runtime } from "@chainlink/cre-sdk";
import { MULTICALL3, type W4Config } from "@kirchhoff/engine";
import { ReadBudget } from "../src/budget.ts";
import { selectorMap, unixSeconds } from "../src/chains.ts";
import { w4ConfigSchema, type W4ConfigInput } from "../src/config.ts";
import { creChainIo, fromCreLog } from "../src/cre-io.ts";
import { withBudget } from "../src/io.ts";
import { runTopology, watchedChains } from "../src/w4.ts";

const scan =
  (grantChain: string | null) =>
  (runtime: Runtime<W4Config>, log: EVMLog | null): string => {
    const config = runtime.config;
    const budget = new ReadBudget();
    const io = withBudget(creChainIo(runtime, selectorMap(config.chains)), budget);
    const grant = grantChain === null || log === null ? null : { chain: grantChain, log: fromCreLog(log) };
    const outcome = runTopology(io, config, MULTICALL3, grant, unixSeconds(runtime.now()));
    runtime.log(`W4 reads used ${budget.used}/15: ${budget.describe()}`);
    return `findings=${outcome.findings.length} writes=${outcome.writes.length}`;
  };

const initWorkflow = (config: W4Config) => {
  const selectors = selectorMap(config.chains);
  const client = (chain: string): EVMClient => {
    const selector = selectors.get(chain);
    if (selector === undefined) throw new Error(`no selector for ${chain}`);
    return new EVMClient(selector);
  };
  const fullScan = scan(null);
  return [
    handler(
      client(config.registry.chain).logTrigger(
        logTriggerConfig({ addresses: [config.registry.address], topics: [[config.registry.specActivatedTopic0], [config.tokenId]] }),
      ),
      (runtime: Runtime<W4Config>) => fullScan(runtime, null),
    ),
    handler(new CronCapability().trigger({ schedule: config.schedule }), (runtime: Runtime<W4Config>) => fullScan(runtime, null)),
    ...watchedChains(config).map((chain) =>
      handler(
        client(chain.name).logTrigger(
          logTriggerConfig({
            addresses: [chain.token],
            topics: [[config.roleGrantedTopic0], [config.minterRole]],
            confidence: chain.triggerConfidence,
          }),
        ),
        (runtime: Runtime<W4Config>, log: EVMLog) => scan(chain.name)(runtime, log),
      ),
    ),
  ];
};

export async function main(): Promise<void> {
  const runner = await Runner.newRunner<W4Config, W4ConfigInput>({ configSchema: w4ConfigSchema });
  await runner.run(initWorkflow);
}
