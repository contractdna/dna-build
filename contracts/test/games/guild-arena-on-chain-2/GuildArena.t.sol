// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {GameKitConformance} from "../GameKitConformance.sol";
import {GuildArena} from "../../../src/games/guild-arena-on-chain-2/GuildArena.sol";

/// The rules of Guild Arena, run on the game the conformance setUp deploys and funds through the real factory.
contract GuildArenaTest is GameKitConformance {
    event GuildCreated(uint256 indexed guild, bytes32 name, address indexed founder);
    event Joined(uint256 indexed guild, address indexed member);
    event Left(uint256 indexed guild, address indexed member);
    event Committed(uint256 indexed epoch, address indexed member, bytes32 hash);
    event Revealed(uint256 indexed epoch, uint256 indexed guild, address indexed member);
    event Played(address indexed player, uint256 valueWei);

    /// The kit's errors, declared here by signature (a derived contract's lookup doesn't reach an inherited error).
    error NotSafe();
    error NotLive();

    function _creationCode() internal pure override returns (bytes memory) {
        return type(GuildArena).creationCode;
    }

    function _g() internal view returns (GuildArena) {
        return GuildArena(address(game));
    }

    function _at(uint256 t) internal {
        vm.warp(t);
    }

    /// The first second of the reveal half of epoch `e`.
    function _revealTime(uint256 e) internal view returns (uint256) {
        return _g().epochStart(e) + _g().HALF();
    }

    /// A play: a player with no guild founds one (in the commit phase: at the next epoch's start if it is the reveal
    /// phase); a player with a guild commits once per epoch (moving on to the next epoch when it is already done or
    /// the reveal phase is on).
    function _play(address player) internal override {
        GuildArena g = _g();
        if (g.guildOf(player) == 0) {
            if (g.inRevealPhase()) _at(g.epochStart(g.currentEpoch() + 1));
            bytes32 name = bytes32(uint256(uint160(player)));
            vm.prank(player);
            g.createGuild(name);
            return;
        }
        uint256 e = g.currentEpoch();
        if (g.commitOf(e, player) != bytes32(0) || g.inRevealPhase()) {
            _at(g.epochStart(e + 1));
        }
        e = g.currentEpoch();
        bytes32 c = g.commitHash(keccak256(abi.encode(player)), player, e);
        vm.prank(player);
        g.commit(c);
    }

    /// Closes the open epoch: time moves to the next epoch's start.
    function _closeRounds() internal override {
        GuildArena g = _g();
        _at(g.epochStart(g.currentEpoch() + 1));
    }

    function test_params_areTheRules() public view {
        GuildArena g = _g();
        assertEq(g.SEATS(), 8);
        assertEq(g.EPOCH(), 7 days);
        assertEq(g.HALF(), g.EPOCH() / 2);
        assertEq(uint256(g.start()), block.timestamp);
    }

    function test_createGuild_founderIsMember_emitsEvent() public {
        GuildArena g = _g();
        address a = makeAddr("founder");
        bytes32 name = bytes32("the arena");
        vm.expectEmit(true, true, false, true, address(game));
        emit GuildCreated(1, name, a);
        vm.prank(a);
        g.createGuild(name);
        assertEq(g.guildCount(), 1);
        assertEq(g.guildOf(a), 1);
        assertEq(g.memberCount(1), 1);
        assertEq(g.membersOf(1)[0], a);
        assertEq(g.guildName(1), name);
    }

    function test_createGuild_zeroNameReverts() public {
        address z = makeAddr("zero");
        vm.prank(z);
        vm.expectRevert(GuildArena.NoName.selector);
        _g().createGuild(bytes32(0));
        assertEq(_g().guildCount(), 0);
    }

    function test_createOrJoin_whenAlreadyInGuild_reverts() public {
        GuildArena g = _g();
        address a = makeAddr("a");
        address b = makeAddr("b");
        vm.prank(a);
        g.createGuild(bytes32("one"));
        vm.prank(a);
        vm.expectRevert(GuildArena.AlreadyInGuild.selector);
        g.createGuild(bytes32("two"));
        vm.prank(b);
        g.joinGuild(1);
        vm.prank(b);
        vm.expectRevert(GuildArena.AlreadyInGuild.selector);
        g.joinGuild(1);
        vm.prank(a);
        vm.expectRevert(GuildArena.AlreadyInGuild.selector);
        g.joinGuild(1);
    }

    function test_join_ninthMember_reverts_seatCapHeld() public {
        GuildArena g = _g();
        address[] memory ps = _players(9);
        vm.prank(ps[0]);
        g.createGuild(bytes32("full"));
        for (uint256 i = 1; i < 8; ++i) {
            vm.prank(ps[i]);
            g.joinGuild(1);
        }
        assertEq(g.memberCount(1), 8, "eighth member fits");
        vm.prank(ps[8]);
        vm.expectRevert(GuildArena.GuildFull.selector);
        g.joinGuild(1);
        assertEq(g.memberCount(1), 8, "ninth member refused");
        assertEq(g.guildOf(ps[8]), 0);
    }

    function test_join_nonexistentGuild_reverts() public {
        GuildArena g = _g();
        address a = makeAddr("a");
        address b = makeAddr("b");
        vm.prank(a);
        vm.expectRevert(GuildArena.NoSuchGuild.selector);
        g.joinGuild(0);
        vm.prank(a);
        g.createGuild(bytes32("x"));
        uint256 beyond = g.guildCount() + 1;
        vm.prank(b);
        vm.expectRevert(GuildArena.NoSuchGuild.selector);
        g.joinGuild(beyond);
    }

    function test_leave_swapAndPop_membersOfConsistent() public {
        GuildArena g = _g();
        address a = makeAddr("a");
        address b = makeAddr("b");
        address c = makeAddr("c");
        vm.prank(a);
        g.createGuild(bytes32("swap"));
        vm.prank(b);
        g.joinGuild(1);
        vm.prank(c);
        g.joinGuild(1);
        vm.prank(a);
        g.leaveGuild();
        assertEq(g.guildOf(a), 0);
        assertEq(g.memberCount(1), 2);
        address[] memory ms = g.membersOf(1);
        assertEq(ms[0], c, "the last member takes the leaver's slot");
        assertEq(ms[1], b);
        assertEq(g.guildOf(c), 1);
        assertEq(g.guildOf(b), 1);
        vm.prank(a);
        vm.expectRevert(GuildArena.NotInGuild.selector);
        g.leaveGuild();
        vm.prank(a);
        g.joinGuild(1);
        assertEq(g.memberCount(1), 3, "rejoin works");
        assertEq(g.guildOf(a), 1);
    }

    function test_create_join_leave_inRevealPhase_revert() public {
        GuildArena g = _g();
        address a = makeAddr("a");
        address b = makeAddr("b");
        vm.prank(a);
        g.createGuild(bytes32("phase"));
        _at(_revealTime(0));
        vm.prank(b);
        vm.expectRevert(GuildArena.RevealPhase.selector);
        g.createGuild(bytes32("late"));
        vm.prank(b);
        vm.expectRevert(GuildArena.RevealPhase.selector);
        g.joinGuild(1);
        vm.prank(a);
        vm.expectRevert(GuildArena.RevealPhase.selector);
        g.leaveGuild();
    }

    function test_create_join_leave_allowedAtHalfMinusOne_andNextEpochStart() public {
        GuildArena g = _g();
        address a = makeAddr("a");
        address b = makeAddr("b");
        address c = makeAddr("c");
        _at(_revealTime(0) - 1);
        vm.prank(a);
        g.createGuild(bytes32("edge"));
        vm.prank(b);
        g.joinGuild(1);
        _at(g.epochStart(1));
        vm.prank(c);
        g.createGuild(bytes32("next"));
        vm.prank(b);
        g.leaveGuild();
        assertEq(g.guildOf(b), 0);
        assertEq(g.guildCount(), 2);
    }

    function test_commit_requiresGuild_commitPhaseOnly_oncePerEpoch_nonZero() public {
        GuildArena g = _g();
        address a = makeAddr("a");
        address out = makeAddr("out");
        bytes32 c1 = keccak256("c1");
        vm.prank(out);
        vm.expectRevert(GuildArena.NotInGuild.selector);
        g.commit(c1);
        vm.prank(a);
        g.createGuild(bytes32("commit"));
        vm.prank(a);
        vm.expectRevert(GuildArena.ZeroCommit.selector);
        g.commit(bytes32(0));
        vm.prank(a);
        g.commit(c1);
        assertEq(g.commitOf(0, a), c1);
        assertEq(g.commitGuild(0, a), 1);
        bytes32 c2 = keccak256("c2");
        vm.prank(a);
        vm.expectRevert(GuildArena.AlreadyCommitted.selector);
        g.commit(c2);
        _at(_revealTime(0));
        bytes32 c3 = keccak256("c3");
        vm.prank(a);
        vm.expectRevert(GuildArena.NotCommitPhase.selector);
        g.commit(c3);
        _closeRounds();
        bytes32 c4 = keccak256("c4");
        vm.prank(a);
        g.commit(c4);
        assertEq(g.commitOf(1, a), c4, "a new epoch allows one more commit");
    }

    function test_commit_atExactlyHALF_reverts() public {
        GuildArena g = _g();
        address a = makeAddr("a");
        address b = makeAddr("b");
        vm.prank(a);
        g.createGuild(bytes32("edge"));
        vm.prank(b);
        g.joinGuild(1);
        _at(_revealTime(0) - 1);
        bytes32 last = keccak256("last second");
        vm.prank(a);
        g.commit(last);
        _at(_revealTime(0));
        bytes32 late = keccak256("too late");
        vm.prank(b);
        vm.expectRevert(GuildArena.NotCommitPhase.selector);
        g.commit(late);
    }

    function _commitAs(address who, bytes32 secret) internal {
        GuildArena g = _g();
        bytes32 c = g.commitHash(secret, who, g.currentEpoch());
        vm.prank(who);
        g.commit(c);
    }

    function _revealAs(address who, bytes32 secret) internal {
        GuildArena g = _g();
        vm.prank(who);
        g.reveal(secret);
    }

    function test_reveal_validEarnsOnePointMemberAndGuild_updatesTopGuild() public {
        GuildArena g = _g();
        address a = makeAddr("a");
        bytes32 s = keccak256("secret a");
        vm.prank(a);
        g.createGuild(bytes32("win"));
        _commitAs(a, s);
        _at(_revealTime(0));
        vm.expectEmit(true, true, true, true, address(game));
        emit Revealed(0, 1, a);
        _revealAs(a, s);
        assertEq(g.reputation(a), 1);
        assertEq(g.guildPoints(0, 1), 1);
        assertEq(g.topGuild(0), 1);
        assertTrue(g.revealed(0, a));
    }

    function test_reveal_wrongSecret_otherSender_otherEpoch_reverts() public {
        GuildArena g = _g();
        address a = makeAddr("a");
        address b = makeAddr("b");
        bytes32 s = keccak256("s");
        vm.prank(a);
        g.createGuild(bytes32("g"));
        vm.prank(b);
        g.joinGuild(1);
        bytes32 ca = g.commitHash(s, a, 0);
        vm.prank(a);
        g.commit(ca);
        vm.prank(b);
        g.commit(ca); // b copies a's commitment: it is bound to a, so it never matches b
        _at(_revealTime(0));
        vm.prank(a);
        vm.expectRevert(GuildArena.BadSecret.selector);
        g.reveal(keccak256("wrong"));
        vm.prank(b);
        vm.expectRevert(GuildArena.BadSecret.selector);
        g.reveal(s);
        assertEq(g.reputation(a), 0);
        assertEq(g.guildPoints(0, 1), 0);
        _closeRounds();
        bytes32 c1 = g.commitHash(s, a, 0);
        vm.prank(a);
        g.commit(c1); // the epoch 0 hash, committed in epoch 1
        _at(_revealTime(1));
        vm.prank(a);
        vm.expectRevert(GuildArena.BadSecret.selector);
        g.reveal(s);
        assertEq(g.guildPoints(1, 1), 0);
    }

    function test_reveal_twice_reverts_andNotOutsideTheRevealPhase() public {
        GuildArena g = _g();
        address a = makeAddr("a");
        bytes32 s = keccak256("twice");
        vm.prank(a);
        g.createGuild(bytes32("t"));
        _commitAs(a, s);
        vm.prank(a);
        vm.expectRevert(GuildArena.NotRevealPhase.selector);
        g.reveal(s);
        _at(_revealTime(0));
        _revealAs(a, s);
        vm.prank(a);
        vm.expectRevert(GuildArena.AlreadyRevealed.selector);
        g.reveal(s);
        _closeRounds();
        vm.prank(a);
        vm.expectRevert(GuildArena.NotRevealPhase.selector);
        g.reveal(s);
        assertEq(g.reputation(a), 1);
    }

    function test_reveal_afterSwitchingGuild_reverts() public {
        GuildArena g = _g();
        address a = makeAddr("a");
        address b = makeAddr("b");
        bytes32 s = keccak256("switch");
        vm.prank(a);
        g.createGuild(bytes32("from"));
        vm.prank(b);
        g.createGuild(bytes32("to"));
        _commitAs(a, s);
        vm.prank(a);
        g.leaveGuild();
        vm.prank(a);
        g.joinGuild(2);
        _at(_revealTime(0));
        vm.prank(a);
        vm.expectRevert(GuildArena.GuildChanged.selector);
        g.reveal(s);
        assertEq(g.guildPoints(0, 1), 0);
        assertEq(g.guildPoints(0, 2), 0);
    }

    function test_topGuild_tieKeepsFirst_higherOvertakes_perEpochIndependent() public {
        GuildArena g = _g();
        address a1 = makeAddr("a1");
        address a2 = makeAddr("a2");
        address b1 = makeAddr("b1");
        address b2 = makeAddr("b2");
        vm.prank(a1);
        g.createGuild(bytes32("A"));
        vm.prank(a2);
        g.joinGuild(1);
        vm.prank(b1);
        g.createGuild(bytes32("B"));
        vm.prank(b2);
        g.joinGuild(2);
        bytes32 sA1 = keccak256("a1");
        bytes32 sA2 = keccak256("a2");
        bytes32 sB1 = keccak256("b1");
        bytes32 sB2 = keccak256("b2");
        _commitAs(a1, sA1);
        _commitAs(a2, sA2);
        _commitAs(b1, sB1);
        _commitAs(b2, sB2);
        _at(_revealTime(0));
        _revealAs(a1, sA1);
        assertEq(g.topGuild(0), 1);
        _revealAs(b1, sB1);
        assertEq(g.guildPoints(0, 2), 1);
        assertEq(g.topGuild(0), 1, "a tie keeps the guild that got there first");
        _revealAs(b2, sB2);
        assertEq(g.topGuild(0), 2, "a higher score overtakes");
        _revealAs(a2, sA2);
        assertEq(g.guildPoints(0, 1), 2);
        assertEq(g.topGuild(0), 2, "a tie again keeps the leader");
        _closeRounds();
        _commitAs(a1, sA1);
        _at(_revealTime(1));
        _revealAs(a1, sA1);
        assertEq(g.guildPoints(1, 1), 1, "points are per epoch");
        assertEq(g.guildPoints(1, 2), 0);
        assertEq(g.topGuild(1), 1);
        assertEq(g.topGuild(0), 2, "the epoch 0 leader stands");
    }

    function test_reputation_lifetimeAcrossEpochs_neverDropsOnLeave() public {
        GuildArena g = _g();
        address a = makeAddr("a");
        bytes32 s0 = keccak256("rep0");
        bytes32 s1 = keccak256("rep1");
        vm.prank(a);
        g.createGuild(bytes32("life"));
        _commitAs(a, s0);
        _at(_revealTime(0));
        _revealAs(a, s0);
        assertEq(g.reputation(a), 1);
        _closeRounds();
        vm.prank(a);
        g.leaveGuild();
        assertEq(g.reputation(a), 1, "leaving keeps reputation");
        vm.prank(a);
        g.joinGuild(1);
        _commitAs(a, s1);
        _at(_revealTime(1));
        _revealAs(a, s1);
        assertEq(g.reputation(a), 2);
        assertEq(g.guildPoints(0, 1), 1);
        assertEq(g.guildPoints(1, 1), 1);
    }

    function test_pause_blocksEveryPlay_onlySafe() public {
        GuildArena g = _g();
        address a = makeAddr("a");
        address b = makeAddr("b");
        vm.expectEmit(true, false, false, true, address(game));
        emit Played(a, 0);
        vm.prank(a);
        g.createGuild(bytes32("open"));
        vm.prank(b);
        vm.expectRevert(NotSafe.selector);
        g.pause(true);
        vm.prank(safe);
        g.pause(true);
        vm.prank(b);
        vm.expectRevert(NotLive.selector);
        g.createGuild(bytes32("paused"));
        vm.prank(a);
        vm.expectRevert(NotLive.selector);
        g.leaveGuild();
        vm.prank(a);
        vm.expectRevert(NotLive.selector);
        g.commit(keccak256("paused commit"));
        vm.prank(safe);
        g.pause(false);
        vm.expectEmit(true, false, false, true, address(game));
        emit Played(b, 0);
        vm.prank(b);
        g.createGuild(bytes32("again"));
        assertEq(g.guildOf(b), 2);
    }

    function test_sweepRightAfterRetire_noRoundOpen_neverOwes() public {
        GuildArena g = _g();
        address a = makeAddr("a");
        vm.prank(a);
        g.createGuild(bytes32("retire"));
        vm.prank(agent);
        factory.retire(address(game));
        assertTrue(g.retired());
        uint256 free = g.freeBalance();
        uint256 before = safe.balance;
        g.sweep();
        assertEq(safe.balance, before + free, "the free balance goes back to the Safe");
        assertEq(address(game).balance, 0);
        assertEq(g.owedTotal(), 0);
        assertEq(g.owed(a), 0);
    }

    function test_joinLeaveCommit_emitTheirEvents() public {
        GuildArena g = _g();
        address a = makeAddr("ev-a");
        address b = makeAddr("ev-b");
        vm.prank(a);
        g.createGuild(bytes32("events"));
        vm.expectEmit(true, true, false, false, address(game));
        emit Joined(1, b);
        vm.prank(b);
        g.joinGuild(1);
        bytes32 s = keccak256("ev");
        bytes32 c = g.commitHash(s, b, 0);
        vm.expectEmit(true, true, false, true, address(game));
        emit Committed(0, b, c);
        vm.prank(b);
        g.commit(c);
        vm.expectEmit(true, true, false, false, address(game));
        emit Left(1, b);
        vm.prank(b);
        g.leaveGuild();
    }

    /// Only a reveal in the second half of the epoch, with the committed secret, scores; anything else reverts.
    function testFuzz_commitReveal_anySecretAndTime(bytes32 secret, uint32 t) public {
        GuildArena g = _g();
        address a = makeAddr("fuzzer");
        vm.prank(a);
        g.createGuild(bytes32("fuzz"));
        bytes32 c = g.commitHash(secret, a, 0);
        vm.prank(a);
        g.commit(c);
        uint256 dt = uint256(t) % 7 days;
        _at(uint256(g.start()) + dt);
        bool revealTime = dt >= g.HALF();
        if (revealTime) {
            bytes32 other = keccak256(abi.encode(secret));
            vm.prank(a);
            vm.expectRevert(GuildArena.BadSecret.selector);
            g.reveal(other);
            _revealAs(a, secret);
            assertEq(g.guildPoints(0, 1), 1);
            assertEq(g.topGuild(0), 1);
        } else {
            vm.prank(a);
            vm.expectRevert(GuildArena.NotRevealPhase.selector);
            g.reveal(secret);
            assertEq(g.guildPoints(0, 1), 0);
        }
        assertEq(g.reputation(a), revealTime ? 1 : 0);
    }

    /// Members of a full guild leave in a random order: the list stays consistent after every leave, and every member
    /// can still leave (a stale slot would make a later leave fail or evict the wrong member).
    function testFuzz_leave_anyOrder_listStaysConsistent(uint256 seed) public {
        GuildArena g = _g();
        address[] memory ps = _players(8);
        vm.prank(ps[0]);
        g.createGuild(bytes32("order"));
        for (uint256 i = 1; i < 8; ++i) {
            vm.prank(ps[i]);
            g.joinGuild(1);
        }
        uint256 left;
        for (uint256 k = 8; k > 0; --k) {
            seed = uint256(keccak256(abi.encode(seed, k)));
            uint256 pick = seed % k;
            address who;
            uint256 seen;
            for (uint256 i; i < 8; ++i) {
                if (g.guildOf(ps[i]) == 1) {
                    if (seen == pick) {
                        who = ps[i];
                        break;
                    }
                    ++seen;
                }
            }
            vm.prank(who);
            g.leaveGuild();
            ++left;
            assertEq(g.guildOf(who), 0);
            address[] memory ms = g.membersOf(1);
            assertEq(ms.length, 8 - left);
            assertEq(g.memberCount(1), 8 - left);
            for (uint256 i; i < ms.length; ++i) {
                assertTrue(ms[i] != who, "the leaver is gone");
                assertEq(g.guildOf(ms[i]), 1);
                for (uint256 j = i + 1; j < ms.length; ++j) {
                    assertTrue(ms[i] != ms[j], "no duplicates");
                }
            }
        }
        assertEq(g.memberCount(1), 0);
        // the emptied guild can be joined again
        vm.prank(ps[3]);
        g.joinGuild(1);
        assertEq(g.membersOf(1)[0], ps[3]);
    }

    function test_reveal_afterLeavingWithoutRejoin_reverts_rejoinSameGuildScores() public {
        GuildArena g = _g();
        address a = makeAddr("a");
        address b = makeAddr("b");
        bytes32 sa = keccak256("sa");
        bytes32 sb = keccak256("sb");
        vm.prank(a);
        g.createGuild(bytes32("x"));
        vm.prank(b);
        g.joinGuild(1);
        _commitAs(a, sa);
        _commitAs(b, sb);
        vm.prank(a);
        g.leaveGuild();
        vm.prank(b);
        g.leaveGuild();
        vm.prank(b);
        g.joinGuild(1);
        _at(_revealTime(0));
        vm.prank(a);
        vm.expectRevert(GuildArena.GuildChanged.selector);
        g.reveal(sa);
        _revealAs(b, sb);
        assertEq(g.guildPoints(0, 1), 1);
        assertEq(g.reputation(a), 0);
        assertEq(g.reputation(b), 1);
    }

    function test_reveal_withoutCommit_reverts_andCommitIsPerEpoch() public {
        GuildArena g = _g();
        address a = makeAddr("a");
        vm.prank(a);
        g.createGuild(bytes32("y"));
        _at(_revealTime(0));
        vm.prank(a);
        vm.expectRevert(GuildArena.NoCommit.selector);
        g.reveal(bytes32(0));
        assertEq(g.guildPoints(0, 1), 0);
        assertEq(g.topGuild(0), 0);
    }

    function test_epochMath_boundaries() public {
        GuildArena g = _g();
        uint256 s = g.start();
        _at(s + 7 days - 1);
        assertEq(g.currentEpoch(), 0);
        assertTrue(g.inRevealPhase());
        _at(s + 7 days);
        assertEq(g.currentEpoch(), 1);
        assertFalse(g.inRevealPhase());
        assertEq(g.epochStart(3), s + 21 days);
        _at(s + 7 days + g.HALF() - 1);
        assertFalse(g.inRevealPhase());
        _at(s + 7 days + g.HALF());
        assertTrue(g.inRevealPhase());
    }

    /// However many join, the guild never holds more than the seats.
    function testFuzz_joinCount_neverExceedsSeats(uint8 n) public {
        GuildArena g = _g();
        uint256 seats = g.SEATS();
        uint256 joiners = uint256(n) % 20;
        address founder = makeAddr("founder");
        vm.prank(founder);
        g.createGuild(bytes32("cap"));
        for (uint256 i; i < joiners; ++i) {
            address p = makeAddr(string.concat("joiner", vm.toString(i)));
            uint256 count = g.memberCount(1);
            vm.prank(p);
            if (count < seats) {
                g.joinGuild(1);
            } else {
                vm.expectRevert(GuildArena.GuildFull.selector);
                g.joinGuild(1);
            }
        }
        uint256 expected = joiners + 1 < seats ? joiners + 1 : seats;
        assertEq(g.memberCount(1), expected);
        assertLe(g.memberCount(1), seats);
    }
}

