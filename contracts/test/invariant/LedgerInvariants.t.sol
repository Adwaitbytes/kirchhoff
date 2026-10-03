// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Test} from "forge-std/Test.sol";

import {CREReceiver} from "../../src/CREReceiver.sol";
import {ConservationLedger} from "../../src/ConservationLedger.sol";
import {QuarantineController} from "../../src/QuarantineController.sol";
import {ReportType, Status} from "../../src/interfaces/KirchhoffTypes.sol";

/// @notice Drives the ledger with arbitrary, mostly-plausible report sequences plus issuer and attacker actions, and
/// tracks the PRD section 17 invariants as ghost state after every call.
contract LedgerHandler is CommonBase, StdUtils {
    bytes32 internal constant TOKEN = keccak256("kETH");
    bytes32 internal constant WF = keccak256("workflow-all");
    uint8 internal constant ALL_TYPES = 0x1e; // bits 1..4

    ConservationLedger public immutable ledger;
    QuarantineController public immutable quarantine;
    address public immutable forwarder;
    address public immutable workflowOwner;
    address public immutable safe;

    // Ghost state
    bool public brokenSinceRecovering;
    bool public sawIllegalHealthyAfterBroken;
    bool public sawEpochRegression;
    bool public sawNonIncreasingAcceptedEpoch;
    uint64 public lastEpochId;
    uint256 public brokenCount;
    uint256 public recoveredCount;
    uint256 public acceptedEpochs;

    constructor(
        ConservationLedger ledger_,
        QuarantineController quarantine_,
        address forwarder_,
        address workflowOwner_,
        address safe_
    ) {
        ledger = ledger_;
        quarantine = quarantine_;
        forwarder = forwarder_;
        workflowOwner = workflowOwner_;
        safe = safe_;
    }

    // ---------------- actions ----------------

    function epoch(uint64 epochSeed, int128 delta, bool drift) external {
        uint64 epochId = _nearEpoch(epochSeed);
        Status s = drift ? Status.DRIFT : Status.CONSERVED;
        bytes memory payload =
            abi.encode(epochId, int256(delta), bytes32(0), bytes32(0), uint8(s), uint16(0), new bytes32[](0));
        _send(ReportType.EPOCH, payload);
    }

    function breach(uint256 evidenceSeed, int128 delta, address recipient) external {
        bytes32 evidence = keccak256(abi.encode(evidenceSeed % 8));
        bytes memory payload = abi.encode(
            uint64(evidenceSeed),
            int256(delta),
            bytes32(0),
            evidence,
            uint16(2),
            uint64(1),
            bytes32(0),
            recipient,
            uint256(1),
            bytes32(0)
        );
        _send(ReportType.BREACH, payload);
    }

    function quarantineApplied(bool useActive, uint256 seed) external {
        bytes32 incidentId = useActive ? ledger.activeIncident(TOKEN) : keccak256(abi.encode(seed));
        address[] memory tainted = new address[](1);
        tainted[0] = address(uint160(seed));
        _send(ReportType.QUARANTINE_APPLIED, abi.encode(incidentId, tainted));
    }

    function resolve(bool useActive, uint256 seed) external {
        bytes32 incidentId = useActive ? ledger.activeIncident(TOKEN) : keccak256(abi.encode(seed));
        vm.prank(safe);
        try quarantine.resolve(TOKEN, incidentId) {} catch {}
        _observe(false);
    }

    function recoveryCheck(uint64 epochSeed, int128 delta) external {
        _send(ReportType.RECOVERY_CHECK, abi.encode(_nearEpoch(epochSeed), int256(delta), bytes32(0)));
    }

    function warp(uint32 secondsForward) external {
        vm.warp(block.timestamp + bound(secondsForward, 1, 2 hours));
    }

    /// @notice Attackers try every entry point that could clear BROKEN without the Safe.
    function attackerTries(address caller, uint64 recoveryEndsAt) external {
        vm.assume(caller != forwarder && caller != address(quarantine) && caller != safe);
        vm.prank(caller);
        try ledger.beginRecovery(TOKEN, ledger.activeIncident(TOKEN), recoveryEndsAt) {} catch {}
        bytes memory report = abi.encode(
            ReportType.RECOVERY_CHECK,
            ledger.chainSelector(),
            address(ledger),
            TOKEN,
            abi.encode(lastEpochId + 1, int256(0), bytes32(0))
        );
        vm.prank(caller);
        try ledger.onReport(abi.encodePacked(WF, bytes10(0), workflowOwner, bytes2(0)), report) {} catch {}
        vm.prank(caller);
        try quarantine.resolve(TOKEN, ledger.activeIncident(TOKEN)) {} catch {}
        _observe(false);
    }

    // ---------------- internals ----------------

    function _nearEpoch(uint64 seed) internal view returns (uint64) {
        // Mostly lastEpochId + 1 or + 2, sometimes a replay or a regression, so both accept and reject paths run.
        uint256 pick = seed % 5;
        if (pick == 0) return lastEpochId;
        if (pick == 1 && lastEpochId > 0) return lastEpochId - 1;
        return lastEpochId + uint64(1 + seed % 2);
    }

    function _send(uint8 reportType, bytes memory payload) internal {
        bytes memory report = abi.encode(reportType, ledger.chainSelector(), address(ledger), TOKEN, payload);
        bytes memory metadata = abi.encodePacked(WF, bytes10(0), workflowOwner, bytes2(0));
        uint64 before = ledger.latestEpoch(TOKEN).epochId;
        vm.prank(forwarder);
        bool ok;
        try ledger.onReport(metadata, report) {
            ok = true;
        } catch {}
        uint64 afterId = ledger.latestEpoch(TOKEN).epochId;
        if (ok && afterId != before) {
            ++acceptedEpochs;
            if (afterId <= before) sawNonIncreasingAcceptedEpoch = true;
        }
        _observe(ok && reportType == ReportType.RECOVERY_CHECK);
    }

    function _observe(bool recovered) internal {
        (Status s,,,) = ledger.statusOf(TOKEN);
        uint64 epochId = ledger.latestEpoch(TOKEN).epochId;
        if (epochId < lastEpochId) sawEpochRegression = true;
        lastEpochId = epochId;

        if (s == Status.BROKEN) {
            if (!brokenSinceRecovering) ++brokenCount;
            brokenSinceRecovering = true;
        } else if (s == Status.RECOVERING) {
            brokenSinceRecovering = false;
        } else if ((s == Status.CONSERVED || s == Status.DRIFT) && brokenSinceRecovering) {
            sawIllegalHealthyAfterBroken = true;
        }
        if (recovered) ++recoveredCount;
    }
}

