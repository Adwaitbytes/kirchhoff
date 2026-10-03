// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Pool} from "@chainlink/contracts-ccip/contracts/libraries/Pool.sol";

import {IConservationLedger} from "./interfaces/IConservationLedger.sol";
import {IQuarantineController} from "./interfaces/IQuarantineController.sol";
import {Status} from "./interfaces/KirchhoffTypes.sol";

/// @title KirchhoffTokenPool
/// @notice PRD section 9 Fallback B: KIRCHHOFF enforcement inside a standard CCIP token pool
/// (npm chainlink/contracts-ccip 2.0.0). Both lockOrBurn and releaseOrMint, in their V1 and V2 forms, revert unless the
/// token is CONSERVED or DRIFT with a fresh status, its lanes are not frozen, and neither end of the transfer is
/// tainted. Stale status always fails closed here: a pool cannot tell a stalled engine from a hidden breach.
/// @dev Enforcement mixin. The concrete pools (KirchhoffBurnMintTokenPool, KirchhoffLockReleaseTokenPool) inherit the
/// unmodified upstream pool and call these checks from `_validateLockOrBurn` / `_validateReleaseOrMint`, the single
/// choke points every public lockOrBurn / releaseOrMint overload of the upstream TokenPool passes through, so no entry
/// point can bypass them. They run after the upstream validation, so unauthorized callers still see the standard CCIP
/// errors. It is a mixin rather than a TokenPool subclass because LockReleaseTokenPool marks its `_lockOrBurn` and
/// `_releaseOrMint` non-virtual, which rules out a second TokenPool branch in the inheritance graph.
/// The upstream pool events (LockedOrBurned, ReleasedOrMinted) are unchanged.
abstract contract KirchhoffTokenPool {
    IConservationLedger public immutable kirchhoffLedger;
    IQuarantineController public immutable kirchhoffQuarantine;
    bytes32 public immutable kirchhoffTokenId;

    error KirchhoffZeroAddress();
    error TokenNotConserved(bytes32 tokenId, Status status);
    error TokenStatusStale(bytes32 tokenId, uint64 updatedAt);
    error LaneFrozen(bytes32 tokenId);
    error AccountTainted(bytes32 tokenId, address account);

    constructor(IConservationLedger ledger, IQuarantineController quarantine, bytes32 tokenId) {
        if (address(ledger) == address(0) || address(quarantine) == address(0)) revert KirchhoffZeroAddress();
        kirchhoffLedger = ledger;
        kirchhoffQuarantine = quarantine;
        kirchhoffTokenId = tokenId;
    }

    function _kirchhoffCheckLockOrBurn(Pool.LockOrBurnInV1 calldata lockOrBurnIn) internal view {
        _requireTransferable();
        _requireNotTainted(lockOrBurnIn.originalSender);
        _requireEncodedNotTainted(lockOrBurnIn.receiver);
    }

    function _kirchhoffCheckReleaseOrMint(Pool.ReleaseOrMintInV1 calldata releaseOrMintIn) internal view {
        _requireTransferable();
        _requireNotTainted(releaseOrMintIn.receiver);
        _requireEncodedNotTainted(releaseOrMintIn.originalSender);
    }

    /// @notice The same verdict the pool would apply right now, for UIs and the e2e harness.
    function kirchhoffCheck(address sender, address receiver) external view {
        _requireTransferable();
        _requireNotTainted(sender);
        _requireNotTainted(receiver);
    }

    function _requireTransferable() internal view {
        bytes32 tokenId = kirchhoffTokenId;
        (Status status,, uint64 updatedAt, bool stale) = kirchhoffLedger.statusOf(tokenId);
        if (status != Status.CONSERVED && status != Status.DRIFT) revert TokenNotConserved(tokenId, status);
        if (stale) revert TokenStatusStale(tokenId, updatedAt);
        if (kirchhoffQuarantine.isFrozen(tokenId)) revert LaneFrozen(tokenId);
    }

    function _requireNotTainted(address account) internal view {
        if (kirchhoffQuarantine.isTainted(kirchhoffTokenId, account)) revert AccountTainted(kirchhoffTokenId, account);
    }

    /// @dev CCIP abi-encodes EVM addresses into 32 bytes. Anything else (non-EVM chains) cannot be an EVM taint entry.
    function _requireEncodedNotTainted(bytes calldata encoded) internal view {
        if (encoded.length != 32) return;
        uint256 raw = abi.decode(encoded, (uint256));
        if (raw > type(uint160).max) return;
        _requireNotTainted(address(uint160(raw)));
    }
}
