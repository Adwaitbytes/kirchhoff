// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Pool} from "@chainlink/contracts-ccip/contracts/libraries/Pool.sol";
import {LockReleaseTokenPool} from "@chainlink/contracts-ccip/contracts/pools/LockReleaseTokenPool.sol";
import {IERC20} from "@openzeppelin/contracts@5.3.0/token/ERC20/IERC20.sol";

import {KirchhoffTokenPool} from "./KirchhoffTokenPool.sol";
import {IConservationLedger} from "./interfaces/IConservationLedger.sol";
import {IQuarantineController} from "./interfaces/IQuarantineController.sol";

/// @title KirchhoffLockReleaseTokenPool
/// @notice Upstream CCIP LockReleaseTokenPool 2.0.0 for the home chain, with KIRCHHOFF Fallback B enforcement.
/// Liquidity lives in the upstream ERC20LockBox 2.0.0 (`getLockBox()`), which W2 reads as CCIP escrow.
contract KirchhoffLockReleaseTokenPool is LockReleaseTokenPool, KirchhoffTokenPool {
    constructor(
        IERC20 token,
        uint8 localTokenDecimals,
        address advancedPoolHooks,
        address rmnProxy,
        address router,
        address lockBox,
        IConservationLedger ledger,
        IQuarantineController quarantine,
        bytes32 tokenId
    )
        LockReleaseTokenPool(token, localTokenDecimals, advancedPoolHooks, rmnProxy, router, lockBox)
        KirchhoffTokenPool(ledger, quarantine, tokenId)
    {}

    function typeAndVersion() external pure override returns (string memory) {
        return "KirchhoffLockReleaseTokenPool 1.0.0 (LockReleaseTokenPool 2.0.0)";
    }

    function _validateLockOrBurn(
        Pool.LockOrBurnInV1 calldata lockOrBurnIn,
        bytes4 requestedFinality,
        bytes memory tokenArgs,
        uint256 feeAmount
    ) internal override {
        super._validateLockOrBurn(lockOrBurnIn, requestedFinality, tokenArgs, feeAmount);
        _kirchhoffCheckLockOrBurn(lockOrBurnIn);
    }

    function _validateReleaseOrMint(
        Pool.ReleaseOrMintInV1 calldata releaseOrMintIn,
        uint256 localAmount,
        bytes4 requestedFinalityConfig
    ) internal override {
        super._validateReleaseOrMint(releaseOrMintIn, localAmount, requestedFinalityConfig);
        _kirchhoffCheckReleaseOrMint(releaseOrMintIn);
    }
}
