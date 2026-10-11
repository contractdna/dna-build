// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ConvictionVault} from "./ConvictionVault.sol";
import {IModuleRegistry} from "./interfaces/IDNA.sol";

interface IRegistryQueue {
    function queued(uint256 id) external view returns (uint8 op, address proposer, uint64 queuedAt, bytes memory data);
}

/// @title MutationBoard (SPEC §14)
/// @notice Holders steer what the AI tests next; it holds nothing. Votes and mysteries pick what is TESTED next
///         (queued through ModuleRegistry, still behind every gate), never what is kept.
///         - Ballot: the agent (L ≥ 5, unpaused) or the Safe offers 3 options at most once per 48 h; voting opens
///           1 h later (the Safe's veto window) and lasts 24 h; weight = Σ ConvictionVault.weightAt(id, ballot start).
///           The agent then records `BallotRun` (the winner was queued: checked on chain against the registry
///           queue) or `BallotSkipped` (the gates refused it).
///         - Mystery: the agent or the Safe seals keccak256(salt ‖ payload) for a reveal 2–7 d out; anyone reveals
///           within 24 h of `revealAt`; unrevealed → `markBroken`; the Safe can cancel ("cancelled by guardian").
///         No owner, no pause, no proxy. Roles are read live from the registry.
contract MutationBoard {
    enum MysteryStatus {
        None,
        Sealed,
        Revealed,
        Run,
        Rejected,
        Broken,
        Cancelled
    }

    struct Ballot {
        bytes32[3] options; // option descriptors (hash of the public description / plate + params)
        uint40 start; // voting opens (proposal + VETO_WINDOW)
        uint40 end; // start + VOTING
        bool cancelled;
        bool resolved; // BallotRun / BallotSkipped recorded
        uint256[3] tally;
    }

    struct Vote {
        uint8 option; // 1-based; 0 = never voted
        uint248 weight;
    }

    struct Mystery {
        bytes32 commitment; // keccak256(abi.encodePacked(salt, payload))
        uint40 revealAt;
        MysteryStatus status;
        address sealer;
    }

    uint256 public constant BALLOT_EVERY = 48 hours;
    uint256 public constant VETO_WINDOW = 1 hours;
    uint256 public constant VOTING = 24 hours;
    uint256 public constant REVEAL_MIN = 2 days;
    uint256 public constant REVEAL_MAX = 7 days;
    uint256 public constant REVEAL_WINDOW = 24 hours;
    uint256 public constant MAX_PAYLOAD = 2048; // bytes
    uint8 public constant MIN_LEVEL = 5;

    ConvictionVault public immutable vault;
    IModuleRegistry public immutable registry;
    address public immutable safe;

    uint256 public ballotCount;
    uint256 public lastBallotAt;
    mapping(uint256 => Ballot) internal _ballots;
    mapping(uint256 => mapping(uint256 => Vote)) public votes; // ballot => position id => vote
    uint256 public mysteryCount;
    uint256 public pendingMystery; // the one Sealed mystery (0 = none)
    mapping(uint256 => Mystery) public mysteries;

    event BallotProposed(uint256 indexed ballot, bytes32[3] options, uint256 start, uint256 end, address indexed by);
    event BallotCancelled(uint256 indexed ballot);
    event Voted(
        uint256 indexed ballot, uint256 indexed positionId, address indexed voter, uint8 option, uint256 weight
    );
    event BallotRun(uint256 indexed ballot, uint8 option, uint256 registryOpId);
    event BallotSkipped(uint256 indexed ballot, bytes32 reasonHash);
    event Sealed(uint256 indexed mystery, bytes32 commitment, uint256 revealAt, address indexed by);
    event Revealed(uint256 indexed mystery, bytes32 salt, bytes payload);
    event Run(uint256 indexed mystery, uint256 registryOpId);
    event Rejected(uint256 indexed mystery, bytes32 reasonHash);
    event Broken(uint256 indexed mystery);
    event CancelledByGuardian(uint256 indexed mystery);

    error BadConfig();
    error Unauthorized();
    error TooSoon();
    error NotVoting();
    error BadOption();
    error NotOwner();
    error NotOver();
    error Resolved();
    error NotAgentOp();
    error NotWinner();
    error BadReveal();
    error MysteryPending();
    error BadStatus();
    error BadSeal();

    constructor(ConvictionVault vault_, IModuleRegistry registry_) {
        if (address(vault_).code.length == 0 || address(registry_).code.length == 0) revert BadConfig();
        vault = vault_;
        registry = registry_;
        safe = registry_.safe();
    }

    // ------------------------------------------------------------------ ballots

    /// @notice Agent (L ≥ 5, unpaused) or Safe; at most one ballot per BALLOT_EVERY.
    function propose(bytes32[3] calldata options) external returns (uint256 id) {
        if (!_canPropose(msg.sender)) revert Unauthorized();
        if (lastBallotAt != 0 && block.timestamp < lastBallotAt + BALLOT_EVERY) revert TooSoon();
        lastBallotAt = block.timestamp;
        id = ++ballotCount;
        Ballot storage b = _ballots[id];
        b.options = options;
        b.start = uint40(block.timestamp + VETO_WINDOW);
        b.end = uint40(block.timestamp + VETO_WINDOW + VOTING);
        emit BallotProposed(id, options, b.start, b.end, msg.sender);
    }

    /// @notice Safe veto, any time before the ballot is resolved. A veto inside the 1 h window (before voting opens)
    ///         frees the ballot slot, so a vetoed ballot can be replaced instead of costing a BALLOT_EVERY period.
    function cancelBallot(uint256 id) external {
        if (msg.sender != safe) revert Unauthorized();
        Ballot storage b = _ballots[id];
        if (b.start == 0 || b.resolved) revert BadStatus();
        b.cancelled = true;
        if (id == ballotCount && block.timestamp < b.start) lastBallotAt = 0;
        emit BallotCancelled(id);
    }

    /// @notice Vote with the caller's positions. Weight = weightAt(id, ballot start) (streak included; 0 for positions
    ///         younger than MIN_AGE at the start or withdrawn). Re-voting moves the stored prior weight.
    function vote(uint256 id, uint8 option, uint256[] calldata positionIds) external {
        Ballot storage b = _ballots[id];
        if (b.cancelled || block.timestamp < b.start || block.timestamp >= b.end) revert NotVoting();
        if (option >= 3) revert BadOption();
        uint256 start = b.start;
        for (uint256 k; k < positionIds.length; ++k) {
            uint256 pid = positionIds[k];
            if (vault.positions(pid).owner != msg.sender) revert NotOwner();
            Vote memory prior = votes[id][pid];
            if (prior.option != 0) b.tally[prior.option - 1] -= prior.weight;
            uint256 w = vault.weightAt(pid, start);
            b.tally[option] += w;
            votes[id][pid] = Vote(option + 1, uint248(w));
            emit Voted(id, pid, msg.sender, option, w);
        }
    }

    /// @notice Winning option after voting ends: the highest tally; ties (and an all-zero ballot) go to the lowest
    ///         index.
    function winner(uint256 id) public view returns (uint8 w) {
        Ballot storage b = _ballots[id];
        if (b.start == 0 || block.timestamp < b.end) revert NotOver();
        for (uint8 i = 1; i < 3; ++i) {
            if (b.tally[i] > b.tally[w]) w = i;
        }
    }

    /// @notice Agent: the winner was queued in the registry as op `registryOpId`, proposed by the agent itself.
    function ballotRun(uint256 id, uint8 option, uint256 registryOpId) external {
        _resolveBallot(id);
        if (option != winner(id)) revert NotWinner();
        _requireAgentOp(registryOpId);
        emit BallotRun(id, option, registryOpId);
    }

    /// @notice Agent: the winner failed the safety gates and was not queued.
    function ballotSkipped(uint256 id, bytes32 reasonHash) external {
        _resolveBallot(id);
        winner(id); // only after voting ends
        emit BallotSkipped(id, reasonHash);
    }

    function ballots(uint256 id)
        external
        view
        returns (
            bytes32[3] memory options,
            uint256 start,
            uint256 end,
            bool cancelled,
            bool resolved,
            uint256[3] memory tally
        )
    {
        Ballot storage b = _ballots[id];
        return (b.options, b.start, b.end, b.cancelled, b.resolved, b.tally);
    }

    // ------------------------------------------------------------------ mysteries

    /// @notice Agent (L ≥ 5, unpaused) or Safe; one sealed mystery at a time; reveal 2–7 d out.
    function seal(bytes32 commitment, uint256 revealAt) external returns (uint256 id) {
        if (!_canPropose(msg.sender)) revert Unauthorized();
        if (pendingMystery != 0) revert MysteryPending();
        if (revealAt < block.timestamp + REVEAL_MIN || revealAt > block.timestamp + REVEAL_MAX) revert BadSeal();
        if (commitment == bytes32(0)) revert BadSeal(); // an empty commitment could never be revealed
        id = ++mysteryCount;
        mysteries[id] = Mystery(commitment, uint40(revealAt), MysteryStatus.Sealed, msg.sender);
        pendingMystery = id;
        emit Sealed(id, commitment, revealAt, msg.sender);
    }

    /// @notice Anyone with the salt and payload, within REVEAL_WINDOW from `revealAt`.
    function reveal(uint256 id, bytes32 salt, bytes calldata payload) external {
        Mystery storage m = mysteries[id];
        if (m.status != MysteryStatus.Sealed) revert BadStatus();
        if (block.timestamp < m.revealAt || block.timestamp >= uint256(m.revealAt) + REVEAL_WINDOW) revert BadReveal();
        if (payload.length > MAX_PAYLOAD || keccak256(abi.encodePacked(salt, payload)) != m.commitment) {
            revert BadReveal();
        }
        m.status = MysteryStatus.Revealed;
        pendingMystery = 0;
        emit Revealed(id, salt, payload);
    }

    /// @notice Anyone, once the reveal window passed unrevealed.
    function markBroken(uint256 id) external {
        Mystery storage m = mysteries[id];
        if (m.status != MysteryStatus.Sealed || block.timestamp < uint256(m.revealAt) + REVEAL_WINDOW) {
            revert BadStatus();
        }
        m.status = MysteryStatus.Broken;
        pendingMystery = 0;
        emit Broken(id);
    }

    /// @notice Safe veto of a sealed mystery, labelled publicly as "cancelled by guardian".
    function cancelSeal(uint256 id) external {
        if (msg.sender != safe) revert Unauthorized();
        Mystery storage m = mysteries[id];
        if (m.status != MysteryStatus.Sealed) revert BadStatus();
        m.status = MysteryStatus.Cancelled;
        pendingMystery = 0;
        emit CancelledByGuardian(id);
    }

    /// @notice Agent: the revealed payload was queued in the registry as `registryOpId` (proposed by the agent).
    function mysteryRun(uint256 id, uint256 registryOpId) external {
        Mystery storage m = _revealedByAgent(id);
        _requireAgentOp(registryOpId);
        m.status = MysteryStatus.Run;
        emit Run(id, registryOpId);
    }

    /// @notice Agent: the revealed payload failed the safety gates.
    function mysteryRejected(uint256 id, bytes32 reasonHash) external {
        Mystery storage m = _revealedByAgent(id);
        m.status = MysteryStatus.Rejected;
        emit Rejected(id, reasonHash);
    }

    // ------------------------------------------------------------------ internal

    function _canPropose(address who) internal view returns (bool) {
        return who == safe || (_isAgent(who) && registry.level() >= MIN_LEVEL);
    }

    function _isAgent(address who) internal view returns (bool) {
        return who == registry.agent() && !registry.agentPaused();
    }

    function _resolveBallot(uint256 id) internal {
        if (!_isAgent(msg.sender)) revert Unauthorized();
        Ballot storage b = _ballots[id];
        if (b.cancelled || b.resolved) revert Resolved();
        b.resolved = true;
    }

    function _revealedByAgent(uint256 id) internal view returns (Mystery storage m) {
        if (!_isAgent(msg.sender)) revert Unauthorized();
        m = mysteries[id];
        if (m.status != MysteryStatus.Revealed) revert BadStatus();
    }

    /// @dev The op exists in the registry queue and the current agent proposed it.
    function _requireAgentOp(uint256 opId) internal view {
        (, address proposer,,) = IRegistryQueue(address(registry)).queued(opId);
        if (proposer == address(0) || proposer != registry.agent()) revert NotAgentOp();
    }
}
