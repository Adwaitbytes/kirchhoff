// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBridgeEvents} from "./IBridgeEvents.sol";

/// @title BridgeRegistry (TESTNET SIMULATION ONLY)
/// @notice Debit/credit registry plus the frozen `Burned` / `Released` events, shared by WeakBridge (remote chains)
/// and HomeEscrowAdapter (home chain). Signatures frozen by docs/INTERFACES.md Revision 2: CRE allows 15 EVM reads
/// and 100-block log queries per execution, so W1 confirms a debit with one `debitOf` call at the pinned block.
abstract contract BridgeRegistry is IBridgeEvents {
    struct Entry {
        uint256 amount; // 0 means no entry
        address account; // debit: recipient on the destination chain; credit: recipient here
        uint64 chain; // debit: destination chain selector; credit: source chain selector
        uint64 blockNumber;
    }

    mapping(bytes32 id => Entry) internal s_debits;
    mapping(bytes32 id => Entry) internal s_credits;

    error DuplicateDebit(bytes32 id);
    error DuplicateCredit(bytes32 id);

    /// @notice amount 0 means no debit with this id exists on this chain.
    function debitOf(bytes32 id)
        external
        view
        virtual
        returns (uint256 amount, address recipient, uint64 dstChain, uint64 blockNumber)
    {
        Entry storage e = s_debits[id];
        return (e.amount, e.account, e.chain, e.blockNumber);
    }

    /// @notice amount 0 means no credit with this id exists on this chain.
    function creditOf(bytes32 id)
        external
        view
        virtual
        returns (uint256 amount, address recipient, uint64 srcChain, uint64 blockNumber)
    {
        Entry storage e = s_credits[id];
        return (e.amount, e.account, e.chain, e.blockNumber);
    }

    function _recordDebit(bytes32 id, address from, address to, uint256 amount, uint64 dstChain) internal {
        if (s_debits[id].amount != 0) revert DuplicateDebit(id);
        s_debits[id] = Entry(amount, to, dstChain, uint64(block.number));
        emit Burned(id, from, to, amount, dstChain);
    }

    function _recordCredit(bytes32 id, address to, uint256 amount, uint64 srcChain) internal {
        if (s_credits[id].amount != 0) revert DuplicateCredit(id);
        s_credits[id] = Entry(amount, to, srcChain, uint64(block.number));
        // The only prior external call on this path is a view (WeakBridge home mode reads escrow.creditOf).
        // forge-lint: disable-next-line(reentrancy-events)
        emit Released(id, to, amount, srcChain);
    }
}
