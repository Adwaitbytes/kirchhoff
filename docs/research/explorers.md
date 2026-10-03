# Block explorers, verification and Multicall3 for Sepolia, Arbitrum Sepolia and Base Sepolia

Research date: 2026-10-04. Items not checked against a live source are marked **UNVERIFIED**.

## TL;DR

- **Etherscan API V2.** Base URL `https://api.etherscan.io/v2/api?chainid=<id>&module=...&action=...&apikey=<KEY>`. One Etherscan key covers all three chains.
- **Free tier on the general API.** Per https://docs.etherscan.io/supported-chains, checked 2026-10-04:
  - Sepolia `11155111`: Free tier available.
  - Arbitrum Sepolia `421614`: Free tier available, but from **2026-11-01** it moves to a shared community pool.
  - Base Sepolia `84532`: **Paid tier only**.
- **Verification, source and ABI are still free everywhere.** The same page says "Source code and ABI endpoints are available on all chains for every API plan, including the Free Tier." Etherscan's 2025-11-22 post says "all verified contract related endpoints including source code, ABI, and verification continue to remain fully available across all supported networks, even under the Free API tier". So `forge verify-contract` on Base Sepolia works with a free key. Log and tx queries on Base Sepolia do not.
- **Free tier limit:** 3 calls/sec, up to 100,000 calls/day. Calls without a key return `{"status":"0","message":"NOTOK","result":"Missing/Invalid API Key"}`, which I observed on all three chain IDs.
- **Blockscout** has keyless per-instance APIs, all checked live:
  - `https://eth-sepolia.blockscout.com/api` and `/api/v2`
  - `https://arbitrum-sepolia.blockscout.com/api` and `/api/v2`
  - `https://base-sepolia.blockscout.com/api` and `/api/v2`

  For verification use `--verifier blockscout --verifier-url https://<host>/api/`, with no key needed. Blockscout's free ROUTED "PRO API" `https://api.blockscout.com/v2/api?chain_id=<id>` needs a key from dev.blockscout.com.
- **Foundry** (docs generated from forge `1.8.0-nightly`, commit `fa8b5fc2`): `forge verify-contract <ADDR> <path:Name> --chain <name|id> --verifier etherscan --etherscan-api-key $ETHERSCAN_API_KEY --watch [--constructor-args <hex>]`. Built-in chain names are `sepolia`, `arbitrum-sepolia` and `base-sepolia`. Foundry's defaults for them already point at `https://api.etherscan.io/v2/api?chainid=...`.
- **Multicall3** `0xcA11bde05977b3631167028862bE2a173976CA11` has code on all three chains. It is 3808 bytes, the `aggregate3` selector `0x82ad56cb` is present, and `getBlockNumber()` works. Gotcha: on Arbitrum Sepolia the bytecode hash differs, and `getBlockNumber()` returns the **L1 (Sepolia) block number**.

---

## 1. Chain reference

| Chain | Chain ID | Etherscan-family explorer | Blockscout explorer | CRE chain name |
|---|---|---|---|---|
| Ethereum Sepolia | 11155111 | https://sepolia.etherscan.io | https://eth-sepolia.blockscout.com | `ethereum-testnet-sepolia` |
| Arbitrum Sepolia | 421614 | https://sepolia.arbiscan.io | https://arbitrum-sepolia.blockscout.com | `ethereum-testnet-sepolia-arbitrum-1` |
| Base Sepolia | 84532 | https://sepolia.basescan.org | https://base-sepolia.blockscout.com | `ethereum-testnet-sepolia-base-1` |

Link patterns are the same on all explorers: `<explorer>/tx/<hash>`, `<explorer>/address/<addr>`, `<explorer>/block/<n>`.

Sources for the table:
- Chain IDs: checked via `eth_chainId` on `https://ethereum-sepolia-rpc.publicnode.com`, `https://arbitrum-sepolia-rpc.publicnode.com` and `https://base-sepolia-rpc.publicnode.com`.
- Etherscan-family browser URLs: alloy-chains `src/generated/named.rs` @ `5e5cd4a6a73df8a2d0e8dc3d65825782d303f059`, which is what Foundry uses. The CRE Forwarder Directory uses the same hosts.
- Blockscout hosts: checked live, including `/api/v2/stats` returning HTTP 200.
- CRE chain names: the CRE Forwarder Directory.

---

## 2. Etherscan API V2 (multichain)

