// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice PRD section 7 core interface plus the ledger-only hooks and issuer-Safe controls.
interface IQuarantineController {
    // ---- PRD section 7 (frozen) ----
    event LanesFrozen(bytes32 indexed tokenId, bytes32 indexed incidentId);
    event Tainted(bytes32 indexed tokenId, address indexed account, bytes32 indexed incidentId);
    event IncidentResolved(bytes32 indexed tokenId, bytes32 indexed incidentId, uint64 recoveryEndsAt);

    function isFrozen(bytes32 tokenId) external view returns (bool);
    function isTainted(bytes32 tokenId, address account) external view returns (bool);
    function resolve(bytes32 tokenId, bytes32 incidentId) external; // issuer Safe only

    // ---- Extras ----
    event LanesUnfrozen(bytes32 indexed tokenId);
    event Untainted(bytes32 indexed tokenId, address indexed account);
    event TokenConfigured(bytes32 indexed tokenId, address indexed issuerSafe, uint64 recoveryTimelockSeconds);
    event IssuerSafeChanged(bytes32 indexed tokenId, address indexed previousSafe, address indexed newSafe);
    event RecoveryTimelockChanged(bytes32 indexed tokenId, uint64 recoveryTimelockSeconds);

    /// @notice Ledger only: freeze lanes and taint the breach recipient.
    function onBreach(bytes32 tokenId, bytes32 incidentId, address recipient) external;
    /// @notice Ledger only: taint every address listed in a QUARANTINE_APPLIED report.
    function onQuarantineApplied(bytes32 tokenId, bytes32 incidentId, address[] calldata accounts) external;
    /// @notice Ledger only: unfreeze lanes after a successful RECOVERY_CHECK. Taints persist.
    function onRecovered(bytes32 tokenId) external;

    /// @notice Issuer Safe only: clear taints once the incident review is complete.
    function untaint(bytes32 tokenId, address[] calldata accounts) external;

    function issuerOf(bytes32 tokenId) external view returns (address);
    function recoveryTimelockOf(bytes32 tokenId) external view returns (uint64);
}
