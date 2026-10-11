// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GameKit} from "../GameKit.sol";

/// Template: a daily check-in (contracts/docs/games.md, "Templates"). Each address checks in at most once per UTC day.
/// Once a day is over, anyone settles it: a fixed share of the free balance is set aside and split evenly among that
/// day's check-ins. Each player then collects their own share (credited for a pull claim); no loop over players. What
/// is not collected within COLLECT_DAYS goes back to the free balance (`release`). No streaks, no randomness.
/// Many addresses checking in only split the same day's share more ways: the game never pays more per day.
contract DailyCheckin is GameKit {
    /// Share of the free balance (minus what is already set aside) one settled day splits. Bounds: 10 (0.1%) to 500 (5%).
    uint256 public constant SHARE_BPS = 100;
    /// Days after a day ends in which its check-ins may collect. Bounds: 1 to 6 (under the kit's 7-day sweep backstop).
    uint256 public constant COLLECT_DAYS = 3;

    /// One UTC day (block.timestamp / 1 days), in one storage slot. Every amount fits: all the ETH there is is under
    /// 2^96 wei.
    struct Day {
        uint32 checkins;
        bool settled;
        /// what each check-in collects, set at settle
        uint96 each;
        /// what the day still holds for its check-ins
        uint120 left;
    }

    mapping(uint256 day => Day) public dayOf;
    /// 0: no check-in; CHECKED_IN; COLLECTED.
    mapping(uint256 day => mapping(address player => uint8)) public statusOf;
    /// Set aside for settled days, not collected yet (the sum of every day's `left`).
    uint256 public reserved;
    /// Days with check-ins that are not settled yet.
    uint256 public openDays;

    uint8 internal constant CHECKED_IN = 1;
    uint8 internal constant COLLECTED = 2;

    event Settled(uint256 indexed day, uint256 checkins, uint256 each);
    event Released(uint256 indexed day, uint256 amount);

    error AlreadyCheckedIn();
    error DayNotOver();
    error AlreadySettled();
    error NoCheckins();
    error NotCheckedIn();
    error AlreadyCollected();
    error CollectClosed();
    error CollectOpen();
    error NothingLeft();

    function today() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function checkIn() external whenLive {
        uint256 d = today();
        if (statusOf[d][msg.sender] != 0) revert AlreadyCheckedIn();
        statusOf[d][msg.sender] = CHECKED_IN;
        Day storage day = dayOf[d];
        if (day.checkins == 0) ++openDays;
        ++day.checkins;
        _played(0);
    }

    /// Anyone, once `d` is over, while the game is live (a Safe pause stops it; after retiring, nothing new is set
    /// aside and the sweep waits for the backstop).
    function settle(uint256 d) public whenLive {
        if (d >= today()) revert DayNotOver();
        Day storage day = dayOf[d];
        if (day.settled) revert AlreadySettled();
        uint256 n = day.checkins;
        if (n == 0) revert NoCheckins();
        day.settled = true;
        --openDays;
        uint256 each = ((freeBalance() - reserved) * SHARE_BPS) / 10_000 / n;
        day.each = uint96(each);
        day.left = uint120(each * n);
        reserved += each * n;
        emit Settled(d, n, each);
    }

    /// A player's share of day `d` (settling it first if no one has), credited for `claim`. Not while paused (the
    /// kit's `_credit` refuses).
    function collect(uint256 d) external {
        Day storage day = dayOf[d];
        if (!day.settled) settle(d);
        uint8 status = statusOf[d][msg.sender];
        if (status == 0) revert NotCheckedIn();
        if (status == COLLECTED) revert AlreadyCollected();
        if (block.timestamp >= _collectEnd(d)) revert CollectClosed();
        statusOf[d][msg.sender] = COLLECTED;
        uint256 each = day.each;
        day.left -= uint120(each);
        reserved -= each;
        _credit(msg.sender, each);
    }

    /// Anyone, once day `d`'s collect window is over: what its check-ins left goes back to the free balance.
    function release(uint256 d) external {
        if (block.timestamp < _collectEnd(d)) revert CollectOpen();
        Day storage day = dayOf[d];
        uint256 amount = day.left;
        if (amount == 0) revert NothingLeft();
        day.left = 0;
        reserved -= amount;
        emit Released(d, amount);
    }

    function _collectEnd(uint256 d) internal pure returns (uint256) {
        return (d + 1 + COLLECT_DAYS) * 1 days;
    }

    function _roundOpen() internal view override returns (bool) {
        return openDays > 0 || reserved > 0;
    }
}
