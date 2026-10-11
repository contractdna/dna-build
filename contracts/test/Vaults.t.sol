// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {DNAToken} from "../src/DNAToken.sol";
import {SplitRoute} from "../src/interfaces/IDNA.sol";
import {PlatformRevenue} from "../src/PlatformRevenue.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {BuybackBurn} from "../src/BuybackBurn.sol";
import {LiquidityVault} from "../src/LiquidityVault.sol";
import {PoolBound} from "../src/PoolBound.sol";

/// @dev Test-only stand-in for DNAHook: exact-in ETH→DNA swaps pay 2.00% project (→ FeeVault) + 0.10% platform
///      (→ PlatformRevenue) as ERC-6909 mints; BuybackBurn's swaps are not charged here (its fees on the real hook:
///      BuybackBurn.t.sol). `fund` mints claims backed by msg.value.
contract TestHook {
    IPoolManager public immutable pm;
    address public immutable token;
    address public immutable feeVault;
    address public immutable platformRevenue;
    address public immutable buybackBurn;

    constructor(IPoolManager pm_, address token_, address fv, address pr, address bb) {
        (pm, token, feeVault, platformRevenue, buybackBurn) = (pm_, token_, fv, pr, bb);
    }

    function poolManager() external view returns (IPoolManager) {
        return pm;
    }

    function poolKey() external view returns (PoolKey memory) {
        return PoolKey(
            Currency.wrap(address(0)), Currency.wrap(token), LPFeeLibrary.DYNAMIC_FEE_FLAG, 1, IHooks(address(this))
        );
    }

    function beforeSwap(address sender, PoolKey calldata, SwapParams calldata p, bytes calldata)
        external
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (sender == buybackBurn || !p.zeroForOne || p.amountSpecified >= 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDelta.wrap(0), 0);
        }
        uint256 gross = uint256(-p.amountSpecified);
        uint256 project = gross * 20_000 / 1e6;
        uint256 fee = gross * 21_000 / 1e6;
        if (project != 0) pm.mint(feeVault, 0, project);
        if (fee > project) pm.mint(platformRevenue, 0, fee - project);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
    }

    function fund(address to) external payable {
        pm.unlock(abi.encode(to, msg.value));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        pm.settle{value: amount}();
        pm.mint(to, 0, amount);
        return "";
    }
}

contract MockRegistry {
    SplitRoute internal r;

    function set(address module, bytes32[4] memory params) external {
        r = SplitRoute(module, params);
    }

    function splitRoute() external view returns (SplitRoute memory) {
        return r;
    }
}

/// @dev Same selector as ISplitPolicy.split; returns raw words so dirty / huge values can be tested. Params are the
///      four shares; `mode` picks a failure.
contract MockSplit {
    uint256 public mode;

    function setMode(uint256 mode_) external {
        mode = mode_;
    }

    function split(bytes32[4] calldata p) external view returns (uint256, uint256, uint256, uint256) {
        if (mode == 1) revert("nope");
        if (mode == 2) {
            while (gasleft() > 0) {} // burn the whole cap
        }
        if (mode == 3) {
            assembly {
                mstore(0, 5000)
                return(0, 64) // short returndata
            }
        }
        if (mode == 4) {
            assembly {
                mstore(0, 5000)
                mstore(32, 3000)
                mstore(64, 2000)
                mstore(96, 0)
                return(0, 110400) // valid prefix + ~108 KB: about the largest bomb that fits the 40k cap (after the mode SLOAD)
            }
        }
        return (uint256(p[0]), uint256(p[1]), uint256(p[2]), uint256(p[3]));
    }
}

/// @dev Tries to re-enter distribute from inside the (static) split call, then returns a valid split.
contract ReentrantSplit {
    FeeVault public fv;
    bool public reentered;

    function setVault(FeeVault fv_) external {
        fv = fv_;
    }

    function split(bytes32[4] calldata) external returns (uint256, uint256, uint256, uint256) {
        try fv.distribute() {
            reentered = true; // unreachable: state writes under STATICCALL revert
        } catch {}
        return (4500, 3000, 1500, 1000);
    }
}

/// @dev Payout recipient that re-enters its payer on receipt.
contract ReentrantRecipient {
    address public target;
    bytes public payload;
    bool public reentered;
    uint256 public received;

    function arm(address target_, bytes memory payload_) external {
        (target, payload) = (target_, payload_);
    }

    receive() external payable {
        received += msg.value;
        (bool ok,) = target.call(payload);
        if (ok) reentered = true;
    }
}

