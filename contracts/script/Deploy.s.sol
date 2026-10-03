// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBurnMintERC20} from "@chainlink/contracts-ccip/contracts/interfaces/IBurnMintERC20.sol";
import {ERC20LockBox} from "@chainlink/contracts-ccip/contracts/pools/ERC20LockBox.sol";
import {AuthorizedCallers} from "@chainlink/contracts/src/v0.8/shared/access/AuthorizedCallers.sol";
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {CREReceiver} from "../src/CREReceiver.sol";
import {ConservationFeed} from "../src/ConservationFeed.sol";
import {ConservationLedger} from "../src/ConservationLedger.sol";
import {KirchhoffBurnMintTokenPool} from "../src/KirchhoffBurnMintTokenPool.sol";
import {KirchhoffGuard} from "../src/KirchhoffGuard.sol";
import {KirchhoffLockReleaseTokenPool} from "../src/KirchhoffLockReleaseTokenPool.sol";
import {KirchhoffRegistry} from "../src/KirchhoffRegistry.sol";
import {QuarantineController} from "../src/QuarantineController.sol";
import {DemoLendingMarket} from "../src/demo/DemoLendingMarket.sol";
import {HomeEscrowAdapter} from "../src/demo/HomeEscrowAdapter.sol";
import {KETH} from "../src/demo/KETH.sol";
import {LocalRMNMock, LocalRouterMock} from "../src/demo/LocalCCIPMocks.sol";
import {MockKeystoneForwarder} from "../src/demo/MockKeystoneForwarder.sol";
import {RemoteKETH} from "../src/demo/RemoteKETH.sol";
import {WeakBridge} from "../src/demo/WeakBridge.sol";
import {ReportType} from "../src/interfaces/KirchhoffTypes.sol";

/// @dev Subsets of TokenAdminRegistry 1.5.0 / RegistryModuleOwnerCustom 1.6.0 (chainlink/contracts-ccip 2.0.0
/// `tokenAdminRegistry/`), signature-identical to upstream.
interface ITokenAdminRegistry {
    struct TokenConfig {
        address administrator;
        address pendingAdministrator;
        address tokenPool;
    }

    function getTokenConfig(address token) external view returns (TokenConfig memory);
    function acceptAdminRole(address localToken) external;
    function setPool(address localToken, address pool) external;
}

interface IRegistryModuleOwnerCustom {
    function registerAdminViaOwner(address token) external;
    function registerAdminViaGetCCIPAdmin(address token) external;
}