/// Random founding, joins, leaves, commits, reveals and time for the invariant run. A call that would revert is skipped
/// (it reverts inside a try and changes nothing), so only the steps that land move the ghosts.
contract GuildArenaHandler is Test {
    GuildArena internal g;
    address[4] public actors = [address(0xA1), address(0xA2), address(0xA3), address(0xA4)];
    mapping(address => uint256) public ghostRep;
    uint256[4] internal repSeen;
    bool public repDropped;
    uint256 public totalReveals;

    constructor(GuildArena g_) {
        g = g_;
    }

    function secretOf(address who, uint256 e) public pure returns (bytes32) {
        return keccak256(abi.encode(who, e));
    }

    function createGuild(uint256 who, uint256 name) external {
        bytes32 nm = bytes32(uint256(name % 1000) + 1);
        vm.prank(actors[who % 4]);
        try g.createGuild(nm) {} catch {}
        _track();
    }

    function joinGuild(uint256 who, uint256 pick) external {
        uint256 n = g.guildCount();
        uint256 gid = n == 0 ? 0 : (pick % n) + 1;
        vm.prank(actors[who % 4]);
        try g.joinGuild(gid) {} catch {}
        _track();
    }

    function leaveGuild(uint256 who) external {
        vm.prank(actors[who % 4]);
        try g.leaveGuild() {} catch {}
        _track();
    }

    function commit(uint256 who) external {
        address a = actors[who % 4];
        uint256 e = g.currentEpoch();
        bytes32 c = g.commitHash(secretOf(a, e), a, e);
        vm.prank(a);
        try g.commit(c) {} catch {}
        _track();
    }

    function reveal(uint256 who) external {
        address a = actors[who % 4];
        uint256 e = g.currentEpoch();
        bytes32 s = secretOf(a, e);
        vm.prank(a);
        try g.reveal(s) {
            ghostRep[a] += 1;
            totalReveals += 1;
        } catch {}
        _track();
    }

    function wait(uint32 s) external {
        skip(uint256(s) % 4 days);
        _track();
    }

    /// Reputation never drops: remembers each actor's last value and flags any fall.
    function _track() internal {
        for (uint256 i; i < 4; ++i) {
            uint256 r = g.reputation(actors[i]);
            if (r < repSeen[i]) repDropped = true;
            repSeen[i] = r;
        }
    }
}

