// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DNAToken} from "../src/DNAToken.sol";
import {ModuleRegistry} from "../src/ModuleRegistry.sol";
import {IdeaMarket} from "../src/IdeaMarket.sol";
import {IModuleRegistry} from "../src/interfaces/IDNA.sol";

abstract contract IdeaBase is Test {
    DNAToken token;
    ModuleRegistry reg;
    IdeaMarket m;
    address safe = makeAddr("safe");
    address agent = makeAddr("agent");
    address anchorKey = makeAddr("anchorKey");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");

    function _deploy() internal {
        vm.warp(1_700_000_000);
        token = new DNAToken(address(this));
        reg = new ModuleRegistry(safe, agent, anchorKey, 5, makeAddr("initializer"));
        m = new IdeaMarket(token, IModuleRegistry(address(reg)));
        address[7] memory who = [safe, agent, anchorKey, alice, bob, carol, dave];
        for (uint256 k; k < who.length; ++k) {
            _fund(who[k], 50_000_000 ether);
        }
    }

    function _fund(address who, uint256 amt) internal {
        token.transfer(who, amt);
        vm.prank(who);
        token.approve(address(m), type(uint256).max);
    }

    /// @dev the public getter's 10 static return values encode exactly like the static struct
    function _round(uint256 r) internal view returns (IdeaMarket.Round memory) {
        (, bytes memory ret) = address(m).staticcall(abi.encodeCall(m.rounds, (r)));
        return abi.decode(ret, (IdeaMarket.Round));
    }
}

