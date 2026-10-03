// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/// @title KirchhoffProtected
/// @notice Drop-in guard for lending markets and vaults (PRD section 13): revert unless the collateral's
/// ConservationFeed is fresh and reports CONSERVED or DRIFT.
abstract contract KirchhoffProtected {
    AggregatorV3Interface public immutable kirchhoffFeed; // ConservationFeed for this collateral
    uint256 public constant MAX_AGE = 300; // seconds

    error CollateralNotConserved(int256 status);
    error CollateralStatusStale(uint256 age);

    constructor(address feed) {
        kirchhoffFeed = AggregatorV3Interface(feed);
    }

    function _requireConserved() internal view {
        (, int256 s,, uint256 updatedAt,) = kirchhoffFeed.latestRoundData();
        if (block.timestamp - updatedAt > MAX_AGE) revert CollateralStatusStale(block.timestamp - updatedAt);
        if (s != 1 && s != 2) revert CollateralNotConserved(s); // 1 CONSERVED, 2 DRIFT
    }
}
