// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {KeystoneForwarder} from "@chainlink/contracts/src/v0.8/keystone/KeystoneForwarder.sol";

import {CREReceiver} from "../src/CREReceiver.sol";
import {MockKeystoneForwarder} from "../src/demo/MockKeystoneForwarder.sol";
import {ReportType, Status} from "../src/interfaces/KirchhoffTypes.sol";

import {KirchhoffTestBase} from "./utils/KirchhoffTestBase.sol";

/// @notice End-to-end delivery through the real KeystoneForwarder 1.0.0 (DON signatures, f = 1) and through
/// MockKeystoneForwarder, proving both hand the ledger byte-identical metadata.
contract ForwarderIntegrationTest is KirchhoffTestBase {
    KeystoneForwarder internal realForwarder;
    MockKeystoneForwarder internal mockForwarder;
    uint256[4] internal signerKeys = [uint256(0xA11CE), 0xB0B, 0xCA401, 0xD0D];

    uint32 internal constant DON_ID = 1;
    uint32 internal constant CONFIG_VERSION = 1;

    function setUp() public {
        _deployCore(HOME_SELECTOR);
        realForwarder = new KeystoneForwarder();
        address[] memory signers = new address[](4);
        for (uint256 i = 0; i < 4; ++i) {
            signers[i] = vm.addr(signerKeys[i]);
        }
        realForwarder.setConfig(DON_ID, CONFIG_VERSION, 1, signers);
        mockForwarder = new MockKeystoneForwarder();
    }

    function _rawReport(bytes32 executionId, bytes32 workflowId, string memory name, bytes memory body)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            uint8(1),
            executionId,
            uint32(block.timestamp),
            DON_ID,
            CONFIG_VERSION,
            workflowId,
            _encodeName(name),
            workflowOwner,
            bytes2(0x0001),
            body
        );
    }

    function _sign(bytes memory rawReport, bytes memory reportContext) internal view returns (bytes[] memory sigs) {
        bytes32 completeHash = keccak256(abi.encodePacked(keccak256(rawReport), reportContext));
        sigs = new bytes[](2); // f + 1
        for (uint256 i = 0; i < 2; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKeys[i], completeHash);
            sigs[i] = abi.encodePacked(r, s, v - 27);
        }
    }

    function test_realForwarder_deliversSignedEpoch() public {
        vm.prank(admin);
        ledger.setForwarder(address(realForwarder), CREReceiver.ForwarderMode.PRODUCTION);

        bytes memory body =
            _envelope(ReportType.EPOCH, KETH_ID, _epochPayload(1, 0, Status.CONSERVED, new bytes32[](0)));
        bytes memory raw = _rawReport(keccak256("exec-1"), W2_ID, W2_NAME, body);
        bytes memory ctx = abi.encodePacked(keccak256("configDigest"), bytes32(uint256(1)), bytes32(0));

        vm.expectEmit(address(realForwarder));
        emit KeystoneForwarder.ReportProcessed(address(ledger), keccak256("exec-1"), bytes2(0x0001), true);
        realForwarder.report(address(ledger), raw, ctx, _sign(raw, ctx));
        assertEq(uint8(_status()), uint8(Status.CONSERVED));
    }

    function test_realForwarder_unregisteredWorkflowFailsTransmission() public {
        vm.prank(admin);
        ledger.setForwarder(address(realForwarder), CREReceiver.ForwarderMode.PRODUCTION);

        bytes memory body =
            _envelope(ReportType.EPOCH, KETH_ID, _epochPayload(1, 0, Status.CONSERVED, new bytes32[](0)));
        bytes memory raw = _rawReport(keccak256("exec-2"), keccak256("rogue"), W2_NAME, body);
        bytes memory ctx = abi.encodePacked(keccak256("configDigest"), bytes32(uint256(2)), bytes32(0));

        vm.expectEmit(address(realForwarder));
        emit KeystoneForwarder.ReportProcessed(address(ledger), keccak256("exec-2"), bytes2(0x0001), false);
        realForwarder.report(address(ledger), raw, ctx, _sign(raw, ctx));
        assertEq(uint8(_status()), uint8(Status.UNKNOWN));
    }

    function test_realForwarder_ledgerRejectsDirectCallsWhenWiredToForwarder() public {
        vm.prank(admin);
        ledger.setForwarder(address(realForwarder), CREReceiver.ForwarderMode.PRODUCTION);
        bytes memory body =
            _envelope(ReportType.EPOCH, KETH_ID, _epochPayload(1, 0, Status.CONSERVED, new bytes32[](0)));
        // The old forwarder address no longer works.
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(CREReceiver.InvalidSender.selector, forwarder, address(realForwarder)));
        ledger.onReport(_metadata(W2_ID, W2_NAME, workflowOwner), body);
    }

    function test_mockForwarder_matchesRealLayout() public {
        vm.prank(admin);
        ledger.setForwarder(address(mockForwarder), CREReceiver.ForwarderMode.LOCAL_MOCK);

        bytes memory body =
            _envelope(ReportType.EPOCH, KETH_ID, _epochPayload(1, 3, Status.CONSERVED, new bytes32[](0)));
        bytes memory raw = _rawReport(keccak256("exec-3"), W2_ID, W2_NAME, body);
        assertEq(
            raw,
            mockForwarder.encodeRawReport(
                keccak256("exec-3"),
                uint32(block.timestamp),
                DON_ID,
                CONFIG_VERSION,
                W2_ID,
                _encodeName(W2_NAME),
                workflowOwner,
                bytes2(0x0001),
                body
            )
        );

        vm.expectEmit(address(mockForwarder));
        emit MockKeystoneForwarder.ReportProcessed(address(ledger), keccak256("exec-3"), bytes2(0x0001), true);
        mockForwarder.report(address(ledger), raw, "", new bytes[](0));
        (, int256 delta,,) = ledger.statusOf(KETH_ID);
        assertEq(delta, 3);

        bytes32 transmissionId = mockForwarder.getTransmissionId(address(ledger), keccak256("exec-3"), bytes2(0x0001));
        assertTrue(mockForwarder.succeeded(transmissionId));

        // Like the deployed simulation mock there is no replay guard: the ledger's own epoch ordering rejects it,
        // the forwarder tx still succeeds and reports result=false, and state is unchanged.
        uint64 revision = ledger.revisionOf(KETH_ID);
        vm.expectEmit(address(mockForwarder));
        emit MockKeystoneForwarder.ReportProcessed(address(ledger), keccak256("exec-3"), bytes2(0x0001), false);
        mockForwarder.report(address(ledger), raw, "", new bytes[](0));
        assertEq(ledger.revisionOf(KETH_ID), revision);
        assertFalse(mockForwarder.succeeded(transmissionId));
    }

    function test_mockForwarder_rejectedReportIsFailedTransmission() public {
        vm.prank(admin);
        ledger.setForwarder(address(mockForwarder), CREReceiver.ForwarderMode.LOCAL_MOCK);
        bytes memory body = _envelope(ReportType.EPOCH, KETH_ID, _epochPayload(1, 0, Status.DRIFT, new bytes32[](0)));
        bytes memory raw = _rawReport(keccak256("exec-4"), W2_ID, W2_NAME, body);

        vm.expectEmit(address(mockForwarder));
        emit MockKeystoneForwarder.ReportProcessed(address(ledger), keccak256("exec-4"), bytes2(0x0001), false);
        mockForwarder.report(address(ledger), raw, "", new bytes[](0)); // UNKNOWN -> DRIFT is illegal
        assertEq(uint8(_status()), uint8(Status.UNKNOWN), "rejected report leaves state untouched");
    }

    function test_mockForwarder_isPermissionlessButPinningHolds() public {
        vm.prank(admin);
        ledger.setForwarder(address(mockForwarder), CREReceiver.ForwarderMode.SIMULATION);
        bytes memory body = _envelope(ReportType.BREACH, KETH_ID, _breachPayload(keccak256("fake"), 2, attacker, 1));
        bytes memory raw = _rawReport(keccak256("exec-6"), keccak256("attacker-workflow"), W1_NAME, body);
        vm.prank(attacker);
        mockForwarder.report(address(ledger), raw, "", new bytes[](0));
        assertEq(uint8(_status()), uint8(Status.UNKNOWN), "unpinned workflow cannot write through the open mock");
    }

    function test_mockForwarder_rejectsShortReportAndZeroReceiver() public {
        vm.expectRevert(MockKeystoneForwarder.InvalidReport.selector);
        mockForwarder.report(address(ledger), new bytes(108), "", new bytes[](0));
        vm.expectRevert(MockKeystoneForwarder.InvalidReceiver.selector);
        mockForwarder.report(address(0), new bytes(109), "", new bytes[](0));
    }

    function test_mockForwarder_nonReceiverIsFailedTransmission() public {
        bytes memory raw = _rawReport(keccak256("exec-5"), W2_ID, W2_NAME, "");
        vm.expectEmit(address(mockForwarder));
        emit MockKeystoneForwarder.ReportProcessed(address(this), keccak256("exec-5"), bytes2(0x0001), false);
        mockForwarder.report(address(this), raw, "", new bytes[](0));
    }
}
