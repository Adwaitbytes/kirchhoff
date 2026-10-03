import { describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import { ConfigError, loadConfig, rpcFor } from "../src/config.ts";
import { loadTokens, SpecLoadError } from "../src/spec-cache.ts";
import { API_KEY, DEPLOYMENTS_PATH, SECRET_HEX, SPEC_PATH } from "./helpers/harness.ts";

const BASE = { JUDGE_SPEC_PATH: SPEC_PATH, JUDGE_DEPLOYMENTS_PATH: DEPLOYMENTS_PATH };

describe("config", () => {
  it("defaults to HMAC and refuses to start without credentials", () => {
    expect(() => loadConfig(BASE)).toThrow(ConfigError);
    expect(() => loadConfig(BASE)).toThrow(/JUDGE_HMAC_API_KEY/);
  });

  it("loads HMAC credentials and PRD defaults", () => {
    const c = loadConfig({ ...BASE, JUDGE_HMAC_API_KEY: API_KEY, JUDGE_HMAC_SECRET: SECRET_HEX });
    expect(c.auth.mode).toBe("hmac");
    expect(c).toMatchObject({ port: 8080, budgetMs: 2000, specSyncMs: 60_000, specMaxAgeMs: 180_000, basePath: "" });
  });

  it("requires insecure mode to be explicit", () => {
    expect(loadConfig({ ...BASE, JUDGE_AUTH_MODE: "insecure" }).auth).toEqual({ mode: "insecure" });
    expect(() => loadConfig({ ...BASE, JUDGE_AUTH_MODE: "none" })).toThrow(/hmac or insecure/);
  });

  it("validates numbers, paths and log levels", () => {
    const env = { ...BASE, JUDGE_AUTH_MODE: "insecure" };
    expect(() => loadConfig({ ...env, JUDGE_TIME_BUDGET_MS: "2s" })).toThrow(/integer/);
    expect(() => loadConfig({ ...env, JUDGE_TIME_BUDGET_MS: "20000" })).toThrow(/between/);
    expect(loadConfig({ ...env, JUDGE_BASE_PATH: "/compliance/" }).basePath).toBe("/compliance");
    expect(() => loadConfig({ ...env, JUDGE_BASE_PATH: "compliance" })).toThrow(/URL path/);
    expect(() => loadConfig({ ...env, JUDGE_LOG_LEVEL: "trace" })).toThrow(/JUDGE_LOG_LEVEL/);
  });

  it("needs two distinct providers per spec chain", () => {
    expect(() => rpcFor({}, ["ethereum-testnet-sepolia"])).toThrow(/RPC_ETH_SEPOLIA_1/);
    expect(() => rpcFor({ RPC_ETH_SEPOLIA_1: "http://a", RPC_ETH_SEPOLIA_2: "http://a" }, ["ethereum-testnet-sepolia"])).toThrow(/independent/);
    expect(() => rpcFor({ RPC_ETH_SEPOLIA_1: "ws://a", RPC_ETH_SEPOLIA_2: "http://b" }, ["ethereum-testnet-sepolia"])).toThrow(/http/);
    expect(() => rpcFor({}, ["mystery-chain"])).toThrow(/no RPC env prefix/);
    expect(rpcFor({ RPC_ETH_SEPOLIA_1: "http://a", RPC_ETH_SEPOLIA_2: "http://b" }, ["ethereum-testnet-sepolia"]).get("ethereum-testnet-sepolia")).toEqual([
      "http://a",
      "http://b",
    ]);
  });

  it("refuses a deployment record that fails the engine schema", () => {
    expect(() => loadTokens([SPEC_PATH], SPEC_PATH)).toThrow(SpecLoadError);
  });

  it("keys the token by keccak256(symbol) and hashes the resolved spec, so any address change alters it", () => {
    const [token] = loadTokens([SPEC_PATH], DEPLOYMENTS_PATH);
    const [real] = loadTokens([SPEC_PATH], DEPLOYMENTS_PATH.replace("deployments.test.json", "deployments.real-sepolia.json"));
    expect(token?.tokenId).toBe(keccak256(toBytes("kETH")));
    expect(token?.cachedSpecHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(real?.cachedSpecHash).not.toBe(token?.cachedSpecHash);
  });
});
