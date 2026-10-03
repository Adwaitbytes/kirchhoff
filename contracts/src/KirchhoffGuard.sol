// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IKirchhoffGuard} from "./interfaces/IKirchhoffGuard.sol";
import {IQuarantineController} from "./interfaces/IQuarantineController.sol";

/// @title KirchhoffGuard
/// @notice Opt-in transfer hook for one protected token: the token calls `check` from its `_update`, and transfers out
/// of tainted accounts revert. This is what stops a forged-release recipient from moving funds onward on the same
/// chain (PRD Flow B step 6).
contract KirchhoffGuard is IKirchhoffGuard {
    IQuarantineController public immutable quarantine;
    bytes32 public immutable tokenId;

    error ZeroAddress();
    error SenderTainted(address account);

    constructor(IQuarantineController quarantine_, bytes32 tokenId_) {
        if (address(quarantine_) == address(0)) revert ZeroAddress();
        quarantine = quarantine_;
        tokenId = tokenId_;
    }

    /// @inheritdoc IKirchhoffGuard
    /// @dev Mints (from == 0) are never blocked here; mint authority is the token's own concern.
    function check(address from, address, uint256) external view {
        if (from != address(0) && quarantine.isTainted(tokenId, from)) revert SenderTainted(from);
    }
}
