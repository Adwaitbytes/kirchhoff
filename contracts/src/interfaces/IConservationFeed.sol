// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AggregatorV3Interface} from "./AggregatorV3Interface.sol";

/// @notice AggregatorV3-compatible status feed. answer is a Status value (docs/INTERFACES.md "Staleness").
interface IConservationFeed is AggregatorV3Interface {
    function ledger() external view returns (address);
    function tokenId() external view returns (bytes32);
    /// @notice Latest Δ (backing minus claims) as recorded by the ledger, for UIs and vaults that want the number.
    function latestDelta() external view returns (int256);
}
