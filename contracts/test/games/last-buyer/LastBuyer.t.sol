// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {GameKit} from "../../../src/games/GameKit.sol";
import {GameKitConformance} from "../GameKitConformance.sol";
import {LastBuyer} from "../../../src/games/last-buyer/LastBuyer.sol";

contract LastBuyerTest is GameKitConformance {
    LastBuyer internal g;
    BuyerHandler internal handler;

    function setUp() public override {
        super.setUp();
        g = LastBuyer(address(game));
        handler = new BuyerHandler(g);
        targetContract(address(handler));
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(LastBuyer).creationCode;
    }

    function _play(address player) internal override {
        if (g.startedAt() != 0 && block.timestamp >= g.endsAt()) g.settle();
        vm.prank(player);
        g.play();
    }

    function _closeRounds() internal override {
        if (g.startedAt() == 0) return;
        if (block.timestamp < g.endsAt()) vm.warp(g.endsAt());
        g.settle();
    }

    function test_params_inBounds() public view {
        assertGe(g.COUNTDOWN(), 10 minutes);
        assertLe(g.COUNTDOWN(), 1 days);
        assertGe(g.MIN_ROUND(), g.COUNTDOWN());
        assertLe(g.MIN_ROUND(), 7 days);
        assertGe(g.PRIZE_BPS(), 100);
        assertLe(g.PRIZE_BPS(), 2000);
    }

    function test_theLastPlayerIsOwedTheShare() public {
        address a = makeAddr("a");
        address b = makeAddr("b");
        _play(a);
        _play(b);
        uint256 prize = (game.freeBalance() * g.PRIZE_BPS()) / 10_000;
        _closeRounds();
        assertEq(game.owed(b), prize);
        assertEq(game.owed(a), 0);
        assertEq(g.leader(), address(0));
        assertEq(g.startedAt(), 0);
        assertEq(g.endsAt(), 0);
    }

    function test_aRoundLastsAtLeastMinRound() public {
        uint256 t0 = block.timestamp;
        _play(makeAddr("a"));
        assertEq(g.startedAt(), t0);
        assertEq(g.endsAt(), t0 + g.MIN_ROUND(), "an early play: the round's floor");
        vm.warp(t0 + g.MIN_ROUND() - 1);
        vm.expectRevert(LastBuyer.RoundRunning.selector);
        g.settle();
    }

    function test_aLatePlayGivesAFullCountdown_noFixedEnd() public {
        uint256 t0 = block.timestamp;
        _play(makeAddr("a"));
        uint256 late = t0 + g.MIN_ROUND() - 1;
        vm.warp(late);
        _play(makeAddr("b"));
        assertEq(g.endsAt(), late + g.COUNTDOWN(), "a play in the last second restarts the whole countdown");
        assertEq(g.startedAt(), t0, "the round keeps its start");
        vm.warp(late + g.COUNTDOWN() - 1);
        _play(makeAddr("c"));
        assertEq(g.leader(), makeAddr("c"));
        assertEq(g.endsAt(), late + 2 * g.COUNTDOWN() - 1);
    }

    function test_noPlayOnceTheRoundEnded_untilSettled() public {
        _play(makeAddr("a"));
        vm.warp(g.endsAt());
        vm.prank(makeAddr("b"));
        vm.expectRevert(LastBuyer.RoundOver.selector);
        g.play();
        g.settle();
        vm.prank(makeAddr("b"));
        g.play();
        assertEq(g.startedAt(), block.timestamp, "a new round");
    }

    function test_settle_needsAnEndedRound() public {
        vm.expectRevert(LastBuyer.RoundRunning.selector);
        g.settle();
        _play(makeAddr("a"));
        vm.warp(g.endsAt() - 1);
        vm.expectRevert(LastBuyer.RoundRunning.selector);
        g.settle();
        vm.warp(g.endsAt());
        g.settle();
    }

    function test_paused_noPlay_noSettle() public {
        _play(makeAddr("a"));
        vm.warp(g.endsAt());
        vm.prank(safe);
        game.pause(true);
        vm.expectRevert(GameKit.NotLive.selector);
        g.settle();
        vm.prank(makeAddr("b"));
        vm.expectRevert(GameKit.NotLive.selector);
        g.play();
    }

    function test_sweepWaitsForTheOpenRound() public {
        _play(makeAddr("a"));
        vm.prank(agent);
        factory.retire(address(game));
        vm.expectRevert(GameKit.RoundOpen.selector);
        game.sweep();
    }

    /// However the plays fall, a prize is paid at most once per MIN_ROUND.
    function testFuzz_atMostOnePrizePerMinRound(uint32[8] memory gaps) public {
        uint256 start = block.timestamp;
        uint256 prizes;
        for (uint256 i; i < gaps.length; ++i) {
            skip(uint256(gaps[i]) % (2 * g.MIN_ROUND()));
            if (g.startedAt() != 0 && block.timestamp >= g.endsAt()) {
                g.settle();
                ++prizes;
            }
            _play(address(uint160(0x1000 + i)));
            _assertSolvent();
        }
        assertLe(prizes, (block.timestamp - start) / g.MIN_ROUND());
    }

    function invariant_solvent_andARoundEndsNoSoonerThanItsFloor() public view {
        _assertSolvent();
        assertEq(handler.owedSum(), game.owedTotal());
        if (g.startedAt() != 0) assertGe(g.endsAt(), g.startedAt() + g.MIN_ROUND());
    }
}

/// Random plays, settles, claims and time for the invariant run (every call may fail).
contract BuyerHandler is Test {
    LastBuyer internal g;
    address[4] internal actors = [address(0xA1), address(0xA2), address(0xA3), address(0xA4)];

    constructor(LastBuyer g_) {
        g = g_;
    }

    function play(uint256 who) external {
        vm.prank(actors[who % 4]);
        try g.play() {} catch {}
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
        skip(uint256(s) % 2 days);
    }

    function owedSum() external view returns (uint256 sum) {
        for (uint256 i; i < 4; ++i) {
            sum += g.owed(actors[i]);
        }
    }
}
