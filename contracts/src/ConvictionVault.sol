// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IModuleRegistry} from "./interfaces/IDNA.sol";

interface IVaultBound {
    function vault() external view returns (address);
    function token() external view returns (address);
}

/// @title ConvictionVault (SPEC §12)
/// @notice Holders lock DNA in positions. One weight function serves both games: MutationBoard votes (`weightAt`)
///         and the off-chain holder-jackpot ticket builder (staked DNA counts at its weight, held DNA at ×1).
///         weight = amount × min(tier multiplier × streak, ×4): ×2 / ×2.5 / ×3 while the 12 h / 3 d / 7 d term runs,
///         ×2 once it is over (still locked); streak by the position's age ×1.25 / ×1.5 / ×2 at 2 / 5 / 10 days.
///         A position stays locked after its term until its owner withdraws; there is no expiry, no extend, no transfer.
///         No owner, no pause, no proxy, no admin withdraw. The only privileged act is binding DNA once.
/// @dev DNA is OZ ERC20 (reverts on failure, no fee-on-transfer, no hooks): CEI, no reentrancy guard.
contract ConvictionVault {
    struct Position {
        address owner;
        uint8 tier; // immutable: the first term's tier (later terms: `recommit`, kept in `_recommits`)
        uint40 start; // immutable: lock timestamp (streak and eligibility always count from here)
        bool withdrawn;
        uint128 amount;
    }

    uint256 public constant MIN_LOCK = 10_000 ether; // (tunable)
    uint256 public constant MIN_AGE = 12 hours; // a position votes only from start + MIN_AGE
    uint256 public constant TIERS = 3;
    uint256 public constant MAX_MULT = 40_000; // ×4 combined ceiling, in hundredths × hundredths
    uint256 internal constant BPS = 100; // multipliers in hundredths

    IModuleRegistry public immutable registry;
    address public immutable safe;
    address public immutable initializer;

    IERC20 public token; // DNA, bound once from the pot (the pot read it from the hook's PoolKey)
    uint256 public count; // ids 1..count exist
    uint256 public totalLocked; // Σ amount of positions not withdrawn
    mapping(uint256 => Position) internal _positions;
    /// @dev Per position, every recommit in order, packed `termStart << 8 | tier`: the term in force at any T is the
    ///      last entry with termStart ≤ T (else the first term), so weights at a past T never change.
    mapping(uint256 => uint48[]) internal _recommits;
    mapping(address => bool) public excluded; // immutable team-wallet list (constructor)

    event Locked(uint256 indexed id, address indexed owner, uint256 amount, uint8 tier, uint256 weight);
    event Withdrawn(uint256 indexed id, address indexed owner, uint256 amount);
    event Recommitted(uint256 indexed id, uint8 tier, uint256 termStart);
    event TokenBound(address token);

    error AlreadyBound();
    error NotBound();
    error BadConfig();
    error BadTier();
    error Excluded();
    error NotInitializer();
    error NotOwner();
    error TooEarly();
    error TooSmall();
    error TooLarge();
    error AlreadyWithdrawn();
    error WrongPot();

    /// @param excluded_ Wallets that may never lock or win: the Safe signers' own EOAs / team wallets (a
    ///        launch-config input, the mainnet launch path refuses an empty list). Safe, agent and anchor key are
    ///        excluded live.
    /// @dev No token argument: DNA's address is a launch-graph output (route A's packer derives it), while this vault's
    ///      address must be known before the graph (GamePot → FeeVault → hook constructor). DNA is bound from the pot.
    constructor(IModuleRegistry registry_, address initializer_, address[] memory excluded_) {
        if (address(registry_).code.length == 0 || initializer_ == address(0)) revert BadConfig();
        registry = registry_;
        safe = registry_.safe();
        initializer = initializer_;
        for (uint256 i; i < excluded_.length; ++i) {
            if (excluded_[i] == address(0)) revert BadConfig();
            excluded[excluded_[i]] = true;
        }
    }

    /// @notice One-shot: bind DNA, read from an initialized GamePot that points back here. Only `initializer`. Locks
    ///         open after this.
    function initialize(address gamePot_) external {
        if (msg.sender != initializer) revert NotInitializer();
        if (address(token) != address(0)) revert AlreadyBound();
        if (gamePot_.code.length == 0 || IVaultBound(gamePot_).vault() != address(this)) revert WrongPot();
        address t = IVaultBound(gamePot_).token();
        if (t == address(0)) revert WrongPot();
        token = IERC20(t);
        emit TokenBound(t);
    }

    // ------------------------------------------------------------------ holders

    /// @notice Lock `amount` DNA for at least term(tier) (12 h ×2, 3 d ×2.5, 7 d ×3). Operators and the excluded team
    ///         wallets cannot lock (sybil-bypassable; disclosed).
    function lock(uint256 amount, uint8 tier) external returns (uint256 id) {
        if (address(token) == address(0)) revert NotBound();
        if (tier >= TIERS) revert BadTier();
        if (amount < MIN_LOCK) revert TooSmall();
        if (amount > type(uint96).max) revert TooLarge(); // > supply; keeps every weight (≤ amount × 4) small
        if (
            excluded[msg.sender] || msg.sender == safe || msg.sender == registry.agent()
                || msg.sender == registry.anchorKey()
        ) revert Excluded();
        id = ++count;
        _positions[id] = Position(msg.sender, tier, uint40(block.timestamp), false, uint128(amount));
        totalLocked += amount;
        emit Locked(id, msg.sender, amount, tier, _weight(id, _positions[id], block.timestamp));
        token.transferFrom(msg.sender, address(this), amount);
    }

    /// @notice Withdraw the caller's positions whose committed term is over.
    function withdraw(uint256[] calldata ids) external returns (uint256 total) {
        for (uint256 k; k < ids.length; ++k) {
            uint256 id = ids[k];
            Position storage p = _positions[id];
            if (p.owner != msg.sender) revert NotOwner();
            if (p.withdrawn) revert AlreadyWithdrawn();
            (uint256 ts, uint8 tier) = termAt(id, block.timestamp);
            if (block.timestamp < ts + term(tier)) revert TooEarly(); // never inside a committed term
            p.withdrawn = true;
            total += p.amount;
            emit Withdrawn(id, msg.sender, p.amount);
        }
        totalLocked -= total;
        if (total != 0) token.transfer(msg.sender, total);
    }

    /// @notice Owner: start a new committed term on positions whose current term has ended, without touching `start`
    ///         (holding always beats churning: the streak keeps growing). The new tier's
    ///         multiplier applies for the new term, then drops to ×2 again. Withdraw is blocked until it ends.
    function recommit(uint256[] calldata ids, uint8 tier) external {
        if (tier >= TIERS) revert BadTier();
        for (uint256 k; k < ids.length; ++k) {
            uint256 id = ids[k];
            Position storage p = _positions[id];
            if (p.owner != msg.sender) revert NotOwner();
            if (p.withdrawn) revert AlreadyWithdrawn();
            (uint256 ts, uint8 cur) = termAt(id, block.timestamp);
            if (block.timestamp < ts + term(cur)) revert TooEarly();
            _recommits[id].push(uint48(block.timestamp << 8 | tier));
            emit Recommitted(id, tier, block.timestamp);
        }
    }

    // ------------------------------------------------------------------ views

    /// @notice Minimum term of a tier: 12 h, 3 d, 7 d (tunable).
    function term(uint8 tier) public pure returns (uint256) {
        return tier == 0 ? 12 hours : (tier == 1 ? 3 days : 7 days);
    }

    /// @notice Tier multiplier in hundredths while the term runs: ×2, ×2.5, ×3; ×2 after it (still locked).
    function tierMult(uint8 tier) public pure returns (uint256) {
        return tier == 0 ? 200 : (tier == 1 ? 250 : 300);
    }

    /// @notice Streak multiplier in hundredths by position age: ≥ 2 d ×1.25, ≥ 5 d ×1.5, ≥ 10 d ×2 (tunable).
    function streakMult(uint256 age) public pure returns (uint256) {
        return age >= 10 days ? 200 : (age >= 5 days ? 150 : (age >= 2 days ? 125 : 100));
    }

    function positions(uint256 id) external view returns (Position memory) {
        return _positions[id];
    }

    /// @notice amount × min(tier multiplier of the term in force at T while T < termStart + term, else ×2)
    ///         × streak(T − start), ×4), ignoring eligibility. For T < start it is the weight at lock.
    function currentWeight(uint256 id, uint256 T) public view returns (uint256) {
        return _weight(id, _positions[id], T);
    }

    /// @notice The committed term in force at T: the last recommit with termStart ≤ T, else the first term.
    function termAt(uint256 id, uint256 T) public view returns (uint256 termStart, uint8 tier) {
        uint48[] storage r = _recommits[id];
        for (uint256 i = r.length; i > 0; --i) {
            uint48 x = r[i - 1];
            if (x >> 8 <= T) return (x >> 8, uint8(x));
        }
        Position storage p = _positions[id];
        return (p.start, p.tier);
    }

    function recommitCount(uint256 id) external view returns (uint256) {
        return _recommits[id].length;
    }

    /// @notice Vote weight at time T: currentWeight if the position is not withdrawn and start + MIN_AGE ≤ T, else 0.
    function weightAt(uint256 id, uint256 T) external view returns (uint256) {
        Position storage p = _positions[id];
        if (p.owner == address(0) || p.withdrawn || uint256(p.start) + MIN_AGE > T) return 0;
        return _weight(id, p, T);
    }

    // ------------------------------------------------------------------ internal

    function _weight(uint256 id, Position storage p, uint256 T) internal view returns (uint256) {
        uint256 start = p.start;
        uint256 age = T > start ? T - start : 0;
        (uint256 ts, uint8 tier) = termAt(id, T);
        uint256 inTerm = T > ts ? T - ts : 0;
        uint256 m = (inTerm < term(tier) ? tierMult(tier) : 2 * BPS) * streakMult(age);
        return uint256(p.amount) * (m < MAX_MULT ? m : MAX_MULT) / (BPS * BPS);
    }
}