Docs: https://docs.etherscan.io. I read the raw `.md` pages on 2026-10-04: `supported-chains.md`, `resources/rate-limits.md`, `changelog.md`, `contract-verification/verify-with-api.md`, `contract-verification/verify-with-foundry.md` and `api-reference/endpoint/getabi.md`.

- **Base:** `https://api.etherscan.io/v2/api`
- **Required query param:** `chainid` (string). Example from the docs OpenAPI: "Chain ID to query, eg 1 for Ethereum, 42161 for Arbitrum".
- **Auth:** query param `apikey`. Docs: "One request verifies on every chain, just switch the `chainid`."

### Plans (from `resources/rate-limits.md`, verbatim rows)

```
| Free | 3 calls/second, up to 100,000 calls/day, [selected chains](/supported-chains) only | Not Available |
| Lite | 5 calls/second, up to 100,000 calls/day | Not Available |
| Standard | 10 calls/second, up to 200,000 calls/day | Available |
```

### Free-tier status per chain

This comes from the `supported-chains.md` data array, where the 4th element is "free tier available":

```
["Sepolia Testnet", 11155111, "test", true]
["Base Sepolia Testnet", 84532, "test", false]
["Arbitrum Sepolia Testnet", 421614, "test", true]
```

- The same page notes: "Source code and ABI endpoints are available on all chains for every API plan, including the Free Tier."
- Etherscan blog, 2025-11-22 (https://info.etherscan.com/whats-changing-in-the-free-api-tier-coverage-and-why/): "all verified contract related endpoints including source code, ABI, and verification continue to remain fully available across all supported networks, even under the Free API tier".
- `changelog.md`, "Community Free API Limit for Arbitrum", updated 2026-10-01: effective **2026-11-01** for 42161 and 421614. "Each chain will have its own shared pool of free API calls available to all Free tier users collectively ... Once a chain's shared pool is depleted, Free tier requests on that chain will be temporarily unavailable until the pool resets."

**What this means for this project:**
- A single free Etherscan key can verify contracts on all three chains, and can run `getabi` / `getsourcecode` on all three.
- Non-contract endpoints (logs, txlist, balance and so on) on **Base Sepolia require a paid plan**. Use Blockscout or RPC for those.
- Arbitrum Sepolia free calls may be intermittently unavailable after 2026-11-01.

### Example calls

```bash
# ABI of a verified contract
curl "https://api.etherscan.io/v2/api?chainid=11155111&module=contract&action=getabi&address=0xF8344CFd5c43616a4366C34E3EEE75af79a74482&apikey=$ETHERSCAN_API_KEY"

# Source + compiler settings
curl "https://api.etherscan.io/v2/api?chainid=84532&module=contract&action=getsourcecode&address=0xYourContract&apikey=$ETHERSCAN_API_KEY"

# Submit verification (POST, standard JSON input), verbatim shape from docs verify-with-api.md
curl --request POST \
  --url 'https://api.etherscan.io/v2/api?chainid=421614&module=contract&action=verifysourcecode' \
  --data-urlencode "apikey=$ETHERSCAN_API_KEY" \
  --data-urlencode 'contractaddress=0xYourContractAddress' \
  --data-urlencode 'sourceCode={"language":"Solidity","sources":{...},"settings":{...}}' \
  --data-urlencode 'contractname=src/MyConsumer.sol:MyConsumer' \
  --data-urlencode 'compilerversion=v0.8.26+commit.8a97fa7a' \
  --data-urlencode 'codeformat=solidity-standard-json-input' \
  --data-urlencode 'constructorArguments=' \
  --data-urlencode 'licenseType=3'
# -> {"status":"1","message":"OK","result":"<guid>"}

# Poll
curl "https://api.etherscan.io/v2/api?chainid=421614&module=contract&action=checkverifystatus&guid=<guid>&apikey=$ETHERSCAN_API_KEY"
# -> result "Pass - Verified"
```

Notes:
- `constructorArguments` is ABI-encoded hex **without** `0x`. This is the usual Etherscan convention, but the docs only say "ABI-encoded arguments, in hex": **UNVERIFIED**.
- `licenseType=3` is MIT.

---

## 3. Blockscout

Live checks on 2026-10-04, all with no API key:

| Chain | Etherscan-compatible RPC API | REST v2 | Verifier URL for forge |
|---|---|---|---|
| Sepolia | `https://eth-sepolia.blockscout.com/api` | `https://eth-sepolia.blockscout.com/api/v2` | `https://eth-sepolia.blockscout.com/api/` |
| Arb Sepolia | `https://arbitrum-sepolia.blockscout.com/api` | `https://arbitrum-sepolia.blockscout.com/api/v2` | `https://arbitrum-sepolia.blockscout.com/api/` |
| Base Sepolia | `https://base-sepolia.blockscout.com/api` | `https://base-sepolia.blockscout.com/api/v2` | `https://base-sepolia.blockscout.com/api/` |

What I checked:
- `GET /api?module=contract&action=getabi&address=0xcA11…CA11` returned `{"message":"OK","result":"[...]"}` on all three.
- `GET /api/v2/smart-contracts/<addr>` returned `name`, `is_verified`, `compiler_version`, `source_code` and `additional_sources`. I used it to pull verified source of the CRE forwarders.
- Rate-limit headers observed without a key: `x-ratelimit-limit: 180` (eth-sepolia and arbitrum-sepolia) and `150` (base-sepolia), plus `x-ratelimit-remaining` and `x-ratelimit-reset` (the reset value looked like milliseconds). The window length is **UNVERIFIED**.

### Blockscout verification with Foundry

Source: https://docs.blockscout.com/devs/verification/foundry-verification, raw `.md` read 2026-10-04. Verbatim excerpts:

```sh
forge verify-contract \
  --rpc-url <rpc_https_endpoint> \
  <address> \
  <contract_file>:<contract_name> \
  --verifier blockscout \
  --verifier-url <blockscout_homepage_explorer_url>/api/
```

The docs also say: "Make sure to add `/api/` to the end of the Blockscout homepage explorer URL (e.g., `--verifier-url=https://eth-sepolia.blockscout.com/api/`)". On keys: "For the per-instance route, no: any non-empty string works, or you can drop `--etherscan-api-key` entirely."

The PRO API (one key for all chains, free at dev.blockscout.com) works like this:

```sh
--verifier blockscout --verifier-url "https://api.blockscout.com/v2/api?chain_id=<chain_id>" --etherscan-api-key <your_pro_api_key>
```

---

## 4. Foundry verification (forge v1.x)

The flag reference is https://getfoundry.sh/reference/forge/verify-contract. It is generated from `forge verify-contract --help` of `forge Version: 1.8.0-nightly`, commit `fa8b5fc25b5b4340152dea9010777f9e5cb2fc8a` (per https://getfoundry.sh/reference/versions).

Relevant flags, verbatim names:

```
Usage: forge verify-contract [OPTIONS] <ADDRESS> [CONTRACT]
      --constructor-args <ARGS>          The ABI-encoded constructor arguments. Only for Etherscan [alias: --encoded-constructor-args]
      --constructor-args-path <PATH>
      --guess-constructor-args           Try to extract constructor arguments from on-chain creation code
      --compiler-version <VERSION>
      --num-of-optimizations <NUM>       [alias: --optimizer-runs]
      --watch                            Wait for verification result after submission
      --via-ir
      --evm-version <EVM_VERSION>
  -e, --etherscan-api-key <KEY>          [env: ETHERSCAN_API_KEY=]
  -c, --chain <CHAIN>                    The chain name or EIP-155 chain ID [env: CHAIN=]
      --verifier <VERIFIER>              etherscan | sourcify | blockscout | oklink | custom
      --verifier-api-key <VERIFIER_API_KEY>   [env: VERIFIER_API_KEY=]
      --verifier-url <VERIFIER_URL>      [env: VERIFIER_URL=]
  -r, --rpc-url <URL>
```

Chain names: alloy-chains @ `5e5cd4a` defines `"sepolia"` (11155111), `"arbitrum-sepolia"` (421614) and `"base-sepolia"` (84532). Its default Etherscan API URLs are `https://api.etherscan.io/v2/api?chainid=11155111`, `...=421614` and `...=84532`. So with `--chain` you do **not** need `--verifier-url` for Etherscan.

### Etherscan V2 examples

```bash
# Ethereum Sepolia
forge verify-contract 0xYourAddr src/MyConsumer.sol:MyConsumer \
  --chain sepolia --verifier etherscan --etherscan-api-key "$ETHERSCAN_API_KEY" \
  --constructor-args $(cast abi-encode "constructor(address)" 0xF8344CFd5c43616a4366C34E3EEE75af79a74482) \
  --compiler-version 0.8.26 --watch

# Arbitrum Sepolia
forge verify-contract 0xYourAddr src/MyConsumer.sol:MyConsumer \
  --chain arbitrum-sepolia --verifier etherscan --etherscan-api-key "$ETHERSCAN_API_KEY" \
  --constructor-args $(cast abi-encode "constructor(address)" 0x76c9cf548b4179F8901cda1f8623568b58215E62) --watch

# Base Sepolia (explicit V2 URL form, as in Etherscan's own Foundry doc "Custom Chains")
forge verify-contract 0xYourAddr src/MyConsumer.sol:MyConsumer \
  --verifier etherscan --verifier-url "https://api.etherscan.io/v2/api?chainid=84532" \
  --etherscan-api-key "$ETHERSCAN_API_KEY" \
  --constructor-args $(cast abi-encode "constructor(address)" 0xF8344CFd5c43616a4366C34E3EEE75af79a74482) --watch
```

Notes on these examples:
- Etherscan's own Foundry page (`docs.etherscan.io/contract-verification/verify-with-foundry`) shows:

  ```bash
  forge verify-contract --watch --chain sepolia <addr> src/ContractFile.sol:ContractName --verifier etherscan --etherscan-api-key YourApiKeyToken
  ```

  and, for chains Foundry does not know, `--verifier-url "https://api.etherscan.io/v2/api?chainid=2201"`.
- `--constructor-args` takes the ABI-encoded hex from `cast abi-encode`.
- The constructor arguments shown are the production forwarders. Use the mock addresses if you deployed for simulation.

### Blockscout examples

```bash
forge verify-contract 0xYourAddr src/MyConsumer.sol:MyConsumer --verifier blockscout --verifier-url https://eth-sepolia.blockscout.com/api/      --chain sepolia --watch
forge verify-contract 0xYourAddr src/MyConsumer.sol:MyConsumer --verifier blockscout --verifier-url https://arbitrum-sepolia.blockscout.com/api/ --chain arbitrum-sepolia --watch
forge verify-contract 0xYourAddr src/MyConsumer.sol:MyConsumer --verifier blockscout --verifier-url https://base-sepolia.blockscout.com/api/     --chain base-sepolia --watch
```

### `forge script --verify`

The `forge script` reference documents `--verify` ("Verifies all the contracts found in the receipts of a script, if any"), `--etherscan-api-key`, `--verifier`, `--verifier-url` and `--chain` (alias `--chain-id`). `--multi` together with `--verify` / `--resume` is treated as a multi-chain deployment.

```bash
forge script script/Deploy.s.sol --rpc-url base-sepolia --broadcast --verify --account deployer
# Blockscout instead:
forge script script/Deploy.s.sol --rpc-url base-sepolia --broadcast --verify \
  --verifier blockscout --verifier-url https://base-sepolia.blockscout.com/api/
# Re-verify a previous run:
forge script script/Deploy.s.sol --rpc-url base-sepolia --resume --verify
```

### `foundry.toml`

Reference: https://getfoundry.sh/config/reference/etherscan. The page says: "With Etherscan API V2, only Etherscan keys are valid, which can be used to access all similar explorers (e.g. BscScan / BaseScan / Polygonscan)." Supported keys per entry are `key`, `chain` and `url`.

```toml
[rpc_endpoints]
sepolia          = "${SEPOLIA_RPC_URL}"           # e.g. https://ethereum-sepolia-rpc.publicnode.com
arbitrum-sepolia = "${ARBITRUM_SEPOLIA_RPC_URL}"  # e.g. https://arbitrum-sepolia-rpc.publicnode.com
base-sepolia     = "${BASE_SEPOLIA_RPC_URL}"      # e.g. https://base-sepolia-rpc.publicnode.com

[etherscan]
sepolia          = { key = "${ETHERSCAN_API_KEY}", chain = 11155111 }
arbitrum-sepolia = { key = "${ETHERSCAN_API_KEY}", chain = 421614 }
base-sepolia     = { key = "${ETHERSCAN_API_KEY}", chain = 84532, url = "https://api.etherscan.io/v2/api?chainid=84532" }
```

- `url` is optional for these three, because the alloy-chains defaults already use V2.
- **Do not copy** the legacy V1 URLs from Foundry's multi-chain guide (`https://api.basescan.org/api`, `https://api.arbiscan.io/api`). Those are the deprecated per-explorer V1 APIs. That page is stale.
- Whether `--rpc-url base-sepolia` alone causes forge to pick the `[etherscan].base-sepolia` entry when you pass `--verify` is **UNVERIFIED**. Pass `--chain` explicitly to be safe.

---

## 5. Multicall3

Canonical source: https://github.com/mds1/multicall3 (`gh` redirects the old `mds1/multicall` name here), `src/Multicall3.sol` @ `b667d67ecfa5361a81e8f110234ce242613b0012` (2026-01-23). License MIT, `pragma solidity 0.8.12`.

Structs, verbatim:

```solidity
    struct Call {
        address target;
        bytes callData;
    }

    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Call3Value {
        address target;
        bool allowFailure;
        uint256 value;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }
```

Signatures, verbatim:

```solidity
function aggregate(Call[] calldata calls) public payable returns (uint256 blockNumber, bytes[] memory returnData)
function tryAggregate(bool requireSuccess, Call[] calldata calls) public payable returns (Result[] memory returnData)
function tryBlockAndAggregate(bool requireSuccess, Call[] calldata calls) public payable returns (uint256 blockNumber, bytes32 blockHash, Result[] memory returnData)
function blockAndAggregate(Call[] calldata calls) public payable returns (uint256 blockNumber, bytes32 blockHash, Result[] memory returnData)
function aggregate3(Call3[] calldata calls) public payable returns (Result[] memory returnData)
function aggregate3Value(Call3Value[] calldata calls) public payable returns (Result[] memory returnData)
function getBlockHash(uint256 blockNumber) public view returns (bytes32 blockHash)
function getBlockNumber() public view returns (uint256 blockNumber)
function getCurrentBlockCoinbase() public view returns (address coinbase)
function getCurrentBlockDifficulty() public view returns (uint256 difficulty)
function getCurrentBlockGasLimit() public view returns (uint256 gaslimit)
function getCurrentBlockTimestamp() public view returns (uint256 timestamp)
function getEthBalance(address addr) public view returns (uint256 balance)
function getLastBlockHash() public view returns (bytes32 blockHash)
function getBasefee() public view returns (uint256 basefee)
function getChainId() public view returns (uint256 chainid)
```

`aggregate3` reverts with `"Multicall3: call failed"` when a call fails and its `allowFailure` is false. As an ABI string: `aggregate3((address,bool,bytes)[])`, selector `0x82ad56cb`. I found that selector in the deployed bytecode on all three chains; the selector itself is widely published, and I did not compute it.

### On-chain checks (2026-10-04)

| Chain | `eth_getCode` size | sha256(code) prefix | `getBlockNumber()` (`0x42cbb15c`) |
|---|---|---|---|
| Sepolia | 3808 B | `2756d7c52baee85c` | 11838319 (matches Sepolia head) |
| Arbitrum Sepolia | 3808 B | `bb28260b34386672` (differs) | 11838319, which is the **L1 Sepolia** block, not the Arbitrum block (~315,465,494) |
| Base Sepolia | 3808 B | `2756d7c52baee85c` | 47648406 (matches Base head) |

Blockscout reports `Multicall3` as verified on all three.

Gotchas:
- On Arbitrum, `block.number` (and therefore Multicall3 `getBlockNumber` / `aggregate`'s returned `blockNumber`) is the L1 block number. Do not use it as an L2 block cursor.
- The CRE EVM client does its own reads. You only need Multicall3 for batching on the frontend or backend (viem's `multicall` uses this address by default).

---

## UNVERIFIED items

1. Whether Etherscan's `constructorArguments` must omit `0x`. This is the convention, but the docs do not say so explicitly.
2. The Blockscout rate-limit window length and the units of `x-ratelimit-reset`. I only observed the limit values 180 and 150.
3. Whether `forge script --verify --rpc-url <alias>` auto-selects the matching `[etherscan]` entry without `--chain` for these chains.
4. Behaviour of the Arbitrum Sepolia free-tier "shared pool" after 2026-11-01: how big it is, and how often it is depleted.
5. The exact Etherscan V2 plan required for non-contract endpoints on Base Sepolia (Lite or higher?). The docs say only "Paid Tier Only".
6. Why Multicall3's bytecode differs on Arbitrum Sepolia. It is functionally a Multicall3 (the `aggregate3` selector is present and the explorer shows it as verified), but I did not diff the source.
7. The forge flag list is from the `1.8.0-nightly` reference. Exact flag parity with the stable release you install is not checked; run `forge verify-contract --help` locally.
