// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {GameKit} from "../../../src/games/GameKit.sol";
import {GameKitConformance} from "../GameKitConformance.sol";
import {DailyCheckin} from "../../../src/games/daily-checkin/DailyCheckin.sol";

contract DailyCheckinTest is GameKitConformance {
    DailyCheckin internal g;
    CheckinHandler internal handler;
    /// days the conformance plays checked in on, and who, until _closeRounds settles them
    uint256[] internal pending;
    mapping(uint256 day => address[]) internal players;

    function setUp() public override {
        super.setUp();
        g = DailyCheckin(address(game));
        handler = new CheckinHandler(g);
        targetContract(address(handler));
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(DailyCheckin).creationCode;
    }

    function _play(address player) internal override {
        vm.prank(player);
        g.checkIn();
        uint256 d = g.today();
        if (players[d].length == 0) pending.push(d);
        players[d].push(player);
    }

    /// Ends every day played on, settles it, and collects every share still in its window (else releases it).
    function _closeRounds() internal override {
        if (pending.length == 0) return;
        uint256 last = pending[pending.length - 1];
        if (g.today() <= last) vm.warp((last + 1) * 1 days);
        for (uint256 i; i < pending.length; ++i) {
            uint256 d = pending[i];
            if (!_day(d).settled) g.settle(d);
            bool open = block.timestamp < (d + 1 + g.COLLECT_DAYS()) * 1 days;
            for (uint256 j; open && j < players[d].length; ++j) {
                address p = players[d][j];
                if (g.statusOf(d, p) == 2) continue;
                vm.prank(p);
                g.collect(d);
            }
            if (!open && _day(d).left > 0) g.release(d);
            delete players[d];
        }
        delete pending;
    }

    function _day(uint256 d) internal view returns (DailyCheckin.Day memory x) {
        (x.checkins, x.settled, x.each, x.left) = g.dayOf(d);
    }

    function _checkIn(address p) internal {
        vm.prank(p);
        g.checkIn();
    }

    function _collect(address p, uint256 day) internal {
        vm.prank(p);
        g.collect(day);
    }

    function test_params_inBounds() public view {
        assertGe(g.SHARE_BPS(), 10);
        assertLe(g.SHARE_BPS(), 500);
        assertGe(g.COLLECT_DAYS(), 1);
        assertLe(g.COLLECT_DAYS(), 6);
    }

    function test_oneCheckInPerAddressPerDay() public {
        address a = makeAddr("a");
        _checkIn(a);
        vm.prank(a);
        vm.expectRevert(DailyCheckin.AlreadyCheckedIn.selector);
        g.checkIn();
        skip(1 days);
        _checkIn(a);
        assertEq(_day(g.today() - 1).checkins, 1);
        assertEq(_day(g.today()).checkins, 1);
    }

    function test_aDayIsOpenOnceWhateverItsCheckIns() public {
        _checkIn(makeAddr("a"));
        _checkIn(makeAddr("b"));
        assertEq(g.openDays(), 1);
        skip(1 days);
        _checkIn(makeAddr("a"));
        assertEq(g.openDays(), 2);
        g.settle(g.today() - 1);
        assertEq(g.openDays(), 1);
    }

    function test_settle_onlyAfterTheDay_once_andNotAnEmptyDay() public {
        _checkIn(makeAddr("a"));
        uint256 d = g.today();
        vm.expectRevert(DailyCheckin.DayNotOver.selector);
        g.settle(d);
        vm.warp((d + 1) * 1 days - 1);
        vm.expectRevert(DailyCheckin.DayNotOver.selector);
        g.settle(d);
        vm.warp((d + 1) * 1 days);
        g.settle(d);
        vm.expectRevert(DailyCheckin.AlreadySettled.selector);
        g.settle(d);
        vm.warp((d + 2) * 1 days);
        vm.expectRevert(DailyCheckin.NoCheckins.selector);
        g.settle(d + 1);
    }

    function test_settle_splitsTheShareOfWhatIsNotSetAside() public {
        address a = makeAddr("a");
        address b = makeAddr("b");
        _checkIn(a);
        _checkIn(b);
        uint256 d1 = g.today();
        skip(1 days);
        _checkIn(a);
        uint256 d2 = g.today();
        skip(1 days);
        uint256 free = game.freeBalance();
        g.settle(d1);
        uint256 each1 = (free * g.SHARE_BPS()) / 10_000 / 2;
        assertEq(_day(d1).each, each1);
        assertEq(g.reserved(), each1 * 2);
        g.settle(d2);
        uint256 each2 = ((free - each1 * 2) * g.SHARE_BPS()) / 10_000;
        assertEq(_day(d2).each, each2, "the second day splits only what the first left");
        assertEq(g.reserved(), each1 * 2 + each2);
        assertEq(game.owedTotal(), 0, "settling owes nobody yet");
    }

    function test_collect_creditsTheShare_settlingFirst_once() public {
        address a = makeAddr("a");
        address b = makeAddr("b");
        _checkIn(a);
        _checkIn(b);
        uint256 d = g.today();
        skip(1 days);
        uint256 each = (game.freeBalance() * g.SHARE_BPS()) / 10_000 / 2;
        _collect(a, d);
        assertTrue(_day(d).settled, "the first collect settles the day");
        assertEq(game.owed(a), each);
        assertEq(_day(d).left, each);
        assertEq(g.reserved(), each);
        vm.prank(a);
        vm.expectRevert(DailyCheckin.AlreadyCollected.selector);
        g.collect(d);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(DailyCheckin.NotCheckedIn.selector);
        g.collect(d);
        _collect(b, d);
        assertEq(_day(d).left, 0);
        assertEq(g.reserved(), 0);
        uint256 before = a.balance;
        vm.prank(a);
        game.claim();
        assertEq(a.balance, before + each);
    }

    function test_collect_closesAfterItsWindow_thenTheRestIsReleased() public {
        address a = makeAddr("a");
        address b = makeAddr("b");
        _checkIn(a);
        _checkIn(b);
        uint256 d = g.today();
        uint256 end = (d + 1 + g.COLLECT_DAYS()) * 1 days;
        vm.warp(end - 1);
        vm.expectRevert(DailyCheckin.CollectOpen.selector);
        g.release(d);
        _collect(a, d);
        vm.warp(end);
        vm.prank(b);
        vm.expectRevert(DailyCheckin.CollectClosed.selector);
        g.collect(d);
        uint256 rest = _day(d).left;
        assertGt(rest, 0);
        g.release(d);
        assertEq(_day(d).left, 0);
        assertEq(g.reserved(), 0);
        vm.expectRevert(DailyCheckin.NothingLeft.selector);
        g.release(d);
    }

    function test_paused_noCheckIn_noSettle_noCollect() public {
        address a = makeAddr("a");
        _checkIn(a);
        uint256 d = g.today();
        skip(1 days);
        vm.prank(safe);
        game.pause(true);
        vm.prank(makeAddr("b"));
        vm.expectRevert(GameKit.NotLive.selector);
        g.checkIn();
        vm.expectRevert(GameKit.NotLive.selector);
        g.settle(d);
        vm.prank(safe);
        game.pause(false);
        g.settle(d);
        vm.prank(safe);
        game.pause(true);
        vm.prank(a);
        vm.expectRevert(GameKit.NotLive.selector);
        g.collect(d);
    }

    function test_sweepWaitsForSharesSetAside() public {
        address a = makeAddr("a");
        _checkIn(a);
        uint256 d = g.today();
        skip(1 days);
        g.settle(d);
        assertEq(g.openDays(), 0);
        assertGt(g.reserved(), 0);
        vm.prank(agent);
        factory.retire(address(game));
        vm.expectRevert(GameKit.RoundOpen.selector);
        game.sweep();
        _collect(a, d);
        game.sweep();
        assertEq(game.freeBalance(), 0);
        assertGt(game.owed(a), 0, "the share stays claimable");
    }

    function testFuzz_aDayNeverPaysMoreThanItsShare(uint8 n, uint8 collectors) public {
        uint256 count = uint256(n) % 40 + 1;
        for (uint256 i; i < count; ++i) {
            _checkIn(address(uint160(0x1000 + i)));
        }
        uint256 d = g.today();
        skip(1 days);
        uint256 free = game.freeBalance();
        g.settle(d);
        uint256 c = uint256(collectors) % (count + 1);
        for (uint256 i; i < c; ++i) {
            _collect(address(uint160(0x1000 + i)), d);
        }
        assertLe(game.owedTotal() + g.reserved(), (free * g.SHARE_BPS()) / 10_000);
        assertEq(game.owedTotal() + _day(d).left, _day(d).each * count);
        _assertSolvent();
    }

    function invariant_solventAndSetAsideAddsUp() public view {
        _assertSolvent();
        assertEq(handler.owedSum(), game.owedTotal(), "only players are owed");
        assertEq(handler.leftSum(), g.reserved(), "what is set aside is what the days still hold");
        assertLe(g.reserved(), game.freeBalance(), "never more set aside than the game holds");
    }
}

