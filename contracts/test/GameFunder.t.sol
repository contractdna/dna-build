// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {GameFunder, IGameFactory} from "../src/games/GameFunder.sol";

contract MockGameFactory is IGameFactory {
    mapping(address => bool) public isGame;

    function add(address game) external {
        isGame[game] = true;
    }

    /// The funding batch points the factory at its GameFunder (GameFactory.setFunder); the mock only accepts it.
    function setFunder(address) external {}
}

contract MockGame {
    uint256 public received;

    function fund() external payable {
        received += msg.value;
    }
}

contract GameFunderTest is Test {
    uint256 constant BUDGET = 0.2 ether;
    uint256 constant CAP = 0.1 ether;

    address safe = makeAddr("safe");
    MockGameFactory factory = new MockGameFactory();
    GameFunder funder;
    MockGame[4] games;

    function setUp() public {
        funder = new GameFunder(safe, factory, BUDGET, CAP);
        for (uint256 i; i < games.length; ++i) {
            games[i] = new MockGame();
            factory.add(address(games[i]));
        }
        vm.deal(address(funder), 10 ether);
    }

    function _fund(address game, uint256 amount) internal {
        vm.prank(safe);
        funder.fund(game, amount);
    }

    function test_constructor_rejectsBadConfig() public {
        vm.expectRevert(GameFunder.BadConfig.selector);
        new GameFunder(address(0), factory, BUDGET, CAP);
        vm.expectRevert(GameFunder.BadConfig.selector);
        new GameFunder(safe, IGameFactory(address(0)), BUDGET, CAP);
        vm.expectRevert(GameFunder.BadConfig.selector);
        new GameFunder(safe, factory, BUDGET, 0);
        vm.expectRevert(GameFunder.BadConfig.selector);
        new GameFunder(safe, factory, CAP - 1, CAP);
    }

    function test_fund_paysGameFromOwnBalance() public {
        vm.expectEmit(address(funder));
        emit GameFunder.Funded(address(games[0]), 0.05 ether, 0.05 ether, 0.05 ether);
        _fund(address(games[0]), 0.05 ether);
        assertEq(games[0].received(), 0.05 ether);
        assertEq(address(funder).balance, 10 ether - 0.05 ether);
        assertEq(funder.fundedTotal(address(games[0])), 0.05 ether);
        assertEq(funder.spentInWindow(), 0.05 ether);
    }

    function test_fund_onlySafe() public {
        vm.expectRevert(GameFunder.NotSafe.selector);
        funder.fund(address(games[0]), 1);
    }

    function test_fund_rejectsNonGameAndZero() public {
        address stranger = address(new MockGame()); // has fund(), not from the factory
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(GameFunder.NotGame.selector, stranger));
        funder.fund(stranger, 1);
        vm.prank(safe);
        vm.expectRevert(GameFunder.ZeroAmount.selector);
        funder.fund(address(games[0]), 0);
    }

    function test_fund_perGameCapBoundary() public {
        _fund(address(games[0]), CAP - 1);
        _fund(address(games[0]), 1); // exactly the cap
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(GameFunder.OverGameCap.selector, CAP + 1, CAP));
        funder.fund(address(games[0]), 1);
        // the cap is lifetime: a week later it still holds
        skip(30 days);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(GameFunder.OverGameCap.selector, CAP + 1, CAP));
        funder.fund(address(games[0]), 1);
    }

    function test_fund_rollingWeeklyBudget() public {
        uint256 t0 = vm.getBlockTimestamp();
        _fund(address(games[0]), CAP); // t0
        skip(3 days);
        _fund(address(games[1]), CAP); // t0 + 3d: budget full
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(GameFunder.OverWeeklyBudget.selector, BUDGET + 1, BUDGET));
        funder.fund(address(games[2]), 1);

        vm.warp(t0 + 7 days - 1); // the t0 spend is still inside the window
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(GameFunder.OverWeeklyBudget.selector, BUDGET + 1, BUDGET));
        funder.fund(address(games[2]), 1);

        vm.warp(t0 + 7 days); // the t0 spend leaves the window: CAP is free again, not more
        assertEq(funder.spentInWindow(), CAP);
        _fund(address(games[2]), CAP);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(GameFunder.OverWeeklyBudget.selector, BUDGET + 1, BUDGET));
        funder.fund(address(games[3]), 1);
    }

    function test_fund_insufficientBalance() public {
        vm.deal(address(funder), 0.01 ether);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(GameFunder.InsufficientBalance.selector, 0.02 ether, 0.01 ether));
        funder.fund(address(games[0]), 0.02 ether);
    }

    function test_fund_gameRevertBubbles() public {
        address reverter = makeAddr("eoa-game"); // listed but without code: the call reverts, nothing is counted
        factory.add(reverter);
        vm.prank(safe);
        vm.expectRevert();
        funder.fund(reverter, 1);
        assertEq(funder.spentInWindow(), 0);
    }

    function test_sweep_onlySafe_returnsBalance() public {
        vm.expectRevert(GameFunder.NotSafe.selector);
        funder.sweep();
        vm.expectEmit(address(funder));
        emit GameFunder.Swept(10 ether);
        vm.prank(safe);
        funder.sweep();
        assertEq(safe.balance, 10 ether);
        assertEq(address(funder).balance, 0);
    }

    function test_receive_acceptsTopUp() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(funder).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(funder).balance, 11 ether);
    }

    /// A flood of tiny spends can't brick fund(): each call pops at most MAX_POP expired spends, and the ones not yet
    /// popped still count, so the budget is only ever stricter than the true rolling sum.
    function test_fund_popBoundNeverBricksAndStaysConservative() public {
        uint256 n = funder.MAX_POP() * 2 + 5;
        GameFunder big = new GameFunder(safe, factory, n * 1 gwei + CAP, CAP);
        vm.deal(address(big), 1 ether);
        for (uint256 i; i < n; ++i) {
            vm.prank(safe);
            big.fund(address(games[i % 4]), 1 gwei);
        }
        skip(7 days);
        assertEq(big.spentInWindow(), 0); // the view sees through the backlog
        uint256 before = big.counted();
        vm.prank(safe);
        big.fund(address(games[0]), 1 gwei);
        assertEq(big.head(), funder.MAX_POP());
        assertEq(big.counted(), before - funder.MAX_POP() * 1 gwei + 1 gwei);
        assertGe(big.counted(), big.spentInWindow());
    }

    /// Model check: any sequence of funds keeps every 7-day window and every game inside its limits, and the contract
    /// accepts exactly what the model accepts while the pop backlog stays empty.
    function testFuzz_fund_matchesRollingModel(uint256[24] memory steps) public {
        uint64[] memory at = new uint64[](steps.length);
        uint256[] memory amt = new uint256[](steps.length);
        uint256[4] memory perGame;
        uint256 n;
        for (uint256 i; i < steps.length; ++i) {
            uint256 s = steps[i];
            skip(uint256(uint32(s)) % 3 days);
            uint256 g = (s >> 32) % 4;
            uint256 amount = (s >> 64) % (CAP + 0.01 ether);
            uint256 inWindow;
            for (uint256 j; j < n; ++j) {
                if (at[j] + 7 days > vm.getBlockTimestamp()) inWindow += amt[j];
            }
            bool ok = amount != 0 && perGame[g] + amount <= CAP && inWindow + amount <= BUDGET;
            assertEq(funder.spentInWindow(), inWindow);
            vm.prank(safe);
            try funder.fund(address(games[g]), amount) {
                assertTrue(ok, "accepted a fund the model rejects");
                at[n] = uint64(vm.getBlockTimestamp());
                amt[n++] = amount;
                perGame[g] += amount;
            } catch {
                assertFalse(ok, "rejected a fund the model accepts");
            }
        }
        for (uint256 g; g < 4; ++g) {
            assertEq(games[g].received(), perGame[g]);
            assertLe(perGame[g], CAP);
        }
        for (uint256 i; i < n; ++i) {
            uint256 sum;
            for (uint256 j; j < n; ++j) {
                if (at[j] >= at[i] && at[j] < at[i] + 7 days) sum += amt[j];
            }
            assertLe(sum, BUDGET);
        }
    }
}
