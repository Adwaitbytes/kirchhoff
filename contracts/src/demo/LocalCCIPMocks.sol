// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title LocalRouterMock (LOCAL ANVIL / TESTS ONLY)
/// @notice The two IRouter views a CCIP 2.0.0 TokenPool consults (`getOnRamp`, `isOffRamp`), with owner-set ramps, so
/// the Kirchhoff pools can be deployed and exercised on a local chain without a CCIP deployment. Never used on
/// testnets, where Deploy.s.sol requires the real router.
contract LocalRouterMock is Ownable {
    mapping(uint64 chainSelector => address) internal s_onRamps;
    mapping(uint64 chainSelector => mapping(address offRamp => bool)) internal s_offRamps;

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setOnRamp(uint64 destChainSelector, address onRamp) external onlyOwner {
        s_onRamps[destChainSelector] = onRamp;
    }

    function setOffRamp(uint64 sourceChainSelector, address offRamp, bool allowed) external onlyOwner {
        s_offRamps[sourceChainSelector][offRamp] = allowed;
    }

    function getOnRamp(uint64 destChainSelector) external view returns (address) {
        return s_onRamps[destChainSelector];
    }

    function isOffRamp(uint64 sourceChainSelector, address offRamp) external view returns (bool) {
        return s_offRamps[sourceChainSelector][offRamp];
    }
}

/// @title LocalRMNMock (LOCAL ANVIL / TESTS ONLY)
/// @notice IRMN curse views with owner-controlled curses.
contract LocalRMNMock is Ownable {
    mapping(bytes16 subject => bool) internal s_cursed;
    bool internal s_globalCurse;

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setCursed(bytes16 subject, bool cursed) external onlyOwner {
        s_cursed[subject] = cursed;
    }

    function setGlobalCurse(bool cursed) external onlyOwner {
        s_globalCurse = cursed;
    }

    function isCursed() external view returns (bool) {
        return s_globalCurse;
    }

    function isCursed(bytes16 subject) external view returns (bool) {
        return s_globalCurse || s_cursed[subject];
    }
}
