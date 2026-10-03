# CCIP research: token pools, testnet addresses, CCT registration, ccipSend

Researched 2026-10-04.

| Source | Ref |
| --- | --- |
| `@chainlink/contracts-ccip` | npm **2.0.0** (`latest`; `beta` = `2.1.0-beta.0`). Solidity read from the npm tarball. Repo: `smartcontractkit/chainlink-ccip` `chains/evm/contracts/` (`main` @ `d0e9ff9`, 2026-10-02; docs link tag `contracts-ccip-v2.0.0`) |
| Testnet addresses | docs data `smartcontractkit/documentation` @ `2c185d0`: `src/config/data/ccip/v1_2_0/testnet/{chains,lanes,tokens,verifiers}.json`. **Every Router / OnRamp / OffRamp / TokenAdminRegistry / RegistryModuleOwnerCustom / TokenPoolFactory address below was also checked live with `eth_call typeAndVersion()` on public RPCs on 2026-10-04** |
| CCT tutorials | `src/content/ccip/v2/evm/tutorials/cross-chain-tokens/*.mdx`; repo https://github.com/smartcontractkit/docs-cct-foundry |
| ccip-cli | npm `@chainlink/ccip-cli` **1.15.0** (2026-09-30); help text below captured from the installed binary |

## TL;DR for engineers

1. **All three testnet lanes are CCIP 2.0.** OnRamp/OffRamp return `OnRamp 2.0.0` / `OffRamp 2.0.0`. Router is still `Router 1.2.0`; TokenAdminRegistry `1.5.0`; RegistryModuleOwnerCustom `1.6.0`. Pools: build against **`@chainlink/contracts-ccip@2.0.0`** V2 pools (`BurnMintTokenPool 2.0.0`, `LockReleaseTokenPool 2.0.0`). The reference CCIP-BnM pools on all three chains are `BurnMintTokenPool 2.0.0`.
2. **Pool events carry no message id.** `LockedOrBurned(uint64 indexed remoteChainSelector, address token, address sender, uint256 amount)` and `ReleasedOrMinted(uint64 indexed remoteChainSelector, address token, address sender, address recipient, uint256 amount)` (here `sender` = the OnRamp/OffRamp caller). Match a debit to a message id with the OnRamp's `CCIPMessageSent(... bytes32 indexed messageId ...)` emitted **in the same transaction**, and a credit with the OffRamp's `ExecutionStateChanged(..., bytes32 indexed messageId, ...)`. PRD W1/Judge "filterLogs on the pool debit by message id topic" must filter the **OnRamp** instead.
3. **The pool interface does not receive the message id either.** `Pool.ReleaseOrMintInV1` has `originalSender, remoteChainSelector, receiver, sourceDenominatedAmount, localToken, sourcePoolAddress, sourcePoolData, offchainTokenData`; no messageId. Fallback B can check "token BROKEN" and "receiver/sender tainted" inside the pool, but not "this specific message was matched".
4. **V2 LockRelease escrow lives in an `ERC20LockBox`, not the pool.** W2's "escrow balance" read must call `token.balanceOf(lockBox)` (`LockReleaseTokenPool.getLockBox()`).
5. **One token per message.** OnRamp 2.0.0 reverts `CanOnlySendOneTokenPerMessage()` if `tokenAmounts.length > 1`.
6. **Fallback B can be a hook, not a fork of the pool.** V2 pools call an optional `IAdvancedPoolHooks` (`preflightCheck` on source, `postflightCheck` on destination). Subclass `AdvancedPoolHooks 2.0.0` (functions are `virtual`) and add the KIRCHHOFF checks; the same hook contract also makes kETH require our CCV via `applyCCVConfigUpdates`. Standard `BurnMintTokenPool` / `LockReleaseTokenPool` stay unmodified.
7. CCT registration on testnet is **self-serve**: `RegistryModuleOwnerCustom.registerAdminViaOwner(token)` or `registerAdminViaGetCCIPAdmin(token)` -> `TokenAdminRegistry.acceptAdminRole(token)` -> `TokenAdminRegistry.setPool(token, pool)` -> `pool.applyChainUpdates(...)` on each chain.

---

## 1. Network table (verified live)

