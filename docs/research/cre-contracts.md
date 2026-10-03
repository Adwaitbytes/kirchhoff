# CRE onchain contracts: IReceiver, ReceiverTemplate, KeystoneForwarder, MockKeystoneForwarder

Research date: 2026-10-04. Every address was checked against a live RPC on that date. Anything not checked against source or chain is marked **UNVERIFIED**.

## TL;DR

- A consumer must implement `IReceiver.onReport(bytes metadata, bytes report)` and ERC-165 `supportsInterface`, returning true for `type(IReceiver).interfaceId` and `type(IERC165).interfaceId`. The official `ReceiverTemplate.sol` is **not** published in `@chainlink/contracts` 1.5.0. Copy it from the docs sample files (MIT). It needs OpenZeppelin **v5** `Ownable`, because it calls `Ownable(msg.sender)`.
- `metadata` as delivered by the forwarder is **64 bytes**: `workflowId (bytes32) | workflowName (bytes10) | workflowOwner (address) | reportId (bytes2)`. Do not `require(metadata.length == 62)`.
- `workflowName` is `bytes10(ascii(hex(sha256(name))[0:10]))`. For example, `"my_workflow"` gives `0x62373666336165316465`. `workflowId` is the value printed by `cre workflow hash`, and its first byte is always `0x00`.
- Production `KeystoneForwarder` addresses. Each was checked: it has code and `typeAndVersion() = "KeystoneForwarder 1.0.0"`.
  - Ethereum Sepolia: `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`
  - Arbitrum Sepolia: `0x76c9cf548b4179F8901cda1f8623568b58215E62`
  - Base Sepolia: `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`
- Simulation `MockKeystoneForwarder` addresses, used by `cre workflow simulate --broadcast`. Each was checked: it has code and `typeAndVersion() = "MockKeystoneForwarder 1.0.0"`.
  - Ethereum Sepolia: `0x15fC6ae953E024d975e77382eEeC56A9101f9F88`
  - Arbitrum Sepolia: `0xd41263567ddfead91504199b8c6c87371e83ca5d`
  - Base Sepolia: `0x82300bd7c3958625581cc2f77bc6464dcecdf3e5`
- The mock forwarder checks **no signatures**, and its `report()` and `route()` are **permissionless**. Anyone can make the mock call your consumer with arbitrary metadata and report bytes. A consumer whose forwarder is set to the mock is effectively open to the public. Use it only on throwaway testnet deployments.
- In simulation broadcasts I observed this on chain: `workflowId = 0x1111…11`, `workflowOwner = 0xaaaa…aa`, `reportId = 0x0001`, and a real-looking `workflowName` hash. That is why the docs say not to set `setExpectedWorkflowId`, `setExpectedAuthor` or `setExpectedWorkflowName` during simulation.
- Neither forwarder reverts when your `onReport` reverts. The outer tx succeeds, and `ReportProcessed(..., result=false)` is emitted. Always check the `result` field of the event, or `WriteReportReply.receiverContractExecutionStatus`.

---

## 1. Sources and versions used

| Source | Location | Version / commit |
|---|---|---|
| CRE docs (docs.chain.link source) | `smartcontractkit/documentation`, local clone `$R/documentation` | HEAD `2c185d063e24e62e13e2827dfd5e5d7257466078` (2026-10-02) |
| Docs Solidity samples | `public/samples/CRE/IReceiver.sol`, `IERC165.sol`, `ReceiverTemplate.sol`, `BasicConsumer.sol` (rendered at https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts) | same |
| Consumer guide page | `src/content/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts.mdx` (lastModified 2026-05-08) | same |
| Forwarder Directory page | `src/content/cre/guides/workflow/using-evm-client/forwarder-directory-ts.mdx` (lastModified 2026-09-18) -> https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory | same |
| npm `@chainlink/contracts` | `$R/npm/chainlink-contracts-1.5.0/package` (license field `BUSL-1.1`; the keystone files themselves are `SPDX MIT`) | 1.5.0 (latest, npm `time.modified` 2026-08-31) |
| KeystoneForwarder (as linked by docs) | `smartcontractkit/chainlink-evm` `contracts/cre/src/v1/KeystoneForwarder.sol` | commit `b6427ea1f4847d640abdf24dbd6c6f01d7799d59`. Its logic is identical to npm 1.5.0 `src/v0.8/keystone/KeystoneForwarder.sol`; I diffed them and only the import paths differ. |
| MockKeystoneForwarder (current source) | `smartcontractkit/chainlink-evm` `contracts/cre/src/dev/MockKeystoneForwarder.sol` | develop `d1ee27b0b5875adb8eca1e0da05926f7eb1f6e1f` (2026-10-02). Last commit on the file: `5ead02cec534c1ebbab696831be183c6099d0137`. typeAndVersion `"MockKeystoneForwarder 1.0.0-dev"` |
| MockKeystoneForwarder (deployed) | Verified source on Blockscout, e.g. https://eth-sepolia.blockscout.com/address/0x15fC6ae953E024d975e77382eEeC56A9101f9F88 (file path `src/v0.8/keystone/MockKeystoneForwarder.sol`) | typeAndVersion `"MockKeystoneForwarder 1.0.0"`. This is **older** than the current dev source; see section 6. |
| chainlink-common (name and ID hashing) | `smartcontractkit/chainlink-common` `pkg/workflows/utils.go` | main `3e181f9aaed854bce5af454d67bdc65815120792` (2026-10-02) |
| cre-cli | `$R/cre-cli` | `29b8ebb7b14c12486396fde646143cc62d97960c` (2026-09-29) |
| cre-templates | `$R/cre-templates` | `d0223f31182c76bc36b1cc9d47b13b18efcf2bf6` (2026-09-03) |

---

## 2. `IReceiver` (verbatim)

