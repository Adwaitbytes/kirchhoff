// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBurnMintERC20} from "@chainlink/contracts-ccip/contracts/interfaces/IBurnMintERC20.sol";
import {IGetCCIPAdmin} from "@chainlink/contracts-ccip/contracts/interfaces/IGetCCIPAdmin.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {KirchhoffGuard} from "../src/KirchhoffGuard.sol";
import {BridgeRegistry} from "../src/demo/BridgeRegistry.sol";
import {HomeEscrowAdapter} from "../src/demo/HomeEscrowAdapter.sol";
import {IBridgeEvents} from "../src/demo/IBridgeEvents.sol";
import {KETH} from "../src/demo/KETH.sol";
import {RemoteKETH} from "../src/demo/RemoteKETH.sol";
import {WeakBridge} from "../src/demo/WeakBridge.sol";

import {KirchhoffTestBase} from "./utils/KirchhoffTestBase.sol";

contract WeakBridgeTest is KirchhoffTestBase {
    uint256 internal constant VERIFIER_KEY = 0xBADB1D6E;
    address internal verifier;
    address internal alice = makeAddr("alice");

    KETH internal keth;
    HomeEscrowAdapter internal escrow;
    WeakBridge internal homeBridge;
    RemoteKETH internal remote;
    WeakBridge internal remoteBridge;

    function setUp() public {
        _deployCore(HOME_SELECTOR);
        verifier = vm.addr(VERIFIER_KEY);
        keth = new KETH(new KirchhoffGuard(quarantine, KETH_ID), admin);
        escrow = new HomeEscrowAdapter(keth, admin);
        homeBridge = new WeakBridge(verifier, IBurnMintERC20(address(0)), escrow);
        vm.prank(admin);
        escrow.setBridge(address(homeBridge));

        remote = new RemoteKETH(admin);
        remoteBridge = new WeakBridge(verifier, remote, HomeEscrowAdapter(address(0)));
        vm.prank(admin);
        remote.grantMintAndBurnRoles(address(remoteBridge));

        vm.prank(admin);
        keth.mint(alice, 100 ether);
    }

    function _sign(WeakBridge bridge, uint256 key, bytes32 id, address to, uint256 amount, uint64 srcChain)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, bridge.creditDigest(id, to, amount, srcChain));
        return abi.encodePacked(r, s, v);
    }

    function _expectBadSig(WeakBridge bridge, bytes32 id, address to, uint256 amount, uint64 srcChain, bytes memory sig)
        internal
    {
        address recovered = ECDSA.recover(bridge.creditDigest(id, to, amount, srcChain), sig);
        assertTrue(recovered != verifier);
        vm.expectRevert(abi.encodeWithSelector(WeakBridge.InvalidSignature.selector, recovered));
    }

    // ---------------- construction ----------------

    function test_constructor_modes() public {
        vm.expectRevert(WeakBridge.ZeroAddress.selector);
        new WeakBridge(address(0), remote, HomeEscrowAdapter(address(0)));
        vm.expectRevert(WeakBridge.InvalidMode.selector);
        new WeakBridge(verifier, IBurnMintERC20(address(0)), HomeEscrowAdapter(address(0)));
        vm.expectRevert(WeakBridge.InvalidMode.selector);
        new WeakBridge(verifier, remote, escrow);
    }

    function test_digest_bindsChainAndContract() public {
        bytes32 id = keccak256("id");
        bytes32 d1 = homeBridge.creditDigest(id, alice, 1, ARB_SELECTOR);
        bytes32 d2 = remoteBridge.creditDigest(id, alice, 1, ARB_SELECTOR);
        assertTrue(d1 != d2, "different contract, different digest");
        vm.chainId(31_338);
        assertTrue(homeBridge.creditDigest(id, alice, 1, ARB_SELECTOR) != d1, "different chain, different digest");

        bytes32 expectedDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("WeakBridge"),
                keccak256("1"),
                block.chainid,
                address(homeBridge)
            )
        );
        assertEq(homeBridge.domainSeparator(), expectedDomain);
    }

    // ---------------- home mode (escrow) ----------------

    function test_home_sendLocksAndEmitsBurnedFromEscrow() public {
        vm.prank(alice);
        keth.approve(address(escrow), 10 ether);
        bytes32 expectedId =
            keccak256(abi.encode(block.chainid, address(homeBridge), uint256(1), alice, alice, 10 ether, ARB_SELECTOR));
        vm.expectEmit(address(escrow));
        emit IBridgeEvents.Burned(expectedId, alice, alice, 10 ether, ARB_SELECTOR);
        vm.prank(alice);
        bytes32 id = homeBridge.send(alice, 10 ether, ARB_SELECTOR);
        assertEq(id, expectedId);
        assertEq(keth.balanceOf(address(escrow)), 10 ether);
        (uint256 amt, address rcpt, uint64 dst, uint64 blk) = homeBridge.debitOf(id);
        assertEq(amt, 10 ether);
        assertEq(rcpt, alice);
        assertEq(dst, ARB_SELECTOR);
        assertEq(blk, block.number);
        (amt,,,) = homeBridge.debitOf(keccak256("missing"));
        assertEq(amt, 0, "amount 0 means no debit");
        assertEq(homeBridge.nonce(), 1);
    }

    function test_home_creditReleasesFromEscrow() public {
        vm.prank(alice);
        keth.approve(address(escrow), 10 ether);
        vm.prank(alice);
        homeBridge.send(alice, 10 ether, ARB_SELECTOR);

        bytes32 id = keccak256("arb-burn-1");
        bytes memory sig = _sign(homeBridge, VERIFIER_KEY, id, alice, 4 ether, ARB_SELECTOR);
        vm.expectEmit(address(escrow));
        emit IBridgeEvents.Released(id, alice, 4 ether, ARB_SELECTOR);
        homeBridge.credit(id, alice, 4 ether, ARB_SELECTOR, sig);
        assertEq(keth.balanceOf(address(escrow)), 6 ether);
        (uint256 amt, address rcpt, uint64 src, uint64 blk) = homeBridge.creditOf(id);
        assertEq(amt, 4 ether);
        assertEq(rcpt, alice);
        assertEq(src, ARB_SELECTOR);
        assertEq(blk, block.number);
        (amt,,,) = escrow.creditOf(id);
        assertEq(amt, 4 ether, "home bridge reads through to the escrow registry");
    }

    function test_kelpReplay_forgedCreditDrainsEscrow() public {
        // The weakness being demonstrated: a credit signed by the single key releases with no debit anywhere.
        vm.prank(alice);
        keth.approve(address(escrow), 100 ether);
        vm.prank(alice);
        homeBridge.send(alice, 100 ether, ARB_SELECTOR);
        bytes32 forgedId = keccak256("forged");
        homeBridge.credit(
            forgedId,
            attacker,
            100 ether,
            ARB_SELECTOR,
            _sign(homeBridge, VERIFIER_KEY, forgedId, attacker, 100 ether, ARB_SELECTOR)
        );
        assertEq(keth.balanceOf(attacker), 100 ether);
    }

    function test_credit_rejectsWrongSigner() public {
        bytes32 id = keccak256("id");
        uint256 wrongKey = 0x1234;
        bytes memory sig = _sign(homeBridge, wrongKey, id, alice, 1 ether, ARB_SELECTOR);
        vm.expectRevert(abi.encodeWithSelector(WeakBridge.InvalidSignature.selector, vm.addr(wrongKey)));
        homeBridge.credit(id, alice, 1 ether, ARB_SELECTOR, sig);
    }

    function test_credit_rejectsTamperedFields() public {
        bytes32 id = keccak256("id");
        bytes memory sig = _sign(remoteBridge, VERIFIER_KEY, id, alice, 1 ether, HOME_SELECTOR);
        // Each tampered field recovers a different, non-verifier address.
        _expectBadSig(remoteBridge, id, attacker, 1 ether, HOME_SELECTOR, sig);
        remoteBridge.credit(id, attacker, 1 ether, HOME_SELECTOR, sig);
        _expectBadSig(remoteBridge, id, alice, 2 ether, HOME_SELECTOR, sig);
        remoteBridge.credit(id, alice, 2 ether, HOME_SELECTOR, sig);
        _expectBadSig(remoteBridge, id, alice, 1 ether, BASE_SELECTOR, sig);
        remoteBridge.credit(id, alice, 1 ether, BASE_SELECTOR, sig);
        _expectBadSig(remoteBridge, keccak256("other"), alice, 1 ether, HOME_SELECTOR, sig);
        remoteBridge.credit(keccak256("other"), alice, 1 ether, HOME_SELECTOR, sig);
        remoteBridge.credit(id, alice, 1 ether, HOME_SELECTOR, sig);
    }

    function test_credit_signatureNotReplayableAcrossBridges() public {
        bytes32 id = keccak256("id");
        bytes memory sig = _sign(remoteBridge, VERIFIER_KEY, id, alice, 1 ether, HOME_SELECTOR);
        WeakBridge otherRemote = new WeakBridge(verifier, remote, HomeEscrowAdapter(address(0)));
        vm.prank(admin);
        remote.grantMintRole(address(otherRemote));
        _expectBadSig(otherRemote, id, alice, 1 ether, HOME_SELECTOR, sig);
        otherRemote.credit(id, alice, 1 ether, HOME_SELECTOR, sig);
    }

    function test_credit_rejectsMalformedSignature() public {
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 3));
        remoteBridge.credit(keccak256("id"), alice, 1, HOME_SELECTOR, hex"010203");
    }

    function test_credit_rejectsDoubleCredit() public {
        bytes32 id = keccak256("id");
        bytes memory sig = _sign(remoteBridge, VERIFIER_KEY, id, alice, 1 ether, HOME_SELECTOR);
        remoteBridge.credit(id, alice, 1 ether, HOME_SELECTOR, sig);
        vm.expectRevert(abi.encodeWithSelector(WeakBridge.AlreadyCredited.selector, id));
        remoteBridge.credit(id, alice, 1 ether, HOME_SELECTOR, sig);
    }

    function test_credit_rejectsZero() public {
        vm.expectRevert(WeakBridge.ZeroAddress.selector);
        remoteBridge.credit(bytes32(0), address(0), 1, HOME_SELECTOR, "");
        vm.expectRevert(WeakBridge.ZeroAmount.selector);
        remoteBridge.credit(bytes32(0), alice, 0, HOME_SELECTOR, "");
    }

    function test_send_rejectsZero() public {
        vm.expectRevert(WeakBridge.ZeroAddress.selector);
        remoteBridge.send(address(0), 1, HOME_SELECTOR);
        vm.expectRevert(WeakBridge.ZeroAmount.selector);
        remoteBridge.send(alice, 0, HOME_SELECTOR);
    }

    // ---------------- remote mode (burn / mint) ----------------

    function test_remote_creditMintsAndSendBurns() public {
        bytes32 id = keccak256("home-lock-1");
        vm.expectEmit(address(remoteBridge));
        emit IBridgeEvents.Released(id, alice, 5 ether, HOME_SELECTOR);
        remoteBridge.credit(
            id, alice, 5 ether, HOME_SELECTOR, _sign(remoteBridge, VERIFIER_KEY, id, alice, 5 ether, HOME_SELECTOR)
        );
        assertEq(remote.balanceOf(alice), 5 ether);

        vm.prank(alice);
        remote.approve(address(remoteBridge), 2 ether);
        bytes32 expectedId = keccak256(
            abi.encode(block.chainid, address(remoteBridge), uint256(1), alice, alice, 2 ether, HOME_SELECTOR)
        );
        vm.expectEmit(address(remoteBridge));
        emit IBridgeEvents.Burned(expectedId, alice, alice, 2 ether, HOME_SELECTOR);
        vm.prank(alice);
        remoteBridge.send(alice, 2 ether, HOME_SELECTOR);
        assertEq(remote.balanceOf(alice), 3 ether);
        assertEq(remote.totalSupply(), 3 ether);
        (uint256 amt, address rcpt, uint64 dst,) = remoteBridge.debitOf(expectedId);
        assertEq(amt, 2 ether);
        assertEq(rcpt, alice);
        assertEq(dst, HOME_SELECTOR);
        (amt, rcpt, dst,) = remoteBridge.creditOf(id);
        assertEq(amt, 5 ether);
        assertEq(rcpt, alice);
        assertEq(dst, HOME_SELECTOR);
    }

    // ---------------- HomeEscrowAdapter ----------------

    function test_escrow_accessControl() public {
        vm.expectRevert(abi.encodeWithSelector(HomeEscrowAdapter.OnlyBridge.selector, address(this)));
        escrow.lock(bytes32(0), alice, alice, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(HomeEscrowAdapter.OnlyBridge.selector, address(this)));
        escrow.release(bytes32(0), alice, 1, 0);

        vm.startPrank(admin);
        vm.expectRevert(HomeEscrowAdapter.AlreadySet.selector);
        escrow.setBridge(address(1));
        vm.stopPrank();

        HomeEscrowAdapter fresh = new HomeEscrowAdapter(keth, admin);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        fresh.setBridge(address(1));
        vm.prank(admin);
        vm.expectRevert(HomeEscrowAdapter.ZeroAddress.selector);
        fresh.setBridge(address(0));

        vm.expectRevert(HomeEscrowAdapter.ZeroAddress.selector);
        new HomeEscrowAdapter(IERC20(address(0)), admin);
    }

    function test_escrow_zeroAmounts() public {
        vm.startPrank(address(homeBridge));
        vm.expectRevert(HomeEscrowAdapter.ZeroAmount.selector);
        escrow.lock(bytes32(0), alice, alice, 0, 0);
        vm.expectRevert(HomeEscrowAdapter.ZeroAmount.selector);
        escrow.release(bytes32(0), alice, 0, 0);
        vm.stopPrank();
    }

    function test_escrow_rejectsDuplicateRegistryIds() public {
        vm.prank(alice);
        keth.approve(address(escrow), 2 ether);
        vm.startPrank(address(homeBridge));
        escrow.lock(keccak256("d"), alice, alice, 1 ether, ARB_SELECTOR);
        vm.expectRevert(abi.encodeWithSelector(BridgeRegistry.DuplicateDebit.selector, keccak256("d")));
        escrow.lock(keccak256("d"), alice, alice, 1 ether, ARB_SELECTOR);
        escrow.release(keccak256("c"), alice, 1 ether, ARB_SELECTOR);
        vm.expectRevert(abi.encodeWithSelector(BridgeRegistry.DuplicateCredit.selector, keccak256("c")));
        escrow.release(keccak256("c"), alice, 1 ether, ARB_SELECTOR);
        vm.stopPrank();
    }

    // ---------------- RemoteKETH ----------------

    function test_remoteKETH_rolesAndEvents() public {
        address minter = makeAddr("minter");
        vm.startPrank(admin);
        vm.expectEmit(address(remote));
        emit RemoteKETH.MintAccessGranted(minter);
        remote.grantMintRole(minter);
        vm.expectEmit(address(remote));
        emit RemoteKETH.BurnAccessGranted(minter);
        remote.grantBurnRole(minter);

        // Re-granting is a no-op and emits nothing.
        vm.recordLogs();
        remote.grantMintRole(minter);
        assertEq(vm.getRecordedLogs().length, 0);

        vm.expectEmit(address(remote));
        emit RemoteKETH.MintAccessRevoked(minter);
        remote.revokeMintRole(minter);
        vm.expectEmit(address(remote));
        emit RemoteKETH.BurnAccessRevoked(minter);
        remote.revokeBurnRole(minter);
        vm.recordLogs();
        remote.revokeBurnRole(minter);
        assertEq(vm.getRecordedLogs().length, 0);

        // Admin role grants do not emit the mint/burn events.
        vm.recordLogs();
        remote.grantRole(remote.DEFAULT_ADMIN_ROLE(), minter);
        assertEq(vm.getRecordedLogs().length, 1);
        vm.recordLogs();
        remote.revokeRole(remote.DEFAULT_ADMIN_ROLE(), minter);
        assertEq(vm.getRecordedLogs().length, 1);
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, remote.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(alice);
        remote.grantMintRole(alice);
    }

    function test_remoteKETH_mintBurnAuth() public {
        bytes32 minterRole = remote.MINTER_ROLE();
        bytes32 burnerRole = remote.BURNER_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, minterRole)
        );
        vm.prank(alice);
        remote.mint(alice, 1);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, burnerRole)
        );
        vm.prank(alice);
        remote.burn(1);

        vm.prank(address(remoteBridge));
        vm.expectRevert(abi.encodeWithSelector(RemoteKETH.InvalidRecipient.selector, address(remote)));
        remote.mint(address(remote), 1);

        vm.prank(address(remoteBridge));
        remote.mint(address(remoteBridge), 3);
        vm.prank(address(remoteBridge));
        remote.burn(1);
        assertEq(remote.totalSupply(), 2);

        vm.prank(address(remoteBridge));
        remote.mint(alice, 5);
        vm.prank(alice);
        remote.approve(address(remoteBridge), 5);
        vm.prank(address(remoteBridge));
        remote.burn(alice, 2); // burn(account, amount) is burnFrom
        assertEq(remote.balanceOf(alice), 3);
    }

    function test_remoteKETH_ccipAdminAndInterfaces() public {
        assertEq(remote.getCCIPAdmin(), admin);
        address next = makeAddr("next");
        vm.expectEmit(address(remote));
        emit RemoteKETH.CCIPAdminTransferred(admin, next);
        vm.prank(admin);
        remote.setCCIPAdmin(next);
        assertEq(remote.getCCIPAdmin(), next);

        assertTrue(remote.supportsInterface(type(IBurnMintERC20).interfaceId));
        assertTrue(remote.supportsInterface(type(IERC20).interfaceId));
        assertTrue(remote.supportsInterface(type(IGetCCIPAdmin).interfaceId));
        assertTrue(remote.supportsInterface(type(IAccessControl).interfaceId));
        assertTrue(remote.supportsInterface(type(IERC165).interfaceId));
        assertFalse(remote.supportsInterface(0xffffffff));
        assertEq(remote.decimals(), 18);

        vm.expectRevert(RemoteKETH.ZeroAddress.selector);
        new RemoteKETH(address(0));
    }
}
