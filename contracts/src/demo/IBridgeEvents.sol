// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice WeakBridge debit/credit events, frozen by docs/INTERFACES.md and the KIRCH-SPEC (message id is topic 1).
/// Emitted by HomeEscrowAdapter on the home chain and by WeakBridge on remote chains. TESTNET SIMULATION ONLY.
interface IBridgeEvents {
    event Burned(bytes32 indexed id, address indexed from, address to, uint256 amount, uint64 dstChain);
    event Released(bytes32 indexed id, address indexed to, uint256 amount, uint64 srcChain);
}