/// Random check-ins, settles, collects, releases, claims and time for the invariant run (every call may fail).
contract CheckinHandler is Test {
    DailyCheckin internal g;
    address[4] internal actors = [address(0xA1), address(0xA2), address(0xA3), address(0xA4)];
    uint256[] internal seen;
    mapping(uint256 day => bool) internal known;

    constructor(DailyCheckin g_) {
        g = g_;
    }

    function checkIn(uint256 who) external {
        vm.prank(actors[who % 4]);
        try g.checkIn() {
            uint256 d = g.today();
            if (!known[d]) {
                known[d] = true;
                seen.push(d);
            }
        } catch {}
    }

    function settle(uint256 back) external {
        try g.settle(_day(back)) {} catch {}
    }

    function collect(uint256 who, uint256 back) external {
        vm.prank(actors[who % 4]);
        try g.collect(_day(back)) {} catch {}
    }

    function release(uint256 back) external {
        try g.release(_day(back)) {} catch {}
    }

    function claim(uint256 who) external {
        address a = actors[who % 4];
        if (g.owed(a) == 0) return;
        vm.prank(a);
        g.claim();
    }

    function pass(uint32 s) external {
        skip(uint256(s) % 3 days);
    }

    function owedSum() external view returns (uint256 sum) {
        for (uint256 i; i < 4; ++i) {
            sum += g.owed(actors[i]);
        }
    }

    function leftSum() external view returns (uint256 sum) {
        for (uint256 i; i < seen.length; ++i) {
            (,,, uint120 left) = g.dayOf(seen[i]);
            sum += left;
        }
    }

    function _day(uint256 back) internal view returns (uint256) {
        uint256 t = g.today();
        return t - (back % (t < 8 ? t + 1 : 8));
    }
}
