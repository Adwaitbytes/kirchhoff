// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBurnMintERC20} from "@chainlink/contracts-ccip/contracts/interfaces/IBurnMintERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {BridgeRegistry} from "./BridgeRegistry.sol";
import {HomeEscrowAdapter} from "./HomeEscrowAdapter.sol";

/// @title WeakBridge (TESTNET SIMULATION ONLY)
/// @notice A deliberately weak third-party bridge: one ECDSA key (a "1-of-1 verifier") authorizes every credit. The
/// Kelp Replay demo signs a credit with this key with no matching debit, reproducing the effect of the Kelp forgery
/// (a credit with no debit) without claiming to reproduce LayerZero's exact bug.
/// @dev Home mode (escrow set): debits lock into HomeEscrowAdapter and credits release from it; the adapter emits the
/// events and holds the debit/credit registry. Remote mode (token set): debits burn and credits mint RemoteKETH; this
/// contract emits the events and holds the registry. In home mode `debitOf` / `creditOf` read through to the escrow,
/// so both addresses answer the same question.
/// Credits are EIP-712 signatures bound to this chain id and this contract address, so a signature cannot be
/// replayed on another chain or another bridge deployment; each id is creditable once.
contract WeakBridge is BridgeRegistry, EIP712 {
    bytes32 public constant CREDIT_TYPEHASH = keccak256("Credit(bytes32 id,address to,uint256 amount,uint64 srcChain)");

    address public immutable verifier;
    IBurnMintERC20 public immutable remoteToken;
    HomeEscrowAdapter public immutable escrow;

    uint256 public nonce;

    error ZeroAddress();
    error InvalidMode();
    error ZeroAmount();
    error InvalidSignature(address recovered);
    error AlreadyCredited(bytes32 id);

    constructor(address verifier_, IBurnMintERC20 remoteToken_, HomeEscrowAdapter escrow_) EIP712("WeakBridge", "1") {
        if (verifier_ == address(0)) revert ZeroAddress();
        // Exactly one of the two backends: a bridge that could both mint and release would double its blast radius.
        if ((address(remoteToken_) == address(0)) == (address(escrow_) == address(0))) revert InvalidMode();
        verifier = verifier_;
        remoteToken = remoteToken_;
        escrow = escrow_;
    }

    /// @notice Debit on this chain for a credit on `dstChain`. Home: approve the escrow; remote: approve this bridge.
    function send(address to, uint256 amount, uint64 dstChain) external returns (bytes32 id) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        id = keccak256(abi.encode(block.chainid, address(this), ++nonce, msg.sender, to, amount, dstChain));
        if (address(escrow) != address(0)) {
            escrow.lock(id, msg.sender, to, amount, dstChain);
        } else {
            _recordDebit(id, msg.sender, to, amount, dstChain);
            remoteToken.burnFrom(msg.sender, amount);
        }
    }

    /// @notice Credit authorized by the single verifier key. Anyone may relay a valid signature.
    function credit(bytes32 id, address to, uint256 amount, uint64 srcChain, bytes calldata signature) external {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (_isCredited(id)) revert AlreadyCredited(id);
        address recovered = ECDSA.recover(creditDigest(id, to, amount, srcChain), signature);
        if (recovered != verifier) revert InvalidSignature(recovered);

        if (address(escrow) != address(0)) {
            escrow.release(id, to, amount, srcChain);
        } else {
            _recordCredit(id, to, amount, srcChain);
            remoteToken.mint(to, amount);
        }
    }

    /// @notice EIP-712 digest the verifier signs; includes this chain id and contract address via the domain.
    function creditDigest(bytes32 id, address to, uint256 amount, uint64 srcChain) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CREDIT_TYPEHASH, id, to, amount, srcChain)));
    }

    function debitOf(bytes32 id)
        external
        view
        override
        returns (uint256 amount, address recipient, uint64 dstChain, uint64 blockNumber)
    {
        if (address(escrow) != address(0)) return escrow.debitOf(id);
        Entry storage e = s_debits[id];
        return (e.amount, e.account, e.chain, e.blockNumber);
    }

    function creditOf(bytes32 id)
        external
        view
        override
        returns (uint256 amount, address recipient, uint64 srcChain, uint64 blockNumber)
    {
        if (address(escrow) != address(0)) return escrow.creditOf(id);
        Entry storage e = s_credits[id];
        return (e.amount, e.account, e.chain, e.blockNumber);
    }

    function _isCredited(bytes32 id) internal view returns (bool) {
        if (address(escrow) == address(0)) return s_credits[id].amount != 0;
        (uint256 amount,,,) = escrow.creditOf(id);
        return amount != 0;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
