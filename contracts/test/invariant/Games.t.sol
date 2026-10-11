// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockAgentRegistry} from "../games/GameKitConformance.sol";
import {KitHarness} from "../games/GameKit.t.sol";
import {GameFactory} from "../../src/games/GameFactory.sol";
import {GameKit} from "../../src/games/GameKit.sol";

/// Random funding, plays, credits, claims, pauses, deploys, retires and sweeps across the factory's games. Every call
/// that may legitimately revert is tried and classified, so a raw revert is a handler bug.
contract GamesHandler is Test {
    GameFactory immutable factory;
    address immutable safe;
    address immutable agent;
    address immutable funder;
    address[] public games;
    address[4] actors = [address(0xC1), address(0xC2), address(0xC3), address(0xC4)];
    uint256 public sentToSafe;
    uint256 public funded;

    constructor(GameFactory f, address s, address a, address fu) {
        (factory, safe, agent, funder) = (f, s, a, fu);
    }

    function gameCount() external view returns (uint256) {
        return games.length;
    }

    function _game(uint256 i) internal view returns (KitHarness) {
        return KitHarness(games[i % games.length]);
    }

    function deploy() external {
        if (factory.liveCount() >= factory.MAX_LIVE()) return;
        vm.prank(agent);
        games.push(factory.deploy(type(KitHarness).creationCode, bytes32(games.length)));
    }

    function fund(uint256 i, uint96 amount) external {
        if (games.length == 0) return;
        uint256 a = uint256(amount) % 1 ether;
        vm.deal(funder, a);
        uint256 before = safe.balance;
        vm.prank(funder);
        _game(i).fund{value: a}();
        sentToSafe += safe.balance - before;
        funded += a;
    }

    function play(uint256 i, uint256 who) external {
        if (games.length == 0) return;
        KitHarness g = _game(i);
        if (g.paused() || g.retired()) return;
        vm.prank(actors[who % 4]);
        g.play(0);
    }

    function credit(uint256 i, uint256 who, uint256 amount) external {
        if (games.length == 0) return;
        KitHarness g = _game(i);
        if (g.paused()) {
            vm.expectRevert(GameKit.NotLive.selector); // a Safe pause stops every new payout
            g.credit(actors[who % 4], 0);
            return;
        }
        g.credit(actors[who % 4], amount % (g.freeBalance() + 1));
    }

    function claim(uint256 i, uint256 who) external {
        if (games.length == 0) return;
        KitHarness g = _game(i);
        address a = actors[who % 4];
        if (g.owed(a) == 0) return;
        vm.prank(a);
        g.claim();
    }

    function pause(uint256 i, bool on) external {
        if (games.length == 0) return;
        vm.prank(safe);
        _game(i).pause(on);
    }

    function setOpen(uint256 i, bool open) external {
        if (games.length == 0) return;
        _game(i).setOpen(open);
    }

    function retire(uint256 i) external {
        if (games.length == 0) return;
        address g = games[i % games.length];
        if (!factory.isLive(g)) return;
        vm.prank(agent);
        factory.retire(g);
    }

    function sweep(uint256 i) external {
        if (games.length == 0) return;
        KitHarness g = _game(i);
        if (!g.retired() || (g.open() && block.timestamp < g.retiredAt() + g.SWEEP_BACKSTOP())) return;
        uint256 before = safe.balance;
        g.sweep();
        sentToSafe += safe.balance - before;
    }

    function wait(uint32 s) external {
        skip(uint256(s) % 8 days);
    }

    function owedSum(uint256 i) external view returns (uint256 sum) {
        for (uint256 k; k < 4; ++k) {
            sum += KitHarness(games[i]).owed(actors[k]);
        }
    }
}

contract GamesInvariantTest is Test {
    address safe = makeAddr("safe");
    address agent = makeAddr("agent");
    address funder = makeAddr("funder");
    GameFactory factory;
    GamesHandler handler;

    function setUp() public {
        factory = new GameFactory(safe, new MockAgentRegistry(agent));
        vm.prank(safe);
        factory.setFunder(funder);
        handler = new GamesHandler(factory, safe, agent, funder);
        targetContract(address(handler));
    }

    /// Every game holds at least what it owes, and what it owes is exactly the players' claims.
    function invariant_solvent_owedAddsUp() public view {
        for (uint256 i; i < handler.gameCount(); ++i) {
            address g = handler.games(i);
            assertGe(g.balance, GameKit(payable(g)).owedTotal());
            assertEq(handler.owedSum(i), GameKit(payable(g)).owedTotal());
        }
    }

    /// At most 3 live; liveCount is the live games; every deployed game stays a game.
    function invariant_liveCount() public view {
        uint256 live;
        for (uint256 i; i < handler.gameCount(); ++i) {
            address g = handler.games(i);
            assertTrue(factory.isGame(g));
            if (factory.isLive(g)) {
                ++live;
                assertFalse(GameKit(payable(g)).retired());
            } else {
                assertTrue(GameKit(payable(g)).retired());
            }
        }
        assertEq(factory.liveCount(), live);
        assertLe(live, 3);
    }

    /// No ETH appears or vanishes: everything funded is in a game, with the Safe, or paid to a player.
    function invariant_conservation() public view {
        uint256 held;
        for (uint256 i; i < handler.gameCount(); ++i) {
            held += handler.games(i).balance;
        }
        uint256 paid;
        for (uint160 a = 0xC1; a <= 0xC4; ++a) {
            paid += address(a).balance;
        }
        assertEq(held + handler.sentToSafe() + paid, handler.funded());
    }
}
