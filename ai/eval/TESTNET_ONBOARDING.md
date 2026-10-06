# Spec Copilot: testnet onboarding of kETH from the canonical token

Live run, 2026-10-06, against a local API in testnet mode (`KIRCHHOFF_NETWORK=testnet`, Neon hosted DB,
RPC: Tenderly Sepolia, Arbitrum public RPC, publicnode Base Sepolia; explorers: Blockscout, then Etherscan V2),
model `anthropic/claude-sonnet-5.5` via OpenRouter. One `POST /v1/specs/draft`:

```json
{"description": "kETH, an ETH token whose home is Ethereum Sepolia, also on Arbitrum Sepolia and Base Sepolia, bridged with Chainlink CCIP and a custom WeakBridge.",
 "canonical": {"chain": "ethereum-testnet-sepolia", "address": "0xb270dcD4f512709DFAedBAab736888699BDa0273"}}
```

## Result

| Metric | Value |
|---|---|
| Wall time (request to `done`) | **111.6 s** |
| Tool calls | 11, all `ok` (0 failures) |
| Validation | **ok, 0 errors**, on the first draft (no repair turn and no extra discovery round needed) |
| Accuracy vs `docs/kETH.testnet.resolved.yaml` | **49 / 49 fields match** (case-insensitive addresses, minter lists, events, ramps, lock box), 0 extra fields |
| Address/minter lines with verified tool provenance | **21 / 21** (list_ccip_pools 12, get_contract 5, list_role_grants 4); 0 red lines |
| specHash | `0x3705e84d18b108a8f553a0d110eccb92682f83a8f759e48fb94f6d41154a3017` |

## Trace

| # | Tool | Input | ms | Result |
|---|---|---|---|---|
| 1 | get_contract | home, kETH `0xb270…0273` | 4090 | KETH (verified), deployer `0x82b3…18dc` |
| 2 | list_ccip_pools | home, kETH | 2111 | pool `0x1c60…2bde` (LockReleaseTokenPool 2.0.0), lockBox `0x8fa1…f899`, 2 remote lanes (Arbitrum Sepolia, Base Sepolia): remote token `0x93ee…002d`, remote pool `0x98ec…840e`, ramps per chain, both cross-checked consistent on the remote chain |
| 3 | get_contract | home, deployer EOA | 3294 | deployed 11 contracts (named, with creation tx) |
| 4 | get_contract | arb, deployer EOA | 3077 | deployed 7 contracts |
| 5 | get_contract | base, deployer EOA | 2634 | deployed 7 contracts |
| 6 | list_role_grants | arb, remote kETH | 10060 | 2 active minters: KirchhoffBurnMintTokenPool, WeakBridge `0x9bb3…5d78` |
| 7 | list_role_grants | base, remote kETH | 5783 | 2 active minters: KirchhoffBurnMintTokenPool, WeakBridge |
| 8 | get_contract | home, `0xde9a…a3d7` | 4582 | HomeEscrowAdapter (verified; declares Burned/Released) |
| 9 | get_contract | home, `0x69b5…656d` | 3985 | WeakBridge (home copy); the model chose the HomeEscrowAdapter as the home contract |
| 10 | get_contract | arb, `0x9bb3…5d78` | 4965 | WeakBridge |
| 11 | get_contract | base, `0x9bb3…5d78` | 6217 | WeakBridge |

## What was broken (the 2026-10-06 01:09Z failure) and what changed

1. **The failing draft never ran in testnet mode.** Two APIs listened on port 8090: a stale `KIRCHHOFF_NETWORK=local`
   one bound to `127.0.0.1:8090` (started 01:07 local) and the testnet one bound to `0.0.0.0:8090`. macOS routes
   `127.0.0.1:8090` to the specific bind, so the request hit the local-mode API: no TokenAdminRegistry (Anvil has none,
   hence "no CCIP pool" in 1 ms from the deployer-contracts fallback), `href: null` everywhere (explorer links are
   testnet-only), and Anvil chains where kETH has the same deterministic address. `CHAINS[c].ccip.tokenAdminRegistry`
   was already wired in testnet mode (now pinned by `api/test/ai-env.test.ts`). This run used port 8091.
2. **Local "deployed 0 contracts":** the Anvil creation scan covered only the last 5,000 blocks; Anvil mines a block per
   second, so the deployment blocks near genesis fell out of the window. It now scans from genesis (bounded, 32 blocks in flight).
3. **Testnet EOA lookups:** Blockscout's txlist only read one page of 200; Etherscan V2 `deployedBy` was a stub returning
   `[]` (its comment claimed a paid plan; `account/txlist` answers on the free tier for all three chains, checked live).
   Both now page through `txlist`, skip failed creations, keep the creation tx and block as provenance, and get names from
   verified metadata. An explorer outage is now a tool failure, never "deployed 0 contracts".
4. **Remote discovery:** `list_ccip_pools` now follows the CCIP 2.0.0 pool's remote config (`getSupportedChains`,
   `getRemotePools` with a 1.5 `getRemotePool` fallback, `getRemoteToken`, `getLockBox`) and cross-checks each lane on the
   remote chain (remote registry `getPool`, pool `getToken`, the pool's `getRemoteToken` pointing back).
5. **Arbitrum minters were invisible:** `list_role_grants` scanned 100k blocks back. On Arbitrum Sepolia that is about 7 hours,
   and the remote token was granted its roles about 730k blocks ago. It now scans from the token's creation block (explorer
   creation tx, confirmed by its onchain receipt), filtered to access-control topics, with one wide `eth_getLogs` that narrows
   to the provider's range limit (e.g. publicnode's 50,000) when it is rejected.
6. **Agent loop:** a draft with empty `remotes` or `bridges` that fails validation now sends the model back to the tools for one
   bounded round (6 turns, 16 calls) before the repair turn. Empty sections render as `[]`, not YAML null.

Regression tests replay recorded RPC and explorer traffic (`ai/test/fixtures/testnet-onboarding.json`, recorded by
`ai/eval/record-testnet-fixtures.ts` with the API key redacted): `ai/test/testnet-onboarding.test.ts`.