| | Ethereum Sepolia | Arbitrum Sepolia | Base Sepolia |
| --- | --- | --- | --- |
| Chain ID | 11155111 | 421614 | 84532 |
| CCIP chain name | `ethereum-testnet-sepolia` | `ethereum-testnet-sepolia-arbitrum-1` | `ethereum-testnet-sepolia-base-1` |
| Chain selector | `16015286601757825753` | `3478487238524512106` | `10344971235874465080` |
| Router (`Router 1.2.0`) | `0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59` | `0x2a9C5afB0d0e4BAb2BCdaE109EC4b0c4Be15a165` | `0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93` |
| OnRamp (`OnRamp 2.0.0`, one per chain for all lanes) | `0x8dcf17f298c881A547D91ca4aA3C2AD7568C6777` | `0x6B9a7cF69F90Ae2659bfe3069fba5Aa308A48cC4` | `0xA33b221A8427739c76f631a995ca60544bEdD632` |
| OffRamp (`OffRamp 2.0.0`) | `0xc6A246A9AcdAaE651708706494720F79C3E5d0A1` | `0xC93218EB7B778bC0c13E5296140C8E4Fa1C440DA` | `0xa137536A3BFd81aD6f090981268b8C2818451d41` |
| TokenAdminRegistry (1.5.0) | `0x95F29FEE11c5C55d26cCcf1DB6772DE953B37B82` | `0x8126bE56454B628a88C17849B9ED99dd5a11Bd2f` | `0x736D0bBb318c1B27Ff686cd19804094E66250e17` |
| RegistryModuleOwnerCustom (1.6.0) | `0xa3c796d480638d7476792230da1E2ADa86e031b0` | `0xaD417c0611dBD225471D31F056b8B6beC1CBC153` | `0x176ae8C6C11DD2c031B924CE1A0A43188035f3f6` |
| TokenPoolFactory | `0x2067C0444F9dc58cFB33B095279A28886562f169` (1.5.1) | `0xFc28e82F5D0780CF6074D5331Ca34859F92e6E54` (1.5.1) | `0x28E1D991F537b06e46027a86295e3FD2647aE139` (2.0.0, verified live) |
| RMN proxy (`armProxy`, 1.0.0) | `0xba3f6251de62dED61Ff98590cB2fDf6871FbB991` | `0x9527E2d01A3064ef6b50c1Da1C0cC523803BCFF2` | `0x99360767a4705f68CcCb9533195B761648d6d807` |
| LINK | `0x779877A7B0D9E8603169DdbD7836e478b4624789` | `0xb1D4538B4571d411F07960EF2838Ce337FE1E80E` | `0xE4aB69C077896252FAFBD49EFD26B5D171A32410` |
| WETH (fee token) | `0x097D90c9d3E0B50Ca60e1ae45F6A81010f9FB534` | `0xE591bf0A0CF924A0674d7792db046B23CEbF5f34` | `0x4200000000000000000000000000000000000006` |
| CCIP-BnM token / pool (`BurnMintTokenPool 2.0.0`) | `0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05` / `0xabc0dF19Ce41b0b5e711366636e32F5914493B99` | `0xA8C0c11bf64AF62CDCA6f93D3769B88BdD7cb93D` / `0xec182af18C19D68d1995AE064B52c8A7dfBd650d` | `0x88A2d74F47a237a62e7A51cdDa67270CE381555e` / `0xcf7371F9bAb265ecda53ba89dC7a48c10856A6D3` |
| Chainlink default CCV (`VersionedVerifierResolver 2.0.0`) | `0x8f3ee3c77D2B27c32306a89D367654F959Db223D` | same | same |
| Fee tokens | GHO, LINK, WETH, native | GHO, LINK, WETH, native | LINK, WETH, native |

Lanes (from `lanes.json`): all six directed lanes between these three chains exist, all v2.0.0. Arbitrum Sepolia and Base Sepolia OnRamps have `enforceOutOfOrder: false`.

The RMN proxy and the LINK/WETH/CCIP-BnM addresses come from docs data only. I did not call them live: UNVERIFIED on-chain, low risk.

## 2. Package and imports

