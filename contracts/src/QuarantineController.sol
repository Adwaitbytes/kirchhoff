// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IConservationLedger} from "./interfaces/IConservationLedger.sol";
import {IQuarantineController} from "./interfaces/IQuarantineController.sol";

/// @title QuarantineController
/// @notice Containment state for protected tokens on one chain: CCIP lane freeze, tainted accounts and the issuer-Safe
/// incident resolution that starts the recovery timelock. Breach-driven writes come only from the ConservationLedger;
/// every release of containment (resolve, untaint) comes only from the token's issuer Safe.
contract QuarantineController is IQuarantineController, Ownable2Step {
    struct TokenConfig {
        address issuerSafe;
        uint64 recoveryTimelockSeconds;
    }

    IConservationLedger public immutable ledger;

    mapping(bytes32 tokenId => TokenConfig) internal s_config;
    mapping(bytes32 tokenId => bool) internal s_frozen;
    mapping(bytes32 tokenId => mapping(address account => bool)) internal s_tainted;

    error ZeroAddress();
    error OnlyLedger(address caller);
    error OnlyIssuer(address caller);
    error TokenAlreadyConfigured(bytes32 tokenId);
    error TokenNotConfigured(bytes32 tokenId);
    error InvalidRecoveryTimelock();

    constructor(IConservationLedger ledger_, address initialOwner) Ownable(initialOwner) {
        if (address(ledger_) == address(0)) revert ZeroAddress();
        ledger = ledger_;
    }

    modifier onlyLedger() {
        if (msg.sender != address(ledger)) revert OnlyLedger(msg.sender);
        _;
    }

    modifier onlyIssuer(bytes32 tokenId) {
        address issuer = s_config[tokenId].issuerSafe;
        if (issuer == address(0)) revert TokenNotConfigured(tokenId);
        if (msg.sender != issuer) revert OnlyIssuer(msg.sender);
        _;
    }

    // ================================================================
    // Configuration
    // ================================================================

    /// @notice One-shot: after this the operator has no say over the token; the issuer Safe controls everything.
    function configureToken(bytes32 tokenId, address issuerSafe, uint64 recoveryTimelockSeconds) external onlyOwner {
        if (s_config[tokenId].issuerSafe != address(0)) revert TokenAlreadyConfigured(tokenId);
        if (issuerSafe == address(0)) revert ZeroAddress();
        if (recoveryTimelockSeconds == 0) revert InvalidRecoveryTimelock();
        s_config[tokenId] = TokenConfig(issuerSafe, recoveryTimelockSeconds);
        emit TokenConfigured(tokenId, issuerSafe, recoveryTimelockSeconds);
    }

    function setIssuerSafe(bytes32 tokenId, address newSafe) external onlyIssuer(tokenId) {
        if (newSafe == address(0)) revert ZeroAddress();
        emit IssuerSafeChanged(tokenId, s_config[tokenId].issuerSafe, newSafe);
        s_config[tokenId].issuerSafe = newSafe;
    }

    function setRecoveryTimelock(bytes32 tokenId, uint64 recoveryTimelockSeconds) external onlyIssuer(tokenId) {
        if (recoveryTimelockSeconds == 0) revert InvalidRecoveryTimelock();
        s_config[tokenId].recoveryTimelockSeconds = recoveryTimelockSeconds;
        emit RecoveryTimelockChanged(tokenId, recoveryTimelockSeconds);
    }

    // ================================================================
    // Ledger hooks
    // ================================================================

    /// @inheritdoc IQuarantineController
    function onBreach(bytes32 tokenId, bytes32 incidentId, address recipient) external onlyLedger {
        s_frozen[tokenId] = true;
        emit LanesFrozen(tokenId, incidentId);
        // A Loop Rule deficit has no single recipient; W2 reports address(0) and only the freeze applies.
        if (recipient != address(0)) _taint(tokenId, recipient, incidentId);
    }

    /// @inheritdoc IQuarantineController
    function onQuarantineApplied(bytes32 tokenId, bytes32 incidentId, address[] calldata accounts) external onlyLedger {
        for (uint256 i = 0; i < accounts.length; ++i) {
            if (accounts[i] != address(0)) _taint(tokenId, accounts[i], incidentId);
        }
    }

    /// @inheritdoc IQuarantineController
    function onRecovered(bytes32 tokenId) external onlyLedger {
        s_frozen[tokenId] = false;
        emit LanesUnfrozen(tokenId);
    }

    // ================================================================
    // Issuer Safe actions
    // ================================================================

    /// @inheritdoc IQuarantineController
    /// @dev The ledger enforces that the token is QUARANTINED and that incidentId is its active incident.
    function resolve(bytes32 tokenId, bytes32 incidentId) external onlyIssuer(tokenId) {
        uint64 recoveryEndsAt = uint64(block.timestamp) + s_config[tokenId].recoveryTimelockSeconds;
        // Emitted first so the log order is fixed regardless of what the ledger emits; a ledger revert undoes both.
        emit IncidentResolved(tokenId, incidentId, recoveryEndsAt);
        ledger.beginRecovery(tokenId, incidentId, recoveryEndsAt);
    }

    /// @inheritdoc IQuarantineController
    function untaint(bytes32 tokenId, address[] calldata accounts) external onlyIssuer(tokenId) {
        for (uint256 i = 0; i < accounts.length; ++i) {
            if (s_tainted[tokenId][accounts[i]]) {
                s_tainted[tokenId][accounts[i]] = false;
                emit Untainted(tokenId, accounts[i]);
            }
        }
    }

    // ================================================================
    // Views
    // ================================================================

    function isFrozen(bytes32 tokenId) external view returns (bool) {
        return s_frozen[tokenId];
    }

    function isTainted(bytes32 tokenId, address account) external view returns (bool) {
        return s_tainted[tokenId][account];
    }

    function issuerOf(bytes32 tokenId) external view returns (address) {
        return s_config[tokenId].issuerSafe;
    }

    function recoveryTimelockOf(bytes32 tokenId) external view returns (uint64) {
        return s_config[tokenId].recoveryTimelockSeconds;
    }

    function _taint(bytes32 tokenId, address account, bytes32 incidentId) internal {
        if (s_tainted[tokenId][account]) return;
        s_tainted[tokenId][account] = true;
        emit Tainted(tokenId, account, incidentId);
    }
}
