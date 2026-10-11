// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {DNAToken} from "../src/DNAToken.sol";
import {DNAHook} from "../src/DNAHook.sol";
import {Bootstrap} from "../src/Bootstrap.sol";
import {LaunchSplit} from "../script/Launch.s.sol";
import {PositionInfo, PositionInfoLibrary} from "@uniswap/v4-periphery/src/libraries/PositionInfoLibrary.sol";

/// Bootstrap against a real local PoolManager + PositionManager (no Permit2: the launch must never need it).
contract BootstrapTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using PositionInfoLibrary for PositionInfo;

    // The CLAUS launch curve: opening tick 201107, DNA-only [1107, 201107), 0.25 ETH launch value (buy + full range).
    uint160 constant OPEN = 1843504778864234216533230113107236;
    uint256 constant BUY = 0.25 ether;

    IPoolManager pm;
    PositionManager posm;
    Bootstrap bootstrap;
    DNAToken token;
    DNAHook hook;
    address factory = makeAddr("factory");
    address safe = makeAddr("safe");
    address feeVault = makeAddr("feeVault");
    address platformRevenue = makeAddr("platformRevenue");

    function setUp() public {
        pm = new PoolManager(address(this));
        posm = new PositionManager(
            pm, IAllowanceTransfer(address(0)), 100_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );
        bootstrap = new Bootstrap(safe, IPositionManager(address(posm)), factory);
        token = new DNAToken(address(bootstrap));
        address at = address(uint160(0x4444 << 144) | uint160(Hooks.ALL_HOOK_MASK));
        deployCodeTo(
            "DNAHook.sol:DNAHook",
            abi.encode(pm, address(token), makeAddr("registry"), feeVault, platformRevenue, makeAddr("buyback")),
            at
        );
        hook = DNAHook(at);
        vm.deal(factory, 10 ether);
    }

    function _params() internal pure returns (Bootstrap.LaunchParams memory) {
        return _params(BUY);
    }

    function _params(uint256 value) internal pure returns (Bootstrap.LaunchParams memory) {
        (uint256 buyEth, uint256 dnaOut) = LaunchSplit.split(OPEN, 1107, 201107, value);
        return Bootstrap.LaunchParams(OPEN, 1107, 201107, dnaOut * 9 / 10, buyEth);
    }

    function _launch(Bootstrap.LaunchParams memory p) internal returns (uint256) {
        return _launch(p, BUY);
    }

    function _launch(Bootstrap.LaunchParams memory p, uint256 value) internal returns (uint256) {
        vm.prank(factory);
        return bootstrap.initialize{value: value}(address(token), address(hook), p);
    }

    function test_openingPriceIsTick201107() public pure {
        assertEq(TickMath.getTickAtSqrtPrice(OPEN), 201107);
    }

    function test_launch() public {
        vm.deal(address(bootstrap), 7); // forced ETH: must end up at the Safe
        PoolKey memory key = hook.poolKey();
        Bootstrap.LaunchParams memory p = _params();
        (, uint256 predicted) = LaunchSplit.split(OPEN, 1107, 201107, BUY);

        vm.expectEmit(true, true, true, true, address(pm));
        emit IPoolManager.Initialize(
            key.toId(), key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks, OPEN, 201107
        );
        vm.recordLogs();
        uint256 id = _launch(p);
        (uint256 fullId, uint256 bought, uint256 burned, uint256 ethDust) = _launchedEvent();

        // two positions, both dead-owned: the main one DNA-only below the opening tick, then the full-range one
        assertEq(fullId, id + 1);
        assertEq(posm.ownerOf(id), bootstrap.DEAD());
        assertEq(posm.ownerOf(fullId), bootstrap.DEAD());
        assertGt(posm.getPositionLiquidity(id), 0);
        assertGt(posm.getPositionLiquidity(fullId), 0);
        (PoolKey memory pk, PositionInfo info) = posm.getPoolAndPositionInfo(fullId);
        assertEq(address(pk.hooks), address(hook));
        assertEq(info.tickLower(), TickMath.MIN_TICK, "full range");
        assertEq(info.tickUpper(), TickMath.MAX_TICK, "full range");
        assertEq(token.balanceOf(address(posm)), 0, "nothing stranded in the PositionManager");
        assertEq(address(posm).balance, 0);

        // the launch buy moved the price down and returned what the split predicts (the multi-step swap rounds down)
        (uint160 sqrtP, int24 tick,,) = pm.getSlot0(key.toId());
        assertLt(sqrtP, OPEN);
        assertLt(tick, 201107);
        assertApproxEqRel(bought, predicted, 1e6, "split model (1e-12)");
        assertLe(bought, predicted);

        // leftovers: the excess DNA (the 0.01% margin) burned; ETH dust ≤ one unit of full-range liquidity (≤ 1 wei
        // above tick 0) goes to the Safe with the forced ETH
        assertEq(token.SUPPLY() - token.totalSupply(), burned);
        assertGt(burned, 0);
        assertLt(burned, bought / 1000, "excess DNA < 0.1% of the buy");
        assertLe(ethDust, (uint256(1) << 96) / sqrtP + 1);
        assertEq(safe.balance, 7 + ethDust);
        assertEq(token.balanceOf(address(bootstrap)), 0);
        assertEq(address(bootstrap).balance, 0);

        // the pool holds every DNA left and all the ETH but the dust (pool share of the buy, fee claims, full range)
        assertEq(token.balanceOf(address(pm)), token.totalSupply());
        assertEq(address(pm).balance, BUY - ethDust);

        // fees on the launch buy only, at t = 0: the launch fee (3%) → FeeVault, 0.3% → PlatformRevenue (claims)
        assertEq(pm.balanceOf(feeVault, 0), p.buyEth * hook.LAUNCH_PROJECT_FEE() / 1e6);
        assertEq(pm.balanceOf(platformRevenue, 0), p.buyEth * hook.PLATFORM_FEE() / 1e6);

        // the launch guard: the buy was the one exempt swap, not counted; adding liquidity is not a swap
        assertEq(hook.walletBought(tx.origin), 0);
    }

    /// Any launch value: the default split launches, the full-range position is ETH-limited (dust ≤ 1 wei) and the
    /// burned excess stays small.
    function testFuzz_splitLaunches(uint256 value) public {
        value = bound(value, 0.01 ether, 5 ether);
        vm.deal(factory, value);
        vm.recordLogs();
        _launch(_params(value), value);
        (, uint256 bought, uint256 burned, uint256 ethDust) = _launchedEvent();
        assertLe(ethDust, 1);
        assertLt(burned, bought / 1000);
        assertEq(address(pm).balance, value - ethDust);
    }

    /// buyEth too small: the full-range position is DNA-limited instead; it still launches, and the ETH it cannot pair
    /// goes to the Safe (no DNA left to burn beyond the main position's rounding dust).
    function test_buyTooSmall_unpairedEthToSafe() public {
        Bootstrap.LaunchParams memory p = _params();
        p.buyEth = p.buyEth * 9 / 10;
        p.minDnaOut = 0;
        vm.recordLogs();
        uint256 id = _launch(p);
        (uint256 fullId, uint256 bought, uint256 burned, uint256 ethDust) = _launchedEvent();
        assertEq(fullId, id + 1);
        assertEq(posm.ownerOf(fullId), bootstrap.DEAD());
        assertGt(ethDust, 0.01 ether, "the unpaired ETH");
        assertEq(safe.balance, ethDust, "to the Safe");
        assertLt(burned, bought / 1e15, "DNA-limited: (almost) all the DNA paired");
        assertEq(address(pm).balance, BUY - ethDust, "the pool got the buy and the paired ETH");
        assertEq(token.balanceOf(address(pm)), token.totalSupply());
    }

    function test_revert_buyEthBounds() public {
        Bootstrap.LaunchParams memory p = _params();
        p.buyEth = 0;
        vm.expectRevert(Bootstrap.InvalidParams.selector);
        _launch(p);
        p.buyEth = BUY; // nothing left for the full-range position
        vm.expectRevert(Bootstrap.InvalidParams.selector);
        _launch(p);
    }

    function _launchedEvent() internal view returns (uint256 fullId, uint256 bought, uint256 burned, uint256 ethDust) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(bootstrap) && logs[i].topics[0] == Bootstrap.Launched.selector) {
                return abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
            }
        }
        revert("no Launched");
    }

    function test_revert_secondInitialize() public {
        _launch(_params());
        vm.expectRevert(Bootstrap.AlreadyLaunched.selector);
        _launch(_params());
    }

    function test_revert_notFactory() public {
        vm.deal(address(this), BUY);
        vm.expectRevert(Bootstrap.NotFactory.selector);
        bootstrap.initialize{value: BUY}(address(token), address(hook), _params());
    }

    function test_revert_badRange() public {
        Bootstrap.LaunchParams memory p = _params();
        p.tickUpper = 201108; // above the opening tick: position would need ETH
        vm.expectRevert(Bootstrap.InvalidParams.selector);
        _launch(p);

        p = _params();
        p.tickLower = -30_001; // boundary-tick saturation zone
        vm.expectRevert(Bootstrap.InvalidParams.selector);
        _launch(p);
    }

    function test_revert_minOut() public {
        Bootstrap.LaunchParams memory p = _params();
        p.minDnaOut = 1_000_000_000 ether;
        vm.expectRevert(Bootstrap.InsufficientOutput.selector);
        _launch(p);
    }

    function test_revert_tokenNotHookCurrency1() public {
        vm.prank(factory);
        vm.expectRevert(Bootstrap.InvalidParams.selector);
        bootstrap.initialize{value: BUY}(makeAddr("otherToken"), address(hook), _params());
    }

    function test_revert_noInitialBuy() public {
        vm.prank(factory);
        vm.expectRevert(Bootstrap.InvalidParams.selector);
        bootstrap.initialize(address(token), address(hook), _params());
    }

    function test_revert_unlockCallbackNotPoolManager() public {
        vm.expectRevert(Bootstrap.NotPoolManager.selector);
        bootstrap.unlockCallback("");
    }
}
