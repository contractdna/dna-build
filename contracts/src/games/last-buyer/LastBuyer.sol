// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GameKit} from "../GameKit.sol";

/// Template: last player wins (contracts/docs/games.md, "Templates"). A play starts a round or restarts its countdown;
/// once the round has ended, anyone settles it and the last player is owed PRIZE_BPS of the free balance.
/// A round ends at the later of (its start + MIN_ROUND) and (its last play + COUNTDOWN), so:
///  - there is no fixed end to race for: a play in the last second still gives everyone a full COUNTDOWN to answer;
///  - however many addresses or scripts play, the game pays at most one prize per MIN_ROUND.
/// It is still bot-dominated: plays cost only gas, so a script that answers every countdown, day and night, wins every
/// round a person can't stay awake for. While two scripts keep answering each other, no one is paid at all.
contract LastBuyer is GameKit {
    /// Countdown each play restarts. Bounds: 10 minutes to 1 day.
    uint256 public constant COUNTDOWN = 1 hours;
    /// Shortest round, and so the fastest the game can pay. Bounds: COUNTDOWN to 7 days.
    uint256 public constant MIN_ROUND = 1 days;
    /// The last player's share of the free balance. Bounds: 100 (1%) to 2000 (20%).
    uint256 public constant PRIZE_BPS = 1000;

    address public leader;
    /// When the open round started (0: no round open).
    uint64 public startedAt;
    /// When the open round ends, unless someone plays first.
    uint64 public endsAt;

    event Settled(address indexed winner, uint256 prize);

    error RoundOver();
    error RoundRunning();

    function play() external whenLive {
        if (startedAt == 0) startedAt = uint64(block.timestamp);
        else if (block.timestamp >= endsAt) revert RoundOver();
        leader = msg.sender;
        uint256 end = block.timestamp + COUNTDOWN;
        uint256 floor = startedAt + MIN_ROUND;
        endsAt = uint64(end > floor ? end : floor);
        _played(0);
    }

    /// Anyone, once the round has ended, while the game is live (a Safe pause stops payouts; after retiring, the open
    /// round's money goes back with the sweep at the backstop).
    function settle() external whenLive {
        if (startedAt == 0 || block.timestamp < endsAt) revert RoundRunning();
        address winner = leader;
        leader = address(0);
        startedAt = 0;
        endsAt = 0;
        uint256 prize = (freeBalance() * PRIZE_BPS) / 10_000;
        _credit(winner, prize);
        emit Settled(winner, prize);
    }

    function _roundOpen() internal view override returns (bool) {
        return startedAt != 0;
    }
}
