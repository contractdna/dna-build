// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Errors} from "@openzeppelin/contracts/utils/Errors.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ModuleRegistry} from "../src/ModuleRegistry.sol";
import {BountyBoard} from "../src/BountyBoard.sol";
import {IModuleRegistry} from "../src/interfaces/IDNA.sol";

contract Rejecter {} // no receive: every ETH payment reverts

/// @dev re-enters the board from its receive hook
contract Reenterer {
    BountyBoard b;
    uint256 target;

    constructor(BountyBoard b_, uint256 target_) {
        (b, target) = (b_, target_);
    }

    receive() external payable {
        b.expire(target);
    }
}

abstract contract BountyBase is Test {
    ModuleRegistry reg;
    BountyBoard b;
    address safe = makeAddr("safe");
    address agent = makeAddr("agent");
    address anchorKey = makeAddr("anchorKey");
    address rando = makeAddr("rando");
    string[] reqs;

    function _deploy() internal {
        vm.warp(1_700_000_000);
        reg = new ModuleRegistry(safe, agent, anchorKey, 5, makeAddr("initializer"));
        b = new BountyBoard(IModuleRegistry(address(reg)));
        vm.deal(safe, 1_000 ether);
        vm.deal(agent, 1 ether);
        reqs.push("ships tests");
    }

    /// @dev Raise through the registry queue (no rollbacks here, so no 5-day wait) or lower at once.
    function _setLevel(uint8 n) internal {
        vm.startPrank(safe);
        if (n < reg.level()) {
            reg.lowerLevel(n);
        } else {
            uint256 q = reg.queue(ModuleRegistry.Op.SetLevel, abi.encode(n));
            vm.warp(block.timestamp + 1 hours);
            reg.execute(q);
        }
        vm.stopPrank();
    }

    function _status(uint256 id) internal view returns (BountyBoard.Status s) {
        (,, s,,) = b.bounties(id);
    }

    function _safePropose(uint96 reward, uint64 deadline) internal returns (uint256) {
        vm.prank(safe);
        return b.propose{value: reward}(reward, deadline, "title", "request", reqs);
    }

    function _agentPropose(uint96 reward, uint64 deadline) internal returns (uint256) {
        vm.prank(agent);
        return b.propose(reward, deadline, "title", "request", reqs);
    }
}

