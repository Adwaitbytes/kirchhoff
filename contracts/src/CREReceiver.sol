// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IReceiver} from "@chainlink/contracts/src/v0.8/keystone/interfaces/IReceiver.sol";

/// @title CREReceiver
/// @notice Chainlink CRE `ReceiverTemplate` pattern (docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/
/// building-consumer-contracts, page revision 2026-05-08), hardened for KIRCHHOFF:
///  - the forwarder check is mandatory and can never be set to zero (the template allows disabling it), and the
///    receiver records whether that forwarder is the signed production one or a permissionless mock;
///  - several workflows (W1, W2, W3) write to the same ledger, so instead of the template's single expected
///    workflow id we keep an allowlist keyed by workflow id, each entry pinning its owner, optional name and the
///    report types it may send. Pinning is always on, because the simulation MockKeystoneForwarder lets anyone
///    deliver arbitrary metadata (simulation reports carry workflowId 0x11..11 and owner 0xaa..aa);
///  - metadata decoding and workflow-name encoding are byte-for-byte the template's, so CRE metadata produced by
///    the real KeystoneForwarder (`rawReport[45:109]`, KeystoneForwarder 1.0.0) is accepted unchanged.
abstract contract CREReceiver is IReceiver, Ownable2Step {
    /// @notice Which forwarder the receiver trusts. SIMULATION and LOCAL_MOCK forwarders are permissionless and
    /// unsigned, so in those modes the receiver is only as safe as its workflow pinning, and UIs must label it.
    enum ForwarderMode {
        PRODUCTION, // KeystoneForwarder 1.0.0, DON-signed reports
        SIMULATION, // Chainlink's MockKeystoneForwarder used by `cre workflow simulate --broadcast`
        LOCAL_MOCK // MockKeystoneForwarder deployed on a local Anvil chain
    }

    struct WorkflowAuth {
        address owner; // CRE workflow owner (the template's "author"); never zero for an allowed workflow
        bytes10 name; // template encoding of the workflow name; zero means "do not check the name"
        uint8 allowedReportTypes; // bitmask, bit n set means report type n is allowed
    }

    /// @dev Metadata is workflow_cid(32) | workflow_name(10) | workflow_owner(20) | report_id(2).
    uint256 internal constant METADATA_LENGTH = 64;
    bytes private constant HEX_CHARS = "0123456789abcdef";

    address private s_forwarder;
    ForwarderMode private s_forwarderMode;
    mapping(bytes32 workflowId => WorkflowAuth) private s_workflows;

    error InvalidForwarderAddress();
    error InvalidSender(address sender, address expected);
    error InvalidMetadataLength(uint256 length);
    error InvalidWorkflowId(bytes32 received);
    error InvalidAuthor(address received, address expected);
    error InvalidWorkflowName(bytes10 received, bytes10 expected);
    error InvalidWorkflowOwner();
    error ReportTypeNotAllowed(bytes32 workflowId, uint8 reportType);

    event ForwarderAddressUpdated(address indexed previousForwarder, address indexed newForwarder);
    event ForwarderModeUpdated(ForwarderMode mode);
    event WorkflowAuthorized(bytes32 indexed workflowId, address indexed owner, bytes10 name, uint8 allowedReportTypes);
    event WorkflowRevoked(bytes32 indexed workflowId);

    constructor(address forwarder, ForwarderMode mode, address initialOwner) Ownable(initialOwner) {
        if (forwarder == address(0)) revert InvalidForwarderAddress();
        s_forwarder = forwarder;
        s_forwarderMode = mode;
        emit ForwarderAddressUpdated(address(0), forwarder);
        emit ForwarderModeUpdated(mode);
    }

    /// @inheritdoc IReceiver
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != s_forwarder) revert InvalidSender(msg.sender, s_forwarder);
        if (metadata.length != METADATA_LENGTH) revert InvalidMetadataLength(metadata.length);

        (bytes32 workflowId, bytes10 workflowName, address workflowOwner) = _decodeMetadata(metadata);
        WorkflowAuth memory auth = s_workflows[workflowId];
        if (auth.owner == address(0)) revert InvalidWorkflowId(workflowId);
        if (workflowOwner != auth.owner) revert InvalidAuthor(workflowOwner, auth.owner);
        if (auth.name != bytes10(0) && workflowName != auth.name) {
            revert InvalidWorkflowName(workflowName, auth.name);
        }

        _processReport(workflowId, auth.allowedReportTypes, report);
    }

    /// @notice Mode and address change together, so the label can never disagree with the forwarder in use.
    function setForwarder(address forwarder, ForwarderMode mode) external onlyOwner {
        if (forwarder == address(0)) revert InvalidForwarderAddress();
        address previous = s_forwarder;
        s_forwarder = forwarder;
        s_forwarderMode = mode;
        emit ForwarderAddressUpdated(previous, forwarder);
        emit ForwarderModeUpdated(mode);
    }

    /// @notice Allows a workflow to write. `name` is the plain workflow name; empty skips the name check.
    function setWorkflow(bytes32 workflowId, address workflowOwner, string calldata name, uint8 allowedReportTypes)
        external
        onlyOwner
    {
        if (workflowOwner == address(0)) revert InvalidWorkflowOwner();
        bytes10 encoded = encodeWorkflowName(name);
        s_workflows[workflowId] = WorkflowAuth(workflowOwner, encoded, allowedReportTypes);
        emit WorkflowAuthorized(workflowId, workflowOwner, encoded, allowedReportTypes);
    }

    function revokeWorkflow(bytes32 workflowId) external onlyOwner {
        delete s_workflows[workflowId];
        emit WorkflowRevoked(workflowId);
    }

    function getForwarderAddress() external view returns (address) {
        return s_forwarder;
    }

    function forwarderMode() external view returns (ForwarderMode) {
        return s_forwarderMode;
    }

    function getWorkflow(bytes32 workflowId) external view returns (WorkflowAuth memory) {
        return s_workflows[workflowId];
    }

    /// @notice CRE workflow-name encoding from the ReceiverTemplate: the first 10 lowercase hex characters of
    /// sha256(name), stored as raw bytes.
    function encodeWorkflowName(string calldata name) public pure returns (bytes10) {
        if (bytes(name).length == 0) return bytes10(0);
        bytes32 hash = sha256(bytes(name));
        bytes memory first10 = new bytes(10);
        for (uint256 i = 0; i < 5; ++i) {
            uint8 b = uint8(hash[i]);
            first10[2 * i] = HEX_CHARS[b >> 4];
            first10[2 * i + 1] = HEX_CHARS[b & 0x0f];
        }
        return bytes10(first10);
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function _decodeMetadata(bytes memory metadata)
        internal
        pure
        returns (bytes32 workflowId, bytes10 workflowName, address workflowOwner)
    {
        assembly {
            workflowId := mload(add(metadata, 32))
            workflowName := mload(add(metadata, 64))
            workflowOwner := shr(mul(12, 8), mload(add(metadata, 74)))
        }
    }

    /// @param allowedReportTypes The calling workflow's report-type bitmask, enforced by the implementer.
    function _processReport(bytes32 workflowId, uint8 allowedReportTypes, bytes calldata report) internal virtual;
}
