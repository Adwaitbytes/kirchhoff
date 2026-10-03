import { KNOWN_CHAINS, type ChainDeployment, type Deployments, type Hex } from "@kirchhoff/engine";

/** The per-chain record contracts/script/Deploy.s.sol writes (the fields the workflows need). */
export type DeployRecord = {
  role: "home" | "remote";
  chainId: number;
  chainSelector: string;
  tokenSymbol: string;
  conservationLedger: Hex;
  quarantineController: Hex;
  conservationFeed: Hex;
  ccipRouter: Hex;
  kirchhoffTokenPool: Hex;
  weakBridge: Hex;
  kirchhoffRegistry?: Hex;
  kETH?: Hex;
  remoteKETH?: Hex;
  homeEscrowAdapter?: Hex;
  ccipLockBox?: Hex;
  /** Local scenario harness only: the LocalOffRamp it deployed in place of a CCIP OffRamp. */
  ccipOffRamp?: Hex;
};

/**
 * CCIP 2.0.0 OnRamp / OffRamp per public testnet (docs/research/ccip.md section 1, checked live with
 * typeAndVersion on 2026-10-04). Deploy.s.sol does not record them because it never calls them.
 */
const TESTNET_RAMPS: Readonly<Record<number, { onRamp: Hex; offRamp: Hex }>> = {
  11155111: { onRamp: "0x8dcf17f298c881A547D91ca4aA3C2AD7568C6777", offRamp: "0xc6A246A9AcdAaE651708706494720F79C3E5d0A1" },
  421614: { onRamp: "0x6B9a7cF69F90Ae2659bfe3069fba5Aa308A48cC4", offRamp: "0xC93218EB7B778bC0c13E5296140C8E4Fa1C440DA" },
  84532: { onRamp: "0xA33b221A8427739c76f631a995ca60544bEdD632", offRamp: "0xa137536A3BFd81aD6f090981268b8C2818451d41" },
};

function need(value: Hex | undefined, label: string): Hex {
  if (value === undefined) throw new Error(`deployment record is missing ${label}`);
  return value;
}

/**
 * Local Anvil chains have no CCIP ramps: Deploy.s.sol wires the pools to a LocalRouterMock. The router stands in
 * as the OnRamp (it emits nothing, so no CCIP debit exists locally) and, unless the scenario harness deployed its
 * LocalOffRamp, as the OffRamp too (documented in workflows/README.md).
 */
function rampsFor(record: DeployRecord): { onRamp: Hex; offRamp: Hex } {
  return TESTNET_RAMPS[record.chainId] ?? { onRamp: record.ccipRouter, offRamp: record.ccipOffRamp ?? record.ccipRouter };
}

export function fromDeployRecords(network: string, records: readonly DeployRecord[]): Deployments {
  const chains: Record<string, ChainDeployment> = {};
  for (const record of records) {
    const known = KNOWN_CHAINS.find((c) => c.selector === BigInt(record.chainSelector));
    if (known === undefined) throw new Error(`chain selector ${record.chainSelector} is not a KIRCHHOFF chain`);
    const isHome = record.role === "home";
    const token = need(isHome ? record.kETH : record.remoteKETH, isHome ? "kETH" : "remoteKETH");
    // Home: HomeEscrowAdapter emits Burned/Released and holds the debit registry; remote: the WeakBridge does.
    const weakbridge = isHome ? need(record.homeEscrowAdapter, "homeEscrowAdapter") : record.weakBridge;
    chains[known.name] = {
      chainId: record.chainId,
      ledger: record.conservationLedger,
      quarantine: record.quarantineController,
      feed: record.conservationFeed,
      ...(isHome ? { registry: need(record.kirchhoffRegistry, "kirchhoffRegistry") } : {}),
      ccip: rampsFor(record),
      tokens: {
        [record.tokenSymbol]: {
          token,
          ...(isHome ? { escrow: need(record.homeEscrowAdapter, "homeEscrowAdapter"), lockbox: need(record.ccipLockBox, "ccipLockBox") } : {}),
          bridges: { ccip: record.kirchhoffTokenPool, weakbridge },
        },
      },
    };
  }
  return { network, chains };
}
