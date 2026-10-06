import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "@kirchhoff/indexer";
import { CHAINS, CHAIN_KEYS, type ChainKey } from "@kirchhoff/sdk";
import { AiServices } from "../src/ai.ts";

// Never queried: copilotEnv() is pure wiring. The pool connects lazily, so no database is needed.
const db = createDb(process.env.API_UNIT_TEST_DATABASE_URL ?? "postgres://kirchhoff:kirchhoff@127.0.0.1:5434/kirchhoff_mcp_test", { max: 1 });
afterAll(async () => {
  await db.end();
});

const TESTNET_RPC: Record<ChainKey, string[]> = {
  "ethereum-testnet-sepolia": ["https://sepolia.example"],
  "ethereum-testnet-sepolia-arbitrum-1": ["https://arb.example"],
  "ethereum-testnet-sepolia-base-1": ["https://base.example"],
};

const services = (mode: "local" | "testnet", etherscanKey: string | undefined): AiServices =>
  new AiServices({ db, ai: { provider: null, model: "none", fastModel: "none" }, mode, rpc: TESTNET_RPC, etherscanKey, narratorWaitMs: 10 });

describe("Spec Copilot env wiring", () => {
  it("testnet: every chain gets its TokenAdminRegistry and ramps, a client, explorer links and both explorers", () => {
    const env = services("testnet", "k").copilotEnv();
    for (const c of CHAIN_KEYS) {
      expect(env.tokenAdminRegistry[c]).toBe(CHAINS[c].ccip.tokenAdminRegistry);
      expect(env.ramps[c]).toEqual({ onRamp: CHAINS[c].ccip.onRamp, offRamp: CHAINS[c].ccip.offRamp });
      expect(env.clients[c]).toBeDefined();
    }
    expect(env.explorerLinks).toBe(true);
    expect(env.explorer.id).toBe("blockscout+etherscan");
    expect(env.logLookback).toBe(100_000n);
  });

  it("local: no registry (Anvil has none), so list_ccip_pools falls back to the deployer's contracts", () => {
    const env = services("local", undefined).copilotEnv();
    expect(env.tokenAdminRegistry).toEqual({});
    expect(env.explorerLinks).toBe(false);
    expect(env.explorer.id).toBe("local-artifacts");
  });
});
