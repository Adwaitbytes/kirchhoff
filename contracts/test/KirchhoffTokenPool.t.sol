// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Pool} from "@chainlink/contracts-ccip/contracts/libraries/Pool.sol";
import {RateLimiter} from "@chainlink/contracts-ccip/contracts/libraries/RateLimiter.sol";
import {ERC20LockBox} from "@chainlink/contracts-ccip/contracts/pools/ERC20LockBox.sol";
import {TokenPool} from "@chainlink/contracts-ccip/contracts/pools/TokenPool.sol";
import {AuthorizedCallers} from "@chainlink/contracts/src/v0.8/shared/access/AuthorizedCallers.sol";

import {KirchhoffBurnMintTokenPool} from "../src/KirchhoffBurnMintTokenPool.sol";
import {KirchhoffGuard} from "../src/KirchhoffGuard.sol";
import {KirchhoffLockReleaseTokenPool} from "../src/KirchhoffLockReleaseTokenPool.sol";
import {KirchhoffTokenPool} from "../src/KirchhoffTokenPool.sol";
import {KETH} from "../src/demo/KETH.sol";
import {LocalRMNMock, LocalRouterMock} from "../src/demo/LocalCCIPMocks.sol";
import {RemoteKETH} from "../src/demo/RemoteKETH.sol";
import {IConservationLedger} from "../src/interfaces/IConservationLedger.sol";
import {IQuarantineController} from "../src/interfaces/IQuarantineController.sol";
import {Reason, Status} from "../src/interfaces/KirchhoffTypes.sol";

import {KirchhoffTestBase} from "./utils/KirchhoffTestBase.sol";