### 2a. Docs sample: `documentation/public/samples/CRE/IReceiver.sol` (MIT, `pragma solidity ^0.8.0`)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC165} from "./IERC165.sol";

/// @title IReceiver - receives keystone reports
/// @notice Implementations must support the IReceiver interface through ERC165.
interface IReceiver is IERC165 {
  /// @notice Handles incoming keystone reports.
  /// @dev If this function call reverts, it can be retried with a higher gas
  /// limit. The receiver is responsible for discarding stale reports.
  /// @param metadata Report's metadata.
  /// @param report Workflow report.
  function onReport(
    bytes calldata metadata,
    bytes calldata report
  ) external;
}
```

### 2b. npm `@chainlink/contracts@1.5.0`: `src/v0.8/keystone/interfaces/IReceiver.sol` (MIT, `^0.8.0`)

This is the same interface, but it imports from a **version-pinned OpenZeppelin path**:

```solidity
import {IERC165} from "@openzeppelin/contracts@5.0.2/utils/introspection/IERC165.sol";
...
  function onReport(bytes calldata metadata, bytes calldata report) external;
```

If you import it from the npm package, you need this remapping: `@openzeppelin/contracts@5.0.2/=<path to OZ 5.0.2>/contracts/`. The package's own `remappings.txt` maps it to `node_modules/@openzeppelin/contracts-5.0.2`.

### 2c. `IERC165`: docs sample `public/samples/CRE/IERC165.sol` (MIT, `pragma solidity >=0.4.16`, a copy of OZ v5.4.0)

```solidity
// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v5.4.0) (utils/introspection/IERC165.sol)

pragma solidity >=0.4.16;

/**
 * @dev Interface of the ERC-165 standard, as defined in the
 * https://eips.ethereum.org/EIPS/eip-165[ERC].
 *
 * Implementers can declare support of contract interfaces, which can then be
 * queried by others ({ERC165Checker}).
 *
 * For an implementation, see {ERC165}.
 */
