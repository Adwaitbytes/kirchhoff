// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RateLimiter} from "@chainlink/contracts-ccip/contracts/libraries/RateLimiter.sol";
import {TokenPool} from "@chainlink/contracts-ccip/contracts/pools/TokenPool.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @title ConfigureLanes
/// @notice Wires this chain's KirchhoffTokenPool to the pools of the other chains (TokenPool.applyChainUpdates),
/// reading every address from deployments/<network>.json written by Deploy.s.sol. Run once per chain after all three
/// chains are deployed. Idempotent: a remote chain already configured only gets its pool added if missing.
/// @dev Env: DEPLOYER_PRIVATE_KEY (pool owner), NETWORK (this chain), REMOTE_NETWORKS (comma-separated, e.g.
/// "arb-sepolia,base-sepolia"). Rate limits are left disabled: KIRCHHOFF's status check, not a rate cap, is the
/// control under test on these testnet lanes.
contract ConfigureLanes is Script {
    function run() external {
        string memory dir = string.concat(vm.projectRoot(), "/../deployments/");
        string memory local = vm.readFile(string.concat(dir, vm.envString("NETWORK"), ".json"));
        TokenPool pool = TokenPool(vm.parseJsonAddress(local, ".kirchhoffTokenPool"));
        string[] memory remotes = vm.split(vm.envString("REMOTE_NETWORKS"), ",");

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        for (uint256 i = 0; i < remotes.length; ++i) {
            string memory remote = vm.readFile(string.concat(dir, vm.trim(remotes[i]), ".json"));
            uint64 selector = uint64(vm.parseUint(vm.parseJsonString(remote, ".chainSelector")));
            bytes memory remotePool = abi.encode(vm.parseJsonAddress(remote, ".kirchhoffTokenPool"));
            string memory tokenKey = vm.keyExistsJson(remote, ".kETH") ? ".kETH" : ".remoteKETH";
            bytes memory remoteToken = abi.encode(vm.parseJsonAddress(remote, tokenKey));

            if (!pool.isSupportedChain(selector)) {
                TokenPool.ChainUpdate[] memory updates = new TokenPool.ChainUpdate[](1);
                bytes[] memory pools = new bytes[](1);
                pools[0] = remotePool;
                RateLimiter.Config memory off = RateLimiter.Config(false, 0, 0);
                updates[0] = TokenPool.ChainUpdate(selector, pools, remoteToken, off, off);
                pool.applyChainUpdates(new uint64[](0), updates);
                console2.log("Added remote chain", vm.trim(remotes[i]));
            } else if (!pool.isRemotePool(selector, remotePool)) {
                pool.addRemotePool(selector, remotePool);
                console2.log("Added remote pool for", vm.trim(remotes[i]));
            } else {
                console2.log("Already wired:", vm.trim(remotes[i]));
            }
        }
        vm.stopBroadcast();
    }
}
