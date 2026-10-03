# KIRCHHOFF contracts

Foundry project for the KIRCHHOFF onchain suite (PRD section 7) and the testnet-only demo suite.
Solidity 0.8.26, optimizer on (200 runs), `via_ir` off, EVM `cancun`.

## Commands

```bash
export PATH=$HOME/.foundry/bin:$PATH
cd contracts
npm ci                                   # Solidity deps (see "Upstream versions"); forge install is not used
forge build                              # compiles clean, no warnings
forge fmt --check                        # formatting gate
forge lint                               # 0 findings (reviewed exclusions in foundry.toml)
forge test                               # unit + fuzz + invariant, fork-free
forge snapshot                           # writes .gas-snapshot
forge coverage --report summary --no-match-coverage "(script|test)/"
```

Root `Makefile` note for the lead: `make install` runs `cd contracts && forge install`, which fails here because
dependencies come from npm. Replace it with `cd contracts && npm ci`.

## Layout

```
src/interfaces/   frozen ABI: KirchhoffTypes (Status, Epoch, Breach, ReportType, Reason, KirchhoffIds),
                  IConservationLedger, IQuarantineController, IKirchhoffGuard, IConservationFeed,
                  AggregatorV3Interface, IKirchhoffRegistry
src/              production: CREReceiver, ConservationLedger, QuarantineController, ConservationFeed,
                  KirchhoffGuard, KirchhoffRegistry, KirchhoffProtected, KirchhoffTokenPool (mixin),
                  KirchhoffBurnMintTokenPool, KirchhoffLockReleaseTokenPool
src/demo/         TESTNET SIMULATION ONLY: KETH, RemoteKETH, HomeEscrowAdapter, WeakBridge, BridgeRegistry,
                  IBridgeEvents, DemoLendingMarket (+ DemoUSD), MockKeystoneForwarder, LocalCCIPMocks
test/             unit suites, fuzz/BridgeConservation.t.sol, invariant/LedgerInvariants.t.sol
script/           Deploy.s.sol (one chain), ConfigureLanes.s.sol (CCIP pool wiring between chains)
```

## Upstream versions (verified from source, 2026-10-04)

