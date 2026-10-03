// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ConservationFeed} from "../src/ConservationFeed.sol";
import {KirchhoffGuard} from "../src/KirchhoffGuard.sol";
import {KirchhoffProtected} from "../src/KirchhoffProtected.sol";
import {DemoLendingMarket, DemoUSD} from "../src/demo/DemoLendingMarket.sol";
import {KETH} from "../src/demo/KETH.sol";
import {IKirchhoffGuard} from "../src/interfaces/IKirchhoffGuard.sol";
import {IQuarantineController} from "../src/interfaces/IQuarantineController.sol";
import {Reason, Status} from "../src/interfaces/KirchhoffTypes.sol";

import {KirchhoffTestBase} from "./utils/KirchhoffTestBase.sol";

contract GuardAndLendingTest is KirchhoffTestBase {
    KirchhoffGuard internal guard;
    KETH internal keth;
    ConservationFeed internal feed;
    DemoLendingMarket internal market;
    address internal alice = makeAddr("alice");

    function setUp() public {
        _deployCore(HOME_SELECTOR);
        guard = new KirchhoffGuard(quarantine, KETH_ID);
        keth = new KETH(guard, admin);
        feed = new ConservationFeed(ledger, KETH_ID, "kETH");
        market = new DemoLendingMarket(keth, address(feed));
        vm.startPrank(admin);
        keth.mint(alice, 100 ether);
        keth.mint(attacker, 100 ether);
        vm.stopPrank();
        vm.prank(alice);
        keth.approve(address(market), type(uint256).max);
    }

    // ---------------- Guard / kETH ----------------

    function test_guard_constructorRejectsZero() public {
        vm.expectRevert(KirchhoffGuard.ZeroAddress.selector);
        new KirchhoffGuard(IQuarantineController(address(0)), KETH_ID);
        vm.expectRevert(KETH.ZeroAddress.selector);
        new KETH(IKirchhoffGuard(address(0)), admin);
    }

    function test_keth_metadata() public view {
        assertEq(keth.decimals(), 18);
        assertEq(keth.symbol(), "kETH");
        assertEq(address(keth.guard()), address(guard));
    }

    function test_keth_mintOnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        keth.mint(alice, 1);
    }

    function test_guard_blocksTaintedSender() public {
        _breach(keccak256("ev"), Reason.DEBIT_NOT_FOUND, attacker, 1);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffGuard.SenderTainted.selector, attacker));
        keth.transfer(alice, 1 ether);

        // Transfers to a tainted address and between clean accounts still work.
        vm.prank(alice);
        keth.transfer(attacker, 1 ether);
        assertEq(keth.balanceOf(attacker), 101 ether);

        // transferFrom by a spender is also blocked when the owner is tainted.
        vm.prank(attacker);
        keth.approve(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffGuard.SenderTainted.selector, attacker));
        keth.transferFrom(attacker, alice, 1 ether);
    }

    function test_guard_untaintRestoresTransfers() public {
        _breach(keccak256("ev"), Reason.DEBIT_NOT_FOUND, attacker, 1);
        vm.prank(safe);
        quarantine.untaint(KETH_ID, _one(attacker));
        vm.prank(attacker);
        keth.transfer(alice, 1 ether);
    }

    function test_guard_neverBlocksMint() public view {
        guard.check(address(0), attacker, 1);
    }

    // ---------------- DemoLendingMarket ----------------

    function test_lending_borrowWhenConserved() public {
        _epoch(1, 0, Status.CONSERVED);
        vm.startPrank(alice);
        market.deposit(10 ether);
        market.borrow(10_000 ether); // 10 kETH * 2000 * 50%
        vm.stopPrank();
        DemoUSD dusd = market.stable();
        assertEq(dusd.balanceOf(alice), 10_000 ether);
        assertEq(market.debtOf(alice), 10_000 ether);
    }

    function test_lending_borrowWhenDrift() public {
        _epoch(1, 0, Status.CONSERVED);
        _epoch(2, 0, Status.DRIFT);
        vm.startPrank(alice);
        market.deposit(1 ether);
        market.borrow(1 ether);
        vm.stopPrank();
    }

    function test_lending_borrowRevertsCollateralBroken() public {
        _epoch(1, 0, Status.CONSERVED);
        vm.prank(alice);
        market.deposit(10 ether);
        _breach(keccak256("ev"), Reason.DEBIT_NOT_FOUND, attacker, 1);
        vm.prank(alice);
        vm.expectRevert(DemoLendingMarket.CollateralBroken.selector);
        market.borrow(1 ether);

        _quarantineApplied(_incident(keccak256("ev")), _one(attacker));
        vm.prank(alice);
        vm.expectRevert(DemoLendingMarket.CollateralBroken.selector);
        market.borrow(1 ether);

        vm.prank(safe);
        quarantine.resolve(KETH_ID, _incident(keccak256("ev")));
        vm.prank(alice);
        vm.expectRevert(DemoLendingMarket.CollateralBroken.selector);
        market.borrow(1 ether);
    }

    function test_lending_borrowRevertsStale() public {
        _epoch(1, 0, Status.CONSERVED);
        vm.prank(alice);
        market.deposit(10 ether);
        uint256 age = market.MAX_AGE() + 1;
        vm.warp(block.timestamp + age);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffProtected.CollateralStatusStale.selector, age));
        market.borrow(1 ether);
    }

    function test_lending_borrowRevertsUnknown() public {
        vm.prank(alice);
        market.deposit(10 ether);
        // Fresh in KirchhoffProtected's 300s window but past the ledger's 120s staleness: feed answers UNKNOWN.
        _epoch(1, 0, Status.CONSERVED);
        vm.warp(block.timestamp + STALENESS + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffProtected.CollateralNotConserved.selector, int256(0)));
        market.borrow(1 ether);
    }

    function test_lending_healthChecks() public {
        _epoch(1, 0, Status.CONSERVED);
        vm.startPrank(alice);
        market.deposit(1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(DemoLendingMarket.InsufficientCollateral.selector, 1000 ether, 1001 ether)
        );
        market.borrow(1001 ether);
        market.borrow(1000 ether);
        vm.expectRevert(
            abi.encodeWithSelector(DemoLendingMarket.InsufficientCollateral.selector, 500 ether, 1000 ether)
        );
        market.withdraw(0.5 ether);
        vm.expectRevert(abi.encodeWithSelector(DemoLendingMarket.RepayExceedsDebt.selector, 1000 ether, 1001 ether));
        market.repay(1001 ether);
        market.repay(1000 ether);
        market.withdraw(1 ether);
        vm.stopPrank();
        assertEq(keth.balanceOf(alice), 100 ether);
        assertEq(market.collateralOf(alice), 0);
    }

    function test_lending_zeroAmounts() public {
        vm.startPrank(alice);
        vm.expectRevert(DemoLendingMarket.ZeroAmount.selector);
        market.deposit(0);
        vm.expectRevert(DemoLendingMarket.ZeroAmount.selector);
        market.withdraw(0);
        vm.expectRevert(DemoLendingMarket.ZeroAmount.selector);
        market.borrow(0);
        vm.expectRevert(DemoLendingMarket.ZeroAmount.selector);
        market.repay(0);
        vm.stopPrank();
    }

    function test_lending_taintedCannotDeposit() public {
        _breach(keccak256("ev"), Reason.DEBIT_NOT_FOUND, attacker, 1);
        vm.startPrank(attacker);
        keth.approve(address(market), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffGuard.SenderTainted.selector, attacker));
        market.deposit(1 ether);
        vm.stopPrank();
    }

    function test_demoUSD_onlyMarket() public {
        DemoUSD dusd = market.stable();
        vm.expectRevert(abi.encodeWithSelector(DemoUSD.OnlyMarket.selector, address(this)));
        dusd.mint(address(this), 1);
        vm.expectRevert(abi.encodeWithSelector(DemoUSD.OnlyMarket.selector, address(this)));
        dusd.burn(address(this), 1);
    }
}
