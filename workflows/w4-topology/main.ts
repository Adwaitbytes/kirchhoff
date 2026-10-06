/**
 * W4 Topology Watch (PRD section 8): reloads the active spec and checks that every account able to mint, the CCIP
 * pool registered for the token and that pool's peers all match it. Any difference raises EPOCH DRIFT with reason
 * SPEC_MISMATCH and pages the issuer through the HTTP capability (CRE secrets, idempotency key = drift key).
 *
 * Trigger indexes: 0 = SpecActivated (home registry, this token), 1 = cron, then RoleGranted(MINTER_ROLE) per remote
 * chain (kETH: 2 = arb, 3 = base), then CCIP TokenAdminRegistry PoolSet(token) per chain that has a registry
 * (public testnets: 4 = home, 5 = arb, 6 = base; none on Anvil).
 *
 * Production deploys W4's handlers inside W2 (CRE allows 3 workflows per org, INTERFACES.md Revision 2 item 6),
 * so its EPOCH is sent under W2's workflow id, which the ledger authorizes for EPOCH.
 */
import { CronCapability, EVMClient, type EVMLog, handler, logTriggerConfig, Runner, type Runtime } from "@chainlink/cre-sdk";
import { MULTICALL3, type W4Config } from "@kirchhoff/engine";
import { encodeEventTopics, pad } from "viem";
import { ReadBudget } from "../src/budget.ts";
import { selectorMap, unixSeconds } from "../src/chains.ts";
import { w4ConfigSchema, type W4ConfigInput } from "../src/config.ts";
import { creChainIo, fromCreLog } from "../src/cre-io.ts";
import { page, readNotifySecrets } from "../src/cre-notify.ts";
import { withBudget } from "../src/io.ts";
import { poolSetChains, runTopology, TOPOLOGY_ABI, watchedChains, type TopologyTrigger } from "../src/w4.ts";

const POOL_SET = encodeEventTopics({ abi: TOPOLOGY_ABI, eventName: "PoolSet" })[0];

const run = (runtime: Runtime<W4Config>, trigger: TopologyTrigger): string => {
  const config = runtime.config;
  const budget = new ReadBudget();
  const io = withBudget(creChainIo(runtime, selectorMap(config.chains)), budget);
  const outcome = runTopology(io, config, MULTICALL3, trigger, unixSeconds(runtime.now()));
  runtime.log(`W4 reads used ${budget.used}/15: ${budget.describe()}`);
  let sent = 0;
  if (outcome.text !== null && outcome.driftKey !== null) {
    sent = page(runtime, outcome.text, outcome.driftKey, readNotifySecrets(runtime, config.notifySecrets));
  }
  return `findings=${outcome.findings.length} writes=${outcome.writes.length} notified=${sent}`;
};

const initWorkflow = (config: W4Config) => {
  const selectors = selectorMap(config.chains);
  const client = (chain: string): EVMClient => {
    const selector = selectors.get(chain);
    if (selector === undefined) throw new Error(`no selector for ${chain}`);
    return new EVMClient(selector);
  };
  if (typeof POOL_SET !== "string") throw new Error("PoolSet topic missing");
  return [
    handler(
      client(config.registry.chain).logTrigger(
        logTriggerConfig({ addresses: [config.registry.address], topics: [[config.registry.specActivatedTopic0], [config.tokenId]] }),
      ),
      (runtime: Runtime<W4Config>, log: EVMLog) => run(runtime, { kind: "spec", log: fromCreLog(log) }),
    ),
    handler(new CronCapability().trigger({ schedule: config.schedule }), (runtime: Runtime<W4Config>) => run(runtime, { kind: "scan" })),
    ...watchedChains(config).map((chain) =>
      handler(
        client(chain.name).logTrigger(
          logTriggerConfig({ addresses: [chain.token], topics: [[config.roleGrantedTopic0], [config.minterRole]], confidence: chain.triggerConfidence }),
        ),
        (runtime: Runtime<W4Config>, log: EVMLog) => run(runtime, { kind: "grant", chain: chain.name, log: fromCreLog(log) }),
      ),
    ),
    ...poolSetChains(config).map((chain) =>
      handler(
        client(chain.name).logTrigger(
          logTriggerConfig({ addresses: [chain.tokenAdminRegistry], topics: [[POOL_SET], [pad(chain.token)]], confidence: chain.triggerConfidence }),
        ),
        (runtime: Runtime<W4Config>, log: EVMLog) => run(runtime, { kind: "pool", chain: chain.name, log: fromCreLog(log) }),
      ),
    ),
  ];
};

export async function main(): Promise<void> {
  const runner = await Runner.newRunner<W4Config, W4ConfigInput>({ configSchema: w4ConfigSchema });
  await runner.run(initWorkflow);
}
