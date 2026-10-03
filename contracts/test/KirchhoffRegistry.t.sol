// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";

import {KirchhoffRegistry} from "../src/KirchhoffRegistry.sol";
import {IKirchhoffRegistry} from "../src/interfaces/IKirchhoffRegistry.sol";

contract KirchhoffRegistryTest is Test {
    KirchhoffRegistry internal registry;
    address internal admin = makeAddr("admin");
    address internal safe = makeAddr("safe");
    bytes32 internal constant KETH_ID = keccak256("kETH");
    bytes32 internal constant SPEC_V1 = keccak256("spec-v1");
    bytes32 internal constant SPEC_V2 = keccak256("spec-v2");

    function setUp() public {
        vm.warp(1_790_000_000);
        registry = new KirchhoffRegistry(600, admin);
        vm.prank(admin);
        registry.registerToken("kETH", safe);
    }

    function test_constructor_timelockBounds() public {
        vm.expectRevert(abi.encodeWithSelector(KirchhoffRegistry.InvalidTimelock.selector, 599));
        new KirchhoffRegistry(599, admin);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffRegistry.InvalidTimelock.selector, 48 hours + 1));
        new KirchhoffRegistry(48 hours + 1, admin);
        assertEq(new KirchhoffRegistry(48 hours, admin).timelockSeconds(), 48 hours);
        assertEq(registry.timelockSeconds(), 600);
    }

    function test_registerToken() public {
        assertEq(registry.issuerOf(KETH_ID), safe);
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffRegistry.TokenAlreadyRegistered.selector, KETH_ID));
        registry.registerToken("kETH", safe);
        vm.expectRevert(KirchhoffRegistry.EmptySymbol.selector);
        registry.registerToken("", safe);
        vm.expectRevert(KirchhoffRegistry.ZeroAddress.selector);
        registry.registerToken("kBTC", address(0));
        vm.expectEmit(address(registry));
        emit IKirchhoffRegistry.TokenRegistered(keccak256("kBTC"), "kBTC", safe);
        assertEq(registry.registerToken("kBTC", safe), keccak256("kBTC"));
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        vm.prank(safe);
        registry.registerToken("kSOL", safe);
    }

    function test_proposeActivate_timelock() public {
        uint64 eta = uint64(block.timestamp) + 600;
        vm.expectEmit(address(registry));
        emit IKirchhoffRegistry.SpecProposed(KETH_ID, SPEC_V1, "ipfs://v1", eta);
        vm.prank(safe);
        registry.proposeSpec(KETH_ID, SPEC_V1, "ipfs://v1");

        IKirchhoffRegistry.PendingSpec memory p = registry.pendingSpec(KETH_ID);
        assertEq(p.specHash, SPEC_V1);
        assertEq(p.eta, eta);
        assertEq(registry.activeSpecHash(KETH_ID), bytes32(0));

        vm.warp(eta - 1);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffRegistry.TimelockNotElapsed.selector, eta));
        registry.activateSpec(KETH_ID);

        vm.warp(eta);
        vm.expectEmit(address(registry));
        emit IKirchhoffRegistry.SpecActivated(KETH_ID, SPEC_V1, "ipfs://v1", 1);
        registry.activateSpec(KETH_ID); // permissionless once the timelock has elapsed

        IKirchhoffRegistry.Spec memory s = registry.activeSpec(KETH_ID);
        assertEq(s.specHash, SPEC_V1);
        assertEq(s.specURI, "ipfs://v1");
        assertEq(s.version, 1);
        assertEq(s.activatedAt, eta);
        assertEq(registry.pendingSpec(KETH_ID).eta, 0);

        vm.expectRevert(abi.encodeWithSelector(KirchhoffRegistry.NoPendingSpec.selector, KETH_ID));
        registry.activateSpec(KETH_ID);
    }

    function test_reproposeRestartsTimelock() public {
        vm.prank(safe);
        registry.proposeSpec(KETH_ID, SPEC_V1, "ipfs://v1");
        vm.warp(block.timestamp + 500);
        vm.expectEmit(address(registry));
        emit IKirchhoffRegistry.SpecProposalCancelled(KETH_ID, SPEC_V1);
        vm.prank(safe);
        registry.proposeSpec(KETH_ID, SPEC_V2, "ipfs://v2");
        uint64 eta2 = uint64(block.timestamp) + 600;
        vm.warp(block.timestamp + 100);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffRegistry.TimelockNotElapsed.selector, eta2));
        registry.activateSpec(KETH_ID);
        vm.warp(block.timestamp + 500);
        registry.activateSpec(KETH_ID);
        assertEq(registry.activeSpecHash(KETH_ID), SPEC_V2);
    }

    function test_cancelSpec() public {
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffRegistry.NoPendingSpec.selector, KETH_ID));
        registry.cancelSpec(KETH_ID);

        vm.prank(safe);
        registry.proposeSpec(KETH_ID, SPEC_V1, "ipfs://v1");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffRegistry.OnlyIssuer.selector, admin));
        registry.cancelSpec(KETH_ID);

        vm.expectEmit(address(registry));
        emit IKirchhoffRegistry.SpecProposalCancelled(KETH_ID, SPEC_V1);
        vm.prank(safe);
        registry.cancelSpec(KETH_ID);
        vm.warp(block.timestamp + 600);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffRegistry.NoPendingSpec.selector, KETH_ID));
        registry.activateSpec(KETH_ID);
    }

    function test_propose_onlyIssuerAndValidated() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffRegistry.OnlyIssuer.selector, admin));
        registry.proposeSpec(KETH_ID, SPEC_V1, "ipfs://v1");

        vm.prank(safe);
        vm.expectRevert(KirchhoffRegistry.EmptySpecHash.selector);
        registry.proposeSpec(KETH_ID, bytes32(0), "ipfs://v1");

        bytes32 unknown = keccak256("nope");
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffRegistry.TokenNotRegistered.selector, unknown));
        registry.proposeSpec(unknown, SPEC_V1, "");

        vm.expectRevert(abi.encodeWithSelector(KirchhoffRegistry.TokenNotRegistered.selector, unknown));
        registry.activateSpec(unknown);
    }

    function test_versionIncrements() public {
        vm.startPrank(safe);
        registry.proposeSpec(KETH_ID, SPEC_V1, "ipfs://v1");
        vm.warp(block.timestamp + 600);
        registry.activateSpec(KETH_ID);
        registry.proposeSpec(KETH_ID, SPEC_V2, "ipfs://v2");
        vm.warp(block.timestamp + 600);
        registry.activateSpec(KETH_ID);
        vm.stopPrank();
        assertEq(registry.activeSpec(KETH_ID).version, 2);
    }

    function test_setIssuerSafe() public {
        address next = makeAddr("next");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(KirchhoffRegistry.OnlyIssuer.selector, admin));
        registry.setIssuerSafe(KETH_ID, next);

        vm.prank(safe);
        vm.expectRevert(KirchhoffRegistry.ZeroAddress.selector);
        registry.setIssuerSafe(KETH_ID, address(0));

        vm.expectEmit(address(registry));
        emit IKirchhoffRegistry.IssuerSafeChanged(KETH_ID, safe, next);
        vm.prank(safe);
        registry.setIssuerSafe(KETH_ID, next);
        assertEq(registry.issuerOf(KETH_ID), next);
    }
}
