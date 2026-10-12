// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GameKit} from "../GameKit.sol";

/// Word Hunt (free to play, no money moves): the Safe, or the keeper it names, opens a round with keccak256 of a
/// lowercase word and a length in blocks. A player commits keccak256(guess, player) (one open commit per round), then
/// reveals the guess from the same address in a later block. The first right reveal wins the round: it is stored,
/// `Win` is emitted and the player's win count goes up (a leaderboard, no prize). A round with no winner closes empty.
contract WordHunt is GameKit {
    uint256 public constant MIN_BLOCKS = 10;
    uint256 public constant MAX_BLOCKS = 50_400;
    uint256 public constant MAX_LEN = 32;

    address public keeper;
    uint256 public roundId;
    bytes32 public wordHash;
    uint256 public endBlock;
    bool public closed;
    address public winner;
    mapping(uint256 round => address) public winnerOf;
    mapping(address player => uint256) public wins;
    mapping(uint256 round => mapping(address player => bytes32)) public commitHash;
    mapping(uint256 round => mapping(address player => uint256)) public commitBlock;

    event KeeperSet(address indexed who);
    event Opened(uint256 indexed round, bytes32 word, uint256 last);
    event Win(uint256 indexed round, address indexed player);
    event Closed(uint256 indexed round);

    error NotSetter();
    error BadHash();
    error BadLength();
    error BadGuessLength();
    error NoOpenRound();
    error RoundIsOpen();
    error RoundRunning();
    error AlreadyCommitted();
    error NoCommit();
    error SameBlock();
    error WrongCommit();

    /// The Safe names (or clears, with address(0)) the keeper that may open rounds.
    function setKeeper(address k) external {
        if (msg.sender != safe) revert NotSafe();
        keeper = k;
        emit KeeperSet(k);
    }

    /// Open a round: `h` is keccak256 of the lowercase word, `len` its length in blocks. No play is counted.
    function openRound(bytes32 h, uint64 len) external whenLive {
        if (msg.sender != safe && msg.sender != keeper) revert NotSetter();
        if (h == bytes32(0)) revert BadHash();
        if (len < MIN_BLOCKS || len > MAX_BLOCKS) revert BadLength();
        if (roundOpen()) revert RoundIsOpen();
        roundId += 1;
        wordHash = h;
        endBlock = block.number + len;
        closed = false;
        winner = address(0);
        emit Opened(roundId, h, endBlock);
    }

    /// Anyone, once the round's last block has passed: it closes (empty when nobody won).
    function closeRound() external {
        if (roundId == 0 || closed) revert NoOpenRound();
        if (block.number <= endBlock) revert RoundRunning();
        closed = true;
        emit Closed(roundId);
    }

    /// The commitment a player makes for a guess: it is bound to the player's address.
    function commitHashOf(string memory guess, address player) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(guess, player));
    }

    /// Commit a hash for this round. One open commit per address per round; a reveal (right or wrong) clears it.
    function commitGuess(bytes32 h) external whenLive {
        if (!roundOpen()) revert NoOpenRound();
        if (h == bytes32(0)) revert BadHash();
        if (commitHash[roundId][msg.sender] != bytes32(0)) revert AlreadyCommitted();
        commitHash[roundId][msg.sender] = h;
        commitBlock[roundId][msg.sender] = block.number;
        _played(0);
    }

    /// Reveal a guess in a later block than the commit, from the same address. The first right one wins the round.
    function revealGuess(string calldata guess) external whenLive {
        if (!roundOpen()) revert NoOpenRound();
        uint256 n = bytes(guess).length;
        if (n == 0 || n > MAX_LEN) revert BadGuessLength();
        bytes32 h = commitHash[roundId][msg.sender];
        if (h == bytes32(0)) revert NoCommit();
        if (block.number <= commitBlock[roundId][msg.sender]) revert SameBlock();
        if (keccak256(abi.encodePacked(guess, msg.sender)) != h) revert WrongCommit();
        delete commitHash[roundId][msg.sender];
        delete commitBlock[roundId][msg.sender];
        _played(0);
        if (keccak256(bytes(guess)) == wordHash) {
            winner = msg.sender;
            winnerOf[roundId] = msg.sender;
            wins[msg.sender] += 1;
            closed = true;
            emit Win(roundId, msg.sender);
        }
    }

    /// A round is open from its opening until its last block, and until it is won or closed.
    function roundOpen() public view returns (bool) {
        return roundId != 0 && !closed && block.number <= endBlock;
    }

    function _roundOpen() internal view override returns (bool) {
        return roundOpen();
    }
}
