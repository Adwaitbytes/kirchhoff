// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CREReceiver} from "../src/CREReceiver.sol";
import {ConservationLedger} from "../src/ConservationLedger.sol";
import {IConservationLedger} from "../src/interfaces/IConservationLedger.sol";
import {IQuarantineController} from "../src/interfaces/IQuarantineController.sol";
import {Breach, Epoch, Reason, ReportType, Status} from "../src/interfaces/KirchhoffTypes.sol";
import {IReceiver} from "@chainlink/contracts/src/v0.8/keystone/interfaces/IReceiver.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {KirchhoffTestBase} from "./utils/KirchhoffTestBase.sol";

contract ConservationLedgerTest is KirchhoffTestBase {
    bytes32 internal constant EVIDENCE = keccak256("evidence-kelp-replay");

    function setUp() public {
        _deployCore(HOME_SELECTOR);
    }

    // ================================================================
    // Registration and wiring
    // ================================================================

    function test_registerToken_emitsAndStores() public {
        bytes32 id = keccak256("kUSD");
        vm.expectEmit(address(ledger));
        emit IConservationLedger.TokenRegistered(id, 60);
        vm.prank(admin);
        ledger.registerToken(id, 60);
        assertTrue(ledger.isRegistered(id));
        assertEq(ledger.stalenessSeconds(id), 60);
    }

    function test_registerToken_revertsTwice() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.TokenAlreadyRegistered.selector, KETH_ID));
        ledger.registerToken(KETH_ID, 60);
    }

    function test_registerToken_revertsZeroStaleness() public {
        vm.prank(admin);
        vm.expectRevert(ConservationLedger.InvalidStaleness.selector);
        ledger.registerToken(keccak256("x"), 0);
    }

    function test_registerToken_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        ledger.registerToken(keccak256("x"), 60);
    }

    function test_setQuarantineController_oneShot() public {
        vm.prank(admin);
        vm.expectRevert(ConservationLedger.QuarantineControllerAlreadySet.selector);
        ledger.setQuarantineController(address(1));
    }

    function test_setQuarantineController_rejectsZero() public {
        ConservationLedger fresh =
            new ConservationLedger(forwarder, CREReceiver.ForwarderMode.PRODUCTION, HOME_SELECTOR, admin);
        vm.prank(admin);
        vm.expectRevert(ConservationLedger.ZeroAddress.selector);
        fresh.setQuarantineController(address(0));
    }

    function test_breach_revertsWithoutController() public {
        ConservationLedger fresh =
            new ConservationLedger(forwarder, CREReceiver.ForwarderMode.PRODUCTION, HOME_SELECTOR, admin);
        vm.startPrank(admin);
        fresh.registerToken(KETH_ID, STALENESS);
        fresh.setWorkflow(W1_ID, workflowOwner, W1_NAME, MASK_W1);
        vm.stopPrank();
        bytes memory report = abi.encode(
            ReportType.BREACH, HOME_SELECTOR, address(fresh), KETH_ID, _breachPayload(EVIDENCE, 2, attacker, 1)
        );
        bytes memory metadata = _metadata(W1_ID, W1_NAME, workflowOwner);
        vm.prank(forwarder);
        vm.expectRevert(ConservationLedger.QuarantineControllerNotSet.selector);
        fresh.onReport(metadata, report);
    }

    function test_constructor_rejectsZeroForwarder() public {
        vm.expectRevert(CREReceiver.InvalidForwarderAddress.selector);
        new ConservationLedger(address(0), CREReceiver.ForwarderMode.PRODUCTION, HOME_SELECTOR, admin);
    }

    function test_setStalenessSeconds_onlyIssuer() public {
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.OnlyIssuer.selector, address(this)));
        ledger.setStalenessSeconds(KETH_ID, 30);

        vm.prank(safe);
        vm.expectRevert(ConservationLedger.InvalidStaleness.selector);
        ledger.setStalenessSeconds(KETH_ID, 0);

        vm.expectEmit(address(ledger));
        emit IConservationLedger.StalenessUpdated(KETH_ID, 30);
        vm.prank(safe);
        ledger.setStalenessSeconds(KETH_ID, 30);
        assertEq(ledger.stalenessSeconds(KETH_ID), 30);
    }

    function test_setStalenessSeconds_unregisteredToken() public {
        bytes32 id = keccak256("nope");
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.TokenNotRegistered.selector, id));
        ledger.setStalenessSeconds(id, 30);
    }

    function test_supportsInterface() public view {
        assertTrue(ledger.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(ledger.supportsInterface(type(IERC165).interfaceId));
        assertFalse(ledger.supportsInterface(0xdeadbeef));
    }

    // ================================================================
    // Forwarder / workflow authentication (ReceiverTemplate pattern)
    // ================================================================

    function test_onReport_rejectsWrongForwarder() public {
        bytes memory report =
            _envelope(ReportType.EPOCH, KETH_ID, _epochPayload(1, 0, Status.CONSERVED, new bytes32[](0)));
        bytes memory metadata = _metadata(W2_ID, W2_NAME, workflowOwner);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(CREReceiver.InvalidSender.selector, attacker, forwarder));
        ledger.onReport(metadata, report);
    }

    function test_onReport_rejectsUnknownWorkflow() public {
        bytes32 rogue = keccak256("rogue");
        bytes memory report =
            _envelope(ReportType.EPOCH, KETH_ID, _epochPayload(1, 0, Status.CONSERVED, new bytes32[](0)));
        bytes memory metadata = _metadata(rogue, W2_NAME, workflowOwner);
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(CREReceiver.InvalidWorkflowId.selector, rogue));
        ledger.onReport(metadata, report);
    }

    function test_onReport_rejectsWrongOwner() public {
        bytes memory report =
            _envelope(ReportType.EPOCH, KETH_ID, _epochPayload(1, 0, Status.CONSERVED, new bytes32[](0)));
        bytes memory metadata = _metadata(W2_ID, W2_NAME, attacker);
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(CREReceiver.InvalidAuthor.selector, attacker, workflowOwner));
        ledger.onReport(metadata, report);
    }

    function test_onReport_rejectsWrongName() public {
        bytes memory report =
            _envelope(ReportType.EPOCH, KETH_ID, _epochPayload(1, 0, Status.CONSERVED, new bytes32[](0)));
        bytes memory metadata = _metadata(W2_ID, "evil", workflowOwner);
        vm.prank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(CREReceiver.InvalidWorkflowName.selector, _encodeName("evil"), _encodeName(W2_NAME))
        );
        ledger.onReport(metadata, report);
    }

    function test_onReport_skipsNameCheckWhenUnset() public {
        bytes32 id = keccak256("w2-noname");
        vm.prank(admin);
        ledger.setWorkflow(id, workflowOwner, "", MASK_W2);
        _deliver(
            id,
            "anything",
            _envelope(ReportType.EPOCH, KETH_ID, _epochPayload(1, 0, Status.CONSERVED, new bytes32[](0)))
        );
        assertEq(uint8(_status()), uint8(Status.CONSERVED));
    }

    function test_onReport_rejectsBadMetadataLength() public {
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(CREReceiver.InvalidMetadataLength.selector, 63));
        ledger.onReport(new bytes(63), "");
    }

    function test_onReport_rejectsReportTypeOutsideWorkflowMask() public {
        // W3 may only send QUARANTINE_APPLIED.
        bytes memory report =
            _envelope(ReportType.EPOCH, KETH_ID, _epochPayload(1, 0, Status.CONSERVED, new bytes32[](0)));
        vm.expectRevert(abi.encodeWithSelector(CREReceiver.ReportTypeNotAllowed.selector, W3_ID, ReportType.EPOCH));
        _deliver(W3_ID, W3_NAME, report);
    }

    function test_revokeWorkflow() public {
        vm.expectEmit(address(ledger));
        emit CREReceiver.WorkflowRevoked(W2_ID);
        vm.prank(admin);
        ledger.revokeWorkflow(W2_ID);
        vm.expectRevert(abi.encodeWithSelector(CREReceiver.InvalidWorkflowId.selector, W2_ID));
        _epoch(1, 0, Status.CONSERVED);
    }

    function test_setWorkflow_rejectsZeroOwner() public {
        vm.prank(admin);
        vm.expectRevert(CREReceiver.InvalidWorkflowOwner.selector);
        ledger.setWorkflow(W2_ID, address(0), W2_NAME, MASK_W2);
    }

    function test_setWorkflow_storesEncodedName() public view {
        CREReceiver.WorkflowAuth memory auth = ledger.getWorkflow(W2_ID);
        assertEq(auth.owner, workflowOwner);
        assertEq(auth.name, _encodeName(W2_NAME));
        assertEq(auth.allowedReportTypes, MASK_W2);
    }

    function test_encodeWorkflowName_matchesTemplateEncoding() public view {
        // First 10 lowercase hex chars of sha256(name) as raw ASCII (CRE ReceiverTemplate encoding), checked against
        // forge's own hex formatting ("0x" + 64 chars).
        bytes memory hexString = bytes(vm.toString(sha256(bytes(W2_NAME))));
        bytes memory first10 = new bytes(10);
        for (uint256 i = 0; i < 10; ++i) {
            first10[i] = hexString[i + 2];
        }
        assertEq(ledger.encodeWorkflowName(W2_NAME), bytes10(first10));
        assertEq(ledger.encodeWorkflowName(W2_NAME), _encodeName(W2_NAME));
        assertEq(ledger.encodeWorkflowName(""), bytes10(0));
    }

    function test_setForwarder() public {
        assertEq(uint8(ledger.forwarderMode()), uint8(CREReceiver.ForwarderMode.PRODUCTION));
        address next = makeAddr("next");
        vm.expectEmit(address(ledger));
        emit CREReceiver.ForwarderAddressUpdated(forwarder, next);
        vm.expectEmit(address(ledger));
        emit CREReceiver.ForwarderModeUpdated(CREReceiver.ForwarderMode.SIMULATION);
        vm.prank(admin);
        ledger.setForwarder(next, CREReceiver.ForwarderMode.SIMULATION);
        assertEq(ledger.getForwarderAddress(), next);
        assertEq(uint8(ledger.forwarderMode()), uint8(CREReceiver.ForwarderMode.SIMULATION));

        vm.prank(admin);
        vm.expectRevert(CREReceiver.InvalidForwarderAddress.selector);
        ledger.setForwarder(address(0), CREReceiver.ForwarderMode.PRODUCTION);
    }

    /// @dev Revision 2: simulation reports carry workflowId 0x11..11 and owner 0xaa..aa through a permissionless
    /// mock, so a simulation ledger pins exactly those and still rejects anything else.
    function test_simulationPinning() public {
        bytes32 simId = bytes32(0x1111111111111111111111111111111111111111111111111111111111111111);
        address simOwner = 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa;
        vm.startPrank(admin);
        ledger.setForwarder(forwarder, CREReceiver.ForwarderMode.SIMULATION);
        ledger.setWorkflow(simId, simOwner, "", MASK_W1 | MASK_W2 | MASK_W3);
        vm.stopPrank();

        bytes memory report =
            _envelope(ReportType.EPOCH, KETH_ID, _epochPayload(1, 0, Status.CONSERVED, new bytes32[](0)));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(CREReceiver.InvalidAuthor.selector, attacker, simOwner));
        ledger.onReport(abi.encodePacked(simId, bytes10("7ee82105a7"), attacker, bytes2(0x0001)), report);

        vm.prank(forwarder);
        ledger.onReport(abi.encodePacked(simId, bytes10("7ee82105a7"), simOwner, bytes2(0x0001)), report);
        assertEq(uint8(_status()), uint8(Status.CONSERVED));
    }

    function test_adminFunctions_onlyOwner() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker);
        vm.startPrank(attacker);
        vm.expectRevert(err);
        ledger.setForwarder(attacker, CREReceiver.ForwarderMode.PRODUCTION);
        vm.expectRevert(err);
        ledger.setWorkflow(keccak256("x"), attacker, "", 0xff);
        vm.expectRevert(err);
        ledger.revokeWorkflow(W1_ID);
        vm.stopPrank();
    }

    // ================================================================
    // Replay protection
    // ================================================================

    function test_replay_rejectsWrongChainSelector() public {
        bytes memory report = abi.encode(
            ReportType.EPOCH,
            ARB_SELECTOR,
            address(ledger),
            KETH_ID,
            _epochPayload(1, 0, Status.CONSERVED, new bytes32[](0))
        );
        vm.expectRevert(
            abi.encodeWithSelector(ConservationLedger.WrongChainSelector.selector, ARB_SELECTOR, HOME_SELECTOR)
        );
        _deliver(W2_ID, W2_NAME, report);
    }

    function test_replay_rejectsWrongLedger() public {
        address other = makeAddr("otherLedger");
        bytes memory report = abi.encode(
            ReportType.EPOCH, HOME_SELECTOR, other, KETH_ID, _epochPayload(1, 0, Status.CONSERVED, new bytes32[](0))
        );
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.WrongLedger.selector, other, address(ledger)));
        _deliver(W2_ID, W2_NAME, report);
    }

    function test_replay_sameReportOnSecondLedgerRejected() public {
        // A report built for ledger A on this chain must not apply to ledger B on the same chain.
        ConservationLedger ledgerB =
            new ConservationLedger(forwarder, CREReceiver.ForwarderMode.PRODUCTION, HOME_SELECTOR, admin);
        vm.startPrank(admin);
        ledgerB.registerToken(KETH_ID, STALENESS);
        ledgerB.setWorkflow(W2_ID, workflowOwner, W2_NAME, MASK_W2);
        vm.stopPrank();
        bytes memory report =
            _envelope(ReportType.EPOCH, KETH_ID, _epochPayload(1, 0, Status.CONSERVED, new bytes32[](0)));
        vm.prank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(ConservationLedger.WrongLedger.selector, address(ledger), address(ledgerB))
        );
        ledgerB.onReport(_metadata(W2_ID, W2_NAME, workflowOwner), report);
    }

    function test_rejectsUnknownReportType() public {
        vm.prank(admin);
        ledger.setWorkflow(W2_ID, workflowOwner, W2_NAME, 0xff);
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.UnknownReportType.selector, 0));
        _deliver(W2_ID, W2_NAME, _envelope(0, KETH_ID, ""));
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.UnknownReportType.selector, 5));
        _deliver(W2_ID, W2_NAME, _envelope(5, KETH_ID, ""));
    }

    function test_rejectsUnregisteredToken() public {
        bytes32 id = keccak256("unregistered");
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.TokenNotRegistered.selector, id));
        _deliver(W1_ID, W1_NAME, _envelope(ReportType.BREACH, id, _breachPayload(EVIDENCE, 2, attacker, 1)));
    }

    // ================================================================
    // EPOCH
    // ================================================================

    function test_epoch_firstConservedFromUnknown() public {
        vm.expectEmit(address(ledger));
        emit IConservationLedger.StatusChanged(KETH_ID, Status.UNKNOWN, Status.CONSERVED, 0);
        vm.expectEmit(address(ledger));
        emit IConservationLedger.EpochRecorded(KETH_ID, 1, 5, Status.CONSERVED);
        _epoch(1, 5, Status.CONSERVED);

        (Status s, int256 delta, uint64 updatedAt, bool stale) = ledger.statusOf(KETH_ID);
        assertEq(uint8(s), uint8(Status.CONSERVED));
        assertEq(delta, 5);
        assertEq(updatedAt, block.timestamp);
        assertFalse(stale);

        Epoch memory e = ledger.latestEpoch(KETH_ID);
        assertEq(e.epochId, 1);
        assertEq(e.delta, 5);
        assertEq(e.evaluatedAt, block.timestamp);
        assertEq(e.blocksHash, keccak256(abi.encode("blocks", uint64(1))));
        assertEq(uint8(e.status), uint8(Status.CONSERVED));
        assertEq(ledger.revisionOf(KETH_ID), 1);
    }

    function test_epoch_illegalUnknownToDrift() public {
        vm.expectRevert(
            abi.encodeWithSelector(ConservationLedger.IllegalTransition.selector, Status.UNKNOWN, Status.DRIFT)
        );
        _epoch(1, 0, Status.DRIFT);
    }

    function test_epoch_conservedDriftConserved() public {
        _epoch(1, 0, Status.CONSERVED);
        vm.expectEmit(address(ledger));
        emit IConservationLedger.StatusChanged(KETH_ID, Status.CONSERVED, Status.DRIFT, 0);
        _epoch(2, 0, Status.DRIFT);
        _epoch(3, 0, Status.CONSERVED);
        assertEq(uint8(_status()), uint8(Status.CONSERVED));
        assertEq(ledger.latestEpoch(KETH_ID).epochId, 3);
    }

    function test_epoch_sameStatusEmitsNoStatusChanged() public {
        _epoch(1, 0, Status.CONSERVED);
        vm.recordLogs();
        _epoch(2, 0, Status.CONSERVED);
        assertEq(vm.getRecordedLogs().length, 1); // EpochRecorded only
    }

    function test_epoch_rejectsNonIncreasingEpoch() public {
        _epoch(5, 0, Status.CONSERVED);
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.EpochNotIncreasing.selector, 5, 5));
        _epoch(5, 0, Status.CONSERVED);
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.EpochNotIncreasing.selector, 4, 5));
        _epoch(4, 0, Status.CONSERVED);
    }

    function test_epoch_rejectsEpochZero() public {
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.EpochNotIncreasing.selector, 0, 0));
        _epoch(0, 0, Status.CONSERVED);
    }

    function test_epoch_rejectsBrokenOrOtherStatuses() public {
        for (uint8 s = 0; s < 8; ++s) {
            if (s == uint8(Status.CONSERVED) || s == uint8(Status.DRIFT)) continue;
            bytes memory payload =
                abi.encode(uint64(1), int256(0), bytes32(0), bytes32(0), s, uint16(0), new bytes32[](0));
            vm.expectRevert(abi.encodeWithSelector(ConservationLedger.InvalidEpochStatus.selector, s));
            _deliver(W2_ID, W2_NAME, _envelope(ReportType.EPOCH, KETH_ID, payload));
        }
    }

    function test_epoch_marksSettledMessagesConsumed() public {
        bytes32[] memory settled = new bytes32[](2);
        settled[0] = keccak256("m1");
        settled[1] = keccak256("m2");
        vm.expectEmit(address(ledger));
        emit IConservationLedger.MessageConsumed(KETH_ID, settled[0]);
        vm.expectEmit(address(ledger));
        emit IConservationLedger.MessageConsumed(KETH_ID, settled[1]);
        _deliver(W2_ID, W2_NAME, _envelope(ReportType.EPOCH, KETH_ID, _epochPayload(1, 0, Status.CONSERVED, settled)));
        assertTrue(ledger.isConsumed(settled[0]));
        assertTrue(ledger.isConsumed(settled[1]));
        assertFalse(ledger.isConsumed(keccak256("m3")));

        // Re-settling an id is idempotent and emits no second MessageConsumed.
        bytes32[] memory again = new bytes32[](1);
        again[0] = settled[0];
        vm.recordLogs();
        _deliver(W2_ID, W2_NAME, _envelope(ReportType.EPOCH, KETH_ID, _epochPayload(2, 0, Status.CONSERVED, again)));
        assertEq(vm.getRecordedLogs().length, 1);
    }

    function test_epoch_ignoredWhileContained() public {
        _epoch(1, 0, Status.CONSERVED);
        _breach(EVIDENCE, Reason.DEBIT_NOT_FOUND, attacker, 1 ether);
        uint64 revision = ledger.revisionOf(KETH_ID);

        // BROKEN: ignored, no revert, no events, even with a stale epoch id.
        vm.recordLogs();
        _epoch(1, 0, Status.CONSERVED);
        _epoch(2, 0, Status.CONSERVED);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(uint8(_status()), uint8(Status.BROKEN));

        // QUARANTINED: ignored.
        _quarantineApplied(_incident(EVIDENCE), _one(attacker));
        _epoch(3, 0, Status.CONSERVED);
        assertEq(uint8(_status()), uint8(Status.QUARANTINED));

        // RECOVERING: ignored.
        vm.prank(safe);
        quarantine.resolve(KETH_ID, _incident(EVIDENCE));
        _epoch(4, 0, Status.CONSERVED);
        assertEq(uint8(_status()), uint8(Status.RECOVERING));
        assertEq(ledger.latestEpoch(KETH_ID).epochId, 1);
        assertEq(ledger.revisionOf(KETH_ID), revision + 2);
    }

    // ================================================================
    // BREACH
    // ================================================================

    function test_breach_fromConservedSetsBrokenAndContains() public {
        _epoch(1, 0, Status.CONSERVED);
        bytes32 incidentId = _incident(EVIDENCE);

        vm.expectEmit(address(ledger));
        emit IConservationLedger.IncidentOpened(KETH_ID, incidentId, EVIDENCE);
        vm.expectEmit(address(ledger));
        emit IConservationLedger.BreachRecorded(
            KETH_ID,
            Reason.DEBIT_NOT_FOUND,
            EVIDENCE,
            HOME_SELECTOR,
            keccak256(abi.encode("tx", EVIDENCE)),
            attacker,
            116_500 ether
        );
        vm.expectEmit(address(ledger));
        emit IConservationLedger.StatusChanged(KETH_ID, Status.CONSERVED, Status.BROKEN, Reason.DEBIT_NOT_FOUND);
        vm.expectEmit(address(quarantine));
        emit IQuarantineController.LanesFrozen(KETH_ID, incidentId);
        vm.expectEmit(address(quarantine));
        emit IQuarantineController.Tainted(KETH_ID, attacker, incidentId);
        _breach(EVIDENCE, Reason.DEBIT_NOT_FOUND, attacker, 116_500 ether);

        (Status s, int256 delta,,) = ledger.statusOf(KETH_ID);
        assertEq(uint8(s), uint8(Status.BROKEN));
        assertEq(delta, -116_500 ether);
        assertEq(ledger.activeIncident(KETH_ID), incidentId);
        assertTrue(quarantine.isFrozen(KETH_ID));
        assertTrue(quarantine.isTainted(KETH_ID, attacker));

        Breach memory b = ledger.breachOf(incidentId);
        assertEq(b.tokenId, KETH_ID);
        assertEq(b.evidenceHash, EVIDENCE);
        assertEq(b.reason, Reason.DEBIT_NOT_FOUND);
        assertEq(b.recipient, attacker);
        assertEq(b.amount, 116_500 ether);
        assertEq(b.offendingChain, HOME_SELECTOR);
        assertEq(b.messageId, keccak256(abi.encode("msg", EVIDENCE)));
        assertEq(b.epochId, 7);
        assertEq(b.recordedAt, block.timestamp);
    }

    function test_breach_fromUnknownRegisteredToken() public {
        _breach(EVIDENCE, Reason.LOOP_DEFICIT, address(0), 5);
        assertEq(uint8(_status()), uint8(Status.BROKEN));
        assertTrue(quarantine.isFrozen(KETH_ID));
    }

    function test_breach_fromDrift() public {
        _epoch(1, 0, Status.CONSERVED);
        _epoch(2, 0, Status.DRIFT);
        _breach(EVIDENCE, Reason.DOUBLE_CREDIT, attacker, 1);
        assertEq(uint8(_status()), uint8(Status.BROKEN));
    }

    function test_breach_duplicateEvidenceIsNoop() public {
        _breach(EVIDENCE, Reason.DEBIT_NOT_FOUND, attacker, 1);
        uint64 revision = ledger.revisionOf(KETH_ID);
        vm.recordLogs();
        _breach(EVIDENCE, Reason.DEBIT_NOT_FOUND, attacker, 1);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(ledger.revisionOf(KETH_ID), revision);
    }

    function test_breach_extraEvidenceWhileBrokenKeepsStatusAndIncident() public {
        _breach(EVIDENCE, Reason.DEBIT_NOT_FOUND, attacker, 1);
        address second = makeAddr("second");
        bytes32 ev2 = keccak256("ev2");
        _breach(ev2, Reason.LOOP_DEFICIT, second, 2);
        assertEq(uint8(_status()), uint8(Status.BROKEN));
        assertEq(ledger.activeIncident(KETH_ID), _incident(EVIDENCE));
        assertEq(ledger.breachOf(_incident(ev2)).amount, 2);
        assertTrue(quarantine.isTainted(KETH_ID, second));
    }

    function test_breach_whileQuarantinedKeepsStatus() public {
        _breach(EVIDENCE, Reason.DEBIT_NOT_FOUND, attacker, 1);
        _quarantineApplied(_incident(EVIDENCE), _one(attacker));
        _breach(keccak256("ev2"), Reason.LOOP_DEFICIT, address(0), 2);
        assertEq(uint8(_status()), uint8(Status.QUARANTINED));
        assertEq(ledger.activeIncident(KETH_ID), _incident(EVIDENCE));
    }

    function test_breach_duringRecoveringReBreaks() public {
        _driveToRecovering(EVIDENCE);
        bytes32 ev2 = keccak256("ev2");
        vm.expectEmit(address(ledger));
        emit IConservationLedger.StatusChanged(KETH_ID, Status.RECOVERING, Status.BROKEN, Reason.LOOP_DEFICIT);
        _breach(ev2, Reason.LOOP_DEFICIT, address(0), 2);
        assertEq(uint8(_status()), uint8(Status.BROKEN));
        assertEq(ledger.activeIncident(KETH_ID), _incident(ev2));
        assertEq(ledger.recoveryEndsAt(KETH_ID), 0);
        assertTrue(quarantine.isFrozen(KETH_ID));
    }

    // ================================================================
    // QUARANTINE_APPLIED
    // ================================================================

    function test_quarantine_fromBroken() public {
        _breach(EVIDENCE, Reason.DEBIT_NOT_FOUND, attacker, 1);
        address[] memory tainted = new address[](3);
        tainted[0] = attacker;
        tainted[1] = makeAddr("mule");
        tainted[2] = address(0);
        vm.expectEmit(address(ledger));
        emit IConservationLedger.StatusChanged(KETH_ID, Status.BROKEN, Status.QUARANTINED, Reason.DEBIT_NOT_FOUND);
        vm.expectEmit(address(quarantine));
        emit IQuarantineController.Tainted(KETH_ID, tainted[1], _incident(EVIDENCE));
        _quarantineApplied(_incident(EVIDENCE), tainted);
        assertEq(uint8(_status()), uint8(Status.QUARANTINED));
        assertTrue(quarantine.isTainted(KETH_ID, tainted[1]));
        assertFalse(quarantine.isTainted(KETH_ID, address(0)));
    }

    function test_quarantine_illegalFromNonBroken() public {
        bytes32 incidentId = _incident(EVIDENCE);
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.NotBroken.selector, Status.UNKNOWN));
        _quarantineApplied(incidentId, _one(attacker));

        _epoch(1, 0, Status.CONSERVED);
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.NotBroken.selector, Status.CONSERVED));
        _quarantineApplied(incidentId, _one(attacker));

        _epoch(2, 0, Status.DRIFT);
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.NotBroken.selector, Status.DRIFT));
        _quarantineApplied(incidentId, _one(attacker));

        _breach(EVIDENCE, Reason.DEBIT_NOT_FOUND, attacker, 1);
        _quarantineApplied(incidentId, _one(attacker));
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.NotBroken.selector, Status.QUARANTINED));
        _quarantineApplied(incidentId, _one(attacker));

        vm.prank(safe);
        quarantine.resolve(KETH_ID, incidentId);
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.NotBroken.selector, Status.RECOVERING));
        _quarantineApplied(incidentId, _one(attacker));
    }

    function test_quarantine_rejectsWrongIncident() public {
        _breach(EVIDENCE, Reason.DEBIT_NOT_FOUND, attacker, 1);
        bytes32 wrong = keccak256("wrong");
        vm.expectRevert(
            abi.encodeWithSelector(ConservationLedger.IncidentMismatch.selector, wrong, _incident(EVIDENCE))
        );
        _quarantineApplied(wrong, _one(attacker));
    }

    // ================================================================
    // Recovery (resolve -> RECOVERING -> RECOVERY_CHECK)
    // ================================================================

    function test_beginRecovery_onlyQuarantineController() public {
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.OnlyQuarantineController.selector, safe));
        vm.prank(safe);
        ledger.beginRecovery(KETH_ID, bytes32(0), 0);
    }

    function test_beginRecovery_requiresQuarantined() public {
        _breach(EVIDENCE, Reason.DEBIT_NOT_FOUND, attacker, 1);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.NotQuarantined.selector, Status.BROKEN));
        quarantine.resolve(KETH_ID, _incident(EVIDENCE));
    }

    function test_beginRecovery_rejectsWrongIncident() public {
        _breach(EVIDENCE, Reason.DEBIT_NOT_FOUND, attacker, 1);
        _quarantineApplied(_incident(EVIDENCE), _one(attacker));
        bytes32 wrong = keccak256("wrong");
        vm.prank(safe);
        vm.expectRevert(
            abi.encodeWithSelector(ConservationLedger.IncidentMismatch.selector, wrong, _incident(EVIDENCE))
        );
        quarantine.resolve(KETH_ID, wrong);
    }

    function test_recovery_fullPath() public {
        bytes32 incidentId = _incident(EVIDENCE);
        _breach(EVIDENCE, Reason.DEBIT_NOT_FOUND, attacker, 1);
        _quarantineApplied(incidentId, _one(attacker));

        uint64 endsAt = uint64(block.timestamp) + RECOVERY_TIMELOCK;
        vm.expectEmit(address(quarantine));
        emit IQuarantineController.IncidentResolved(KETH_ID, incidentId, endsAt);
        vm.expectEmit(address(ledger));
        emit IConservationLedger.StatusChanged(KETH_ID, Status.QUARANTINED, Status.RECOVERING, Reason.DEBIT_NOT_FOUND);
        vm.expectEmit(address(ledger));
        emit IConservationLedger.RecoveryStarted(KETH_ID, incidentId, endsAt);
        vm.prank(safe);
        quarantine.resolve(KETH_ID, incidentId);
        assertEq(ledger.recoveryEndsAt(KETH_ID), endsAt);

        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.RecoveryTimelockActive.selector, endsAt));
        _recoveryCheck(1, 0);

        vm.warp(endsAt);
        vm.expectEmit(address(ledger));
        emit IConservationLedger.StatusChanged(KETH_ID, Status.RECOVERING, Status.CONSERVED, 0);
        vm.expectEmit(address(ledger));
        emit IConservationLedger.EpochRecorded(KETH_ID, 1, 0, Status.CONSERVED);
        vm.expectEmit(address(quarantine));
        emit IQuarantineController.LanesUnfrozen(KETH_ID);
        _recoveryCheck(1, 0);

        assertEq(uint8(_status()), uint8(Status.CONSERVED));
        assertFalse(quarantine.isFrozen(KETH_ID));
        assertTrue(quarantine.isTainted(KETH_ID, attacker), "taints persist until the Safe clears them");
        assertEq(ledger.activeIncident(KETH_ID), bytes32(0));
        assertEq(ledger.recoveryEndsAt(KETH_ID), 0);
    }

    function test_recovery_rejectsNegativeDelta() public {
        _driveToRecovering(EVIDENCE);
        vm.warp(block.timestamp + RECOVERY_TIMELOCK);
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.NegativeDelta.selector, -1));
        _recoveryCheck(1, -1);
    }

    function test_recovery_acceptsSurplus() public {
        _driveToRecovering(EVIDENCE);
        vm.warp(block.timestamp + RECOVERY_TIMELOCK);
        _recoveryCheck(1, 10 ether);
        (Status s, int256 delta,,) = ledger.statusOf(KETH_ID);
        assertEq(uint8(s), uint8(Status.CONSERVED));
        assertEq(delta, 10 ether);
    }

    function test_recovery_requiresIncreasingEpoch() public {
        _epoch(9, 0, Status.CONSERVED);
        _driveToRecovering(EVIDENCE);
        vm.warp(block.timestamp + RECOVERY_TIMELOCK);
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.EpochNotIncreasing.selector, 9, 9));
        _recoveryCheck(9, 0);
        _recoveryCheck(10, 0);
    }

    function test_recovery_illegalFromEveryOtherStatus() public {
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.NotRecovering.selector, Status.UNKNOWN));
        _recoveryCheck(1, 0);
        _epoch(1, 0, Status.CONSERVED);
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.NotRecovering.selector, Status.CONSERVED));
        _recoveryCheck(2, 0);
        _epoch(2, 0, Status.DRIFT);
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.NotRecovering.selector, Status.DRIFT));
        _recoveryCheck(3, 0);
        _breach(EVIDENCE, Reason.DEBIT_NOT_FOUND, attacker, 1);
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.NotRecovering.selector, Status.BROKEN));
        _recoveryCheck(3, 0);
        _quarantineApplied(_incident(EVIDENCE), _one(attacker));
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.NotRecovering.selector, Status.QUARANTINED));
        _recoveryCheck(3, 0);
    }

    function test_recovery_staleRecoveryCheckCannotClearLaterIncident() public {
        // Incident 1: a RECOVERY_CHECK for epoch 5 fails (timelock active). Anyone may retry it later on the
        // production forwarder, so it must not be usable after W2 has moved on.
        _epoch(1, 0, Status.CONSERVED);
        _driveToRecovering(EVIDENCE);
        uint64 endsAt = ledger.recoveryEndsAt(KETH_ID);
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.RecoveryTimelockActive.selector, endsAt));
        _recoveryCheck(5, 0);

        // W2 keeps reporting during containment; those epochs are ignored but advance the high-water mark.
        _epoch(6, 0, Status.CONSERVED);
        vm.warp(block.timestamp + RECOVERY_TIMELOCK);
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.EpochNotIncreasing.selector, 5, 6));
        _recoveryCheck(5, 0);
        _recoveryCheck(7, 0);
        assertEq(uint8(_status()), uint8(Status.CONSERVED));
    }

    function test_creReportAloneCanNeverClearBroken() public {
        _breach(EVIDENCE, Reason.DEBIT_NOT_FOUND, attacker, 1);
        // No report type moves BROKEN to anything but QUARANTINED.
        _epoch(100, 0, Status.CONSERVED);
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.NotRecovering.selector, Status.BROKEN));
        _recoveryCheck(101, 0);
        assertEq(uint8(_status()), uint8(Status.BROKEN));
    }

    // ================================================================
    // Staleness
    // ================================================================

    function test_staleness() public {
        (,,, bool stale) = ledger.statusOf(KETH_ID);
        assertTrue(stale, "never written");
        _epoch(1, 0, Status.CONSERVED);
        vm.warp(block.timestamp + STALENESS);
        (,,, stale) = ledger.statusOf(KETH_ID);
        assertFalse(stale, "exactly at the window");
        vm.warp(block.timestamp + 1);
        (,,, stale) = ledger.statusOf(KETH_ID);
        assertTrue(stale);
    }

    function test_staleness_unregisteredIsStale() public view {
        (Status s,,, bool stale) = ledger.statusOf(keccak256("nope"));
        assertEq(uint8(s), uint8(Status.UNKNOWN));
        assertTrue(stale);
    }
}
