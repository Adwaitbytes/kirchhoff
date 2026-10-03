/**
 * A Judge wired to six in-process RPC stubs (three chains, two providers each) and the real kETH
 * spec resolved against test/fixtures/deployments.test.json. Every test starts from a CONSERVED,
 * synced, debit-visible state and mutates only what it exercises.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import type { AuthConfig } from "../../src/config.ts";
import { createLogger, type Logger } from "../../src/log.ts";
import { createMetrics, type JudgeMetrics } from "../../src/metrics.ts";
import { createProviders, type ChainProviders } from "../../src/rpc.ts";
import { compileValidators, type EvaluateRequest } from "../../src/schema.ts";
import { createJudgeServer } from "../../src/server.ts";
import { SpecCache, loadTokens, type ProtectedToken } from "../../src/spec-cache.ts";
import { HEADER_API_KEY, HEADER_SIGNATURE, HEADER_TIMESTAMP, sign, stringToSign } from "../../src/hmac.ts";
import { RpcStub, ccipSendLogs, conservedLedger, type LedgerState } from "./rpc-stub.ts";

export const SPEC_PATH = fileURLToPath(new URL("../../../engine/specs/kETH.yaml", import.meta.url));
export const DEPLOYMENTS_PATH = fileURLToPath(new URL("../fixtures/deployments.test.json", import.meta.url));

export const HOME = 16015286601757825753n;
export const ARB = 3478487238524512106n;
export const BASE = 10344971235874465080n;

export const API_KEY = "3f2b7c58-6d41-4a9e-8b0c-1d2e3f405162";
export const SECRET_HEX = "a1".repeat(32);

export const MESSAGE_ID: Hex = "0x9f2b1c0d5e4a3b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4";
export const SOURCE_TX: Hex = "0x4c0f2a9b8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605f4e3";
export const SENDER: Hex = "0x1111111111111111111111111111111111111111";
export const RECEIVER: Hex = "0x2222222222222222222222222222222222222222";
export const AMOUNT = 10n * 10n ** 18n;
export const SOURCE_BLOCK = 1837421n;

export function pad32(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

export type Harness = {
  url: string;
  token: ProtectedToken;
  stubs: ReadonlyMap<bigint, readonly [RpcStub, RpcStub]>;
  cache: SpecCache;
  metrics: JudgeMetrics;
  logs: string[];
  /** Applies a change to both providers of a chain. */
  both(chain: bigint, change: (stub: RpcStub) => void): void;
  ledger(chain: bigint, provider: 0 | 1): LedgerState;
  close(): Promise<void>;
};

export type HarnessOptions = {
  auth?: AuthConfig;
  budgetMs?: number;
  basePath?: string;
  syncNow?: boolean;
  /** Alternative deployment record; the default arb debit log is only seeded for the default one. */
  deploymentsPath?: string;
};

