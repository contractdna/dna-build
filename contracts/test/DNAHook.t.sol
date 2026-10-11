// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {DNAHook} from "../src/DNAHook.sol";
import {DNAToken} from "../src/DNAToken.sol";
import {FeeMath} from "../src/libraries/FeeMath.sol";
import {Route, IDNAHook} from "../src/interfaces/IDNA.sol";

/// Module stand-in: answers every call with fixed raw bytes (lets tests return exact, oversized or garbage words).
contract Ret {
    bytes data;

    constructor(bytes memory d) {
        data = d;
    }

    fallback() external {
        bytes memory d = data;
        assembly {
            return(add(d, 32), mload(d))
        }
    }
}

contract Reverter {
    fallback() external {
        revert("no");
    }
}

contract GasBurner {
    fallback() external {
        while (true) {}
    }
}

contract DNAHookTest is Test, Deployers {
    using StateLibrary for IPoolManager;

    DNAHook hook;
    DNAToken token;
    PoolSwapTest bbRouter; // stands in for BuybackBurn (no project fee; pays the platform fee)
    address feeVault = makeAddr("feeVault");
    address platformRevenue = makeAddr("platformRevenue");
    uint24 BASE; // hook.BASELINE_PROJECT_FEE (2.2%)
    uint24 PF; // hook.PLATFORM_FEE (0.3%, Programmable 3.6.0)
    uint24 T; // BASE + PF: what a trader pays after the launch hour (2.5%)
    uint256 launched; // the pool's initialization time

    function setUp() public {
        deployFreshManagerAndRouters();
        bbRouter = new PoolSwapTest(manager);
        token = new DNAToken(address(this));

        address at = address(uint160(0x4444 << 144) | uint160(Hooks.ALL_HOOK_MASK));
        deployCodeTo(
            "DNAHook.sol:DNAHook",
            abi.encode(manager, address(token), address(this), feeVault, platformRevenue, address(bbRouter)),
            at
        );
        hook = DNAHook(at);
        (BASE, PF) = (hook.BASELINE_PROJECT_FEE(), hook.PLATFORM_FEE());
        T = BASE + PF;
        key = hook.poolKey();
        manager.initialize(key, SQRT_PRICE_1_1);
        launched = block.timestamp;
        vm.warp(block.timestamp + hook.LAUNCH_CAP_WINDOW()); // no new liquidity inside the launch window

        vm.deal(address(this), 1e24);
        token.approve(address(modifyLiquidityRouter), type(uint256).max);
        token.approve(address(swapRouter), type(uint256).max);
        token.approve(address(bbRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity{value: 1e22}(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e22, salt: 0}), ""
        );
        vm.roll(block.number + hook.LAUNCH_TAX_BLOCKS()); // past the launch tax (test/LaunchGuard.t.sol)
        vm.warp(launched + 1 hours); // the suite below tests the steady state; "launch fee" tests warp back into the hour
    }

    // ---------------- helpers ----------------

    function _swap(PoolSwapTest r, bool zeroForOne, int256 amt) internal returns (BalanceDelta) {
        return r.swap{value: zeroForOne ? 100 ether : 0}(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amt,
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _claims() internal view returns (uint256 project, uint256 platform) {
        return (manager.balanceOf(feeVault, 0), manager.balanceOf(platformRevenue, 0));
    }

    /// Swap and return (project, platform) minted by it.
    function _fees(bool zeroForOne, int256 amt) internal returns (uint256 p, uint256 q, BalanceDelta d) {
        return _fees(swapRouter, zeroForOne, amt);
    }

    function _fees(PoolSwapTest r, bool zeroForOne, int256 amt)
        internal
        returns (uint256 p, uint256 q, BalanceDelta d)
    {
        (uint256 p0, uint256 q0) = _claims();
        d = _swap(r, zeroForOne, amt);
        (p, q) = _claims();
        (p, q) = (p - p0, q - q0);
    }

    function _route(address active) internal {
        Route memory r;
        r.active = active;
        hook.setRoute(r);
    }

    function _word(uint256 v) internal returns (address) {
        return address(new Ret(abi.encode(v)));
    }

    /// The revert PoolManager surfaces when a hook callback reverts with `err`.
    function _wrapped(bytes4 callback, bytes4 err) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            callback,
            abi.encodeWithSelector(err),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    // ---------------- fee paths (invariant 1) ----------------

    function test_exactInBuy_feeOnSpecified() public {
        (uint256 p, uint256 q, BalanceDelta d) = _fees(true, -1 ether);
        assertEq(d.amount0(), -1 ether, "trader pays exactly the input");
        assertEq(p, 1 ether * uint256(BASE) / 1e6);
        assertEq(q, 1 ether * uint256(PF) / 1e6);
    }

    function test_exactOutSell_feeOnSpecified() public {
        (uint256 p, uint256 q, BalanceDelta d) = _fees(false, 0.5 ether);
        assertEq(d.amount0(), 0.5 ether, "trader receives exactly the output");
        uint256 fee = FeeMath.fromNet(0.5 ether, T);
        assertEq(p + q, fee);
        assertEq(p, (0.5 ether + fee) * BASE / 1e6);
    }

    function test_exactInSell_feeOnUnspecified() public {
        (uint256 p, uint256 q, BalanceDelta d) = _fees(false, -10 ether);
        uint256 gross = uint256(int256(d.amount0())) + p + q; // pool's ETH out
        assertEq(p + q, FeeMath.fromGross(gross, T));
        assertEq(p, gross * BASE / 1e6);
    }

    function test_exactOutBuy_feeOnUnspecified() public {
        (uint256 p, uint256 q, BalanceDelta d) = _fees(true, 10 ether);
        uint256 paid = uint256(-int256(d.amount0()));
        assertEq(p + q, FeeMath.fromNet(paid - p - q, T), "fromNet on the pool's ETH in");
        assertGe((p + q) * 1e6, paid * T, "never under-charged");
        assertEq(p, paid * BASE / 1e6);
    }

    function testFuzz_feeSplitBounds(uint256 amt, bool zeroForOne, bool exactIn) public {
        amt = bound(amt, 1e6, 20 ether);
        (uint256 p, uint256 q, BalanceDelta d) = _fees(zeroForOne, exactIn ? -int256(amt) : int256(amt));
        int256 e = d.amount0();
        // gross = what the trader paid in ETH (buy) or what the pool released in ETH (sell)
        uint256 gross = e < 0 ? uint256(-e) : uint256(e) + p + q;
        assertEq(p, gross * BASE / 1e6, "project = floor(gross*pips/1e6)");
        assertGe(q, gross * PF / 1e6, "platform floor");
        assertLe(q, gross * PF / 1e6 + 2, "platform ceiling");
    }

    // ---------------- buybacks, pool binding, liquidity ----------------

    /// DNA's own buybacks pay the platform fee and no project fee: 0.30% of a 1 ETH buy, where a trader pays 2.5%.
    function test_buybackPaysOnlyThePlatformFee() public {
        (uint256 p, uint256 q, BalanceDelta d) = _fees(bbRouter, true, -1 ether);
        assertEq(d.amount0(), -1 ether, "pays exactly the input");
        assertEq(p, 0, "no project fee");
        assertEq(q, 1 ether * uint256(PF) / 1e6, "0.30% to PlatformRevenue");
        (p, q,) = _fees(true, -1 ether);
        assertEq(p + q, 1 ether * uint256(T) / 1e6, "a trader still pays project + platform");
    }

    /// All four paths: the same FeeMath as a trader's swap at 0 project pips (exact-in: fromGross; exact-out: fromNet on
    /// the pool's ETH), FeeTaken reports pips 0 / project 0, and the swap is observed like any other.
    function testFuzz_buybackPaysOnlyPlatformFee(uint256 amt, bool zeroForOne, bool exactIn) public {
        amt = bound(amt, 1e6, 20 ether);
        (,,, uint64 count0) = hook.observables();
        vm.recordLogs();
        (uint256 p, uint256 q, BalanceDelta d) = _fees(bbRouter, zeroForOne, exactIn ? -int256(amt) : int256(amt));
        int256 e = d.amount0();
        uint256 gross = e < 0 ? uint256(-e) : uint256(e) + q; // ETH paid (buy) or released by the pool (sell)
        assertEq(p, 0, "no project fee");
        assertEq(q, exactIn ? FeeMath.fromGross(gross, PF) : FeeMath.fromNet(gross - q, PF), "platform fee only");
        assertGt(q, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(hook) || logs[i].topics[0] != IDNAHook.FeeTaken.selector) continue;
            n++;
            // (buy, exactInput, gross, project, platform, pips)
            assertEq(logs[i].data, abi.encode(zeroForOne, exactIn, gross, uint256(0), q, uint24(0)), "FeeTaken");
        }
        assertEq(n, 1, "one FeeTaken");
        (,,, uint64 count1) = hook.observables();
        assertEq(count1, count0 + 1, "observed");
    }

    /// A buyback never calls a module (no breaker tick from a failing one) and leaves the traders around it unchanged.
    function test_buybackSkipsModulesTradersUnchanged() public {
        _route(address(new Reverter()));
        (uint256 p0, uint256 q0,) = _fees(true, -1 ether); // module fails → baseline + one breaker tick
        (uint32 n0,) = hook.breaker();
        assertEq(n0, 1);
        (uint256 p, uint256 q,) = _fees(bbRouter, true, -1 ether);
        assertEq(p, 0);
        assertEq(q, 1 ether * uint256(PF) / 1e6);
        (uint32 n1,) = hook.breaker();
        assertEq(n1, n0, "no module call on a buyback");
        (uint256 p2, uint256 q2,) = _fees(true, -1 ether);
        assertEq(abi.encode(p2, q2), abi.encode(p0, q0), "the next trader pays what the last one did");
    }

    /// The ETH-specified partial-fill guard covers buybacks too: an exact-in buyback stopped by its price limit reverts
    /// (so BuybackBurn buys exact-out, where the fee follows the ETH that actually filled).
    function test_buybackExactInPartialFillReverts() public {
        vm.expectRevert(_wrapped(IHooks.afterSwap.selector, DNAHook.PartialNativeFill.selector));
        bbRouter.swap{value: 2000 ether}(
            key,
            SwapParams({
                zeroForOne: true, amountSpecified: -2000 ether, sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(-10)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function test_onlyCanonicalPool() public {
        PoolKey memory k = key;
        k.tickSpacing = 10;
        bytes memory wrong = _wrapped(IHooks.beforeInitialize.selector, DNAHook.WrongPool.selector);
        vm.expectRevert(wrong);
        manager.initialize(k, SQRT_PRICE_1_1);
        k = key;
        k.fee = 3000;
        vm.expectRevert(wrong);
        manager.initialize(k, SQRT_PRICE_1_1);
        k = key;
        k.currency1 = Currency.wrap(address(new DNAToken(address(this))));
        vm.expectRevert(wrong);
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    function test_removeLiquidityNeverBlocked() public {
        modifyLiquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: -1e22, salt: 0}), ""
        );
    }

    function test_partialNativeFillReverts() public {
        vm.expectRevert(_wrapped(IHooks.afterSwap.selector, DNAHook.PartialNativeFill.selector));
        swapRouter.swap{value: 2000 ether}(
            key,
            SwapParams({
                zeroForOne: true, amountSpecified: -2000 ether, sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(-10)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    // ---------------- modules (invariant 6) ----------------

    function test_activeModuleSetsFee() public {
        _route(_word(30_000));
        (uint256 p,,) = _fees(true, -1 ether);
        assertEq(p, 0.03 ether);
    }

    function test_moduleClampedToCap() public {
        _route(_word(90_000));
        (uint256 p,,) = _fees(true, -1 ether);
        assertEq(p, 0.05 ether);
    }

    function test_badModulesFallBackToBaseline() public {
        address[4] memory bad = [
            address(new Reverter()),
            address(new GasBurner()),
            address(new Ret(abi.encode(uint256(1), uint256(2)))), // wrong size
            _word(1 << 30) // > uint24
        ];
        for (uint256 i; i < bad.length; i++) {
            _route(bad[i]);
            (uint256 p,,) = _fees(true, -1 ether);
            assertEq(p, 1 ether * uint256(BASE) / 1e6, "baseline");
            (uint32 n,) = hook.breaker();
            assertEq(n, 1, "failure counted, route change reset it");
        }
    }

    function test_breakerCountsWithinWindowAndResets() public {
        _route(address(new Reverter()));
        for (uint256 i; i < 3; i++) {
            _fees(true, -0.1 ether);
        }
        (uint32 n,) = hook.breaker();
        assertEq(n, 3);
        vm.roll(block.number + 301);
        _fees(true, -0.1 ether);
        (n,) = hook.breaker();
        assertEq(n, 1, "new window");
        _route(address(0));
        (n,) = hook.breaker();
        assertEq(n, 0);
    }

    function test_canaryClampedToActive() public {
        Route memory r;
        r.active = _word(20_000);
        r.canary = _word(45_000);
        r.canaryStart = uint64(block.number);
        r.canaryPeriod = 100;
        r.canaryLen = 50;
        hook.setRoute(r);
        (uint256 p,,) = _fees(true, -1 ether);
        assertEq(p, 0.03 ether, "active + 1 point");
        vm.roll(block.number + 60);
        (p,,) = _fees(true, -1 ether);
        assertEq(p, 0.02 ether, "outside window: active");
    }

    function test_shadowObservedNotCharged() public {
        Route memory r;
        r.shadow = _word(40_000);
        hook.setRoute(r);
        vm.expectEmit(true, false, false, true, address(hook));
        emit IDNAHook.ShadowFee(r.shadow, 40_000);
        (uint256 p,,) = _fees(true, -1 ether); // swapCount 0 → shadow turn
        assertEq(p, 1 ether * uint256(BASE) / 1e6);
    }

    /// Invariant 2: the fee does not depend on how much gas the trader sends (above the minimum).
    function test_feeIndependentOfGas() public {
        _route(_word(30_000));
        uint256 snap = vm.snapshotState();
        (uint256 p0, uint256 q0) = _claims();
        swapRouter.swap{value: 1 ether, gas: 400_000}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        (uint256 p1, uint256 q1) = _claims();
        vm.revertToState(snap);
        (uint256 p2, uint256 q2,) = _fees(true, -1 ether);
        assertEq(p1 - p0, p2);
        assertEq(q1 - q0, q2);
    }

    // ---------------- access, views ----------------

    function test_setRouteOnlyRegistry() public {
        Route memory r;
        vm.prank(makeAddr("rando"));
        vm.expectRevert(DNAHook.OnlyRegistry.selector);
        hook.setRoute(r);
    }

    function test_observables() public {
        _fees(true, -1 ether);
        _fees(false, -1 ether);
        (int24 lastTick,, uint64 lastBlock, uint64 count) = hook.observables();
        (, int24 tick,,) = manager.getSlot0(key.toId());
        assertEq(lastTick, tick);
        assertEq(lastBlock, block.number);
        assertEq(count, 2);
        assertEq(address(hook.poolManager()), address(manager));
        assertEq(Currency.unwrap(hook.poolKey().currency1), address(token));
        assertEq(hook.poolKey().fee, LPFeeLibrary.DYNAMIC_FEE_FLAG);
    }

    // ---------------- edge cases ----------------

    /// An active module answering near uint24.max during a canary window must not overflow the canary clamp.
    function test_canaryClampNoOverflow() public {
        Route memory r;
        r.active = _word(16_770_000);
        r.canary = _word(20_000);
        r.canaryStart = uint64(block.number);
        r.canaryPeriod = 100;
        r.canaryLen = 50;
        hook.setRoute(r);
        (uint256 p,,) = _fees(true, -1 ether);
        assertEq(p, 0.04 ether, "active clamped to 5%, canary clamped to active - 1pt");
    }

    function test_dustSwaps() public {
        (uint256 p, uint256 q,) = _fees(true, -10); // exact-in buy, 10 wei: fee rounds to 0
        assertEq(p + q, 0);
        (p, q,) = _fees(false, 1); // exact-out sell, 1 wei ETH: fromNet rounds up to 1, all platform
        assertEq(p, 0);
        assertEq(q, 1);
        (p, q,) = _fees(true, 1); // exact-out buy, 1 wei DNA
        assertEq(p, 0);
        assertGe(q, 1);
        (p, q,) = _fees(false, -10); // exact-in sell, 10 wei DNA
        assertEq(p + q, 0);
    }

    function test_hookHoldsNoClaims() public {
        _fees(true, -1 ether);
        _fees(true, 1 ether);
        _fees(false, -1 ether);
        _fees(false, 0.5 ether);
        assertEq(manager.balanceOf(address(hook), 0), 0);
        assertEq(manager.balanceOf(address(hook), uint256(uint160(address(token)))), 0);
        assertEq(address(hook).balance, 0);
    }

    // ---------------- launch fee: LAUNCH_PROJECT_FEE (3%) at initialization, linearly to 2.2% over the first hour ----
    // Every expectation is derived from hook.LAUNCH_PROJECT_FEE(), so the flat-2% switch (LAUNCH_PROJECT_FEE = 20_000)
    // is one line in the hook and these tests still hold.

    /// The expected baseline, written independently of the hook's code: B + (L − B) × (3600 − t) / 3600 for t < 3600.
    function _expectedBase(uint256 t) internal view returns (uint256) {
        uint256 l = hook.LAUNCH_PROJECT_FEE();
        return t >= 3600 ? BASE : BASE + (l - BASE) * (3600 - t) / 3600;
    }

    /// Route A, profile 3.6.0: 2.2% project + Programmable's 0.30% = 2.5% for traders, 3.3% at launch.
    function test_feeSchedule() public view {
        assertEq(hook.PLATFORM_FEE(), 3_000, "Programmable 3.6.0 binds programmableFeeHundredthsOfBip = 3000");
        assertEq(hook.BASELINE_PROJECT_FEE(), 22_000, "2.2% baseline");
        assertEq(hook.BASELINE_PROJECT_FEE() + hook.PLATFORM_FEE(), 25_000, "2.5% total after the launch hour");
        assertEq(hook.LAUNCH_PROJECT_FEE() + hook.PLATFORM_FEE(), 33_000, "3.3% total at launch");
    }

    function test_launchFee_bounds() public view {
        assertGe(hook.LAUNCH_PROJECT_FEE(), hook.BASELINE_PROJECT_FEE(), "launch fee >= baseline");
        assertLe(hook.LAUNCH_PROJECT_FEE(), hook.MAX_PROJECT_FEE(), "launch fee <= the 5% cap");
        assertEq(hook.LAUNCH_DECAY(), 1 hours);
    }

    function test_launchFee_exactPoints() public {
        uint256[5] memory t = [uint256(0), 30 minutes, 59 minutes + 59, 60 minutes, 5 hours];
        for (uint256 i; i < t.length; i++) {
            vm.warp(launched + t[i]);
            uint256 want = _expectedBase(t[i]); // 30_000, 26_000, 22_002, 22_000, 22_000
            assertEq(hook.baselineFee(), want, "baselineFee");
            (uint256 p, uint256 q,) = _fees(true, -1 ether); // exact-in buy: fee on the 1 ETH paid
            assertEq(p, 1 ether * want / 1e6, "project");
            assertEq(q, 1 ether * uint256(PF) / 1e6, "platform unchanged");
        }
        assertEq(_expectedBase(0), hook.LAUNCH_PROJECT_FEE(), "t = 0: the launch fee");
    }

    /// Buys and sells, exact-in and exact-out, any moment in or after the hour: project = floor(gross × base / 1e6).
    function testFuzz_launchFee(uint256 elapsed, uint256 amt, bool zeroForOne, bool exactIn) public {
        elapsed = bound(elapsed, 0, 2 hours);
        amt = bound(amt, 1e6, 20 ether);
        vm.warp(launched + elapsed);
        uint256 base = _expectedBase(elapsed);
        assertEq(hook.baselineFee(), base);
        (uint256 p, uint256 q, BalanceDelta d) = _fees(zeroForOne, exactIn ? -int256(amt) : int256(amt));
        int256 e = d.amount0();
        uint256 gross = e < 0 ? uint256(-e) : uint256(e) + p + q;
        assertEq(p, gross * base / 1e6, "project = floor(gross*base/1e6)");
        assertGe(q, gross * PF / 1e6, "platform floor");
        assertLe(q, gross * PF / 1e6 + 2, "platform ceiling");
        assertGe((p + q) * 1e6 + 2e6, gross * (base + PF), "never under-charged beyond rounding");
    }

    function test_launchFee_allFourPathsAtLaunch() public {
        vm.warp(launched); // t = 0: the launch fee + 0.3%
        uint24 l = hook.LAUNCH_PROJECT_FEE();
        uint24 t0 = l + PF;
        (uint256 p, uint256 q, BalanceDelta d) = _fees(false, 0.5 ether); // exact-out sell: fee on specified
        assertEq(d.amount0(), 0.5 ether);
        uint256 fee = FeeMath.fromNet(0.5 ether, t0);
        assertEq(p + q, fee);
        assertEq(p, (0.5 ether + fee) * l / 1e6);
        (p, q, d) = _fees(false, -10 ether); // exact-in sell: fee on the pool's ETH out
        uint256 gross = uint256(int256(d.amount0())) + p + q;
        assertEq(p + q, FeeMath.fromGross(gross, t0));
        (p, q, d) = _fees(true, 10 ether); // exact-out buy: fee on the pool's ETH in
        uint256 paid = uint256(-int256(d.amount0()));
        assertEq(p + q, FeeMath.fromNet(paid - p - q, t0));
        assertEq(p, paid * l / 1e6);
    }

    /// A failing module (the breaker fallback) pays the decayed baseline, not a flat 2%.
    function test_launchFee_breakerFallback() public {
        _route(address(new Reverter()));
        vm.warp(launched + 15 minutes); // 3%: 27_500
        (uint256 p,,) = _fees(true, -1 ether);
        assertEq(p, 1 ether * _expectedBase(15 minutes) / 1e6, "fallback = the decayed baseline");
        (uint32 n,) = hook.breaker();
        assertEq(n, 1, "failure counted");
        vm.warp(launched + 1 hours);
        (p,,) = _fees(true, -1 ether);
        assertEq(p, 1 ether * uint256(BASE) / 1e6, "after the hour: the baseline");
    }

    /// Modules are never touched by the decay; a canary with no active module is clamped around the decayed baseline.
    function test_launchFee_modulesUnaffected() public {
        vm.warp(launched + 10 minutes);
        _route(_word(15_000));
        (uint256 p,,) = _fees(true, -1 ether);
        assertEq(p, 0.015 ether, "active module's answer, not the launch fee");
        Route memory r;
        r.canary = _word(45_000);
        r.canaryStart = uint64(block.number);
        r.canaryPeriod = 100;
        r.canaryLen = 50;
        vm.warp(launched); // 3%: base 30_000 → canary clamped to 40_000
        hook.setRoute(r);
        (p,,) = _fees(true, -1 ether);
        assertEq(
            p,
            1 ether * uint256(hook.LAUNCH_PROJECT_FEE() + 10_000) / 1e6,
            "canary within 1 point of the decayed baseline"
        );
        vm.warp(launched + 2 hours); // base 22_000 → canary clamped to 32_000
        (p,,) = _fees(true, -1 ether);
        assertEq(p, 1 ether * uint256(BASE + 10_000) / 1e6, "after the hour: within 1 point of the baseline");
    }

    /// The clock is set once, by the pool's initialization: no second initialize, no direct call, can reset it.
    function test_launchFee_clockCannotBeReset() public {
        vm.warp(launched + 1 hours);
        vm.expectRevert();
        manager.initialize(key, SQRT_PRICE_1_1);
        vm.expectRevert();
        hook.beforeInitialize(address(this), key, SQRT_PRICE_1_1);
        assertEq(hook.baselineFee(), BASE, "still decayed");
        (,,, uint64 swaps) = hook.observables();
        _fees(true, -1 ether);
        (,,, uint64 swaps2) = hook.observables();
        assertEq(swaps2, swaps + 1);
        assertEq(hook.baselineFee(), BASE, "observing a swap keeps the launch time");
    }

    /// The gas guard fires (rather than a starved module silently falling back to baseline) somewhere in the sweep.
    function test_outOfGasBudgetGuard() public {
        _route(_word(30_000));
        bytes memory guard = _wrapped(IHooks.beforeSwap.selector, DNAHook.OutOfGasBudget.selector);
        bytes memory call = abi.encodeCall(
            PoolSwapTest.swap,
            (
                key,
                SwapParams({zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ""
            )
        );
        bool hit;
        for (uint256 g = 100_000; g < 400_000 && !hit; g += 1_000) {
            (bool ok, bytes memory ret) = address(swapRouter).call{value: 1 ether, gas: g}(call);
            hit = !ok && keccak256(ret) == keccak256(guard);
        }
        assertTrue(hit, "guard never fired");
    }
}