| Dependency | Version | How it is used |
| --- | --- | --- |
| `@chainlink/contracts-ccip` | npm **2.0.0** (repo `smartcontractkit/chainlink-ccip`, tag `contracts-ccip-v2.0.0`, commit `c2c125c27f056db2e98d21501922b6eff5750f36`) | `TokenPool`, `BurnMintTokenPool 2.0.0`, `LockReleaseTokenPool 2.0.0`, `ERC20LockBox 2.0.0`, `Pool`, `RateLimiter`, `IBurnMintERC20`, `IGetCCIPAdmin`. All three testnet lanes run OnRamp/OffRamp 2.0.0 (docs/research/ccip.md). |
| `@chainlink/contracts` | npm **1.5.0** (repo `smartcontractkit/chainlink-evm`, tag `contracts-v1.5.0`) | `keystone/interfaces/IReceiver.sol`; `keystone/KeystoneForwarder.sol` (tests only, real DON-signature path); `shared/access/AuthorizedCallers` |
| CRE `ReceiverTemplate` | docs sample `public/samples/CRE/ReceiverTemplate.sol`, `smartcontractkit/documentation` @ `2c185d0` (page revision 2026-05-08) | pattern and metadata decoding reproduced in `src/CREReceiver.sol` (see decisions) |
| `@openzeppelin/contracts` | **5.3.0** (also mapped as `@openzeppelin/contracts@5.3.0/`, the exact copy CCIP 2.0.0 pins) | all project code |
| `@openzeppelin/contracts` 5.0.2 / 4.8.3 | npm aliases | only because `IReceiver` (5.0.2) and `KeystoneForwarder` / `AuthorizedCallers` (4.8.3) import them |
| `forge-std` | **v1.16.1** (git tag, same as CCIP 2.0.0's dev dependency) | tests and scripts |
| Foundry | forge 1.8.4 (`50af4ef`) | |

## Deploying

`script/Deploy.s.sol` deploys the full production + demo suite for one chain and writes
`../deployments/<NETWORK>.json`. It is idempotent: recorded addresses that still have code are reused and every
configuration step checks onchain state first, so it is safe to re-run (a second run broadcasts nothing).

```bash
# Home (Ethereum Sepolia), CRE simulation forwarder, 10-minute testnet registry timelock
NETWORK=eth-sepolia ROLE=home FORWARDER_MODE=simulation REGISTRY_TIMELOCK_SECONDS=600 \
ISSUER_SAFE_ADDRESS=0x... WEAKBRIDGE_VERIFIER=0x... DEPLOYER_PRIVATE_KEY=0x... \
forge script script/Deploy.s.sol --rpc-url $RPC_ETH_SEPOLIA_1 --broadcast --verify

# Remotes
NETWORK=arb-sepolia  ROLE=remote FORWARDER_MODE=simulation ... --rpc-url $RPC_ARB_SEPOLIA_1
NETWORK=base-sepolia ROLE=remote FORWARDER_MODE=simulation ... --rpc-url $RPC_BASE_SEPOLIA_1

# Wire CCIP pools (run on each chain once all three exist)
NETWORK=eth-sepolia REMOTE_NETWORKS=arb-sepolia,base-sepolia DEPLOYER_PRIVATE_KEY=0x... \
forge script script/ConfigureLanes.s.sol --rpc-url $RPC_ETH_SEPOLIA_1 --broadcast
```

Local Anvil (chain ids 31337/31338/31339 from docs/INTERFACES.md): omit `FORWARDER_MODE`; the script deploys
`MockKeystoneForwarder`, `LocalRouterMock` and `LocalRMNMock` itself. Mocks are refused on any other chain id.

| Env | Meaning |
| --- | --- |
| `DEPLOYER_PRIVATE_KEY`, `NETWORK`, `ROLE` (`home`/`remote`), `ISSUER_SAFE_ADDRESS`, `WEAKBRIDGE_VERIFIER` | required |
| `FORWARDER_MODE` | `production` (KeystoneForwarder), `simulation` (Chainlink MockKeystoneForwarder), `local` (Anvil only, default there) |
| `WORKFLOW_OWNER`, `WORKFLOW_ID_W1/W2/W3`, `WORKFLOW_NAME_W1/W2/W3` | authorize production workflows (W1: BREACH; W2: EPOCH, BREACH, RECOVERY_CHECK; W3: QUARANTINE_APPLIED). Ids come from `cre workflow hash` and change with the config, which embeds these addresses, so re-run after hashing. |
| `KEYSTONE_FORWARDER`, `CHAIN_SELECTOR`, `CCIP_ROUTER`, `CCIP_RMN_PROXY`, `CCIP_TOKEN_ADMIN_REGISTRY`, `CCIP_REGISTRY_MODULE`, `LINK_TOKEN` | override the built-in address book |
| `REGISTRY_TIMELOCK_SECONDS` (172800, min 600), `STALENESS_SECONDS` (120), `RECOVERY_TIMELOCK_SECONDS` (3600), `TOKEN_SYMBOL` (kETH) | parameters |
| `HANDOFF_TO_SAFE` | start Ownable2Step transfers of ledger, quarantine, registry and pool ownership to the issuer Safe (the Safe must `acceptOwnership`) |

In `simulation` and `local` modes the ledger pins the simulator's fixed metadata (workflowId `0x11..11`, owner
`0xaa..aa`, any name) for all report types. The simulation forwarder is permissionless, so such a ledger is
public-writable by anyone who forges that metadata: label it "Testnet simulation" everywhere. `forwarderMode()`
and the JSON field `forwarderMode` record which mode a ledger is in.

On testnets the script also performs self-serve CCT registration (`registerAdminViaOwner` for kETH,
`registerAdminViaGetCCIPAdmin` for RemoteKETH, then `acceptAdminRole` and `setPool`).

### Built-in address book (verified live 2026-10-04, docs/research/cre-contracts.md section 5, ccip.md section 1)

| | Ethereum Sepolia | Arbitrum Sepolia | Base Sepolia |
| --- | --- | --- | --- |
| KeystoneForwarder 1.0.0 | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` | `0x76c9cf548b4179F8901cda1f8623568b58215E62` | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` |
| MockKeystoneForwarder 1.0.0 (simulation) | `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` | `0xD41263567DdfeAd91504199b8c6c87371e83ca5d` | `0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5` |
| CCIP Router 1.2.0 | `0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59` | `0x2a9C5afB0d0e4BAb2BCdaE109EC4b0c4Be15a165` | `0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93` |
| RMN proxy | `0xba3f6251de62dED61Ff98590cB2fDf6871FbB991` | `0x9527E2d01A3064ef6b50c1Da1C0cC523803BCFF2` | `0x99360767a4705f68CcCb9533195B761648d6d807` |
| TokenAdminRegistry 1.5.0 | `0x95F29FEE11c5C55d26cCcf1DB6772DE953B37B82` | `0x8126bE56454B628a88C17849B9ED99dd5a11Bd2f` | `0x736D0bBb318c1B27Ff686cd19804094E66250e17` |
| RegistryModuleOwnerCustom 1.6.0 | `0xa3c796d480638d7476792230da1E2ADa86e031b0` | `0xaD417c0611dBD225471D31F056b8B6beC1CBC153` | `0x176ae8C6C11DD2c031B924CE1A0A43188035f3f6` |
| LINK | `0x779877A7B0D9E8603169DdbD7836e478b4624789` | `0xb1D4538B4571d411F07960EF2838Ce337FE1E80E` | `0xE4aB69C077896252FAFBD49EFD26B5D171A32410` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | same | same |

