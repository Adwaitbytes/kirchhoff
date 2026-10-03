# KIRCHHOFF frozen interfaces (ABI freeze, PRD section 16 hard gate 1)

Every workstream codes against this file. Changing anything here requires the lead to update this file first.
Source of truth for Solidity is `contracts/src/interfaces/`. Source of truth for TypeScript is `engine/src/types.ts`.

## Enums

`Status` (uint8, also the ConservationFeed answer):
`UNKNOWN=0, CONSERVED=1, DRIFT=2, BROKEN=3, QUARANTINED=4, RECOVERING=5`

`Reason` (uint16):

| Code | Value | Code | Value |
| --- | --- | --- | --- |
| OK | 0 | FLOW_LIMIT | 8 |
| PENDING_ATTESTATION | 1 | STATUS_STALE | 9 |
| DEBIT_NOT_FOUND | 2 | TOKEN_BROKEN | 10 |
| AMOUNT_MISMATCH | 3 | TOKEN_QUARANTINED | 11 |
| RECIPIENT_MISMATCH | 4 | UNKNOWN_TOKEN | 12 |
| DOUBLE_CREDIT | 5 | SPEC_MISMATCH | 13 |
| LOOP_DEFICIT | 6 | TOKEN_RECOVERING | 14 |
| RESERVE_SHORTFALL | 7 | | |

`TOKEN_RECOVERING` is the explicit code for PRD section 9 step 6 ("RECOVERING: FAIL with that reason"); the PRD's table groups it under the status codes.

`ReportType` (uint8): `EPOCH=1, BREACH=2, QUARANTINE_APPLIED=3, RECOVERY_CHECK=4`

## Identifiers

- `tokenId = keccak256(bytes(symbol))`, e.g. `keccak256("kETH")`.
- `incidentId = keccak256(abi.encode(tokenId, evidenceHash))`, computed identically by ConservationLedger, W3 and the API.
- `blocksHash = keccak256(abi.encode(uint64[] chainSelectors, uint64[] blockNumbers))`, selectors sorted ascending.
- Chain selectors (CCIP): Ethereum Sepolia `16015286601757825753`, Arbitrum Sepolia `3478487238524512106`, Base Sepolia `10344971235874465080`. Local Anvil chains reuse these selectors with chain ids 31337 (home), 31338 (arb), 31339 (base).

## CRE report envelope (`ConservationLedger.onReport(metadata, report)`)

```
report = abi.encode(uint8 reportType, uint64 chainSelector, address ledger, bytes32 tokenId, bytes payload)
```
The ledger rejects the report if `chainSelector != block chain's selector` or `ledger != address(this)` (replay protection, PRD section 7 and threat 8).

Payloads:

| Type | Payload ABI |
| --- | --- |
| EPOCH | `(uint64 epochId, int256 delta, bytes32 blocksHash, bytes32 evidenceHash, uint8 status, uint16 reason, bytes32[] settledMessageIds)` status is CONSERVED or DRIFT |
| BREACH | `(uint64 epochId, int256 delta, bytes32 blocksHash, bytes32 evidenceHash, uint16 reason, uint64 offendingChain, bytes32 offendingTx, address recipient, uint256 amount, bytes32 messageId)` |
| QUARANTINE_APPLIED | `(bytes32 incidentId, address[] tainted)` |
| RECOVERY_CHECK | `(uint64 epochId, int256 delta, bytes32 blocksHash)` |

Contract-enforced rules (PRD section 7):
- EPOCH: ignored (no revert, emits nothing) if status is BROKEN, QUARANTINED or RECOVERING; `epochId` must strictly increase, else revert. Marks every `settledMessageIds` entry consumed.
- BREACH: allowed from any status except a token that is not registered. Sets BROKEN, stores evidence, emits `BreachRecorded`, calls `QuarantineController.onBreach(tokenId, incidentId, recipient)` which freezes lanes and taints the recipient. BREACH for an already BROKEN or QUARANTINED token records the extra evidence but does not change status. BREACH `epochId` is informational and not ordering-checked.
- QUARANTINE_APPLIED: only when BROKEN. Sets QUARANTINED, taints every listed address.
- RECOVERY_CHECK: only when RECOVERING, `block.timestamp >= recoveryEndsAt`, and `delta >= 0`. Sets CONSERVED and unfreezes lanes. Taints persist until the issuer Safe clears them.
- Only `QuarantineController.resolve` (issuer Safe only) can move QUARANTINED to RECOVERING, by calling `ConservationLedger.beginRecovery`. A CRE report can never clear BROKEN.

## Staleness

`statusOf().stale = block.timestamp - updatedAt > stalenessSeconds(tokenId)`. ConservationFeed answers `0` (UNKNOWN) when stale and the status is CONSERVED or DRIFT; BROKEN and worse are always reported as is.

