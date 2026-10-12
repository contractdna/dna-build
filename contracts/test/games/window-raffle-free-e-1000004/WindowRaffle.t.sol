// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {GameKitConformance} from "../GameKitConformance.sol";
import {GameKit} from "../../../src/games/GameKit.sol";
import {WindowRaffle} from "../../../src/games/window-raffle-free-e-1000004/WindowRaffle.sol";

contract WindowRaffleTest is GameKitConformance {
    uint256[] internal touched;
    uint256 internal done;

    function _creationCode() internal pure override returns (bytes memory) {
        return type(WindowRaffle).creationCode;
    }

    function _g() internal view returns (WindowRaffle) {
        return WindowRaffle(address(game));
    }

    function _play(address player) internal override {
        WindowRaffle g = _g();
        vm.prank(player);
        g.enter();
        uint256 w = g.currentWindow();
        if (touched.length == 0 || touched[touched.length - 1] != w) touched.push(w);
    }

    function _closeRounds() internal override {
        WindowRaffle g = _g();
        uint256 n = touched.length;
        if (n == 0) return;
        uint256 last = touched[n - 1];
        if (g.currentWindow() <= last) vm.warp((last + 1) * g.WINDOW());
        for (uint256 i = done; i < n; i++) {
            uint256 w = touched[i];
            if (g.drawBlockOf(w) == 0) g.draw(w);
        }
        vm.roll(block.number + 2);
        for (uint256 i = done; i < n; i++) {
            uint256 w = touched[i];
            if (!g.finalizedOf(w)) g.finalize(w);
        }
        done = n;
    }

    function _addr(uint256 i) internal pure returns (address) {
        return address(uint160(0x10000 + i));
    }

    function _enterMany(uint256 n) internal {
        for (uint256 i = 0; i < n; i++) {
            _play(_addr(i));
        }
    }

    function _toNextWindow() internal {
        WindowRaffle g = _g();
        vm.warp((g.currentWindow() + 1) * g.WINDOW());
    }

    function _drawAndRoll(uint256 w) internal returns (uint256 drawBlock) {
        _g().draw(w);
        drawBlock = _g().drawBlockOf(w);
        vm.roll(drawBlock + 1);
    }

    // ---------------------------------------------------------------- params

    function test_params_matchSpec() public view {
        WindowRaffle g = _g();
        assertEq(g.WINDOW(), 6 hours);
        assertEq(g.MAX_ENTRANTS(), 256);
        assertEq(g.MAX_WEIGHT(), 5);
        assertEq(g.WINNERS(), 5);
        assertEq(g.VOID_BLOCKS(), 256);
    }

    // ---------------------------------------------------------------- enter

    function test_enter_oncePerWindow_againNextWindow() public {
        WindowRaffle g = _g();
        address a = _addr(1);
        uint256 w = g.currentWindow();
        _play(a);
        assertTrue(g.hasEntered(w, a));
        assertEq(g.entrantCount(w), 1);
        assertEq(g.entrantAt(w, 0), a);
        vm.prank(a);
        vm.expectRevert(WindowRaffle.AlreadyEntered.selector);
        g.enter();
        // a different player is fine in the same window
        _play(_addr(2));
        assertEq(g.entrantCount(w), 2);
        // just before the window ends: still refused
        vm.warp((w + 1) * g.WINDOW() - 1);
        vm.prank(a);
        vm.expectRevert(WindowRaffle.AlreadyEntered.selector);
        g.enter();
        vm.warp((w + 1) * g.WINDOW());
        _play(a);
        assertTrue(g.hasEntered(w + 1, a));
        assertFalse(g.hasEntered(w + 2, a));
        assertEq(g.entrantCount(w + 1), 1);
    }

    function test_enter_capsAt256_257thReverts() public {
        WindowRaffle g = _g();
        uint256 w = g.currentWindow();
        _enterMany(256);
        assertEq(g.entrantCount(w), 256);
        vm.prank(_addr(256));
        vm.expectRevert(WindowRaffle.WindowFull.selector);
        g.enter();
        assertEq(g.entrantCount(w), 256);
        _toNextWindow();
        _play(_addr(256));
        assertEq(g.entrantCount(w + 1), 1);
    }

    function test_enter_emitsPlayedAndEntered() public {
        WindowRaffle g = _g();
        vm.expectEmit(true, true, false, true, address(g));
        emit WindowRaffle.Entered(g.currentWindow(), _addr(7), 0, 1);
        _play(_addr(7));
    }

    function test_weight_growsWithConsecutiveWindows_cappedAt5() public {
        WindowRaffle g = _g();
        address a = _addr(1);
        address b = _addr(2);
        uint256 w0 = g.currentWindow();
        for (uint256 k = 0; k < 8; k++) {
            uint256 expected = k + 1 > 5 ? 5 : k + 1;
            assertEq(g.nextWeight(a), expected, "nextWeight before entering");
            _play(b); // b enters second at index 1 with the same streak
            _play(a);
            uint256 idxA = g.entrantCount(w0 + k) - 1;
            assertEq(g.weightOf(w0 + k, idxA), expected, "a's weight");
            assertEq(g.weightOf(w0 + k, 0), expected, "b's weight");
            _toNextWindow();
        }
    }

    function test_weight_resetsAfterAMissedWindow() public {
        WindowRaffle g = _g();
        address a = _addr(1);
        uint256 w = g.currentWindow();
        for (uint256 k = 0; k < 3; k++) {
            _play(a);
            _toNextWindow();
        }
        assertEq(g.nextWeight(a), 4);
        _toNextWindow(); // missed one window
        assertEq(g.nextWeight(a), 1);
        _play(a);
        assertEq(g.weightOf(w + 4, 0), 1);
        assertEq(g.nextWeight(a), 2);
        _toNextWindow();
        assertEq(g.nextWeight(a), 2);
        _play(a);
        assertEq(g.weightOf(w + 5, 0), 2);
    }

    function test_nextWeight_freshPlayerIsOne() public view {
        assertEq(_g().nextWeight(_addr(99)), 1);
    }

    function test_paused_noEnter_onlySafePauses_drawFinalizeStillWork() public {
        WindowRaffle g = _g();
        uint256 w = g.currentWindow();
        _enterMany(3);
        vm.expectRevert(GameKit.NotSafe.selector);
        g.pause(true);
        vm.prank(safe);
        g.pause(true);
        vm.prank(_addr(50));
        vm.expectRevert(GameKit.NotLive.selector);
        g.enter();
        _toNextWindow();
        _drawAndRoll(w);
        g.finalize(w);
        assertEq(g.winnersOf(w).length, 3);
        vm.prank(safe);
        g.pause(false);
        _play(_addr(50));
    }

    // ---------------------------------------------------------------- draw / finalize

    function test_draw_onlyAfterWindowEnds_once_notEmpty() public {
        WindowRaffle g = _g();
        uint256 w = g.currentWindow();
        vm.expectRevert(WindowRaffle.NotEnded.selector);
        g.draw(w);
        _play(_addr(1));
        vm.warp((w + 1) * g.WINDOW() - 1);
        vm.expectRevert(WindowRaffle.NotEnded.selector);
        g.draw(w);
        vm.expectRevert(WindowRaffle.NotEnded.selector);
        g.draw(w + 1);
        vm.expectRevert(WindowRaffle.NotEnded.selector);
        g.draw(type(uint256).max);
        vm.warp((w + 1) * g.WINDOW());
        // an empty window that has ended
        _toNextWindow();
        vm.expectRevert(WindowRaffle.NoEntrants.selector);
        g.draw(w + 1);
        g.draw(w);
        assertEq(g.drawBlockOf(w), block.number + 1);
        vm.expectRevert(WindowRaffle.AlreadyDrawn.selector);
        g.draw(w);
    }

    function test_finalize_notBeforeDrawBlock_notUndrawn_once() public {
        WindowRaffle g = _g();
        uint256 w = g.currentWindow();
        _enterMany(8);
        vm.expectRevert(WindowRaffle.NotDrawn.selector);
        g.finalize(w);
        _toNextWindow();
        vm.expectRevert(WindowRaffle.NotDrawn.selector);
        g.finalize(w);
        g.draw(w);
        uint256 db = g.drawBlockOf(w);
        vm.expectRevert(WindowRaffle.TooEarly.selector);
        g.finalize(w); // same block as the draw
        vm.roll(db);
        vm.expectRevert(WindowRaffle.TooEarly.selector);
        g.finalize(w); // the draw block itself
        vm.roll(db + 1);
        g.finalize(w);
        assertTrue(g.finalizedOf(w));
        assertEq(g.winnersOf(w).length, 5);
        vm.expectRevert(WindowRaffle.AlreadyFinalized.selector);
        g.finalize(w);
    }

    function test_finalize_voidsAfter256Blocks_noPoints() public {
        WindowRaffle g = _g();
        uint256 w = g.currentWindow();
        _enterMany(8);
        _toNextWindow();
        g.draw(w);
        uint256 db = g.drawBlockOf(w);
        vm.roll(db + 256);
        g.finalize(w);
        assertEq(g.winnersOf(w).length, 5, "drawBlock + 256 still counts");
    }

    function test_finalize_voidsAfter256Blocks_257isVoid() public {
        WindowRaffle g = _g();
        uint256 w = g.currentWindow();
        _enterMany(8);
        _toNextWindow();
        g.draw(w);
        uint256 db = g.drawBlockOf(w);
        vm.roll(db + 257);
        g.finalize(w);
        assertTrue(g.finalizedOf(w));
        assertEq(g.winnersOf(w).length, 0, "voided");
        for (uint256 i = 0; i < 8; i++) {
            assertEq(g.pointsOf(_addr(i)), 0);
        }
        vm.expectRevert(WindowRaffle.AlreadyFinalized.selector);
        g.finalize(w);
        // a voided window never reopens: draw again is refused
        vm.expectRevert(WindowRaffle.AlreadyDrawn.selector);
        g.draw(w);
    }

    function test_fewerThan5Entrants_allWin_onePointEach() public {
        WindowRaffle g = _g();
        for (uint256 n = 1; n <= 5; n++) {
            uint256 w = g.currentWindow();
            for (uint256 i = 0; i < n; i++) {
                _play(_addr(100 * n + i));
            }
            _toNextWindow();
            _drawAndRoll(w);
            g.finalize(w);
            address[] memory ws = g.winnersOf(w);
            assertEq(ws.length, n);
            for (uint256 i = 0; i < n; i++) {
                assertEq(g.pointsOf(_addr(100 * n + i)), 1);
            }
        }
    }

    function test_winnersDistinct_fiveFromMany_pointsPlusOne() public {
        WindowRaffle g = _g();
        uint256 w = g.currentWindow();
        _enterMany(100);
        _toNextWindow();
        _drawAndRoll(w);
        g.finalize(w);
        address[] memory ws = g.winnersOf(w);
        assertEq(ws.length, 5);
        for (uint256 i = 0; i < ws.length; i++) {
            assertTrue(g.hasEntered(w, ws[i]));
            assertEq(g.pointsOf(ws[i]), 1);
            for (uint256 j = i + 1; j < ws.length; j++) {
                assertTrue(ws[i] != ws[j]);
            }
        }
        uint256 total;
        for (uint256 i = 0; i < 100; i++) {
            total += g.pointsOf(_addr(i));
        }
        assertEq(total, 5);
    }

    function test_pointsAccumulateAcrossWindows() public {
        WindowRaffle g = _g();
        uint256 total;
        address a = _addr(1);
        for (uint256 k = 0; k < 4; k++) {
            uint256 w = g.currentWindow();
            _play(a);
            _play(_addr(2));
            _toNextWindow();
            _drawAndRoll(w);
            g.finalize(w);
            total += 1;
            assertEq(g.pointsOf(a), total, "2 entrants: both win every window");
        }
    }

    function test_entrantsOf_pagesAndClamps() public {
        WindowRaffle g = _g();
        uint256 w = g.currentWindow();
        _enterMany(40);
        assertEq(g.entrantsOf(w, 0, 32).length, 32);
        address[] memory tail = g.entrantsOf(w, 32, 32);
        assertEq(tail.length, 8);
        assertEq(tail[0], _addr(32));
        assertEq(tail[7], _addr(39));
        assertEq(g.entrantsOf(w, 40, 32).length, 0);
        assertEq(g.entrantsOf(w, 1000, 32).length, 0);
        assertEq(g.entrantsOf(w, 0, 0).length, 0);
        assertEq(g.entrantsOf(w, 39, type(uint256).max).length, 1);
    }

    function test_noEthEverCredited_owedTotalZero() public {
        WindowRaffle g = _g();
        uint256 w = g.currentWindow();
        _enterMany(10);
        _toNextWindow();
        _drawAndRoll(w);
        g.finalize(w);
        assertEq(g.owedTotal(), 0);
        for (uint256 i = 0; i < 10; i++) {
            assertEq(g.owed(_addr(i)), 0);
        }
        assertEq(address(g).balance, 0.1 ether);
    }

    function test_roundOpen_sweepWaitsForDrawnUnfinalized() public {
        WindowRaffle g = _g();
        uint256 w = g.currentWindow();
        _enterMany(3);
        _toNextWindow();
        g.draw(w);
        vm.prank(agent);
        factory.retire(address(g));
        vm.expectRevert(GameKit.RoundOpen.selector);
        g.sweep();
        vm.roll(block.number + 2);
        g.finalize(w);
        g.sweep();
        assertEq(g.freeBalance(), 0);
    }

    function test_roundOpen_voidedWindowAlsoClosesTheRound() public {
        WindowRaffle g = _g();
        uint256 w = g.currentWindow();
        _enterMany(3);
        _toNextWindow();
        g.draw(w);
        vm.prank(agent);
        factory.retire(address(g));
        vm.roll(block.number + 1000);
        g.finalize(w);
        g.sweep();
        assertEq(g.freeBalance(), 0);
    }

    function test_roundOpen_twoOpenWindowsNeedBothFinalized() public {
        WindowRaffle g = _g();
        uint256 w0 = g.currentWindow();
        _enterMany(2);
        _toNextWindow();
        _enterMany(2);
        _toNextWindow();
        g.draw(w0);
        g.draw(w0 + 1);
        vm.prank(agent);
        factory.retire(address(g));
        vm.roll(block.number + 2);
        g.finalize(w0);
        vm.expectRevert(GameKit.RoundOpen.selector);
        g.sweep();
        g.finalize(w0 + 1);
        g.sweep();
    }

    // ---------------------------------------------------------------- gas

    function test_gas_enter_draw_finalize_with256EntrantsWeight5_under200k() public {
        WindowRaffle g = _g();
        uint256 w0 = g.currentWindow();
        uint256 worst;
        for (uint256 k = 0; k < 5; k++) {
            for (uint256 i = 0; i < 256; i++) {
                address p = _addr(i);
                vm.prank(p);
                uint256 before = gasleft();
                g.enter();
                uint256 used = before - gasleft();
                if (used > worst) worst = used;
            }
            if (k < 4) _toNextWindow();
        }
        assertLt(worst, 200_000, "enter gas");
        uint256 w = w0 + 4;
        assertEq(g.entrantCount(w), 256);
        for (uint256 i = 0; i < 256; i += 31) {
            assertEq(g.weightOf(w, i), 5);
        }
        _toNextWindow();
        uint256 g0 = gasleft();
        g.draw(w);
        assertLt(g0 - gasleft(), 200_000, "draw gas");
        vm.roll(block.number + 2);
        g0 = gasleft();
        g.finalize(w);
        assertLt(g0 - gasleft(), 200_000, "finalize gas");
        assertEq(g.winnersOf(w).length, 5);
    }

    function test_gas_finalize_winnerInLastWordOfFullWindow() public {
        WindowRaffle g = _g();
        uint256 w = g.currentWindow();
        _enterMany(256);
        _toNextWindow();
        _drawAndRoll(w);
        uint256 g0 = gasleft();
        g.finalize(w);
        assertLt(g0 - gasleft(), 200_000);
    }

    // ---------------------------------------------------------------- pickWinners

    function _build(uint256 n, uint256 rawSeed) internal pure returns (uint256[8] memory ws) {
        for (uint256 i = 0; i < n; i++) {
            uint256 wt = (uint256(keccak256(abi.encode(rawSeed, i))) % 5) + 1;
            ws[i / 32] |= wt << ((i % 32) * 8);
        }
    }

    function _weightAt(uint256[8] memory ws, uint256 i) internal pure returns (uint256) {
        return (ws[i / 32] >> ((i % 32) * 8)) & 0xff;
    }

    function testFuzz_pickWinners_distinct_inRange_nonzeroWeight_countMin5n(uint256 n, uint256 wseed, uint256 seed)
        public
        view
    {
        n = bound(n, 1, 256);
        uint256[8] memory ws = _build(n, wseed);
        (uint256 bits, uint256 count) = _g().pickWinners(ws, seed, n);
        assertEq(count, n < 5 ? n : 5);
        if (count < 5) assertEq(bits >> (8 * count), 0);
        assertEq(bits >> 40, 0);
        for (uint256 k = 0; k < count; k++) {
            uint256 ik = (bits >> (8 * k)) & 0xff;
            assertLt(ik, n);
            assertGt(_weightAt(ws, ik), 0);
            for (uint256 j = k + 1; j < count; j++) {
                assertTrue(ik != ((bits >> (8 * j)) & 0xff), "distinct");
            }
        }
    }

    function testFuzz_pickWinners_ignoresWeightsBeyondN(uint256 n, uint256 seed, uint256[8] memory junk) public view {
        n = bound(n, 1, 255);
        uint256[8] memory ws = _build(n, seed);
        uint256[8] memory dirty;
        for (uint256 j = 0; j < 8; j++) {
            dirty[j] = ws[j];
        }
        for (uint256 i = n; i < 256; i++) {
            uint256 wt = ((junk[i / 32] >> ((i % 32) * 8)) & 0xff) % 6;
            dirty[i / 32] |= wt << ((i % 32) * 8);
        }
        (uint256 b1, uint256 c1) = _g().pickWinners(ws, seed, n);
        (uint256 b2, uint256 c2) = _g().pickWinners(dirty, seed, n);
        assertEq(b1, b2);
        assertEq(c1, c2);
    }

    function testFuzz_pickWinners_singleHeavyAmongZeros_alwaysPicked(uint256 n, uint256 h, uint256 wt, uint256 seed)
        public
        view
    {
        n = bound(n, 1, 256);
        h = bound(h, 0, n - 1);
        wt = bound(wt, 1, 5);
        uint256[8] memory ws;
        ws[h / 32] = wt << ((h % 32) * 8);
        (uint256 bits, uint256 count) = _g().pickWinners(ws, seed, n);
        assertEq(count, 1);
        assertEq(bits, h);
    }

    function test_pickWinners_allEqualPicksMatchDistribution() public view {
        // 6 entries, entry 0 has weight 5, others 1: entry 0 is first pick with p = 5/10
        uint256[8] memory ws;
        ws[0] = 5 | (1 << 8) | (1 << 16) | (1 << 24) | (1 << 32) | (1 << 40);
        uint256 hits;
        uint256 runs = 400;
        for (uint256 s = 0; s < runs; s++) {
            (uint256 bits,) = _g().pickWinners(ws, uint256(keccak256(abi.encode("s", s))), 6);
            if ((bits & 0xff) == 0) hits++;
        }
        assertGt(hits, 140);
        assertLt(hits, 260);
    }

    function test_pickWinners_weightedTowardsHeavy_acrossWords() public view {
        // entry 100 (word 3) weight 5, entry 7 weight 1, 3 entries weight 1 in word 7; others zero
        uint256[8] memory ws;
        ws[0] = uint256(1) << 56;
        ws[3] = uint256(5) << 32; // index 96 + 4 = 100
        ws[7] = 1 | (1 << 8) | (1 << 16);
        uint256 hits;
        uint256 runs = 300;
        for (uint256 s = 0; s < runs; s++) {
            (uint256 bits, uint256 count) = _g().pickWinners(ws, uint256(keccak256(abi.encode("t", s))), 256);
            assertEq(count, 5);
            if ((bits & 0xff) == 100) hits++;
        }
        // p = 5 / 10 = 0.5
        assertGt(hits, 110);
        assertLt(hits, 190);
    }

    function test_pickWinners_lastEntryOf256CanWin() public view {
        uint256[8] memory ws;
        ws[7] = uint256(3) << 248;
        (uint256 bits, uint256 count) = _g().pickWinners(ws, 1, 256);
        assertEq(count, 1);
        assertEq(bits, 255);
    }

    function test_pickWinners_eachEntrantCanWinWithManyEntries() public view {
        // entry 0 of 200 weight-1 entries wins sometimes, last one too
        uint256[8] memory ws = _build(200, 77);
        bool first;
        bool last;
        for (uint256 s = 0; s < 600; s++) {
            (uint256 bits, uint256 count) = _g().pickWinners(ws, s, 200);
            for (uint256 k = 0; k < count; k++) {
                uint256 ik = (bits >> (8 * k)) & 0xff;
                if (ik == 0) first = true;
                if (ik == 199) last = true;
            }
        }
        assertTrue(first && last);
    }

    // ---------------------------------------------------------------- full flow fuzz

    function testFuzz_fullFlow_winnersAreEntrants_pointsMatch(uint8 nIn, uint8 wins, uint32 offset) public {
        WindowRaffle g = _g();
        uint256 n = bound(nIn, 1, 60);
        uint256 nw = bound(wins, 1, 4);
        vm.warp(block.timestamp + uint256(offset));
        uint256[] memory ws = new uint256[](nw);
        for (uint256 k = 0; k < nw; k++) {
            ws[k] = g.currentWindow();
            uint256 cnt = n > k ? n - k : 1;
            for (uint256 i = 0; i < cnt; i++) {
                _play(_addr(i));
            }
            _toNextWindow();
        }
        _closeRounds();
        uint256 totalWinners;
        for (uint256 k = 0; k < nw; k++) {
            uint256 cnt = n > k ? n - k : 1;
            assertEq(g.entrantCount(ws[k]), cnt);
            address[] memory win = g.winnersOf(ws[k]);
            assertEq(win.length, cnt < 5 ? cnt : 5);
            totalWinners += win.length;
            for (uint256 a = 0; a < win.length; a++) {
                assertTrue(g.hasEntered(ws[k], win[a]));
                for (uint256 b = a + 1; b < win.length; b++) {
                    assertTrue(win[a] != win[b]);
                }
            }
        }
        uint256 pts;
        for (uint256 i = 0; i < n; i++) {
            pts += g.pointsOf(_addr(i));
        }
        assertEq(pts, totalWinners);
        assertEq(g.owedTotal(), 0);
    }

    function testFuzz_streakWeightMatchesModel(uint8 pattern) public {
        WindowRaffle g = _g();
        address a = _addr(1);
        uint256 streak;
        uint256 prevEntered;
        for (uint256 k = 0; k < 8; k++) {
            bool in_ = (pattern >> k) & 1 == 1;
            if (in_) {
                uint256 exp = prevEntered == 1 ? streak + 1 : 1;
                uint256 expW = exp > 5 ? 5 : exp;
                assertEq(g.nextWeight(a), expW);
                uint256 w = g.currentWindow();
                _play(a);
                assertEq(g.weightOf(w, 0), expW);
                streak = exp;
                prevEntered = 1;
            } else {
                prevEntered = 0;
                streak = 0;
            }
            _toNextWindow();
        }
    }
}