contract BountyBoardTest is BountyBase {
    uint64 DL; // default deadline

    function setUp() public {
        _deploy();
        DL = uint64(block.timestamp + 14 days);
    }

    function test_constructor() public {
        assertEq(b.safe(), safe);
        assertEq(address(b.registry()), address(reg));
        vm.expectRevert(BountyBoard.BadConfig.selector);
        new BountyBoard(IModuleRegistry(rando));
    }

    // ---------------------------------------------------------------- propose / fund

    function test_propose_safeFunds() public {
        vm.expectEmit(address(b));
        emit BountyBoard.BountyProposed(1, safe, 1 ether, DL, "title", "request", reqs, true);
        uint256 id = _safePropose(1 ether, DL);
        assertEq(id, 1);
        assertEq(address(b).balance, 1 ether);
        (uint96 reward, uint64 deadline, BountyBoard.Status s,, address w) = b.bounties(id);
        assertEq(reward, 1 ether);
        assertEq(deadline, DL);
        assertEq(uint8(s), uint8(BountyBoard.Status.Open));
        assertEq(w, address(0));

        vm.startPrank(safe);
        vm.expectRevert(BountyBoard.BadValue.selector);
        b.propose{value: 1 ether - 1}(1 ether, DL, "t", "r", reqs);
        vm.expectRevert(BountyBoard.BadValue.selector);
        b.propose{value: 0}(1 ether, DL, "t", "r", reqs);
        vm.expectRevert(BountyBoard.BadInput.selector);
        b.propose{value: 0}(0, DL, "t", "r", reqs); // reward > 0
        vm.stopPrank();
    }

    function test_propose_agentUnfunded() public {
        uint256 id = _agentPropose(2 ether, DL);
        assertEq(uint8(_status(id)), uint8(BountyBoard.Status.Proposed));
        assertEq(address(b).balance, 0);
        vm.prank(agent);
        vm.expectRevert(BountyBoard.BadValue.selector);
        b.propose{value: 1}(1, DL, "t", "r", reqs);
        vm.prank(rando);
        vm.expectRevert(BountyBoard.Unauthorized.selector);
        b.propose(1 ether, DL, "t", "r", reqs);
        vm.prank(anchorKey);
        vm.expectRevert(BountyBoard.Unauthorized.selector);
        b.propose(1 ether, DL, "t", "r", reqs);
        vm.prank(safe);
        reg.pauseAgent();
        vm.prank(agent);
        vm.expectRevert(BountyBoard.Unauthorized.selector);
        b.propose(1 ether, DL, "t", "r", reqs);
    }

    function test_propose_inputBounds() public {
        string[] memory many = new string[](17);
        vm.startPrank(agent);
        vm.expectRevert(BountyBoard.BadInput.selector);
        b.propose(1, uint64(block.timestamp), "t", "r", reqs);
        vm.expectRevert(BountyBoard.BadInput.selector);
        b.propose(1, DL, "", "r", reqs);
        vm.expectRevert(BountyBoard.BadInput.selector);
        b.propose(1, DL, string(new bytes(121)), "r", reqs);
        vm.expectRevert(BountyBoard.BadInput.selector);
        b.propose(1, DL, "t", string(new bytes(2001)), reqs);
        vm.expectRevert(BountyBoard.BadInput.selector);
        b.propose(1, DL, "t", "r", many);
        b.propose(1, DL, string(new bytes(120)), string(new bytes(2000)), new string[](16));
        vm.stopPrank();
    }

    function test_fund() public {
        uint256 id = _agentPropose(2 ether, DL);
        vm.deal(rando, 2 ether);
        vm.prank(rando);
        vm.expectRevert(BountyBoard.Unauthorized.selector);
        b.fund{value: 2 ether}(id);
        vm.startPrank(safe);
        vm.expectRevert(BountyBoard.BadValue.selector);
        b.fund{value: 1 ether}(id);
        vm.expectEmit(address(b));
        emit BountyBoard.BountyFunded(id, 2 ether, false);
        b.fund{value: 2 ether}(id);
        assertEq(uint8(_status(id)), uint8(BountyBoard.Status.Open));
        vm.expectRevert(BountyBoard.BadStatus.selector);
        b.fund{value: 2 ether}(id);
        vm.stopPrank();

        uint256 late = _agentPropose(1 ether, DL);
        vm.warp(DL);
        vm.prank(safe);
        vm.expectRevert(BountyBoard.PastDeadline.selector);
        b.fund{value: 1 ether}(late);
    }

    // ---------------------------------------------------------------- submit / recommend

    function test_submit() public {
        uint256 p = _agentPropose(1 ether, DL);
        vm.expectRevert(BountyBoard.BadStatus.selector);
        b.submit(p, "ipfs://x");
        uint256 id = _safePropose(1 ether, DL);
        vm.expectEmit(address(b));
        emit BountyBoard.WorkSubmitted(id, rando, "ipfs://x");
        vm.prank(rando);
        b.submit(id, "ipfs://x");
        vm.expectRevert(BountyBoard.BadInput.selector);
        b.submit(id, "");
        vm.expectRevert(BountyBoard.BadInput.selector);
        b.submit(id, string(new bytes(513)));
        vm.warp(DL);
        vm.expectRevert(BountyBoard.PastDeadline.selector);
        b.submit(id, "ipfs://x");
    }

    function test_recommend() public {
        uint256 id = _safePropose(1 ether, DL);
        vm.prank(rando);
        vm.expectRevert(BountyBoard.Unauthorized.selector);
        b.recommend(id, rando, "ref");
        vm.startPrank(agent);
        vm.expectRevert(BountyBoard.BadInput.selector);
        b.recommend(id, address(0), "ref");
        vm.expectRevert(BountyBoard.BadStatus.selector);
        b.recommend(99, rando, "ref");
        vm.expectEmit(address(b));
        emit BountyBoard.AwardRecommended(id, rando, "ref");
        b.recommend(id, rando, "ref");
        vm.stopPrank();
        assertEq(address(b).balance, 1 ether, "recommend moves nothing");
        vm.prank(safe);
        reg.pauseAgent();
        vm.prank(agent);
        vm.expectRevert(BountyBoard.Unauthorized.selector);
        b.recommend(id, rando, "ref");
    }

    // ---------------------------------------------------------------- award

    function test_award() public {
        uint256 id = _safePropose(1 ether, DL);
        vm.prank(agent);
        vm.expectRevert(BountyBoard.Unauthorized.selector);
        b.award(id, payable(agent), "ref");
        vm.startPrank(safe);
        vm.expectRevert(BountyBoard.BadInput.selector);
        b.award(id, payable(address(0)), "ref");
        vm.warp(DL + 3 days); // award is allowed after the deadline while Open (inside the grace)
        vm.expectEmit(address(b));
        emit BountyBoard.BountyAwarded(id, rando, 1 ether, "ref");
        b.award(id, payable(rando), "ref");
        assertEq(rando.balance, 1 ether);
        assertEq(address(b).balance, 0);
        (,, BountyBoard.Status s,, address w) = b.bounties(id);
        assertEq(uint8(s), uint8(BountyBoard.Status.Awarded));
        assertEq(w, rando);
        vm.expectRevert(BountyBoard.BadStatus.selector);
        b.award(id, payable(rando), "ref");
        vm.stopPrank();

        uint256 p = _agentPropose(1 ether, DL + 20 days);
        vm.prank(safe);
        vm.expectRevert(BountyBoard.BadStatus.selector);
        b.award(p, payable(rando), "ref"); // unfunded
    }

    function test_award_revertingWinner_pickAnother() public {
        uint256 id = _safePropose(1 ether, DL);
        address rej = address(new Rejecter());
        vm.prank(safe);
        vm.expectRevert(Errors.FailedCall.selector);
        b.award(id, payable(rej), "ref");
        assertEq(uint8(_status(id)), uint8(BountyBoard.Status.Open));
        vm.prank(safe);
        b.award(id, payable(rando), "ref");
        assertEq(rando.balance, 1 ether);
    }

    function test_award_reentrancyBlocked() public {
        uint256 other = _safePropose(1 ether, DL);
        uint256 id = _safePropose(1 ether, DL);
        vm.warp(DL + 7 days); // `other` is expirable, so only the guard stops the re-entry
        Reenterer r = new Reenterer(b, other);
        vm.prank(safe);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        b.award(id, payable(address(r)), "ref");
        assertEq(uint8(_status(id)), uint8(BountyBoard.Status.Open));
        assertEq(uint8(_status(other)), uint8(BountyBoard.Status.Open));
        assertEq(address(b).balance, 2 ether);
    }

    // ---------------------------------------------------------------- cancel / expire

    function test_cancel() public {
        uint256 p = _agentPropose(1 ether, DL);
        uint256 o = _safePropose(3 ether, DL);
        vm.prank(rando);
        vm.expectRevert(BountyBoard.Unauthorized.selector);
        b.cancel(o);
        uint256 before = safe.balance;
        vm.startPrank(safe);
        vm.expectEmit(address(b));
        emit BountyBoard.BountyClosed(p, false, 0);
        b.cancel(p);
        vm.expectEmit(address(b));
        emit BountyBoard.BountyClosed(o, false, 3 ether);
        b.cancel(o);
        assertEq(safe.balance, before + 3 ether);
        assertEq(uint8(_status(o)), uint8(BountyBoard.Status.Cancelled));
        vm.expectRevert(BountyBoard.BadStatus.selector);
        b.cancel(o);
        vm.expectRevert(BountyBoard.BadStatus.selector);
        b.fund{value: 1 ether}(p);
        vm.expectRevert(BountyBoard.BadStatus.selector);
        b.award(o, payable(rando), "");
        vm.stopPrank();
    }

    function test_expire() public {
        uint256 p = _agentPropose(1 ether, DL);
        uint256 o = _safePropose(3 ether, DL);
        vm.warp(DL - 1);
        vm.expectRevert(BountyBoard.TooEarly.selector);
        b.expire(p);
        vm.warp(DL);
        vm.expectEmit(address(b));
        emit BountyBoard.BountyClosed(p, true, 0);
        vm.prank(rando);
        b.expire(p);
        assertEq(uint8(_status(p)), uint8(BountyBoard.Status.Expired));

        vm.warp(uint256(DL) + 7 days - 1);
        vm.expectRevert(BountyBoard.TooEarly.selector);
        b.expire(o);
        vm.warp(uint256(DL) + 7 days);
        uint256 before = safe.balance;
        vm.prank(rando);
        b.expire(o);
        assertEq(safe.balance, before + 3 ether);
        assertEq(rando.balance, 0);
        vm.expectRevert(BountyBoard.BadStatus.selector);
        b.expire(o);
        vm.expectRevert(BountyBoard.BadStatus.selector);
        b.expire(42); // never existed
    }

    function test_noReceive_forcedEthIgnored() public {
        vm.prank(safe);
        (bool ok,) = address(b).call{value: 1 ether}("");
        assertFalse(ok);
        uint256 id = _safePropose(1 ether, DL);
        vm.deal(address(b), 5 ether); // forced (selfdestruct-style) ETH
        vm.prank(safe);
        b.cancel(id);
        assertEq(address(b).balance, 4 ether, "only the escrow left");
    }

    // ---------------------------------------------------------------- agent allowance (level 7)

    function _fromAllowance(uint256 id) internal view returns (bool fa) {
        (,,, fa,) = b.bounties(id);
    }

    function test_allowance_fundWithdrawSafeOnly() public {
        vm.prank(agent);
        vm.expectRevert(BountyBoard.Unauthorized.selector);
        b.fundAllowance{value: 1 ether}();
        vm.startPrank(safe);
        vm.expectRevert(BountyBoard.BadValue.selector);
        b.fundAllowance();
        vm.expectEmit(address(b));
        emit BountyBoard.AllowanceFunded(5 ether, 5 ether);
        b.fundAllowance{value: 5 ether}();
        vm.stopPrank();
        assertEq(b.allowance(), 5 ether);
        assertEq(address(b).balance, 5 ether);

        _setLevel(7);
        vm.prank(agent);
        vm.expectRevert(BountyBoard.Unauthorized.selector); // even at level 7 the agent never withdraws
        b.withdrawAllowance(1 ether);
        uint256 before = safe.balance;
        vm.startPrank(safe);
        vm.expectRevert(BountyBoard.BadValue.selector);
        b.withdrawAllowance(5 ether + 1);
        vm.expectRevert(BountyBoard.BadValue.selector);
        b.withdrawAllowance(0);
        vm.expectEmit(address(b));
        emit BountyBoard.AllowanceWithdrawn(2 ether, 3 ether);
        b.withdrawAllowance(2 ether);
        vm.stopPrank();
        assertEq(safe.balance, before + 2 ether);
        assertEq(b.allowance(), 3 ether);
        assertEq(address(b).balance, 3 ether);
    }

    function test_allowance_agentL7FundsAndAwards() public {
        vm.prank(safe);
        b.fundAllowance{value: 3 ether}();
        _setLevel(7);
        uint64 dl = uint64(block.timestamp + 14 days);
        uint256 id = _agentPropose(2 ether, dl);
        vm.prank(agent);
        vm.expectRevert(BountyBoard.BadValue.selector); // the agent never sends ETH
        b.fund{value: 1}(id);
        vm.expectEmit(address(b));
        emit BountyBoard.BountyFunded(id, 2 ether, true);
        vm.prank(agent);
        b.fund(id);
        assertEq(uint8(_status(id)), uint8(BountyBoard.Status.Open));
        assertTrue(_fromAllowance(id));
        assertEq(b.allowance(), 1 ether);
        assertEq(address(b).balance, 3 ether, "allowance to escrow moves no ETH");

        uint256 big = _agentPropose(2 ether, dl);
        vm.prank(agent);
        vm.expectRevert(BountyBoard.BadValue.selector); // reward > allowance
        b.fund(big);

        vm.prank(rando);
        vm.expectRevert(BountyBoard.Unauthorized.selector);
        b.award(id, payable(rando), "ref");
        vm.expectEmit(address(b));
        emit BountyBoard.BountyAwarded(id, rando, 2 ether, "ref");
        vm.prank(agent);
        b.award(id, payable(rando), "ref");
        assertEq(rando.balance, 2 ether);
        assertEq(agent.balance, 1 ether, "agent never receives");
        assertEq(address(b).balance, 1 ether);
        assertEq(b.allowance(), 1 ether);
    }

    function test_allowance_L6AgentCannot() public {
        vm.prank(safe);
        b.fundAllowance{value: 3 ether}();
        _setLevel(6);
        uint256 id = _agentPropose(1 ether, DL);
        vm.prank(agent);
        vm.expectRevert(BountyBoard.Unauthorized.selector);
        b.fund(id);
        // funded at 7, then lowered to 6: the agent can no longer award; the Safe still can
        _setLevel(7);
        vm.prank(agent);
        b.fund(id);
        vm.prank(safe);
        reg.lowerLevel(6);
        vm.prank(agent);
        vm.expectRevert(BountyBoard.Unauthorized.selector);
        b.award(id, payable(rando), "");
        vm.prank(safe);
        b.award(id, payable(rando), "");
        assertEq(rando.balance, 1 ether);
    }

    function test_allowance_pausedAgentCannot() public {
        vm.prank(safe);
        b.fundAllowance{value: 3 ether}();
        _setLevel(7);
        uint256 id = _agentPropose(1 ether, uint64(block.timestamp + 14 days));
        uint256 id2 = _agentPropose(1 ether, uint64(block.timestamp + 14 days));
        vm.prank(agent);
        b.fund(id);
        vm.prank(safe);
        reg.pauseAgent();
        vm.startPrank(agent);
        vm.expectRevert(BountyBoard.Unauthorized.selector);
        b.fund(id2);
        vm.expectRevert(BountyBoard.Unauthorized.selector);
        b.award(id, payable(rando), "");
        vm.stopPrank();
    }

    function test_allowance_agentNeverAwardsSafeEscrow() public {
        vm.prank(safe);
        b.fundAllowance{value: 3 ether}();
        _setLevel(10);
        uint64 dl = uint64(block.timestamp + 14 days);
        uint256 safeOpen = _safePropose(1 ether, dl);
        uint256 safeFunded = _agentPropose(1 ether, dl);
        vm.prank(safe);
        b.fund{value: 1 ether}(safeFunded); // agent proposal, Safe escrow
        assertFalse(_fromAllowance(safeFunded));
        vm.startPrank(agent);
        vm.expectRevert(BountyBoard.Unauthorized.selector);
        b.award(safeOpen, payable(rando), "");
        vm.expectRevert(BountyBoard.Unauthorized.selector);
        b.award(safeFunded, payable(rando), "");
        vm.expectRevert(BountyBoard.Unauthorized.selector);
        b.award(99, payable(rando), ""); // never existed
        vm.stopPrank();
    }

    /// Cancel / expire of an allowance-funded bounty returns its escrow to the allowance, not to the Safe.
    function test_allowance_closeRefundsToAllowance() public {
        vm.prank(safe);
        b.fundAllowance{value: 3 ether}();
        _setLevel(7);
        uint64 dl = uint64(block.timestamp + 14 days);
        uint256 a = _agentPropose(1 ether, dl);
        uint256 c = _agentPropose(2 ether, dl);
        vm.startPrank(agent);
        b.fund(a);
        b.fund(c);
        vm.stopPrank();
        assertEq(b.allowance(), 0);
        uint256 before = safe.balance;
        vm.expectEmit(address(b));
        emit BountyBoard.BountyClosed(a, false, 1 ether);
        vm.prank(safe);
        b.cancel(a);
        assertEq(b.allowance(), 1 ether);
        vm.warp(uint256(dl) + 7 days);
        vm.prank(rando);
        b.expire(c);
        assertEq(b.allowance(), 3 ether);
        assertEq(safe.balance, before, "nothing pushed to the Safe");
        assertEq(address(b).balance, 3 ether);
    }

    function test_allowance_agentAwardReentrancyBlocked() public {
        vm.prank(safe);
        b.fundAllowance{value: 3 ether}();
        _setLevel(7);
        uint256 other = _safePropose(1 ether, DL);
        uint256 id = _agentPropose(1 ether, uint64(block.timestamp + 14 days));
        vm.prank(agent);
        b.fund(id);
        vm.warp(uint256(DL) + 7 days); // `other` is expirable, so only the guard stops the re-entry
        Reenterer r = new Reenterer(b, other);
        vm.prank(agent);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        b.award(id, payable(address(r)), "");
        assertEq(uint8(_status(id)), uint8(BountyBoard.Status.Open));
        assertEq(uint8(_status(other)), uint8(BountyBoard.Status.Open));
        assertEq(address(b).balance, 4 ether);
    }
}

