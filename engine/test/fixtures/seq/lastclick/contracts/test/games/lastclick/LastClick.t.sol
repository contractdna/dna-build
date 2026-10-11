// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {GameKitConformance} from "../GameKitConformance.sol";
import {LastClick} from "../../../src/games/lastclick/LastClick.sol";

contract LastClickTest is GameKitConformance {
    function _creationCode() internal pure override returns (bytes memory) {
        return type(LastClick).creationCode;
    }

    function _play(address player) internal override {
        LastClick g = LastClick(address(game));
        if (g.deadline() != 0 && block.timestamp >= g.deadline()) g.settle();
        vm.prank(player);
        g.click();
    }

    function _closeRounds() internal override {
        LastClick g = LastClick(address(game));
        if (g.deadline() == 0) return;
        if (block.timestamp < g.deadline()) vm.warp(g.deadline());
        g.settle();
    }

    function test_lastClickerIsOwedTenPercent() public {
        address a = makeAddr("a");
        address b = makeAddr("b");
        _play(a);
        _play(b);
        _closeRounds();
        assertEq(game.owed(b), 0.01 ether);
        assertEq(game.owed(a), 0);
    }

    function test_clickExtendsTheRound_settleWaitsForTheDeadline() public {
        LastClick g = LastClick(address(game));
        _play(makeAddr("a"));
        assertEq(g.deadline(), block.timestamp + 1 hours);
        skip(1 hours - 1);
        vm.expectRevert(LastClick.RoundRunning.selector);
        g.settle();
        _play(makeAddr("b"));
        assertEq(g.deadline(), block.timestamp + 1 hours);
        assertEq(g.leader(), makeAddr("b"));
        skip(1 hours);
        vm.prank(makeAddr("c"));
        vm.expectRevert(LastClick.RoundOver.selector);
        g.click();
        g.settle();
        assertEq(g.deadline(), 0);
        assertEq(g.leader(), address(0));
    }

    function testFuzz_prizeIsTenPercentOfTheFreeBalance(uint64 extra) public {
        vm.deal(funder, uint256(extra) + 1 ether);
        vm.prank(funder);
        game.fund{value: extra}();
        uint256 free = game.freeBalance();
        address p = makeAddr("p");
        _play(p);
        _closeRounds();
        assertEq(game.owed(p), (free * 1000) / 10_000);
    }
}

contract LastClickHandler is Test {
    LastClick internal g;
    address[3] internal actors = [address(0xB1), address(0xB2), address(0xB3)];

    constructor(LastClick g_) {
        g = g_;
    }

    function click(uint256 who) external {
        if (g.deadline() != 0 && block.timestamp >= g.deadline()) g.settle();
        vm.prank(actors[who % 3]);
        g.click();
    }

    function settle() external {
        if (g.deadline() != 0 && block.timestamp >= g.deadline()) g.settle();
    }

    function claim(uint256 who) external {
        address a = actors[who % 3];
        if (g.owed(a) == 0) return;
        vm.prank(a);
        g.claim();
    }

    function wait(uint32 s) external {
        skip(uint256(s) % 2 hours);
    }

    function owedSum() external view returns (uint256 s) {
        for (uint256 i; i < 3; ++i) {
            s += g.owed(actors[i]);
        }
    }
}

contract LastClickInvariantTest is LastClickTest {
    LastClickHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new LastClickHandler(LastClick(address(game)));
        targetContract(address(handler));
    }

    function invariant_solventAndOwedAddsUp() public view {
        assertGe(address(game).balance, game.owedTotal());
        assertEq(handler.owedSum(), game.owedTotal());
    }
}
