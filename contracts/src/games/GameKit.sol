// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IGameHost, IGameKit} from "./IGames.sol";

/// The base every Sequencer game inherits (contracts/docs/games.md). A game:
///  - is deployed by the GameFactory (CREATE2), which it remembers as `factory`; the Safe is the factory's;
///  - is paid only by the current GameFunder (`fund`, read live from the factory), never by players: no other payable
///    entry point, no receive/fallback (the Sequencer's gates refuse any);
///  - counts a play with `_played` (the player is always msg.sender; no plays while paused or retired);
///  - pays winners only by crediting them (`_credit`, never more than the free balance, never while paused) for a pull
///    `claim`, which works forever, paused or retired;
///  - can be paused only by the Safe, and retired only by the factory: retiring stops plays, then `sweep` (anyone)
///    returns the free balance to the Safe once no round is open (or 7 days after retiring, whatever the round says);
///  - after retiring, a late `fund` is forwarded to the Safe instead of reverting, so a fund still waiting in the Safe's
///    Delay queue can never jam the queue behind it.
/// Payouts follow checks-effects-interactions: owed is cleared before the transfer.
abstract contract GameKit is IGameKit {
    uint256 public constant SWEEP_BACKSTOP = 7 days;

    IGameHost public immutable factory;
    address public immutable safe;

    bool public paused;
    bool public retired;
    uint64 public retiredAt;
    uint256 public owedTotal;
    mapping(address player => uint256) public owed;

    event Played(address indexed player, uint256 valueWei);
    event Funded(uint256 amount);
    event Forwarded(uint256 amount);
    event Credited(address indexed to, uint256 amount);
    event Claimed(address indexed to, uint256 amount);
    event PausedSet(bool on);
    event Retired();
    event Swept(uint256 amount);

    error NotFunder();
    error NotSafe();
    error NotFactory();
    error NotLive();
    error NotRetired();
    error AlreadyRetired();
    error RoundOpen();
    error NothingOwed();
    error OverFreeBalance(uint256 amount, uint256 free);
    error TransferFailed();

    constructor() {
        factory = IGameHost(msg.sender);
        address s = IGameHost(msg.sender).safe();
        if (s == address(0)) revert NotSafe();
        safe = s;
    }

    modifier whenLive() {
        if (paused || retired) revert NotLive();
        _;
    }

    /// GameFunder's payment. After retiring, the value goes straight on to the Safe.
    function fund() external payable {
        if (msg.sender != factory.funder()) revert NotFunder();
        if (retired) {
            emit Forwarded(msg.value);
            _send(safe, msg.value);
        } else {
            emit Funded(msg.value);
        }
    }

    function pause(bool on) external {
        if (msg.sender != safe) revert NotSafe();
        paused = on;
        emit PausedSet(on);
    }

    function retire() external {
        if (msg.sender != address(factory)) revert NotFactory();
        if (retired) revert AlreadyRetired();
        retired = true;
        retiredAt = uint64(block.timestamp);
        emit Retired();
    }

    /// Everything not owed to players back to the Safe, once retired and no round is open (or after the backstop).
    function sweep() external {
        if (!retired) revert NotRetired();
        // after the backstop the game's own code is never asked (a _roundOpen that reverts can't hold the money)
        if (block.timestamp < retiredAt + SWEEP_BACKSTOP && _roundOpen()) revert RoundOpen();
        uint256 amount = freeBalance();
        emit Swept(amount);
        _send(safe, amount);
    }

    function claim() external {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        owedTotal -= amount;
        emit Claimed(msg.sender, amount);
        _send(msg.sender, amount);
    }

    /// What the game holds beyond what it owes players.
    function freeBalance() public view returns (uint256) {
        return address(this).balance - owedTotal;
    }

    /// Count a play by msg.sender. `valueWei` is the play's stake once a deposit level exists (0 until then).
    function _played(uint256 valueWei) internal {
        if (paused || retired) revert NotLive();
        emit Played(msg.sender, valueWei);
    }

    /// Owe `amount` to `to`, out of the free balance only.
    /// Not while paused: a Safe pause stops every new payout (claims of what is already owed still work).
    function _credit(address to, uint256 amount) internal {
        if (paused) revert NotLive();
        uint256 free = freeBalance();
        if (amount > free) revert OverFreeBalance(amount, free);
        owed[to] += amount;
        owedTotal += amount;
        emit Credited(to, amount);
    }

    /// True while a round holds something the game must still settle (sweep waits for it, up to the backstop).
    function _roundOpen() internal view virtual returns (bool);

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
