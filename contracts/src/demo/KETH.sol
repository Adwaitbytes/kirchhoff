// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {IKirchhoffGuard} from "../interfaces/IKirchhoffGuard.sol";

/// @title kETH (TESTNET SIMULATION ONLY)
/// @notice Canonical demo token on the home chain (Ethereum Sepolia). Every balance change runs the KirchhoffGuard,
/// so tainted accounts cannot move kETH. Not a real asset; the owner mint exists only to seed demo liquidity.
contract KETH is ERC20, Ownable {
    IKirchhoffGuard public immutable guard;

    error ZeroAddress();

    constructor(IKirchhoffGuard guard_, address initialOwner)
        ERC20("Kirchhoff ETH (testnet)", "kETH")
        Ownable(initialOwner)
    {
        if (address(guard_) == address(0)) revert ZeroAddress();
        guard = guard_;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        guard.check(from, to, value);
        super._update(from, to, value);
    }
}
