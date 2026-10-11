// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GameKit} from "../GameKit.sol";

/// HELD, not offered to the dev team: a script with a few addresses that reveals last picks the winner; held until
/// entries carry a stake. Entries are free, so one script can enter with many addresses and reveal after everyone else,
/// choosing which of its reveals to make.
/// Template: a raffle with commit-reveal (contracts/docs/games.md, "Templates"). The kit offers no randomness and a game
/// may make no external call (so no VRF), nor read blockhash or prevrandao: the draw comes from the entrants themselves.
///  - Entry: the first entry opens a round of ENTRY_WINDOW. Each address enters once with hashOf(secret), a secret only
///    it knows.
///  - Reveal: for REVEAL_WINDOW after entry closes, each entrant reveals its secret. Only entrants who reveal can win;
///    each reveal mixes keccak256(secret, entrant) into the seed (bound to the entrant, so a copied commitment adds a
///    contribution and never cancels one).
///  - Draw: once the reveal window is over, anyone settles: the winner is seed % (revealed entrants), owed PRIZE_BPS of
///    the free balance, for a pull claim. No reveals, no prize.
/// What commit-reveal can't remove: the last entrants to reveal see the outcome and choose whether to reveal; k such
/// addresses choose among 2^k outcomes. With free entry, those k addresses can all be one script's. The game still pays
/// at most one prize per round, however many addresses enter.
contract Raffle is GameKit {
    /// How long a round takes entries. Bounds: 1 hour to 3 days.
    uint256 public constant ENTRY_WINDOW = 1 days;
    /// How long entrants have to reveal after entry closes. Bounds: 1 hour to 2 days.
    uint256 public constant REVEAL_WINDOW = 1 days;
    /// The winner's share of the free balance. Bounds: 100 (1%) to 2000 (20%).
    uint256 public constant PRIZE_BPS = 1000;

    /// The open round's number (rounds settled so far).
    uint256 public round;
    /// When the open round stops taking entries (0: no round open).
    uint64 public entryEnds;
    uint256 public entrants;
    bytes32 public seed;
    mapping(uint256 round => mapping(address player => bytes32)) public commitmentOf;
    mapping(uint256 round => mapping(address player => bool)) public revealed;
    mapping(uint256 round => address[]) internal _revealers;

    event Revealed(uint256 indexed round, address indexed player);
    event Drawn(uint256 indexed round, address indexed winner, uint256 prize);

    error EntryClosed();
    error EmptyCommitment();
    error AlreadyEntered();
    error NotRevealTime();
    error AlreadyRevealed();
    error WrongSecret();
    error RoundRunning();

    /// What an entrant commits to: keccak256 of the secret's 32 bytes (a page computes it locally, never asks a node).
    function hashOf(bytes32 secret) public pure returns (bytes32) {
        return keccak256(abi.encode(secret));
    }

    function revealedCount() external view returns (uint256) {
        return _revealers[round].length;
    }

    function enter(bytes32 commitment) external whenLive {
        if (entryEnds == 0) entryEnds = uint64(block.timestamp + ENTRY_WINDOW);
        else if (block.timestamp >= entryEnds) revert EntryClosed();
        if (commitment == bytes32(0)) revert EmptyCommitment();
        if (commitmentOf[round][msg.sender] != bytes32(0)) revert AlreadyEntered();
        commitmentOf[round][msg.sender] = commitment;
        ++entrants;
        _played(0);
    }

    /// Any time in the reveal window, paused or not (a reveal pays nothing).
    function reveal(bytes32 secret) external {
        if (entryEnds == 0 || block.timestamp < entryEnds || block.timestamp >= entryEnds + REVEAL_WINDOW) {
            revert NotRevealTime();
        }
        if (revealed[round][msg.sender]) revert AlreadyRevealed();
        if (commitmentOf[round][msg.sender] != hashOf(secret)) revert WrongSecret();
        revealed[round][msg.sender] = true;
        seed ^= keccak256(abi.encode(secret, msg.sender));
        _revealers[round].push(msg.sender);
        emit Revealed(round, msg.sender);
    }

    /// Anyone, once the reveal window is over, while the game is live (a Safe pause stops payouts; after retiring, the
    /// open round's money goes back with the sweep at the backstop).
    function settle() external whenLive {
        if (entryEnds == 0 || block.timestamp < entryEnds + REVEAL_WINDOW) revert RoundRunning();
        address[] storage revealers = _revealers[round];
        uint256 n = revealers.length;
        address winner;
        uint256 prize;
        if (n > 0) {
            winner = revealers[uint256(seed) % n];
            prize = (freeBalance() * PRIZE_BPS) / 10_000;
            _credit(winner, prize);
        }
        emit Drawn(round, winner, prize);
        ++round;
        entryEnds = 0;
        entrants = 0;
        seed = bytes32(0);
    }

    function _roundOpen() internal view override returns (bool) {
        return entryEnds != 0;
    }
}
