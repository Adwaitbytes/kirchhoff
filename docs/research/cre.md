# CRE research: CLI, project layout, TypeScript SDK, limits

Researched 2026-10-04. Everything below was read from real source or run locally:

| Source | Ref |
| --- | --- |
| CRE CLI binary | `cre_darwin_arm64.zip` from https://github.com/smartcontractkit/cre-cli/releases/tag/v1.36.0 (released 2026-10-01), SHA-256 `5f655c72eb4a0c8e71ba5320658ee49e05d63182ae591fbfaa90f05b369e43d6` matched `checksums.txt`; `cre version` prints `CRE CLI version v1.36.0`. All flag tables below are copied from its `--help` output |
| `smartcontractkit/cre-cli` source | `main` @ `29b8ebb` (2026-09-29) |
| `@chainlink/cre-sdk` | npm `latest` = **1.23.0** (published 2026-09-29), type definitions read from the npm tarball. GitHub `smartcontractkit/cre-sdk-typescript` `main` @ `51ce64e` still says 1.22.0 in `packages/cre-sdk/package.json` |
| `smartcontractkit/cre-templates` | `main` @ `d0223f31182c76bc36b1cc9d47b13b18efcf2bf6` |
| docs.chain.link/cre source | `smartcontractkit/documentation` `main` @ `2c185d0` (2026-10-02), `src/content/cre/**`; docs version file pins `cre-cli` LATEST = `v1.36.0` |

## TL;DR for engineers

