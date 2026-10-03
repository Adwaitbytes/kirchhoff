// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice PRD section 7 core interface.
interface IKirchhoffGuard {
    function check(address from, address to, uint256 amount) external view; // reverts if from is tainted
}
