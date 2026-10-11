// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IModuleRegistry} from "./interfaces/IDNA.sol";

/// @title BountyBoard (SPEC §11)
/// @notice ETH bounties escrowed by the Safe. The agent (read live from ModuleRegistry) may propose unfunded bounties
///         and recommend winners; the Safe funds, awards, and cancels. At autonomy level ≥ 7 the agent may also fund
///         its proposals from a Safe-deposited allowance and award those (never Safe-escrowed bounties).
///         Unawarded Safe escrow returns to the Safe; unawarded allowance escrow returns to the allowance.
///         No receive(): ETH arrives only with propose/fund/fundAllowance (forced ETH is ignored; invariants use ≥).
contract BountyBoard is ReentrancyGuardTransient {
    enum Status {
        None,
        Proposed, // unfunded agent proposal
        Open, // funded
        Awarded,
        Cancelled,
        Expired
    }

    struct Bounty {
        uint96 reward;
        uint64 deadline;
        Status status;
        bool fromAllowance; // funded by the agent from the allowance
        address winner;
    }

    uint256 public constant AWARD_GRACE = 7 days; // Open and unawarded past deadline + grace → anyone may expire
    uint256 public constant MAX_TITLE = 120; // bytes
    uint256 public constant MAX_REQUEST = 2_000; // bytes
    uint256 public constant MAX_REQUIREMENTS = 16;
    uint256 public constant MAX_URI = 512; // bytes
    uint8 public constant ALLOWANCE_LEVEL = 7; // registry level at which the agent spends the allowance

    IModuleRegistry public immutable registry;
    address public immutable safe;

    uint256 public nextId = 1;
    mapping(uint256 => Bounty) public bounties;
    uint256 public allowance; // Safe-deposited ETH the agent may move into bounties; not part of any bounty's escrow

    event BountyProposed(
        uint256 indexed id,
        address indexed by,
        uint256 reward,
        uint256 deadline,
        string title,
        string request,
        string[] requirements,
        bool funded
    );
    event BountyFunded(uint256 indexed id, uint256 reward, bool fromAllowance);
    event WorkSubmitted(uint256 indexed id, address indexed by, string uri);
    event AwardRecommended(uint256 indexed id, address indexed winner, bytes32 ref);
    event BountyAwarded(uint256 indexed id, address indexed winner, uint256 reward, bytes32 ref);
    event BountyClosed(uint256 indexed id, bool expired, uint256 refunded);
    event AllowanceFunded(uint256 amount, uint256 allowance);
    event AllowanceWithdrawn(uint256 amount, uint256 allowance);

    error BadConfig();
    error Unauthorized();
    error BadValue();
    error BadInput();
    error BadStatus();
    error PastDeadline();
    error TooEarly();

    constructor(IModuleRegistry registry_) {
        if (address(registry_).code.length == 0) revert BadConfig();
        registry = registry_;
        safe = registry_.safe();
    }

    /// @notice Safe: `msg.value == reward` → Open. Unpaused agent: `msg.value == 0` → Proposed (Safe may `fund`).
    function propose(
        uint96 reward,
        uint64 deadline,
        string calldata title,
        string calldata request,
        string[] calldata requirements
    ) external payable returns (uint256 id) {
        bool funded = msg.sender == safe;
        if (funded) {
            if (msg.value != reward) revert BadValue();
        } else {
            if (msg.sender != registry.agent() || registry.agentPaused()) revert Unauthorized();
            if (msg.value != 0) revert BadValue();
        }
        if (
            reward == 0 || deadline <= block.timestamp || bytes(title).length == 0 || bytes(title).length > MAX_TITLE
                || bytes(request).length > MAX_REQUEST || requirements.length > MAX_REQUIREMENTS
        ) revert BadInput();
        id = nextId++;
        bounties[id] = Bounty(reward, deadline, funded ? Status.Open : Status.Proposed, false, address(0));
        emit BountyProposed(id, msg.sender, reward, deadline, title, request, requirements, funded);
    }

    /// @notice Fund an agent proposal before its deadline: the Safe with `msg.value == reward`, or the unpaused agent at
    ///         level ≥ 7 from the allowance (`msg.value == 0`, `reward ≤ allowance`).
    function fund(uint256 id) external payable {
        bool bySafe = msg.sender == safe;
        if (!bySafe && !_agentSpends()) revert Unauthorized();
        Bounty storage b = bounties[id];
        if (b.status != Status.Proposed) revert BadStatus();
        if (block.timestamp >= b.deadline) revert PastDeadline();
        if (bySafe) {
            if (msg.value != b.reward) revert BadValue();
        } else {
            if (msg.value != 0 || b.reward > allowance) revert BadValue();
            allowance -= b.reward;
            b.fromAllowance = true;
        }
        b.status = Status.Open;
        emit BountyFunded(id, b.reward, !bySafe);
    }

    /// @notice Safe deposits ETH into the agent's bounty allowance.
    function fundAllowance() external payable {
        if (msg.sender != safe) revert Unauthorized();
        if (msg.value == 0) revert BadValue();
        allowance += msg.value;
        emit AllowanceFunded(msg.value, allowance);
    }

    /// @notice Safe takes back unspent allowance, any time (escrow already in Open bounties stays there).
    function withdrawAllowance(uint256 amount) external nonReentrant {
        if (msg.sender != safe) revert Unauthorized();
        if (amount == 0 || amount > allowance) revert BadValue();
        allowance -= amount;
        emit AllowanceWithdrawn(amount, allowance);
        Address.sendValue(payable(safe), amount);
    }

    /// @notice Anyone submits work to an Open bounty before its deadline (event only; untrusted).
    function submit(uint256 id, string calldata uri) external {
        Bounty storage b = bounties[id];
        if (b.status != Status.Open) revert BadStatus();
        if (block.timestamp >= b.deadline) revert PastDeadline();
        if (bytes(uri).length == 0 || bytes(uri).length > MAX_URI) revert BadInput();
        emit WorkSubmitted(id, msg.sender, uri);
    }

    /// @notice Unpaused agent recommends a winner (event only; the Safe decides).
    function recommend(uint256 id, address winner, bytes32 ref) external {
        if (msg.sender != registry.agent() || registry.agentPaused()) revert Unauthorized();
        if (bounties[id].status != Status.Open) revert BadStatus();
        if (winner == address(0)) revert BadInput();
        emit AwardRecommended(id, winner, ref);
    }

    /// @notice Safe pays the reward to one winner; the agent at level ≥ 7 too, for allowance-funded bounties only.
    ///         A reverting winner reverts the award; pick another.
    function award(uint256 id, address payable winner, bytes32 ref) external nonReentrant {
        Bounty storage b = bounties[id];
        if (msg.sender != safe && !(b.fromAllowance && _agentSpends())) revert Unauthorized();
        if (b.status != Status.Open) revert BadStatus();
        if (winner == address(0)) revert BadInput();
        (b.status, b.winner) = (Status.Awarded, winner);
        emit BountyAwarded(id, winner, b.reward, ref);
        Address.sendValue(winner, b.reward);
    }

    /// @notice Safe closes a Proposed or Open bounty; Open escrow returns to the Safe (or to the allowance it came from).
    function cancel(uint256 id) external nonReentrant {
        if (msg.sender != safe) revert Unauthorized();
        _close(id, Status.Cancelled);
    }

    /// @notice Anyone: Proposed past deadline, or Open past deadline + AWARD_GRACE → Expired, escrow back as in cancel.
    function expire(uint256 id) external nonReentrant {
        Bounty storage b = bounties[id];
        uint256 at = b.status == Status.Open ? b.deadline + AWARD_GRACE : b.deadline;
        if (block.timestamp < at) revert TooEarly();
        _close(id, Status.Expired);
    }

    function _close(uint256 id, Status to) internal {
        Bounty storage b = bounties[id];
        Status s = b.status;
        if (s != Status.Proposed && s != Status.Open) revert BadStatus();
        b.status = to;
        uint256 refund = s == Status.Open ? b.reward : 0;
        emit BountyClosed(id, to == Status.Expired, refund);
        if (b.fromAllowance) allowance += refund;
        else if (refund != 0) Address.sendValue(payable(safe), refund);
    }

    /// @dev Unpaused agent at autonomy level ≥ ALLOWANCE_LEVEL (all read live from the registry).
    function _agentSpends() internal view returns (bool) {
        return msg.sender == registry.agent() && !registry.agentPaused() && registry.level() >= ALLOWANCE_LEVEL;
    }
}