```bash
npm i @chainlink/contracts-ccip@2.0.0
# brings @chainlink/contracts@1.5.0, @chainlink/ace@1.0.0,
# @openzeppelin/contracts-4.8.3 (npm alias) and @openzeppelin/contracts-5.3.0 (npm alias)
```

Imports inside the package use versioned OZ paths such as `@openzeppelin/contracts@5.3.0/utils/introspection/IERC165.sol`. Working remappings, verbatim from `chainlink-ccv-starter-kit-contracts/remappings.txt` (which uses this same package via npm):

```
forge-std/=lib/forge-std/src/
@chainlink/contracts-ccip/=node_modules/@chainlink/contracts-ccip/
@chainlink/contracts/=node_modules/@chainlink/contracts/
@chainlink/policy-management/=node_modules/@chainlink/ace/packages/policy-management/src/
@openzeppelin/contracts@4.8.3=node_modules/@openzeppelin/contracts-4.8.3
@openzeppelin/contracts@5.3.0=node_modules/@openzeppelin/contracts-5.3.0
```

Key paths inside the package (`contracts/`):

```
libraries/Pool.sol               Pool.LockOrBurnInV1 / LockOrBurnOutV1 / ReleaseOrMintInV1 / ReleaseOrMintOutV1
libraries/Client.sol             Client.EVM2AnyMessage, Any2EVMMessage, EVMTokenAmount, GenericExtraArgsV2
libraries/ExtraArgsCodec.sol     GenericExtraArgsV3 (CCV selection) + _encodeGenericExtraArgsV3
libraries/FinalityCodec.sol      WAIT_FOR_FINALITY_FLAG = bytes4(0), WAIT_FOR_SAFE_FLAG = bytes4(uint32(1 << 16))
interfaces/IPool.sol (IPoolV1), interfaces/IPoolV2.sol, interfaces/IAdvancedPoolHooks.sol, interfaces/IRouterClient.sol
pools/TokenPool.sol, BurnMintTokenPool.sol, BurnMintTokenPoolAbstract.sol, LockReleaseTokenPool.sol,
pools/ERC20LockBox.sol, pools/AdvancedPoolHooks.sol
tokenAdminRegistry/TokenAdminRegistry.sol, RegistryModuleOwnerCustom.sol
onRamp/OnRamp.sol, offRamp/OffRamp.sol, Router.sol
```

## 3. Pool structs (verbatim, `libraries/Pool.sol`)

```solidity
library Pool {
  bytes4 public constant CCIP_POOL_V1 = 0xaff2afbf;
  uint16 public constant CCIP_POOL_V1_RET_BYTES = 32;
  uint32 public constant CCIP_LOCK_OR_BURN_V1_RET_BYTES = 32;

  struct LockOrBurnInV1 {
    bytes receiver; //  The recipient of the tokens on the destination chain. For EVM source chains, this is abi-encoded (32 bytes).
    uint64 remoteChainSelector; // ─╮ The chain ID of the destination chain.
    address originalSender; // ─────╯ The original sender of the tx on the source chain.
    uint256 amount; //  The amount of tokens to lock or burn, denominated in the source token's decimals.
    address localToken; // The address on this chain of the token to lock or burn.
  }

  struct LockOrBurnOutV1 {
    bytes destTokenAddress;
    bytes destPoolData;
  }

  struct ReleaseOrMintInV1 {
    bytes originalSender; //            The original sender of the tx on the source chain.
    uint64 remoteChainSelector; // ───╮ The chain ID of the source chain.
    address receiver; // ─────────────╯ The recipient of the tokens on the destination chain.
    uint256 sourceDenominatedAmount; // The amount of tokens to release or mint, denominated in the source token's decimals.
    address localToken; //              The address on this chain of the token to release or mint.
    bytes sourcePoolAddress; //         The address of the source pool, abi encoded in the case of EVM chains.
    bytes sourcePoolData; //            The data received from the source pool to process the release or mint.
    bytes offchainTokenData; //         The offchain data to process the release or mint.
  }

  struct ReleaseOrMintOutV1 {
    uint256 destinationAmount;
  }
}
```

## 4. Pool interfaces

V2 (`interfaces/IPoolV2.sol`). The CCIP 2.0 OnRamp/OffRamp call these:

