// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IReceiver} from "@chainlink/contracts/src/v0.8/keystone/interfaces/IReceiver.sol";

/// @title MockKeystoneForwarder (LOCAL ANVIL / TESTS ONLY)
/// @notice Behaves like the "MockKeystoneForwarder 1.0.0" Chainlink deploys for `cre workflow simulate --broadcast`
/// (docs/research/cre-contracts.md section 6c): same `report` entry point, raw-report layout and metadata slicing as
/// KeystoneForwarder 1.0.0, but permissionless, unsigned, with no ERC-165 check and no replay guard. A reverting
/// receiver does not revert the transmission; it is reported as `ReportProcessed(..., false)`.
/// Anything pointed at this forwarder is public-writable except for its workflow pinning.
contract MockKeystoneForwarder {
    string public constant typeAndVersion = "MockKeystoneForwarder 1.0.0 (KIRCHHOFF local)";

    /// @dev Raw report layout (KeystoneForwarder._getMetadata): version(1) | workflow_execution_id(32) |
    /// timestamp(4) | don_id(4) | don_config_version(4) | workflow_cid(32) | workflow_name(10) |
    /// workflow_owner(20) | report_id(2) | report. onReport receives bytes [45, 109) as metadata.
    uint256 internal constant METADATA_LENGTH = 109;
    uint256 internal constant FORWARDER_METADATA_LENGTH = 45;

    mapping(bytes32 transmissionId => bool) public succeeded;

    error InvalidReport();
    error InvalidReceiver();

    event ReportProcessed(
        address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result
    );

    function report(address receiver, bytes calldata rawReport, bytes calldata, bytes[] calldata) external {
        if (rawReport.length < METADATA_LENGTH) revert InvalidReport();
        if (receiver == address(0)) revert InvalidReceiver();
        bytes32 workflowExecutionId = bytes32(rawReport[1:33]);
        bytes2 reportId = bytes2(rawReport[107:109]);

        // Like the upstream mock, the event follows the call and reports its outcome.
        (bool success,) = receiver.call(
            abi.encodeCall(
                IReceiver.onReport, (rawReport[FORWARDER_METADATA_LENGTH:METADATA_LENGTH], rawReport[METADATA_LENGTH:])
            )
        );
        succeeded[getTransmissionId(receiver, workflowExecutionId, reportId)] = success;
        // forge-lint: disable-next-line(reentrancy-events)
        emit ReportProcessed(receiver, workflowExecutionId, reportId, success);
    }

    function getTransmissionId(address receiver, bytes32 workflowExecutionId, bytes2 reportId)
        public
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(bytes20(uint160(receiver)), workflowExecutionId, reportId));
    }

    /// @notice Builds a raw report exactly as the CRE DON does, for scripts and tests.
    function encodeRawReport(
        bytes32 workflowExecutionId,
        uint32 timestamp,
        uint32 donId,
        uint32 donConfigVersion,
        bytes32 workflowId,
        bytes10 workflowName,
        address workflowOwner,
        bytes2 reportId,
        bytes calldata reportBody
    ) external pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(1),
            workflowExecutionId,
            timestamp,
            donId,
            donConfigVersion,
            workflowId,
            workflowName,
            workflowOwner,
            reportId,
            reportBody
        );
    }
}
