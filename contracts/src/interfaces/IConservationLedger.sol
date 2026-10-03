// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Breach, Epoch, Status} from "./KirchhoffTypes.sol";

/// @notice PRD section 7 core interface, plus the registration, recovery and read extras that docs/INTERFACES.md
/// relies on (stalenessSeconds, incidents, revision for the feed's roundId).
interface IConservationLedger {
    // ---- PRD section 7 (frozen) ----
    event EpochRecorded(bytes32 indexed tokenId, uint64 indexed epochId, int256 delta, Status status);
    event StatusChanged(bytes32 indexed tokenId, Status from, Status to, uint16 reason);
    event BreachRecorded(
        bytes32 indexed tokenId,
        uint16 reason,
        bytes32 evidenceHash,
        uint64 offendingChain,
        bytes32 offendingTx,
        address recipient,
        uint256 amount
    );

    function statusOf(bytes32 tokenId) external view returns (Status status, int256 delta, uint64 updatedAt, bool stale);
    function latestEpoch(bytes32 tokenId) external view returns (Epoch memory);
    function isConsumed(bytes32 messageId) external view returns (bool); // debit already matched to a credit

    // ---- Extras ----
    event TokenRegistered(bytes32 indexed tokenId, uint64 stalenessSeconds);
    event StalenessUpdated(bytes32 indexed tokenId, uint64 stalenessSeconds);
    event QuarantineControllerSet(address indexed quarantineController);
    event MessageConsumed(bytes32 indexed tokenId, bytes32 indexed messageId);
    event IncidentOpened(bytes32 indexed tokenId, bytes32 indexed incidentId, bytes32 evidenceHash);
    event RecoveryStarted(bytes32 indexed tokenId, bytes32 indexed incidentId, uint64 recoveryEndsAt);

    /// @notice Registers a protected token. Only registered tokens accept reports (PRD "UNKNOWN-without-spec").
    function registerToken(bytes32 tokenId, uint64 stalenessSeconds) external;

    /// @notice Moves QUARANTINED to RECOVERING. Callable only by the QuarantineController (issuer Safe path).
    function beginRecovery(bytes32 tokenId, bytes32 incidentId, uint64 recoveryEndsAt) external;

    function isRegistered(bytes32 tokenId) external view returns (bool);
    function stalenessSeconds(bytes32 tokenId) external view returns (uint64);
    function recoveryEndsAt(bytes32 tokenId) external view returns (uint64);
    /// @notice The incident that most recently moved the token to BROKEN; zero if none.
    function activeIncident(bytes32 tokenId) external view returns (bytes32);
    function breachOf(bytes32 incidentId) external view returns (Breach memory);
    /// @notice Increments on every applied state write for the token; the ConservationFeed uses it as roundId.
    function revisionOf(bytes32 tokenId) external view returns (uint64);
    function chainSelector() external view returns (uint64);
    function quarantineController() external view returns (address);
}