```solidity
function lockOrBurn(Pool.LockOrBurnInV1 calldata lockOrBurnIn, bytes4 requestedFinalityConfig, bytes calldata tokenArgs)
  external returns (Pool.LockOrBurnOutV1 memory lockOrBurnOut, uint256 destTokenAmount);
function releaseOrMint(Pool.ReleaseOrMintInV1 calldata releaseOrMintIn, bytes4 requestedFinalityConfig)
  external returns (Pool.ReleaseOrMintOutV1 memory releaseOrMintOut);
function getRequiredCCVs(address localToken, uint64 remoteChainSelector, uint256 sourceAmount,
  bytes4 requestedFinalityConfig, bytes calldata extraData, MessageDirection direction)
  external view returns (address[] memory requiredCCVs);           // enum MessageDirection { Outbound, Inbound }
function getTokenTransferFeeConfig(address localToken, uint64 destChainSelector, bytes4 requestedFinalityConfig, bytes calldata tokenArgs)
  external view returns (TokenTransferFeeConfig memory feeConfig);
function getFee(address localToken, uint64 destChainSelector, uint256 amount, address feeToken, bytes4 requestedFinalityConfig, bytes calldata tokenArgs)
  external view returns (uint256 feeUSDCents, uint32 destGasOverhead, uint32 destBytesOverhead, uint16 tokenFeeBps, bool isEnabled);
function getRemoteToken(uint64 remoteChainSelector) external view returns (bytes memory);
```

V1 (`interfaces/IPool.sol`, `interface IPoolV1`): `lockOrBurn(Pool.LockOrBurnInV1)`, `releaseOrMint(Pool.ReleaseOrMintInV1)`, `isSupportedChain(uint64)`, `isSupportedToken(address)`. `TokenPool 2.0.0` implements both (`IPoolV1V2`). The V1 entry points skip pool fees and use wait-for-finality. "V1 pools on CCIP 2.0 lanes ... CCV resolution falls back to lane defaults" (`token-issuer-guide.mdx`), so **a V1 pool cannot require our CCV.**

### TokenPool 2.0.0 base (`pools/TokenPool.sol`, `abstract contract TokenPool is IPoolV1V2, Ownable2StepMsgSender`)

Constructor: `constructor(IERC20 token, uint8 localTokenDecimals, address advancedPoolHooks, address rmnProxy, address router)`.

Validation path (V2 `lockOrBurn`): `_getFee` -> `_validateLockOrBurn` (supported token, RMN curse check `CursedByRMN()`, `_onlyOnRamp`, rate limit (FTF bucket if non-default finality), `_preflightCheck` -> `s_advancedPoolHooks.preflightCheck(...)`) -> `_lockOrBurn(remoteChainSelector, destTokenAmount)` -> `emit LockedOrBurned`.
`releaseOrMint`: `_calculateLocalAmount` (decimals from `sourcePoolData`) -> `_validateReleaseOrMint` (token, RMN, `_onlyOffRamp`, `isRemotePool(remoteChainSelector, sourcePoolAddress)` else `InvalidSourcePoolAddress`, inbound rate limit, `_postflightCheck` -> hooks `postflightCheck`) -> `_releaseOrMint(receiver, localAmount, remoteChainSelector)` -> `emit ReleasedOrMinted`.

Events (verbatim):

```solidity
event LockedOrBurned(uint64 indexed remoteChainSelector, address token, address sender, uint256 amount);
event ReleasedOrMinted(uint64 indexed remoteChainSelector, address token, address sender, address recipient, uint256 amount);
event ChainAdded(uint64 remoteChainSelector, bytes remoteToken, ...);
event ChainRemoved(uint64 remoteChainSelector);
event RemotePoolAdded(uint64 indexed remoteChainSelector, bytes remotePoolAddress);
event RemotePoolRemoved(uint64 indexed remoteChainSelector, bytes remotePoolAddress);
event OutboundRateLimitConsumed(uint64 indexed remoteChainSelector, address token, uint256 amount);
event InboundRateLimitConsumed(uint64 indexed remoteChainSelector, address token, uint256 amount);
event FinalityConfigSet(bytes4 allowedFinality);
event AdvancedPoolHooksUpdated(IAdvancedPoolHooks oldHook, IAdvancedPoolHooks newHook);
```