## Design decisions where the PRD left room

1. **CRE receiver.** `ReceiverTemplate` supports one expected workflow id, but three workflows (W1, W2, W3) write to
   the ledger. `CREReceiver` keeps the template's metadata decoding, name encoding (`sha256` hex, first 10 chars),
   errors and ERC-165 surface, and replaces the single id with an allowlist `workflowId -> (owner, name, allowed
   report types)`. The forwarder can never be zero (the template allows disabling it), metadata must be exactly 64
   bytes, and forwarder address and mode change together through `setForwarder`.
2. **Fallback B overrides the validation choke points.** `KirchhoffBurnMintTokenPool` / `KirchhoffLockReleaseTokenPool`
   inherit the unmodified upstream 2.0.0 pools and override `_validateLockOrBurn` / `_validateReleaseOrMint`, which
   every V1 and V2 `lockOrBurn` / `releaseOrMint` overload passes through, running the upstream checks first.
   `KirchhoffTokenPool` is a mixin because `LockReleaseTokenPool` marks `_lockOrBurn` / `_releaseOrMint` non-virtual.
   Pools allow only CONSERVED or DRIFT with a fresh status (stale always fails closed), no frozen lanes, and no
   tainted sender/receiver on either end. CCV requirement via `AdvancedPoolHooks.applyCCVConfigUpdates` is not wired
   (no hooks contract is deployed; `advancedPoolHooks = address(0)`).
3. **Home escrow.** CCIP liquidity sits in the upstream `ERC20LockBox` (`pool.getLockBox()`); WeakBridge liquidity sits in
   `HomeEscrowAdapter`. Home backing for the Loop Rule is the sum of both balances.
4. **EPOCH from UNKNOWN must be CONSERVED** (PRD transition table); `UNKNOWN -> DRIFT` reverts.
5. **BREACH is idempotent per incident** (`incidentId = keccak256(abi.encode(tokenId, evidenceHash))`): W1 writes the
   same breach to all chains and CRE may redeliver, so a repeat is a silent no-op. A new breach on a BROKEN or
   QUARANTINED token stores evidence and still taints its recipient, without changing status or the active incident.
   A breach during RECOVERING re-breaks the token and becomes the new active incident.
6. **QUARANTINE_APPLIED and resolve must name the active incident**, so a stale or wrong incident cannot advance the
   state machine.
7. **Epoch high-water mark.** The production forwarder lets anyone retry a FAILED transmission. EPOCHs ignored during
   containment still raise a per-token high-water mark, and EPOCH / RECOVERY_CHECK ordering is checked against it,
   so a RECOVERY_CHECK that failed in an earlier incident cannot be replayed to clear a later one.
8. **Governance.** Operator (Ownable2Step owner) can only wire contracts and register tokens once; every release of
   containment (resolve, untaint, staleness, recovery timelock, spec changes, issuer rotation) is issuer-Safe only.
   Spec activation is permissionless once the timelock elapses. Registry timelock bounded to [600s, 48h].
9. **Feed rounds.** The ledger keeps only the latest state, so `roundId` is the ledger's per-token revision (it bumps on
   every applied write) and `getRoundData` serves only the latest round, reverting `NoDataPresent()` otherwise.
10. **WeakBridge credits** are EIP-712 (`Credit(bytes32 id,address to,uint256 amount,uint64 srcChain)`, domain
    `WeakBridge`/`1` with chain id and contract address). Registries `debitOf` / `creditOf` follow INTERFACES.md
    Revision 2; on the home chain the bridge reads through to the escrow.
11. **MockKeystoneForwarder** mirrors the deployed simulation mock (permissionless, unsigned, no ERC-165 check, no
    replay guard, reverting receiver reported as `ReportProcessed(..., false)`), plus a zero-receiver check.