1. Install: `curl -sSL https://app.chain.link/cre/install.sh | bash`, then `cre version` (expect v1.36.0). TS workflows need **Bun >= 1.2.21** (SDK `engines`). Login: `cre login` (browser, 2FA) or `CRE_API_KEY` env var (API keys require deploy-access approval).
2. **`cre workflow simulate` requires authentication.** Verified locally: without login it exits with `authentication required: no credentials found`. `cre workflow build` does NOT require login (verified: compiled our probe workflow to a 2.6 MB `binary.wasm`).
3. SDK package: **`@chainlink/cre-sdk@1.23.0`**. Pair with `viem` (templates pin `2.34.0`; SDK depends on `^2.54.2`) and `zod@3.25.76`.
4. **Per-execution limits that break the PRD as written** (from `cre workflow limits export` and `service-quotas.mdx`):
   - `ChainRead.LogQueryBlockLimit = 100` blocks per `filterLogs`. PRD `search_window_blocks` must be <= 100 per query. 100 blocks is ~20 min on Sepolia (12s), ~200 s on Base Sepolia (2s), only ~25 s on Arbitrum Sepolia (~0.25s blocks: UNVERIFIED block time).
   - `ChainRead.CallLimit = 15` EVM read calls per execution (callContract, filterLogs, headerByNumber, getTransactionReceipt, ...). Budget W1/W2 against this.
   - `LogTrigger.FilterAddressLimit = 5` addresses per log trigger; `FilterTopicsPerSlotLimit = 10`; `EventRateLimit = 10 per 6s`; `TriggerSubscriptionLimit = 10` triggers per workflow.
   - `CRONTrigger.FastestScheduleInterval = 30s` (PRD W2's 30s cron is exactly the floor).
   - `ExecutionTimeout = 5m`, `CapabilityCallTimeout = 3m`, `ChainWrite.TargetsLimit = 10` chains, `ChainWrite.EVM.ReportSizeLimit = 50000` bytes, `TransactionGasLimit = 10,000,000`, `HTTPAction.CallLimit = 15`, `Secrets.CallLimit = 5`, `Consensus.CallLimit = 50`, `Consensus.ObservationSizeLimit = 25kb`.
   - **Registry quota: max 3 workflows per organization** (private registry) and **3 workflows per linked key, 1 linked key per org** (onchain registry). **The PRD's four deployed workflows (W1-W4) exceed this.** Merge W4 into W2 (both cron) or ask for a quota increase.
5. **`SAFE` is not available for chain reads.** `callContract` / `headerByNumber` / `filterLogs` accept only `LATEST_BLOCK_NUMBER`, `LAST_FINALIZED_BLOCK_NUMBER`, or an explicit block number. Log triggers accept `LATEST`, `SAFE` (default), `FINALIZED`. PRD W1 step 2 "headerByNumber at the spec's confidence" must map `safe` to `finalized` (or an explicit depth).
6. Pinned-block reads work: `headerByNumber({blockNumber: LAST_FINALIZED_BLOCK_NUMBER})`, then `callContract({..., blockNumber: bigintToProtoBigInt(n)})`. Verified to type-check and compile.
7. Simulation is single-node; `--broadcast` sends real transactions from `CRE_ETH_PRIVATE_KEY` through a per-chain **mock forwarder** (addresses below; details in `cre-contracts.md`). Without `--broadcast` the write is a dry run and the tx hash prints as all zeros.
8. Local Anvil is supported: `http://localhost` / `127.0.0.1` RPC URLs are allowed without `--allow-insecure-rpc`. Easiest: `anvil --fork-url <sepolia rpc>` and point `ethereum-testnet-sepolia` at it (mock forwarder exists in forked state). For a fresh Anvil chain use the undocumented `experimental-chains` target setting (from CLI source) with your own forwarder.

---

## 1. Install and authenticate

From `src/content/cre/getting-started/cli-installation/macos-linux.mdx` (recommended version `v1.36.0`):

```bash
curl -sSL https://app.chain.link/cre/install.sh | bash
cre version            # CRE CLI version v1.36.0
cre update             # self-update later
```

Manual install: download `cre_darwin_arm64.zip` / `cre_darwin_amd64.zip` / `cre_linux_amd64.tar.gz` / `cre_linux_arm64.tar.gz` / `cre_windows_amd64.zip` plus `checksums.txt` from https://github.com/smartcontractkit/cre-cli/releases, verify SHA-256, unzip, put the binary on PATH. The install script warns (does not block) if Go < 1.25.3 or Bun < 1.0.0 is missing; for TS the SDK itself requires Bun >= 1.2.21.

Auth (`reference/cli/authentication.mdx`):

```bash
cre login                       # opens browser, 2FA; not usable with --non-interactive
cre whoami                      # shows Email, Organization ID, Deploy Access
export CRE_API_KEY="..."        # headless/CI; created in app.chain.link/cre -> Organization -> APIs -> + Organization API
```

"API key authentication requires your account to have deploy access approval." So for the hackathon, every engineer who simulates needs `cre login` on their own machine unless the org has deploy access.

Top-level command list (v1.36.0 `cre --help`): `init`, `templates`, `account`, `login`, `logout`, `whoami`, `workflow`, `execution`, `secrets`, `registry`, `generate-bindings`, `update`, `version`.

Global flags (v1.36.0):

```
      --allow-insecure-rpc     Allow non-localhost HTTP RPC URLs (insecure)
      --allow-unknown-chains   Skip chain-name validation against the chain-selectors registry
                               (for experimental chains)
  -e, --env string             Path to .env file which contains sensitive info
      --non-interactive        Fail instead of prompting; requires all inputs via flags
  -R, --project-root string    Path to the project root
  -E, --public-env string      Path to .env.public file which contains shared, non-sensitive
                               build config
  -T, --target string          Use target settings from YAML config
  -v, --verbose                Run command in VERBOSE mode
```

`cre init` flags: `--deployment-registry string` (e.g. `my-private-registry` or `onchain:ethereum-testnet-sepolia`), `-p, --project-name`, `--refresh`, `--rpc-url stringArray` (`chain-name=url`, repeatable), `-t, --template` (e.g. `kv-store-go`), `-w, --workflow-name`.

## 2. Project layout

From `reference/project-configuration-ts.mdx`:

```text
myProject/
├── .env                    # secret values (never commit); CRE_ETH_PRIVATE_KEY lives here
├── project.yaml            # global settings per target (RPCs, optional owner address)
├── secrets.yaml            # logical secret names -> env var names
├── contracts/abi/*.ts      # viem ABIs as TS (no codegen needed; `cre generate-bindings` optional)
└── workflow1/
    ├── package.json
    ├── tsconfig.json
    ├── workflow.yaml       # per-target workflow name + artifacts
    ├── main.ts
    └── config.staging.json
```

`project.yaml`:

```yaml
staging-settings:
  rpcs:
    - chain-name: ethereum-testnet-sepolia
      url: https://ethereum-sepolia-rpc.publicnode.com
    - chain-name: ethereum-testnet-sepolia-arbitrum-1
      url: https://arbitrum-sepolia-rpc.publicnode.com
    - chain-name: ethereum-testnet-sepolia-base-1
      url: https://base-sepolia-rpc.publicnode.com
production-settings:
  account:
    workflow-owner-address: "0x..."   # optional, multisig only
  rpcs:
    - chain-name: ethereum-testnet-sepolia
      url: https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}   # ${VAR} interpolation supported
```

`workflow.yaml` (one per workflow dir):

```yaml
staging-settings:
  user-workflow:
    workflow-name: "w2-loop-staging"
    # deployment-registry: "private"     # optional; omit = onchain registry
  workflow-artifacts:
    workflow-path: "./main.ts"           # TS must point at the entry file
    config-path: "./config.staging.json"
    secrets-path: ""                     # or "../secrets.yaml"
```

`secrets.yaml` (project root):

```yaml
secretsNames:
  SLACK_WEBHOOK_URL:          # logical id used in code
    - SLACK_WEBHOOK_URL_ENV   # env var the CLI reads in simulation
```

Target resolution: `--target <name>` or `CRE_TARGET=<name>`. The target must exist in both `project.yaml` and `workflow.yaml` (if the workflow has one); workflow keys win on conflict. The templates name targets `staging-settings` / `production-settings`; the PRD's `--target staging` only works if we name the target `staging` in both files.

Simulation reads `CRE_ETH_PRIVATE_KEY` from `.env` (needed for `--broadcast`; a funded key per chain written to).

## 3. `cre workflow simulate` (v1.36.0 `--help`, verbatim)

```
Usage:
  cre workflow simulate <workflow-folder-path> [flags]

Flags:
      --broadcast                    Broadcast transactions to configured chains (default: false)
      --config string                Override the config file path from workflow.yaml
      --default-config               Use the config path from workflow.yaml settings (default
                                     behavior)
  -g, --engine-logs                  Enable non-fatal engine logging
      --evm-event-index int          EVM trigger log index (0-based) (default -1)
      --evm-receipt-timeout string   Timeout for waiting on an EVM transaction receipt (e.g.
                                     30s, 2m) (default "1m")
      --evm-tx-hash string           EVM trigger transaction hash (0x...)
  -h, --help                         help for simulate
      --http-payload string          HTTP trigger payload as JSON string or path to JSON file
      --http-trigger-port int        Port used by the local HTTP trigger server (default 2000)
      --limits string                Production limits to enforce during simulation: 'default'
                                     for prod defaults, path to a limits JSON file (e.g. from
                                     'cre workflow limits export'), or 'none' to disable
                                     (default "default")
      --listen                       Listen for HTTP requests or supported log triggers and
                                     run the simulator for each match (not supported by cron)
      --no-config                    Simulate without a config file
      --skip-type-checks             Skip TypeScript project typecheck during compilation
                                     (passes --skip-type-checks to cre-compile)
      --solana-event-index int       Solana trigger event index (0-based, among 'Program
                                     data:' events in the tx) (default -1)
      --solana-tx-sig string         Solana trigger transaction signature (base58)
      --trigger-index int            Index of the trigger to run (0-based) (default -1)
      --wasm string                  Path or URL to a pre-built WASM binary (skips compilation)
```

Non-interactive recipes (from `guides/operations/simulating-workflows.mdx`):

```bash
# cron handler (index = position in the array returned by initWorkflow)
cre workflow simulate ./w2-loop --non-interactive --trigger-index 0 --target staging-settings
# EVM log handler: replay a specific log from a real tx
cre workflow simulate ./w1-junction --non-interactive --trigger-index 1 \
  --evm-tx-hash 0x<txhash> --evm-event-index <logIndexWithinTx> --target staging-settings --broadcast
# watch live logs and re-run per matching event (not for cron)
cre workflow simulate ./w1-junction --listen --target staging-settings
# HTTP trigger
cre workflow simulate ./w --non-interactive --trigger-index 1 --http-payload @./payload.json --target staging-settings
```

Notes:
- `--evm-event-index` is the 0-based position in `receipt.logs` of that transaction (verified in source: `cmd/workflow/simulate/chain/evm/trigger.go` `fetchAndConvertLog` indexes `txReceipt.Logs[eventIndex]` and errors with `event index %d out of range`). It is NOT the block-level `logIndex`. Ignore the `triggerLogIndex: 291` value in the `event-reactor-ts` config, which looks block-level.
- `--limits default` is the default: simulation **enforces production limits** unless you pass `--limits none`. Export and edit with `cre workflow limits export > limits.json`.
- Dry run (no `--broadcast`) prints `Write report transaction succeeded: 0x0000...0000`.
- Single-node: no real consensus; cron fires immediately when selected.

### Pointing at local Anvil / custom RPCs

- Any `rpcs[].url` can be a local node. `internal/rpc/cleartext.go` (`EvaluateCleartextRPC`) blocks plain-HTTP URLs **unless the host is loopback** (`localhost`, `127.0.0.1`, `::1`); remote `http://` needs `--allow-insecure-rpc`.
- Recommended: fork the real testnet so forwarders and CCIP contracts exist:

```bash
anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com --port 8545
```

```yaml
local-settings:
  rpcs:
    - chain-name: ethereum-testnet-sepolia
      url: http://127.0.0.1:8545
```

- Fresh (non-fork) Anvil: the simulator supports an `experimental-chains` list per target. This is in the CLI source (`internal/settings/settings_get.go` struct `ExperimentalChain`, key `experimental-chains` in `internal/settings/settings_load.go`; consumed in `cmd/workflow/simulate/chain/evm/chaintype.go`) but **not documented** on docs.chain.link. Each entry requires `chain-selector`, `rpc-url`, `forwarder`; `chain-type` defaults to EVM. If the selector duplicates a supported chain, only the forwarder is overridden. Shape (keys from the struct tags):

```yaml
local-settings:
  experimental-chains:
    - chain-type: evm
      chain-selector: 16015286601757825753     # any uint64; must match what the workflow passes to EVMClient
      rpc-url: http://127.0.0.1:8545
      forwarder: "0x<your deployed MockKeystoneForwarder>"
```

  Combine with `--allow-unknown-chains` if the CLI rejects the chain name. The workflow side must construct `new EVMClient(<selector>)` with a bigint; `getNetwork()` will return `undefined` for an unknown selector, so do not rely on it there. UNVERIFIED end-to-end (we could not simulate without a CRE login).

### Simulation forwarders (from `cmd/workflow/simulate/chain/evm/supported_chains.go`)

| Chain name | Simulation forwarder used by `--broadcast` |
| --- | --- |
| `ethereum-testnet-sepolia` | `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` |
| `ethereum-testnet-sepolia-arbitrum-1` | `0xd41263567ddfead91504199b8c6c87371e83ca5d` |
| `ethereum-testnet-sepolia-base-1` | `0x82300bd7c3958625581cc2f77bc6464dcecdf3e5` |

Production forwarders, on-chain verification of these addresses, and receiver-side rules: see `cre-contracts.md`. `cre workflow supported-chains [--output json]` lists both (requires login).

## 4. `cre workflow deploy` and access

`cre workflow deploy --help` (v1.36.0): flags `--config`, `--default-config`, `--no-config`, `-o/--output` (default `./binary.wasm.br.b64`), `-l/--owner-label`, `--skip-type-checks`, `--unsigned`, `--wasm`, `--yes`.

Requirements (`account/deploy-access.mdx`, `guides/operations/deploying-workflows.mdx`):
- **Deploy access is gated.** `cre account access` checks status or submits a request (asks for a use-case description; Chainlink reviews and emails). `cre whoami` shows `Deploy Access: Not enabled|Enabled`. Simulation works without deploy access.
- Choose a registry per target via `user-workflow.deployment-registry`:
  - `"private"`: Chainlink-hosted, authorized by CRE login. No wallet, no gas, no mainnet RPC.
  - `"onchain:ethereum-mainnet"` (default when omitted): Workflow Registry on **Ethereum Mainnet**, requires `cre account link-key` and **mainnet ETH for gas**.
- Quotas (`service-quotas.mdx`): private registry max **3 workflows per organization**; onchain max **1 linked key per org, 3 workflows per key**. "Being actively tuned ahead of general availability."
- Other lifecycle: `cre workflow activate|pause|delete|get|list|hash`, `cre workflow custom-build`.
- Deployed workflows read secrets from the Vault DON: `cre secrets create|update|delete|list|execute` (`--secrets-auth onchain|browser`).

## 5. TypeScript SDK API (`@chainlink/cre-sdk@1.23.0`)

Package entry exports: `dist/index.d.ts`; subpaths `./restricted-apis`, `./restricted-node-modules`, `./unrestricted`, `./pb`, `./test`; bin `cre-compile`. Deps: `@bufbuild/protobuf 2.6.3`, `@chainlink/cre-sdk-javy-plugin 1.7.0`, `@noble/hashes 2.2.0`, `viem ^2.54.2`, `zod 3.25.76`. `engines.bun >= 1.2.21`.

### Entry point and handlers

```ts
import { Runner, handler, cre, type Runtime } from '@chainlink/cre-sdk'

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema })   // zod schema validates config JSON
  await runner.run(initWorkflow)                                    // initWorkflow(config, secretsProvider) => Workflow
}
```

- `handler(trigger, fn, hooks?)` (also `cre.handler`). `fn: (runtime: Runtime<C>, triggerOutput) => Promise<T> | T`.
- `initWorkflow` returns an array of handlers; **array position = `--trigger-index`**.
- `cre.capabilities` = `{ CronCapability, HTTPCapability, ConfidentialHTTPClient, HTTPClient, EVMClient, SolanaClient }`.

### Runtime (`dist/sdk/runtime.d.ts`)

```ts
interface BaseRuntime<C> { config: C; now(): Date; log(message: string): void; callCapability(...) }
interface Runtime<C> extends BaseRuntime<C>, SecretsProvider {
  runInNodeMode<TArgs extends unknown[], TInput, TOutput = TInput>(
    fn: (nodeRuntime: NodeRuntime<C>, ...args: TArgs) => TInput,
    consensusAggregation: ConsensusAggregation<TInput, TOutput, true>,
    unwrapOptions?: ...
  ): (...args: TArgs) => { result: () => TOutput }
  report(input: ReportRequest | ReportRequestJson): { result: () => Report }
}
type SecretsProvider = {
  getSecrets(requests: Array<SecretRequest | SecretRequestJson>): { result: () => Record<string, Secret> }
  getSecret(request: SecretRequest | SecretRequestJson): { result: () => Secret }
}
// SecretRequestJson = { id?: string; namespace?: string }; Secret has { id, namespace, owner, value }
```

All capability calls are synchronous-looking: call, then `.result()`. Do not `await` them. Use `runtime.now()`, never `Date.now()`.

### Cron trigger

```ts
new CronCapability().trigger({ schedule: '*/30 * * * * *' })   // CAPABILITY_ID "cron-trigger@1.0.0"
// handler payload: CronPayload { scheduledExecutionTime?: Timestamp }
```

5 or 6 fields (6th = seconds, first position). Prefix `TZ=<iana>` for timezones. Minimum interval 30 s.

### EVM client (`generated-sdk/capabilities/blockchain/evm/v1alpha/client_sdk_gen.d.ts`)

```ts
export declare class ClientCapability {            // exported as EVMClient
  static readonly CAPABILITY_ID = "evm@1.0.0";
  static readonly SUPPORTED_CHAIN_SELECTORS: { 'ethereum-testnet-sepolia': 16015286601757825753n; ... }
  constructor(ChainSelector: bigint);
  callContract(runtime, input: CallContractRequest | CallContractRequestJson): { result: () => CallContractReply };
  filterLogs(runtime, input: FilterLogsRequest | FilterLogsRequestJson): { result: () => FilterLogsReply };
  balanceAt(runtime, input): { result: () => BalanceAtReply };
  estimateGas(runtime, input): { result: () => EstimateGasReply };
  getTransactionByHash(runtime, input): { result: () => GetTransactionByHashReply };
  getTransactionReceipt(runtime, input: GetTransactionReceiptRequest | ...Json): { result: () => GetTransactionReceiptReply };
  headerByNumber(runtime, input: HeaderByNumberRequest | ...Json): { result: () => HeaderByNumberReply };
  logTrigger(config: FilterLogTriggerRequestJson): ClientLogTrigger;
  writeReport(runtime, input: WriteCreReportRequest | WriteCreReportRequestJson): { result: () => WriteReportReply };
}
```

(The docs page `reference/sdk/evm-client-ts.mdx` also documents `registerLogTracking` / `unregisterLogTracking`; **these methods are not present in the 1.23.0 type definitions.** Do not use them.)

JSON request/response shapes (from `generated/capabilities/blockchain/evm/v1alpha/client_pb.d.ts`):

```ts
type CallContractRequestJson = { call?: CallMsgJson; blockNumber?: BigIntJson }   // default latest
type CallMsgJson = { from?: string; to?: string; data?: string }
type CallContractReply = { data: Uint8Array }

type FilterLogsRequestJson = { filterQuery?: FilterQueryJson }
type FilterQueryJson = {
  blockHash?: string;            // exact block (cannot combine with from/to)
  fromBlock?: BigIntJson; toBlock?: BigIntJson;
  addresses?: string[];
  topics?: TopicsJson[];         // TopicsJson = { topic?: string[] } per position (OR within, AND across)
}
type FilterLogsReply = { logs: Log[] }
type LogJson = { address; topics: string[]; txHash; blockHash; data; eventSig; blockNumber: BigIntJson;
                 txIndex: number; index: number; removed: boolean }

type HeaderByNumberRequestJson = { blockNumber?: BigIntJson }        // undefined = latest
type HeaderJson = { timestamp?: string /* unix */; blockNumber?: BigIntJson; hash?: string; parentHash?: string }

type GetTransactionReceiptRequestJson = { hash?: string }
type ReceiptJson = { status?: string /* 1|0 */; gasUsed; txIndex; blockHash; logs?: LogJson[]; txHash;
                     effectiveGasPrice?: BigIntJson; blockNumber?: BigIntJson; contractAddress }

type FilterLogTriggerRequestJson = {
  addresses?: string[];           // at least one; max 5 (quota)
  topics?: TopicValuesJson[];     // fixed 4 slots; TopicValuesJson = { values?: string[] }; slot 0 = event sigs (required)
  confidence?: 'CONFIDENCE_LEVEL_SAFE' | 'CONFIDENCE_LEVEL_LATEST' | 'CONFIDENCE_LEVEL_FINALIZED';  // default SAFE
}

type WriteCreReportRequestJson = { receiver: string; report: Report; gasConfig?: { gasLimit: string } }
type WriteReportReply = { txStatus: TxStatus; receiverContractExecutionStatus?: ReceiverContractExecutionStatus;
                          txHash?: Uint8Array; transactionFee?: bigint; errorMessage?: string }
enum TxStatus { FATAL = 0, REVERTED = 1, SUCCESS = 2 }
enum ReceiverContractExecutionStatus { SUCCESS = 0, REVERTED = 1 }
enum ConfidenceLevel { SAFE = 0, LATEST = 1, FINALIZED = 2 }
```

Important: `WriteReportReply.txStatus === SUCCESS` means "included in a block", not finalized, and does **not** by itself mean the receiver did not revert. Also check `receiverContractExecutionStatus` (the forwarder can succeed while the receiver reverts; see `cre-contracts.md`). Hash may change on reorg resubmission.

Helpers (`dist/sdk/utils/capabilities/blockchain/evm/evm-helpers.d.ts`):

```ts
LATEST_BLOCK_NUMBER          // { absVal: base64([2]), sign: '-1' }  => -2
LAST_FINALIZED_BLOCK_NUMBER  // { absVal: base64([3]), sign: '-1' }  => -3
blockNumber(n), bigintToProtoBigInt(n), protoBigIntToBigint(pb)
encodeCallMsg({ from, to, data }): CallMsgJson
logTriggerConfig({ addresses: Hex[], topics?: Hex[][], confidence?: 'SAFE'|'LATEST'|'FINALIZED' })
prepareReportRequest(hexPayload, encoder = EVM_DEFAULT_REPORT_ENCODER)   // {encoderName:'evm',signingAlgo:'ecdsa',hashingAlgo:'keccak256'}
EVM_DEFAULT_REPORT_ENCODER, isChainSelectorSupported(name)
bytesToHex, hexToBytes, hexToBase64, bigintToBytes, bytesToBigint
getNetwork({ chainFamily: 'evm', chainSelectorName, isTestnet }) => NetworkInfo | undefined   // .chainSelector.selector: bigint
```

There is no `SAFE_BLOCK_NUMBER`. From `concepts/finality-ts.mdx`: "The `SAFE` confidence level is not available for chain reads—only `LATEST` and `FINALIZED` are supported." FINALIZED maps to the native `finalized` tag on Ethereum Sepolia, Arbitrum Sepolia, Base Sepolia.

### Reports and writes

```ts
const payload = encodeAbiParameters(parseAbiParameters('uint8 kind, bytes32 tokenId, ...'), [...])
const report = runtime.report(prepareReportRequest(payload)).result()
const reply = evm.writeReport(runtime, { receiver, report, gasConfig: { gasLimit: '1000000' } }).result()
```

The bytes passed as `encodedPayload` arrive at the receiver as the `report` argument of `onReport(bytes metadata, bytes report)`. Official examples differ on what they encode: `cre-sdk-examples/src/workflows/on-chain-write/main.ts` encodes a full `encodeFunctionData(onReport, ...)` call, while docs `evm-client-ts.mdx` encodes `updateReserves(...)` calldata. Either way the receiver decodes the bytes itself; we should encode plain `abi.encode(...)` of our report struct and decode it in `_processReport`. One `runtime.report` can be written to several chains (one `writeReport` per chain, up to 10 targets).

### Consensus aggregation (`dist/sdk/utils/values/consensus_aggregators.d.ts`)

```ts
consensusMedianAggregation<T extends NumericType>()
consensusIdenticalAggregation<T>()
consensusCommonPrefixAggregation<T>() / consensusCommonSuffixAggregation<T>()
consensusFrequencyListAggregation<T>()
ConsensusAggregationByFields<T>({ field: median | identical | commonPrefix | commonSuffix | frequencyList | ignore, ... })
// all support .withDefault(value)
```

EVM client reads made in DON mode (as in all templates) are already consensus reads; `runInNodeMode` + an aggregator is for per-node work (HTTP fetches, node-local computation).

### HTTP client (`generated-sdk/capabilities/networking/http/v1alpha/client_sdk_gen.d.ts`, `CAPABILITY_ID "http-actions@1.0.0-alpha"`)

```ts
new HTTPClient().sendRequest(runtime, (sendRequester: HTTPSendRequester, ...args) => T, consensusIdenticalAggregation<T>())(...args).result()
// or inside node mode: new HTTPClient().sendRequest(nodeRuntime, { url, method, body, multiHeaders, timeout, cacheSettings }).result()
// RequestJson: { url, method, headers (deprecated), body (bytes, base64 in JSON), timeout, cacheSettings, multiHeaders, mtls }
// helpers: ok(resp), text(resp), json(resp), getHeader(resp, name), getHeaders(resp, name)
```

Every node sends the request, so a webhook POST fires once per DON node unless the receiving side de-duplicates. That is why the PRD's idempotency key (incident id) is required. `HTTPAction.CacheAgeLimit` 10m: `cacheSettings` can make nodes share one response (UNVERIFIED semantics for POSTs).

### Secrets

Declared in `secrets.yaml`, referenced via `workflow-artifacts.secrets-path`. In code (DON-mode `Runtime`, not `NodeRuntime`):

```ts
const url = runtime.getSecret({ id: 'SLACK_WEBHOOK_URL' }).result().value
const all = runtime.getSecrets([{ id: 'A' }, { id: 'B' }]).result()   // throws SecretsBatchError if any fail
```

Simulation: values from shell env or project `.env`. Deployed: Vault DON via `cre secrets create`. Quotas: 5 secret fetch calls per execution, 27 KB total, 2 KB per secret, 100 secrets per owner.

## 6. Chain selector names and values (verified two ways)

Values from `@chainlink/cre-sdk@1.23.0` `EVMClient.SUPPORTED_CHAIN_SELECTORS` and identical in docs data `src/config/data/ccip/v1_2_0/testnet/chains.json`:

| CRE / CCIP chain name | Chain ID | Chain selector |
| --- | --- | --- |
| `ethereum-testnet-sepolia` | 11155111 | `16015286601757825753` |
| `ethereum-testnet-sepolia-arbitrum-1` | 421614 | `3478487238524512106` |
| `ethereum-testnet-sepolia-base-1` | 84532 | `10344971235874465080` |

All three are supported since CLI v1.0.0 / TS SDK v1.0.1 (`supported-networks-ts.mdx`). Sepolia's selector exceeds 2^63: always use `bigint` (`16015286601757825753n`).

## 7. WASM compile constraints

From `concepts/typescript-wasm-runtime.mdx` and `getting-started/before-you-build-ts.mdx`:
- TS -> JS -> WASM via **Javy**, running on embedded **QuickJS**, not Node.js. `node:crypto`, `node:fs`, etc. are unavailable. Packages that import Node built-ins fail. Use `@noble/hashes` (already an SDK dependency) for hashing.
- `viem` works and is what all templates use (`encodeFunctionData`, `decodeFunctionResult`, `encodeAbiParameters`, `keccak256`, `parseAbi`). Keep viem usage to pure encoding helpers; there is no transport (no `createPublicClient`).
- `bigint` is fully supported and mandatory for chain values (use `n` literals, `parseUnits` / `formatUnits`). `Map`, `Set`, ES2020+ syntax supported.
- `Promise`/`async` exist in QuickJS, but SDK capabilities use `.result()` and must not be awaited.
- Determinism: use `runtime.now()`; `Math.random()` is overridden with a consensus-safe generator; avoid iterating object keys in nondeterministic order (`concepts/non-determinism-ts.mdx`).
- Memory 100 MB, compressed binary <= 20 MB, config <= 50 KB (docs) / 1 MB (CLI default limits file: the two sources disagree; budget for 50 KB).
- tsconfig used by templates: `target/module ESNext`, `moduleResolution: bundler`, `lib: ["ESNext"]`, `strict: true`, `types: []`, `include: ["main.ts"]` (add our engine files to `include` or import them from main.ts).
- Our shared `@kirchhoff/engine` must therefore be pure TS with no Node built-ins and no `number` arithmetic on token amounts.

## 8. Per-run limits (full default production limits, `cre workflow limits export`, v1.36.0)

```json
{
  "TriggerRegistrationsTimeout": "10s", "TriggerSubscriptionTimeout": "15s", "TriggerSubscriptionLimit": "10",
  "TriggerEventQueueLimit": "50", "TriggerEventQueueTimeout": "10m0s",
  "CapabilityConcurrencyLimit": "30", "CapabilityCallTimeout": "3m0s",
  "SecretsConcurrencyLimit": "5", "ExecutionConcurrencyLimit": "50", "ExecutionTimeout": "5m0s",
  "ExecutionResponseLimit": "100kb", "ExecutionTimestampsEnabled": "false",
  "WASMMemoryLimit": "100mb", "WASMBinarySizeLimit": "100mb", "WASMCompressedBinarySizeLimit": "20mb",
  "WASMConfigSizeLimit": "1mb", "WASMSecretsSizeLimit": "1mb", "LogLineLimit": "1kb", "LogEventLimit": "1000",
  "CRONTrigger": { "FastestScheduleInterval": "30s" },
  "HTTPTrigger": { "RateLimit": "every30s:1" },
  "LogTrigger": { "EventRateLimit": "every6s:10", "EventSizeLimit": "5kb", "FilterAddressLimit": "5", "FilterTopicsPerSlotLimit": "10" },
  "ChainWrite": { "TargetsLimit": "10", "ReportSizeLimit": "50kb",
    "EVM": { "TransactionGasLimit": "10000000", "ReportSizeLimit": "50000", "GasLimit": { "Default": "10000000", "Values": {} } } },
  "ChainRead": { "CallLimit": "15", "LogQueryBlockLimit": "100", "PayloadSizeLimit": "5kb" },
  "Consensus": { "ObservationSizeLimit": "25kb", "CallLimit": "50" },
  "HTTPAction": { "CallLimit": "15", "CacheAgeLimit": "10m0s", "ConnectionTimeout": "10s", "RequestSizeLimit": "120kb", "ResponseSizeLimit": "250kb" },
  "ConfidentialHTTP": { "CallLimit": "15", "ConnectionTimeout": "90s", "RequestSizeLimit": "125kb", "ResponseSizeLimit": "500kb" },
  "Secrets": { "CallLimit": "5" }
}
```

(Solana section omitted.) Docs `service-quotas.mdx` (lastModified 2026-09-16) agrees, with these docs-only items: per-owner 200 concurrent executions; executions over quota are queued and retried up to 10 minutes then dropped; `WASMConfigSizeLimit` 50 KB; `WASMSecretsSizeLimit` 27 KB; quota increases via support.

Design implications for KIRCHHOFF:
- **W1 Junction Watch:** debit search = one `filterLogs` per <= 100-block window. On Arbitrum Sepolia a 100-block window is very short. Filter on the source **OnRamp** `CCIPMessageSent` with `topics[3] = messageId` (the pool's `LockedOrBurned` event has no message id; see `ccip.md`). For WeakBridge, put the message id in an indexed topic. Prefer `blockHash` queries if the credit carries the source block.
- **W2 Loop Ledger:** 3 chains x (1 `headerByNumber` + 1 Multicall3 `callContract` + k `filterLogs`) must stay <= 15 reads. Keep `ChainRead.PayloadSizeLimit` 5 KB in mind for Multicall3 calldata.
- **W1 trigger fan-out:** max 5 addresses per log trigger and 10 triggers per workflow.

## 9. Example workflows

### 9a. Official example, verbatim: `cre-sdk-typescript/packages/cre-sdk-examples/src/workflows/log-trigger/main.ts` (@ `51ce64e`)

```ts
import {
	bigintToProtoBigInt,
	bytesToHex,
	EVMClient,
	type EVMLog,
	getNetwork,
	handler,
	logTriggerConfig,
	protoBigIntToBigint,
	Runner,
	type Runtime,
} from '@chainlink/cre-sdk'
import { z } from 'zod'

const configSchema = z.object({
	evms: z.array(
		z.object({
			messageEmitterAddress: z.string(),
			chainSelectorName: z.string(),
		}),
	),
})

type Config = z.infer<typeof configSchema>

const initWorkflow = (config: Config) => {
	const network = getNetwork({
		chainFamily: 'evm',
		chainSelectorName: config.evms[0].chainSelectorName,
		isTestnet: true,
	})

	if (!network) {
		throw new Error(
			`Network not found for chain selector name: ${config.evms[0].chainSelectorName}`,
		)
	}

	const evmClient = new EVMClient(network.chainSelector.selector)

	const onLogTrigger = (runtime: Runtime<Config>, payload: EVMLog): string => {
		runtime.log('Running LogTrigger')

		const topics = payload.topics

		if (topics.length < 3) {
			runtime.log('Log payload does not contain enough topics')
			throw new Error(`log payload does not contain enough topics ${topics.length}`)
		}

		runtime.log(`Contract address: ${bytesToHex(payload.address)}`)
		runtime.log(`Topics: ${payload.topics.map((t) => bytesToHex(t)).join(', ')}`)
		runtime.log(`Tx hash: ${bytesToHex(payload.txHash)}`)

		if (!payload.blockNumber) {
			throw new Error('Block number is required')
		}

		const blockNumber = protoBigIntToBigint(payload.blockNumber)
		runtime.log(`Block number: ${blockNumber}`)

		// Fetch block header to get timestamp
		const headerResponse = evmClient
			.headerByNumber(runtime, {
				blockNumber: bigintToProtoBigInt(blockNumber),
			})
			.result()

		const timestamp = headerResponse.header?.timestamp
		if (timestamp) {
			const date = new Date(Number(timestamp) * 1000)
			runtime.log(`Block timestamp: ${date.toISOString()}`)
		}

		return 'success'
	}

	// keccak256("MessageEmitted(address,uint256,string)")
	const MESSAGE_EMITTED_TOPIC =
		'0xc799f359194674b273986b8c03283265390f642b631c04e6526b99d0d8f4c38d' as `0x${string}`

	return [
		handler(
			evmClient.logTrigger(
				logTriggerConfig({
					addresses: [config.evms[0].messageEmitterAddress as `0x${string}`],
					topics: [[MESSAGE_EMITTED_TOPIC]],
				}),
			),
			onLogTrigger,
		),
	]
}

export async function main() {
	const runner = await Runner.newRunner<Config>({
		configSchema,
	})
	await runner.run(initWorkflow)
}
```

Its `config.staging.json`: `{"evms":[{"messageEmitterAddress":"0x1d598672486ecB50685Da5497390571Ac4E93FDc","chainSelectorName":"ethereum-testnet-sepolia"}]}`.

The official cron + HTTP + `callContract` + `report` + `writeReport` example is `cre-sdk-typescript/packages/cre-sdk-examples/src/workflows/on-chain-write/main.ts` (same commit): it uses `HTTPClient().sendRequest(runtime, fn, consensusMedianAggregation())`, `evmClient.callContract(runtime, { call: encodeCallMsg({...}), blockNumber: LAST_FINALIZED_BLOCK_NUMBER })`, `runtime.report(prepareReportRequest(callData))`, `evmClient.writeReport(runtime, { receiver, report })` and checks `resp.txStatus !== TxStatus.SUCCESS`.

### 9b. KIRCHHOFF probe workflow: verified to type-check and compile to WASM

Built locally on 2026-10-04 with `@chainlink/cre-sdk@1.23.0`, `viem@2.34.0`, `zod@3.25.76`, `typescript@5.9.3`, Bun 1.4.2, CRE CLI v1.36.0:

```
$ tsc --noEmit                                   -> TYPECHECK_OK
$ cre workflow build ./w --target staging-settings
✓ Workflow compiled successfully
  Binary hash: b217e87c116f5900815997858210d444f76f9abc378bc3ca68f970638a0294aa
✓ Build output written to .../w/binary.wasm      (2,629,861 bytes)
```

`cre workflow simulate` was not run (requires `cre login`). The `CCIPMessageSent` topic it uses was checked against live Sepolia OnRamp logs (see `ccip.md`). It exercises every PRD primitive: cron, EVM log trigger with FINALIZED confidence, `headerByNumber` at finalized, `callContract` at a pinned block, `filterLogs` in a 100-block window, `getTransactionReceipt`, `runInNodeMode` + identical consensus, `runtime.report`, `writeReport` with gas config.

`w/main.ts`:

```ts
import {
	bigintToProtoBigInt,
	bytesToHex,
	CronCapability,
	type CronPayload,
	consensusIdenticalAggregation,
	EVMClient,
	type EVMLog,
	encodeCallMsg,
	getNetwork,
	handler,
	LAST_FINALIZED_BLOCK_NUMBER,
	logTriggerConfig,
	prepareReportRequest,
	protoBigIntToBigint,
	Runner,
	type Runtime,
	TxStatus,
} from '@chainlink/cre-sdk'
import { type Address, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, toBytes, zeroAddress } from 'viem'
import { z } from 'zod'

const configSchema = z.object({
	schedule: z.string(),
	chainSelectorName: z.string(),
	watchedAddress: z.string(),
	receiverAddress: z.string(),
	gasLimit: z.string(),
})
type Config = z.infer<typeof configSchema>

const ERC20 = parseAbi(['function totalSupply() view returns (uint256)'])
const CCIP_MESSAGE_SENT = keccak256(
	toBytes('CCIPMessageSent(uint64,address,bytes32,address,uint256,bytes,(address,uint32,uint32,uint256,bytes)[],bytes[])'),
)

const evmFor = (name: string): EVMClient => {
	const network = getNetwork({ chainFamily: 'evm', chainSelectorName: name, isTestnet: true })
	if (!network) throw new Error(`unknown chain ${name}`)
	return new EVMClient(network.chainSelector.selector)
}

const onCron = (runtime: Runtime<Config>, _payload: CronPayload): string => {
	const evm = evmFor(runtime.config.chainSelectorName)
	const head = evm.headerByNumber(runtime, { blockNumber: LAST_FINALIZED_BLOCK_NUMBER }).result()
	if (!head.header?.blockNumber) throw new Error('no finalized header')
	const pinned = protoBigIntToBigint(head.header.blockNumber)
	const reply = evm
		.callContract(runtime, {
			call: encodeCallMsg({ from: zeroAddress, to: runtime.config.watchedAddress as Address, data: encodeFunctionData({ abi: ERC20, functionName: 'totalSupply' }) }),
			blockNumber: bigintToProtoBigInt(pinned),
		})
		.result()
	const logs = evm
		.filterLogs(runtime, {
			filterQuery: {
				addresses: [runtime.config.watchedAddress],
				topics: [{ topic: [CCIP_MESSAGE_SENT] }],
				fromBlock: bigintToProtoBigInt(pinned - 99n),
				toBlock: bigintToProtoBigInt(pinned),
			},
		})
		.result()
	runtime.log(`pinned=${pinned} callData=${bytesToHex(reply.data)} logs=${logs.logs.length}`)
	const payload = encodeAbiParameters(parseAbiParameters('uint64 pinnedBlock, uint256 logCount'), [pinned, BigInt(logs.logs.length)])
	const report = runtime.report(prepareReportRequest(payload)).result()
	const write = evm
		.writeReport(runtime, { receiver: runtime.config.receiverAddress, report, gasConfig: { gasLimit: runtime.config.gasLimit } })
		.result()
	if (write.txStatus !== TxStatus.SUCCESS) throw new Error(`write failed: ${write.errorMessage ?? write.txStatus}`)
	return bytesToHex(write.txHash ?? new Uint8Array(32))
}

const onLog = (runtime: Runtime<Config>, log: EVMLog): string => {
	const evm = evmFor(runtime.config.chainSelectorName)
	const receipt = evm.getTransactionReceipt(runtime, { hash: bytesToHex(log.txHash) }).result()
	const messageId = log.topics.length > 3 ? bytesToHex(log.topics[3]) : '0x'
	const agreed = runtime
		.runInNodeMode((_node, id: string) => id, consensusIdenticalAggregation<string>())(messageId)
		.result()
	runtime.log(`messageId=${agreed} receiptLogs=${receipt.receipt?.logs.length ?? 0}`)
	return agreed
}

const initWorkflow = (config: Config) => {
	const evm = evmFor(config.chainSelectorName)
	return [
		handler(new CronCapability().trigger({ schedule: config.schedule }), onCron),
		handler(
			evm.logTrigger(
				logTriggerConfig({ addresses: [config.watchedAddress as Address], topics: [[CCIP_MESSAGE_SENT]], confidence: 'FINALIZED' }),
			),
			onLog,
		),
	]
}

export async function main() {
	const runner = await Runner.newRunner<Config>({ configSchema })
	await runner.run(initWorkflow)
}
```

`w/package.json` dependencies: `"@chainlink/cre-sdk": "1.23.0", "viem": "2.34.0", "zod": "3.25.76"`, dev `"typescript": "5.9.3"`. `w/config.staging.json`: `schedule`, `chainSelectorName`, `watchedAddress`, `receiverAddress`, `gasLimit` (strings). `tsconfig.json` copied from `cre-templates/starter-templates/event-reactor/event-reactor-ts/my-workflow/tsconfig.json`.

## UNVERIFIED items in this file

- End-to-end `cre workflow simulate` behavior (no CRE login available to the researcher): trigger index ordering, `--broadcast` writes, and log replay were taken from docs and `--help`, not run.
- `experimental-chains` YAML for a fresh Anvil chain: read from CLI source only; undocumented; not run.
- Exact semantics of `ChainRead.CallLimit` (which EVM methods count; assumed all read methods).
- Arbitrum Sepolia block time (~0.25 s assumed) for sizing 100-block windows.
- `WASMConfigSizeLimit`: CLI default limits say 1 MB, docs say 50 KB.
- HTTP `cacheSettings` dedup behavior for POST webhooks across nodes.
- Whether Chainlink will raise the 3-workflow registry quota for the hackathon.