There are **no** separate `Burned` / `Minted` / `Locked` / `Released` events in 2.0.0. They are unified into `LockedOrBurned` / `ReleasedOrMinted`. Topic hashes were computed with viem and **confirmed against live Sepolia logs** (CCIP-BnM pool `0xabc0...3B99`, and Sepolia tx `0xdca61a6f2c82dc1755cbadc17e5897a31aecaf69775ac615fddc9cab31b2d602`):

| Event | topic0 |
| --- | --- |
| `LockedOrBurned(uint64,address,address,uint256)` | `0xf33bc26b4413b0e7f19f1ea739fdf99098c0061f1f87d954b11f5293fad9ae10` |
| `ReleasedOrMinted(uint64,address,address,address,uint256)` | `0xfc5e3a5bddc11d92c2dc20fae6f7d5eb989f056be35239f7de7e86150609abc0` |
| OnRamp `CCIPMessageSent(uint64,address,bytes32,address,uint256,bytes,(address,uint32,uint32,uint256,bytes)[],bytes[])` | `0x371bc2ff0a006f4ef863b1d27a065d4e9f938b6d883eb154572b4aea593b32cc` |
| OffRamp `ExecutionStateChanged(uint64,uint64,bytes32,uint8,bytes)` | `0x8c324ce1367b83031769f6a813e3bb4c117aba2185789d66b98b791405be6df2` (computed, not seen live) |
| ERC-20 `Transfer` | `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` |

OnRamp 2.0.0 / OffRamp 2.0.0 events (verbatim):

```solidity
event CCIPMessageSent(
  uint64 indexed destChainSelector,
  address indexed sender,
  bytes32 indexed messageId,
  address feeToken,
  uint256 tokenAmountBeforeTokenPoolFees,
  bytes encodedMessage,
  Receipt[] receipts,
  bytes[] verifierBlobs
);
struct Receipt { address issuer; uint32 destGasLimit; uint32 destBytesOverhead; uint256 feeTokenAmount; bytes extraArgs; }

event ExecutionStateChanged(
  uint64 indexed sourceChainSelector,
  uint64 indexed messageNumber,
  bytes32 indexed messageId,
  Internal.MessageExecutionState state,
  bytes returnData
);
```

Order within a Sepolia send tx (observed): token pool rate-limit event, `LockedOrBurned` from the pool, then `CCIPMessageSent` from the OnRamp. The **burn itself emits ERC-20 `Transfer(pool, 0x0, amount)`** from the token, so supply indexing can also use `Transfer` to/from zero.

### BurnMintTokenPool 2.0.0

```solidity
contract BurnMintTokenPool is BurnMintTokenPoolAbstract, ITypeAndVersion {   // "BurnMintTokenPool 2.0.0"
  constructor(IBurnMintERC20 token, uint8 localTokenDecimals, address advancedPoolHooks, address rmnProxy, address router)
  function _lockOrBurn(uint64, uint256 amount) internal virtual override { IBurnMintERC20(address(i_token)).burn(amount); }
}
// BurnMintTokenPoolAbstract._releaseOrMint(receiver, amount, ...) -> IBurnMintERC20(address(i_token)).mint(receiver, amount)
```

The token must implement `IBurnMintERC20` (`mint(address,uint256)`, `burn(uint256)`, `burn(address,uint256)`, `burnFrom(address,uint256)`) and grant the pool mint and burn roles. The pool burns tokens it already holds; the Router transfers them in first. Variants: `BurnFromMintTokenPool`, `BurnWithFromMintTokenPool`, `BurnToAddressMintTokenPool`.

### LockReleaseTokenPool 2.0.0

```solidity
contract LockReleaseTokenPool is TokenPool, ITypeAndVersion {   // "LockReleaseTokenPool 2.0.0"
  constructor(IERC20 token, uint8 localTokenDecimals, address advancedPoolHooks, address rmnProxy, address router, address lockBox)
  function getLockBox() external view returns (address);
  function _lockOrBurn(uint64 remoteChainSelector, uint256 amount) internal override { i_lockBox.deposit(address(i_token), remoteChainSelector, amount); }
  function _releaseOrMint(address receiver, uint256 amount, uint64 remoteChainSelector) internal override { i_lockBox.withdraw(address(i_token), remoteChainSelector, amount, receiver); }
}
// ERC20LockBox 2.0.0: constructor(address token); deposit(address token, uint64, uint256 amount); withdraw(address token, uint64, uint256 amount, address recipient)
```