contract IdeaMarketTest is IdeaBase {
    uint256 constant E = 1 ether;

    function setUp() public {
        _deploy();
    }

    // ---------------------------------------------------------------- helpers

    function _sub(address who, uint256 amt) internal returns (uint256) {
        vm.prank(who);
        return m.submit("title", "body", amt);
    }

    function _stake(address who, uint256 id, uint256 amt) internal {
        vm.prank(who);
        m.stake(id, amt);
    }

    function _propose(address by, uint256 r, uint128 acc, uint128 voi) internal {
        vm.prank(by);
        m.proposeOutcome(r, acc, voi, keccak256("report"), "ipfs://report");
    }

    /// @dev warp to round end, Safe proposes, warp 24 h, finalize.
    function _resolve(uint256 r, uint128 acc, uint128 voi) internal {
        vm.warp(m.roundEnd(r));
        _propose(safe, r, acc, voi);
        vm.warp(m.roundEnd(r) + 24 hours);
        m.finalize(r);
    }

    function _claim(address who, uint256 id) internal returns (uint256 paid) {
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        uint256 before = token.balanceOf(who);
        vm.prank(who);
        m.claim(ids);
        paid = token.balanceOf(who) - before;
    }

    function _setAgent(address a) internal {
        vm.prank(safe);
        uint256 id = reg.queue(ModuleRegistry.Op.SetAgent, abi.encode(a));
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        reg.execute(id);
    }

    // ---------------------------------------------------------------- constructor

    function test_constructor() public view {
        assertEq(m.safe(), safe);
        assertEq(m.START(), 1_700_000_000);
        assertEq(address(m.token()), address(token));
        assertEq(m.currentRound(), 0);
        assertEq(m.roundEnd(0), 1_700_000_000 + 24 hours);
        assertEq(m.MAX_PUBLIC_IDEAS(), 112);
    }

    function test_constructor_rejectsBadConfig() public {
        vm.expectRevert(IdeaMarket.BadConfig.selector);
        new IdeaMarket(token, IModuleRegistry(makeAddr("noCode")));
        DNAToken small = new DNAToken(address(this)); // fine
        new IdeaMarket(small, IModuleRegistry(address(reg)));
        // a token whose supply is below the worst-case round TVL is rejected
        vm.mockCall(address(small), abi.encodeWithSignature("totalSupply()"), abi.encode(uint256(255_999_999 ether)));
        vm.expectRevert(IdeaMarket.BadConfig.selector);
        new IdeaMarket(small, IModuleRegistry(address(reg)));
    }

    // ---------------------------------------------------------------- submit

    function test_submit_public_stakesAndBurnsFee() public {
        uint256 supply = token.totalSupply();
        uint256 bal = token.balanceOf(alice);
        vm.expectEmit(address(m));
        emit IdeaMarket.IdeaSubmitted(1, 0, alice, 0, 10_000 * E, "title", "body");
        vm.expectEmit(address(m));
        emit IdeaMarket.Staked(1, alice, 10_000 * E, 10_000 * E);
        uint256 id = _sub(alice, 10_000 * E);
        assertEq(id, 1);
        assertEq(token.totalSupply(), supply - 1_000 * E, "fee burned");
        assertEq(token.balanceOf(alice), bal - 11_000 * E);
        assertEq(token.balanceOf(address(m)), 10_000 * E, "only the stake is escrowed");
        assertEq(m.stakeOf(1, alice), 10_000 * E);
        assertEq(m.roundStakeOf(0, alice), 10_000 * E);
        (uint32 r, uint8 idx, uint128 staked) = m.ideas(1);
        assertEq(r, 0);
        assertEq(idx, 0);
        assertEq(staked, 10_000 * E);
        IdeaMarket.Round memory rd = _round(0);
        assertEq(rd.count, 1);
        assertEq(rd.firstId, 1);
        assertEq(_sub(bob, 20_000 * E), 2);
        (, idx,) = m.ideas(2);
        assertEq(idx, 1);
        assertEq(_round(0).firstId, 1);
    }

    function test_submit_text() public {
        vm.startPrank(alice);
        vm.expectRevert(IdeaMarket.BadText.selector);
        m.submit("", "b", 10_000 * E);
        vm.expectRevert(IdeaMarket.BadText.selector);
        m.submit(string(new bytes(121)), "b", 10_000 * E);
        vm.expectRevert(IdeaMarket.BadText.selector);
        m.submit("t", string(new bytes(1001)), 10_000 * E);
        // 40 x "€" (3 bytes each) = 120 bytes: caps count UTF-8 bytes, not characters
        string memory euro =
            unicode"€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€";
        assertEq(bytes(euro).length, 120);
        m.submit(euro, string(new bytes(1000)), 10_000 * E);
        vm.expectRevert(IdeaMarket.BadText.selector);
        m.submit(string.concat(euro, "a"), "", 10_000 * E);
        vm.stopPrank();
    }

    function test_submit_rules() public {
        vm.expectRevert(IdeaMarket.TooSmall.selector);
        _sub(alice, 10_000 * E - 1);
        vm.expectRevert(IdeaMarket.Operator.selector);
        _sub(safe, 10_000 * E);
        vm.expectRevert(IdeaMarket.Operator.selector);
        _sub(anchorKey, 10_000 * E);
        vm.expectRevert(IdeaMarket.Operator.selector);
        _sub(agent, 10_000 * E); // agent never stakes
        vm.expectRevert(IdeaMarket.TooSmall.selector);
        _sub(alice, 0); // zero stake is agent-only
        vm.expectRevert(IdeaMarket.CapExceeded.selector);
        _sub(alice, 1_000_000 * E + 1); // per-address cap applies to the opening stake
    }

    function test_submit_agentZeroStake_noFee() public {
        uint256 supply = token.totalSupply();
        uint256 id = _sub(agent, 0);
        assertEq(token.totalSupply(), supply);
        assertEq(token.balanceOf(address(m)), 0);
        (,, uint128 staked) = m.ideas(id);
        assertEq(staked, 0);
        assertEq(_round(0).agentCount, 1);
        vm.prank(safe);
        reg.pauseAgent();
        vm.expectRevert(IdeaMarket.Unauthorized.selector);
        _sub(agent, 0);
    }

    function test_submit_slots_112public_16agent() public {
        address[] memory users = new address[](112);
        for (uint256 k; k < 112; ++k) {
            users[k] = address(uint160(0x10000 + k));
            _fund(users[k], 11_000 * E);
            _sub(users[k], 10_000 * E);
        }
        vm.expectRevert(IdeaMarket.RoundFull.selector);
        _sub(alice, 10_000 * E);
        for (uint256 k; k < 16; ++k) {
            _sub(agent, 0);
        }
        vm.expectRevert(IdeaMarket.RoundFull.selector);
        _sub(agent, 0);
        IdeaMarket.Round memory rd = _round(0);
        assertEq(rd.count, 128);
        assertEq(rd.agentCount, 16);
        (, uint8 idx,) = m.ideas(128);
        assertEq(idx, 127);
        // next round has fresh slots
        vm.warp(m.roundEnd(0));
        assertEq(_sub(alice, 10_000 * E), 129);
        assertEq(_round(1).firstId, 129);
    }

    function test_submit_agentSlotsDoNotEatPublic() public {
        for (uint256 k; k < 16; ++k) {
            _sub(agent, 0);
        }
        _sub(alice, 10_000 * E);
        assertEq(_round(0).count, 17);
    }

    function test_submit_lastSecondLandsInBlockRound() public {
        vm.warp(m.roundEnd(0) - 1);
        uint256 a = _sub(alice, 10_000 * E);
        vm.warp(m.roundEnd(0));
        uint256 b = _sub(bob, 10_000 * E);
        (uint32 ra,,) = m.ideas(a);
        (uint32 rb,,) = m.ideas(b);
        assertEq(ra, 0);
        assertEq(rb, 1);
    }

    // ---------------------------------------------------------------- stake

    function test_stake_rulesAndCaps() public {
        uint256 id = _sub(alice, 10_000 * E);
        vm.expectRevert(IdeaMarket.UnknownIdea.selector);
        _stake(bob, 0, 1_000 * E);
        vm.expectRevert(IdeaMarket.UnknownIdea.selector);
        _stake(bob, 2, 1_000 * E);
        vm.expectRevert(IdeaMarket.TooSmall.selector);
        _stake(bob, id, 1_000 * E - 1);
        address[3] memory ops = [safe, agent, anchorKey];
        for (uint256 k; k < 3; ++k) {
            vm.expectRevert(IdeaMarket.Operator.selector);
            _stake(ops[k], id, 1_000 * E);
        }
        vm.expectEmit(address(m));
        emit IdeaMarket.Staked(id, bob, 1_000 * E, 11_000 * E);
        _stake(bob, id, 1_000 * E);
        assertEq(m.stakeOf(id, bob), 1_000 * E);

        // per-address cap spans ideas in the round
        uint256 id2 = _sub(bob, 10_000 * E);
        _stake(bob, id2, 1_000_000 * E - 11_000 * E);
        vm.expectRevert(IdeaMarket.CapExceeded.selector);
        _stake(bob, id, 1_000 * E);

        // per-idea cap
        _stake(carol, id, 1_000_000 * E);
        vm.expectRevert(IdeaMarket.CapExceeded.selector);
        _stake(dave, id, 1_000_000 * E);
        _stake(dave, id, 2_000_000 * E - 1_011_000 * E);
        (,, uint128 staked) = m.ideas(id);
        assertEq(staked, 2_000_000 * E);
    }

    function test_stake_onlyWhileRoundCurrent() public {
        uint256 id = _sub(alice, 10_000 * E);
        _stake(bob, id, 1_000_000 * E);
        vm.warp(m.roundEnd(0));
        vm.expectRevert(IdeaMarket.NotCurrentRound.selector);
        _stake(carol, id, 1_000 * E);
        // per-address budget is per round
        uint256 id2 = _sub(alice, 10_000 * E);
        _stake(bob, id2, 1_000_000 * E);
        assertEq(m.roundStakeOf(1, bob), 1_000_000 * E);
    }

    function test_operatorRotation_newAgentCannotStake() public {
        uint256 id = _sub(alice, 10_000 * E);
        _setAgent(dave);
        vm.expectRevert(IdeaMarket.Operator.selector);
        _stake(dave, id, 1_000 * E);
        _stake(agent, id, 1_000 * E); // the old agent is a regular user again
    }

    // ---------------------------------------------------------------- propose / cancel

    function test_propose_authWindowAndBitmaps() public {
        _sub(alice, 10_000 * E);
        _sub(bob, 10_000 * E);
        uint256 end = m.roundEnd(0);

        vm.warp(end - 1);
        vm.expectRevert(IdeaMarket.OutsideWindow.selector);
        _propose(safe, 0, 1, 0);

        vm.warp(end);
        vm.expectRevert(IdeaMarket.Unauthorized.selector);
        _propose(alice, 0, 1, 0);
        vm.expectRevert(IdeaMarket.Unauthorized.selector);
        _propose(anchorKey, 0, 1, 0);
        vm.expectRevert(IdeaMarket.OutsideWindow.selector);
        _propose(safe, 1, 0, 0); // round 1 not yet ended
        vm.expectRevert(IdeaMarket.BadBitmap.selector);
        _propose(safe, 0, 1, 1); // overlap
        vm.expectRevert(IdeaMarket.BadBitmap.selector);
        _propose(safe, 0, 4, 0); // bit 2 ≥ count
        vm.expectRevert(IdeaMarket.BadBitmap.selector);
        _propose(safe, 0, 0, 4);

        vm.expectEmit(address(m));
        emit IdeaMarket.OutcomeProposed(0, agent, 1, 2, keccak256("report"), "ipfs://report", end + 24 hours);
        _propose(agent, 0, 1, 2);
        vm.expectRevert(IdeaMarket.BadStatus.selector);
        _propose(safe, 0, 1, 0);

        // cancel: Safe only, then re-propose; window closes at end + 3 d
        vm.prank(agent);
        vm.expectRevert(IdeaMarket.Unauthorized.selector);
        m.cancelOutcome(0);
        vm.prank(safe);
        m.cancelOutcome(0);
        vm.prank(safe);
        vm.expectRevert(IdeaMarket.BadStatus.selector);
        m.cancelOutcome(0);
        vm.warp(end + 3 days);
        vm.expectRevert(IdeaMarket.OutsideWindow.selector);
        _propose(safe, 0, 1, 0);
        vm.warp(end + 3 days - 1);
        _propose(safe, 0, 1, 0);
    }

    function test_propose_emptyRound() public {
        vm.warp(m.roundEnd(0));
        vm.expectRevert(IdeaMarket.EmptyRound.selector);
        _propose(safe, 0, 0, 0);
    }

    function test_propose_pausedAgent() public {
        _sub(alice, 10_000 * E);
        vm.prank(safe);
        reg.pauseAgent();
        vm.warp(m.roundEnd(0));
        vm.expectRevert(IdeaMarket.Unauthorized.selector);
        _propose(agent, 0, 1, 0);
    }

    function test_propose_fullRound_bit127() public {
        for (uint256 k; k < 112; ++k) {
            address u = address(uint160(0x10000 + k));
            _fund(u, 11_000 * E);
            _sub(u, 10_000 * E);
        }
        for (uint256 k; k < 16; ++k) {
            _sub(agent, 0);
        }
        vm.warp(m.roundEnd(0));
        _propose(safe, 0, uint128(1) << 127, type(uint128).max >> 1); // count == 128 accepted in uint256 bound
        vm.warp(m.roundEnd(0) + 24 hours);
        m.finalize(0); // 128-idea loop (gas: see --gas-report)
        IdeaMarket.Round memory rd = _round(0);
        assertEq(rd.acceptedStake, 0); // agent idea at index 127 has no stake
        assertEq(rd.rejectedStake, 0);
    }

    // ---------------------------------------------------------------- finalize

    function test_finalize_appliesAfterDelay() public {
        uint256 a = _sub(alice, 100_000 * E); // accepted
        uint256 b = _sub(bob, 50_000 * E); // rejected
        uint256 c = _sub(carol, 30_000 * E); // void
        _stake(dave, a, 100_000 * E);
        _stake(dave, b, 10_000 * E);
        vm.expectRevert(IdeaMarket.TooEarly.selector);
        m.finalize(0);
        vm.warp(m.roundEnd(0));
        _propose(agent, 0, 1, 4);
        vm.warp(m.roundEnd(0) + 24 hours - 1);
        vm.expectRevert(IdeaMarket.TooEarly.selector);
        m.finalize(0);
        vm.warp(m.roundEnd(0) + 24 hours);
        vm.expectEmit(address(m));
        emit IdeaMarket.RoundFinalized(0, 1, 4, 200_000 * E, 60_000 * E, false);
        m.finalize(0);
        vm.expectRevert(IdeaMarket.BadStatus.selector);
        m.finalize(0);

        // A = 200k, R = 60k: accepted s → s + s·60/200
        assertEq(m.claimable(a, alice), 130_000 * E);
        assertEq(_claim(alice, a), 130_000 * E);
        assertEq(_claim(dave, a), 130_000 * E);
        assertEq(_claim(dave, b), 0);
        assertEq(_claim(bob, b), 0);
        assertEq(_claim(carol, c), 30_000 * E);
        assertEq(token.balanceOf(address(m)), 0);
        // paid once
        assertEq(_claim(alice, a), 0);
    }

    function test_finalize_noAcceptedStake_refundsAll() public {
        uint256 a = _sub(alice, 10_000 * E);
        uint256 b = _sub(bob, 20_000 * E);
        uint256 c = _sub(agent, 0); // accepted, but nobody staked it
        _resolve(0, uint128(1) << 2, 0);
        IdeaMarket.Round memory rd = _round(0);
        assertEq(rd.acceptedStake, 0);
        assertEq(rd.rejectedStake, 30_000 * E);
        assertEq(_claim(alice, a), 10_000 * E);
        assertEq(_claim(bob, b), 20_000 * E);
        assertEq(_claim(alice, c), 0);
        assertEq(token.balanceOf(address(m)), 0);
    }

    function test_finalize_expiry_allVoid() public {
        uint256 a = _sub(alice, 10_000 * E);
        uint256 deadline = m.roundEnd(0) + 3 days + 24 hours;
        vm.warp(deadline - 1);
        vm.expectRevert(IdeaMarket.TooEarly.selector);
        m.finalize(0);
        vm.warp(deadline);
        vm.expectEmit(address(m));
        emit IdeaMarket.RoundFinalized(0, 0, 1, 0, 0, true);
        m.finalize(0);
        assertEq(_claim(alice, a), 10_000 * E);
    }

    function test_finalize_staleProposer_expiresToVoid() public {
        uint256 a = _sub(alice, 10_000 * E);
        _sub(bob, 10_000 * E);
        vm.warp(m.roundEnd(0));
        _propose(agent, 0, 1, 0);
        vm.prank(safe);
        reg.pauseAgent();
        vm.warp(m.roundEnd(0) + 24 hours);
        vm.expectRevert(IdeaMarket.TooEarly.selector);
        m.finalize(0); // proposer no longer valid
        vm.warp(m.roundEnd(0) + 3 days + 24 hours);
        m.finalize(0); // status Proposed but stale → all void
        IdeaMarket.Round memory rd = _round(0);
        assertEq(rd.accepted, 0);
        assertEq(rd.voided, 3);
        assertEq(_claim(alice, a), 10_000 * E);
    }

    function test_finalize_rotatedAgentProposalIsStale() public {
        _sub(alice, 10_000 * E);
        vm.warp(m.roundEnd(0));
        _propose(agent, 0, 1, 0);
        _setAgent(dave); // +1 h (registry queue)
        vm.warp(m.roundEnd(0) + 24 hours); // past the outcome delay: the stale proposal still cannot finalize
        vm.expectRevert(IdeaMarket.TooEarly.selector);
        m.finalize(0);
        // Safe cancels and re-proposes inside the window
        vm.prank(safe);
        m.cancelOutcome(0);
        _propose(safe, 0, 1, 0);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        m.finalize(0);
        assertEq(uint8(_round(0).status), uint8(IdeaMarket.Status.Final));
    }

    function test_finalize_emptyRoundNever() public {
        vm.warp(m.roundEnd(0) + 365 days);
        vm.expectRevert(IdeaMarket.EmptyRound.selector);
        m.finalize(0);
    }

    // ---------------------------------------------------------------- claim

    function test_claim_beforeFinalReverts_zeroSkips() public {
        uint256 a = _sub(alice, 10_000 * E);
        uint256[] memory ids = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (a, 999, a);
        vm.prank(bob); // no positions: all skipped
        assertEq(m.claim(ids), 0);
        vm.prank(alice);
        vm.expectRevert(IdeaMarket.BadStatus.selector);
        m.claim(ids);
        assertEq(m.claimable(a, alice), 0);
        _resolve(0, 1, 0);
        vm.prank(alice); // duplicate id pays once
        assertEq(m.claim(ids), 10_000 * E);
    }

    function test_claim_multiRoundBatch() public {
        uint256 a = _sub(alice, 10_000 * E);
        uint256 b = _sub(bob, 10_000 * E);
        vm.warp(m.roundEnd(0));
        uint256 c = _sub(alice, 20_000 * E);
        _propose(safe, 0, 1, 0); // a accepted, b rejected
        vm.warp(m.roundEnd(1));
        _propose(safe, 1, 0, 1); // c void
        vm.warp(m.roundEnd(1) + 24 hours);
        m.finalize(0);
        m.finalize(1);
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (a, c);
        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        m.claim(ids);
        assertEq(token.balanceOf(alice) - before, 20_000 * E + 20_000 * E);
        assertEq(_claim(bob, b), 0);
    }

    // ---------------------------------------------------------------- fuzz: payout math

    address[] stakers;
    uint256 fTotal; // Σ payouts
    uint256 fVoid; // Σ void stakes
    uint256 fAccPositions;

    /// @dev Random stakes on up to 8 ideas, random disjoint outcome. Σ payouts ∈ [A+R+V−n, A+R+V] (n = accepted
    ///      positions), void and A == 0 positions pay exactly their stake, rejected pay 0.
    function testFuzz_payoutMath(uint256 seed, uint8 nIdeas, uint128 accSeed, uint128 voiSeed) public {
        uint256 n = bound(nIdeas, 1, 8);
        _fuzzStakes(seed, n);
        uint128 mask = uint128((uint256(1) << n) - 1);
        uint128 acc = accSeed & mask;
        uint128 voi = voiSeed & mask & ~acc;
        _resolve(0, acc, voi);
        IdeaMarket.Round memory rd = _round(0);
        uint256 A = rd.acceptedStake;
        uint256 R = rd.rejectedStake;
        for (uint256 id = 1; id <= n; ++id) {
            _claimAll(id, (acc >> (id - 1)) & 1 == 1, (voi >> (id - 1)) & 1 == 1, A == 0);
        }
        uint256 V = fVoid;
        if (A == 0) {
            assertEq(fTotal, R + V, "A == 0: full refunds");
        } else {
            assertLe(fTotal, A + R + V);
            assertGe(fTotal + fAccPositions, A + R + V);
        }
        assertEq(token.balanceOf(address(m)), A + R + V - fTotal, "only dust left");
    }

    function _fuzzStakes(uint256 seed, uint256 n) internal {
        for (uint256 k; k < 10; ++k) {
            stakers.push(address(uint160(0x20000 + k)));
            _fund(stakers[k], 2_000_000 * E);
        }
        for (uint256 i; i < n; ++i) {
            seed = uint256(keccak256(abi.encode(seed)));
            _sub(stakers[i], bound(seed, 10_000 * E, 200_000 * E));
        }
        for (uint256 k; k < 30; ++k) {
            seed = uint256(keccak256(abi.encode(seed)));
            address who = stakers[seed % 10];
            uint256 id = 1 + (seed >> 8) % n;
            (,, uint128 staked) = m.ideas(id);
            uint256 room = 1_000_000 * E - m.roundStakeOf(0, who);
            if (2_000_000 * E - staked < room) room = 2_000_000 * E - staked;
            if (room < 1_000 * E) continue;
            _stake(who, id, bound(seed >> 16, 1_000 * E, room));
        }
    }

    function _claimAll(uint256 id, bool isAcc, bool isVoid, bool noAccepted) internal {
        for (uint256 k; k < 10; ++k) {
            uint256 s = m.stakeOf(id, stakers[k]);
            if (s == 0) continue;
            uint256 p = _claim(stakers[k], id);
            fTotal += p;
            if (isVoid) fVoid += s;
            if (isAcc) {
                fAccPositions++;
                assertGe(p, s);
            } else if (isVoid || noAccepted) {
                assertEq(p, s, "void/refund = stake");
            } else {
                assertEq(p, 0, "rejected = 0");
            }
        }
    }
}

