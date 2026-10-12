// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GameKit} from "../GameKit.sol";

/// Word hunt (free to play, no money moves). The Safe, or the keeper it names, opens a round with keccak256 of a
/// lowercase word and a length in blocks. A player commits keccak256(abi.encode(guess, player)) in one block and reveals
/// the guess in a later block. The first reveal of the word wins the round; `wins` counts each player's wins (a
/// leaderboard). A round with no winner closes empty. No deposits, no prize, nothing is ever credited.
contract WordHunt is GameKit {
    uint256 public constant MIN_BLOCKS = 10;
    uint256 public constant MAX_BLOCKS = 50_400;
    uint256 public constant MAX_LEN = 32;

    struct Commit {
        bytes32 h;
        uint64 blk;
    }

    uint256 public round;
    uint256 public endBlock;
    bytes32 public wordHash;
    address public winner;
    bool public closed;
    address public keeper;

    mapping(address => uint256) public wins;
    mapping(uint256 => mapping(address => Commit)) public commits;

    event KeeperSet(address indexed who);
    event RoundOpened(uint256 indexed id, bytes32 word, uint256 ends);
    event RoundClosed(uint256 indexed id);
    event Win(uint256 indexed id, address indexed player);
    event Miss(uint256 indexed id, address indexed player);

    error NotSetter();
    error RoundRunning();
    error NotEnded();
    error NothingToClose();
    error RoundOver();
    error BadLength();
    error ZeroHash();
    error AlreadyCommitted();
    error NoCommit();
    error SameBlock();
    error BadGuess();
    error BadReveal();

    /// Safe only. Zero clears the keeper.
    function setKeeper(address who) external {
        if (msg.sender != safe) revert NotSafe();
        keeper = who;
        emit KeeperSet(who);
    }

    /// The Safe or the keeper opens a round, once no round is running.
    function openRound(bytes32 h, uint64 lengthBlocks) external whenLive {
        if (msg.sender != safe && msg.sender != keeper) revert NotSetter();
        if (h == bytes32(0)) revert ZeroHash();
        if (lengthBlocks < MIN_BLOCKS || lengthBlocks > MAX_BLOCKS) revert BadLength();
        if (_roundOpen()) revert RoundRunning();
        round += 1;
        wordHash = h;
        endBlock = block.number + lengthBlocks;
        winner = address(0);
        closed = false;
        emit RoundOpened(round, h, endBlock);
    }

    /// Anyone, once the round has ended, if it has no winner. Once per round.
    function closeRound() external {
        if (round == 0 || closed || winner != address(0)) revert NothingToClose();
        if (block.number < endBlock) revert NotEnded();
        closed = true;
        emit RoundClosed(round);
    }

    /// Commit a hash of the guess and the sender. One open commit per sender per round.
    function commitGuess(bytes32 h) external whenLive {
        if (!_roundOpen()) revert RoundOver();
        if (h == bytes32(0)) revert ZeroHash();
        Commit storage c = commits[round][msg.sender];
        if (c.h != bytes32(0)) revert AlreadyCommitted();
        c.h = h;
        c.blk = uint64(block.number);
        _played(0);
    }

    /// Reveal the guess in a block after the commit. A correct guess is the round's winner (the first one is stored).
    function revealGuess(string calldata guess) external whenLive {
        if (!_roundOpen()) revert RoundOver();
        uint256 len = bytes(guess).length;
        if (len == 0 || len > MAX_LEN) revert BadGuess();
        Commit storage c = commits[round][msg.sender];
        if (c.h == bytes32(0)) revert NoCommit();
        if (c.blk >= block.number) revert SameBlock();
        if (keccak256(abi.encode(guess, msg.sender)) != c.h) revert BadReveal();
        delete commits[round][msg.sender];
        _played(0);
        if (keccak256(bytes(guess)) == wordHash) {
            winner = msg.sender;
            wins[msg.sender] += 1;
            emit Win(round, msg.sender);
        } else {
            emit Miss(round, msg.sender);
        }
    }

    /// The commitment a player posts: keccak256 of the guess with the player's own address.
    function hashGuess(string memory guess, address who) public pure returns (bytes32) {
        return keccak256(abi.encode(guess, who));
    }

    /// A round is running until it has a winner or its end block has passed.
    function _roundOpen() internal view override returns (bool) {
        return round != 0 && winner == address(0) && block.number < endBlock;
    }
}