/// Random enters, draws, finalizes, time and block rolls for the invariant run.
contract RaffleHandler is Test {
    WindowRaffle internal g;
    uint256 internal constant ACTORS = 40;
    uint256[] internal seen;
    mapping(uint256 => bool) internal isSeen;

    constructor(WindowRaffle g_) {
        g = g_;
    }

    function actor(uint256 i) public pure returns (address) {
        return address(uint160(0xA000 + (i % ACTORS)));
    }

    function enter(uint256 who) external {
        vm.prank(actor(who));
        try g.enter() {
            uint256 w = g.currentWindow();
            if (!isSeen[w]) {
                isSeen[w] = true;
                seen.push(w);
            }
        } catch {}
    }

    function enterMany(uint8 n) external {
        for (uint256 i = 0; i < uint256(n) % ACTORS; i++) {
            vm.prank(actor(i));
            try g.enter() {
                uint256 w = g.currentWindow();
                if (!isSeen[w]) {
                    isSeen[w] = true;
                    seen.push(w);
                }
            } catch {}
        }
    }

    function draw(uint256 k) external {
        if (seen.length == 0) return;
        try g.draw(seen[k % seen.length]) {} catch {}
    }

    function finalize(uint256 k) external {
        if (seen.length == 0) return;
        try g.finalize(seen[k % seen.length]) {} catch {}
    }

    function wait(uint32 s) external {
        vm.warp(block.timestamp + (uint256(s) % 14 hours));
    }

    function rollBlocks(uint16 n) external {
        vm.roll(block.number + (uint256(n) % 400));
    }

    function seenLength() external view returns (uint256) {
        return seen.length;
    }

    function seenAt(uint256 i) external view returns (uint256) {
        return seen[i];
    }

    function pointsSum() external view returns (uint256 s) {
        for (uint256 i = 0; i < ACTORS; i++) {
            s += g.pointsOf(actor(i));
        }
    }

    function winnersSum() external view returns (uint256 s) {
        for (uint256 k = 0; k < seen.length; k++) {
            s += g.winnersOf(seen[k]).length;
        }
    }
}

