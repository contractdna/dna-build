// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {GameFactory} from "../../src/games/GameFactory.sol";
import {GameFunder} from "../../src/games/GameFunder.sol";
import {GameKit} from "../../src/games/GameKit.sol";
import {IAgentRegistry} from "../../src/games/IGames.sol";

/// The registry's agent view, settable in tests.
contract MockAgentRegistry is IAgentRegistry {
    address public agent;
    bool public agentPaused;
    uint8 public level = 5;

    constructor(address agent_) {
        agent = agent_;
    }

    function set(address agent_, bool paused_, uint8 level_) external {
        (agent, agentPaused, level) = (agent_, paused_, level_);
    }
}

/// The rules every Sequencer game must keep, run against the real GameFactory. A game's test inherits this and says how
/// to build it (`_creationCode`), how one player plays once (`_play`) and how to close whatever round is open
/// (`_closeRounds`, warping time as needed).
abstract contract GameKitConformance is Test {
    address internal safe = makeAddr("conformance.safe");
    address internal agent = makeAddr("conformance.agent");
    /// the real GameFunder (its address once deployed); the Safe pays the game through it, as on mainnet
    address internal funder;
    MockAgentRegistry internal registry;
    GameFactory internal factory;
    GameKit internal game;

    function _creationCode() internal virtual returns (bytes memory);
    function _play(address player) internal virtual;
    function _closeRounds() internal virtual;

    function setUp() public virtual {
        registry = new MockAgentRegistry(agent);
        factory = new GameFactory(safe, registry);
        GameFunder gf = new GameFunder(safe, factory, 0.2 ether, 0.1 ether);
        funder = address(gf);
        vm.prank(safe);
        factory.setFunder(funder);
        vm.prank(agent);
        game = GameKit(factory.deploy(_creationCode(), keccak256("conformance")));
        vm.deal(funder, 1 ether);
        vm.prank(safe);
        gf.fund(address(game), 0.1 ether);
    }

    function _players(uint256 n) internal returns (address[] memory ps) {
        ps = new address[](n);
        for (uint256 i; i < n; ++i) {
            ps[i] = makeAddr(string.concat("conformance.player", vm.toString(i)));
        }
    }

    function _assertSolvent() internal view {
        assertGe(address(game).balance, game.owedTotal(), "balance covers everything owed");
    }

    function test_conformance_onlyTheFunderFunds() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert(GameKit.NotFunder.selector);
        game.fund{value: 1}();
        vm.prank(safe);
        vm.expectRevert(GameKit.NotFunder.selector);
        game.fund{value: 0}();
    }

    function test_conformance_noOtherWayToSendValue() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(game).call{value: 1}("");
        assertFalse(ok, "no receive / fallback");
    }

    function test_conformance_aPlayIsCountedForItsSender() public {
        address p = makeAddr("conformance.counted");
        vm.recordLogs();
        _play(p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(game) && logs[i].topics[0] == GameKit.Played.selector) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), p, "Played names the player");
                seen = true;
            }
        }
        assertTrue(seen, "a play emits Played");
    }

    function test_conformance_onlyTheSafePauses_andPauseStopsPlays() public {
        vm.expectRevert(GameKit.NotSafe.selector);
        game.pause(true);
        vm.prank(safe);
        game.pause(true);
        address p = makeAddr("conformance.paused");
        vm.expectRevert(GameKit.NotLive.selector);
        this.playAs(p);
        vm.prank(safe);
        game.pause(false);
        _play(p);
    }

    function test_conformance_playsKeepTheGameSolvent_andClaimsWorkAfterRetire() public {
        address[] memory ps = _players(5);
        for (uint256 r; r < 3; ++r) {
            for (uint256 i; i < ps.length; ++i) {
                _play(ps[i]);
                _assertSolvent();
            }
            _closeRounds();
            _assertSolvent();
        }
        vm.prank(safe);
        game.pause(true);
        vm.prank(agent);
        factory.retire(address(game));
        for (uint256 i; i < ps.length; ++i) {
            uint256 o = game.owed(ps[i]);
            if (o == 0) continue;
            uint256 before = ps[i].balance;
            vm.prank(ps[i]);
            game.claim();
            assertEq(ps[i].balance, before + o, "claims stay payable after pause and retire");
        }
        _assertSolvent();
    }

    function test_conformance_retireStopsPlays_sweepReturnsTheFreeBalance_lateFundIsForwarded() public {
        address[] memory ps = _players(3);
        for (uint256 i; i < ps.length; ++i) {
            _play(ps[i]);
        }
        _closeRounds();
        vm.prank(agent);
        factory.retire(address(game));
        vm.expectRevert(GameKit.NotLive.selector);
        this.playAs(ps[0]);
        uint256 owedTotal = game.owedTotal();
        uint256 safeBefore = safe.balance;
        uint256 free = game.freeBalance();
        game.sweep();
        assertEq(safe.balance, safeBefore + free, "the free balance goes back to the Safe");
        assertEq(address(game).balance, owedTotal, "what players are owed stays");
        vm.prank(funder);
        game.fund{value: 0.01 ether}();
        assertEq(safe.balance, safeBefore + free + 0.01 ether, "a late fund is forwarded, never reverted");
    }

    function test_conformance_sweepWaitsForAnOpenRound_untilTheBackstop() public {
        _play(makeAddr("conformance.open"));
        vm.prank(agent);
        factory.retire(address(game));
        // either the round is already closed, or sweep waits for it and the backstop lets it through
        try game.sweep() {}
        catch (bytes memory err) {
            assertEq(bytes4(err), GameKit.RoundOpen.selector);
            skip(game.SWEEP_BACKSTOP());
            game.sweep();
        }
        assertEq(game.freeBalance(), 0);
    }

    /// A Safe pause stops the bleed: whatever the game tries while paused (closing its rounds included), nothing new
    /// is owed; existing claims still pay. Unpaused, the game goes on.
    function test_conformance_pauseStopsEveryNewPayout_claimsStillPay() public {
        address[] memory ps = _players(3);
        for (uint256 i; i < ps.length; ++i) {
            _play(ps[i]);
        }
        _closeRounds();
        _play(ps[0]);
        uint256 owedBefore = game.owedTotal();
        vm.prank(safe);
        game.pause(true);
        skip(30 days);
        try this.closeRounds() {} catch {}
        assertEq(game.owedTotal(), owedBefore, "nothing new is owed while paused");
        for (uint256 i; i < ps.length; ++i) {
            if (game.owed(ps[i]) == 0) continue;
            vm.prank(ps[i]);
            game.claim();
        }
        vm.prank(safe);
        game.pause(false);
        _closeRounds();
        _assertSolvent();
    }

    /// A claimant that, while being paid, claims again and plays and closes rounds through the game: it is paid once,
    /// owes nothing after, and the game stays solvent.
    function test_conformance_reentrantClaimant() public {
        ReentrantClaimant c = new ReentrantClaimant(game, IReenter(address(this)));
        _play(makeAddr("conformance.first"));
        _play(address(c));
        _closeRounds();
        uint256 o = game.owed(address(c));
        if (o == 0) return; // this game didn't pay the claimant: nothing to re-enter
        c.claim();
        assertEq(c.got(), o, "paid exactly once");
        assertEq(game.owed(address(c)), 0);
        _assertSolvent();
    }

    /// Called back by the re-entering claimant.
    function reenter() external {
        _play(makeAddr("conformance.reenter"));
        try this.closeRounds() {} catch {}
    }

    /// External so a revert can be expected around one play.
    function playAs(address p) external {
        _play(p);
    }

    /// External so a game's refusal (paused) can be caught.
    function closeRounds() external {
        _closeRounds();
    }
}

interface IReenter {
    function reenter() external;
}

/// While being paid it claims again and calls back into the game through the test, every call allowed to fail.
contract ReentrantClaimant {
    GameKit internal immutable g;
    IReenter internal immutable t;
    bool internal busy;
    uint256 public got;

    constructor(GameKit g_, IReenter t_) {
        g = g_;
        t = t_;
    }

    function claim() external {
        g.claim();
    }

    receive() external payable {
        got += msg.value;
        if (busy) return;
        busy = true;
        try g.claim() {} catch {}
        try t.reenter() {} catch {}
        busy = false;
    }
}
