// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title LogEmitter (JUDGE LOAD TEST ON LOCAL ANVIL ONLY)
/// @notice Anvil has no CCIP OnRamp, so two instances of this contract stand in for the token pool and the OnRamp:
/// `emit2Then` on the pool instance emits LockedOrBurned and then calls the OnRamp instance's `emit4` for
/// CCIPMessageSent, in one transaction and in CCIP 2.0.0's order, which is all the Judge's source-debit lookup reads.
contract LogEmitter {
    error RelayFailed();

    function emit2Then(bytes32 t0, bytes32 t1, bytes calldata data, address next, bytes calldata nextCall) external {
        assembly {
            let p := mload(0x40)
            calldatacopy(p, data.offset, data.length)
            log2(p, data.length, t0, t1)
        }
        (bool ok,) = next.call(nextCall);
        if (!ok) revert RelayFailed();
    }

    function emit2(bytes32 t0, bytes32 t1, bytes calldata data) external {
        assembly {
            let p := mload(0x40)
            calldatacopy(p, data.offset, data.length)
            log2(p, data.length, t0, t1)
        }
    }

    function emit4(bytes32 t0, bytes32 t1, bytes32 t2, bytes32 t3, bytes calldata data) external {
        assembly {
            let p := mload(0x40)
            calldatacopy(p, data.offset, data.length)
            log4(p, data.length, t0, t1, t2, t3)
        }
    }
}
