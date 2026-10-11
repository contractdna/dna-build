// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IModuleRegistry} from "./interfaces/IDNA.sol";

/// @title IdeaMarket (SPEC §10)
/// @notice Anyone stakes DNA to back ideas. Per 24-hour round, stakes on rejected ideas are paid pro-rata to stakers
///         of accepted ideas ("accepted" = selected for implementation after research + red-team). Void ideas refund.
///         A round with no accepted stake refunds everyone. Immutable escrow: no owner, no admin withdraw, no pause.
///         Roles come from ModuleRegistry: `safe` cached, `agent`/`anchorKey`/`agentPaused` read live.
/// @dev DNA is OZ ERC20 (reverts on failure, no fee-on-transfer, no hooks), so no guard: CEI and the only external
///      calls are DNA and registry views.
contract IdeaMarket {
    enum Status {
        Open,
        Proposed,
        Final
    }

    struct Idea {
        uint32 round;
        uint8 index; // bit in the round's outcome bitmaps
        uint128 staked;
    }

    struct Round {
        Status status;
        uint8 count; // ideas submitted (public + agent)
        uint8 agentCount;
        uint32 firstId; // round ideas = [firstId, firstId + count)
        uint40 proposedAt;
        address proposer;
        uint128 accepted; // bitmap; disjoint from voided; the rest are rejected
        uint128 voided;
        uint128 acceptedStake; // A, set at finalize
        uint128 rejectedStake; // R, set at finalize
    }

    uint256 public constant ROUND_LENGTH = 24 hours;
    uint256 public constant RESOLVE_WINDOW = 3 days; // proposals only in [roundEnd, roundEnd + RESOLVE_WINDOW)
    uint256 public constant MIN_DELAY = 24 hours;
    uint256 public constant MIN_SUBMIT = 10_000 ether; // refundable opening stake
    uint256 public constant SUBMIT_FEE = 1_000 ether; // burned, non-refundable (public submits only)
    uint256 public constant MIN_STAKE = 1_000 ether;
    uint256 public constant MAX_PER_ADDRESS = 1_000_000 ether; // per address per round
    uint256 public constant MAX_PER_IDEA = 2_000_000 ether;
    uint256 public constant MAX_IDEAS = 128; // per round = bitmap width
    uint256 public constant MAX_AGENT_IDEAS = 16; // reserved for agent zero-stake intake
    uint256 public constant MAX_PUBLIC_IDEAS = MAX_IDEAS - MAX_AGENT_IDEAS;
    uint256 public constant MAX_TITLE = 120; // bytes
    uint256 public constant MAX_BODY = 1_000; // bytes

    ERC20Burnable public immutable token;
    IModuleRegistry public immutable registry;
    address public immutable safe;
    uint256 public immutable START;

    uint256 public nextId = 1;
    mapping(uint256 => Idea) public ideas;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => uint256)) public stakeOf; // id => staker => stake
    mapping(uint256 => mapping(address => uint256)) public roundStakeOf; // round => staker => stake

    event IdeaSubmitted(
        uint256 indexed id,
        uint256 indexed round,
        address indexed author,
        uint256 index,
        uint256 stake,
        string title,
        string body
    );
    event Staked(uint256 indexed id, address indexed staker, uint256 amount, uint256 ideaTotal);
    event OutcomeProposed(
        uint256 indexed round,
        address indexed by,
        uint128 accepted,
        uint128 voided,
        bytes32 reportHash,
        string uri,
        uint256 eta
    );
    event OutcomeCancelled(uint256 indexed round);
    event RoundFinalized(
        uint256 indexed round,
        uint128 accepted,
        uint128 voided,
        uint256 acceptedStake,
        uint256 rejectedStake,
        bool expired
    );
    event Claimed(uint256 indexed id, address indexed staker, uint256 stake, uint256 payout);

    error BadConfig();
    error BadText();
    error Operator();
    error Unauthorized();
    error RoundFull();
    error TooSmall();
    error CapExceeded();
    error UnknownIdea();
    error NotCurrentRound();
    error OutsideWindow();
    error BadStatus();
    error EmptyRound();
    error BadBitmap();
    error TooEarly();

    constructor(ERC20Burnable token_, IModuleRegistry registry_) {
        // worst-case round TVL ≤ supply ≤ uint128 ⇒ every stake sum fits uint128 and s·R fits uint256
        uint256 supply = token_.totalSupply();
        if (address(registry_).code.length == 0 || MAX_IDEAS * MAX_PER_IDEA > supply || supply > type(uint128).max) {
            revert BadConfig();
        }
        token = token_;
        registry = registry_;
        safe = registry_.safe();
        START = block.timestamp;
    }

    // ------------------------------------------------------------------ users

    /// @notice Submit an idea. Public: `amount ≥ MIN_SUBMIT` opening stake plus a burned SUBMIT_FEE (approve both).
    ///         Agent (unpaused): `amount == 0`, no fee (X-mention intake). Safe and anchorKey cannot submit.
    ///         Lands in the round of the block's timestamp. Text lives in the event only and is untrusted.
    function submit(string calldata title, string calldata body, uint256 amount) external returns (uint256 id) {
        if (bytes(title).length == 0 || bytes(title).length > MAX_TITLE || bytes(body).length > MAX_BODY) {
            revert BadText();
        }
        uint256 r = currentRound();
        Round storage rd = rounds[r];
        bool isAgent = msg.sender == registry.agent();
        if (isAgent) {
            if (amount != 0) revert Operator();
            if (registry.agentPaused()) revert Unauthorized();
            if (rd.agentCount >= MAX_AGENT_IDEAS) revert RoundFull();
            rd.agentCount++;
        } else {
            if (msg.sender == safe || msg.sender == registry.anchorKey()) revert Operator();
            if (amount < MIN_SUBMIT) revert TooSmall();
            if (rd.count - rd.agentCount >= MAX_PUBLIC_IDEAS) revert RoundFull();
        }
        id = nextId++;
        if (rd.count == 0) rd.firstId = uint32(id);
        uint8 index = rd.count++;
        ideas[id] = Idea(uint32(r), index, 0);
        emit IdeaSubmitted(id, r, msg.sender, index, amount, title, body);
        if (!isAgent) {
            _stake(id, r, amount);
            token.burnFrom(msg.sender, SUBMIT_FEE);
        }
    }

    /// @notice Back an idea while its round is current. Operators (Safe, agent, anchorKey) cannot stake.
    function stake(uint256 id, uint256 amount) external {
        if (id == 0 || id >= nextId) revert UnknownIdea();
        uint256 r = ideas[id].round;
        if (r != currentRound()) revert NotCurrentRound();
        if (amount < MIN_STAKE) revert TooSmall();
        if (msg.sender == safe || msg.sender == registry.agent() || msg.sender == registry.anchorKey()) {
            revert Operator();
        }
        _stake(id, r, amount);
    }

    /// @notice Pay out the caller's positions on `ids` (all in Final rounds) in one transfer. Zero positions skip.
    function claim(uint256[] calldata ids) external returns (uint256 total) {
        for (uint256 k; k < ids.length; ++k) {
            uint256 id = ids[k];
            uint256 s = stakeOf[id][msg.sender];
            if (s == 0) continue;
            Idea memory i = ideas[id];
            Round storage rd = rounds[i.round];
            if (rd.status != Status.Final) revert BadStatus();
            stakeOf[id][msg.sender] = 0;
            uint256 p = _payout(rd, i.index, s);
            total += p;
            emit Claimed(id, msg.sender, s, p);
        }
        if (total != 0) token.transfer(msg.sender, total);
    }

    // ------------------------------------------------------------------ resolution

    /// @notice Safe or unpaused agent proposes a round outcome; final after MIN_DELAY unless the Safe cancels.
    function proposeOutcome(uint256 round, uint128 accepted, uint128 voided, bytes32 reportHash, string calldata uri)
        external
    {
        if (!_canResolve(msg.sender)) revert Unauthorized();
        uint256 end = roundEnd(round);
        if (block.timestamp < end || block.timestamp >= end + RESOLVE_WINDOW) revert OutsideWindow();
        Round storage rd = rounds[round];
        if (rd.status != Status.Open) revert BadStatus();
        if (rd.count == 0) revert EmptyRound();
        if (accepted & voided != 0 || uint256(accepted | voided) >= uint256(1) << rd.count) revert BadBitmap();
        (rd.status, rd.proposedAt, rd.proposer, rd.accepted, rd.voided) =
        (Status.Proposed, uint40(block.timestamp), msg.sender, accepted, voided);
        emit OutcomeProposed(round, msg.sender, accepted, voided, reportHash, uri, block.timestamp + MIN_DELAY);
    }

    /// @notice Safe veto of a pending outcome.
    function cancelOutcome(uint256 round) external {
        if (msg.sender != safe) revert Unauthorized();
        Round storage rd = rounds[round];
        if (rd.status != Status.Proposed) revert BadStatus();
        rd.status = Status.Open;
        emit OutcomeCancelled(round);
    }

    /// @notice Anyone. (a) Proposed ≥ MIN_DELAY ago by a still-valid proposer → apply it. (b) Otherwise, from
    ///         roundEnd + RESOLVE_WINDOW + MIN_DELAY → all void (full refunds). Empty rounds never finalize.
    function finalize(uint256 round) external {
        Round storage rd = rounds[round];
        if (rd.status == Status.Final) revert BadStatus();
        uint256 n = rd.count;
        if (n == 0) revert EmptyRound();
        bool expired =
            !(rd.status == Status.Proposed && block.timestamp >= rd.proposedAt + MIN_DELAY && _canResolve(rd.proposer));
        if (expired) {
            if (block.timestamp < roundEnd(round) + RESOLVE_WINDOW + MIN_DELAY) revert TooEarly();
            (rd.accepted, rd.voided) = (0, uint128((uint256(1) << n) - 1));
        }
        (uint256 acc, uint256 voi, uint256 first) = (rd.accepted, rd.voided, rd.firstId);
        uint256 a;
        uint256 rej;
        for (uint256 k; k < n; ++k) {
            uint256 s = ideas[first + k].staked;
            if ((acc >> k) & 1 == 1) a += s;
            else if ((voi >> k) & 1 == 0) rej += s;
        }
        (rd.status, rd.acceptedStake, rd.rejectedStake) = (Status.Final, uint128(a), uint128(rej));
        emit RoundFinalized(round, rd.accepted, rd.voided, a, rej, expired);
    }

    // ------------------------------------------------------------------ views

    function currentRound() public view returns (uint256) {
        return (block.timestamp - START) / ROUND_LENGTH;
    }

    function roundEnd(uint256 round) public view returns (uint256) {
        return START + (round + 1) * ROUND_LENGTH;
    }

    /// @notice What `claim([id])` would pay `staker` now (0 if not Final).
    function claimable(uint256 id, address staker) external view returns (uint256) {
        Idea memory i = ideas[id];
        Round storage rd = rounds[i.round];
        if (rd.status != Status.Final) return 0;
        return _payout(rd, i.index, stakeOf[id][staker]);
    }

    // ------------------------------------------------------------------ internal

    /// @dev void, or no accepted stake (A == 0, round refunds all): s · accepted: s + floor(s·R/A) · rejected: 0.
    function _payout(Round storage rd, uint8 index, uint256 s) internal view returns (uint256) {
        if ((rd.voided >> index) & 1 == 1 || rd.acceptedStake == 0) return s;
        if ((rd.accepted >> index) & 1 == 1) return s + s * rd.rejectedStake / rd.acceptedStake;
        return 0;
    }

    function _stake(uint256 id, uint256 r, uint256 amount) internal {
        Idea storage i = ideas[id];
        uint256 total = i.staked + amount;
        uint256 mine = roundStakeOf[r][msg.sender] + amount;
        if (total > MAX_PER_IDEA || mine > MAX_PER_ADDRESS) revert CapExceeded();
        i.staked = uint128(total);
        roundStakeOf[r][msg.sender] = mine;
        stakeOf[id][msg.sender] += amount;
        emit Staked(id, msg.sender, amount, total);
        token.transferFrom(msg.sender, address(this), amount);
    }

    function _canResolve(address who) internal view returns (bool) {
        return who == safe || (who == registry.agent() && !registry.agentPaused());
    }
}
