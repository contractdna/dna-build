// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GameKit} from "../GameKit.sol";

/// Reference game (a known-good fixture for the Sequencer's gates; never deployed): the last click wins. A click starts
/// or extends a one-hour round; once a round has run out, anyone settles it and the last clicker is owed 10% of the
/// game's free balance. Free to play, no randomness.
contract Example is GameKit {
    uint256 public constant ROUND = 1 hours;
    uint256 public constant PRIZE_BPS = 1000;

    address public leader;
    uint64 public deadline;

    event Settled(address indexed winner, uint256 prize);

    error RoundOver();
    error RoundRunning();

    function click() external whenLive {
        if (deadline != 0 && block.timestamp >= deadline) revert RoundOver();
        leader = msg.sender;
        deadline = uint64(block.timestamp + ROUND);
        _played(0);
    }

    /// Anyone, once the round ran out, while the game is live (a Safe pause stops payouts; after retiring, the open
    /// round's money goes back with the sweep at the backstop).
    function settle() external whenLive {
        if (deadline == 0 || block.timestamp < deadline) revert RoundRunning();
        address winner = leader;
        leader = address(0);
        deadline = 0;
        uint256 prize = (freeBalance() * PRIZE_BPS) / 10_000;
        if (prize > 0) _credit(winner, prize);
        emit Settled(winner, prize);
    }

    function _roundOpen() internal view override returns (bool) {
        return deadline != 0;
    }
}
