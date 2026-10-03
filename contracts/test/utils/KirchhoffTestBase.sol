// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {CREReceiver} from "../../src/CREReceiver.sol";
import {ConservationLedger} from "../../src/ConservationLedger.sol";
import {QuarantineController} from "../../src/QuarantineController.sol";
import {ReportType, Status} from "../../src/interfaces/KirchhoffTypes.sol";

/// @notice Shared fixture: one chain's ledger + quarantine for kETH, three authorized workflows (W1, W2, W3), and
/// builders that encode reports exactly as docs/INTERFACES.md specifies.
abstract contract KirchhoffTestBase is Test {
    uint64 internal constant HOME_SELECTOR = 16_015_286_601_757_825_753; // Ethereum Sepolia
    uint64 internal constant ARB_SELECTOR = 3_478_487_238_524_512_106;
    uint64 internal constant BASE_SELECTOR = 10_344_971_235_874_465_080;
    uint64 internal constant STALENESS = 120;
    uint64 internal constant RECOVERY_TIMELOCK = 3600;

    bytes32 internal constant KETH_ID = keccak256("kETH");
    bytes32 internal constant W1_ID = keccak256("workflow-w1-junction");
    bytes32 internal constant W2_ID = keccak256("workflow-w2-loop");
    bytes32 internal constant W3_ID = keccak256("workflow-w3-responder");
    string internal constant W1_NAME = "w1-junction";
    string internal constant W2_NAME = "w2-loop";
    string internal constant W3_NAME = "w3-responder";

    uint8 internal constant MASK_W1 = uint8(1 << ReportType.BREACH);
    uint8 internal constant MASK_W2 =
        uint8((1 << ReportType.EPOCH) | (1 << ReportType.BREACH) | (1 << ReportType.RECOVERY_CHECK));
    uint8 internal constant MASK_W3 = uint8(1 << ReportType.QUARANTINE_APPLIED);

    address internal admin = makeAddr("admin");
    address internal safe = makeAddr("issuerSafe");
    address internal forwarder = makeAddr("keystoneForwarder");
    address internal workflowOwner = makeAddr("workflowOwner");
    address internal attacker = makeAddr("attacker");

    ConservationLedger internal ledger;
    QuarantineController internal quarantine;

    uint64 internal localSelector;

    function _deployCore(uint64 selector) internal {
        vm.warp(1_790_000_000);
        localSelector = selector;
        _cacheName(W1_NAME);
        _cacheName(W2_NAME);
        _cacheName(W3_NAME);
        _cacheName("evil");
        _cacheName("anything");
        ledger = new ConservationLedger(forwarder, CREReceiver.ForwarderMode.PRODUCTION, selector, admin);
        quarantine = new QuarantineController(ledger, admin);
        vm.startPrank(admin);
        ledger.setQuarantineController(address(quarantine));
        ledger.registerToken(KETH_ID, STALENESS);
        quarantine.configureToken(KETH_ID, safe, RECOVERY_TIMELOCK);
        ledger.setWorkflow(W1_ID, workflowOwner, W1_NAME, MASK_W1);
        ledger.setWorkflow(W2_ID, workflowOwner, W2_NAME, MASK_W2);
        ledger.setWorkflow(W3_ID, workflowOwner, W3_NAME, MASK_W3);
        vm.stopPrank();
    }

    // ---------------- metadata / envelope ----------------
    // Helpers make no external calls, so they never consume a pending vm.prank or vm.expectRevert.

    mapping(bytes32 nameKey => bytes10) internal nameCache;

    /// @dev sha256 is a precompile call, which would consume a pending prank/expectRevert, so names are encoded once
    /// up front with _cacheName and looked up afterwards.
    function _cacheName(string memory name) internal {
        nameCache[keccak256(bytes(name))] = _computeName(name);
    }

    function _encodeName(string memory name) internal view returns (bytes10 encoded) {
        if (bytes(name).length == 0) return bytes10(0);
        encoded = nameCache[keccak256(bytes(name))];
        require(encoded != bytes10(0), "name not cached");
    }

    /// @dev Independent reimplementation of the CRE ReceiverTemplate workflow-name encoding.
    function _computeName(string memory name) internal pure returns (bytes10) {
        if (bytes(name).length == 0) return bytes10(0);
        bytes32 h = sha256(bytes(name));
        bytes memory hexChars = "0123456789abcdef";
        bytes memory out = new bytes(10);
        for (uint256 i = 0; i < 10; ++i) {
            uint8 b = uint8(h[i / 2]);
            out[i] = hexChars[i % 2 == 0 ? b >> 4 : b & 0x0f];
        }
        return bytes10(out);
    }

    function _metadata(bytes32 workflowId, string memory name, address owner) internal view returns (bytes memory) {
        return abi.encodePacked(workflowId, _encodeName(name), owner, bytes2(0x0001));
    }

    function _envelope(uint8 reportType, bytes32 tokenId, bytes memory payload) internal view returns (bytes memory) {
        return abi.encode(reportType, localSelector, address(ledger), tokenId, payload);
    }

    function _deliver(bytes32 workflowId, string memory name, bytes memory report) internal {
        vm.prank(forwarder);
        ledger.onReport(_metadata(workflowId, name, workflowOwner), report);
    }

    // ---------------- payloads ----------------

    function _epochPayload(uint64 epochId, int256 delta, Status status, bytes32[] memory settled)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            epochId,
            delta,
            keccak256(abi.encode("blocks", epochId)),
            keccak256(abi.encode("ev", epochId)),
            uint8(status),
            uint16(0),
            settled
        );
    }

    function _breachPayload(bytes32 evidenceHash, uint16 reason, address recipient, uint256 amount)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            uint64(7),
            -int256(amount),
            keccak256("blocks"),
            evidenceHash,
            reason,
            HOME_SELECTOR,
            keccak256(abi.encode("tx", evidenceHash)),
            recipient,
            amount,
            keccak256(abi.encode("msg", evidenceHash))
        );
    }

    // ---------------- report shortcuts ----------------

    function _epoch(uint64 epochId, int256 delta, Status status) internal {
        _deliver(
            W2_ID,
            W2_NAME,
            _envelope(ReportType.EPOCH, KETH_ID, _epochPayload(epochId, delta, status, new bytes32[](0)))
        );
    }

    function _breach(bytes32 evidenceHash, uint16 reason, address recipient, uint256 amount) internal {
        _deliver(
            W1_ID,
            W1_NAME,
            _envelope(ReportType.BREACH, KETH_ID, _breachPayload(evidenceHash, reason, recipient, amount))
        );
    }

    function _quarantineApplied(bytes32 incidentId, address[] memory tainted) internal {
        _deliver(W3_ID, W3_NAME, _envelope(ReportType.QUARANTINE_APPLIED, KETH_ID, abi.encode(incidentId, tainted)));
    }

    function _recoveryCheck(uint64 epochId, int256 delta) internal {
        _deliver(
            W2_ID, W2_NAME, _envelope(ReportType.RECOVERY_CHECK, KETH_ID, abi.encode(epochId, delta, keccak256("rb")))
        );
    }

    function _incident(bytes32 evidenceHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(KETH_ID, evidenceHash));
    }

    function _status() internal view returns (Status s) {
        (s,,,) = ledger.statusOf(KETH_ID);
    }

    /// @dev Drives the token to RECOVERING with the timelock elapsed; returns the incident id.
    function _driveToRecovering(bytes32 evidenceHash) internal returns (bytes32 incidentId) {
        incidentId = _incident(evidenceHash);
        _breach(evidenceHash, 2, attacker, 1 ether);
        address[] memory tainted = new address[](1);
        tainted[0] = attacker;
        _quarantineApplied(incidentId, tainted);
        vm.prank(safe);
        quarantine.resolve(KETH_ID, incidentId);
    }

    function _one(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }
}
