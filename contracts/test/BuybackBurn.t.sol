// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {DNAHook} from "../src/DNAHook.sol";
import {DNAToken} from "../src/DNAToken.sol";
import {BuybackBurn} from "../src/BuybackBurn.sol";
import {PlatformRevenue} from "../src/PlatformRevenue.sol";
import {PoolBound} from "../src/PoolBound.sol";
import {FeeMath} from "../src/libraries/FeeMath.sol";
import {IDNAHook} from "../src/interfaces/IDNA.sol";

/// BuybackBurn on the real DNAHook: its swaps pay Programmable's platform fee like any swap, and no project fee.
contract BuybackBurnTest is Test, Deployers {
    using StateLibrary for IPoolManager;

    int256 constant DEEP = 1000 ether;

    DNAHook hook;
    DNAToken token;
    BuybackBurn bb;
    PlatformRevenue pr;
    PoolId pid;
    uint24 PF; // hook.PLATFORM_FEE (0.30%)
    address feeVault = makeAddr("feeVault");
    address platform = makeAddr("platform");

    struct Fee {
        bool buy;
        bool exactInput;
        uint256 gross;
        uint256 project;
        uint256 platform;
        uint24 pips;
    }

    function setUp() public {
        vm.warp(1_760_000_000); // realistic clock: the cooldown compares against lastProcess = 0
        deployFreshManagerAndRouters();
        token = new DNAToken(address(this));
        bb = new BuybackBurn(manager, address(this));
        pr = new PlatformRevenue(manager, platform);
        address at = address(uint160(0x4444 << 144) | uint160(Hooks.ALL_HOOK_MASK));
        deployCodeTo(
            "DNAHook.sol:DNAHook",
            abi.encode(manager, address(token), address(this), feeVault, address(pr), address(bb)),
            at
        );
        hook = DNAHook(at);
        PF = hook.PLATFORM_FEE();
        key = hook.poolKey();
        pid = key.toId();
        manager.initialize(key, SQRT_PRICE_1_1);
        bb.initialize(address(hook));

        vm.deal(address(this), 1e30);
        token.approve(address(modifyLiquidityRouter), type(uint256).max);
        vm.warp(block.timestamp + hook.LAUNCH_CAP_WINDOW()); // no new liquidity inside the launch window
        modifyLiquidityRouter.modifyLiquidity{value: 1000 ether}(
            key, ModifyLiquidityParams(-60_000, 60_000, DEEP, 0), ""
        );
        vm.warp(block.timestamp + 1 hours); // past the launch hour (the project fee plays no part here anyway)
    }

    // ---------- helpers ----------

    function _claims(address a) internal view returns (uint256) {
        return manager.balanceOf(a, 0);
    }

    /// ETH claims for `to`, backed by ETH settled into the PoolManager.
    function _fund(address to, uint256 amount) internal {
        manager.unlock(abi.encode(to, amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        manager.settle{value: amount}();
        manager.mint(to, 0, amount);
        return "";
    }

    function _thin() internal {
        modifyLiquidityRouter.modifyLiquidity(key, ModifyLiquidityParams(-60_000, 60_000, -(DEEP - 1 ether), 0), "");
    }

    /// The one FeeTaken of the last process() and its Buyback event's `spent`.
    function _process() internal returns (Fee memory f, uint256 spent) {
        vm.recordLogs();
        bb.process();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == IDNAHook.FeeTaken.selector) {
                f = abi.decode(logs[i].data, (Fee));
                n++;
            }
            if (logs[i].emitter == address(bb) && logs[i].topics[0] == BuybackBurn.Buyback.selector) {
                (spent,,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
            }
        }
        assertEq(n, 1, "one FeeTaken per buyback");
    }

    /// Platform fee only, through the hook's exact-out-buy math (fee on the ETH the pool actually took), all of it to
    /// PlatformRevenue, nothing to FeeVault; BuybackBurn paid exactly pool ETH + fee and never more than `size`.
    function _assertPlatformOnly(Fee memory f, uint256 spent, uint256 size, uint256 pr0) internal view {
        assertTrue(f.buy, "buy");
        assertFalse(f.exactInput, "exact-out");
        assertEq(f.pips, 0, "project pips 0");
        assertEq(f.project, 0, "no project fee");
        assertGt(f.platform, 0, "platform fee charged");
        assertEq(
            f.platform, FeeMath.fromNet(f.gross - f.platform, PF), "0.30% on the pool's ETH, as on any exact-out buy"
        );
        assertEq(_claims(feeVault), 0, "FeeVault gets nothing");
        assertEq(_claims(address(pr)) - pr0, f.platform, "PlatformRevenue accrues the fee");
        assertEq(spent, f.gross, "spent = pool ETH + platform fee");
        assertLe(spent, size, "never more than size");
    }

    // ---------- fees ----------

    function test_process_paysOnlyThePlatformFee() public {
        _fund(address(bb), 0.5 ether);
        uint256 supply = token.totalSupply();
        (uint160 p0,,,) = manager.getSlot0(pid);
        (,,, uint64 count0) = hook.observables();

        (Fee memory f, uint256 spent) = _process();

        _assertPlatformOnly(f, spent, 0.5 ether, 0);
        assertEq(_claims(address(bb)), 0.5 ether - spent, "unspent stays as claims");
        assertGt(spent, 0.49 ether, "a deep pool fills almost all of it");
        assertEq(token.balanceOf(address(bb)), 0, "all burned");
        assertLt(token.totalSupply(), supply, "supply down");
        (uint160 p1,,,) = manager.getSlot0(pid);
        assertGe(p1, p0 * 9975 / 10_000, "within limit");
        (,,, uint64 count1) = hook.observables();
        assertEq(count1, count0 + 1, "buybacks stay in the hook's observables");

        // PlatformRevenue pays it out to its recipient as plain ETH
        pr.claim();
        assertEq(platform.balance, f.platform, "recipient paid");
        assertEq(_claims(address(pr)), 0);
    }

    function test_process_partialFillStopsAtLimitAndPaysOnTheFilledPart() public {
        _thin(); // 1 ETH would move the price far past 0.5%
        _fund(address(bb), 1 ether);
        (uint160 p0,,,) = manager.getSlot0(pid);
        uint256 supply = token.totalSupply();

        (Fee memory f, uint256 spent) = _process();

        (uint160 p1,,,) = manager.getSlot0(pid);
        assertEq(p1, uint160(uint256(p0) * 9975 / 10_000), "stopped exactly at limit");
        _assertPlatformOnly(f, spent, 1 ether, 0);
        uint256 left = _claims(address(bb));
        assertGt(left, 0, "partial");
        assertEq(left, 1 ether - spent, "unspent stays as claims");
        assertLt(token.totalSupply(), supply);
        assertEq(token.balanceOf(address(bb)), 0);
    }

    /// Any size and depth: platform fee exact, no project fee, spend ≤ min(claims, 1 ETH), the price limit holds.
    function testFuzz_process_platformOnlyAndBounded(uint256 size, uint256 depth) public {
        size = bound(size, bb.MIN_SIZE(), 3 ether);
        depth = bound(depth, 0.01 ether, uint256(DEEP) - 1 ether);
        modifyLiquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams(-60_000, 60_000, -(DEEP - int256(depth)), 0), ""
        );
        _fund(address(bb), size);
        (uint160 p0,,,) = manager.getSlot0(pid);
        uint256 cap = size > 1 ether ? 1 ether : size;

        (Fee memory f, uint256 spent) = _process();

        _assertPlatformOnly(f, spent, cap, 0);
        assertEq(_claims(address(bb)), size - spent);
        (uint160 p1,,,) = manager.getSlot0(pid);
        assertGe(p1, uint160(uint256(p0) * 9975 / 10_000), "within limit");
    }

    function test_process_capsAtOneEth() public {
        _fund(address(bb), 3 ether);
        (Fee memory f, uint256 spent) = _process();
        _assertPlatformOnly(f, spent, 1 ether, 0);
        assertEq(_claims(address(bb)), 3 ether - spent);
    }

    /// The budget split assumes the hook's rate: the two constants must agree.
    function test_platformFeeMatchesHook() public view {
        assertEq(bb.PLATFORM_FEE(), hook.PLATFORM_FEE());
    }

    // ---------- mechanics ----------

    function test_process_burnsStrayDna() public {
        token.transfer(address(bb), 123 ether);
        _fund(address(bb), 0.1 ether);
        bb.process();
        assertEq(token.balanceOf(address(bb)), 0);
    }

    function test_process_cooldown() public {
        _fund(address(bb), 3 ether);
        (, uint256 spent1) = _process();
        vm.expectRevert(BuybackBurn.CoolingDown.selector);
        bb.process();
        assertEq(bb.COOLDOWN(), 1 hours);
        vm.warp(block.timestamp + 1 hours - 1);
        vm.expectRevert(BuybackBurn.CoolingDown.selector);
        bb.process();
        vm.warp(block.timestamp + 1);
        (, uint256 spent2) = _process();
        assertEq(_claims(address(bb)), 3 ether - spent1 - spent2, "two buybacks of at most 1 ETH each, the rest kept");
        assertGe(_claims(address(bb)), 1 ether);
    }

    function test_process_nothingToBuy() public {
        vm.expectRevert(BuybackBurn.NothingToBuy.selector);
        bb.process();
    }

    /// Re-deploy token, BuybackBurn, PlatformRevenue and hook (hook address `n`) with the pool at `tick` (P = 1.0001^tick
    /// DNA per ETH), liquidity ±6,000 ticks around it.
    function _setUpAt(int24 tick, uint256 n) internal {
        _deployAt(TickMath.getSqrtPriceAtTick(tick), n);
        modifyLiquidityRouter.modifyLiquidity{value: 1e27}(
            key, ModifyLiquidityParams(tick - 6000, tick + 6000, 1e20, 0), ""
        );
    }

    /// Fresh token, BuybackBurn, PlatformRevenue and hook (hook address `n`), the pool initialized at `sqrtP0`, no liquidity.
    function _deployAt(uint160 sqrtP0, uint256 n) internal {
        token = new DNAToken(address(this));
        bb = new BuybackBurn(manager, address(this));
        pr = new PlatformRevenue(manager, platform);
        address at = address(uint160((0x5000 + n) << 144) | uint160(Hooks.ALL_HOOK_MASK));
        deployCodeTo(
            "DNAHook.sol:DNAHook",
            abi.encode(manager, address(token), address(this), feeVault, address(pr), address(bb)),
            at
        );
        hook = DNAHook(at);
        key = hook.poolKey();
        pid = key.toId();
        manager.initialize(key, sqrtP0);
        bb.initialize(address(hook));
        token.approve(address(modifyLiquidityRouter), type(uint256).max);
        vm.warp(block.timestamp + hook.LAUNCH_CAP_WINDOW()); // no new liquidity inside the launch window
    }

    function addLiq(int24 lo, int24 hi, uint256 l) external {
        modifyLiquidityRouter.modifyLiquidity{value: 1e38}(key, ModifyLiquidityParams(lo, hi, int256(l), 0), "");
    }

    function _tryAddLiq(int24 lo, int24 hi, uint256 l) internal returns (bool ok) {
        (ok,) = address(this).call(abi.encodeCall(this.addLiq, (lo, hi, l)));
    }

    /// A rounding trap (worst case for the exact-out budget): no liquidity between spot and just above the 0.5% limit,
    /// then one position [T − 100, T] holding ≈ the whole buy within `delta` (sqrt-price units) above the limit, so
    /// nearly every DNA is bought at the limit price, plus `dust` one-tick positions of liquidity `dustL` in the gap,
    /// each adding a rounding step. Claims == size.
    function _trap(uint256 size, uint256 delta, uint256 dust, uint256 dustL, int24 t) internal returns (bool) {
        vm.deal(address(this), type(uint256).max / 2);
        uint256 sqrtT = TickMath.getSqrtPriceAtTick(t);
        if (sqrtT <= delta + 10) return false;
        uint256 limit = sqrtT - delta;
        uint256 sqrtP0 = (limit * 10_000 + 9974) / 9975;
        if (sqrtP0 * 9975 / 10_000 != limit || sqrtP0 >= TickMath.MAX_SQRT_PRICE) return false;
        _deployAt(uint160(sqrtP0), 9);
        deal(address(token), address(this), type(uint128).max, true);
        token.approve(address(modifyLiquidityRouter), type(uint256).max);
        // sized for the full budget at the limit price: DNA over [limit, sqrtT] ≈ size · P(limit)
        uint256 want = FullMath.mulDiv(FullMath.mulDiv(size, limit, FixedPoint96.Q96), limit, FixedPoint96.Q96);
        uint256 l = FullMath.mulDiv(want, FixedPoint96.Q96, delta) + 1;
        if (want == 0 || l >= 1.9e32 || !_tryAddLiq(t - 100, t, l)) return false;
        (, int24 t0,,) = manager.getSlot0(pid);
        for (uint256 i; i < dust; ++i) {
            int24 lo = t + 1 + int24(uint24(i));
            if (lo + 1 > t0) break;
            _tryAddLiq(lo, lo + 1, dustL);
        }
        _fund(address(bb), size);
        return true;
    }

    /// claims == size in a trapped pool: never a panic, never more than size. The only other outcome is NothingToBuy
    /// (the rounding buffer leaves no DNA to ask for at this price).
    function _assertTrapSafe() internal {
        uint256 size = _claims(address(bb));
        vm.recordLogs();
        (bool ok, bytes memory err) = address(bb).call(abi.encodeCall(BuybackBurn.process, ()));
        if (!ok) {
            assertEq(bytes4(err), BuybackBurn.NothingToBuy.selector, "only NothingToBuy");
            return;
        }
        uint256 spent = size - _claims(address(bb));
        assertLe(spent, size, "spent <= size");
        uint256 fee = _claims(address(pr));
        assertEq(fee, FeeMath.fromNet(spent - fee, PF), "platform fee on the pool's ETH");
        assertEq(_claims(feeVault), 0);
        assertEq(token.balanceOf(address(bb)), 0);
    }

    /// Regression (exact-out budget): trap at tick -90, claims == size (1e12 wei and 1 ETH), 0..60 one-tick dust
    /// positions of three sizes, every other one with the highest protocol fee on. Without the buffer, dust ticks made
    /// pool ETH + fee exceed size and burn(spent) panic (0x11).
    function test_process_roundingTrapNeverOverspends() public {
        uint256[3] memory dustL = [uint256(1), 10_230, 1e12];
        uint256[2] memory sizes = [uint256(1e12), 1 ether];
        for (uint256 i; i < sizes.length; ++i) {
            for (uint256 j; j < dustL.length; ++j) {
                for (uint256 k; k <= 60; k += 3) {
                    uint256 snap = vm.snapshotState();
                    assertTrue(_trap(sizes[i], 747496309180742, k, dustL[j], -90));
                    if (k % 2 == 1) _maxProtocolFee();
                    _assertTrapSafe();
                    vm.revertToState(snap);
                }
            }
        }
    }

    function testFuzz_process_roundingTrapDustTicks(uint256 dust, uint256 dustL) public {
        dust = bound(dust, 0, 60);
        dustL = bound(dustL, 1, 1e12);
        assertTrue(_trap(1e12, 747496309180742, dust, dustL, -90));
        _assertTrapSafe();
    }

    /// The highest protocol fee v4 allows (0.10%, added to the ETH an exact-out swap takes) stays inside the budget.
    function _maxProtocolFee() internal {
        manager.setProtocolFeeController(address(this));
        manager.setProtocolFee(key, 1000 | (1000 << 12));
    }

    function testFuzz_process_maxProtocolFeeNeverOverspends(uint256 size, uint256 depth) public {
        size = bound(size, bb.MIN_SIZE(), 1 ether);
        depth = bound(depth, 0.01 ether, uint256(DEEP) - 1 ether);
        modifyLiquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams(-60_000, 60_000, -(DEEP - int256(depth)), 0), ""
        );
        _maxProtocolFee();
        _fund(address(bb), size); // claims == size
        (Fee memory f, uint256 spent) = _process();
        _assertPlatformOnly(f, spent, size, 0);
    }

    function testFuzz_process_roundingTrapAnyGeometry(
        uint256 size,
        uint256 delta,
        uint256 dust,
        uint256 dustL,
        int24 t,
        bool protocolFee
    ) public {
        size = bound(size, bb.MIN_SIZE(), 1 ether);
        delta = bound(delta, 1, 1e15);
        dust = bound(dust, 0, 60);
        dustL = bound(dustL, 1, 1e12);
        t = int24(bound(int256(t), -300_000, 60_000));
        vm.assume(_trap(size, delta, dust, dustL, t));
        if (protocolFee) _maxProtocolFee();
        _assertTrapSafe();
    }

    /// Dust (1 wei … MIN_SIZE − 1) is `NothingToBuy` at any price, before any swap and without spending the cooldown.
    /// From MIN_SIZE up a buyback runs (platform fee only, spent ≤ size), unless DNA is priced so high that the budget
    /// buys no more than the rounding slack (2^32 + 64 DNA wei): then also NothingToBuy. P is DNA wei per ETH wei.
    function test_process_dustAtSeveralPrices() public {
        int24[6] memory ticks = [int24(-290_000), -138_162, -69_081, 0, 138_162, 207_243]; // P ≈ 2.5e-13, 1e-6, 1e-3, 1, 1e6, 1e9
        uint256[6] memory firstBuy = [uint256(3), 2, 1, 0, 0, 0]; // index into `sizes` of the first size that buys
        uint256[6] memory dust = [uint256(1), 2, 10, 1e6, 1e9, bb.MIN_SIZE() - 1];
        uint256[3] memory sizes = [bb.MIN_SIZE(), 1e15, 1 ether];
        for (uint256 t; t < ticks.length; ++t) {
            uint256 snap = vm.snapshotState();
            _setUpAt(ticks[t], t);
            for (uint256 i; i < dust.length; ++i) {
                uint256 s = vm.snapshotState();
                _fund(address(bb), dust[i]);
                vm.expectRevert(BuybackBurn.NothingToBuy.selector);
                bb.process();
                assertEq(bb.lastProcess(), 0, "cooldown not spent");
                vm.revertToState(s);
            }
            for (uint256 i; i < sizes.length; ++i) {
                uint256 s = vm.snapshotState();
                _fund(address(bb), sizes[i]);
                if (i < firstBuy[t]) {
                    vm.expectRevert(BuybackBurn.NothingToBuy.selector); // size·P(limit) within the rounding slack
                    bb.process();
                    assertEq(bb.lastProcess(), 0, "cooldown not spent");
                } else {
                    (Fee memory f, uint256 spent) = _process();
                    _assertPlatformOnly(f, spent, sizes[i], 0);
                    assertEq(_claims(address(bb)), sizes[i] - spent);
                    assertEq(token.balanceOf(address(bb)), 0);
                }
                vm.revertToState(s);
            }
            vm.revertToState(snap);
        }
    }

    function test_unlockCallbackOnlyManager() public {
        vm.expectRevert(PoolBound.NotPoolManager.selector);
        bb.unlockCallback(abi.encode(uint256(1)));
    }
}
