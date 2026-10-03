// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Home-chain registry of KIRCH-SPEC hashes with an issuer-Safe-gated, timelocked activation (PRD section 6
/// "Spec lifecycle"). The Judge compares the active spec hash with its cache (SPEC_MISMATCH).
interface IKirchhoffRegistry {
    struct Spec {
        bytes32 specHash;
        string specURI;
        uint64 version; // increments on every activation, 0 when no spec was ever activated
        uint64 activatedAt;
    }

    struct PendingSpec {
        bytes32 specHash;
        string specURI;
        uint64 eta; // earliest activation timestamp, 0 when nothing is pending
    }

    event TokenRegistered(bytes32 indexed tokenId, string symbol, address indexed issuerSafe);
    event SpecProposed(bytes32 indexed tokenId, bytes32 indexed specHash, string specURI, uint64 eta);
    event SpecProposalCancelled(bytes32 indexed tokenId, bytes32 indexed specHash);
    event SpecActivated(bytes32 indexed tokenId, bytes32 indexed specHash, string specURI, uint64 version);
    event IssuerSafeChanged(bytes32 indexed tokenId, address indexed previousSafe, address indexed newSafe);

    function registerToken(string calldata symbol, address issuerSafe) external returns (bytes32 tokenId);
    function proposeSpec(bytes32 tokenId, bytes32 specHash, string calldata specURI) external; // issuer Safe only
    function cancelSpec(bytes32 tokenId) external; // issuer Safe only
    function activateSpec(bytes32 tokenId) external; // anyone, once the timelock has elapsed
    function setIssuerSafe(bytes32 tokenId, address newSafe) external; // issuer Safe only

    function timelockSeconds() external view returns (uint64);
    function issuerOf(bytes32 tokenId) external view returns (address);
    function activeSpec(bytes32 tokenId) external view returns (Spec memory);
    function pendingSpec(bytes32 tokenId) external view returns (PendingSpec memory);
    function activeSpecHash(bytes32 tokenId) external view returns (bytes32);
}