/// @notice Fallback B: the upstream CCIP 2.0.0 pools wrapped with KIRCHHOFF checks, driven through the real pool entry
/// points with router/RMN stand-ins. Covers the remote BurnMint pool and the home LockRelease pool.
contract KirchhoffTokenPoolTest is KirchhoffTestBase {
    address internal onRamp = makeAddr("onRamp");
    address internal offRamp = makeAddr("offRamp");
    address internal alice = makeAddr("alice");
    address internal remotePoolAddr = makeAddr("homePool");
    address internal remoteTokenAddr = makeAddr("homeToken");

    LocalRouterMock internal router;
    LocalRMNMock internal rmn;
    RemoteKETH internal remote;
    KirchhoffBurnMintTokenPool internal pool;

    function setUp() public {
        _deployCore(ARB_SELECTOR);
        router = new LocalRouterMock(address(this));
        rmn = new LocalRMNMock(address(this));
        remote = new RemoteKETH(admin);
        pool = new KirchhoffBurnMintTokenPool(
            remote, 18, address(0), address(rmn), address(router), ledger, quarantine, KETH_ID
        );
        vm.prank(admin);
        remote.grantMintAndBurnRoles(address(pool));
        _addChain(pool, HOME_SELECTOR);
        router.setOnRamp(HOME_SELECTOR, onRamp);
        router.setOffRamp(HOME_SELECTOR, offRamp, true);
        _epoch(1, 0, Status.CONSERVED);
    }

    function _addChain(TokenPool p, uint64 selector) internal {
        TokenPool.ChainUpdate[] memory updates = new TokenPool.ChainUpdate[](1);
        bytes[] memory pools = new bytes[](1);
        pools[0] = abi.encode(remotePoolAddr);
        RateLimiter.Config memory off = RateLimiter.Config(false, 0, 0);
        updates[0] = TokenPool.ChainUpdate(selector, pools, abi.encode(remoteTokenAddr), off, off);
        p.applyChainUpdates(new uint64[](0), updates);
    }

    function _lockIn(address token, address sender, address receiver, uint256 amount)
        internal
        pure
        returns (Pool.LockOrBurnInV1 memory)
    {
        return Pool.LockOrBurnInV1({
            receiver: abi.encode(receiver),
            remoteChainSelector: HOME_SELECTOR,
            originalSender: sender,
            amount: amount,
            localToken: token
        });
    }

    function _releaseIn(address token, address sender, address receiver, uint256 amount)
        internal
        view
        returns (Pool.ReleaseOrMintInV1 memory)
    {
        return Pool.ReleaseOrMintInV1({
            originalSender: abi.encode(sender),
            remoteChainSelector: HOME_SELECTOR,
            receiver: receiver,
            sourceDenominatedAmount: amount,
            localToken: token,
            sourcePoolAddress: abi.encode(remotePoolAddr),
            sourcePoolData: abi.encode(uint256(18)),
            offchainTokenData: ""
        });
    }

    function _fundPool(uint256 amount) internal {
        vm.prank(address(pool));
        remote.mint(address(pool), amount);
    }

    // ================================================================
    // Happy paths (all four entry points)
    // ================================================================

    function test_burnMint_lockOrBurnV1AndV2() public {
        _fundPool(3 ether);
        vm.startPrank(onRamp);
        pool.lockOrBurn(_lockIn(address(remote), alice, alice, 1 ether));
        (, uint256 destAmount) = pool.lockOrBurn(_lockIn(address(remote), alice, alice, 2 ether), bytes4(0), "");
        vm.stopPrank();
        assertEq(destAmount, 2 ether);
        assertEq(remote.totalSupply(), 0);
    }

    function test_burnMint_releaseOrMintV1AndV2() public {
        vm.startPrank(offRamp);
        pool.releaseOrMint(_releaseIn(address(remote), alice, alice, 1 ether));
        Pool.ReleaseOrMintOutV1 memory out =
            pool.releaseOrMint(_releaseIn(address(remote), alice, alice, 2 ether), bytes4(0));
        vm.stopPrank();
        assertEq(out.destinationAmount, 2 ether);
        assertEq(remote.balanceOf(alice), 3 ether);
    }

    function test_driftStillFlows() public {
        _epoch(2, 0, Status.DRIFT);
        vm.prank(offRamp);
        pool.releaseOrMint(_releaseIn(address(remote), alice, alice, 1 ether));
    }

    function test_typeAndVersion() public view {
        assertEq(pool.typeAndVersion(), "KirchhoffBurnMintTokenPool 1.0.0 (BurnMintTokenPool 2.0.0)");
        assertEq(address(pool.kirchhoffLedger()), address(ledger));
        assertEq(address(pool.kirchhoffQuarantine()), address(quarantine));
        assertEq(pool.kirchhoffTokenId(), KETH_ID);
    }

    // ================================================================
    // Fallback B revert paths
    // ================================================================

    function test_revertsWhenBroken_everyEntryPoint() public {
        _fundPool(1 ether);
        _breach(keccak256("ev"), Reason.DEBIT_NOT_FOUND, attacker, 1);
        bytes memory err = abi.encodeWithSelector(KirchhoffTokenPool.TokenNotConserved.selector, KETH_ID, Status.BROKEN);

        vm.startPrank(onRamp);
        vm.expectRevert(err);
        pool.lockOrBurn(_lockIn(address(remote), alice, alice, 1 ether));
        vm.expectRevert(err);
        pool.lockOrBurn(_lockIn(address(remote), alice, alice, 1 ether), bytes4(0), "");
        vm.stopPrank();

        vm.startPrank(offRamp);
        vm.expectRevert(err);
        pool.releaseOrMint(_releaseIn(address(remote), alice, alice, 1 ether));
        vm.expectRevert(err);
        pool.releaseOrMint(_releaseIn(address(remote), alice, alice, 1 ether), bytes4(0));
        vm.stopPrank();
    }

    function test_revertsWhenQuarantinedAndRecovering() public {
        bytes32 incidentId = _incident(keccak256("ev"));
        _breach(keccak256("ev"), Reason.DEBIT_NOT_FOUND, attacker, 1);
        _quarantineApplied(incidentId, _one(attacker));
        vm.prank(offRamp);
        vm.expectRevert(
            abi.encodeWithSelector(KirchhoffTokenPool.TokenNotConserved.selector, KETH_ID, Status.QUARANTINED)
        );
        pool.releaseOrMint(_releaseIn(address(remote), alice, alice, 1 ether));

        vm.prank(safe);
        quarantine.resolve(KETH_ID, incidentId);
        vm.warp(block.timestamp + RECOVERY_TIMELOCK); // timelock over, but no RECOVERY_CHECK yet
        vm.prank(offRamp);
        vm.expectRevert(
            abi.encodeWithSelector(KirchhoffTokenPool.TokenNotConserved.selector, KETH_ID, Status.RECOVERING)
        );
        pool.releaseOrMint(_releaseIn(address(remote), alice, alice, 1 ether));

        _recoveryCheck(2, 0);
        vm.prank(offRamp);
        pool.releaseOrMint(_releaseIn(address(remote), alice, alice, 1 ether));
    }

    function test_revertsWhenUnknown() public {
        // A fresh ledger where the token never had an epoch.
        _deployCore(ARB_SELECTOR);
        KirchhoffBurnMintTokenPool fresh = new KirchhoffBurnMintTokenPool(
            remote, 18, address(0), address(rmn), address(router), ledger, quarantine, KETH_ID
        );
        _addChain(fresh, HOME_SELECTOR);
        vm.prank(offRamp);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffTokenPool.TokenNotConserved.selector, KETH_ID, Status.UNKNOWN));
        fresh.releaseOrMint(_releaseIn(address(remote), alice, alice, 1 ether));
    }

    function test_staleFailsClosed() public {
        (,, uint64 updatedAt,) = ledger.statusOf(KETH_ID);
        vm.warp(block.timestamp + STALENESS + 1);
        vm.prank(offRamp);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffTokenPool.TokenStatusStale.selector, KETH_ID, updatedAt));
        pool.releaseOrMint(_releaseIn(address(remote), alice, alice, 1 ether));
        _fundPool(1 ether);
        vm.prank(onRamp);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffTokenPool.TokenStatusStale.selector, KETH_ID, updatedAt));
        pool.lockOrBurn(_lockIn(address(remote), alice, alice, 1 ether));
    }

    function test_revertsWhenLanesFrozenWhileConserved() public {
        // After recovery the lanes unfreeze; freeze them directly to isolate the lane check.
        vm.prank(address(ledger));
        quarantine.onBreach(KETH_ID, keccak256("i"), address(0));
        vm.prank(offRamp);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffTokenPool.LaneFrozen.selector, KETH_ID));
        pool.releaseOrMint(_releaseIn(address(remote), alice, alice, 1 ether));
    }

    function test_revertsForTaintedParties() public {
        vm.prank(address(ledger));
        quarantine.onQuarantineApplied(KETH_ID, keccak256("i"), _one(attacker));
        _fundPool(4 ether);
        bytes memory err = abi.encodeWithSelector(KirchhoffTokenPool.AccountTainted.selector, KETH_ID, attacker);

        vm.startPrank(onRamp);
        vm.expectRevert(err); // tainted sender
        pool.lockOrBurn(_lockIn(address(remote), attacker, alice, 1 ether));
        vm.expectRevert(err); // tainted destination receiver
        pool.lockOrBurn(_lockIn(address(remote), alice, attacker, 1 ether));
        vm.stopPrank();

        vm.startPrank(offRamp);
        vm.expectRevert(err); // tainted receiver
        pool.releaseOrMint(_releaseIn(address(remote), alice, attacker, 1 ether));
        vm.expectRevert(err); // tainted source sender
        pool.releaseOrMint(_releaseIn(address(remote), attacker, alice, 1 ether));
        vm.stopPrank();
    }

    function test_nonEvmEncodedAddressesAreSkipped() public {
        _fundPool(2 ether);
        Pool.LockOrBurnInV1 memory input = _lockIn(address(remote), alice, alice, 1 ether);
        input.receiver = abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2))); // 64-byte non-EVM receiver
        vm.prank(onRamp);
        pool.lockOrBurn(input);

        input.receiver = abi.encode(type(uint256).max); // 32 bytes but not an address
        vm.prank(onRamp);
        pool.lockOrBurn(input);
    }

    function test_upstreamAuthStillFirst() public {
        // A non-ramp caller sees the upstream CCIP error even when the token is BROKEN.
        _breach(keccak256("ev"), Reason.DEBIT_NOT_FOUND, attacker, 1);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(TokenPool.CallerIsNotARampOnRouter.selector, attacker));
        pool.releaseOrMint(_releaseIn(address(remote), alice, alice, 1 ether));
    }

    function test_kirchhoffCheckView() public {
        pool.kirchhoffCheck(alice, alice);
        vm.prank(address(ledger));
        quarantine.onQuarantineApplied(KETH_ID, keccak256("i"), _one(attacker));
        vm.expectRevert(abi.encodeWithSelector(KirchhoffTokenPool.AccountTainted.selector, KETH_ID, attacker));
        pool.kirchhoffCheck(alice, attacker);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffTokenPool.AccountTainted.selector, KETH_ID, attacker));
        pool.kirchhoffCheck(attacker, alice);
    }

    function test_constructorRejectsZeroKirchhoffAddresses() public {
        vm.expectRevert(KirchhoffTokenPool.KirchhoffZeroAddress.selector);
        new KirchhoffBurnMintTokenPool(
            remote, 18, address(0), address(rmn), address(router), IConservationLedger(address(0)), quarantine, KETH_ID
        );
        vm.expectRevert(KirchhoffTokenPool.KirchhoffZeroAddress.selector);
        new KirchhoffBurnMintTokenPool(
            remote, 18, address(0), address(rmn), address(router), ledger, IQuarantineController(address(0)), KETH_ID
        );
    }

    // ================================================================
    // Home LockRelease pool backed by the upstream ERC20LockBox 2.0.0
    // ================================================================

    function test_lockRelease_homePoolThroughEscrow() public {
        _deployCore(HOME_SELECTOR);
        _epoch(1, 0, Status.CONSERVED);
        KETH keth = new KETH(new KirchhoffGuard(quarantine, KETH_ID), admin);
        ERC20LockBox escrow = new ERC20LockBox(address(keth));
        KirchhoffLockReleaseTokenPool home = new KirchhoffLockReleaseTokenPool(
            keth, 18, address(0), address(rmn), address(router), address(escrow), ledger, quarantine, KETH_ID
        );
        address[] memory callers = new address[](1);
        callers[0] = address(home);
        escrow.applyAuthorizedCallerUpdates(AuthorizedCallers.AuthorizedCallerArgs(callers, new address[](0)));
        TokenPool.ChainUpdate[] memory updates = new TokenPool.ChainUpdate[](1);
        bytes[] memory pools = new bytes[](1);
        pools[0] = abi.encode(remotePoolAddr);
        RateLimiter.Config memory off = RateLimiter.Config(false, 0, 0);
        updates[0] = TokenPool.ChainUpdate(ARB_SELECTOR, pools, abi.encode(remoteTokenAddr), off, off);
        home.applyChainUpdates(new uint64[](0), updates);
        router.setOnRamp(ARB_SELECTOR, onRamp);
        router.setOffRamp(ARB_SELECTOR, offRamp, true);
        assertEq(home.typeAndVersion(), "KirchhoffLockReleaseTokenPool 1.0.0 (LockReleaseTokenPool 2.0.0)");
        assertEq(home.getLockBox(), address(escrow));

        // The router moves the user's tokens into the pool before calling lockOrBurn.
        vm.prank(admin);
        keth.mint(address(home), 5 ether);
        Pool.LockOrBurnInV1 memory lockIn = Pool.LockOrBurnInV1({
            receiver: abi.encode(alice),
            remoteChainSelector: ARB_SELECTOR,
            originalSender: alice,
            amount: 5 ether,
            localToken: address(keth)
        });
        vm.prank(onRamp);
        home.lockOrBurn(lockIn);
        assertEq(keth.balanceOf(address(escrow)), 5 ether);

        Pool.ReleaseOrMintInV1 memory releaseIn = Pool.ReleaseOrMintInV1({
            originalSender: abi.encode(alice),
            remoteChainSelector: ARB_SELECTOR,
            receiver: alice,
            sourceDenominatedAmount: 2 ether,
            localToken: address(keth),
            sourcePoolAddress: abi.encode(remotePoolAddr),
            sourcePoolData: abi.encode(uint256(18)),
            offchainTokenData: ""
        });
        vm.prank(offRamp);
        home.releaseOrMint(releaseIn);
        assertEq(keth.balanceOf(alice), 2 ether);

        // Kelp Replay on the home chain: BROKEN blocks the CCIP release.
        _breach(keccak256("ev"), Reason.DEBIT_NOT_FOUND, attacker, 1);
        vm.prank(offRamp);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffTokenPool.TokenNotConserved.selector, KETH_ID, Status.BROKEN));
        home.releaseOrMint(releaseIn);
        vm.prank(admin);
        keth.mint(address(home), 1 ether);
        lockIn.amount = 1 ether;
        vm.prank(onRamp);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffTokenPool.TokenNotConserved.selector, KETH_ID, Status.BROKEN));
        home.lockOrBurn(lockIn);
    }
}