interface IERC165 {
  /**
   * @dev Returns true if this contract implements the interface defined by
   * `interfaceId`. See the corresponding
   * https://eips.ethereum.org/EIPS/eip-165#how-interfaces-are-identified[ERC section]
   * to learn more about how these ids are created.
   *
   * This function call must use less than 30 000 gas.
   */
  function supportsInterface(
    bytes4 interfaceId
  ) external view returns (bool);
}
```

**Why ERC-165 matters:** the production `KeystoneForwarder.route()` runs `ERC165Checker.supportsInterface(receiver, type(IReceiver).interfaceId)` before calling the receiver. If that check fails, the transmission is permanently marked `invalidReceiver = true`, `onReport` is never called, and `route` returns false. A retry then reverts with `AlreadyAttempted`. Keep `supportsInterface` cheap (under 30k gas).

`type(IReceiver).interfaceId` equals the selector of `onReport(bytes,bytes)`, because it is the only function declared in `IReceiver` itself. I did not compute the 4-byte value without keccak tooling: **UNVERIFIED**. Compute it in a test with `type(IReceiver).interfaceId`, and do not hardcode it.

---

## 3. `ReceiverTemplate` (verbatim, docs version)

Source: `documentation/public/samples/CRE/ReceiverTemplate.sol` at commit `2c185d0`. It is rendered on the Building Consumer Contracts page, section 3.2. License MIT, `pragma solidity ^0.8.0`.

The same file appears byte-identical (whitespace-insensitive) in these cre-templates copies: `starter-templates/tokenized-asset-servicing/contracts/interfaces/`, `prediction-market/*/contracts/evm/src/`, `vault-harvester`, `event-reactor`, `circuit-breaker`. Other templates (`keeper-bot`, `sports-resolution`, `automation-migration`, `ai-audit-firewall`, and `x402-cre-price-alerts`) carry older or variant copies, mostly differing in comments. **Use the docs copy.**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC165} from "./IERC165.sol";
import {IReceiver} from "./IReceiver.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ReceiverTemplate - Abstract receiver with optional permission controls
/// @notice Provides flexible, updatable security checks for receiving workflow reports
/// @dev The forwarder address is required at construction time for security.
///      Additional permission fields can be configured using setter functions.
abstract contract ReceiverTemplate is IReceiver, Ownable {
  // Required permission field at deployment, configurable after
  address private s_forwarderAddress; // If set, only this address can call onReport

  // Optional permission fields (all default to zero = disabled)
  address private s_expectedAuthor; // If set, only reports from this workflow owner are accepted
  bytes10 private s_expectedWorkflowName; // Only validated when s_expectedAuthor is also set
  bytes32 private s_expectedWorkflowId; // If set, only reports from this specific workflow ID are accepted

  // Hex character lookup table for bytes-to-hex conversion
  bytes private constant HEX_CHARS = "0123456789abcdef";

  // Custom errors
  error InvalidForwarderAddress();
  error InvalidSender(address sender, address expected);
  error InvalidAuthor(address received, address expected);
  error InvalidWorkflowName(bytes10 received, bytes10 expected);
  error InvalidWorkflowId(bytes32 received, bytes32 expected);
  error WorkflowNameRequiresAuthorValidation();

  // Events
  event ForwarderAddressUpdated(address indexed previousForwarder, address indexed newForwarder);
  event ExpectedAuthorUpdated(address indexed previousAuthor, address indexed newAuthor);
  event ExpectedWorkflowNameUpdated(bytes10 indexed previousName, bytes10 indexed newName);
  event ExpectedWorkflowIdUpdated(bytes32 indexed previousId, bytes32 indexed newId);
  event SecurityWarning(string message);

  /// @notice Constructor sets msg.sender as the owner and configures the forwarder address
  /// @param _forwarderAddress The address of the Chainlink Forwarder contract (cannot be address(0))
  /// @dev The forwarder address is required for security - it ensures only verified reports are processed
  constructor(
    address _forwarderAddress
  ) Ownable(msg.sender) {
    if (_forwarderAddress == address(0)) {
      revert InvalidForwarderAddress();
    }
    s_forwarderAddress = _forwarderAddress;
    emit ForwarderAddressUpdated(address(0), _forwarderAddress);
  }

  /// @notice Returns the configured forwarder address
  /// @return The forwarder address (address(0) if disabled)
  function getForwarderAddress() external view returns (address) {
    return s_forwarderAddress;
  }

  /// @notice Returns the expected workflow author address
  /// @return The expected author address (address(0) if not set)
  function getExpectedAuthor() external view returns (address) {
    return s_expectedAuthor;
  }

  /// @notice Returns the expected workflow name
  /// @return The expected workflow name (bytes10(0) if not set)
  function getExpectedWorkflowName() external view returns (bytes10) {
    return s_expectedWorkflowName;
  }

  /// @notice Returns the expected workflow ID
  /// @return The expected workflow ID (bytes32(0) if not set)
  function getExpectedWorkflowId() external view returns (bytes32) {
    return s_expectedWorkflowId;
  }

  /// @inheritdoc IReceiver
  /// @dev Performs optional validation checks based on which permission fields are set
  function onReport(
    bytes calldata metadata,
    bytes calldata report
  ) external override {
    // Security Check 1: Verify caller is the trusted Chainlink Forwarder (if configured)
    if (s_forwarderAddress != address(0) && msg.sender != s_forwarderAddress) {
      revert InvalidSender(msg.sender, s_forwarderAddress);
    }

    // Security Checks 2-4: Verify workflow identity - ID, owner, and/or name (if any are configured)
    if (s_expectedWorkflowId != bytes32(0) || s_expectedAuthor != address(0) || s_expectedWorkflowName != bytes10(0)) {
      (bytes32 workflowId, bytes10 workflowName, address workflowOwner) = _decodeMetadata(metadata);

      if (s_expectedWorkflowId != bytes32(0) && workflowId != s_expectedWorkflowId) {
        revert InvalidWorkflowId(workflowId, s_expectedWorkflowId);
      }
      if (s_expectedAuthor != address(0) && workflowOwner != s_expectedAuthor) {
        revert InvalidAuthor(workflowOwner, s_expectedAuthor);
      }

      // ================================================================
      // WORKFLOW NAME VALIDATION - REQUIRES AUTHOR VALIDATION
      // ================================================================
      // Do not rely on workflow name validation alone. Workflow names are unique
      // per owner, but not across owners.
      // Furthermore, workflow names use 40-bit truncation (bytes10), making collisions possible.
      // Therefore, workflow name validation REQUIRES author (workflow owner) validation.
      // The code enforces this dependency at runtime.
      // ================================================================
      if (s_expectedWorkflowName != bytes10(0)) {
        // Author must be configured if workflow name is used
        if (s_expectedAuthor == address(0)) {
          revert WorkflowNameRequiresAuthorValidation();
        }
        // Validate workflow name matches (author already validated above)
        if (workflowName != s_expectedWorkflowName) {
          revert InvalidWorkflowName(workflowName, s_expectedWorkflowName);
        }
      }
    }

    _processReport(report);
  }

  /// @notice Updates the forwarder address that is allowed to call onReport
  /// @param _forwarder The new forwarder address
  /// @dev WARNING: Setting to address(0) disables forwarder validation.
  ///      This makes your contract INSECURE - anyone can call onReport() with arbitrary data.
  ///      Only use address(0) if you fully understand the security implications.
  function setForwarderAddress(
    address _forwarder
  ) external onlyOwner {
    address previousForwarder = s_forwarderAddress;

    // Emit warning if disabling forwarder check
    if (_forwarder == address(0)) {
      emit SecurityWarning("Forwarder address set to zero - contract is now INSECURE");
    }

    s_forwarderAddress = _forwarder;
    emit ForwarderAddressUpdated(previousForwarder, _forwarder);
  }

  /// @notice Updates the expected workflow owner address
  /// @param _author The new expected author address (use address(0) to disable this check)
  function setExpectedAuthor(
    address _author
  ) external onlyOwner {
    address previousAuthor = s_expectedAuthor;
    s_expectedAuthor = _author;
    emit ExpectedAuthorUpdated(previousAuthor, _author);
  }

  /// @notice Updates the expected workflow name from a plaintext string
  /// @param _name The workflow name as a string (use empty string "" to disable this check)
  /// @dev IMPORTANT: Workflow name validation REQUIRES author validation to be enabled.
  ///      The workflow name uses only 40-bit truncation, making collision attacks feasible
  ///      when used alone. However, since workflow names are unique per owner, validating
  ///      both the name AND the author address provides adequate security.
  ///      You must call setExpectedAuthor() before or after calling this function.
  ///      The name is hashed using SHA256 and truncated to bytes10.
  function setExpectedWorkflowName(
    string calldata _name
  ) external onlyOwner {
    bytes10 previousName = s_expectedWorkflowName;

    if (bytes(_name).length == 0) {
      s_expectedWorkflowName = bytes10(0);
      emit ExpectedWorkflowNameUpdated(previousName, bytes10(0));
      return;
    }

    // Convert workflow name to bytes10:
    // SHA256 hash → hex encode → take first 10 chars → hex encode those chars
    bytes32 hash = sha256(bytes(_name));
    bytes memory hexString = _bytesToHexString(abi.encodePacked(hash));
    bytes memory first10 = new bytes(10);
    for (uint256 i = 0; i < 10; i++) {
      first10[i] = hexString[i];
    }
    s_expectedWorkflowName = bytes10(first10);
    emit ExpectedWorkflowNameUpdated(previousName, s_expectedWorkflowName);
  }

  /// @notice Updates the expected workflow ID
  /// @param _id The new expected workflow ID (use bytes32(0) to disable this check)
  function setExpectedWorkflowId(
    bytes32 _id
  ) external onlyOwner {
    bytes32 previousId = s_expectedWorkflowId;
    s_expectedWorkflowId = _id;
    emit ExpectedWorkflowIdUpdated(previousId, _id);
  }

  /// @notice Helper function to convert bytes to hex string
  /// @param data The bytes to convert
  /// @return The hex string representation
  function _bytesToHexString(
    bytes memory data
  ) private pure returns (bytes memory) {
    bytes memory hexString = new bytes(data.length * 2);

    for (uint256 i = 0; i < data.length; i++) {
      hexString[i * 2] = HEX_CHARS[uint8(data[i] >> 4)];
      hexString[i * 2 + 1] = HEX_CHARS[uint8(data[i] & 0x0f)];
    }

    return hexString;
  }

  /// @notice Extracts all metadata fields from the onReport metadata parameter
  /// @param metadata The metadata bytes encoded using abi.encodePacked(workflowId, workflowName, workflowOwner)
  /// @return workflowId The unique identifier of the workflow (bytes32)
  /// @return workflowName The name of the workflow (bytes10)
  /// @return workflowOwner The owner address of the workflow
  function _decodeMetadata(
    bytes memory metadata
  ) internal pure returns (bytes32 workflowId, bytes10 workflowName, address workflowOwner) {
    // Metadata structure (encoded using abi.encodePacked by the Forwarder):
    // - First 32 bytes: length of the byte array (standard for dynamic bytes)
    // - Offset 32, size 32: workflow_id (bytes32)
    // - Offset 64, size 10: workflow_name (bytes10)
    // - Offset 74, size 20: workflow_owner (address)
    assembly {
      workflowId := mload(add(metadata, 32))
      workflowName := mload(add(metadata, 64))
      workflowOwner := shr(mul(12, 8), mload(add(metadata, 74)))
    }
    return (workflowId, workflowName, workflowOwner);
  }

  /// @notice Abstract function to process the report data
  /// @param report The report calldata containing your workflow's encoded data
  /// @dev Implement this function with your contract's business logic
  function _processReport(
    bytes calldata report
  ) internal virtual;

  /// @inheritdoc IERC165
  function supportsInterface(
    bytes4 interfaceId
  ) public view virtual override returns (bool) {
    return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
  }
}
```

### Minimal consumer: `public/samples/CRE/BasicConsumer.sol` (MIT, `^0.8.26`)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {ReceiverTemplate} from "./ReceiverTemplate.sol";

contract MyConsumer is ReceiverTemplate {
  uint256 public s_storedValue;
  event ValueUpdated(uint256 newValue);

  // Constructor requires forwarder address
  constructor(
    address _forwarderAddress
  ) ReceiverTemplate(_forwarderAddress) {}

  // Implement your business logic here
  function _processReport(
    bytes calldata report
  ) internal override {
    uint256 newValue = abi.decode(report, (uint256));
    s_storedValue = newValue;
    emit ValueUpdated(newValue);
  }
}
```

### Variant in chainlink-evm (FYI, not packaged)

`smartcontractkit/chainlink-evm` develop (`d1ee27b`) has `contracts/src/v0.8/automation-cre/ReceiverTemplate.sol`. It uses `pragma ^0.8.24`, imports `@openzeppelin/contracts@5.1.0/...`, and its state vars are `internal` instead of `private`. It is **not** in npm `@chainlink/contracts@1.5.0`. I confirmed this with a grep of the package: there is no `ReceiverTemplate` anywhere.

### Installing with Foundry

There is no published package that ships `ReceiverTemplate`, so **copy the files**. This is also what cre-templates does: for example `starter-templates/automation-migration/contracts/evm/foundry.toml` vendors the files and remaps `@openzeppelin/contracts@5.0.2/=src/vendor/openzeppelin/`.

1. Copy `IReceiver.sol`, `IERC165.sol` and `ReceiverTemplate.sol` from https://github.com/smartcontractkit/documentation/tree/2c185d063e24e62e13e2827dfd5e5d7257466078/public/samples/CRE into e.g. `src/cre/`. They use relative imports (`./IERC165.sol`, `./IReceiver.sol`).
2. Install OpenZeppelin **v5** (needed for `Ownable(address initialOwner)`): `forge install OpenZeppelin/openzeppelin-contracts@v5.4.0`. The docs' IERC165 copy says v5.4.0; any v5.x has the same `Ownable` constructor. Then add the remapping `@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/`.
3. Alternative, interfaces only: `forge install smartcontractkit/chainlink-evm` (large repo), or install npm `@chainlink/contracts@1.5.0`. Then import `@chainlink/contracts/src/v0.8/keystone/interfaces/IReceiver.sol` and add the remapping `@openzeppelin/contracts@5.0.2/=lib/openzeppelin-contracts/contracts/`. I have not built this path with forge here (forge is not installed): **UNVERIFIED** that it compiles cleanly with that single remapping.

---

## 4. `onReport` metadata encoding (exact)

### 4a. Signed `rawReport` layout (from `KeystoneForwarder._getMetadata`)

Offsets in the comment below are memory offsets, which include the 32-byte length prefix. Calldata offset = memory offset - 32.

```
// version                offset  32, size  1
// workflow_execution_id  offset  33, size 32
// timestamp              offset  65, size  4
// don_id                 offset  69, size  4
// don_config_version,    offset  73, size  4
// workflow_cid           offset  77, size 32
// workflow_name          offset 109, size 10
// workflow_owner         offset 119, size 20
// report_id              offset 139, size  2
```

Constants: `METADATA_LENGTH = 109` and `FORWARDER_METADATA_LENGTH = 45`. The forwarder calls:

```solidity
this.route(
  getTransmissionId(receiver, workflowExecutionId, reportId),
  msg.sender,
  receiver,
  rawReport[FORWARDER_METADATA_LENGTH:METADATA_LENGTH],   // -> onReport `metadata` (64 bytes)
  rawReport[METADATA_LENGTH:]                             // -> onReport `report` (your ABI-encoded payload)
);
```

### 4b. `metadata` as seen by `onReport` (64 bytes)

| byte range in `metadata` | field | type |
|---|---|---|
| `[0:32]` | workflowId (`workflow_cid`) | `bytes32` |
| `[32:42]` | workflowName (hash-truncated) | `bytes10` |
| `[42:62]` | workflowOwner | `address` |
| `[62:64]` | reportId | `bytes2` |

The docs say: "In production delivery, `metadata.length` is 64. A `require(metadata.length == 62)` (or similar) in your own code will revert". They give this extraction: `bytes2 reportId = bytes2(metadata[62:64]);`.

The `ReceiverTemplate._decodeMetadata(bytes memory)` assembly reads memory, so add 32 to each calldata offset: `mload(add(metadata,32))` gives the id, `mload(add(metadata,64))` gives the name (as a bytes10 it takes the high 10 bytes), and `shr(96, mload(add(metadata,74)))` gives the owner. The trailing reportId is ignored.

**Docs bug to avoid:** section 5.2 of the consumer guide shows `bytes calldata metadata = msg.data[4:]; _decodeMetadata(metadata)` inside `_processReport`. `msg.data[4:]` is the ABI-encoded argument tuple (head offsets first), not the raw metadata bytes, so this decodes garbage. If you need metadata in business logic, override `onReport` and pass the `metadata` parameter yourself.

### 4c. Computing expected values offchain

- **workflowName (bytes10).** Source: `chainlink-common/pkg/workflows/utils.go` `HashTruncateName` @ `3e181f9`:

  ```go
  func HashTruncateName(name string) string {
  	// Compute SHA-256 hash of the input string
  	hash := sha256.Sum256([]byte(name))

  	// Encode as hex to ensure UTF8
  	var hashBytes = hash[:]
  	resultHex := hex.EncodeToString(hashBytes)

  	// Truncate to 10 bytes
  	truncated := []byte(resultHex)[:10]
  	return string(truncated)
  }
  ```

  The onchain bytes10 value is the 10 ASCII characters, e.g. `"b76f3ae1de"` becomes `0x62373666336165316465`. I checked this with Python, and it matches the docs example for `"my_workflow"`:

  ```python
  h = hashlib.sha256(name.encode()).hexdigest()[:10]; bytes10 = "0x" + h.encode().hex()
  ```

  TS (viem): `toHex(new TextEncoder().encode(sha256Hex(name).slice(0,10)))`. The name is the `workflow-name` in `workflow.yaml`; see the UNVERIFIED items for exactly which string is hashed.
- **workflowId (bytes32).** Run `cre workflow hash <folder> --target <t> [--public_key 0xOwner]`. The docs (`reference/cli/workflow.mdx`) say "The workflow hash is the same value that appears as the Workflow ID onchain." Internally this is `GenerateWorkflowID(owner, name, wasmBinary, config, secretsURL)` = `sha256(owner || name || binary || config || secretsURL)` with **byte 0 overwritten by `versionByte = 0x00`**. The ID changes whenever the binary or the config changes, so re-run `setExpectedWorkflowId` after each `cre workflow deploy` update.
- **workflowOwner.** For the onchain registry this is your `workflow-owner-address` or the EOA of `CRE_ETH_PRIVATE_KEY`. With the off-chain registry or a linked org, the owner may be a derived address (`GenerateWorkflowOwnerAddress(prefix, ownerKey)` in chainlink-common, which is a CREATE2-style keccak). Read it from the first real production `ReportProcessed` tx (decode the `report()` calldata) before calling `setExpectedAuthor`.
- **reportId.** Observed as `0x0001` in simulation.

---

## 5. Forwarder addresses: docs and on-chain checks

From the Forwarder Directory (`forwarder-directory-ts.mdx`, lastModified 2026-09-18). The docs also say: "Chain availability and forwarder addresses depend on your CRE tenant. Run `cre workflow supported-chains` after `cre login`" (`--output json` for scripting).

| Chain | Chain ID | CRE chain name | Production `KeystoneForwarder` | Simulation `MockKeystoneForwarder` |
|---|---|---|---|---|
| Ethereum Sepolia | 11155111 | `ethereum-testnet-sepolia` | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` | `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` |
| Arbitrum Sepolia | 421614 | `ethereum-testnet-sepolia-arbitrum-1` | `0x76c9cf548b4179F8901cda1f8623568b58215E62` | `0xd41263567ddfead91504199b8c6c87371e83ca5d` |
| Base Sepolia | 84532 | `ethereum-testnet-sepolia-base-1` | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` | `0x82300bd7c3958625581cc2f77bc6464dcecdf3e5` |

RPC checks on 2026-10-04. I used publicnode RPCs and confirmed the `eth_chainId` values match. Calls were `eth_getCode` and `eth_call` to `typeAndVersion()` (`0x181f5a77`):

| Chain | Address | code size | `typeAndVersion()` |
|---|---|---|---|
| Sepolia | 0xF8344C…4482 (prod) | 8591 B | `KeystoneForwarder 1.0.0` |
| Sepolia | 0x15fC6a…9F88 (mock) | 4579 B | `MockKeystoneForwarder 1.0.0` |
| Arb Sepolia | 0x76c9cf…5E62 (prod) | 8591 B | `KeystoneForwarder 1.0.0` |
| Arb Sepolia | 0xd41263…ca5d (mock) | 4529 B | `MockKeystoneForwarder 1.0.0` |
| Base Sepolia | 0xF8344C…4482 (prod) | 8591 B | `KeystoneForwarder 1.0.0` |
| Base Sepolia | 0x82300b…f3e5 (mock) | 4529 B | `MockKeystoneForwarder 1.0.0` |

Blockscout `/api/v2/smart-contracts/<addr>` reports all three mocks and the Sepolia production forwarder as verified. Mock compilers: Sepolia v0.8.22, Arb and Base v0.8.26. Production forwarder compiler: v0.8.24.

Explorer links:
- https://sepolia.etherscan.io/address/0xF8344CFd5c43616a4366C34E3EEE75af79a74482
- https://sepolia.arbiscan.io/address/0x76c9cf548b4179F8901cda1f8623568b58215E62
- https://sepolia.basescan.org/address/0xF8344CFd5c43616a4366C34E3EEE75af79a74482

---

## 6. KeystoneForwarder and MockKeystoneForwarder interfaces

### 6a. Production `KeystoneForwarder` (npm 1.5.0 `src/v0.8/keystone/KeystoneForwarder.sol`, MIT, `^0.8.19`)

`contract KeystoneForwarder is OwnerIsCreator, ITypeAndVersion, IRouter`

```solidity
string public constant override typeAndVersion = "KeystoneForwarder 1.0.0";

event ReportProcessed(
  address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result
);
event ConfigSet(uint32 indexed donId, uint32 indexed configVersion, uint8 f, address[] signers);

function report(
  address receiver,
  bytes calldata rawReport,
  bytes calldata reportContext,
  bytes[] calldata signatures
) external;

function setConfig(uint32 donId, uint32 configVersion, uint8 f, address[] calldata signers) external onlyOwner;
function clearConfig(uint32 donId, uint32 configVersion) external onlyOwner;

// errors
error InvalidReport();                       // rawReport.length < 109
error InvalidConfig(uint64 configId);
error InvalidSignatureCount(uint256 expected, uint256 received);  // must be f+1
error InvalidSignature(bytes signature);
error InvalidSigner(address signer);
error DuplicateSigner(address signer);
```

How it works:
- **Signatures.** `completeHash = keccak256(abi.encodePacked(keccak256(rawReport), reportContext))`, and `ecrecover(completeHash, uint8(sig[64]) + 27, r, s)`. It needs exactly `f + 1` distinct configured signers.
- **Event topic.** The `ReportProcessed` topic0 I observed on chain is `0x3617b009e9785c42daebadb6d3fb553243a4bf586d07ea72d65d80013ce116b5`. It is identical on the mock.
- **Gas.**
  - `MINIMUM_GAS_LIMIT = 25_000 + 5_000 + 30_000*3 + 10_000 = 130_000`. `route` reverts with `InsufficientGasForRouting` if `gasleft() - 30_000 < 130_000`.
  - The receiver is called with `gasleft() - 5_000`.
  - The ERC-165 check can use up to 90k gas.
  - So the `gasLimit` you pass in `writeReport` must cover: forwarder overhead (signature recovery for f+1 sigs, plus storage), about 130k minimum, and your `onReport`.

### 6b. `IRouter` (npm 1.5.0 `src/v0.8/keystone/interfaces/IRouter.sol`, MIT, `^0.8.4`), verbatim

```solidity
interface IRouter {
  error UnauthorizedForwarder();
  /// @dev Thrown when the gas limit is insufficient for handling state after
  /// calling the receiver function.
  error InsufficientGasForRouting(bytes32 transmissionId);
  error AlreadyAttempted(bytes32 transmissionId);

  event ForwarderAdded(address indexed forwarder);
  event ForwarderRemoved(address indexed forwarder);

  enum TransmissionState {
    NOT_ATTEMPTED,
    SUCCEEDED,
    INVALID_RECEIVER,
    FAILED
  }

  struct TransmissionInfo {
    bytes32 transmissionId;
    TransmissionState state;
    address transmitter;
    // This is true if the receiver is not a contract or does not implement the
    // `IReceiver` interface.
    bool invalidReceiver;
    // Whether the transmission attempt was successful. If `false`, the
    // transmission can be retried with an increased gas limit.
    bool success;
    // The amount of gas allocated for the `IReceiver.onReport` call. uint80
    // allows storing gas for known EVM block gas limits.
    // Ensures that the minimum gas requested by the user is available during
    // the transmission attempt. If the transmission fails (indicated by a
    // `false` success state), it can be retried with an increased gas limit.
    uint80 gasLimit;
  }

  function addForwarder(address forwarder) external;
  function removeForwarder(address forwarder) external;
  function route(bytes32 transmissionId, address transmitter, address receiver, bytes calldata metadata, bytes calldata report) external returns (bool);
  function getTransmissionId(address receiver, bytes32 workflowExecutionId, bytes2 reportId) external pure returns (bytes32);
  function getTransmissionInfo(address receiver, bytes32 workflowExecutionId, bytes2 reportId) external view returns (TransmissionInfo memory);
  function getTransmitter(address receiver, bytes32 workflowExecutionId, bytes2 reportId) external view returns (address);
}
```

`getTransmissionId = keccak256(bytes.concat(bytes20(uint160(receiver)), workflowExecutionId, reportId))`.

On the production forwarder, a transmission that **succeeded** or hit **INVALID_RECEIVER** cannot be retried (`AlreadyAttempted`). A FAILED one (your `onReport` reverted) **can be retried by anyone**. That is the "same-chain replay on failure" risk the docs describe; mitigate it with a monotonic timestamp or nonce inside your report.

### 6c. Deployed `MockKeystoneForwarder 1.0.0`: key parts, verbatim from the verified Sepolia source

This is the version actually live at the addresses above.

```solidity
/// @notice Simplified mock version of KeystoneForwarder for testing purposes.
/// The report function is permissionless and skips all validations.
contract MockKeystoneForwarder is OwnerIsCreator, ITypeAndVersion, IRouter {
  ...
  string public constant override typeAndVersion = "MockKeystoneForwarder 1.0.0";
  ...
  function route(
    bytes32 transmissionId,
    address transmitter,
    address receiver,
    bytes calldata metadata,
    bytes calldata validatedReport
  ) public returns (bool) {
    s_transmissions[transmissionId].transmitter = transmitter;
    s_transmissions[transmissionId].gasLimit = uint80(gasleft());

    // Always call onReport on the receiver
    bool success;
    bytes memory payload = abi.encodeCall(IReceiver.onReport, (metadata, validatedReport));

    assembly {
      // call and return whether we succeeded. ignore return data
      // call(gas,addr,value,argsOffset,argsLength,retOffset,retLength)
      success := call(gas(), receiver, 0, add(payload, 0x20), mload(payload), 0x0, 0x0)
    }

    s_transmissions[transmissionId].success = success;
    return success;
  }
  ...
  /// @notice Simplified permissionless report function that skips all validations
  /// and does not call onReport on consumer contracts
  function report(
    address receiver,
    bytes calldata rawReport,
    bytes calldata reportContext,
    bytes[] calldata signatures
  ) external {
    if (rawReport.length < METADATA_LENGTH) {
      revert InvalidReport();
    }
    ...
    // Skip all validations and signature checks
    // Skip onReport call to consumer contracts
    bool success = this.route(
      getTransmissionId(receiver, workflowExecutionId, reportId),
      msg.sender,
      receiver,
      rawReport[FORWARDER_METADATA_LENGTH:METADATA_LENGTH],
      rawReport[METADATA_LENGTH:]
    );

    emit ReportProcessed(receiver, workflowExecutionId, reportId, success);
  }
```

What this code does, compared with its comments and the docs:
- **Signatures and config are never checked.** `reportContext` and `signatures` are ignored. **`route()` has no `s_forwarders[msg.sender]` check**, so anyone can call `route` directly with arbitrary metadata.
- **No ERC-165 check** in the deployed 1.0.0. The current dev source (`chainlink-evm` `contracts/cre/src/dev/MockKeystoneForwarder.sol`, `1.0.0-dev`) adds `ERC165Checker.supportsInterface`.
- **No AlreadyAttempted check.** Replays always re-call the receiver.
- **`onReport` IS called, despite the code comment "Skip onReport call".** I confirmed this on chain: Sepolia tx `0x1e55b220a1164f6c690a0d6c01abbcbef8966ca50d5a358d9b5be554ab918819` and Base Sepolia tx `0x635b63f2c41eef17ba429ad1af9c99a8900f01068946d51fc45e4fb1b4a53643` both contain logs emitted by the receiver contract in the same tx, with `ReportProcessed.result = true`.
  - The docs Onchain Write overview (`overview-ts.mdx`, "Simulation vs production" note) says the MockForwarder "records the report but does **not** call your consumer contract's `onReport()`. As a result, `receiverContractExecutionStatus` is always `SUCCESS` in simulation". That conflicts with the deployed code and the on-chain evidence.
  - The safe reading: `onReport` runs, but the simulator may report SUCCESS even when it reverted. Check `ReportProcessed.result` on the explorer.

### 6d. What simulation broadcasts actually send

I decoded the `report(address,bytes,bytes,bytes[])` calldata (selector `0x11289565`) from the 3 most recent mock txs on Sepolia and on Base Sepolia:

| field | observed value |
|---|---|
| version | `1` |
| timestamp | `100` |
| don_id / config_version | `1` / `1` |
| workflow_cid (workflowId) | `0x1111111111111111111111111111111111111111111111111111111111111111` |
| workflow_name | a real-looking 10-char hex ASCII, e.g. `0x37656538323130356137` ("7ee82105a7") |
| workflow_owner | `0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` |
| report_id | `0x0001` |

The cre-cli source matches the placeholder ID: `cmd/workflow/simulate/simulate.go` uses the trigger ID `trigger_reg_1111…1111_%d`.

**Consequences for consumers in simulation:**
- Deploy with the **mock address** as the constructor forwarder. If you later move to production, call `setForwarderAddress(prodForwarder)` or deploy a fresh instance.
- **Do not** set `expectedWorkflowId` or `expectedAuthor`: they would revert with `InvalidWorkflowId` or `InvalidAuthor`. The docs say: "Setting any of these will cause your simulation to fail."
- If you want identity checks that work in both modes, read the values from metadata and allow-list `0x11…11` / `0xaa…aa` only on a test deployment. Never do this on a production contract, because anyone can forge those values through the mock.

### 6e. Gas config for writes (TS SDK)

Docs: `reference/sdk/evm-client-ts.mdx` and `guides/workflow/using-evm-client/onchain-write/writing-data-onchain.mdx`.

```ts
const writeResult = evmClient
  .writeReport(runtime, {
    receiver: config.consumerAddress,
    report: reportResponse,          // from runtime.report({ encodedPayload: hexToBase64(data), encoderName: "evm", signingAlgo: "ecdsa", hashingAlgo: "keccak256" }).result()
    gasConfig: {
      gasLimit: config.gasLimit,     // string, e.g. "500000"
    },
  })
  .result()
```

- `GasConfig.gasLimit` is a **`string`** and is required inside `gasConfig`; `gasConfig` itself is optional.
- `WriteReportReply` has these fields:
  - `txStatus` (`TX_STATUS_SUCCESS` | `TX_STATUS_REVERTED` | `TX_STATUS_FATAL`)
  - `receiverContractExecutionStatus` (`..._SUCCESS` | `..._REVERTED`, optional)
  - `txHash` (`Uint8Array`, optional)
  - `transactionFee` (`bigint` wei, optional)
  - `errorMessage` (optional)
- Docs examples use `"500000"` to `"1000000"`.
- Simulation limit (`cre-cli/cmd/workflow/simulate/limits.json`): `ChainWrite.EVM.GasLimit.Default = 10000000`, `TransactionGasLimit = 10000000`, `ReportSizeLimit = 50000` bytes, `TargetsLimit = 10`. A higher gasLimit fails with "EVM gas of N gas units exceeds the simulation limit … mirrors a production constraint". You can change this with `cre workflow limits export` or `--limits=none`.
- `--broadcast` needs `CRE_ETH_PRIVATE_KEY` in `.env`, funded with native testnet gas. Without `--broadcast`, the tx hash prints as `0x000…000`.

---

## 7. Local Anvil testing with a mock forwarder

Options, best first:

1. **Deploy the real mock source on Anvil.** Get `MockKeystoneForwarder.sol` from `smartcontractkit/chainlink-evm` `contracts/cre/src/dev/MockKeystoneForwarder.sol` at `d1ee27b0b5875adb8eca1e0da05926f7eb1f6e1f`. Its imports are `../v1/interfaces/IReceiver.sol`, `../v1/interfaces/IRouter.sol`, `@chainlink/contracts/src/v0.8/shared/{interfaces/ITypeAndVersion,access/OwnerIsCreator}.sol` and `@openzeppelin/contracts@4.8.3/utils/introspection/ERC165Checker.sol`, so it needs those remappings. Alternatively use the ABI and bytecode artifact that cre-cli ships at `cre-cli/test/MockKeystoneForwarder.json`. That one is compiled with solc 0.8.24 from `src/v0.8/workflow/dev/MockKeystoneForwarder.sol` and has typeAndVersion `1.0.0-dev`; cre-cli deploys it in its own tests via `test/contracts/contracts.go: DeployMockKeystoneForwarder`.
2. **Simplest:** in a Foundry test, `vm.prank(forwarderAddr)` and call `consumer.onReport(metadata, report)` directly. Build metadata as `abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address owner, bytes2 reportId)`, which is 64 bytes, to match production.
3. **End-to-end through the real or mock `report()` path:** build `rawReport` as

   ```solidity
   abi.encodePacked(uint8(1), bytes32 execId, uint32 ts, uint32 donId, uint32 cfgVer, bytes32 workflowId, bytes10 name, address owner, bytes2 reportId, bytes payload)
   ```

   That is 109 header bytes followed by the payload. Call `mock.report(consumer, rawReport, "", new bytes[](0))`. For the production `KeystoneForwarder` on Anvil, call `setConfig(donId, cfgVer, f=1, signers[≥4])` and sign `keccak256(abi.encodePacked(keccak256(rawReport), reportContext))` with f+1 = 2 keys using `vm.sign`. Pack each signature as `abi.encodePacked(r, s, uint8(v - 27))`, because the contract adds 27. That `v-27` packing is inferred from `uint8(signature[64]) + 27` in the source.
4. The npm package also has test mocks under `src/v0.8/keystone/test/mocks/` (`Receiver.sol`, `MaliciousReportReceiver.sol`, `MaliciousRevertingReceiver.sol`), and tests `KeystoneForwarder_ReportTest.t.sol` and `KeystoneForwarderBaseTest.t.sol`. Those tests show the signing pattern. They are excluded from the npm `files` list except `test/mocks`, so read the tests in the chainlink-evm repo.

---

## 8. Gotchas

1. The `metadata` length is 64, not 62.
2. The mock forwarder is permissionless and unsigned. Treat any contract pointed at it as public-writable.
3. Forwarder txs succeed even when `onReport` reverts. Check `ReportProcessed.result`.
4. The docs claim that the simulator never calls `onReport` is contradicted by the deployed mock and by on-chain txs.
5. `workflowId` changes on every binary or config change. Its first byte is `0x00`.
6. `setExpectedWorkflowName` reverts the next `onReport` if `expectedAuthor` is unset (`WorkflowNameRequiresAuthorValidation`).
7. `ReceiverTemplate` requires OZ v5 `Ownable`. The npm IReceiver needs the `@openzeppelin/contracts@5.0.2/` remapping.
8. Embed a chain selector and a monotonic timestamp in your report to stop cross-chain and same-chain replay. The docs give sample code for both in the consumer guide, section 7.
9. Base Sepolia and Ethereum Sepolia share the same production forwarder address `0xF8344C…4482`, but they are separate deployments on separate chains. Signed reports are not chain-bound, which is why you embed the chain selector.

---

## UNVERIFIED items

1. The 4-byte value of `type(IReceiver).interfaceId`. It is not computed here because keccak tooling was unavailable; compute it in Solidity.
2. Whether `@chainlink/contracts@1.5.0` `keystone/interfaces/IReceiver.sol` compiles under forge with only the `@openzeppelin/contracts@5.0.2/` remapping. Forge was not available to test it.
3. Exactly which string the simulator hashes into `workflow_name`: `workflow-name` from `workflow.yaml` or the folder name. The observed values look like valid HashTruncateName outputs, but I could not match them to a known name.
4. The exact `workflowOwner` value in production when you use the off-chain registry or org-linked ownership (derived address versus EOA). Read it from your first production report.
5. Whether `WriteReportReply.receiverContractExecutionStatus` reflects a real `onReport` revert during `cre workflow simulate --broadcast`. The docs say it is always SUCCESS in simulation; I did not run a reverting consumer.
6. Whether the simulator ever uses the newer `MockKeystoneForwarder 1.0.0-dev` (with ERC-165 check) at different addresses. All three documented addresses currently run `1.0.0`.
7. The signature `v` packing for local tests against the production forwarder (`v-27` in the last byte). This is inferred from source, not executed.
8. The forwarder's gas overhead per signature. Measure it with a local test before choosing `gasLimit`.