The lock box must support the token, and the pool must be an authorized caller of the lock box (it is `AuthorizedCallers`). Escrow = `IERC20(kETH).balanceOf(lockBox)`. Fees deducted on V2 lockOrBurn stay on the pool contract, not the lock box.

### AdvancedPoolHooks 2.0.0 (CCV requirement + Fallback B hook point)

```solidity
interface IAdvancedPoolHooks {
  function preflightCheck(Pool.LockOrBurnInV1 calldata lockOrBurnIn, bytes4 requestedFinalityConfig, bytes calldata tokenArgs, uint256 amountPostFee) external;
  function postflightCheck(Pool.ReleaseOrMintInV1 calldata releaseOrMintIn, uint256 localAmount, bytes4 requestedFinalityConfig) external;
  function getRequiredCCVs(address localToken, uint64 remoteChainSelector, uint256 amount, bytes4 requestedFinalityConfig, bytes calldata extraData, IPoolV2.MessageDirection direction) external view returns (address[] memory requiredCCVs);
}

contract AdvancedPoolHooks is IAdvancedPoolHooks, ITypeAndVersion, AuthorizedCallers {   // "AdvancedPoolHooks 2.0.0"
  constructor(address[] memory allowlist, uint256 thresholdAmountForAdditionalCCVs, address policyEngine, address[] memory authorizedCallers)
  struct CCVConfigArg { uint64 remoteChainSelector; address[] outboundCCVs; address[] thresholdOutboundCCVs; address[] inboundCCVs; address[] thresholdInboundCCVs; }
  function applyCCVConfigUpdates(CCVConfigArg[] calldata ccvConfigArgs) public virtual onlyOwner;
  function getCCVConfig(uint64) / getAllCCVConfigs() / setThresholdAmount(uint256) / getThresholdAmount()
  event CCVConfigUpdated(uint64 indexed remoteChainSelector, address[] outboundCCVs, address[] thresholdOutboundCCVs, address[] inboundCCVs, address[] thresholdInboundCCVs);
}
```

Rules from `concepts/cross-chain-token/advanced-pool-hooks.mdx`:
- A non-empty base list **replaces the lane default CCVs for token-only transfers**. To keep the Chainlink committee and add ours, set `outboundCCVs = inboundCCVs = [address(0), <our VersionedVerifierResolver>]` for every remote chain, on each chain's hook.
- Use the resolver address, not the verifier implementation (otherwise the fee quote reverts with no data; `ccv-starter-kit/evm/test-your-setup.mdx`).
- `authorizedCallers` must include the pool; the pool owner sets the hook (constructor arg or `updateAdvancedPoolHooks`).
- The hook sees the post-fee amount; inbound amounts are converted to local decimals first.

Fallback B recommendation: `contract KirchhoffPoolHooks is AdvancedPoolHooks` that overrides `preflightCheck` (revert if the ledger status is BROKEN/QUARANTINED/RECOVERING, or `isTainted(originalSender)`) and `postflightCheck` (same, plus `isTainted(receiver)`), then calls `super`. Verified: both are `public virtual` in `AdvancedPoolHooks.sol` 2.0.0 (lines 96-101 and 117-121) and begin with `_validateCaller(); checkAllowList(...)`, so call `super.preflightCheck(...)` / `super.postflightCheck(...)` to keep the allowlist and policy-engine behavior.

## 5. CCT self-serve registration (testnet)

