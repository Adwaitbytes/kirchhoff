import { parseAbi } from "viem";

/**
 * ABIs of the frozen KIRCHHOFF interfaces (contracts/src/interfaces, docs/INTERFACES.md) and the
 * demo bridge events. Human-readable so a review can diff them against the Solidity line by line.
 */
export const ledgerAbi = parseAbi([
  "struct Epoch { uint64 epochId; int256 delta; uint64 evaluatedAt; bytes32 blocksHash; bytes32 evidenceHash; uint8 status; uint16 reason; }",
  "struct Breach { bytes32 tokenId; uint64 epochId; int256 delta; bytes32 blocksHash; bytes32 evidenceHash; uint16 reason; uint64 offendingChain; bytes32 offendingTx; address recipient; uint256 amount; bytes32 messageId; uint64 recordedAt; }",
  "function statusOf(bytes32 tokenId) view returns (uint8 status, int256 delta, uint64 updatedAt, bool stale)",
  "function latestEpoch(bytes32 tokenId) view returns (Epoch)",
  "function isConsumed(bytes32 messageId) view returns (bool)",
  "function isRegistered(bytes32 tokenId) view returns (bool)",
  "function stalenessSeconds(bytes32 tokenId) view returns (uint64)",
  "function recoveryEndsAt(bytes32 tokenId) view returns (uint64)",
  "function activeIncident(bytes32 tokenId) view returns (bytes32)",
  "function breachOf(bytes32 incidentId) view returns (Breach)",
  "function chainSelector() view returns (uint64)",
  "event EpochRecorded(bytes32 indexed tokenId, uint64 indexed epochId, int256 delta, uint8 status)",
  "event StatusChanged(bytes32 indexed tokenId, uint8 from, uint8 to, uint16 reason)",
  "event BreachRecorded(bytes32 indexed tokenId, uint16 reason, bytes32 evidenceHash, uint64 offendingChain, bytes32 offendingTx, address recipient, uint256 amount)",
  "event MessageConsumed(bytes32 indexed tokenId, bytes32 indexed messageId)",
  "event IncidentOpened(bytes32 indexed tokenId, bytes32 indexed incidentId, bytes32 evidenceHash)",
  "event RecoveryStarted(bytes32 indexed tokenId, bytes32 indexed incidentId, uint64 recoveryEndsAt)",
  "event TokenRegistered(bytes32 indexed tokenId, uint64 stalenessSeconds)",
]);

export const quarantineAbi = parseAbi([
  "function isFrozen(bytes32 tokenId) view returns (bool)",
  "function isTainted(bytes32 tokenId, address account) view returns (bool)",
  "function issuerOf(bytes32 tokenId) view returns (address)",
  "function recoveryTimelockOf(bytes32 tokenId) view returns (uint64)",
  "event LanesFrozen(bytes32 indexed tokenId, bytes32 indexed incidentId)",
  "event LanesUnfrozen(bytes32 indexed tokenId)",
  "event Tainted(bytes32 indexed tokenId, address indexed account, bytes32 indexed incidentId)",
  "event Untainted(bytes32 indexed tokenId, address indexed account)",
  "event IncidentResolved(bytes32 indexed tokenId, bytes32 indexed incidentId, uint64 recoveryEndsAt)",
]);

export const registryAbi = parseAbi([
  "struct Spec { bytes32 specHash; string specURI; uint64 version; uint64 activatedAt; }",
  "struct PendingSpec { bytes32 specHash; string specURI; uint64 eta; }",
  "function timelockSeconds() view returns (uint64)",
  "function issuerOf(bytes32 tokenId) view returns (address)",
  "function activeSpec(bytes32 tokenId) view returns (Spec)",
  "function pendingSpec(bytes32 tokenId) view returns (PendingSpec)",
  "function activeSpecHash(bytes32 tokenId) view returns (bytes32)",
  "event TokenRegistered(bytes32 indexed tokenId, string symbol, address indexed issuerSafe)",
  "event SpecProposed(bytes32 indexed tokenId, bytes32 indexed specHash, string specURI, uint64 eta)",
  "event SpecProposalCancelled(bytes32 indexed tokenId, bytes32 indexed specHash)",
  "event SpecActivated(bytes32 indexed tokenId, bytes32 indexed specHash, string specURI, uint64 version)",
]);

export const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function latestDelta() view returns (int256)",
]);

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** WeakBridge (remotes) and HomeEscrowAdapter (home), frozen in docs/INTERFACES.md. */
export const bridgeAbi = parseAbi([
  "event Burned(bytes32 indexed id, address indexed from, address to, uint256 amount, uint64 dstChain)",
  "event Released(bytes32 indexed id, address indexed to, uint256 amount, uint64 srcChain)",
]);

/** CCIP 2.0.0 pool and ramp events (docs/research/ccip.md, pool topics confirmed on live Sepolia logs). */
export const ccipAbi = parseAbi([
  "event LockedOrBurned(uint64 indexed remoteChainSelector, address token, address sender, uint256 amount)",
  "event ReleasedOrMinted(uint64 indexed remoteChainSelector, address token, address sender, address recipient, uint256 amount)",
  "event CCIPMessageSent(uint64 indexed destChainSelector, address indexed sender, bytes32 indexed messageId, address feeToken, uint256 tokenAmountBeforeTokenPoolFees, bytes encodedMessage, (address issuer, uint32 destGasLimit, uint32 destBytesOverhead, uint256 feeTokenAmount, bytes extraArgs)[] receipts, bytes[] verifierBlobs)",
  "event ExecutionStateChanged(uint64 indexed sourceChainSelector, uint64 indexed messageNumber, bytes32 indexed messageId, uint8 state, bytes returnData)",
]);

/** TokenAdminRegistry 1.5.0 (docs/research/ccip.md). */
export const tokenAdminRegistryAbi = parseAbi([
  "function getPool(address token) view returns (address)",
  "event PoolSet(address indexed token, address indexed previousPool, address indexed newPool)",
]);

/** Role and minter changes that can open a hidden mint path (W4, Spec Copilot list_role_grants). */
export const roleAbi = parseAbi([
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event MintAccessGranted(address indexed minter)",
  "event BurnAccessGranted(address indexed burner)",
  "event MintAccessRevoked(address indexed minter)",
  "event BurnAccessRevoked(address indexed burner)",
]);

/** LayerZero OApp/OFT peer configuration. */
export const oftAbi = parseAbi([
  "event PeerSet(uint32 eid, bytes32 peer)",
  "function peers(uint32 eid) view returns (bytes32)",
]);
