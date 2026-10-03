// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BridgeRegistry} from "./BridgeRegistry.sol";

/// @title HomeEscrowAdapter (TESTNET SIMULATION ONLY)
/// @notice WeakBridge's kETH escrow on the home chain. WeakBridge sends lock here and emit `Burned`; WeakBridge credits
/// release from here and emit `Released`. Every debit and credit is also recorded in `debitOf` / `creditOf`
/// (docs/INTERFACES.md Revision 2) so W1 can confirm a debit with one read instead of a log scan.
/// @dev CCIP liquidity is held separately in the LockReleaseTokenPool's upstream ERC20LockBox; the Loop Rule's home
/// backing is the sum of both balances.
contract HomeEscrowAdapter is BridgeRegistry, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public bridge;

    error ZeroAddress();
    error AlreadySet();
    error OnlyBridge(address caller);
    error ZeroAmount();

    event BridgeSet(address indexed bridge);

    constructor(IERC20 token_, address initialOwner) Ownable(initialOwner) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    /// @dev One-shot: swapping the bridge later would let the owner redirect the escrow.
    function setBridge(address bridge_) external onlyOwner {
        if (bridge != address(0)) revert AlreadySet();
        if (bridge_ == address(0)) revert ZeroAddress();
        bridge = bridge_;
        emit BridgeSet(bridge_);
    }

    /// @notice Debit: pull `amount` from `from` (who approved this escrow) for a WeakBridge send.
    function lock(bytes32 id, address from, address to, uint256 amount, uint64 dstChain) external {
        if (msg.sender != bridge) revert OnlyBridge(msg.sender);
        if (amount == 0) revert ZeroAmount();
        _recordDebit(id, from, to, amount, dstChain);
        // `from` is always the WeakBridge caller (WeakBridge.send passes msg.sender), and only the bridge gets here.
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        token.safeTransferFrom(from, address(this), amount);
    }

    /// @notice Credit: release `amount` to `to` for a WeakBridge credit the bridge has already authorized.
    function release(bytes32 id, address to, uint256 amount, uint64 srcChain) external {
        if (msg.sender != bridge) revert OnlyBridge(msg.sender);
        if (amount == 0) revert ZeroAmount();
        _recordCredit(id, to, amount, srcChain);
        token.safeTransfer(to, amount);
    }
}
