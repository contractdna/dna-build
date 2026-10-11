// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockAgentRegistry} from "./GameKitConformance.sol";
import {GameFactory} from "../../src/games/GameFactory.sol";
import {GameKit} from "../../src/games/GameKit.sol";

/// A game that exposes the kit's internals.
contract KitHarness is GameKit {
    bool public open;
    bool public openReverts;

    function play(uint256 v) external whenLive {
        _played(v);
    }

    function playUnguarded() external {
        _played(0);
    }

    function credit(address to, uint256 amount) external {
        _credit(to, amount);
    }

    function setOpen(bool o) external {
        open = o;
    }

    function setOpenReverts(bool r) external {
        openReverts = r;
    }

    function _roundOpen() internal view override returns (bool) {
        if (openReverts) revert("no answer");
        return open;
    }
}

/// A claimant that refuses ETH.
contract Refuser {
    function claim(GameKit g) external {
        g.claim();
    }
}

contract GameKitTest is Test {
    address safe = makeAddr("safe");
    address agent = makeAddr("agent");
    address funder = makeAddr("funder");
    GameFactory factory;
    KitHarness game;

    function setUp() public {
        factory = new GameFactory(safe, new MockAgentRegistry(agent));
        vm.prank(safe);
        factory.setFunder(funder);
        vm.prank(agent);
        game = KitHarness(factory.deploy(type(KitHarness).creationCode, 0));
        vm.deal(funder, 10 ether);
        vm.prank(funder);
        game.fund{value: 1 ether}();
    }

    function test_constructor_remembersTheFactoryAndItsSafe() public view {
        assertEq(address(game.factory()), address(factory));
        assertEq(game.safe(), safe);
    }

    function test_constructor_refusesADeployerThatIsNotAFactory() public {
        vm.expectRevert();
        new KitHarness(); // msg.sender (this test) has no safe()
    }

    function test_fund_onlyTheCurrentFunder_readLive() public {
        vm.prank(safe);
        vm.expectRevert(GameKit.NotFunder.selector);
        game.fund{value: 0}();
        address next = makeAddr("next funder");
        vm.prank(safe);
        factory.setFunder(next);
        vm.prank(funder);
        vm.expectRevert(GameKit.NotFunder.selector);
        game.fund{value: 0}();
        vm.deal(next, 1 ether);
        vm.prank(next);
        game.fund{value: 1 ether}();
        assertEq(address(game).balance, 2 ether);
    }

    function test_fund_afterRetire_isForwardedToTheSafe() public {
        vm.prank(agent);
        factory.retire(address(game));
        vm.prank(funder);
        vm.expectEmit(address(game));
        emit GameKit.Forwarded(0.5 ether);
        game.fund{value: 0.5 ether}();
        assertEq(safe.balance, 0.5 ether);
        assertEq(address(game).balance, 1 ether);
    }

    function test_pause_onlySafe_stopsPlays_evenWithoutTheModifier() public {
        vm.expectRevert(GameKit.NotSafe.selector);
        game.pause(true);
        vm.prank(safe);
        game.pause(true);
        vm.expectRevert(GameKit.NotLive.selector);
        game.play(0);
        vm.expectRevert(GameKit.NotLive.selector);
        game.playUnguarded(); // _played itself refuses
        vm.prank(safe);
        game.pause(false);
        game.play(0);
    }

    function test_played_namesTheSender() public {
        address p = makeAddr("player");
        vm.expectEmit(address(game));
        emit GameKit.Played(p, 7);
        vm.prank(p);
        game.play(7);
    }

    function test_retire_onlyTheFactory_once() public {
        vm.expectRevert(GameKit.NotFactory.selector);
        game.retire();
        vm.prank(safe);
        vm.expectRevert(GameKit.NotFactory.selector);
        game.retire();
        vm.prank(safe);
        factory.retire(address(game));
        assertTrue(game.retired());
        assertEq(game.retiredAt(), block.timestamp);
        vm.expectRevert(GameKit.NotLive.selector);
        game.play(0);
    }

    function test_credit_neverBeyondTheFreeBalance() public {
        game.credit(makeAddr("a"), 0.6 ether);
        vm.expectRevert(abi.encodeWithSelector(GameKit.OverFreeBalance.selector, 0.5 ether, 0.4 ether));
        game.credit(makeAddr("b"), 0.5 ether);
        game.credit(makeAddr("b"), 0.4 ether);
        assertEq(game.freeBalance(), 0);
        assertEq(game.owedTotal(), 1 ether);
    }

    function test_claim_paysOnce_worksPausedAndRetired() public {
        address a = makeAddr("a");
        game.credit(a, 0.3 ether);
        vm.prank(safe);
        game.pause(true);
        vm.prank(agent);
        factory.retire(address(game));
        vm.prank(a);
        game.claim();
        assertEq(a.balance, 0.3 ether);
        assertEq(game.owedTotal(), 0);
        vm.prank(a);
        vm.expectRevert(GameKit.NothingOwed.selector);
        game.claim();
    }

    function test_claim_toARefuser_revertsAndKeepsTheDebt() public {
        Refuser r = new Refuser();
        game.credit(address(r), 0.1 ether);
        vm.expectRevert(GameKit.TransferFailed.selector);
        r.claim(game);
        assertEq(game.owed(address(r)), 0.1 ether);
    }

    function test_sweep_onlyRetired_waitsForAnOpenRound_untilTheBackstop() public {
        game.credit(makeAddr("a"), 0.25 ether);
        vm.expectRevert(GameKit.NotRetired.selector);
        game.sweep();
        game.setOpen(true);
        vm.prank(agent);
        factory.retire(address(game));
        vm.expectRevert(GameKit.RoundOpen.selector);
        game.sweep();
        skip(7 days - 1);
        vm.expectRevert(GameKit.RoundOpen.selector);
        game.sweep();
        skip(1);
        game.sweep(); // anyone
        assertEq(safe.balance, 0.75 ether);
        assertEq(address(game).balance, 0.25 ether, "owed stays");
        game.sweep(); // nothing left: no revert
        assertEq(safe.balance, 0.75 ether);
    }

    /// After the backstop the game's own code is never asked: a _roundOpen that reverts can't hold the money.
    function test_sweep_afterTheBackstop_neverAsksTheGame() public {
        game.setOpenReverts(true);
        vm.prank(agent);
        factory.retire(address(game));
        vm.expectRevert(bytes("no answer"));
        game.sweep();
        skip(7 days);
        game.sweep();
        assertEq(safe.balance, 1 ether);
    }

    function test_credit_refusedWhilePaused_claimsStillPay() public {
        address a = makeAddr("a");
        game.credit(a, 0.1 ether);
        vm.prank(safe);
        game.pause(true);
        vm.expectRevert(GameKit.NotLive.selector);
        game.credit(a, 0.1 ether);
        vm.prank(a);
        game.claim();
        assertEq(a.balance, 0.1 ether);
        vm.prank(safe);
        game.pause(false);
        game.credit(a, 0.1 ether);
    }

    function test_sweep_noOpenRound_rightAway() public {
        vm.prank(agent);
        factory.retire(address(game));
        game.sweep();
        assertEq(safe.balance, 1 ether);
    }
}