/// @title Deploy
/// @notice Deploys the KIRCHHOFF production suite plus the testnet demo suite for ONE chain and records every address
/// in deployments/<NETWORK>.json at the repo root.
/// @dev Idempotent: an address already recorded for this network is reused when it still has code, and every
/// configuration step checks onchain state first, so re-running after a partial failure only does what is missing.
///
/// Required env: DEPLOYER_PRIVATE_KEY, NETWORK, ROLE (home|remote), ISSUER_SAFE_ADDRESS, WEAKBRIDGE_VERIFIER.
/// Optional env:
///   FORWARDER_MODE        production | simulation | local. Default: local on chain ids 31337-31339, else required.
///   KEYSTONE_FORWARDER    override the per-chain forwarder from the address book below.
///   CHAIN_SELECTOR        override the per-chain CCIP selector (required on unknown chains).
///   CCIP_ROUTER, CCIP_RMN_PROXY, CCIP_TOKEN_ADMIN_REGISTRY, CCIP_REGISTRY_MODULE, LINK_TOKEN  override the book.
///   WORKFLOW_OWNER, WORKFLOW_ID_W1/W2/W3, WORKFLOW_NAME_W1/W2/W3  authorize production CRE workflows. Ids depend on
///     the workflow config, which embeds these addresses, so re-run once `cre workflow hash` prints them.
///   REGISTRY_TIMELOCK_SECONDS (default 172800; 600 for the testnet demo), STALENESS_SECONDS (120),
///   RECOVERY_TIMELOCK_SECONDS (3600), TOKEN_SYMBOL (kETH), HANDOFF_TO_SAFE (false).
contract Deploy is Script {
    /// @dev What `cre workflow simulate --broadcast` puts in metadata (docs/research/cre-contracts.md 6d).
    bytes32 internal constant SIM_WORKFLOW_ID = 0x1111111111111111111111111111111111111111111111111111111111111111;
    address internal constant SIM_WORKFLOW_OWNER = 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa;
    uint8 internal constant ALL_REPORT_TYPES = uint8(
        (1 << ReportType.EPOCH) | (1 << ReportType.BREACH) | (1 << ReportType.QUARANTINE_APPLIED)
            | (1 << ReportType.RECOVERY_CHECK)
    );

    struct Book {
        uint64 chainSelector;
        address productionForwarder;
        address simulationForwarder;
        address router;
        address rmnProxy;
        address tokenAdminRegistry;
        address registryModule;
        address linkToken;
    }

    struct Config {
        string network;
        bool isHome;
        bool isLocal;
        CREReceiver.ForwarderMode mode;
        address deployer;
        address safe;
        address verifier;
        string symbol;
        bytes32 tokenId;
        uint64 registryTimelock;
        uint64 staleness;
        uint64 recoveryTimelock;
        bool handoff;
        Book book;
    }

    error InvalidRole(string role);
    error InvalidForwarderMode(string mode);
    error MissingAddress(string what, uint256 chainId);

    string internal constant JSON_KEY = "kirchhoff";
    string internal s_path;
    string internal s_existing;
    bool internal s_hasExisting;

    function run() external {
        Config memory c = _loadConfig();
        s_path = string.concat(vm.projectRoot(), "/../deployments/", c.network, ".json");
        s_hasExisting = vm.exists(s_path);
        if (s_hasExisting) s_existing = vm.readFile(s_path);

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));

        if (c.isLocal) {
            if (c.book.productionForwarder == address(0)) {
                c.book.productionForwarder = _reuse("mockKeystoneForwarder");
                if (c.book.productionForwarder == address(0)) {
                    c.book.productionForwarder = address(new MockKeystoneForwarder());
                }
            }
            if (c.book.router == address(0)) {
                c.book.router = _reuse("ccipRouter");
                if (c.book.router == address(0)) c.book.router = address(new LocalRouterMock(c.deployer));
            }
            if (c.book.rmnProxy == address(0)) {
                c.book.rmnProxy = _reuse("ccipRmnProxy");
                if (c.book.rmnProxy == address(0)) c.book.rmnProxy = address(new LocalRMNMock(c.deployer));
            }
        }
        address forwarder =
            c.mode == CREReceiver.ForwarderMode.SIMULATION ? c.book.simulationForwarder : c.book.productionForwarder;
        if (forwarder == address(0)) revert MissingAddress("KEYSTONE_FORWARDER", block.chainid);
        if (c.book.router == address(0)) revert MissingAddress("CCIP_ROUTER", block.chainid);
        if (c.book.rmnProxy == address(0)) revert MissingAddress("CCIP_RMN_PROXY", block.chainid);

        (ConservationLedger ledger, QuarantineController quarantine) = _core(c, forwarder);
        ConservationFeed feed = ConservationFeed(_reuse("conservationFeed"));
        if (address(feed) == address(0)) {
            feed = new ConservationFeed(ledger, c.tokenId, string.concat("KIRCHHOFF ", c.symbol, " status"));
        }
        KirchhoffGuard guard = KirchhoffGuard(_reuse("kirchhoffGuard"));
        if (address(guard) == address(0)) guard = new KirchhoffGuard(quarantine, c.tokenId);

        string memory json = JSON_KEY;
        vm.serializeString(json, "network", c.network);
        vm.serializeString(json, "role", c.isHome ? "home" : "remote");
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeString(json, "chainSelector", vm.toString(c.book.chainSelector));
        vm.serializeString(json, "forwarderMode", _modeName(c.mode));
        vm.serializeString(json, "tokenSymbol", c.symbol);
        vm.serializeBytes32(json, "tokenId", c.tokenId);
        vm.serializeAddress(json, "deployer", c.deployer);
        vm.serializeAddress(json, "issuerSafe", c.safe);
        vm.serializeAddress(json, "weakBridgeVerifier", c.verifier);
        vm.serializeAddress(json, "keystoneForwarder", forwarder);
        if (c.isLocal) vm.serializeAddress(json, "mockKeystoneForwarder", forwarder);
        vm.serializeAddress(json, "ccipRouter", c.book.router);
        vm.serializeAddress(json, "ccipRmnProxy", c.book.rmnProxy);
        vm.serializeAddress(json, "ccipTokenAdminRegistry", c.book.tokenAdminRegistry);
        vm.serializeAddress(json, "ccipRegistryModuleOwnerCustom", c.book.registryModule);
        vm.serializeAddress(json, "linkToken", c.book.linkToken);
        vm.serializeAddress(json, "multicall3", 0xcA11bde05977b3631167028862bE2a173976CA11);
        vm.serializeAddress(json, "conservationLedger", address(ledger));
        vm.serializeAddress(json, "quarantineController", address(quarantine));
        vm.serializeAddress(json, "conservationFeed", address(feed));
        vm.serializeAddress(json, "kirchhoffGuard", address(guard));

        address token;
        address pool;
        if (c.isHome) (token, pool) = _home(c, ledger, quarantine, feed, guard);
        else (token, pool) = _remote(c, ledger, quarantine);
        _registerWithCcip(c, token, pool);

        vm.stopBroadcast();
        string memory out = vm.serializeUint(json, "updatedAtBlock", block.number);
        vm.writeJson(out, s_path);
        console2.log("KIRCHHOFF deployment written to", s_path);
    }

    // ================================================================
    // Suites
    // ================================================================

    function _core(Config memory c, address forwarder)
        internal
        returns (ConservationLedger ledger, QuarantineController quarantine)
    {
        ledger = ConservationLedger(_reuse("conservationLedger"));
        if (address(ledger) == address(0)) {
            ledger = new ConservationLedger(forwarder, c.mode, c.book.chainSelector, c.deployer);
        }
        quarantine = QuarantineController(_reuse("quarantineController"));
        if (address(quarantine) == address(0)) quarantine = new QuarantineController(ledger, c.deployer);

        if (ledger.quarantineController() == address(0)) ledger.setQuarantineController(address(quarantine));
        if (!ledger.isRegistered(c.tokenId)) ledger.registerToken(c.tokenId, c.staleness);
        if (quarantine.issuerOf(c.tokenId) == address(0)) {
            quarantine.configureToken(c.tokenId, c.safe, c.recoveryTimelock);
        }
        if (ledger.getForwarderAddress() != forwarder || ledger.forwarderMode() != c.mode) {
            ledger.setForwarder(forwarder, c.mode);
        }

        if (c.mode != CREReceiver.ForwarderMode.PRODUCTION) {
            // Simulation metadata is fixed and its workflow name is not predictable, so pin id and owner only.
            _setWorkflow(ledger, SIM_WORKFLOW_ID, SIM_WORKFLOW_OWNER, "", ALL_REPORT_TYPES);
        }
        address workflowOwner = vm.envOr("WORKFLOW_OWNER", address(0));
        if (workflowOwner != address(0)) {
            _authorizeFromEnv(ledger, workflowOwner, "W1", "w1-junction", uint8(1 << ReportType.BREACH));
            _authorizeFromEnv(
                ledger,
                workflowOwner,
                "W2",
                "w2-loop",
                uint8((1 << ReportType.EPOCH) | (1 << ReportType.BREACH) | (1 << ReportType.RECOVERY_CHECK))
            );
            _authorizeFromEnv(ledger, workflowOwner, "W3", "w3-responder", uint8(1 << ReportType.QUARANTINE_APPLIED));
        }

        if (c.handoff) {
            if (ledger.owner() == c.deployer && ledger.pendingOwner() != c.safe) ledger.transferOwnership(c.safe);
            if (quarantine.owner() == c.deployer && quarantine.pendingOwner() != c.safe) {
                quarantine.transferOwnership(c.safe);
            }
        }
    }

    function _home(
        Config memory c,
        ConservationLedger ledger,
        QuarantineController quarantine,
        ConservationFeed feed,
        KirchhoffGuard guard
    ) internal returns (address, address) {
        _homeRegistry(c);

        KETH keth = KETH(_reuse("kETH"));
        if (address(keth) == address(0)) keth = new KETH(guard, c.deployer);
        _homeWeakBridge(c, keth);
        (ERC20LockBox lockBox, KirchhoffLockReleaseTokenPool pool) = _homePool(c, keth, ledger, quarantine);

        DemoLendingMarket market = DemoLendingMarket(_reuse("demoLendingMarket"));
        if (address(market) == address(0)) market = new DemoLendingMarket(keth, address(feed));

        string memory json = JSON_KEY;
        vm.serializeAddress(json, "kETH", address(keth));
        vm.serializeAddress(json, "ccipLockBox", address(lockBox));
        vm.serializeAddress(json, "kirchhoffTokenPool", address(pool));
        vm.serializeAddress(json, "demoLendingMarket", address(market));
        vm.serializeAddress(json, "demoUSD", address(market.stable()));
        return (address(keth), address(pool));
    }

    function _homeRegistry(Config memory c) internal {
        KirchhoffRegistry registry = KirchhoffRegistry(_reuse("kirchhoffRegistry"));
        if (address(registry) == address(0)) registry = new KirchhoffRegistry(c.registryTimelock, c.deployer);
        if (registry.issuerOf(c.tokenId) == address(0)) registry.registerToken(c.symbol, c.safe);
        if (c.handoff && registry.owner() == c.deployer && registry.pendingOwner() != c.safe) {
            registry.transferOwnership(c.safe);
        }
        vm.serializeAddress(JSON_KEY, "kirchhoffRegistry", address(registry));
    }

    function _homeWeakBridge(Config memory c, KETH keth) internal {
        HomeEscrowAdapter escrow = HomeEscrowAdapter(_reuse("homeEscrowAdapter"));
        if (address(escrow) == address(0)) escrow = new HomeEscrowAdapter(keth, c.deployer);
        WeakBridge bridge = WeakBridge(_reuse("weakBridge"));
        if (address(bridge) == address(0)) bridge = new WeakBridge(c.verifier, IBurnMintERC20(address(0)), escrow);
        if (escrow.bridge() == address(0)) escrow.setBridge(address(bridge));
        vm.serializeAddress(JSON_KEY, "homeEscrowAdapter", address(escrow));
        vm.serializeAddress(JSON_KEY, "weakBridge", address(bridge));
    }

    function _homePool(Config memory c, KETH keth, ConservationLedger ledger, QuarantineController quarantine)
        internal
        returns (ERC20LockBox lockBox, KirchhoffLockReleaseTokenPool pool)
    {
        lockBox = ERC20LockBox(_reuse("ccipLockBox"));
        if (address(lockBox) == address(0)) lockBox = new ERC20LockBox(address(keth));
        pool = KirchhoffLockReleaseTokenPool(_reuse("kirchhoffTokenPool"));
        if (address(pool) == address(0)) {
            pool = new KirchhoffLockReleaseTokenPool(
                keth, 18, address(0), c.book.rmnProxy, c.book.router, address(lockBox), ledger, quarantine, c.tokenId
            );
        }
        if (!_isAuthorizedCaller(lockBox, address(pool))) {
            address[] memory added = new address[](1);
            added[0] = address(pool);
            lockBox.applyAuthorizedCallerUpdates(AuthorizedCallers.AuthorizedCallerArgs(added, new address[](0)));
        }
        if (c.handoff && pool.owner() == c.deployer) pool.transferOwnership(c.safe);
    }

    function _remote(Config memory c, ConservationLedger ledger, QuarantineController quarantine)
        internal
        returns (address, address)
    {
        string memory json = JSON_KEY;

        RemoteKETH token = RemoteKETH(_reuse("remoteKETH"));
        if (address(token) == address(0)) token = new RemoteKETH(c.deployer);
        WeakBridge bridge = WeakBridge(_reuse("weakBridge"));
        if (address(bridge) == address(0)) bridge = new WeakBridge(c.verifier, token, HomeEscrowAdapter(address(0)));
        KirchhoffBurnMintTokenPool pool = KirchhoffBurnMintTokenPool(_reuse("kirchhoffTokenPool"));
        if (address(pool) == address(0)) {
            pool = new KirchhoffBurnMintTokenPool(
                token, 18, address(0), c.book.rmnProxy, c.book.router, ledger, quarantine, c.tokenId
            );
        }

        // KIRCH-SPEC minters for this remote: the CCIP pool and the WeakBridge.
        bytes32 minter = token.MINTER_ROLE();
        bytes32 burner = token.BURNER_ROLE();
        if (!token.hasRole(minter, address(pool)) || !token.hasRole(burner, address(pool))) {
            token.grantMintAndBurnRoles(address(pool));
        }
        if (!token.hasRole(minter, address(bridge)) || !token.hasRole(burner, address(bridge))) {
            token.grantMintAndBurnRoles(address(bridge));
        }

        if (c.handoff && pool.owner() == c.deployer) pool.transferOwnership(c.safe);

        vm.serializeAddress(json, "remoteKETH", address(token));
        vm.serializeAddress(json, "weakBridge", address(bridge));
        vm.serializeAddress(json, "kirchhoffTokenPool", address(pool));
        return (address(token), address(pool));
    }

    /// @dev Self-serve CCT registration (docs/research/ccip.md TL;DR 7). Lanes are wired by ConfigureLanes.s.sol.
    function _registerWithCcip(Config memory c, address token, address pool) internal {
        if (c.book.tokenAdminRegistry == address(0) || c.book.registryModule == address(0)) {
            console2.log("Skipping CCIP TokenAdminRegistry registration (no registry for this chain)");
            return;
        }
        ITokenAdminRegistry tar = ITokenAdminRegistry(c.book.tokenAdminRegistry);
        ITokenAdminRegistry.TokenConfig memory cfg = tar.getTokenConfig(token);
        if (cfg.administrator == address(0) && cfg.pendingAdministrator == address(0)) {
            IRegistryModuleOwnerCustom module = IRegistryModuleOwnerCustom(c.book.registryModule);
            if (c.isHome) module.registerAdminViaOwner(token);
            else module.registerAdminViaGetCCIPAdmin(token);
            cfg = tar.getTokenConfig(token);
        }
        if (cfg.administrator == address(0) && cfg.pendingAdministrator == c.deployer) {
            tar.acceptAdminRole(token);
            cfg = tar.getTokenConfig(token);
        }
        if (cfg.administrator == c.deployer && cfg.tokenPool != pool) tar.setPool(token, pool);
    }

    // ================================================================
    // Configuration
    // ================================================================

    function _loadConfig() internal view returns (Config memory c) {
        c.network = vm.envString("NETWORK");
        string memory role = vm.envString("ROLE");
        if (keccak256(bytes(role)) == keccak256("home")) c.isHome = true;
        else if (keccak256(bytes(role)) != keccak256("remote")) revert InvalidRole(role);

        c.isLocal = block.chainid == 31_337 || block.chainid == 31_338 || block.chainid == 31_339;
        string memory mode = vm.envOr("FORWARDER_MODE", c.isLocal ? string("local") : string(""));
        bytes32 m = keccak256(bytes(mode));
        if (m == keccak256("production")) c.mode = CREReceiver.ForwarderMode.PRODUCTION;
        else if (m == keccak256("simulation")) c.mode = CREReceiver.ForwarderMode.SIMULATION;
        else if (m == keccak256("local") && c.isLocal) c.mode = CREReceiver.ForwarderMode.LOCAL_MOCK;
        else revert InvalidForwarderMode(mode);

        c.deployer = vm.addr(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        c.safe = vm.envAddress("ISSUER_SAFE_ADDRESS");
        c.verifier = vm.envAddress("WEAKBRIDGE_VERIFIER");
        c.symbol = vm.envOr("TOKEN_SYMBOL", string("kETH"));
        c.tokenId = keccak256(bytes(c.symbol));
        c.registryTimelock = uint64(vm.envOr("REGISTRY_TIMELOCK_SECONDS", uint256(48 hours)));
        c.staleness = uint64(vm.envOr("STALENESS_SECONDS", uint256(120)));
        c.recoveryTimelock = uint64(vm.envOr("RECOVERY_TIMELOCK_SECONDS", uint256(3600)));
        c.handoff = vm.envOr("HANDOFF_TO_SAFE", false);

        Book memory b = _addressBook(block.chainid);
        b.chainSelector = uint64(vm.envOr("CHAIN_SELECTOR", uint256(b.chainSelector)));
        if (b.chainSelector == 0) revert MissingAddress("CHAIN_SELECTOR", block.chainid);
        address forwarderOverride = vm.envOr("KEYSTONE_FORWARDER", address(0));
        if (forwarderOverride != address(0)) {
            if (c.mode == CREReceiver.ForwarderMode.SIMULATION) b.simulationForwarder = forwarderOverride;
            else b.productionForwarder = forwarderOverride;
        }
        b.router = vm.envOr("CCIP_ROUTER", b.router);
        b.rmnProxy = vm.envOr("CCIP_RMN_PROXY", b.rmnProxy);
        b.tokenAdminRegistry = vm.envOr("CCIP_TOKEN_ADMIN_REGISTRY", b.tokenAdminRegistry);
        b.registryModule = vm.envOr("CCIP_REGISTRY_MODULE", b.registryModule);
        b.linkToken = vm.envOr("LINK_TOKEN", b.linkToken);
        c.book = b;
    }

    /// @dev Verified 2026-10-04: forwarders in docs/research/cre-contracts.md section 5, CCIP 2.0 lanes in
    /// docs/research/ccip.md section 1. Local Anvil chains reuse the testnet selectors (docs/INTERFACES.md).
    function _addressBook(uint256 chainId) internal pure returns (Book memory b) {
        if (chainId == 11_155_111) {
            b = Book({
                chainSelector: 16_015_286_601_757_825_753,
                productionForwarder: 0xF8344CFd5c43616a4366C34E3EEE75af79a74482,
                simulationForwarder: 0x15fC6ae953E024d975e77382eEeC56A9101f9F88,
                router: 0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59,
                rmnProxy: 0xba3f6251de62dED61Ff98590cB2fDf6871FbB991,
                tokenAdminRegistry: 0x95F29FEE11c5C55d26cCcf1DB6772DE953B37B82,
                registryModule: 0xa3c796d480638d7476792230da1E2ADa86e031b0,
                linkToken: 0x779877A7B0D9E8603169DdbD7836e478b4624789
            });
        } else if (chainId == 421_614) {
            b = Book({
                chainSelector: 3_478_487_238_524_512_106,
                productionForwarder: 0x76c9cf548b4179F8901cda1f8623568b58215E62,
                simulationForwarder: 0xD41263567DdfeAd91504199b8c6c87371e83ca5d,
                router: 0x2a9C5afB0d0e4BAb2BCdaE109EC4b0c4Be15a165,
                rmnProxy: 0x9527E2d01A3064ef6b50c1Da1C0cC523803BCFF2,
                tokenAdminRegistry: 0x8126bE56454B628a88C17849B9ED99dd5a11Bd2f,
                registryModule: 0xaD417c0611dBD225471D31F056b8B6beC1CBC153,
                linkToken: 0xb1D4538B4571d411F07960EF2838Ce337FE1E80E
            });
        } else if (chainId == 84_532) {
            b = Book({
                chainSelector: 10_344_971_235_874_465_080,
                productionForwarder: 0xF8344CFd5c43616a4366C34E3EEE75af79a74482,
                simulationForwarder: 0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5,
                router: 0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93,
                rmnProxy: 0x99360767a4705f68CcCb9533195B761648d6d807,
                tokenAdminRegistry: 0x736D0bBb318c1B27Ff686cd19804094E66250e17,
                registryModule: 0x176ae8C6C11DD2c031B924CE1A0A43188035f3f6,
                linkToken: 0xE4aB69C077896252FAFBD49EFD26B5D171A32410
            });
        } else if (chainId == 31_337) {
            b.chainSelector = 16_015_286_601_757_825_753;
        } else if (chainId == 31_338) {
            b.chainSelector = 3_478_487_238_524_512_106;
        } else if (chainId == 31_339) {
            b.chainSelector = 10_344_971_235_874_465_080;
        }
    }

    // ================================================================
    // Helpers
    // ================================================================

    function _authorizeFromEnv(
        ConservationLedger ledger,
        address workflowOwner,
        string memory tag,
        string memory defaultName,
        uint8 mask
    ) internal {
        bytes32 workflowId = vm.envOr(string.concat("WORKFLOW_ID_", tag), bytes32(0));
        if (workflowId == bytes32(0)) {
            console2.log("Skipping workflow authorization, WORKFLOW_ID unset for", tag);
            return;
        }
        _setWorkflow(
            ledger, workflowId, workflowOwner, vm.envOr(string.concat("WORKFLOW_NAME_", tag), defaultName), mask
        );
    }

    function _setWorkflow(ConservationLedger ledger, bytes32 id, address owner, string memory name, uint8 mask)
        internal
    {
        CREReceiver.WorkflowAuth memory current = ledger.getWorkflow(id);
        if (
            current.owner != owner || current.name != ledger.encodeWorkflowName(name)
                || current.allowedReportTypes != mask
        ) {
            ledger.setWorkflow(id, owner, name, mask);
        }
    }

    function _isAuthorizedCaller(ERC20LockBox lockBox, address caller) internal view returns (bool) {
        address[] memory callers = lockBox.getAllAuthorizedCallers();
        for (uint256 i = 0; i < callers.length; ++i) {
            if (callers[i] == caller) return true;
        }
        return false;
    }

    function _modeName(CREReceiver.ForwarderMode mode) internal pure returns (string memory) {
        if (mode == CREReceiver.ForwarderMode.PRODUCTION) return "production";
        if (mode == CREReceiver.ForwarderMode.SIMULATION) return "simulation";
        return "local";
    }

    /// @dev Returns the recorded address for `key` if it still has code on this chain, else zero.
    function _reuse(string memory key) internal view returns (address addr) {
        if (!s_hasExisting) return address(0);
        string memory path = string.concat(".", key);
        if (!vm.keyExistsJson(s_existing, path)) return address(0);
        addr = vm.parseJsonAddress(s_existing, path);
        if (addr.code.length == 0) return address(0);
        console2.log("Reusing", key, addr);
    }
}