## Bridge events (demo, must match the KIRCH-SPEC)

```
WeakBridge / HomeEscrowAdapter:
  event Burned(bytes32 indexed id, address indexed from, address to, uint256 amount, uint64 dstChain);
  event Released(bytes32 indexed id, address indexed to, uint256 amount, uint64 srcChain);
```
On the home chain, `HomeEscrowAdapter` emits `Burned` on lock (debit) and `Released` on release (credit). On remotes, `WeakBridge` emits `Burned` on burn (debit) and `Released` on mint (credit). The message id is topic 1 for both.

CCIP pool events are the ones emitted by the `@chainlink/contracts-ccip` pool version we deploy (see docs/research/ccip.md). KirchhoffTokenPool keeps them unchanged.

## Judge HTTP contract

Exactly the chainlink-ccv policy hook OpenAPI v1 spec (docs/research/ccv.md). Reason string format: `"<REASON_CODE> <symbol> <short note>"`.

## Revision 2 (after verified research, docs/research/*.md)

These override anything above that conflicts.

1. **Judge pending responses.** The chainlink-ccv verifier drops a FAILed message permanently (manual replay only) and retries non-2xx responses with backoff for up to 7 days. Therefore `PENDING_ATTESTATION` (RPC providers disagree or error, source debit not yet visible, 2s budget exceeded) is returned as **HTTP 503** with body `{"error":"PENDING_ATTESTATION <note>"}`, never as `{"decision":"FAIL"}`. Definitive verdicts (`TOKEN_BROKEN`, `TOKEN_QUARANTINED`, `TOKEN_RECOVERING`, `AMOUNT_MISMATCH`, `SPEC_MISMATCH`, `UNKNOWN_TOKEN`, `STATUS_STALE` under fail_closed) return HTTP 200 `{"decision":"FAIL","reason":...}`. HMAC per docs/research/ccv.md (headers `authorization`, `x-authorization-timestamp` ms, `x-authorization-signature-sha256`; string `POST <path> <sha256hex(body)> <apiKey> <tsMs>`; 15s skew). Chain selectors in hook payloads are decimal strings (parse as bigint); addresses are 32-byte left-padded lowercase hex.
2. **CCIP adapter matching.** CCIP 2.0.0 pool events `LockedOrBurned` / `ReleasedOrMinted` carry no message id. Debits are matched through the OnRamp `CCIPMessageSent` log in the same transaction (messageId in topics[3]); credits through the OffRamp `ExecutionStateChanged` log in the same transaction. Lock-release escrow is the pool's `ERC20LockBox` balance.
3. **WeakBridge debit registry (CRE read budget).** CRE limits `filterLogs` to 100 blocks per query and 15 EVM reads per execution. `WeakBridge` and `HomeEscrowAdapter` therefore also expose
   `function debitOf(bytes32 id) external view returns (uint256 amount, address recipient, uint64 dstChain, uint64 blockNumber)` (amount 0 means no debit) and
   `function creditOf(bytes32 id) external view returns (uint256 amount, address recipient, uint64 srcChain, uint64 blockNumber)`.
   W1 confirms the debit with one `callContract` at the source chain's pinned confidence block (exact, equivalent to the log match), and uses `filterLogs` over the latest 100-block window only for evidence. In-flight F still comes from message matching (ids), never snapshot timing.
4. **Confidence.** CRE chain reads accept `latest`, `finalized` or an explicit block; log triggers accept LATEST, SAFE, FINALIZED. A spec confidence of `safe` maps to SAFE for triggers and to an explicit block number from `headerByNumber(safe)` via an RPC-agnostic fallback to `finalized` for reads.
5. **Fallback B.** `KirchhoffTokenPool` subclasses the CCIP 2.0.0 `BurnMintTokenPool` (remotes) and `LockReleaseTokenPool` (home) and enforces in `lockOrBurn` / `releaseOrMint`. The same deployment may set `applyCCVConfigUpdates([address(0), kirchhoffResolver])` so the token requires our CCV next to the Chainlink default.
6. **Workflow count.** CRE allows 3 deployed workflows per org. We simulate all 4 (PRD). For live deploy, W4 Topology Watch merges into W2 as a second handler.
7. **Forwarders.** Production `KeystoneForwarder` and simulation `MockKeystoneForwarder` addresses per chain are in docs/research/cre-contracts.md. The mock forwarder is permissionless, so testnet ledgers configured for simulation must ALSO pin the expected workflow id/owner/name from metadata; simulation uses workflowId 0x11..11 and owner 0xaa..aa. The deployed ledger records which forwarder mode it is in, and the README labels it.