Per chain, in order (`register-from-eoa-burn-mint-foundry.mdx`, scripts in https://github.com/smartcontractkit/docs-cct-foundry):

1. Deploy the token (`IBurnMintERC20`-compatible for burn/mint chains; plain ERC-20 + `ERC20LockBox` on the lock chain). Expose `owner()` (Ownable) or `getCCIPAdmin()`.
2. Deploy the pool (`BurnMintTokenPool` or `LockReleaseTokenPool`) with `(token, decimals, advancedPoolHooks or address(0), rmnProxy, router)`. Grant the pool mint/burn roles, or authorize it on the lock box.
3. Claim admin: `RegistryModuleOwnerCustom.registerAdminViaGetCCIPAdmin(address token)` or `registerAdminViaOwner(address token)` (also `registerAccessControlDefaultAdmin(address token)`). It must be called by that admin address.
4. Accept: `TokenAdminRegistry.acceptAdminRole(address localToken)`.
5. Link: `TokenAdminRegistry.setPool(address localToken, address pool)` (onlyTokenAdmin). Emits `PoolSet(address indexed token, address indexed previousPool, address indexed newPool)`.
6. Wire lanes: `pool.applyChainUpdates(uint64[] remoteChainSelectorsToRemove, ChainUpdate[] chainsToAdd)` with `struct ChainUpdate { uint64 remoteChainSelector; bytes[] remotePoolAddresses; bytes remoteTokenAddress; RateLimiter.Config outboundRateLimiterConfig; RateLimiter.Config inboundRateLimiterConfig; }`. Addresses are `abi.encode(address)`.
7. (CCV) Deploy `AdvancedPoolHooks` with `authorizedCallers=[pool]`, set it on the pool, and call `applyCCVConfigUpdates`.

Tutorial commands (Foundry scripts from `docs-cct-foundry`):

```bash
git clone https://github.com/smartcontractkit/docs-cct-foundry.git && cd docs-cct-foundry
cast wallet import <keystore> --interactive && cp .env.example .env
CCIP_ADMIN_ADDRESS=<admin> forge script script/setup/ClaimAdmin.s.sol --rpc-url $ETHEREUM_SEPOLIA_RPC_URL --account $KEYSTORE_NAME --broadcast
forge script script/setup/AcceptAdminRole.s.sol --rpc-url $ETHEREUM_SEPOLIA_RPC_URL --account $KEYSTORE_NAME --broadcast
# plus DeployToken.s.sol, pool deploy, SetPool, ApplyChainUpdates scripts (see repo script/ dir); env var naming: ETHEREUM_TESTNET_SEPOLIA_ARBITRUM_1_RPC_URL etc.
```

Other relevant tutorials in the same folder: `configure-sender-allowlist-advanced-pool-hooks-foundry.mdx`, `enforce-ace-policies-foundry.mdx`, `set-transfer-fee-config-foundry.mdx`, `update-rate-limiters-foundry.mdx`, `migrate-from-v1-to-v2-*.mdx`.

## 6. Sending a message

Router 1.2.0 (`interfaces/IRouterClient.sol`):

```solidity
function isChainSupported(uint64 destChainSelector) external view returns (bool supported);
function getFee(uint64 destinationChainSelector, Client.EVM2AnyMessage memory message) external view returns (uint256 fee);
function ccipSend(uint64 destinationChainSelector, Client.EVM2AnyMessage calldata message) external payable returns (bytes32);

struct EVM2AnyMessage {
  bytes receiver;                  // abi.encode(receiver address) for dest EVM chains.
  bytes data;
  Client.EVMTokenAmount[] tokenAmounts;   // { address token; uint256 amount; }  max 1 entry on 2.0 lanes
  address feeToken;                // address(0) = pay in native via msg.value
  bytes extraArgs;
}
```

Extra args:
- Legacy `Client.GenericExtraArgsV2 { uint256 gasLimit; bool allowOutOfOrderExecution; }` with tag `0x181dcf10` via `Client._argsToBytes(...)`. Empty `extraArgs` = 200k gas default.
- CCIP 2.0 `ExtraArgsCodec.GenericExtraArgsV3` (tag `0xa69dd4aa`; packed custom encoding, not `abi.encode`): fields `uint32 gasLimit; bytes4 requestedFinalityConfig; address[] ccvs; bytes[] ccvArgs; address executor; bytes executorArgs; bytes tokenReceiver; bytes tokenArgs`. Encode with `ExtraArgsCodec._encodeGenericExtraArgsV3(args)`. `ccvs` empty = defaults; `executor = address(0)` = default executor; `requestedFinalityConfig = bytes4(0)` = wait for finality, `FinalityCodec.WAIT_FOR_SAFE_FLAG` = safe head, low 16 bits = block depth.
- For pure token transfers to an EOA set `gasLimit = 0`.

Flow: approve the Router for `tokenAmounts` (and for `fee` if paying in LINK), `fee = router.getFee(dest, msg)`, then `router.ccipSend{value: native ? fee : 0}(dest, msg)`. The returned `bytes32` is the messageId (same as `CCIPMessageSent.messageId`).

### ccip-cli (`npm install -g @chainlink/ccip-cli`, v1.15.0)

Commands: `show <tx-hash-or-id>` (default), `send`, `manualExec|manual-exec`, `lane|get-lane`, `laneLatency`, `parse`, `search`, `getSupportedTokens`, `token`.

```bash
# fee quote
ccip-cli send -s ethereum-testnet-sepolia -d ethereum-testnet-sepolia-arbitrum-1 \
  -r 0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59 --only-get-fee
# token transfer (wallet: private key, foundry:<keystore>, hardhat:<name>, ledger)
ccip-cli send -s ethereum-testnet-sepolia -d ethereum-testnet-sepolia-base-1 \
  -r 0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59 --to <destWallet> -t <kETH>=1000000000000000000 \
  --fee-token LINK -w foundry:<keystore> --rpcs <sepoliaRpc> <baseSepoliaRpc>
# show which CCVs the destination requires for this send (checks our hook config)
ccip-cli send ... --only-ccvs
# request specific CCVs on a data message
ccip-cli send ... --data "hello" -L 200000 -x ccvs='["<resolver>"]'
# self-execute through our own aggregator (needed until CCV indexer onboarding)
ccip-cli manual-exec <src-tx> --verifiers grpcs://<aggregator-host>:443
ccip-cli show <messageId> --rpcs <destRpc> --json
```

Other `send` flags: `-L/--gas-limit`, `--estimate-gas-limit`, `--ooo`, `-G/--tx-gas-limit`, `--approve-max`, `--wait`, `--only-estimate`, `--rpcs-file` (default `./.env`), `--chain-selectors "<chainId>=<chain name>"` (for an `anvil --fork --chain-id` fork of a known chain), `--no-interactive`, `-f json`.

Explorer and API:
- CCIP Explorer message: `https://ccip.chain.link/#/side-drawer/msg/<messageId>` (URL pattern used in the docs tutorials). Tx lookup in the explorer by source tx hash: UNVERIFIED URL pattern.
- REST: `https://api.ccip.chain.link/v2/messages/<messageId>` (`.status` = `SUCCESS` when executed).

## 7. Faucets

All returned HTTP 200 on 2026-10-04:
- Sepolia ETH + LINK: https://faucets.chain.link/sepolia
- Arbitrum Sepolia ETH + LINK: https://faucets.chain.link/arbitrum-sepolia
- Base Sepolia ETH + LINK: https://faucets.chain.link/base-sepolia
- Hub: https://faucets.chain.link (LINK drips per chain; amounts and rate limits UNVERIFIED)
- CCIP-BnM test tokens can be minted with `drip(address)` on the CCIP-BnM token (well known from earlier docs; not re-checked in 2.0 docs: UNVERIFIED).

## 8. Finality pacing for the demo

- CCV verifier default (finalized) wait on Ethereum Sepolia: "roughly 13 to 17 minutes" (`ccv-starter-kit/evm/test-your-setup.mdx`). A message that requests `safe` or a block depth is faster.
- CRE FINALIZED uses the native `finalized` tag on all three chains (`cre/concepts/finality-ts.mdx`).
- `ccip-cli laneLatency <source> <dest>` queries live lane latency (not run).
- Arbitrum and Base Sepolia finality depends on L1 Sepolia batch posting and finalization, so expect tens of minutes. Exact numbers: UNVERIFIED.

## UNVERIFIED items in this file

- Whether those remappings compile cleanly together with OpenZeppelin 5.x for our own contracts (forge is not installed here).
- On-chain verification of the RMN proxy, LINK, WETH, and CCIP-BnM addresses (docs data only).
- `ExecutionStateChanged` topic was computed, not observed live.
- CCIP Explorer URL for a source tx hash; faucet drip amounts; CCIP-BnM `drip` on the 2.0 token.
- L2 testnet finality durations.
