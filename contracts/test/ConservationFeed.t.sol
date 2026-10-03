// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ConservationFeed} from "../src/ConservationFeed.sol";
import {IConservationLedger} from "../src/interfaces/IConservationLedger.sol";
import {Reason, Status} from "../src/interfaces/KirchhoffTypes.sol";

import {KirchhoffTestBase} from "./utils/KirchhoffTestBase.sol";

contract ConservationFeedTest is KirchhoffTestBase {
    ConservationFeed internal feed;

    function setUp() public {
        _deployCore(HOME_SELECTOR);
        feed = new ConservationFeed(ledger, KETH_ID, "KIRCHHOFF kETH status");
    }

    function _answer() internal view returns (int256 answer) {
        (, answer,,,) = feed.latestRoundData();
    }

    function test_metadata() public {
        assertEq(feed.decimals(), 0);
        assertEq(feed.version(), 1);
        assertEq(feed.description(), "KIRCHHOFF kETH status");
        assertEq(feed.ledger(), address(ledger));
        assertEq(feed.tokenId(), KETH_ID);
        vm.expectRevert(ConservationFeed.ZeroAddress.selector);
        new ConservationFeed(IConservationLedger(address(0)), KETH_ID, "");
    }

    function test_unknownBeforeFirstEpoch() public view {
        (uint80 roundId, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        assertEq(roundId, 0);
        assertEq(answer, 0);
        assertEq(updatedAt, 0);
    }

    function test_answersFollowStatus() public {
        _epoch(1, 4, Status.CONSERVED);
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            feed.latestRoundData();
        assertEq(answer, 1);
        assertEq(roundId, 1);
        assertEq(answeredInRound, 1);
        assertEq(startedAt, block.timestamp);
        assertEq(updatedAt, block.timestamp);
        assertEq(feed.latestDelta(), 4);

        _epoch(2, 0, Status.DRIFT);
        assertEq(_answer(), 2);

        _breach(keccak256("ev"), Reason.DEBIT_NOT_FOUND, attacker, 9);
        assertEq(_answer(), 3);
        assertEq(feed.latestDelta(), -9);

        _quarantineApplied(_incident(keccak256("ev")), _one(attacker));
        assertEq(_answer(), 4);

        vm.prank(safe);
        quarantine.resolve(KETH_ID, _incident(keccak256("ev")));
        assertEq(_answer(), 5);
        (roundId,,,,) = feed.latestRoundData();
        assertEq(roundId, 5, "every applied write is a new round");
    }

    function test_staleHealthyAnswersUnknown() public {
        _epoch(1, 0, Status.CONSERVED);
        vm.warp(block.timestamp + STALENESS + 1);
        assertEq(_answer(), 0);

        _epoch(2, 0, Status.DRIFT);
        vm.warp(block.timestamp + STALENESS + 1);
        assertEq(_answer(), 0);
    }

    function test_staleBrokenStillReportsBroken() public {
        _breach(keccak256("ev"), Reason.DEBIT_NOT_FOUND, attacker, 9);
        vm.warp(block.timestamp + 10 days);
        assertEq(_answer(), 3);
        _quarantineApplied(_incident(keccak256("ev")), _one(attacker));
        vm.warp(block.timestamp + 10 days);
        assertEq(_answer(), 4);
        vm.prank(safe);
        quarantine.resolve(KETH_ID, _incident(keccak256("ev")));
        vm.warp(block.timestamp + 10 days);
        assertEq(_answer(), 5);
    }

    function test_getRoundData() public {
        vm.expectRevert(ConservationFeed.NoDataPresent.selector);
        feed.getRoundData(0);

        _epoch(1, 0, Status.CONSERVED);
        (uint80 roundId, int256 answer,,,) = feed.getRoundData(1);
        assertEq(roundId, 1);
        assertEq(answer, 1);

        _epoch(2, 0, Status.CONSERVED);
        vm.expectRevert(ConservationFeed.NoDataPresent.selector);
        feed.getRoundData(1);
    }
}
