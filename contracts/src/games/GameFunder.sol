// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IGameFactory, IGameKit} from "./IGames.sol";

/// Pays Sequencer games from its own balance, inside the public ladder: a lifetime cap per game and a rolling 7-day
/// budget. Only the Safe can call it; the agent reaches it through Zodiac Roles (this one function, bounded amount)
/// and Delay (1 h, Safe veto), so the Safe stays the caller. The Safe tops this contract up; the most a stolen agent
/// key can move is this balance, inside the caps. No owner, no upgrade: a new ladder level is a new GameFunder that
/// Roles is re-pointed to, and the old one is swept back to the Safe (contracts/docs/funding.md).
contract GameFunder {
    uint256 public constant WINDOW = 7 days;
    /// At most this many expired spends leave the window per call, so a flood of tiny spends can't push
    /// fund() past the block gas limit. Spends not yet popped still count: the budget is only ever stricter.
    uint256 public constant MAX_POP = 64;

    address public immutable safe;
    IGameFactory public immutable factory;
    uint256 public immutable weeklyBudget;
    uint256 public immutable perGameCap;

    struct Spend {
        uint64 at;
        uint192 amount;
    }

    Spend[] internal spends;
    /// Oldest spend still counted.
    uint256 public head;
    /// Sum of spends from `head` on (>= the true rolling sum, see MAX_POP).
    uint256 public counted;
    mapping(address game => uint256) public fundedTotal;

    event Funded(address indexed game, uint256 amount, uint256 gameTotal, uint256 counted);
    event Swept(uint256 amount);

    error BadConfig();
    error NotSafe();
    error NotGame(address game);
    error ZeroAmount();
    error OverGameCap(uint256 total, uint256 cap);
    error OverWeeklyBudget(uint256 total, uint256 budget);
    error InsufficientBalance(uint256 amount, uint256 balance);
    error SweepFailed();

    constructor(address safe_, IGameFactory factory_, uint256 weeklyBudget_, uint256 perGameCap_) {
        if (
            safe_ == address(0) || address(factory_) == address(0) || perGameCap_ == 0 || perGameCap_ > weeklyBudget_
                || weeklyBudget_ > type(uint192).max
        ) revert BadConfig();
        safe = safe_;
        factory = factory_;
        weeklyBudget = weeklyBudget_;
        perGameCap = perGameCap_;
    }

    /// Top-ups from the Safe.
    receive() external payable {}

    function fund(address game, uint256 amount) external {
        if (msg.sender != safe) revert NotSafe();
        if (amount == 0) revert ZeroAmount();
        if (!factory.isGame(game)) revert NotGame(game);
        uint256 total = fundedTotal[game] + amount;
        if (total > perGameCap) revert OverGameCap(total, perGameCap);
        (uint256 h, uint256 c) = _expire(MAX_POP);
        c += amount;
        if (c > weeklyBudget) revert OverWeeklyBudget(c, weeklyBudget);
        if (amount > address(this).balance) revert InsufficientBalance(amount, address(this).balance);

        head = h;
        counted = c;
        fundedTotal[game] = total;
        spends.push(Spend(uint64(block.timestamp), uint192(amount)));
        emit Funded(game, amount, total, c);
        IGameKit(game).fund{value: amount}();
    }

    /// Everything back to the Safe (retiring this ladder level).
    function sweep() external {
        if (msg.sender != safe) revert NotSafe();
        uint256 amount = address(this).balance;
        emit Swept(amount);
        (bool ok,) = safe.call{value: amount}("");
        if (!ok) revert SweepFailed();
    }

    /// The true rolling sum: funds sent in the last 7 days.
    function spentInWindow() external view returns (uint256 sum) {
        (, sum) = _expire(type(uint256).max);
    }

    function _expire(uint256 maxPop) internal view returns (uint256 h, uint256 c) {
        h = head;
        c = counted;
        uint256 end = spends.length;
        for (uint256 n; h < end && n < maxPop; ++n) {
            Spend memory s = spends[h];
            if (s.at + WINDOW > block.timestamp) break;
            c -= s.amount;
            ++h;
        }
    }
}
