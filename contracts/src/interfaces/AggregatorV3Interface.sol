// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Chainlink AggregatorV3Interface, signature-identical to
/// chainlink/contracts 1.5.0 `shared/interfaces/AggregatorV3Interface.sol`. Redeclared so the
/// interfaces directory has no external imports and keeps the frozen 0.8.26 pragma.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function version() external view returns (uint256);
    function getRoundData(uint80 _roundId)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