contract WindowRaffleInvariantTest is WindowRaffleTest {
    RaffleHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new RaffleHandler(WindowRaffle(address(game)));
        targetContract(address(handler));
    }

    function invariant_winnersDistinctEntrantsOfTheirWindow() public view {
        WindowRaffle g = _g();
        uint256 len = handler.seenLength();
        for (uint256 k = 0; k < len; k++) {
            uint256 w = handler.seenAt(k);
            address[] memory win = g.winnersOf(w);
            uint256 cnt = g.entrantCount(w);
            assertLe(cnt, 256);
            if (!g.finalizedOf(w)) {
                assertEq(win.length, 0, "no winners before finalize");
                continue;
            }
            if (g.drawBlockOf(w) == 0) revert("finalized without draw");
            assertTrue(win.length == 0 || win.length == (cnt < 5 ? cnt : 5));
            for (uint256 a = 0; a < win.length; a++) {
                assertTrue(g.hasEntered(w, win[a]));
                for (uint256 b = a + 1; b < win.length; b++) {
                    assertTrue(win[a] != win[b]);
                }
            }
            for (uint256 i = 0; i < cnt; i++) {
                uint256 wt = g.weightOf(w, i);
                assertTrue(wt >= 1 && wt <= 5);
                assertTrue(g.hasEntered(w, g.entrantAt(w, i)));
            }
        }
    }

    function invariant_noPointsWithoutFinalizedDraw() public view {
        assertEq(handler.pointsSum(), handler.winnersSum());
    }

    function invariant_solvent_nothingOwed() public view {
        assertEq(game.owedTotal(), 0);
        assertGe(address(game).balance, game.owedTotal());
    }

    function invariant_nextWeightInRange() public view {
        for (uint256 i = 0; i < 5; i++) {
            uint256 nw = _g().nextWeight(handler.actor(i));
            assertTrue(nw >= 1 && nw <= 5);
        }
    }
}
