// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {QuarantineController} from "../src/QuarantineController.sol";
import {IConservationLedger} from "../src/interfaces/IConservationLedger.sol";
import {IQuarantineController} from "../src/interfaces/IQuarantineController.sol";
import {Reason} from "../src/interfaces/KirchhoffTypes.sol";

import {KirchhoffTestBase} from "./utils/KirchhoffTestBase.sol";

contract QuarantineControllerTest is KirchhoffTestBase {
    bytes32 internal constant EVIDENCE = keccak256("ev");

    function setUp() public {
        _deployCore(HOME_SELECTOR);
    }

    function test_constructor_rejectsZeroLedger() public {
        vm.expectRevert(QuarantineController.ZeroAddress.selector);
        new QuarantineController(IConservationLedger(address(0)), admin);
    }

    function test_configureToken() public view {
        assertEq(quarantine.issuerOf(KETH_ID), safe);
        assertEq(quarantine.recoveryTimelockOf(KETH_ID), RECOVERY_TIMELOCK);
    }

    function test_configureToken_oneShotAndValidated() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(QuarantineController.TokenAlreadyConfigured.selector, KETH_ID));
        quarantine.configureToken(KETH_ID, admin, 1);
        vm.expectRevert(QuarantineController.ZeroAddress.selector);
        quarantine.configureToken(keccak256("x"), address(0), 1);
        vm.expectRevert(QuarantineController.InvalidRecoveryTimelock.selector);
        quarantine.configureToken(keccak256("x"), safe, 0);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        quarantine.configureToken(keccak256("y"), attacker, 1);
    }

    function test_ledgerHooks_onlyLedger() public {
        bytes memory err = abi.encodeWithSelector(QuarantineController.OnlyLedger.selector, admin);
        vm.startPrank(admin);
        vm.expectRevert(err);
        quarantine.onBreach(KETH_ID, bytes32(0), attacker);
        vm.expectRevert(err);
        quarantine.onQuarantineApplied(KETH_ID, bytes32(0), _one(attacker));
        vm.expectRevert(err);
        quarantine.onRecovered(KETH_ID);
        vm.stopPrank();
    }

    function test_onBreach_withoutRecipientOnlyFreezes() public {
        vm.recordLogs();
        vm.prank(address(ledger));
        quarantine.onBreach(KETH_ID, keccak256("i"), address(0));
        assertTrue(quarantine.isFrozen(KETH_ID));
        assertEq(vm.getRecordedLogs().length, 1);
    }

    function test_taint_isIdempotent() public {
        vm.startPrank(address(ledger));
        quarantine.onBreach(KETH_ID, keccak256("i"), attacker);
        vm.recordLogs();
        quarantine.onQuarantineApplied(KETH_ID, keccak256("i"), _one(attacker));
        vm.stopPrank();
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_resolve_onlyIssuer() public {
        _breach(EVIDENCE, Reason.DEBIT_NOT_FOUND, attacker, 1);
        _quarantineApplied(_incident(EVIDENCE), _one(attacker));
        bytes32 incidentId = _incident(EVIDENCE);

        vm.prank(admin); // the operator cannot resolve
        vm.expectRevert(abi.encodeWithSelector(QuarantineController.OnlyIssuer.selector, admin));
        quarantine.resolve(KETH_ID, incidentId);

        vm.prank(address(ledger));
        vm.expectRevert(abi.encodeWithSelector(QuarantineController.OnlyIssuer.selector, address(ledger)));
        quarantine.resolve(KETH_ID, incidentId);

        bytes32 unknown = keccak256("unknownToken");
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(QuarantineController.TokenNotConfigured.selector, unknown));
        quarantine.resolve(unknown, incidentId);
    }

    function test_untaint_onlyIssuerAndIdempotent() public {
        _breach(EVIDENCE, Reason.DEBIT_NOT_FOUND, attacker, 1);
        address[] memory accounts = new address[](2);
        accounts[0] = attacker;
        accounts[1] = makeAddr("neverTainted");

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(QuarantineController.OnlyIssuer.selector, attacker));
        quarantine.untaint(KETH_ID, accounts);

        vm.expectEmit(address(quarantine));
        emit IQuarantineController.Untainted(KETH_ID, attacker);
        vm.recordLogs();
        vm.prank(safe);
        quarantine.untaint(KETH_ID, accounts);
        assertEq(vm.getRecordedLogs().length, 1);
        assertFalse(quarantine.isTainted(KETH_ID, attacker));
    }

    function test_setIssuerSafe() public {
        address next = makeAddr("nextSafe");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(QuarantineController.OnlyIssuer.selector, admin));
        quarantine.setIssuerSafe(KETH_ID, next);

        vm.prank(safe);
        vm.expectRevert(QuarantineController.ZeroAddress.selector);
        quarantine.setIssuerSafe(KETH_ID, address(0));

        vm.expectEmit(address(quarantine));
        emit IQuarantineController.IssuerSafeChanged(KETH_ID, safe, next);
        vm.prank(safe);
        quarantine.setIssuerSafe(KETH_ID, next);
        assertEq(quarantine.issuerOf(KETH_ID), next);
    }

    function test_setRecoveryTimelock() public {
        vm.prank(safe);
        vm.expectRevert(QuarantineController.InvalidRecoveryTimelock.selector);
        quarantine.setRecoveryTimelock(KETH_ID, 0);

        vm.expectEmit(address(quarantine));
        emit IQuarantineController.RecoveryTimelockChanged(KETH_ID, 60);
        vm.prank(safe);
        quarantine.setRecoveryTimelock(KETH_ID, 60);
        assertEq(quarantine.recoveryTimelockOf(KETH_ID), 60);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(QuarantineController.OnlyIssuer.selector, admin));
        quarantine.setRecoveryTimelock(KETH_ID, 1);
    }
}
