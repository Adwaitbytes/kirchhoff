// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IKirchhoffRegistry} from "./interfaces/IKirchhoffRegistry.sol";
import {KirchhoffIds} from "./interfaces/KirchhoffTypes.sol";

/// @title KirchhoffRegistry
/// @notice Home-chain source of truth for each protected token's active KIRCH-SPEC. Spec changes are proposed by the
/// issuer Safe and only become active after the timelock (48h in production), so an attacker who compromises the
/// operator cannot loosen the rules first, and holders see every pending change (PRD threat 7).
contract KirchhoffRegistry is IKirchhoffRegistry, Ownable2Step {
    uint64 public constant PRODUCTION_TIMELOCK = 48 hours;
    /// @dev Testnet demo floor (PRD: "10 minutes on testnet"). Anything shorter would make the review window a fiction.
    uint64 public constant MIN_TIMELOCK = 10 minutes;

    uint64 public immutable override timelockSeconds;

    mapping(bytes32 tokenId => address) internal s_issuer;
    mapping(bytes32 tokenId => Spec) internal s_active;
    mapping(bytes32 tokenId => PendingSpec) internal s_pending;

    error ZeroAddress();
    error InvalidTimelock(uint64 timelockSeconds);
    error TokenAlreadyRegistered(bytes32 tokenId);
    error TokenNotRegistered(bytes32 tokenId);
    error OnlyIssuer(address caller);
    error EmptySpecHash();
    error EmptySymbol();
    error NoPendingSpec(bytes32 tokenId);
    error TimelockNotElapsed(uint64 eta);

    constructor(uint64 timelockSeconds_, address initialOwner) Ownable(initialOwner) {
        if (timelockSeconds_ < MIN_TIMELOCK || timelockSeconds_ > PRODUCTION_TIMELOCK) {
            revert InvalidTimelock(timelockSeconds_);
        }
        timelockSeconds = timelockSeconds_;
    }

    modifier onlyIssuer(bytes32 tokenId) {
        address issuer = s_issuer[tokenId];
        if (issuer == address(0)) revert TokenNotRegistered(tokenId);
        if (msg.sender != issuer) revert OnlyIssuer(msg.sender);
        _;
    }

    /// @inheritdoc IKirchhoffRegistry
    /// @dev One-shot per token: once registered, the operator has no further control over it.
    function registerToken(string calldata symbol, address issuerSafe) external onlyOwner returns (bytes32 tokenId) {
        if (bytes(symbol).length == 0) revert EmptySymbol();
        if (issuerSafe == address(0)) revert ZeroAddress();
        tokenId = KirchhoffIds.tokenId(symbol);
        if (s_issuer[tokenId] != address(0)) revert TokenAlreadyRegistered(tokenId);
        s_issuer[tokenId] = issuerSafe;
        emit TokenRegistered(tokenId, symbol, issuerSafe);
    }

    /// @inheritdoc IKirchhoffRegistry
    /// @dev A new proposal replaces any pending one and restarts the timelock.
    function proposeSpec(bytes32 tokenId, bytes32 specHash, string calldata specURI) external onlyIssuer(tokenId) {
        if (specHash == bytes32(0)) revert EmptySpecHash();
        PendingSpec storage p = s_pending[tokenId];
        if (p.eta != 0) emit SpecProposalCancelled(tokenId, p.specHash);
        uint64 eta = uint64(block.timestamp) + timelockSeconds;
        s_pending[tokenId] = PendingSpec(specHash, specURI, eta);
        emit SpecProposed(tokenId, specHash, specURI, eta);
    }

    /// @inheritdoc IKirchhoffRegistry
    function cancelSpec(bytes32 tokenId) external onlyIssuer(tokenId) {
        PendingSpec storage p = s_pending[tokenId];
        if (p.eta == 0) revert NoPendingSpec(tokenId);
        emit SpecProposalCancelled(tokenId, p.specHash);
        delete s_pending[tokenId];
    }

    /// @inheritdoc IKirchhoffRegistry
    /// @dev Permissionless execution: the issuer's decision was made at proposal time, the timelock is the review.
    function activateSpec(bytes32 tokenId) external {
        if (s_issuer[tokenId] == address(0)) revert TokenNotRegistered(tokenId);
        PendingSpec memory p = s_pending[tokenId];
        if (p.eta == 0) revert NoPendingSpec(tokenId);
        if (block.timestamp < p.eta) revert TimelockNotElapsed(p.eta);
        uint64 version = s_active[tokenId].version + 1;
        s_active[tokenId] = Spec(p.specHash, p.specURI, version, uint64(block.timestamp));
        delete s_pending[tokenId];
        emit SpecActivated(tokenId, p.specHash, p.specURI, version);
    }

    /// @inheritdoc IKirchhoffRegistry
    function setIssuerSafe(bytes32 tokenId, address newSafe) external onlyIssuer(tokenId) {
        if (newSafe == address(0)) revert ZeroAddress();
        emit IssuerSafeChanged(tokenId, s_issuer[tokenId], newSafe);
        s_issuer[tokenId] = newSafe;
    }

    function issuerOf(bytes32 tokenId) external view returns (address) {
        return s_issuer[tokenId];
    }

    function activeSpec(bytes32 tokenId) external view returns (Spec memory) {
        return s_active[tokenId];
    }

    function pendingSpec(bytes32 tokenId) external view returns (PendingSpec memory) {
        return s_pending[tokenId];
    }

    function activeSpecHash(bytes32 tokenId) external view returns (bytes32) {
        return s_active[tokenId].specHash;
    }
}