/// The invariant run on the game the conformance setUp deployed and funded through the real factory.
contract GuildArenaInvariantTest is GuildArenaTest {
    GuildArenaHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new GuildArenaHandler(GuildArena(address(game)));
        targetContract(address(handler));
    }

    function invariant_seatCapAndOneGuildPerAddress() public view {
        GuildArena g = GuildArena(address(game));
        uint256 n = g.guildCount();
        for (uint256 gid = 1; gid <= n; ++gid) {
            address[] memory ms = g.membersOf(gid);
            assertLe(ms.length, g.SEATS(), "seat cap held");
            for (uint256 i; i < ms.length; ++i) {
                assertEq(g.guildOf(ms[i]), gid, "membersOf agrees with guildOf");
            }
        }
        for (uint256 i; i < 4; ++i) {
            address who = handler.actors(i);
            uint256 gid = g.guildOf(who);
            if (gid == 0) continue;
            bool listed;
            address[] memory listedIn = g.membersOf(gid);
            for (uint256 j; j < listedIn.length; ++j) {
                if (listedIn[j] == who) listed = true;
            }
            assertTrue(listed, "a member is listed in its guild");
        }
    }

    function invariant_reputationIsTheGhostAndNeverDrops() public view {
        GuildArena g = GuildArena(address(game));
        assertFalse(handler.repDropped(), "reputation never drops");
        uint256 sum;
        for (uint256 i; i < 4; ++i) {
            address who = handler.actors(i);
            assertEq(g.reputation(who), handler.ghostRep(who), "reputation is the ghost");
            sum += g.reputation(who);
        }
        assertEq(sum, handler.totalReveals(), "reputation adds up to the reveals");
    }

    function invariant_pointsMatchTheRevealsAndNothingIsOwed() public view {
        GuildArena g = GuildArena(address(game));
        uint256 n = g.guildCount();
        uint256 last = g.currentEpoch();
        uint256 pts;
        for (uint256 e; e <= last; ++e) {
            for (uint256 gid = 1; gid <= n; ++gid) {
                pts += g.guildPoints(e, gid);
            }
        }
        assertEq(pts, handler.totalReveals(), "one point per reveal, to its guild");
        for (uint256 e; e <= last; ++e) {
            uint256 top = g.topGuild(e);
            uint256 best;
            for (uint256 gid = 1; gid <= n; ++gid) {
                uint256 p = g.guildPoints(e, gid);
                if (p > best) best = p;
            }
            assertEq(g.guildPoints(e, top), best, "the top guild holds the best score");
            if (best > 0) assertTrue(top != 0, "a scored epoch has a leader");
        }
        assertEq(g.owedTotal(), 0, "nothing is owed");
    }
}
