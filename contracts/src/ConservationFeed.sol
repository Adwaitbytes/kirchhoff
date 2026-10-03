// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IConservationFeed} from "./interfaces/IConservationFeed.sol";
import {IConservationLedger} from "./interfaces/IConservationLedger.sol";
import {Status} from "./interfaces/KirchhoffTypes.sol";

/// @title ConservationFeed
/// @notice AggregatorV3-compatible view over ConservationLedger for one token. `answer` is the token Status.
/// Healthy answers (CONSERVED, DRIFT) degrade to UNKNOWN (0) when stale; BROKEN and worse are always reported as is,
/// so a stalled engine can never hide a breach (docs/INTERFACES.md "Staleness").
/// @dev The ledger keeps only the latest state, so getRoundData serves the latest round and reverts for any other
/// roundId, like a Chainlink aggregator asked for a round it does not hold. roundId is the ledger's per-token
/// revision, which increments on every applied write, so consumers see a new round whenever the answer can change.
contract ConservationFeed is IConservationFeed {
    uint256 public constant override version = 1;

    IConservationLedger internal immutable i_ledger;
    bytes32 public immutable override tokenId;
    string internal s_description;

    error ZeroAddress();
    error NoDataPresent();

    constructor(IConservationLedger ledger_, bytes32 tokenId_, string memory description_) {
        if (address(ledger_) == address(0)) revert ZeroAddress();
        i_ledger = ledger_;
        tokenId = tokenId_;
        s_description = description_;
    }

    function decimals() external pure returns (uint8) {
        return 0;
    }

    function description() external view returns (string memory) {
        return s_description;
    }

    function ledger() external view returns (address) {
        return address(i_ledger);
    }

    function latestDelta() external view returns (int256 delta) {
        (, delta,,) = i_ledger.statusOf(tokenId);
    }

    function latestRoundData()
        public
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        (Status status,, uint64 updated, bool stale) = i_ledger.statusOf(tokenId);
        roundId = uint80(i_ledger.revisionOf(tokenId));
        answer = (stale && (status == Status.CONSERVED || status == Status.DRIFT))
            ? int256(uint256(Status.UNKNOWN))
            : int256(uint256(status));
        startedAt = updated;
        updatedAt = updated;
        answeredInRound = roundId;
    }

    function getRoundData(uint80 requestedRoundId)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        (roundId, answer, startedAt, updatedAt, answeredInRound) = latestRoundData();
        if (requestedRoundId != roundId || roundId == 0) revert NoDataPresent();
    }
}
