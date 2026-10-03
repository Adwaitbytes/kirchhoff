// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBurnMintERC20} from "@chainlink/contracts-ccip/contracts/interfaces/IBurnMintERC20.sol";
import {IGetCCIPAdmin} from "@chainlink/contracts-ccip/contracts/interfaces/IGetCCIPAdmin.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title RemoteKETH (TESTNET SIMULATION ONLY)
/// @notice Burn-mint representation of kETH on remote chains (Arbitrum Sepolia, Base Sepolia). Implements the CCIP
/// IBurnMintERC20 used by BurnMintTokenPool 2.0.0, modelled on Chainlink's BurnMintERC20 (chainlink/contracts 1.5.0)
/// on OpenZeppelin 5.3. Minters per the KIRCH-SPEC: the CCIP pool and the WeakBridge.
/// @dev W4 Topology Watch alerts on unlisted minters, so every mint/burn grant and revoke emits a dedicated event on
/// top of AccessControl's RoleGranted / RoleRevoked.
contract RemoteKETH is IBurnMintERC20, IGetCCIPAdmin, ERC20Burnable, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    address internal s_ccipAdmin;

    error InvalidRecipient(address recipient);
    error ZeroAddress();

    event MintAccessGranted(address indexed minter);
    event BurnAccessGranted(address indexed burner);
    event MintAccessRevoked(address indexed minter);
    event BurnAccessRevoked(address indexed burner);
    event CCIPAdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    constructor(address admin) ERC20("Kirchhoff ETH (testnet remote)", "kETH") {
        if (admin == address(0)) revert ZeroAddress();
        s_ccipAdmin = admin;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function supportsInterface(bytes4 interfaceId) public pure override returns (bool) {
        return interfaceId == type(IERC20).interfaceId || interfaceId == type(IBurnMintERC20).interfaceId
            || interfaceId == type(IGetCCIPAdmin).interfaceId || interfaceId == type(IAccessControl).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }

    // ================================================================
    // Mint and burn (IBurnMintERC20)
    // ================================================================

    function mint(address account, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (account == address(this)) revert InvalidRecipient(account);
        _mint(account, amount);
    }

    /// @notice Burns the caller's own balance; BurnMintTokenPool burns the tokens the router moved into it.
    function burn(uint256 amount) public override(IBurnMintERC20, ERC20Burnable) onlyRole(BURNER_ROLE) {
        super.burn(amount);
    }

    function burn(address account, uint256 amount) external {
        burnFrom(account, amount);
    }

    function burnFrom(address account, uint256 amount)
        public
        override(IBurnMintERC20, ERC20Burnable)
        onlyRole(BURNER_ROLE)
    {
        super.burnFrom(account, amount);
    }

    // ================================================================
    // Roles
    // ================================================================

    function grantMintRole(address minter) external {
        grantRole(MINTER_ROLE, minter);
    }

    function grantBurnRole(address burner) external {
        grantRole(BURNER_ROLE, burner);
    }

    function grantMintAndBurnRoles(address burnAndMinter) external {
        grantRole(MINTER_ROLE, burnAndMinter);
        grantRole(BURNER_ROLE, burnAndMinter);
    }

    function revokeMintRole(address minter) external {
        revokeRole(MINTER_ROLE, minter);
    }

    function revokeBurnRole(address burner) external {
        revokeRole(BURNER_ROLE, burner);
    }

    function _grantRole(bytes32 role, address account) internal override returns (bool granted) {
        granted = super._grantRole(role, account);
        if (!granted) return granted;
        if (role == MINTER_ROLE) emit MintAccessGranted(account);
        else if (role == BURNER_ROLE) emit BurnAccessGranted(account);
    }

    function _revokeRole(bytes32 role, address account) internal override returns (bool revoked) {
        revoked = super._revokeRole(role, account);
        if (!revoked) return revoked;
        if (role == MINTER_ROLE) emit MintAccessRevoked(account);
        else if (role == BURNER_ROLE) emit BurnAccessRevoked(account);
    }

    // ================================================================
    // CCIP admin (TokenAdminRegistry self-registration via getCCIPAdmin)
    // ================================================================

    function getCCIPAdmin() external view returns (address) {
        return s_ccipAdmin;
    }

    function setCCIPAdmin(address newAdmin) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit CCIPAdminTransferred(s_ccipAdmin, newAdmin);
        s_ccipAdmin = newAdmin;
    }
}
