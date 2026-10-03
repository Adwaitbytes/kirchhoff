// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CREReceiver} from "./CREReceiver.sol";
import {IConservationLedger} from "./interfaces/IConservationLedger.sol";
import {IQuarantineController} from "./interfaces/IQuarantineController.sol";
import {Breach, Epoch, KirchhoffIds, ReportType, Status} from "./interfaces/KirchhoffTypes.sol";

/// @title ConservationLedger
/// @notice Per-chain record of every protected token's status, Δ and breach evidence. Written only by DON-signed CRE
/// reports delivered through the KeystoneForwarder, plus the issuer-Safe recovery path via the QuarantineController.
/// Implements the report envelope and contract-enforced rules of docs/INTERFACES.md.
contract ConservationLedger is CREReceiver, IConservationLedger {
    struct TokenState {
        bool registered;
        Status status;
        uint64 stalenessSeconds;
        uint64 updatedAt;
        uint64 recoveryEndsAt;
        uint64 revision;
        // Highest epochId seen in any EPOCH or RECOVERY_CHECK, including EPOCHs ignored during containment. The
        // production forwarder lets anyone retry a FAILED transmission, so ordering is checked against this mark:
        // a RECOVERY_CHECK that failed in an earlier incident cannot be replayed to clear a later one.
        uint64 highestEpochSeen;
        int256 delta;
        bytes32 activeIncident;
        Epoch latest;
    }

    /// @dev BREACH payload as frozen in docs/INTERFACES.md.
    struct BreachPayload {
        uint64 epochId;
        int256 delta;
        bytes32 blocksHash;
        bytes32 evidenceHash;
        uint16 reason;
        uint64 offendingChain;
        bytes32 offendingTx;
        address recipient;
        uint256 amount;
        bytes32 messageId;
    }

    uint64 public immutable override chainSelector;

    address public override quarantineController;
    mapping(bytes32 tokenId => TokenState) internal s_tokens;
    mapping(bytes32 messageId => bool) internal s_consumed;
    mapping(bytes32 incidentId => Breach) internal s_breaches;

    error WrongChainSelector(uint64 received, uint64 expected);
    error WrongLedger(address received, address expected);
    error UnknownReportType(uint8 reportType);
    error TokenNotRegistered(bytes32 tokenId);
    error TokenAlreadyRegistered(bytes32 tokenId);
    error InvalidStaleness();
    error QuarantineControllerAlreadySet();
    error QuarantineControllerNotSet();
    error ZeroAddress();
    error OnlyQuarantineController(address caller);
    error OnlyIssuer(address caller);
    error EpochNotIncreasing(uint64 received, uint64 latest);
    error InvalidEpochStatus(uint8 status);
    error IllegalTransition(Status from, Status to);
    error NotBroken(Status status);
    error NotQuarantined(Status status);
    error NotRecovering(Status status);
    error IncidentMismatch(bytes32 received, bytes32 expected);
    error RecoveryTimelockActive(uint64 recoveryEndsAt);
    error NegativeDelta(int256 delta);

    constructor(address forwarder, ForwarderMode mode, uint64 chainSelector_, address initialOwner)
        CREReceiver(forwarder, mode, initialOwner)
    {
        chainSelector = chainSelector_;
    }

    // ================================================================
    // Administration
    // ================================================================

    /// @notice One-shot wiring; the controller and ledger reference each other, so one must be set after deploy.
    function setQuarantineController(address controller) external onlyOwner {
        if (quarantineController != address(0)) revert QuarantineControllerAlreadySet();
        if (controller == address(0)) revert ZeroAddress();
        quarantineController = controller;
        emit QuarantineControllerSet(controller);
    }

    /// @inheritdoc IConservationLedger
    function registerToken(bytes32 tokenId, uint64 stalenessSeconds_) external onlyOwner {
        TokenState storage t = s_tokens[tokenId];
        if (t.registered) revert TokenAlreadyRegistered(tokenId);
        if (stalenessSeconds_ == 0) revert InvalidStaleness();
        t.registered = true;
        t.stalenessSeconds = stalenessSeconds_;
        emit TokenRegistered(tokenId, stalenessSeconds_);
    }

    /// @notice Loosening staleness weakens fail-closed behaviour, so only the token's issuer Safe may change it.
    function setStalenessSeconds(bytes32 tokenId, uint64 stalenessSeconds_) external {
        TokenState storage t = _registered(tokenId);
        if (msg.sender != IQuarantineController(_controller()).issuerOf(tokenId)) revert OnlyIssuer(msg.sender);
        if (stalenessSeconds_ == 0) revert InvalidStaleness();
        t.stalenessSeconds = stalenessSeconds_;
        emit StalenessUpdated(tokenId, stalenessSeconds_);
    }

    /// @inheritdoc IConservationLedger
    function beginRecovery(bytes32 tokenId, bytes32 incidentId, uint64 recoveryEndsAt_) external {
        if (msg.sender != quarantineController) revert OnlyQuarantineController(msg.sender);
        TokenState storage t = _registered(tokenId);
        if (t.status != Status.QUARANTINED) revert NotQuarantined(t.status);
        if (incidentId != t.activeIncident) revert IncidentMismatch(incidentId, t.activeIncident);
        t.recoveryEndsAt = recoveryEndsAt_;
        _setStatus(t, tokenId, Status.RECOVERING, s_breaches[incidentId].reason);
        _touch(t);
        emit RecoveryStarted(tokenId, incidentId, recoveryEndsAt_);
    }

    // ================================================================
    // CRE reports
    // ================================================================

    /// @dev report = abi.encode(uint8 reportType, uint64 chainSelector, address ledger, bytes32 tokenId, bytes payload)
    function _processReport(bytes32 workflowId, uint8 allowedReportTypes, bytes calldata report) internal override {
        (uint8 reportType, uint64 selector, address ledger, bytes32 tokenId, bytes memory payload) =
            abi.decode(report, (uint8, uint64, address, bytes32, bytes));

        // Replay protection (PRD threat 8): a report is bound to exactly one chain and one ledger.
        if (selector != chainSelector) revert WrongChainSelector(selector, chainSelector);
        if (ledger != address(this)) revert WrongLedger(ledger, address(this));
        if (reportType < ReportType.EPOCH || reportType > ReportType.RECOVERY_CHECK) {
            revert UnknownReportType(reportType);
        }
        if (allowedReportTypes & (1 << reportType) == 0) revert ReportTypeNotAllowed(workflowId, reportType);

        TokenState storage t = _registered(tokenId);
        if (reportType == ReportType.EPOCH) _applyEpoch(t, tokenId, payload);
        else if (reportType == ReportType.BREACH) _applyBreach(t, tokenId, payload);
        else if (reportType == ReportType.QUARANTINE_APPLIED) _applyQuarantine(t, tokenId, payload);
        else _applyRecoveryCheck(t, tokenId, payload);
    }

    function _applyEpoch(TokenState storage t, bytes32 tokenId, bytes memory payload) internal {
        (
            uint64 epochId,
            int256 delta,
            bytes32 blocksHash,
            bytes32 evidenceHash,
            uint8 rawStatus,
            uint16 reason,
            bytes32[] memory settledMessageIds
        ) = abi.decode(payload, (uint64, int256, bytes32, bytes32, uint8, uint16, bytes32[]));

        // An epoch can never lift a token out of containment; only RECOVERY_CHECK after the Safe's resolve can.
        // Ignored rather than reverted so W2's regular cadence keeps succeeding during an incident.
        if (t.status == Status.BROKEN || t.status == Status.QUARANTINED || t.status == Status.RECOVERING) {
            if (epochId > t.highestEpochSeen) t.highestEpochSeen = epochId;
            return;
        }

        // Decoded as uint8 so an out-of-range value gets a descriptive error instead of an ABI decoding revert.
        if (rawStatus != uint8(Status.CONSERVED) && rawStatus != uint8(Status.DRIFT)) {
            revert InvalidEpochStatus(rawStatus);
        }
        Status status = Status(rawStatus);
        if (t.status == Status.UNKNOWN && status != Status.CONSERVED) revert IllegalTransition(t.status, status);
        _requireNewEpoch(t, epochId);

        for (uint256 i = 0; i < settledMessageIds.length; ++i) {
            bytes32 messageId = settledMessageIds[i];
            if (!s_consumed[messageId]) {
                s_consumed[messageId] = true;
                emit MessageConsumed(tokenId, messageId);
            }
        }

        _recordEpoch(t, tokenId, epochId, delta, blocksHash, evidenceHash, status, reason);
    }

    function _applyBreach(TokenState storage t, bytes32 tokenId, bytes memory payload) internal {
        // Every BREACH payload field is static, so the flat tuple encoding equals the static struct encoding.
        BreachPayload memory p = abi.decode(payload, (BreachPayload));
        Breach memory b = Breach({
            tokenId: tokenId,
            epochId: p.epochId,
            delta: p.delta,
            blocksHash: p.blocksHash,
            evidenceHash: p.evidenceHash,
            reason: p.reason,
            offendingChain: p.offendingChain,
            offendingTx: p.offendingTx,
            recipient: p.recipient,
            amount: p.amount,
            messageId: p.messageId,
            recordedAt: uint64(block.timestamp)
        });

        bytes32 incidentId = KirchhoffIds.incidentId(tokenId, b.evidenceHash);
        // W1 writes the same BREACH to every chain and CRE may redeliver; the same evidence is one incident, so a
        // repeat is a no-op instead of a revert that would show up as a failed transmission.
        if (s_breaches[incidentId].recordedAt != 0) return;
        s_breaches[incidentId] = b;

        t.delta = b.delta;
        emit IncidentOpened(tokenId, incidentId, b.evidenceHash);
        emit BreachRecorded(tokenId, b.reason, b.evidenceHash, b.offendingChain, b.offendingTx, b.recipient, b.amount);

        // Extra evidence on an already contained token does not change status (docs/INTERFACES.md). A breach during
        // RECOVERING re-breaks the token: recovery must start over from the new incident.
        if (t.status != Status.BROKEN && t.status != Status.QUARANTINED) {
            t.activeIncident = incidentId;
            t.recoveryEndsAt = 0;
            _setStatus(t, tokenId, Status.BROKEN, b.reason);
        }
        _touch(t);

        // Containment still applies to the new recipient even when status is unchanged.
        IQuarantineController(_controller()).onBreach(tokenId, incidentId, b.recipient);
    }

    function _applyQuarantine(TokenState storage t, bytes32 tokenId, bytes memory payload) internal {
        (bytes32 incidentId, address[] memory tainted) = abi.decode(payload, (bytes32, address[]));
        if (t.status != Status.BROKEN) revert NotBroken(t.status);
        if (incidentId != t.activeIncident) revert IncidentMismatch(incidentId, t.activeIncident);

        _setStatus(t, tokenId, Status.QUARANTINED, s_breaches[incidentId].reason);
        _touch(t);
        IQuarantineController(_controller()).onQuarantineApplied(tokenId, incidentId, tainted);
    }

    function _applyRecoveryCheck(TokenState storage t, bytes32 tokenId, bytes memory payload) internal {
        (uint64 epochId, int256 delta, bytes32 blocksHash) = abi.decode(payload, (uint64, int256, bytes32));
        if (t.status != Status.RECOVERING) revert NotRecovering(t.status);
        if (block.timestamp < t.recoveryEndsAt) revert RecoveryTimelockActive(t.recoveryEndsAt);
        if (delta < 0) revert NegativeDelta(delta);
        _requireNewEpoch(t, epochId);

        t.recoveryEndsAt = 0;
        t.activeIncident = bytes32(0);
        _recordEpoch(t, tokenId, epochId, delta, blocksHash, bytes32(0), Status.CONSERVED, 0);
        IQuarantineController(_controller()).onRecovered(tokenId);
    }

    // ================================================================
    // Internal state helpers
    // ================================================================

    function _recordEpoch(
        TokenState storage t,
        bytes32 tokenId,
        uint64 epochId,
        int256 delta,
        bytes32 blocksHash,
        bytes32 evidenceHash,
        Status status,
        uint16 reason
    ) internal {
        t.latest = Epoch(epochId, delta, uint64(block.timestamp), blocksHash, evidenceHash, status, reason);
        t.delta = delta;
        _setStatus(t, tokenId, status, reason);
        _touch(t);
        emit EpochRecorded(tokenId, epochId, delta, status);
    }

    function _requireNewEpoch(TokenState storage t, uint64 epochId) internal {
        if (epochId <= t.highestEpochSeen) revert EpochNotIncreasing(epochId, t.highestEpochSeen);
        t.highestEpochSeen = epochId;
    }

    function _setStatus(TokenState storage t, bytes32 tokenId, Status to, uint16 reason) internal {
        Status from = t.status;
        if (from == to) return;
        t.status = to;
        emit StatusChanged(tokenId, from, to, reason);
    }

    function _touch(TokenState storage t) internal {
        t.updatedAt = uint64(block.timestamp);
        ++t.revision;
    }

    function _registered(bytes32 tokenId) internal view returns (TokenState storage t) {
        t = s_tokens[tokenId];
        if (!t.registered) revert TokenNotRegistered(tokenId);
    }

    function _controller() internal view returns (address controller) {
        controller = quarantineController;
        if (controller == address(0)) revert QuarantineControllerNotSet();
    }

    // ================================================================
    // Views
    // ================================================================

    /// @inheritdoc IConservationLedger
    function statusOf(bytes32 tokenId)
        external
        view
        returns (Status status, int256 delta, uint64 updatedAt, bool stale)
    {
        TokenState storage t = s_tokens[tokenId];
        status = t.status;
        delta = t.delta;
        updatedAt = t.updatedAt;
        // Unregistered tokens report stale so every consumer fails closed on them.
        stale = !t.registered || block.timestamp - updatedAt > t.stalenessSeconds;
    }

    function latestEpoch(bytes32 tokenId) external view returns (Epoch memory) {
        return s_tokens[tokenId].latest;
    }

    function isConsumed(bytes32 messageId) external view returns (bool) {
        return s_consumed[messageId];
    }

    function isRegistered(bytes32 tokenId) external view returns (bool) {
        return s_tokens[tokenId].registered;
    }

    function stalenessSeconds(bytes32 tokenId) external view returns (uint64) {
        return s_tokens[tokenId].stalenessSeconds;
    }

    function recoveryEndsAt(bytes32 tokenId) external view returns (uint64) {
        return s_tokens[tokenId].recoveryEndsAt;
    }

    function activeIncident(bytes32 tokenId) external view returns (bytes32) {
        return s_tokens[tokenId].activeIncident;
    }

    function breachOf(bytes32 incidentId) external view returns (Breach memory) {
        return s_breaches[incidentId];
    }

    function revisionOf(bytes32 tokenId) external view returns (uint64) {
        return s_tokens[tokenId].revision;
    }
}
