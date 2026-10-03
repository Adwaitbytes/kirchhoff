// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {KirchhoffProtected} from "../KirchhoffProtected.sol";
import {Status} from "../interfaces/KirchhoffTypes.sol";

/// @title DemoUSD (TESTNET SIMULATION ONLY)
/// @notice Borrowable demo stable; only its lending market can mint or burn it.
contract DemoUSD is ERC20 {
    address public immutable market;

    error OnlyMarket(address caller);

    /// @dev Deployed by DemoLendingMarket's constructor, so the deployer is the market.
    constructor() ERC20("Demo USD (testnet)", "dUSD") {
        market = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != market) revert OnlyMarket(msg.sender);
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (msg.sender != market) revert OnlyMarket(msg.sender);
        _burn(from, amount);
    }
}

/// @title DemoLendingMarket (TESTNET SIMULATION ONLY)
/// @notice Minimal kETH-collateralized market showing the KirchhoffProtected integration: borrowing freezes the moment
/// the kETH ConservationFeed reports BROKEN or worse, and also when the feed is stale or not CONSERVED/DRIFT.
/// Uses a fixed demo price; it is not a real lending protocol.
contract DemoLendingMarket is KirchhoffProtected {
    using SafeERC20 for IERC20;

    uint256 public constant PRICE_USD_PER_KETH = 2000; // fixed demo price, whole dUSD per whole kETH
    uint256 public constant LTV_BPS = 5000;
    uint256 internal constant BPS = 10_000;

    IERC20 public immutable collateral;
    DemoUSD public immutable stable;

    mapping(address account => uint256) public collateralOf;
    mapping(address account => uint256) public debtOf;

    error CollateralBroken();
    error ZeroAmount();
    error InsufficientCollateral(uint256 maxDebt, uint256 requestedDebt);
    error RepayExceedsDebt(uint256 debt, uint256 amount);

    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event Borrowed(address indexed account, uint256 amount);
    event Repaid(address indexed account, uint256 amount);

    constructor(IERC20 collateral_, address feed) KirchhoffProtected(feed) {
        collateral = collateral_;
        stable = new DemoUSD();
    }

    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        collateralOf[msg.sender] += amount;
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 remaining = collateralOf[msg.sender] - amount;
        _requireHealthy(remaining, debtOf[msg.sender]);
        collateralOf[msg.sender] = remaining;
        collateral.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function borrow(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        (, int256 status,,,) = kirchhoffFeed.latestRoundData();
        // The explicit breach error comes first so the demo shows exactly why borrowing froze.
        if (status >= int256(uint256(Status.BROKEN))) revert CollateralBroken();
        _requireConserved();

        uint256 newDebt = debtOf[msg.sender] + amount;
        _requireHealthy(collateralOf[msg.sender], newDebt);
        debtOf[msg.sender] = newDebt;
        emit Borrowed(msg.sender, amount);
        stable.mint(msg.sender, amount);
    }

    function repay(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 debt = debtOf[msg.sender];
        if (amount > debt) revert RepayExceedsDebt(debt, amount);
        debtOf[msg.sender] = debt - amount;
        emit Repaid(msg.sender, amount);
        stable.burn(msg.sender, amount);
    }

    /// @notice Max dUSD debt the given collateral supports (both tokens have 18 decimals).
    function maxDebtFor(uint256 collateralAmount) public pure returns (uint256) {
        return collateralAmount * PRICE_USD_PER_KETH * LTV_BPS / BPS;
    }

    function _requireHealthy(uint256 collateralAmount, uint256 debt) internal pure {
        uint256 maxDebt = maxDebtFor(collateralAmount);
        if (debt > maxDebt) revert InsufficientCollateral(maxDebt, debt);
    }
}
