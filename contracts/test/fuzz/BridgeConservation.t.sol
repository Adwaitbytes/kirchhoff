// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBurnMintERC20} from "@chainlink/contracts-ccip/contracts/interfaces/IBurnMintERC20.sol";

import {KirchhoffGuard} from "../../src/KirchhoffGuard.sol";
import {HomeEscrowAdapter} from "../../src/demo/HomeEscrowAdapter.sol";
import {KETH} from "../../src/demo/KETH.sol";
import {RemoteKETH} from "../../src/demo/RemoteKETH.sol";
import {WeakBridge} from "../../src/demo/WeakBridge.sol";
import {Reason, Status} from "../../src/interfaces/KirchhoffTypes.sol";

import {KirchhoffTestBase} from "../utils/KirchhoffTestBase.sol";

/// @notice PRD section 7 fuzz requirement: random sequences of debits, credits and forged credits through the real
/// demo bridge contracts, with a reference Junction + Loop evaluator writing the resulting reports to the real ledger.
/// Every forged credit must be flagged (one BREACH per forgery, token BROKEN) and a valid sequence must never be.
contract BridgeConservationFuzzTest is KirchhoffTestBase {
    uint256 internal constant VERIFIER_KEY = 0x5EED;
    uint64 internal constant DST_REMOTE = ARB_SELECTOR;

    struct Debit {
        bytes32 id;
        address to;
        uint256 amount;
        bool toRemote; // true: home lock -> remote mint; false: remote burn -> home release
        bool settled;
    }

    KETH internal keth;
    HomeEscrowAdapter internal escrow;
    WeakBridge internal homeBridge;
    RemoteKETH internal remote;
    WeakBridge internal remoteBridge;
    address internal user = makeAddr("user");

    Debit[] internal debits;
    mapping(bytes32 id => uint256 indexPlusOne) internal debitIndex;
    uint256 internal inFlight;
    uint256 internal forgeries;
    uint256 internal junctionBreaches;
    uint64 internal epochId;
    bytes32[] internal forgedEvidence;

    function setUp() public {
        _deployCore(HOME_SELECTOR);
        keth = new KETH(new KirchhoffGuard(quarantine, KETH_ID), admin);
        escrow = new HomeEscrowAdapter(keth, admin);
        address verifier = vm.addr(VERIFIER_KEY);
        homeBridge = new WeakBridge(verifier, IBurnMintERC20(address(0)), escrow);
        remote = new RemoteKETH(admin);
        remoteBridge = new WeakBridge(verifier, remote, HomeEscrowAdapter(address(0)));
        vm.startPrank(admin);
        escrow.setBridge(address(homeBridge));
        remote.grantMintAndBurnRoles(address(remoteBridge));
        keth.mint(user, 1_000_000 ether);
        vm.stopPrank();
        vm.startPrank(user);
        keth.approve(address(escrow), type(uint256).max);
        remote.approve(address(remoteBridge), type(uint256).max);
        vm.stopPrank();
    }

    // ================================================================
    // Reference evaluator (mirrors the engine's Junction and Loop rules)
    // ================================================================

    /// @dev Junction Rule: a credit must match an unsettled debit on the opposite side with the same id, amount and
    /// recipient. Returns the reason code, OK when it matches.
    function _junction(bytes32 id, address to, uint256 amount, bool creditOnRemote) internal view returns (uint16) {
        uint256 idx = debitIndex[id];
        if (idx == 0) return Reason.DEBIT_NOT_FOUND;
        Debit storage d = debits[idx - 1];
        if (d.toRemote != creditOnRemote) return Reason.DEBIT_NOT_FOUND;
        if (d.settled) return Reason.DOUBLE_CREDIT;
        if (d.amount != amount) return Reason.AMOUNT_MISMATCH;
        if (d.to != to) return Reason.RECIPIENT_MISMATCH;
        return Reason.OK;
    }

    /// @dev Loop Rule for lock-release-home: escrow must cover remote supply plus everything in flight.
    function _delta() internal view returns (int256) {
        return int256(keth.balanceOf(address(escrow))) - int256(remote.totalSupply()) - int256(inFlight);
    }

    function _reportEpochOrDeficit() internal {
        int256 delta = _delta();
        if (delta < 0) {
            _breach(keccak256(abi.encode("loop", epochId, delta)), Reason.LOOP_DEFICIT, address(0), uint256(-delta));
        } else {
            _epoch(++epochId, delta, Status.CONSERVED);
        }
    }

    function _credit(bytes32 id, address to, uint256 amount, bool onRemote, bool forged) internal {
        WeakBridge bridge = onRemote ? remoteBridge : homeBridge;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(VERIFIER_KEY, bridge.creditDigest(id, to, amount, onRemote ? HOME_SELECTOR : DST_REMOTE));
        bridge.credit(id, to, amount, onRemote ? HOME_SELECTOR : DST_REMOTE, abi.encodePacked(r, s, v));

        uint16 reason = _junction(id, to, amount, onRemote);
        if (reason != Reason.OK) {
            bytes32 evidence = keccak256(abi.encode("junction", id));
            _breach(evidence, reason, to, amount);
            forgedEvidence.push(evidence);
            ++junctionBreaches;
        } else {
            Debit storage d = debits[debitIndex[id] - 1];
            d.settled = true;
            inFlight -= amount;
        }
        if (forged) ++forgeries;
    }

    // ================================================================
    // Operations
    // ================================================================

    function _sendHomeToRemote(uint256 amount) internal {
        vm.prank(user);
        bytes32 id = homeBridge.send(user, amount, DST_REMOTE);
        debits.push(Debit(id, user, amount, true, false));
        debitIndex[id] = debits.length;
        inFlight += amount;
    }

    function _sendRemoteToHome(uint256 amount) internal returns (bool sent) {
        if (remote.balanceOf(user) < amount) return false;
        vm.prank(user);
        bytes32 id = remoteBridge.send(user, amount, HOME_SELECTOR);
        debits.push(Debit(id, user, amount, false, false));
        debitIndex[id] = debits.length;
        inFlight += amount;
        return true;
    }

    function _settleOne(uint256 pick) internal {
        uint256 n = debits.length;
        for (uint256 k = 0; k < n; ++k) {
            Debit storage d = debits[(pick + k) % n];
            // A forged release can drain the escrow below a real in-flight debit; that release then cannot happen.
            bool releasable = d.toRemote || keth.balanceOf(address(escrow)) >= d.amount;
            if (!d.settled && releasable) {
                _credit(d.id, d.to, d.amount, d.toRemote, false);
                return;
            }
        }
    }

    function _run(uint256 seed, uint256 steps, bool allowForgery) internal {
        _epoch(++epochId, 0, Status.CONSERVED);
        for (uint256 i = 0; i < steps; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 amount = 1 + (r >> 8) % 1000 ether;
            uint256 op = r % (allowForgery ? 6 : 4);
            if (op == 0) {
                _sendHomeToRemote(amount);
            } else if (op == 1) {
                _sendRemoteToHome(amount);
            } else if (op == 2 || op == 3) {
                _settleOne(r >> 128);
            } else if (op == 4 && keth.balanceOf(address(escrow)) >= amount) {
                _credit(keccak256(abi.encode("forged-home", seed, i)), attacker, amount, false, true);
            } else if (op == 5) {
                _credit(keccak256(abi.encode("forged-remote", seed, i)), attacker, amount, true, true);
            }
            _reportEpochOrDeficit();
        }
    }

    // ================================================================
    // Properties
    // ================================================================

    function testFuzz_validSequencesNeverFlagged(uint256 seed, uint8 steps) public {
        _run(seed, bound(steps, 1, 40), false);
        assertEq(forgeries, 0);
        assertEq(junctionBreaches, 0, "a valid credit was flagged");
        (Status s, int256 delta,,) = ledger.statusOf(KETH_ID);
        assertEq(uint8(s), uint8(Status.CONSERVED), "valid traffic must stay CONSERVED");
        assertEq(delta, 0, "valid lock-release traffic conserves exactly");
        assertFalse(quarantine.isFrozen(KETH_ID));
    }

    function testFuzz_everyForgeryFlagged(uint256 seed, uint8 steps) public {
        _run(seed, bound(steps, 1, 40), true);
        assertEq(junctionBreaches, forgeries, "every forgery, and only forgeries, are Junction breaches");
        for (uint256 i = 0; i < forgedEvidence.length; ++i) {
            assertEq(
                ledger.breachOf(_incident(forgedEvidence[i])).recipient, attacker, "each forgery has its own evidence"
            );
        }
        (Status s,,,) = ledger.statusOf(KETH_ID);
        if (forgeries == 0) {
            assertEq(uint8(s), uint8(Status.CONSERVED));
        } else {
            assertEq(uint8(s), uint8(Status.BROKEN), "any forgery breaks the token");
            assertTrue(quarantine.isFrozen(KETH_ID));
            assertTrue(quarantine.isTainted(KETH_ID, attacker));
            assertLt(_delta(), 0, "the Loop Rule independently sees the deficit");
        }
    }

    /// @dev Scenario 3 (Kelp Replay) with fuzzed size: the very first forged release is flagged DEBIT_NOT_FOUND.
    function testFuzz_kelpReplayFirstForgeryBreaks(uint96 locked, uint96 stolen) public {
        uint256 lockedAmount = bound(locked, 1, 1_000_000 ether);
        uint256 stolenAmount = bound(stolen, 1, lockedAmount);
        _epoch(++epochId, 0, Status.CONSERVED);
        _sendHomeToRemote(lockedAmount);
        _settleOne(0);
        _reportEpochOrDeficit();
        _credit(keccak256("kelp"), attacker, stolenAmount, false, true);
        assertEq(uint8(_status()), uint8(Status.BROKEN));
        assertEq(
            ledger.breachOf(_incident(keccak256(abi.encode("junction", keccak256("kelp"))))).reason,
            Reason.DEBIT_NOT_FOUND
        );
        _reportEpochOrDeficit();
        assertEq(_delta(), -int256(stolenAmount));
        // The attacker cannot move the stolen kETH onward on the home chain.
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffGuard.SenderTainted.selector, attacker));
        keth.transfer(user, 1);
    }

    /// @dev Scenario 5: a compromised minter key mints with no message. The Junction Rule sees nothing; the Loop Rule
    /// catches the deficit in the next epoch.
    function testFuzz_compromisedMinterCaughtByLoopRule(uint96 bridged, uint96 minted) public {
        uint256 bridgedAmount = bound(bridged, 1, 1_000_000 ether);
        uint256 mintedAmount = bound(minted, 1, type(uint96).max);
        _epoch(++epochId, 0, Status.CONSERVED);
        _sendHomeToRemote(bridgedAmount);
        _settleOne(0);
        _reportEpochOrDeficit();
        assertEq(uint8(_status()), uint8(Status.CONSERVED));

        vm.prank(admin);
        remote.grantMintRole(attacker);
        vm.prank(attacker);
        remote.mint(attacker, mintedAmount);
        _reportEpochOrDeficit();

        assertEq(junctionBreaches, 0);
        assertEq(uint8(_status()), uint8(Status.BROKEN));
        assertEq(ledger.breachOf(ledger.activeIncident(KETH_ID)).reason, Reason.LOOP_DEFICIT);
        assertEq(ledger.breachOf(ledger.activeIncident(KETH_ID)).amount, mintedAmount);
    }

    /// @dev Scenario 4: one real burn credited twice (through a second minting bridge) is a DOUBLE_CREDIT.
    function testFuzz_doubleCreditFlagged(uint96 amount) public {
        uint256 value = bound(amount, 1, 1_000_000 ether);
        _epoch(++epochId, 0, Status.CONSERVED);
        _sendHomeToRemote(value);
        bytes32 id = debits[0].id;
        _settleOne(0);

        WeakBridge second = new WeakBridge(vm.addr(VERIFIER_KEY), remote, HomeEscrowAdapter(address(0)));
        vm.prank(admin);
        remote.grantMintRole(address(second));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(VERIFIER_KEY, second.creditDigest(id, user, value, HOME_SELECTOR));
        second.credit(id, user, value, HOME_SELECTOR, abi.encodePacked(r, s, v));

        uint16 reason = _junction(id, user, value, true);
        assertEq(reason, Reason.DOUBLE_CREDIT);
        _breach(keccak256(abi.encode("junction-double", id)), reason, user, value);
        assertEq(uint8(_status()), uint8(Status.BROKEN));
        _reportEpochOrDeficit();
        assertEq(_delta(), -int256(value));
    }

    /// @dev Scenario 6: a donation to the escrow raises Δ and the token stays CONSERVED.
    function testFuzz_donationIsSurplus(uint96 donation) public {
        uint256 value = bound(donation, 1, 1_000_000 ether);
        _epoch(++epochId, 0, Status.CONSERVED);
        vm.prank(user);
        keth.transfer(address(escrow), value);
        _reportEpochOrDeficit();
        (Status st, int256 delta,,) = ledger.statusOf(KETH_ID);
        assertEq(uint8(st), uint8(Status.CONSERVED));
        assertEq(delta, int256(value));
    }
}