// =================================================================== invariants

contract BountyHandler is Test {
    BountyBoard b;
    ModuleRegistry reg;
    address safe;
    address agent;
    address[] public winners;
    uint256[] public ids;

    uint256 public ghostFunded;
    uint256 public ghostAwarded;
    uint256 public ghostRefunded; // Safe-escrow refunds pushed to the Safe
    uint256 public ghostAllowanceIn;
    uint256 public ghostAllowanceOut;
    uint256 public agentFunds; // coverage: successful agent allowance fundings / awards
    uint256 public agentAwards;
    uint256 public violations;
    string public lastViolation;
    mapping(uint256 => BountyBoard.Status) public terminal; // first terminal status seen

    constructor(BountyBoard b_, ModuleRegistry reg_, address[] memory winners_) {
        (b, reg, winners) = (b_, reg_, winners_);
        (safe, agent) = (reg.safe(), reg.agent());
    }

    function _flag(string memory why) internal {
        violations++;
        lastViolation = why;
    }

    function _id(uint256 seed) internal view returns (uint256) {
        return ids.length == 0 ? seed : ids[seed % ids.length];
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function winnerCount() external view returns (uint256) {
        return winners.length;
    }

    function safePropose(uint96 reward, uint32 dl) external {
        reward = uint96(bound(reward, 1, 10 ether));
        vm.prank(safe);
        try b.propose{value: reward}(
            reward, uint64(_now() + bound(dl, 1, 60 days)), "t", "r", new string[](0)
        ) returns (
            uint256 id
        ) {
            ids.push(id);
            ghostFunded += reward;
        } catch {}
    }

    function agentPropose(uint96 reward, uint32 dl) external {
        reward = uint96(bound(reward, 1, 10 ether));
        uint256 bal = address(b).balance;
        vm.prank(agent);
        try b.propose(reward, uint64(_now() + bound(dl, 1, 60 days)), "t", "r", new string[](0)) returns (uint256 id) {
            ids.push(id);
        } catch {}
        if (address(b).balance != bal) _flag("agent moved ETH");
    }

    function fund(uint256 seed) external {
        uint256 id = _id(seed);
        (uint96 reward,,,,) = b.bounties(id);
        vm.prank(safe);
        try b.fund{value: reward}(id) {
            ghostFunded += reward;
        } catch {}
    }

    function submit(uint256 seed) external {
        try b.submit(_id(seed), "ipfs://w") {} catch {}
    }

    function recommend(uint256 seed, uint256 w) external {
        uint256 bal = address(b).balance;
        vm.prank(agent);
        try b.recommend(_id(seed), winners[w % winners.length], "") {} catch {}
        if (address(b).balance != bal) _flag("agent moved ETH");
    }

    function award(uint256 seed, uint256 w) external {
        uint256 id = _id(seed);
        (uint96 reward,,,,) = b.bounties(id);
        address winner = winners[w % winners.length];
        uint256 before = winner.balance;
        vm.prank(safe);
        try b.award(id, payable(winner), "") {
            ghostAwarded += reward;
            if (winner.balance != before + reward) _flag("award amount");
        } catch {}
    }

    function cancel(uint256 seed) external {
        uint256 id = _id(seed);
        (uint96 reward,, BountyBoard.Status s, bool fa,) = b.bounties(id);
        uint256 al = b.allowance();
        vm.prank(safe);
        try b.cancel(id) {
            _refunded(s, fa, reward, al);
        } catch {}
    }

    function expire(uint256 seed, uint256 caller) external {
        uint256 id = _id(seed);
        (uint96 reward,, BountyBoard.Status s, bool fa,) = b.bounties(id);
        uint256 al = b.allowance();
        vm.prank(winners[caller % winners.length]);
        try b.expire(id) {
            _refunded(s, fa, reward, al);
        } catch {}
    }

    /// @dev Open Safe escrow goes back to the Safe; Open allowance escrow back to the allowance.
    function _refunded(BountyBoard.Status s, bool fa, uint256 reward, uint256 al) internal {
        if (s != BountyBoard.Status.Open) return;
        if (fa) {
            if (b.allowance() != al + reward) _flag("allowance refund");
        } else {
            ghostRefunded += reward;
        }
    }

    function fundAllowance(uint96 amount) external {
        amount = uint96(bound(amount, 1, 20 ether));
        vm.prank(safe);
        b.fundAllowance{value: amount}();
        ghostAllowanceIn += amount;
    }

    function withdrawAllowance(uint256 amount) external {
        uint256 al = b.allowance();
        if (al == 0) return;
        amount = bound(amount, 1, al);
        vm.prank(safe);
        b.withdrawAllowance(amount);
        ghostAllowanceOut += amount;
    }

    function _agentSpends() internal view returns (bool) {
        return !reg.agentPaused() && reg.level() >= 7;
    }

    /// @dev agent funds a proposal from the allowance: only at level >= 7 unpaused; no ETH moves
    function agentFund(uint256 seed) external {
        uint256 id = _id(seed);
        (uint96 reward,,,,) = b.bounties(id);
        (uint256 bal, uint256 al) = (address(b).balance, b.allowance());
        vm.prank(agent);
        try b.fund(id) {
            if (!_agentSpends()) _flag("agent funded below level 7 / paused");
            if (b.allowance() != al - reward) _flag("allowance debit");
            agentFunds++;
        } catch {}
        if (address(b).balance != bal) _flag("agent fund moved ETH");
    }

    /// @dev agent awards: only allowance-funded bounties, level >= 7, unpaused
    function agentAward(uint256 seed, uint256 w) external {
        uint256 id = _id(seed);
        (uint96 reward,,, bool fa,) = b.bounties(id);
        address winner = winners[w % winners.length];
        uint256 before = winner.balance;
        vm.prank(agent);
        try b.award(id, payable(winner), "") {
            if (!fa) _flag("agent awarded Safe escrow");
            if (!_agentSpends()) _flag("agent awarded below level 7 / paused");
            ghostAwarded += reward;
            agentAwards++;
            if (winner.balance != before + reward) _flag("award amount");
        } catch {}
    }

    /// @dev level 6 <-> 7: lower at once, raise through the registry queue
    function toggleLevel() external {
        bool high = reg.level() >= 7;
        vm.prank(safe);
        if (high) {
            reg.lowerLevel(6);
            return;
        }
        uint256 q = reg.queue(ModuleRegistry.Op.SetLevel, abi.encode(uint8(7)));
        vm.warp(_now() + 1 hours);
        reg.execute(q);
    }

    function warp(uint256 secs) external {
        vm.warp(_now() + bound(secs, 1, 20 days));
    }

    /// @dev pause (and check the paused agent can do nothing), or unpause through the registry's 1 h queue
    function togglePause() external {
        if (reg.agentPaused()) {
            vm.prank(safe);
            uint256 q = reg.queue(ModuleRegistry.Op.UnpauseAgent, "");
            vm.warp(_now() + 1 hours);
            reg.execute(q);
            return;
        }
        vm.prank(safe);
        reg.pauseAgent();
        uint256 bal = address(b).balance;
        vm.prank(agent);
        try b.propose(1, uint64(_now() + 1 days), "t", "r", new string[](0)) {
            _flag("paused agent proposed");
        } catch {}
        if (ids.length != 0) {
            vm.prank(agent);
            try b.fund(ids[0]) {
                _flag("paused agent funded");
            } catch {}
            vm.prank(agent);
            try b.award(ids[0], payable(winners[0]), "") {
                _flag("paused agent awarded");
            } catch {}
        }
        if (address(b).balance != bal) _flag("paused agent moved ETH");
    }

    /// @dev records each terminal status the first time it is seen; flags any later change
    function checkTerminal() public {
        for (uint256 k; k < ids.length; ++k) {
            (,, BountyBoard.Status s,,) = b.bounties(ids[k]);
            BountyBoard.Status t = terminal[ids[k]];
            if (t != BountyBoard.Status.None && t != s) _flag("terminal state changed");
            if (uint8(s) >= uint8(BountyBoard.Status.Awarded)) terminal[ids[k]] = s;
        }
    }
}

contract BountyBoardInvariantTest is BountyBase {
    BountyHandler h;
    uint256 safeStart;

    function setUp() public {
        _deploy();
        address[] memory w = new address[](4);
        for (uint256 k; k < 3; ++k) {
            w[k] = address(uint160(0x40000 + k));
        }
        w[3] = address(new Rejecter());
        h = new BountyHandler(b, reg, w);
        vm.deal(safe, 1_000_000 ether);
        safeStart = safe.balance;
        targetContract(address(h));
    }

    function invariant_noHandlerViolations() public {
        h.checkTerminal();
        assertEq(h.violations(), 0, h.lastViolation());
    }

    /// @dev escrow == Σ Open rewards + allowance (Proposed holds nothing; no forced ETH in this run)
    function invariant_escrowMatchesOpen() public view {
        uint256 open;
        for (uint256 k; k < h.idCount(); ++k) {
            (uint96 reward,, BountyBoard.Status s,,) = b.bounties(h.ids(k));
            if (s == BountyBoard.Status.Open) open += reward;
        }
        assertEq(address(b).balance, open + b.allowance());
    }

    /// @dev ETH leaves only to the Safe (refunds, allowance withdrawals) or winners (awards), exactly as accounted
    function invariant_ethFlows() public view {
        uint256 inflow = h.ghostFunded() + h.ghostAllowanceIn();
        assertEq(address(b).balance, inflow - h.ghostAllowanceOut() - h.ghostAwarded() - h.ghostRefunded());
        assertEq(safe.balance, safeStart - inflow + h.ghostAllowanceOut() + h.ghostRefunded());
        uint256 paid;
        for (uint256 k; k < h.winnerCount(); ++k) {
            paid += h.winners(k).balance;
        }
        assertEq(paid, h.ghostAwarded());
        assertEq(agent.balance, 1 ether, "agent never pays or receives");
    }

    /// Deterministic coverage: the handler's allowance paths (fund, agent fund, agent award, refund to the allowance,
    /// withdraw) all run and keep every invariant, so the fuzzed suite can't silently skip them.
    function test_handlerReachesAllowancePaths() public {
        h.fundAllowance(5 ether);
        h.toggleLevel(); // 5 → 7 through the registry queue
        assertEq(reg.level(), 7);
        h.agentPropose(1 ether, 10 days);
        h.agentFund(0);
        h.agentAward(0, 0);
        h.agentPropose(1 ether, 10 days);
        h.agentFund(1);
        h.cancel(1); // allowance-funded Open → back to the allowance
        h.withdrawAllowance(1 ether);
        assertEq(h.agentFunds(), 2);
        assertEq(h.agentAwards(), 1);
        assertEq(h.ghostAllowanceIn(), 5 ether);
        assertGt(h.ghostAllowanceOut(), 0);
        assertEq(b.allowance(), 5 ether - 1 ether - h.ghostAllowanceOut());
        invariant_noHandlerViolations();
        invariant_escrowMatchesOpen();
        invariant_ethFlows();
    }

    function afterInvariant() external view {
        console.log("agent allowance funds", h.agentFunds(), "agent awards", h.agentAwards());
    }
}