contract VaultsTest is Deployers {
    using StateLibrary for IPoolManager;

    uint128 constant DEEP = 1000 ether;
    uint160 constant HOOK_FLAGS = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);

    DNAToken token;
    MockRegistry registry;
    MockSplit splitModule;
    FeeVault fv;
    PlatformRevenue pr;
    BuybackBurn bb;
    LiquidityVault lv;
    TestHook hook;
    PoolId pid;
    address safe = makeAddr("safe");
    address gamePot = makeAddr("gamePot");
    address platform = makeAddr("platform");
    address alice = makeAddr("alice");

    function setUp() public {
        vm.warp(1_760_000_000); // realistic clock: cooldowns compare against lastX = 0
        vm.deal(address(this), 1e30);
        deployFreshManagerAndRouters();
        token = new DNAToken(address(this));
        registry = new MockRegistry();
        splitModule = new MockSplit();
        bb = new BuybackBurn(manager, address(this));
        lv = new LiquidityVault(manager, address(this));
        fv = new FeeVault(manager, address(registry), address(bb), address(lv), gamePot, safe);
        pr = new PlatformRevenue(manager, platform);

        TestHook impl = new TestHook(manager, address(token), address(fv), address(pr), address(bb));
        hook = TestHook(address((uint160(1) << 100) | HOOK_FLAGS));
        vm.etch(address(hook), address(impl).code); // all-immutable: runtime code is the whole state

        bb.initialize(address(hook));
        lv.initialize(address(hook));

        key = PoolKey(
            Currency.wrap(address(0)),
            Currency.wrap(address(token)),
            LPFeeLibrary.DYNAMIC_FEE_FLAG,
            1,
            IHooks(address(hook))
        );
        pid = key.toId();
        manager.initialize(key, SQRT_PRICE_1_1);
        token.approve(address(modifyLiquidityRouter), type(uint256).max);
        token.approve(address(swapRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity{value: 1000 ether}(
            key, ModifyLiquidityParams(-60_000, 60_000, int256(uint256(DEEP)), 0), ""
        );
    }

    // ---------- helpers ----------

    function _claims(address a) internal view returns (uint256) {
        return manager.balanceOf(a, 0);
    }

    function _fund(address to, uint256 amount) internal {
        hook.fund{value: amount}(to);
    }

    function _setSplit(uint256 b, uint256 l, uint256 t, uint256 g, uint256 mode) internal {
        registry.set(address(splitModule), [bytes32(b), bytes32(l), bytes32(t), bytes32(g)]);
        splitModule.setMode(mode);
    }

    function _assertSplit(uint256 b, uint256 l, uint256 t, uint256 g) internal view {
        (uint256 b2, uint256 l2, uint256 t2, uint256 g2,) = fv.currentSplit();
        assertEq(b2, b, "buyback");
        assertEq(l2, l, "lp");
        assertEq(t2, t, "treasury");
        assertEq(g2, g, "game");
    }

    function _assertBaseline() internal view {
        (,,,, bool baseline) = fv.currentSplit();
        assertTrue(baseline, "baseline");
        _assertSplit(3500, 3500, 3000, 0);
    }

    function _userBuy(uint256 amount) internal {
        swapRouter.swap{value: amount}(
            key, SwapParams(true, -int256(amount), MIN_PRICE_LIMIT), PoolSwapTest.TestSettings(false, false), ""
        );
    }

    // ---------- test hook sanity ----------

    function test_hook_mintsFeesToVaults() public {
        _userBuy(1 ether);
        assertEq(_claims(address(fv)), 0.02 ether);
        assertEq(_claims(address(pr)), 0.001 ether);
    }

    // ---------- PlatformRevenue ----------

    function test_platform_claimPaysFixedRecipientOnly() public {
        _fund(address(pr), 1 ether);
        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        pr.claim();
        assertEq(platform.balance, 1 ether);
        assertEq(alice.balance, aliceBefore);
        assertEq(_claims(address(pr)), 0);
    }

    function test_platform_claimRevertsWhenEmpty() public {
        vm.expectRevert(PlatformRevenue.NothingToClaim.selector);
        pr.claim();
    }

    function test_platform_reentrantRecipientPaidOnce() public {
        ReentrantRecipient r = new ReentrantRecipient();
        PlatformRevenue pr2 = new PlatformRevenue(manager, address(r));
        r.arm(address(pr2), abi.encodeCall(PlatformRevenue.claim, ()));
        _fund(address(pr2), 1 ether);
        pr2.claim();
        assertEq(r.received(), 1 ether);
        assertFalse(r.reentered());
        assertEq(_claims(address(pr2)), 0);
    }

    function test_platform_unlockCallbackOnlyManager() public {
        vm.expectRevert(PlatformRevenue.NotPoolManager.selector);
        pr.unlockCallback("");
    }

    // ---------- FeeVault: split validity ----------

    function test_split_codelessRegistryIsBaseline() public {
        FeeVault fv2 = new FeeVault(manager, makeAddr("notYetDeployed"), address(bb), address(lv), gamePot, safe);
        (uint256 b, uint256 l, uint256 t, uint256 g, bool baseline) = fv2.currentSplit();
        assertTrue(baseline);
        assertEq(b, 3500);
        assertEq(l, 3500);
        assertEq(t, 3000);
        assertEq(g, 0, "baseline sends nothing to games");
        FeeVault fv3 = new FeeVault(manager, address(0), address(bb), address(lv), gamePot, safe);
        (,,,, baseline) = fv3.currentSplit();
        assertTrue(baseline);
    }

    function test_split_matrix() public {
        _assertBaseline(); // zero module

        _setSplit(5000, 3000, 2000, 0, 0);
        _assertSplit(5000, 3000, 2000, 0);
        _setSplit(2000, 4000, 4000, 0, 0); // all edges
        _assertSplit(2000, 4000, 4000, 0);
        _setSplit(5000, 4000, 1000, 0, 0);
        _assertSplit(5000, 4000, 1000, 0);
        _setSplit(3500, 3000, 2500, 1000, 0); // the launch split
        _assertSplit(3500, 3000, 2500, 1000);
        _setSplit(3000, 2000, 3000, 2000, 0); // games at its upper edge
        _assertSplit(3000, 2000, 3000, 2000);
        _setSplit(2000, 2000, 4000, 2000, 0);
        _assertSplit(2000, 2000, 4000, 2000);

        uint256[4][13] memory bad = [
            [uint256(5000), 5000, 0, 0], // adversarial case: no clamp/renormalize
            [uint256(1999), 5000, 3001, 0],
            [uint256(5001), 2999, 2000, 0],
            [uint256(4000), 1999, 4001, 0],
            [uint256(3000), 5001, 1999, 0],
            [uint256(4500), 4600, 900, 0],
            [uint256(2000), 3900, 4100, 0],
            [uint256(4000), 4000, 2001, 0], // sum 10_001
            [uint256(type(uint256).max), 2000, 1000, 0], // overflow-shaped garbage
            [uint256(3000), 2000, 2999, 2001], // games above 2000
            [uint256(3500), 3000, 2500, 1001], // sum 10_001 via games
            [uint256(3500), 3000, 2500, 999], // sum 9_999 via games
            [uint256(3500), 3000, 2500, type(uint256).max - 8999] // games wraps the sum to 10_000 if unchecked
        ];
        for (uint256 i; i < bad.length; ++i) {
            _setSplit(bad[i][0], bad[i][1], bad[i][2], bad[i][3], 0);
            _assertBaseline();
        }
        _setSplit(5000, 3000, 2000, 0, 1); // revert
        _assertBaseline();
        _setSplit(5000, 3000, 2000, 0, 2); // OOG at the cap
        _assertBaseline();
        _setSplit(5000, 3000, 2000, 0, 3); // short returndata
        _assertBaseline();
        _setSplit(5000, 3000, 2000, 0, 4); // oversized returndata: rejected, never copied
        _assertBaseline();
        registry.set(address(0xBEEF), [bytes32(0), 0, 0, 0]); // code-less module
        _assertBaseline();
    }

    /// Return bomb: the caller pays the module's capped gas, never a copy of its returndata. Old code
    /// (`.staticcall` + `ret.length == 96`) copied all ~116 KB into FeeVault memory: ~+50k gas over this bound.
    function test_split_returnBombCostBounded() public {
        splitModule.setMode(4);
        bytes memory call = abi.encodeCall(MockSplit.split, ([bytes32(0), 0, 0, 0]));
        (bool ok, bytes memory ret) = address(splitModule).staticcall{gas: fv.SPLIT_GAS_CAP()}(call);
        assertTrue(ok, "bomb must fit in the cap, else nothing is returned");
        assertEq(ret.length, 110_400);

        _setSplit(5000, 3000, 2000, 0, 0);
        fv.currentSplit();
        uint256 good = vm.lastFrameGas().gasTotalUsed;
        _setSplit(5000, 3000, 2000, 0, 4);
        fv.currentSplit();
        uint256 bomb = vm.lastFrameGas().gasTotalUsed;
        console.log("currentSplit gas: well-formed module", good, "max bomb", bomb);
        assertLt(bomb, good + fv.SPLIT_GAS_CAP(), "returndata copied into the caller");
        _assertBaseline();
    }

    function testFuzz_split_validIffInBoundsAndExactSum(uint256 b, uint256 l, uint256 t, uint256 g) public {
        b = bound(b, 0, 12_000);
        l = bound(l, 0, 12_000);
        t = bound(t, 0, 12_000);
        g = bound(g, 0, 4_000);
        _setSplit(b, l, t, g, 0);
        bool valid = b >= 2000 && b <= 5000 && l >= 2000 && l <= 5000 && t >= 1000 && t <= 4000 && g <= 2000
            && b + l + t + g == 10_000;
        if (valid) _assertSplit(b, l, t, g);
        else _assertBaseline();
    }

    /// Valid 4-way splits are reachable (the fuzz above rarely hits an exact sum): derive t from the rest.
    function testFuzz_split_validFourWay(uint256 b, uint256 l, uint256 g) public {
        b = bound(b, 2000, 5000);
        l = bound(l, 2000, 5000);
        g = bound(g, 0, 2000);
        if (b + l + g > 9000 || b + l + g < 6000) return; // t would leave [1000, 4000]
        uint256 t = 10_000 - b - l - g;
        _setSplit(b, l, t, g, 0);
        _assertSplit(b, l, t, g);
    }

    function test_split_gasStarvedCallerReverts() public {
        _setSplit(5000, 3000, 2000, 0, 0);
        vm.expectRevert(FeeVault.OutOfGasBudget.selector);
        fv.currentSplit{gas: 60_000}();
    }

    // ---------- FeeVault: distribute ----------

    function testFuzz_distribute_exactSum(uint256 amount, uint256 b, uint256 l, uint256 g) public {
        amount = bound(amount, 0.05 ether, 1e9 ether);
        b = bound(b, 2000, 5000);
        l = bound(l, 2000, 5000);
        g = bound(g, 0, 2000);
        uint256 t = b + l + g <= 10_000 ? 10_000 - b - l - g : 0;
        _setSplit(b, l, t, g, 0);
        if (t < 1000 || t > 4000) (b, l, t, g) = (3500, 3500, 3000, 0);
        _fund(address(fv), amount);

        vm.prank(alice);
        fv.distribute();

        uint256 toBb = _claims(address(bb));
        uint256 toLv = _claims(address(lv));
        uint256 toGame = _claims(gamePot);
        assertEq(toBb, amount * b / 10_000);
        assertEq(toLv, amount * l / 10_000);
        assertEq(toGame, amount * g / 10_000);
        assertEq(safe.balance, amount - toBb - toLv - toGame);
        assertEq(toBb + toLv + toGame + safe.balance, amount, "exact sum");
        assertEq(fv.totalDistributed(), amount);
        assertEq(_claims(address(fv)), 0);
        assertEq(alice.balance, 0);
    }

    function test_distribute_launchSplitAndTotal() public {
        _setSplit(3500, 3000, 2500, 1000, 0);
        _fund(address(fv), 1 ether);
        fv.distribute();
        assertEq(_claims(address(bb)), 0.35 ether);
        assertEq(_claims(address(lv)), 0.3 ether);
        assertEq(safe.balance, 0.25 ether);
        assertEq(_claims(gamePot), 0.1 ether, "game share moves as a 6909 claim");
        _fund(address(fv), 0.5 ether);
        registry.set(address(0), [bytes32(0), 0, 0, 0]); // rollback: games off
        fv.distribute();
        assertEq(_claims(gamePot), 0.1 ether, "baseline sends nothing to games");
        assertEq(fv.totalDistributed(), 1.5 ether);
    }

    function test_distribute_belowMinimumReverts() public {
        _fund(address(fv), 0.05 ether - 1);
        vm.expectRevert(FeeVault.BelowMinimum.selector);
        fv.distribute();
    }

    function test_distribute_maliciousModuleCannotDoubleSpend() public {
        ReentrantSplit m = new ReentrantSplit();
        m.setVault(fv);
        registry.set(address(m), [bytes32(0), 0, 0, 0]);
        _fund(address(fv), 1 ether);
        fv.distribute();
        assertEq(_claims(address(bb)), 0.45 ether);
        assertEq(_claims(address(lv)), 0.3 ether);
        assertEq(safe.balance, 0.15 ether);
        assertEq(_claims(gamePot), 0.1 ether);
        assertFalse(m.reentered());
    }

    function test_distribute_reentrantSafePaidOnce() public {
        ReentrantRecipient r = new ReentrantRecipient();
        FeeVault fv2 = new FeeVault(manager, address(registry), address(bb), address(lv), gamePot, address(r));
        r.arm(address(fv2), abi.encodeCall(FeeVault.distribute, ()));
        _fund(address(fv2), 1 ether);
        fv2.distribute();
        assertEq(r.received(), 0.3 ether);
        assertFalse(r.reentered());
        assertEq(_claims(address(bb)) + _claims(address(lv)) + r.received(), 1 ether);
        assertEq(_claims(address(fv2)), 0);
    }

    function test_distribute_unlockCallbackOnlyManager() public {
        vm.expectRevert(FeeVault.NotPoolManager.selector);
        fv.unlockCallback(abi.encode(uint256(1)));
    }

    // ---------- initialize (front-run proof) ----------

    function test_initialize_onlyInitializerOnce() public {
        BuybackBurn b2 = new BuybackBurn(manager, address(this));
        LiquidityVault l2 = new LiquidityVault(manager, address(this));
        PoolBound[2] memory vaults = [PoolBound(b2), PoolBound(l2)];
        for (uint256 i; i < 2; ++i) {
            vm.prank(alice);
            vm.expectRevert(PoolBound.NotInitializer.selector);
            vaults[i].initialize(address(hook));

            vm.expectRevert(PoolBound.WrongHook.selector);
            vaults[i].initialize(address(0));

            TestHook other =
                new TestHook(IPoolManager(address(0xdead)), address(token), address(0), address(0), address(0));
            vm.expectRevert(PoolBound.WrongHook.selector);
            vaults[i].initialize(address(other));

            vaults[i].initialize(address(hook));
            assertEq(vaults[i].hook(), address(hook));
            assertEq(vaults[i].token(), address(token));

            vm.expectRevert(PoolBound.AlreadyInitialized.selector);
            vaults[i].initialize(address(hook));
        }
    }

    function test_uninitializedVaultsCannotAct() public {
        BuybackBurn b2 = new BuybackBurn(manager, address(this));
        _fund(address(b2), 1 ether);
        vm.expectRevert(PoolBound.NotInitialized.selector);
        b2.process();
        LiquidityVault l2 = new LiquidityVault(manager, address(this));
        _fund(address(l2), 1 ether);
        vm.expectRevert(PoolBound.NotInitialized.selector);
        l2.add();
    }

    // ---------- LiquidityVault ----------

    function _expectedRange(uint24 width) internal view returns (int24 lower, int24 upper) {
        (, int24 tick,,) = manager.getSlot0(pid);
        lower = tick + 2;
        int256 u = int256(lower) + int256(uint256(width));
        upper = u > TickMath.MAX_TICK ? TickMath.MAX_TICK : int24(u);
    }

    function testFuzz_lp_addMath(uint256 budget, uint256 move) public {
        budget = bound(budget, 1e9, 1e6 ether);
        uint24 width = lv.WIDTH();
        move = bound(move, 0, 50 ether);
        if (move != 0) _userBuy(move); // vary the starting tick
        _fund(address(lv), budget);

        (int24 lower, int24 upper) = _expectedRange(width);
        uint160 sa = TickMath.getSqrtPriceAtTick(lower);
        uint160 sb = TickMath.getSqrtPriceAtTick(upper);
        uint128 L = LiquidityAmounts.getLiquidityForAmount0(sa, sb, budget);
        uint256 need = SqrtPriceMath.getAmount0Delta(sa, sb, L, true);
        uint128 poolLiqBefore = manager.getLiquidity(pid);

        lv.add(); // unlock would revert CurrencyNotSettled on any leftover delta

        assertLe(need, budget);
        assertEq(_claims(address(lv)), budget - need, "burned exactly need");
        (uint128 posL,,) = manager.getPositionInfo(pid, address(lv), lower, upper, bytes32(0));
        assertEq(posL, L, "position liquidity");
        assertEq(manager.getLiquidity(pid), poolLiqBefore, "range above price: active liquidity unchanged");
        assertEq(lv.positions(), 1);
    }

    function testFuzz_lp_liquidityMonotonic(uint256 a, uint256 b) public {
        a = bound(a, 1e12, 1000 ether);
        b = bound(b, 1e12, 1000 ether);
        uint24 w1 = lv.WIDTH();
        uint24 w2 = w1;

        _fund(address(lv), a);
        (int24 l1, int24 u1) = _expectedRange(w1);
        lv.add();
        (uint128 p1,,) = manager.getPositionInfo(pid, address(lv), l1, u1, bytes32(0));
        assertGt(p1, 0);

        _userBuy(1 ether); // price moves; vault's position untouched
        vm.warp(block.timestamp + 4 hours);
        _fund(address(lv), b);
        (int24 l2, int24 u2) = _expectedRange(w2);
        lv.add();
        (uint128 p1After,,) = manager.getPositionInfo(pid, address(lv), l1, u1, bytes32(0));
        (uint128 p2,,) = manager.getPositionInfo(pid, address(lv), l2, u2, bytes32(uint256(1)));
        assertEq(p1After, p1, "first position never decreases");
        assertGt(p2, 0);
        assertEq(lv.positions(), 2);
    }

    function test_lp_cooldown() public {
        _fund(address(lv), 2 ether);
        lv.add();
        vm.expectRevert(LiquidityVault.CoolingDown.selector);
        lv.add();
        vm.warp(block.timestamp + 4 hours);
        _fund(address(lv), 1 ether);
        lv.add();
    }

    function test_lp_noWithdrawPath() public {
        _fund(address(lv), 1 ether);
        lv.add();
        string[8] memory sigs = [
            "withdraw()",
            "withdraw(uint256)",
            "remove(uint256)",
            "decreaseLiquidity(uint256,uint128)",
            "collect(uint256)",
            "sweep(address)",
            "execute(address,bytes)",
            "multicall(bytes[])"
        ];
        for (uint256 i; i < sigs.length; ++i) {
            (bool ok,) = address(lv).call(abi.encodeWithSignature(sigs[i]));
            assertFalse(ok, sigs[i]);
        }
        (bool sent,) = address(lv).call{value: 1}("");
        assertFalse(sent, "no receive");
        vm.expectRevert(PoolBound.NotPoolManager.selector);
        lv.unlockCallback(abi.encode(uint24(1)));
    }

    /// @dev The external surface is exactly the enumerated set; none of it decreases liquidity.
    function testFuzz_lp_unknownSelectorsRevert(bytes4 sel) public {
        bytes4[10] memory known = [
            lv.add.selector,
            lv.unlockCallback.selector,
            lv.initialize.selector,
            lv.poolManager.selector,
            lv.initializer.selector,
            lv.hook.selector,
            lv.token.selector,
            lv.COOLDOWN.selector,
            lv.lastAdd.selector,
            lv.positions.selector
        ];
        for (uint256 i; i < known.length; ++i) {
            vm.assume(sel != known[i]);
        }
        (bool ok,) = address(lv).call(abi.encodePacked(sel, new bytes(128)));
        assertFalse(ok);
    }

    // ---------- end to end ----------

    function test_e2e_feesToBuybackAndLiquidity() public {
        for (uint256 i; i < 5; ++i) {
            _userBuy(1 ether);
        }
        assertEq(_claims(address(fv)), 0.1 ether);
        fv.distribute();
        assertEq(_claims(address(bb)), 0.035 ether);
        assertEq(_claims(address(lv)), 0.035 ether);
        assertEq(safe.balance, 0.03 ether);
        uint256 supply = token.totalSupply();
        bb.process();
        assertLt(token.totalSupply(), supply);
        lv.add();
        assertLt(_claims(address(lv)), 0.035 ether);
        pr.claim();
        assertEq(platform.balance, 0.005 ether);
    }
}
