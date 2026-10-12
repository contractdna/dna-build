// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GameKit} from "../GameKit.sol";

/// Guild Arena (contracts/docs/games.md). Anyone founds a guild with a name, or joins one: 8 seats, one guild per
/// address. Epochs run 7 days from deployment. In each epoch the first half is a commit phase (a member commits
/// keccak256(secret, member, epoch)) and the second half a reveal phase (the member reveals the secret). One valid
/// reveal per member per epoch scores 1 point for the member (lifetime reputation) and 1 for its guild (per epoch,
/// with a leader per epoch). The game holds no money: it never pays, so it never credits and has no round to settle.
contract GuildArena is GameKit {
    uint256 public constant SEATS = 8;
    uint256 public constant EPOCH = 7 days;
    uint256 public constant HALF = EPOCH / 2;

    uint64 public start;
    uint256 public guildCount;

    mapping(uint256 guild => bytes32) public guildName;
    mapping(address member => uint256) public guildOf;
    mapping(uint256 guild => address[]) private _members;
    mapping(address member => uint256) private _slot;

    mapping(address member => uint256) public reputation;

    mapping(uint256 epoch => mapping(address member => bytes32)) public commitOf;
    mapping(uint256 epoch => mapping(address member => uint256)) public commitGuild;
    mapping(uint256 epoch => mapping(address member => bool)) public revealed;
    mapping(uint256 epoch => mapping(uint256 guild => uint256)) public guildPoints;
    mapping(uint256 epoch => uint256) public topGuild;

    event GuildCreated(uint256 indexed guild, bytes32 name, address indexed founder);
    event Joined(uint256 indexed guild, address indexed member);
    event Left(uint256 indexed guild, address indexed member);
    event Committed(uint256 indexed epoch, address indexed member, bytes32 hash);
    event Revealed(uint256 indexed epoch, uint256 indexed guild, address indexed member);

    error NoName();
    error AlreadyInGuild();
    error NotInGuild();
    error NoSuchGuild();
    error GuildFull();
    error RevealPhase();
    error NotRevealPhase();
    error NotCommitPhase();
    error ZeroCommit();
    error AlreadyCommitted();
    error NoCommit();
    error AlreadyRevealed();
    error BadSecret();
    error GuildChanged();

    constructor() {
        start = uint64(block.timestamp);
    }

    function createGuild(bytes32 name) external whenLive {
        if (name == bytes32(0)) revert NoName();
        if (guildOf[msg.sender] != 0) revert AlreadyInGuild();
        if (inRevealPhase()) revert RevealPhase();
        uint256 guild = ++guildCount;
        guildName[guild] = name;
        _seat(guild, msg.sender);
        emit GuildCreated(guild, name, msg.sender);
        _played(0);
    }

    function joinGuild(uint256 guild) external whenLive {
        if (guildOf[msg.sender] != 0) revert AlreadyInGuild();
        if (inRevealPhase()) revert RevealPhase();
        if (guild == 0 || guild > guildCount) revert NoSuchGuild();
        if (_members[guild].length >= SEATS) revert GuildFull();
        _seat(guild, msg.sender);
        emit Joined(guild, msg.sender);
        _played(0);
    }

    function leaveGuild() external whenLive {
        uint256 guild = guildOf[msg.sender];
        if (guild == 0) revert NotInGuild();
        if (inRevealPhase()) revert RevealPhase();
        _unseat(guild, msg.sender);
        emit Left(guild, msg.sender);
        _played(0);
    }

    function commit(bytes32 c) external whenLive {
        uint256 guild = guildOf[msg.sender];
        if (guild == 0) revert NotInGuild();
        if (inRevealPhase()) revert NotCommitPhase();
        if (c == bytes32(0)) revert ZeroCommit();
        uint256 e = currentEpoch();
        if (commitOf[e][msg.sender] != bytes32(0)) revert AlreadyCommitted();
        commitOf[e][msg.sender] = c;
        commitGuild[e][msg.sender] = guild;
        emit Committed(e, msg.sender, c);
        _played(0);
    }

    function reveal(bytes32 secret) external whenLive {
        if (!inRevealPhase()) revert NotRevealPhase();
        uint256 e = currentEpoch();
        bytes32 c = commitOf[e][msg.sender];
        if (c == bytes32(0)) revert NoCommit();
        if (revealed[e][msg.sender]) revert AlreadyRevealed();
        if (commitHash(secret, msg.sender, e) != c) revert BadSecret();
        uint256 guild = guildOf[msg.sender];
        if (guild == 0 || guild != commitGuild[e][msg.sender]) revert GuildChanged();
        revealed[e][msg.sender] = true;
        reputation[msg.sender] += 1;
        guildPoints[e][guild] += 1;
        // the first guild to reach a score keeps a tie: only a strictly higher score takes the lead
        if (guildPoints[e][guild] > guildPoints[e][topGuild[e]]) topGuild[e] = guild;
        emit Revealed(e, guild, msg.sender);
        _played(0);
    }

    function currentEpoch() public view returns (uint256) {
        return (block.timestamp - start) / EPOCH;
    }

    function inRevealPhase() public view returns (bool) {
        return (block.timestamp - start) % EPOCH >= HALF;
    }

    function epochStart(uint256 e) external view returns (uint256) {
        return start + e * EPOCH;
    }

    function commitHash(bytes32 secret, address member, uint256 e) public pure returns (bytes32) {
        return keccak256(abi.encode(secret, member, e));
    }

    function membersOf(uint256 guild) external view returns (address[] memory) {
        return _members[guild];
    }

    function memberCount(uint256 guild) external view returns (uint256) {
        return _members[guild].length;
    }

    function _seat(uint256 guild, address member) private {
        _slot[member] = _members[guild].length;
        _members[guild].push(member);
        guildOf[member] = guild;
    }

    /// Swap-and-pop: the last member takes the leaver's slot.
    function _unseat(uint256 guild, address member) private {
        address[] storage list = _members[guild];
        uint256 pos = _slot[member];
        address last = list[list.length - 1];
        list[pos] = last;
        _slot[last] = pos;
        list.pop();
        delete _slot[member];
        guildOf[member] = 0;
    }

    /// The game holds no round: nothing to settle before a sweep.
    function _roundOpen() internal pure override returns (bool) {
        return false;
    }
}
