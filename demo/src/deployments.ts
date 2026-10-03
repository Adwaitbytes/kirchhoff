import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Deployments } from "@kirchhoff/engine";
import { DEPLOYMENTS_SCHEMA } from "@kirchhoff/engine/spec";
import Ajv from "ajv";
import { getAddress, isAddress, type Address } from "viem";
import { ConfigError, DEPLOYMENTS_DIR } from "./env.ts";
import { ROLES, type ChainRole, type Network, type NetworkName } from "./networks.ts";

export const TOKEN_SYMBOL = "kETH";

/** Flat per-chain record written by contracts/script/Deploy.s.sol (keys per contracts/README.md), plus demo extras. */
export type RawDeployment = Record<string, string | number> & {
  network: string;
  role: "home" | "remote";
  chainId: number;
  chainSelector: string;
  forwarderMode: string;
  tokenId: string;
  issuerSafe: string;
  conservationLedger: string;
  quarantineController: string;
  conservationFeed: string;
  kirchhoffGuard: string;
  kirchhoffTokenPool: string;
  weakBridge: string;
};

/** The name Deploy.s.sol / ConfigureLanes.s.sol get as NETWORK, so forge writes `<network>-<role>.raw.json`. */
export function forgeNetwork(net: NetworkName, role: ChainRole): string {
  return `${net}-${role}.raw`;
}

export function rawPath(net: NetworkName, role: ChainRole): string {
  return join(DEPLOYMENTS_DIR, `${forgeNetwork(net, role)}.json`);
}

export function mergedPath(net: NetworkName): string {
  return join(DEPLOYMENTS_DIR, `${net}.json`);
}

export function statePath(net: NetworkName): string {
  return join(DEPLOYMENTS_DIR, `${net}-demo-state.json`);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function readRaw(net: NetworkName, role: ChainRole): RawDeployment | null {
  const path = rawPath(net, role);
  return existsSync(path) ? (readJson(path) as RawDeployment) : null;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function addr(raw: RawDeployment, key: string): Address {
  const value = raw[key];
  if (typeof value !== "string" || !isAddress(value)) throw new ConfigError(`deployment ${raw.network} has no address for ${key}`);
  return getAddress(value);
}

/** The full three-chain set; throws if any chain is missing (run deploy-all first). */
export type DeploymentSet = Readonly<Record<ChainRole, RawDeployment>>;

export function loadSet(net: NetworkName): DeploymentSet {
  const out: Partial<Record<ChainRole, RawDeployment>> = {};
  for (const role of ROLES) {
    const raw = readRaw(net, role);
    if (raw === null) throw new ConfigError(`${rawPath(net, role)} missing: run deploy-all --network ${net} first`);
    out[role] = raw;
  }
  return out as DeploymentSet;
}

/**
 * Converts the forge records into exactly the engine's deployments schema (engine/src/spec/compile-files.ts
 * DEPLOYMENTS_SCHEMA) and validates it before anything is written. Bridge ids match engine/specs/kETH.yaml:
 * `ccip` is the KirchhoffTokenPool, `weakbridge` is the HomeEscrowAdapter on home and the WeakBridge on remotes.
 */
export function toEngineDeployments(n: Network, set: DeploymentSet): Deployments {
  const chains: Record<string, Deployments["chains"][string]> = {};
  for (const role of ROLES) {
    const raw = set[role];
    const config = n.chains[role];
    const isHome = role === "home";
    const tokens = {
      [TOKEN_SYMBOL]: {
        token: addr(raw, isHome ? "kETH" : "remoteKETH"),
        ...(isHome ? { escrow: addr(raw, "homeEscrowAdapter"), lockbox: addr(raw, "ccipLockBox") } : {}),
        bridges: {
          ccip: addr(raw, "kirchhoffTokenPool"),
          weakbridge: isHome ? addr(raw, "homeEscrowAdapter") : addr(raw, "weakBridge"),
        },
      },
    };
    chains[config.chainName] = {
      chainId: config.chainId,
      ledger: addr(raw, "conservationLedger"),
      quarantine: addr(raw, "quarantineController"),
      feed: addr(raw, "conservationFeed"),
      ...(isHome ? { registry: addr(raw, "kirchhoffRegistry") } : {}),
      ccip: { onRamp: addr(raw, "ccipOnRamp"), offRamp: addr(raw, "ccipOffRamp") },
      tokens,
    };
  }
  const deployments: Deployments = { network: n.name, chains };
  const validate = new Ajv({ allErrors: true, strict: true }).compile(DEPLOYMENTS_SCHEMA);
  if (!validate(deployments)) {
    throw new ConfigError(`engine deployments schema rejected ${n.name}.json: ${JSON.stringify(validate.errors)}`);
  }
  return deployments;
}

/** Demo-only state (Safe parameters, seed markers). Not a deployments document: the SDK parser ignores it. */
export type DemoState = {
  label: "Testnet simulation";
  network: NetworkName;
  safe?: { address: Address; owners: Address[]; threshold: number; saltNonce: string; singleton: Address; factory: Address; fallbackHandler: Address };
  seeded?: { escrowed: string; arb: string; base: string; txs: string[] };
  lastIncident?: { incidentId: string; attackTx: string; amount: string; at: string };
};

export function readState(net: NetworkName): DemoState {
  const path = statePath(net);
  return existsSync(path) ? (readJson(path) as DemoState) : { label: "Testnet simulation", network: net };
}

export function writeState(state: DemoState): void {
  writeJson(statePath(state.network), state);
}
