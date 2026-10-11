// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {GameKit} from "../../../src/games/GameKit.sol";
import {GameKitConformance} from "../GameKitConformance.sol";
import {Raffle} from "../../../src/games/raffle/Raffle.sol";

contract RaffleTest is GameKitConformance {
    Raffle internal g;
    RaffleHandler internal handler;
    /// the open round's entrants (the conformance plays), revealed by _closeRounds
    address[] internal entered;

    function setUp() public override {
        super.setUp();
        g = Raffle(address(game));
        handler = new RaffleHandler(g);
        targetContract(address(handler));
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(Raffle).creationCode;
    }

    function _secret(address p) internal view returns (bytes32) {
        return keccak256(abi.encode(p, g.round()));
    }

    function _play(address player) internal override {
        if (g.entryEnds() != 0 && block.timestamp >= g.entryEnds()) _closeRounds();
        bytes32 c = g.hashOf(_secret(player));
        vm.prank(player);
        g.enter(c);
        entered.push(player);
    }

    /// Every entrant reveals while the window is open; then the round is drawn.
    function _closeRounds() internal override {
        if (g.entryEnds() == 0) return;
        uint256 revealEnd = g.entryEnds() + g.REVEAL_WINDOW();
        if (block.timestamp < g.entryEnds()) vm.warp(g.entryEnds());
        for (uint256 i; block.timestamp < revealEnd && i < entered.length; ++i) {
            if (g.revealed(g.round(), entered[i])) continue;
            _reveal(entered[i]);
        }
        if (block.timestamp < revealEnd) vm.warp(revealEnd);
        g.settle();
        delete entered;
    }

    function _enter(address p) internal {
        bytes32 c = g.hashOf(_secret(p));
        vm.prank(p);
        g.enter(c);
    }

    function _reveal(address p) internal {
        bytes32 s = _secret(p);
        vm.prank(p);
        g.reveal(s);
    }

    function testFuzz_hashOfIsTheSecretsKeccak(bytes32 secret) public view {
        assertEq(g.hashOf(secret), keccak256(abi.encodePacked(secret)), "a page hashes the 32 bytes the same way");
    }

    function test_params_inBounds() public view {
        assertGe(g.ENTRY_WINDOW(), 1 hours);
        assertLe(g.ENTRY_WINDOW(), 3 days);
        assertGe(g.REVEAL_WINDOW(), 1 hours);
        assertLe(g.REVEAL_WINDOW(), 2 days);
        assertGe(g.PRIZE_BPS(), 100);
        assertLe(g.PRIZE_BPS(), 2000);
    }

    function test_enter_opensARound_oncePerAddress_untilItCloses() public {
        address a = makeAddr("a");
        _enter(a);
        assertEq(g.entryEnds(), block.timestamp + g.ENTRY_WINDOW());
        assertEq(g.entrants(), 1);
        vm.prank(a);
        vm.expectRevert(Raffle.AlreadyEntered.selector);
        g.enter(bytes32(uint256(1)));
        vm.prank(makeAddr("b"));
        vm.expectRevert(Raffle.EmptyCommitment.selector);
        g.enter(bytes32(0));
        uint256 ends = g.entryEnds();
        vm.warp(ends - 1);
        _enter(makeAddr("b"));
        assertEq(g.entryEnds(), ends, "a later entry keeps the window");
        assertEq(g.entrants(), 2);
        vm.warp(ends);
        vm.prank(makeAddr("c"));
        vm.expectRevert(Raffle.EntryClosed.selector);
        g.enter(bytes32(uint256(1)));
    }

    function test_reveal_onlyInItsWindow_onlyTheRightSecret_once() public {
        address a = makeAddr("a");
        bytes32 sa = _secret(a);
        vm.prank(a);
        vm.expectRevert(Raffle.NotRevealTime.selector);
        g.reveal(sa);
        _enter(a);
        address b = makeAddr("b");
        _enter(b);
        bytes32 sb = _secret(b);
        uint256 ends = g.entryEnds();
        vm.warp(ends - 1);
        vm.prank(a);
        vm.expectRevert(Raffle.NotRevealTime.selector);
        g.reveal(sa);
        vm.warp(ends);
        vm.prank(a);
        vm.expectRevert(Raffle.WrongSecret.selector);
        g.reveal(bytes32(uint256(7)));
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(Raffle.WrongSecret.selector);
        g.reveal(sa);
        _reveal(a);
        assertTrue(g.revealed(0, a));
        assertEq(g.revealedCount(), 1);
        assertEq(g.seed(), keccak256(abi.encode(sa, a)));
        vm.prank(a);
        vm.expectRevert(Raffle.AlreadyRevealed.selector);
        g.reveal(sa);
        vm.warp(ends + g.REVEAL_WINDOW());
        vm.prank(b);
        vm.expectRevert(Raffle.NotRevealTime.selector);
        g.reveal(sb);
    }

    function test_draw_picksSeedModRevealers_andPaysTheShare() public {
        address[3] memory ps = [makeAddr("a"), makeAddr("b"), makeAddr("c")];
        for (uint256 i; i < 3; ++i) {
            _enter(ps[i]);
        }
        vm.warp(g.entryEnds());
        bytes32 seed;
        for (uint256 i; i < 3; ++i) {
            _reveal(ps[i]);
            seed ^= keccak256(abi.encode(_secret(ps[i]), ps[i]));
        }
        assertEq(g.seed(), seed);
        address winner = ps[uint256(seed) % 3];
        uint256 prize = (game.freeBalance() * g.PRIZE_BPS()) / 10_000;
        vm.warp(g.entryEnds() + g.REVEAL_WINDOW() - 1);
        vm.expectRevert(Raffle.RoundRunning.selector);
        g.settle();
        skip(1);
        g.settle();
        assertEq(game.owed(winner), prize);
        assertEq(game.owedTotal(), prize);
        assertEq(g.round(), 1);
        assertEq(g.entryEnds(), 0);
        assertEq(g.entrants(), 0);
        assertEq(g.seed(), bytes32(0));
        assertEq(g.revealedCount(), 0, "a new round starts with no reveals");
    }

    function test_onlyARevealerCanWin_noRevealsNoPrize() public {
        address a = makeAddr("a");
        address b = makeAddr("b");
        _enter(a);
        _enter(b);
        vm.warp(g.entryEnds());
        _reveal(b);
        vm.warp(g.entryEnds() + g.REVEAL_WINDOW());
        g.settle();
        assertEq(game.owed(a), 0);
        assertGt(game.owed(b), 0);
        _enter(a);
        vm.warp(g.entryEnds() + g.REVEAL_WINDOW());
        uint256 owedBefore = game.owedTotal();
        g.settle();
        assertEq(game.owedTotal(), owedBefore, "no reveal: no prize");
        assertEq(g.round(), 2);
    }

    function test_settle_needsARound() public {
        vm.expectRevert(Raffle.RoundRunning.selector);
        g.settle();
    }

    function test_aCopiedCommitmentNeverCancelsAReveal() public {
        address a = makeAddr("a");
        address copier = makeAddr("copier");
        _enter(a);
        bytes32 c = g.commitmentOf(0, a);
        vm.prank(copier);
        g.enter(c);
        vm.warp(g.entryEnds());
        _reveal(a);
        bytes32 s = _secret(a);
        vm.prank(copier);
        g.reveal(s);
        assertEq(g.seed(), keccak256(abi.encode(s, a)) ^ keccak256(abi.encode(s, copier)));
        assertTrue(g.seed() != bytes32(0));
    }

    function test_paused_revealsGoOn_noEntry_noDraw() public {
        address a = makeAddr("a");
        _enter(a);
        vm.warp(g.entryEnds());
        vm.prank(safe);
        game.pause(true);
        _reveal(a);
        vm.prank(makeAddr("b"));
        vm.expectRevert(GameKit.NotLive.selector);
        g.enter(bytes32(uint256(1)));
        vm.warp(g.entryEnds() + g.REVEAL_WINDOW());
        vm.expectRevert(GameKit.NotLive.selector);
        g.settle();
    }

    function test_sweepWaitsForTheOpenRound() public {
        _enter(makeAddr("a"));
        vm.prank(agent);
        factory.retire(address(game));
        vm.expectRevert(GameKit.RoundOpen.selector);
        game.sweep();
    }

    function testFuzz_theWinnerRevealed_andThePrizeIsTheShare(uint8 n, uint64 mask) public {
        uint256 count = uint256(n) % 30 + 1;
        for (uint256 i; i < count; ++i) {
            _enter(address(uint160(0x1000 + i)));
        }
        vm.warp(g.entryEnds());
        for (uint256 i; i < count; ++i) {
            if ((mask >> i) & 1 == 1) _reveal(address(uint160(0x1000 + i)));
        }
        uint256 revealers = g.revealedCount();
        uint256 prize = (game.freeBalance() * g.PRIZE_BPS()) / 10_000;
        vm.warp(g.entryEnds() + g.REVEAL_WINDOW());
        g.settle();
        assertEq(game.owedTotal(), revealers == 0 ? 0 : prize);
        for (uint256 i; i < count; ++i) {
            address p = address(uint160(0x1000 + i));
            if (game.owed(p) > 0) assertTrue(g.revealed(0, p), "only a revealer wins");
        }
        _assertSolvent();
    }

    function invariant_solvent_andRevealsAreEntries() public view {
        _assertSolvent();
        assertEq(handler.owedSum(), game.owedTotal());
        assertLe(g.revealedCount(), g.entrants());
    }
}

/// Random entries, reveals, draws, claims and time for the invariant run (every call may fail).
contract RaffleHandler is Test {
    Raffle internal g;
    address[4] internal actors = [address(0xA1), address(0xA2), address(0xA3), address(0xA4)];

    constructor(Raffle g_) {
        g = g_;
    }

    function _secret(address p) internal view returns (bytes32) {
        return keccak256(abi.encode(p, g.round()));
    }

    function enter(uint256 who) external {
        address a = actors[who % 4];
        bytes32 c = g.hashOf(_secret(a));
        vm.prank(a);
        try g.enter(c) {} catch {}
    }

    function reveal(uint256 who) external {
        address a = actors[who % 4];
        bytes32 s = _secret(a);
        vm.prank(a);
        try g.reveal(s) {} catch {}
    }

    function settle() external {
        try g.settle() {} catch {}
    }

    function claim(uint256 who) external {
        address a = actors[who % 4];
        if (g.owed(a) == 0) return;
        vm.prank(a);
        g.claim();
    }

    function pass(uint32 s) external {
        skip(uint256(s) % 1 days);
    }

    function owedSum() external view returns (uint256 sum) {
        for (uint256 i; i < 4; ++i) {
            sum += g.owed(actors[i]);
        }
    }
}
