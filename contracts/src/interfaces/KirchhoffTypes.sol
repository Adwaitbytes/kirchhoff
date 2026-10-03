// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Token status, frozen by docs/INTERFACES.md. The numeric value is also the ConservationFeed answer.
enum Status {
    UNKNOWN,
    CONSERVED,
    DRIFT,
    BROKEN,
    QUARANTINED,
    RECOVERING
}

/// @notice One Conservation Engine evaluation as recorded onchain (PRD section 7).
struct Epoch {
    uint64 epochId; // strictly increasing per token
    int256 delta; // backing minus claims, token base units
    uint64 evaluatedAt; // block timestamp of the report write
    bytes32 blocksHash; // keccak of pinned (chainSelector, blockNumber) pairs
    bytes32 evidenceHash; // keccak of the evidence bundle (IPFS CID stored offchain)
    Status status;
    uint16 reason; // reason code from PRD section 6
}

/// @notice Evidence stored for every recorded breach, keyed by incidentId.
struct Breach {
    bytes32 tokenId;
    uint64 epochId; // informational only, never ordering-checked
    int256 delta;
    bytes32 blocksHash;
    bytes32 evidenceHash;
    uint16 reason;
    uint64 offendingChain;
    bytes32 offendingTx;
    address recipient;
    uint256 amount;
    bytes32 messageId;
    uint64 recordedAt;
}

/// @notice CRE report types (uint8 on the wire). Values are frozen by docs/INTERFACES.md and start at 1, so they
/// are constants rather than a Solidity enum (which would start at 0).
library ReportType {
    uint8 internal constant EPOCH = 1;
    uint8 internal constant BREACH = 2;
    uint8 internal constant QUARANTINE_APPLIED = 3;
    uint8 internal constant RECOVERY_CHECK = 4;
}

/// @notice Reason codes (uint16), frozen by docs/INTERFACES.md.
library Reason {
    uint16 internal constant OK = 0;
    uint16 internal constant PENDING_ATTESTATION = 1;
    uint16 internal constant DEBIT_NOT_FOUND = 2;
    uint16 internal constant AMOUNT_MISMATCH = 3;
    uint16 internal constant RECIPIENT_MISMATCH = 4;
    uint16 internal constant DOUBLE_CREDIT = 5;
    uint16 internal constant LOOP_DEFICIT = 6;
    uint16 internal constant RESERVE_SHORTFALL = 7;
    uint16 internal constant FLOW_LIMIT = 8;
    uint16 internal constant STATUS_STALE = 9;
    uint16 internal constant TOKEN_BROKEN = 10;
    uint16 internal constant TOKEN_QUARANTINED = 11;
    uint16 internal constant UNKNOWN_TOKEN = 12;
    uint16 internal constant SPEC_MISMATCH = 13;
    uint16 internal constant TOKEN_RECOVERING = 14;
}

/// @notice Identifier helpers shared with W3 and the API (docs/INTERFACES.md "Identifiers").
library KirchhoffIds {
    function tokenId(string memory symbol) internal pure returns (bytes32) {
        return keccak256(bytes(symbol));
    }

    function incidentId(bytes32 tokenId_, bytes32 evidenceHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(tokenId_, evidenceHash));
    }
}
