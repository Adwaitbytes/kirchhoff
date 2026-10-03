/**
 * Standalone in-process RPC stubs for load and chaos runs: three chains, two providers each, on
 * fixed ports, seeded exactly like the test harness (CONSERVED, spec synced, debit visible).
 *
 *   node load/stub-chains.ts            # ports 18545-18550, writes load/payload.json and load/stub.env
 *
 * Chaos control on 127.0.0.1:18599 (scripts/chaos.sh):
 *   POST /<PREFIX_N>/down | /<PREFIX_N>/up | /<PREFIX_N>/rpc-error | /<PREFIX_N>/ok   e.g. /RPC_ETH_SEPOLIA_2/down
 *   POST /stale/on | /stale/off   every ledger reports stale (W2 paused past staleness_seconds)
 */
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { loadTokens } from "../src/spec-cache.ts";
import { RpcStub, ccipSendLogs, conservedLedger } from "../test/helpers/rpc-stub.ts";
import { AMOUNT, ARB, BASE, DEPLOYMENTS_PATH, HOME, MESSAGE_ID, SENDER, SOURCE_BLOCK, SOURCE_TX, SPEC_PATH, kethRequest } from "../test/helpers/harness.ts";

const here = (f: string): string => fileURLToPath(new URL(f, import.meta.url));
const [token] = loadTokens([SPEC_PATH], DEPLOYMENTS_PATH);
if (token === undefined) throw new Error("no token");

const chains = [
  { selector: HOME, prefix: "RPC_ETH_SEPOLIA", ports: [18545, 18546] },
  { selector: ARB, prefix: "RPC_ARB_SEPOLIA", ports: [18547, 18548] },
  { selector: BASE, prefix: "RPC_BASE_SEPOLIA", ports: [18549, 18550] },
] as const;

const env: string[] = [];
const stubs = new Map<string, RpcStub>();
for (const chain of chains) {
  const c = token.chains.get(chain.selector);
  if (c === undefined) throw new Error("chain missing");
  for (const [i, port] of chain.ports.entries()) {
    const stub = new RpcStub();
    stub.state.ledgers.set(c.ledger, conservedLedger());
    stub.state.quarantines.set(c.quarantine, { frozen: false, tainted: new Set() });
    if (chain.selector === token.registry.selector) stub.state.registries.set(token.registry.address, token.cachedSpecHash);
    if (chain.selector === ARB && c.pool !== null && c.onRamp !== null) {
      stub.state.logs.push(
        ...ccipSendLogs({ pool: c.pool, onRamp: c.onRamp, token: c.token, sender: SENDER, destSelector: HOME, messageId: MESSAGE_ID, amount: AMOUNT, txHash: SOURCE_TX, blockNumber: SOURCE_BLOCK }),
      );
    }
    await stub.start(port);
    stubs.set(`${chain.prefix}_${i + 1}`, stub);
    env.push(`${chain.prefix}_${i + 1}=${stub.url}`);
  }
}

writeFileSync(here("./payload.json"), `${JSON.stringify(kethRequest(token))}\n`);
writeFileSync(here("./stub.env"), `${env.join("\n")}\n`);
process.stdout.write(`stub chains up\n${env.join("\n")}\n`);

const ports = new Map<string, number>(chains.flatMap((c) => c.ports.map((port, i) => [`${c.prefix}_${i + 1}`, port] as const)));

async function control(path: string): Promise<string> {
  const [, target, action] = path.split("/");
  if (target === "stale") {
    for (const stub of stubs.values()) for (const l of stub.state.ledgers.values()) l.stale = action === "on";
    return `all ledgers stale=${action === "on" ? "true" : "false"}`;
  }
  const stub = target === undefined ? undefined : stubs.get(target);
  const port = target === undefined ? undefined : ports.get(target);
  if (stub === undefined || port === undefined) throw new Error(`unknown target ${target ?? ""}`);
  if (action === "down") await stub.stop();
  else if (action === "up") await stub.start(port);
  else if (action === "rpc-error") stub.failure = "rpc-error";
  else if (action === "ok") stub.failure = "none";
  else throw new Error(`unknown action ${action ?? ""}`);
  return `${target} ${action}`;
}

const controlServer = createServer((req, res) => {
  control(req.url ?? "/").then(
    (msg) => {
      process.stdout.write(`chaos: ${msg}\n`);
      res.end(`${msg}\n`);
    },
    (e: unknown) => {
      res.statusCode = 400;
      res.end(`${e instanceof Error ? e.message : String(e)}\n`);
    },
  );
});
controlServer.listen(18599, "127.0.0.1");
const stop = (): void => {
  controlServer.close();
  void Promise.all([...stubs.values()].map((s) => s.stop())).then(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