// =================================================================== invariants

contract IdeaHandler is Test {
    IdeaMarket m;
    DNAToken token;
    ModuleRegistry reg;
    address safe;
    address agent;
    address anchorKey;
    address[] public actors;

    // ghosts
    uint256[] public ideaIds;
    uint256 public ghostIn; // DNA staked into the market
    uint256 public ghostOut; // DNA paid by claims
    uint256 public ghostBurned; // submit fees
    uint256 public violations;
    uint256 public nP; // successful proposals (coverage)
    uint256 public nF; // successful finalizes
    uint256 public nC; // claims that paid
    string public lastViolation;
    mapping(uint256 => mapping(address => bool)) public claimed;

    constructor(IdeaMarket m_, DNAToken token_, ModuleRegistry reg_, address[] memory actors_) {
        (m, token, reg, actors) = (m_, token_, reg_, actors_);
        (safe, agent, anchorKey) = (reg.safe(), reg.agent(), reg.anchorKey());
    }

    function _flag(string memory why) internal {
        violations++;
        lastViolation = why;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    /// @dev mostly a round that has ideas (the round of a random idea), sometimes any round up to current
    function _roundOf(uint256 seed) internal view returns (uint256 r) {
        if (ideaIds.length == 0 || seed % 4 == 0) return seed % (m.currentRound() + 1);
        (r,,) = m.ideas(ideaIds[seed % ideaIds.length]);
    }

    function ideaCount() external view returns (uint256) {
        return ideaIds.length;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function submit(uint256 actorSeed, uint256 amt) external {
        address who = _actor(actorSeed);
        amt = bound(amt, 10_000 ether, 300_000 ether);
        uint256 supply = token.totalSupply();
        vm.prank(who);
        try m.submit("t", "b", amt) returns (uint256 id) {
            ideaIds.push(id);
            ghostIn += amt;
            ghostBurned += 1_000 ether;
            if (token.totalSupply() != supply - 1_000 ether) _flag("fee burn");
        } catch {}
    }

    function agentSubmit() external {
        vm.prank(agent);
        try m.submit("t", "b", 0) returns (uint256 id) {
            ideaIds.push(id);
        } catch {}
    }

    function stake(uint256 actorSeed, uint256 ideaSeed, uint256 amt) external {
        if (ideaIds.length == 0) return;
        address who = _actor(actorSeed);
        uint256 id = ideaIds[ideaSeed % ideaIds.length];
        amt = bound(amt, 1_000 ether, 600_000 ether);
        vm.prank(who);
        try m.stake(id, amt) {
            ghostIn += amt;
        } catch {}
    }

    function operatorStake(uint256 opSeed, uint256 ideaSeed) external {
        if (ideaIds.length == 0) return;
        address op = [safe, agent, anchorKey][opSeed % 3];
        uint256 id = ideaIds[ideaSeed % ideaIds.length];
        vm.prank(op);
        try m.stake(id, 1_000 ether) {
            _flag("operator staked");
        } catch {}
        vm.prank(op);
        try m.submit("t", "b", 10_000 ether) {
            _flag("operator staked via submit");
        } catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(_now() + bound(secs, 1 hours, 2 days));
    }

    function propose(uint256 roundSeed, uint128 acc, uint128 voi, bool bySafe) external {
        uint256 r = _roundOf(roundSeed);
        (, uint8 count,,,,,,,,) = m.rounds(r);
        uint128 mask = uint128((uint256(1) << count) - 1); // in-range bitmaps (out-of-range is unit-tested)
        (acc, voi) = (acc & mask, voi & mask & ~acc);
        vm.prank(bySafe ? safe : agent);
        try m.proposeOutcome(r, acc, voi, bytes32(0), "") {
            nP++;
        } catch {}
    }

    function cancel(uint256 roundSeed) external {
        uint256 r = _roundOf(roundSeed);
        vm.prank(safe);
        try m.cancelOutcome(r) {} catch {}
    }

    /// @dev pause, or unpause through the registry's 1 h queue
    function togglePause() external {
        vm.startPrank(safe);
        if (!reg.agentPaused()) {
            reg.pauseAgent();
        } else {
            uint256 id = reg.queue(ModuleRegistry.Op.UnpauseAgent, "");
            vm.warp(_now() + 1 hours);
            reg.execute(id);
        }
        vm.stopPrank();
    }

    function finalize(uint256 roundSeed) external {
        uint256 r = _roundOf(roundSeed);
        try m.finalize(r) {
            nF++;
        } catch {}
    }

    /// @dev claims up to 8 ids from a random offset (mostly Final rounds, plus one duplicate and one random id)
    function claim(uint256 actorSeed, uint256 offset, bool onlyFinal) external {
        uint256 n = ideaIds.length;
        if (n == 0) return;
        offset %= n; // fuzzed offsets near 2^256 would overflow offset + k
        address who = _actor(actorSeed);
        uint256[] memory ids = new uint256[](10);
        uint256 c;
        for (uint256 k; k < n && c < 8; ++k) {
            uint256 id = ideaIds[(offset + k) % n];
            (uint32 r,,) = m.ideas(id);
            (IdeaMarket.Status st,,,,,,,,,) = m.rounds(r);
            if (st == IdeaMarket.Status.Final) ids[c++] = id;
        }
        if (c != 0) ids[c++] = ids[0]; // duplicate pays once
        if (!onlyFinal) ids[c++] = ideaIds[offset % n]; // may be non-Final → whole claim reverts
        assembly {
            mstore(ids, c)
        }
        uint256 expected;
        for (uint256 k; k < c; ++k) {
            bool dup;
            for (uint256 j; j < k; ++j) {
                if (ids[j] == ids[k]) dup = true;
            }
            if (!dup) expected += m.claimable(ids[k], who);
        }
        uint256 mineBefore = token.balanceOf(who);
        uint256 escrowBefore = token.balanceOf(address(m));
        vm.prank(who);
        try m.claim(ids) returns (uint256 total) {
            if (token.balanceOf(who) - mineBefore != total || escrowBefore - token.balanceOf(address(m)) != total) {
                _flag("claim not to sender");
            }
            if (total != expected) _flag("claim != claimable");
            _markClaimed(ids, who);
            ghostOut += total;
            if (total != 0) nC++;
        } catch {}
    }

    function _markClaimed(uint256[] memory ids, address who) internal {
        for (uint256 k; k < ids.length; ++k) {
            if (m.stakeOf(ids[k], who) != 0) _flag("position not zeroed");
            claimed[ids[k]][who] = true;
        }
    }
}

contract IdeaMarketInvariantTest is IdeaBase {
    IdeaHandler h;

    function setUp() public {
        _deploy();
        address[] memory actors = new address[](5);
        for (uint256 k; k < 5; ++k) {
            actors[k] = address(uint160(0x30000 + k));
            _fund(actors[k], 50_000_000 ether);
        }
        h = new IdeaHandler(m, token, reg, actors);
        targetContract(address(h));
    }

    function invariant_noHandlerViolations() public view {
        assertEq(h.violations(), 0, h.lastViolation());
    }

    /// @dev balance == staked in − claimed out (DNA leaves only via claim); supply falls only by submit fees.
    function invariant_flows() public view {
        assertEq(token.balanceOf(address(m)), h.ghostIn() - h.ghostOut());
        assertEq(token.totalSupply(), token.SUPPLY() - h.ghostBurned());
    }

    /// @dev balance ≥ Σ obligations (payout if Final, else stake); caps hold; operators hold no stake.
    function invariant_solventAndCapped() public view {
        uint256 owed;
        for (uint256 k; k < h.ideaCount(); ++k) {
            owed += _checkIdea(h.ideaIds(k));
        }
        assertGe(token.balanceOf(address(m)), owed);
    }

    function _checkIdea(uint256 id) internal view returns (uint256 owed) {
        (uint32 r, uint8 idx, uint128 staked) = m.ideas(id);
        assertLe(staked, m.MAX_PER_IDEA());
        IdeaMarket.Round memory rd = _round(r);
        assertLt(idx, rd.count);
        assertLe(rd.count, 128);
        assertLe(rd.agentCount, 16);
        assertLe(rd.count - rd.agentCount, 112);
        bool fin = rd.status == IdeaMarket.Status.Final;
        uint256 sum;
        for (uint256 a; a < h.actorCount(); ++a) {
            address who = h.actors(a);
            uint256 s = m.stakeOf(id, who);
            sum += s;
            owed += fin ? m.claimable(id, who) : s;
            assertLe(m.roundStakeOf(r, who), m.MAX_PER_ADDRESS());
        }
        if (!fin) assertEq(sum, staked);
        address[3] memory ops = [safe, agent, anchorKey];
        for (uint256 o; o < 3; ++o) {
            assertEq(m.stakeOf(id, ops[o]), 0);
            assertEq(m.roundStakeOf(r, ops[o]), 0);
        }
    }

    /// @dev every round with ideas can be finalized at roundEnd + RESOLVE_WINDOW + 24 h.
    function invariant_liveness() public {
        uint256 cur = m.currentRound();
        for (uint256 r; r <= cur; ++r) {
            IdeaMarket.Round memory rd = _round(r);
            if (rd.count == 0 || rd.status == IdeaMarket.Status.Final) continue;
            uint256 snap = vm.snapshotState();
            uint256 deadline = m.roundEnd(r) + 3 days + 24 hours;
            if (vm.getBlockTimestamp() < deadline) vm.warp(deadline);
            m.finalize(r);
            vm.revertToState(snap);
        }
    }
}