export function contractsOn(token: ProtectedToken, chain: bigint) {
  const c = token.chains.get(chain);
  if (c === undefined) throw new Error(`chain ${chain.toString()} not in spec`);
  return c;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const [token] = loadTokens([SPEC_PATH], options.deploymentsPath ?? DEPLOYMENTS_PATH);
  if (token === undefined) throw new Error("no token");
  const stubs = new Map<bigint, readonly [RpcStub, RpcStub]>();
  const providers = new Map<bigint, ChainProviders>();
  for (const selector of [HOME, ARB, BASE]) {
    const pair = [new RpcStub(), new RpcStub()] as const;
    await Promise.all(pair.map((s) => s.start()));
    const c = contractsOn(token, selector);
    for (const s of pair) {
      s.state.ledgers.set(c.ledger, conservedLedger());
      s.state.quarantines.set(c.quarantine, { frozen: false, tainted: new Set() });
      if (selector === token.registry.selector) s.state.registries.set(token.registry.address, token.cachedSpecHash);
    }
    stubs.set(selector, pair);
    providers.set(selector, createProviders(c.name, [pair[0].url, pair[1].url], options.budgetMs ?? 2000));
  }
  const arb = contractsOn(token, ARB);
  if (arb.pool === null || arb.onRamp === null) throw new Error("deployments lack the arb CCIP pool or onramp");
  const debit = ccipSendLogs({
    pool: arb.pool,
    onRamp: arb.onRamp,
    token: arb.token,
    sender: SENDER,
    destSelector: HOME,
    messageId: MESSAGE_ID,
    amount: AMOUNT,
    txHash: SOURCE_TX,
    blockNumber: SOURCE_BLOCK,
  });
  if (options.deploymentsPath === undefined) for (const s of stubs.get(ARB) ?? []) s.state.logs.push(...debit);

  const providersFor = (selector: bigint): ChainProviders | undefined => providers.get(selector);
  const cache = new SpecCache({
    tokens: [token],
    providersFor: (selector) => {
      const p = providers.get(selector);
      if (p === undefined) throw new Error("no providers");
      return p;
    },
    syncMs: 60_000,
    maxAgeMs: 180_000,
  });
  if (options.syncNow ?? true) await cache.syncOnce();

  const logs: string[] = [];
  const logger: Logger = createLogger("debug", (_level, line) => logs.push(line));
  const metrics = createMetrics();
  const server: Server = createJudgeServer({
    cache,
    providersFor,
    auth: options.auth ?? { mode: "insecure" },
    basePath: options.basePath ?? "",
    budgetMs: options.budgetMs ?? 2000,
    validators: compileValidators(),
    metrics,
    logger,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    token,
    stubs,
    cache,
    metrics,
    logs,
    both(chain, change) {
      for (const s of stubs.get(chain) ?? []) change(s);
    },
    ledger(chain, provider) {
      const stub = stubs.get(chain)?.[provider];
      const l = stub?.state.ledgers.get(contractsOn(token, chain).ledger);
      if (l === undefined) throw new Error("no ledger");
      return l;
    },
    async close() {
      cache.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
      await Promise.all([...stubs.values()].flat().map((s) => s.stop()));
    },
  };
}

/** A valid v1 request for 10 kETH from Arbitrum Sepolia to Ethereum Sepolia, shaped like the spec example. */
export function kethRequest(token: ProtectedToken, overrides: { amount?: bigint; dest?: bigint; source?: bigint } = {}): EvaluateRequest {
  const source = overrides.source ?? ARB;
  const dest = overrides.dest ?? HOME;
  const src = contractsOn(token, source);
  const dstToken = token.chains.get(dest)?.token ?? "0x0000000000000000000000000000000000000000";
  return {
    schema_version: "v1",
    verifier_id: "kirchhoff-cell-1",
    message_id: MESSAGE_ID,
    source_tx_hash: SOURCE_TX,
    source_block_number: Number(SOURCE_BLOCK),
    source_block_timestamp: "2026-10-04T12:34:56Z",
    fee_token: pad32("0x0000000000000000000000000000000000000000"),
    fee_token_amount: "1000000000000000",
    finalized_block_number: Number(SOURCE_BLOCK) + 15,
    block_depth: 15,
    message: {
      version: 1,
      source_chain_selector: source.toString(),
      dest_chain_selector: dest.toString(),
      sequence_number: 42,
      on_ramp_address: pad32(src.onRamp ?? "0x00"),
      off_ramp_address: pad32("0x0000000000000000000000000000000000001005"),
      sender: pad32(SENDER),
      receiver: pad32(RECEIVER),
      data: "0x",
      dest_blob: "0x",
      execution_gas_limit: 0,
      ccip_receive_gas_limit: 0,
      finality: { mode: "finalized", block_depth: 0, safe: false },
      ccv_and_executor_hash: `0x${"cd".repeat(32)}`,
      token_transfer: {
        version: 1,
        amount: (overrides.amount ?? AMOUNT).toString(),
        source_pool_address: pad32(src.pool ?? "0x00"),
        source_token_address: pad32(src.token),
        dest_token_address: pad32(dstToken),
        token_receiver: pad32(RECEIVER),
        extra_data: "0x",
      },
    },
  };
}

export type PostResult = { status: number; body: Record<string, unknown>; ms: number };

export async function post(
  url: string,
  body: unknown,
  options: { path?: string; headers?: Record<string, string>; sign?: { apiKey: string; secretHex: string; tsMs?: number } } = {},
): Promise<PostResult> {
  const path = options.path ?? "/v1/evaluate";
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json", ...options.headers };
  if (options.sign !== undefined) {
    const ts = String(options.sign.tsMs ?? Date.now());
    headers[HEADER_API_KEY] = options.sign.apiKey;
    headers[HEADER_TIMESTAMP] = ts;
    headers[HEADER_SIGNATURE] = sign(
      Buffer.from(options.sign.secretHex, "hex"),
      stringToSign(path, Buffer.from(raw, "utf8"), options.sign.apiKey, ts),
    );
  }
  const started = performance.now();
  const res = await fetch(`${url}${path}`, { method: "POST", headers, body: raw });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, ms: performance.now() - started };
}