contract LedgerInvariantTest is Test {
    LedgerHandler internal handler;
    ConservationLedger internal ledger;

    function setUp() public {
        vm.warp(1_790_000_000);
        address admin = makeAddr("admin");
        address forwarder = makeAddr("forwarder");
        address workflowOwner = makeAddr("workflowOwner");
        address safe = makeAddr("safe");
        ledger =
            new ConservationLedger(forwarder, CREReceiver.ForwarderMode.PRODUCTION, 16_015_286_601_757_825_753, admin);
        QuarantineController quarantine = new QuarantineController(ledger, admin);
        vm.startPrank(admin);
        ledger.setQuarantineController(address(quarantine));
        ledger.registerToken(keccak256("kETH"), 120);
        quarantine.configureToken(keccak256("kETH"), safe, 600);
        ledger.setWorkflow(keccak256("workflow-all"), workflowOwner, "", 0x1e);
        vm.stopPrank();

        handler = new LedgerHandler(ledger, quarantine, forwarder, workflowOwner, safe);
        targetContract(address(handler));
    }

    /// @notice PRD section 7/17: status never goes from BROKEN to CONSERVED (or DRIFT) without passing RECOVERING.
    function invariant_brokenNeverHealthyWithoutRecovering() public view {
        assertFalse(handler.sawIllegalHealthyAfterBroken());
    }

    /// @notice PRD section 17: epochId strictly increases.
    function invariant_epochIdStrictlyIncreases() public view {
        assertFalse(handler.sawEpochRegression());
        assertFalse(handler.sawNonIncreasingAcceptedEpoch());
        assertEq(ledger.latestEpoch(keccak256("kETH")).epochId, handler.lastEpochId());
    }

    /// @notice Recovery only ever completes through the Safe path; the counters show the paths were exercised.
    function invariant_recoveryNeverExceedsBreaks() public view {
        assertLe(handler.recoveredCount(), handler.brokenCount());
    }

    /// @notice The handler can reach every state, so the invariants above are not vacuous.
    function test_handlerReachesFullRecoveryCycle() public {
        handler.epoch(2, 0, false); // seed % 5 == 2 -> epoch 1
        handler.breach(1, -1, address(0xBEEF));
        handler.quarantineApplied(true, 1);
        handler.resolve(true, 0);
        handler.warp(type(uint32).max); // bounded to 2h, past the 600s recovery timelock
        handler.recoveryCheck(2, 0);
        assertEq(handler.brokenCount(), 1);
        assertEq(handler.recoveredCount(), 1);
        assertEq(handler.acceptedEpochs(), 2);
        assertFalse(handler.brokenSinceRecovering());
    }
}
