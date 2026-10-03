// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBurnMintERC20} from "@chainlink/contracts-ccip/contracts/interfaces/IBurnMintERC20.sol";
import {Pool} from "@chainlink/contracts-ccip/contracts/libraries/Pool.sol";
import {BurnMintTokenPool} from "@chainlink/contracts-ccip/contracts/pools/BurnMintTokenPool.sol";

import {KirchhoffTokenPool} from "./KirchhoffTokenPool.sol";
import {IConservationLedger} from "./interfaces/IConservationLedger.sol";
import {IQuarantineController} from "./interfaces/IQuarantineController.sol";

/// @title KirchhoffBurnMintTokenPool
/// @notice Upstream CCIP BurnMintTokenPool 2.0.0 for remote chains, with KIRCHHOFF Fallback B enforcement.
contract KirchhoffBurnMintTokenPool is BurnMintTokenPool, KirchhoffTokenPool {
    constructor(
        IBurnMintERC20 token,
        uint8 localTokenDecimals,
        address advancedPoolHooks,
        address rmnProxy,
        address router,
        IConservationLedger ledger,
        IQuarantineController quarantine,
        bytes32 tokenId
    )
        BurnMintTokenPool(token, localTokenDecimals, advancedPoolHooks, rmnProxy, router)
        KirchhoffTokenPool(ledger, quarantine, tokenId)
    {}

    function typeAndVersion() external pure override returns (string memory) {
        return "KirchhoffBurnMintTokenPool 1.0.0 (BurnMintTokenPool 2.0.0)";
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
