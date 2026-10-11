// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {GameKitConformance} from "../GameKitConformance.sol";
import {Example} from "../../../src/games/example/Example.sol";

contract ExampleTest is GameKitConformance {
    function _creationCode() internal pure override returns (bytes memory) {
        return type(Example).creationCode;
    }

    function _play(address player) internal override {
        Example g = Example(address(game));
        if (g.deadline() != 0 && block.timestamp >= g.deadline()) g.settle();
        vm.prank(player);
        g.click();
    }

    function _closeRounds() internal override {
        Example g = Example(address(game));
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

    function test_noClickAfterTheRoundRanOut_untilSettled() public {
        Example g = Example(address(game));
        _play(makeAddr("a"));
        vm.warp(g.deadline());
        vm.prank(makeAddr("b"));
        vm.expectRevert(Example.RoundOver.selector);
        g.click();
        vm.warp(g.deadline() - 1);
        vm.expectRevert(Example.RoundRunning.selector);
        g.settle();
    }

    function testFuzz_prizeNeverExceedsTheFreeBalance(uint8 rounds) public {
        for (uint256 r; r < uint256(rounds) % 40; ++r) {
            _play(address(uint160(0x1000 + r)));
            _closeRounds();
            assertGe(address(game).balance, game.owedTotal());
        }
    }
}

/// Random clicks, settles, claims and time for the invariant run.
contract ExampleHandler is Test {
    Example internal g;
    address[4] internal actors = [address(0xA1), address(0xA2), address(0xA3), address(0xA4)];

    constructor(Example g_) {
        g = g_;
    }

    function click(uint256 who) external {
        if (g.deadline() != 0 && block.timestamp >= g.deadline()) g.settle();
        vm.prank(actors[who % 4]);
        g.click();
    }

    function settle() external {
        if (g.deadline() != 0 && block.timestamp >= g.deadline()) g.settle();
    }

    function claim(uint256 who) external {
        address a = actors[who % 4];
        if (g.owed(a) == 0) return;
        vm.prank(a);
        g.claim();
    }

    function wait(uint32 s) external {
        skip(uint256(s) % 2 hours);
    }

    function owedSum() external view returns (uint256 sum) {
        for (uint256 i; i < 4; ++i) {
            sum += g.owed(actors[i]);
        }
    }
}

/// The invariant run on the game the conformance setUp deployed and funded through the real factory: a game's tests
/// import only the kit, the suite, forge-std and the game's own files, so they never build a factory themselves.
contract ExampleInvariantTest is ExampleTest {
    ExampleHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new ExampleHandler(Example(address(game)));
        targetContract(address(handler));
    }

    function invariant_solventAndOwedAddsUp() public view {
        assertGe(address(game).balance, game.owedTotal());
        assertEq(handler.owedSum(), game.owedTotal());
    }
}
