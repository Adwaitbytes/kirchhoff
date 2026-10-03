// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title LocalOffRamp (LOCAL ANVIL SCENARIO HARNESS ONLY)
/// @notice Stands in for the CCIP 2.0.0 OffRamp on the local Anvil chains, which have no CCIP deployment, so the
/// workflows scenario harness can deliver a CCIP credit: it calls the token pool's V1 `releaseOrMint` (the pool
/// checks `router.isOffRamp`, which the harness sets on the LocalRouterMock) and then emits the OffRamp 2.0.0
/// `ExecutionStateChanged` with the message id, exactly as the real OffRamp does in the same transaction
/// (docs/research/ccip.md section 4). Permissionless by design: it exists to forge credits in scenario 4.
contract LocalOffRamp {
    struct ReleaseOrMintInV1 {
        bytes originalSender;
        uint64 remoteChainSelector;
        address receiver;
        uint256 sourceDenominatedAmount;
        address localToken;
        bytes sourcePoolAddress;
        bytes sourcePoolData;
        bytes offchainTokenData;
    }

    /// @dev Verbatim OffRamp 2.0.0 event; state 2 is SUCCESS in Internal.MessageExecutionState.
    event ExecutionStateChanged(
        uint64 indexed sourceChainSelector,
        uint64 indexed messageNumber,
        bytes32 indexed messageId,
        uint8 state,
        bytes returnData
    );

    error ReleaseFailed(bytes reason);

    uint64 public messageNumber;

    function execute(
        address pool,
        uint64 sourceChainSelector,
        bytes32 messageId,
        address receiver,
        uint256 amount,
        address localToken,
        address sourcePool
    ) external {
        ReleaseOrMintInV1 memory input = ReleaseOrMintInV1({
            originalSender: abi.encode(msg.sender),
            remoteChainSelector: sourceChainSelector,
            receiver: receiver,
            sourceDenominatedAmount: amount,
            localToken: localToken,
            sourcePoolAddress: abi.encode(sourcePool),
            sourcePoolData: abi.encode(uint8(18)),
            offchainTokenData: ""
        });
        (bool ok, bytes memory ret) = pool.call(
            abi.encodeWithSignature("releaseOrMint((bytes,uint64,address,uint256,address,bytes,bytes,bytes))", input)
        );
        if (!ok) revert ReleaseFailed(ret);
        emit ExecutionStateChanged(sourceChainSelector, ++messageNumber, messageId, 2, "");
    }
}
