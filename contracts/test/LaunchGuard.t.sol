// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm, console} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DNAHook} from "../src/DNAHook.sol";
import {DNAToken} from "../src/DNAToken.sol";
import {Route, IDNAHook} from "../src/interfaces/IDNA.sol";
import {Ret} from "./DNAHook.t.sol";

/// Opens the pool, adds liquidity and buys (zero or more times), all in ONE transaction: the shape of Bootstrap's
/// launch.
contract Launcher {
    function launch(
        IPoolManager m,
        PoolModifyLiquidityTest lp,
        PoolSwapTest sw,
        PoolKey calldata key,
        uint160 sqrtP,
        ModifyLiquidityParams calldata pos,
        int256[] calldata buys
    ) external payable returns (BalanceDelta[] memory d) {
        m.initialize(key, sqrtP);
        IERC20(Currency.unwrap(key.currency1)).approve(address(lp), type(uint256).max);
        lp.modifyLiquidity{value: address(this).balance}(key, pos, "");
        d = new BalanceDelta[](buys.length);
        for (uint256 i; i < buys.length; ++i) {
            d[i] = sw.swap{value: address(this).balance}(
                key,
                SwapParams(true, buys[i], TickMath.MIN_SQRT_PRICE + 1),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ""
            );
        }
    }

    /// The same, then one more position added after the buys: liquidity inside the initialization transaction.
    function launchAndAdd(
        IPoolManager m,
        PoolModifyLiquidityTest lp,
        PoolSwapTest sw,
        PoolKey calldata key,
        uint160 sqrtP,
        ModifyLiquidityParams calldata pos,
        int256[] calldata buys
    ) external payable {
        this.launch(m, lp, sw, key, sqrtP, pos, buys);
        (, int24 tick,,) = StateLibrary.getSlot0(m, PoolIdLibrary.toId(key));
        lp.modifyLiquidity{value: 100 ether}(
            key, ModifyLiquidityParams(tick + 1, tick + 200, 1e21, bytes32(uint256(1))), ""
        );
    }

    receive() external payable {}
}

/// The cycling attack (security review): buy, add ETH-only liquidity just above spot, sell into it, remove, repeat.
contract Cycler {
    function run(PoolSwapTest sw, PoolModifyLiquidityTest lp, PoolKey calldata key, uint256 dna, uint256 rounds)
        external
        payable
    {
        IERC20 t = IERC20(Currency.unwrap(key.currency1));
        t.approve(address(sw), type(uint256).max);
        t.approve(address(lp), type(uint256).max);
        PoolSwapTest.TestSettings memory s = PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
        IPoolManager m = sw.manager();
        for (uint256 i; i < rounds; ++i) {
            sw.swap{value: 200 ether}(key, SwapParams(true, int256(dna), TickMath.MIN_SQRT_PRICE + 1), s, "");
            (, int24 tick,,) = StateLibrary.getSlot0(m, PoolIdLibrary.toId(key));
            ModifyLiquidityParams memory pos = ModifyLiquidityParams(tick + 1, tick + 200, 1e24, bytes32(i));
            lp.modifyLiquidity{value: 200 ether}(key, pos, "");
            sw.swap(key, SwapParams(false, -int256(dna), TickMath.MAX_SQRT_PRICE - 1), s, "");
            pos.liquidityDelta = -1e24;
            lp.modifyLiquidity(key, pos, "");
        }
    }

    receive() external payable {}
}

/// Several exact-output buys in ONE transaction.
contract MultiBuy {
    function buy(PoolSwapTest sw, PoolKey calldata key, int256 each, uint256 n) external payable {
        for (uint256 i; i < n; ++i) {
            sw.swap{value: address(this).balance}(
                key,
                SwapParams(true, each, TickMath.MIN_SQRT_PRICE + 1),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ""
            );
        }
    }

    receive() external payable {}
}

/// Exact-output buy of `dna`, then exact-input sell of the same `dna`, in ONE transaction: net zero DNA.
contract RoundTrip {
    function run(PoolSwapTest sw, PoolKey calldata key, uint256 dna) external payable {
        PoolSwapTest.TestSettings memory t = PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
        sw.swap{value: address(this).balance}(key, SwapParams(true, int256(dna), TickMath.MIN_SQRT_PRICE + 1), t, "");
        IERC20(Currency.unwrap(key.currency1)).approve(address(sw), dna);
        sw.swap(key, SwapParams(false, -int256(dna), TickMath.MAX_SQRT_PRICE - 1), t, "");
    }

    receive() external payable {}
}

/// Launch guard: the 9-block launch tax (90% → 10%, all of the project share to buyback-and-burn) and, until 4 minutes
/// after launch, the caps: net 2% of the original supply out of the pool per block (from block 0) and net 1% per
/// sending wallet (tx.origin; counted from block 0, enforced from block 4). The launch buy and buybacks are exempt.
contract LaunchTaxCapTest is Test, Deployers {
    DNAHook hook;
    DNAToken token;
    PoolSwapTest bbRouter; // stands in for BuybackBurn
    Launcher launcher;
    address feeVault = makeAddr("feeVault");
    address platformRevenue = makeAddr("platformRevenue");
    uint24 PF;
    uint256 launchBlock;
    uint256 launched;
    uint256 constant WALLET_CAP = 10_000_000 ether; // 1% of supply
    uint256 constant BLOCK_CAP = 20_000_000 ether; // 2% of supply
    address constant ORIGIN = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38; // forge's default tx.origin
    int24 constant OPEN_TICK = 138_000; // ~980k DNA per ETH: the cap costs ~10 ETH

    function setUp() public {
        vm.warp(1_760_000_000);
        vm.roll(100);
        deployFreshManagerAndRouters();
        bbRouter = new PoolSwapTest(manager);
        token = new DNAToken(address(this));
        launcher = new Launcher();
        address at = address(uint160(0x4444 << 144) | uint160(Hooks.ALL_HOOK_MASK));
        deployCodeTo(
            "DNAHook.sol:DNAHook",
            abi.encode(manager, address(token), address(this), feeVault, platformRevenue, address(bbRouter)),
            at
        );
        hook = DNAHook(at);
        PF = hook.PLATFORM_FEE();
        key = hook.poolKey();
        vm.deal(address(this), 1e30);
        token.approve(address(swapRouter), type(uint256).max);
        token.approve(address(bbRouter), type(uint256).max);
        token.transfer(address(launcher), 400_000_000 ether);
    }

    // ---------------- helpers ----------------

    /// Open + liquidity (+ an optional exact-output buy of `buy` DNA) in one transaction.
    function _launch(int256 buy) internal returns (BalanceDelta d) {
        int256[] memory buys = new int256[](buy != 0 ? 1 : 0);
        if (buy != 0) buys[0] = buy;
        BalanceDelta[] memory ds = _launch(buys);
        if (buy != 0) d = ds[0];
    }

    function _launch(int256[] memory buys) internal returns (BalanceDelta[] memory d) {
        d = launcher.launch{value: 2_000 ether}(
            manager,
            modifyLiquidityRouter,
            swapRouter,
            key,
            TickMath.getSqrtPriceAtTick(OPEN_TICK),
            ModifyLiquidityParams({tickLower: 120_000, tickUpper: 156_000, liquidityDelta: 6e23, salt: 0}),
            buys
        );
        (launchBlock, launched) = (block.number, block.timestamp);
    }

    function _swap(PoolSwapTest r, bool zeroForOne, int256 amt) internal returns (BalanceDelta) {
        return r.swap{value: zeroForOne ? 200 ether : 0}(
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

    function _claims() internal view returns (uint256 vault, uint256 burn, uint256 platform) {
        return (
            manager.balanceOf(feeVault, 0),
            manager.balanceOf(address(bbRouter), 0),
            manager.balanceOf(platformRevenue, 0)
        );
    }

    /// Swap; return the project share minted to FeeVault, to BuybackBurn, the platform share, and the delta.
    function _fees(PoolSwapTest r, bool zeroForOne, int256 amt)
        internal
        returns (uint256 v, uint256 b, uint256 q, BalanceDelta d)
    {
        (uint256 v0, uint256 b0, uint256 q0) = _claims();
        d = _swap(r, zeroForOne, amt);
        (v, b, q) = _claims();
        (v, b, q) = (v - v0, b - b0, q - q0);
    }

    function _hookError(bytes4 err) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            IHooks.afterSwap.selector,
            abi.encodeWithSelector(err),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function _blockCapError() internal view returns (bytes memory) {
        return _hookError(DNAHook.LaunchCapExceeded.selector);
    }

    function _walletCapError() internal view returns (bytes memory) {
        return _hookError(DNAHook.WalletCapExceeded.selector);
    }

    /// Exact-output buy of `dna` DNA (dna > 0) or exact-input sell of -dna DNA (dna < 0), sent by EOA `who` (as both
    /// msg.sender and tx.origin).
    function _as(address who, int256 dna) internal returns (BalanceDelta d) {
        if (who.balance < 300 ether) vm.deal(who, 1_000 ether);
        if (dna < 0 && token.allowance(who, address(swapRouter)) == 0) {
            token.transfer(who, 100_000_000 ether);
            vm.prank(who, who);
            token.approve(address(swapRouter), type(uint256).max);
        }
        vm.prank(who, who);
        d = _swap(swapRouter, dna > 0, dna);
    }

    function _at(uint256 k) internal {
        vm.roll(launchBlock + k);
    }

    /// The launch tax at k blocks after the pool's first block, written independently of the hook: 90% − 10 points × k.
    function _tax(uint256 k) internal pure returns (uint256) {
        return k < 9 ? 900_000 - k * 100_000 : 0;
    }

    // ---------------- launch tax ----------------

    function test_tax_constants() public view {
        assertEq(hook.LAUNCH_TAX(), 900_000);
        assertEq(hook.LAUNCH_TAX_STEP(), 100_000);
        assertEq(hook.LAUNCH_TAX_BLOCKS(), 9);
        assertEq(hook.LAUNCH_CAP_START(), 4);
        assertEq(hook.LAUNCH_CAP_WINDOW(), 4 minutes);
        assertEq(hook.LAUNCH_BLOCK_CAP(), BLOCK_CAP);
        assertEq(hook.LAUNCH_WALLET_CAP(), WALLET_CAP);
        assertEq(WALLET_CAP * 100, token.totalSupply(), "1% of supply");
    }

    /// Blocks 0..8 after launch: buys and sells pay 90%..10% project + 0.3% platform, the project share minted to
    /// BuybackBurn; block 9 on: the normal (decaying) fee, to FeeVault.
    function test_tax_ladderByBlock() public {
        _launch(0);
        for (uint256 k; k <= 11; ++k) {
            vm.roll(launchBlock + k);
            uint256 tax = _tax(k);
            uint256 want = tax != 0 ? tax : hook.LAUNCH_PROJECT_FEE(); // the clock has not moved: decay at t = 0
            assertEq(hook.baselineFee(), want, "baselineFee = the effective project fee");

            // exact-in buy: fee on the ETH paid
            (uint256 v, uint256 b, uint256 q,) = _fees(swapRouter, true, -0.1 ether);
            assertEq(tax != 0 ? b : v, 0.1 ether * want / 1e6, "buy: project");
            assertEq(tax != 0 ? v : b, 0, "buy: nothing to the other one");
            assertEq(q, 0.1 ether * uint256(PF) / 1e6, "buy: platform unchanged");

            // exact-in sell: fee on the pool's ETH out
            BalanceDelta d;
            (v, b, q, d) = _fees(swapRouter, false, -10_000 ether);
            uint256 gross = uint256(int256(d.amount0())) + v + b + q;
            assertEq(tax != 0 ? b : v, gross * want / 1e6, "sell: project");
            assertEq(tax != 0 ? v : b, 0, "sell: nothing to the other one");
            assertGe(q, gross * PF / 1e6, "sell: platform floor");
            assertLe(q, gross * PF / 1e6 + 2, "sell: platform ceiling");
        }
    }

    /// All four paths, any ladder block: project = floor(gross × tax / 1e6) to BuybackBurn, platform 0.3%, never
    /// under-charged.
    function testFuzz_tax_allPaths(uint256 k, uint256 amt, bool zeroForOne, bool exactIn) public {
        _launch(0);
        k = bound(k, 0, 8);
        amt = bound(amt, 1e6, zeroForOne && !exactIn ? 1_000_000 ether : 1 ether); // DNA out (exact-out buy) or ETH
        vm.roll(launchBlock + k);
        uint256 tax = _tax(k);
        (uint256 v, uint256 b, uint256 q, BalanceDelta d) =
            _fees(swapRouter, zeroForOne, exactIn ? -int256(amt) : int256(amt));
        int256 e = d.amount0();
        uint256 gross = e < 0 ? uint256(-e) : uint256(e) + b + q;
        assertEq(v, 0, "nothing to FeeVault");
        assertEq(b, gross * tax / 1e6, "project = floor(gross*tax/1e6)");
        assertGe(q, gross * PF / 1e6, "platform floor");
        assertLe(q, gross * PF / 1e6 + 2, "platform ceiling");
        assertGe((b + q) * 1e6 + 2e6, gross * (tax + PF), "never under-charged beyond rounding");
    }

    /// The ladder calls no module (a failing module would tick the breaker; an active one would set the fee).
    function test_tax_noModuleCalls() public {
        _launch(0);
        Route memory r;
        r.active = address(new Ret(hex"01")); // fails: would tick the breaker
        r.shadow = address(new Ret(abi.encode(uint256(40_000))));
        hook.setRoute(r);
        vm.recordLogs();
        (, uint256 b,,) = _fees(swapRouter, true, -1 ether);
        assertEq(b, 0.9 ether, "90% in the first block");
        (uint32 n,) = hook.breaker();
        assertEq(n, 0, "no module call");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != IDNAHook.ShadowFee.selector, "no shadow call");
        }
        vm.roll(launchBlock + 9);
        _fees(swapRouter, true, -1 ether);
        (n,) = hook.breaker();
        assertEq(n, 1, "after the ladder the route is asked again");
    }

    /// BuybackBurn pays no project fee during the ladder either.
    function test_tax_buybackExempt() public {
        _launch(0);
        (uint256 v, uint256 b, uint256 q,) = _fees(bbRouter, true, -1 ether);
        assertEq(v + b, 0, "no project fee");
        assertEq(q, 1 ether * uint256(PF) / 1e6, "platform only");
    }

    // ---------------- launch transaction ----------------

    /// The buy in the initialization transaction pays the normal (3%) fee to FeeVault and is neither capped nor
    /// counted; the next transaction in the same block pays the 90% tax.
    function test_launchTx_normalFeeUncapped() public {
        uint256 v0 = manager.balanceOf(feeVault, 0);
        BalanceDelta d = _launch(int256(5 * WALLET_CAP)); // 5% of supply in the launch transaction
        assertEq(uint256(int256(d.amount1())), 5 * WALLET_CAP, "uncapped");
        uint256 paid = uint256(-int256(d.amount0()));
        assertEq(manager.balanceOf(feeVault, 0) - v0, paid * hook.LAUNCH_PROJECT_FEE() / 1e6, "normal fee");
        assertEq(manager.balanceOf(address(bbRouter), 0), 0, "nothing to the burn");
        assertEq(hook.walletBought(ORIGIN), 0, "the launch buy is not counted");

        (uint256 v, uint256 b,,) = _fees(swapRouter, true, -1 ether); // same block, new transaction
        assertEq(v, 0);
        assertEq(b, 0.9 ether, "a second transaction in the launch block pays 90%");
    }

    /// The exemption covers exactly one swap (Bootstrap's launch buy): a second swap in the initialization
    /// transaction pays the 90% tax ...
    function test_launchTx_secondSwapTaxed() public {
        int256[] memory buys = new int256[](2);
        (buys[0], buys[1]) = (int256(5 * WALLET_CAP), -1 ether);
        _launch(buys);
        assertEq(manager.balanceOf(address(bbRouter), 0), 0.9 ether, "the second swap pays 90% to the burn");
    }

    /// ... is capped by the block's 2% ...
    function test_launchTx_secondSwapCapped() public {
        int256[] memory buys = new int256[](2);
        (buys[0], buys[1]) = (int256(5 * WALLET_CAP), int256(BLOCK_CAP + 1));
        vm.expectRevert(_blockCapError());
        this.launchExternal(buys);
        (buys[0], buys[1]) = (int256(5 * WALLET_CAP), int256(BLOCK_CAP));
        _launch(buys);
        vm.expectRevert(_blockCapError());
        _as(makeAddr("next"), 1); // the launch block is full
    }

    function launchExternal(int256[] memory buys) external {
        _launch(buys);
    }

    /// ... and counts toward its wallet's cap.
    function test_launchTx_secondSwapCounted() public {
        int256[] memory buys = new int256[](2);
        (buys[0], buys[1]) = (int256(5 * WALLET_CAP), int256(WALLET_CAP / 2));
        _launch(buys);
        assertEq(hook.walletBought(ORIGIN), WALLET_CAP / 2, "only the second swap is counted");
        _at(4);
        vm.expectRevert(_walletCapError());
        _swap(swapRouter, true, int256(WALLET_CAP / 2 + 1));
        _swap(swapRouter, true, int256(WALLET_CAP / 2));
    }

    // ---------------- caps: when ----------------

    /// Blocks 0..3: the block cap (2%) is enforced, the wallet cap is not. A 5% buy at k = 3 reverts; 2% passes, at
    /// the 60% tax.
    function test_cap_blocks0to3BlockCapOnly() public {
        _launch(0);
        _at(3);
        vm.expectRevert(_blockCapError());
        _swap(swapRouter, true, int256(5 * WALLET_CAP));
        (uint256 v, uint256 b,, BalanceDelta d) = _fees(swapRouter, true, int256(BLOCK_CAP));
        assertEq(uint256(int256(d.amount1())), BLOCK_CAP);
        assertEq(b, uint256(-int256(d.amount0())) * 600_000 / 1e6, "60% to the burn");
        assertEq(v, 0);
        assertEq(hook.walletBought(ORIGIN), BLOCK_CAP, "2% from one wallet: over its 1%, not enforced before block 4");
        vm.expectRevert(_blockCapError());
        _as(makeAddr("other"), 1);
    }

    /// Every block k = 0..3: more than 2% in one block reverts, across wallets; exactly 2% passes.
    function test_cap_blocks0to3Each() public {
        _launch(0);
        for (uint256 k; k < 4; ++k) {
            _at(k);
            _as(makeAddr(string.concat("a", vm.toString(k))), int256(WALLET_CAP * 3 / 2));
            vm.expectRevert(_blockCapError());
            _as(makeAddr(string.concat("b", vm.toString(k))), int256(WALLET_CAP / 2 + 1));
            _as(makeAddr(string.concat("b", vm.toString(k))), int256(WALLET_CAP / 2));
        }
    }

    /// k = 4 (50% tax) enforces both caps.
    function test_cap_k4EnforcesBoth() public {
        _launch(0);
        _at(4);
        vm.expectRevert(_walletCapError());
        _as(makeAddr("w1"), int256(WALLET_CAP + 1));
        _as(makeAddr("w1"), int256(WALLET_CAP));
        _as(makeAddr("w2"), int256(WALLET_CAP));
        vm.expectRevert(_blockCapError());
        _as(makeAddr("w3"), 1);
    }

    function test_cap_endsAt4Minutes() public {
        _launch(0);
        _at(9);
        vm.warp(launched + 4 minutes - 1);
        vm.expectRevert(_walletCapError());
        _swap(swapRouter, true, int256(WALLET_CAP + 1));
        vm.warp(launched + 4 minutes);
        _swap(swapRouter, true, int256(3 * WALLET_CAP));
        _swap(swapRouter, true, int256(3 * WALLET_CAP)); // same block, same wallet: still fine
    }

    // ---------------- caps: per wallet (tx.origin) ----------------

    /// Exact-input buys are measured by the DNA they deliver too.
    function test_cap_exactInput() public {
        _launch(0);
        _at(9);
        vm.expectRevert(_walletCapError());
        _swap(swapRouter, true, -20 ether); // ~19M DNA
        _swap(swapRouter, true, -5 ether);
    }

    /// Buys in blocks 0..3 count toward the wallet cap enforced from block 4.
    function test_cap_earlyBuysCount() public {
        _launch(0);
        address w = makeAddr("early");
        _at(1);
        _as(w, int256(WALLET_CAP * 6 / 10));
        assertEq(hook.walletBought(w), WALLET_CAP * 6 / 10);
        _at(4);
        vm.expectRevert(_walletCapError());
        _as(w, int256(WALLET_CAP * 5 / 10));
        _as(w, int256(WALLET_CAP * 4 / 10));
    }

    /// A wallet that bought 6% early cannot buy again inside the window, but it can sell; after the window it can buy.
    function test_cap_bigEarlyBuyerCanOnlySell() public {
        _launch(0);
        address w = makeAddr("big");
        for (uint256 k = 1; k <= 3; ++k) {
            _at(k);
            _as(w, int256(BLOCK_CAP)); // 2% a block: 6% in all
        }
        _at(4);
        vm.expectRevert(_walletCapError());
        _as(w, 1);
        vm.prank(w, w);
        token.approve(address(swapRouter), type(uint256).max);
        vm.prank(w, w);
        _swap(swapRouter, false, -int256(WALLET_CAP)); // sells its own DNA
        assertEq(hook.walletBought(w), 6 * WALLET_CAP, "gross: sells do not lower it");
        vm.expectRevert(_walletCapError());
        _as(w, 1);
        vm.warp(launched + 4 minutes);
        _as(w, int256(WALLET_CAP));
    }

    /// One wallet, several transactions in different blocks: the cap is on its running net, not per block.
    function test_cap_walletAcrossBlocks() public {
        _launch(0);
        address w = makeAddr("w");
        _at(4);
        _as(w, int256(WALLET_CAP * 6 / 10));
        _at(5);
        _as(w, int256(WALLET_CAP * 4 / 10));
        _at(6);
        vm.expectRevert(_walletCapError());
        _as(w, 1);
    }

    /// Several small buys from one contract in ONE transaction: limited by the origin's cap.
    function test_cap_multiSwapOneTx() public {
        _launch(0);
        _at(9);
        MultiBuy mb = new MultiBuy();
        vm.expectRevert(_walletCapError());
        mb.buy{value: 200 ether}(swapRouter, key, int256(WALLET_CAP / 4), 5);
        mb.buy{value: 200 ether}(swapRouter, key, int256(WALLET_CAP / 4), 4); // exactly 1%
        assertEq(hook.walletBought(ORIGIN), WALLET_CAP);
    }

    /// Sells lower the origin's net (floored at 0: selling more than bought earns no room).
    /// Gross: a wallet that bought 1% and sold it all cannot buy again inside the window (no inventory recycling).
    function test_cap_walletIsGross() public {
        _launch(0);
        address w = makeAddr("w");
        _at(4);
        _as(w, int256(WALLET_CAP));
        vm.prank(w, w);
        token.approve(address(swapRouter), type(uint256).max);
        vm.prank(w, w);
        _swap(swapRouter, false, -int256(WALLET_CAP)); // sells all of it
        assertEq(hook.walletBought(w), WALLET_CAP, "sells do not lower it");
        _at(5);
        vm.expectRevert(_walletCapError());
        _as(w, 1);
        vm.warp(launched + 4 minutes);
        _as(w, int256(WALLET_CAP)); // after the window
    }

    // ---------------- caps: per block ----------------

    /// Different origins share the block's 2%: the third 1% buyer in a block reverts; next block it passes.
    function test_cap_blockSharedByOrigins() public {
        _launch(0);
        _at(9);
        _as(makeAddr("a"), int256(WALLET_CAP));
        _as(makeAddr("b"), int256(WALLET_CAP));
        vm.expectRevert(_blockCapError());
        _as(makeAddr("c"), int256(WALLET_CAP));
        _at(10);
        _as(makeAddr("c"), int256(WALLET_CAP));
    }

    /// A round trip (buy 1%, sell it back) in one transaction leaves both nets at 0: two other wallets can still buy
    /// 1% each in the same block.
    function test_cap_roundTripDoesNotBlockTheBlock() public {
        _launch(0);
        _at(9);
        RoundTrip rt = new RoundTrip();
        address g = makeAddr("griefer");
        vm.deal(g, 1_000 ether);
        vm.prank(g, g);
        rt.run{value: 200 ether}(swapRouter, key, WALLET_CAP);
        assertEq(hook.walletBought(g), WALLET_CAP, "gross");
        _as(makeAddr("a"), int256(WALLET_CAP));
        _as(makeAddr("b"), int256(WALLET_CAP));
        vm.expectRevert(_blockCapError());
        _as(makeAddr("c"), 1);
    }

    /// A sell frees block room; a sell first in a block (or after a block change) earns none.
    function test_cap_blockNetFloorAndStale() public {
        _launch(0);
        _at(9);
        _as(makeAddr("a"), int256(WALLET_CAP));
        _at(10);
        _swap(swapRouter, false, -int256(5 * WALLET_CAP)); // first in the block: nothing to subtract from
        _as(makeAddr("b"), int256(WALLET_CAP));
        _as(makeAddr("c"), int256(WALLET_CAP));
        vm.expectRevert(_blockCapError());
        _as(makeAddr("d"), 1);
        _swap(swapRouter, false, -int256(WALLET_CAP / 2)); // frees half a percent
        _as(makeAddr("d"), int256(WALLET_CAP / 2));
        vm.expectRevert(_blockCapError());
        _as(makeAddr("e"), 1);
    }

    /// Sells never revert on a cap, even with the block and the wallet at their caps.
    function test_cap_sellsNeverCapped() public {
        _launch(0);
        _at(4);
        _swap(swapRouter, true, int256(WALLET_CAP));
        _as(makeAddr("b"), int256(WALLET_CAP));
        _swap(swapRouter, false, -int256(5 * WALLET_CAP)); // exact-in sell of 5% of supply
        _swap(swapRouter, false, 10 ether); // exact-out sell
    }

    // ---------------- no new liquidity inside the window ----------------

    /// Adds ETH-only liquidity just above spot (reverting with LiquidityLocked when `locked`).
    function _addAbove(PoolModifyLiquidityTest r, uint256 eth, bool locked) internal {
        (, int24 tick,,) = StateLibrary.getSlot0(manager, PoolIdLibrary.toId(key));
        if (locked) vm.expectRevert(_lockedError());
        r.modifyLiquidity{value: eth}(
            key, ModifyLiquidityParams({tickLower: tick + 1, tickUpper: tick + 200, liquidityDelta: 1e21, salt: 0}), ""
        );
    }

    /// Inside the window nobody adds liquidity (any block); removing is never blocked; after it adding works again.
    function test_liquidity_lockedInWindow() public {
        _launch(0);
        _at(9);
        _addAbove(modifyLiquidityRouter, 100 ether, true);
        vm.warp(launched + 4 minutes - 1);
        _addAbove(modifyLiquidityRouter, 100 ether, true);
        vm.warp(launched + 4 minutes);
        _addAbove(modifyLiquidityRouter, 100 ether, false);
        (, int24 tick,,) = StateLibrary.getSlot0(manager, PoolIdLibrary.toId(key));
        modifyLiquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: tick + 1, tickUpper: tick + 200, liquidityDelta: -1e21, salt: 0}), ""
        );
    }

    /// The initialization transaction adds liquidity freely (Bootstrap's two positions): the Launcher adds after a buy
    /// in the same transaction, then another transaction cannot.
    function test_liquidity_initTxAllowed() public {
        int256[] memory buys = new int256[](1);
        buys[0] = int256(WALLET_CAP);
        launcher.launchAndAdd{value: 2_000 ether}(
            manager,
            modifyLiquidityRouter,
            swapRouter,
            key,
            TickMath.getSqrtPriceAtTick(OPEN_TICK),
            ModifyLiquidityParams({tickLower: 120_000, tickUpper: 156_000, liquidityDelta: 6e23, salt: 0}),
            buys
        );
        (launchBlock, launched) = (block.number, block.timestamp);
        _addAbove(modifyLiquidityRouter, 100 ether, true);
    }

    /// The cycling attack: buy 1%, add an ETH-only position just above spot, sell the DNA into it (lowering the
    /// nets), remove it (the DNA comes back uncounted), repeat, all in one transaction. The add reverts in the window.
    function test_liquidity_cyclingAttackFails() public {
        _launch(0);
        _at(9);
        Cycler cy = new Cycler();
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        vm.expectRevert(_lockedError());
        cy.run{value: 500 ether}(swapRouter, lp, key, WALLET_CAP, 3);
    }

    function _lockedError() internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            IHooks.beforeAddLiquidity.selector,
            abi.encodeWithSelector(DNAHook.LiquidityLocked.selector),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    // ---------------- exemptions ----------------

    /// BuybackBurn is exempt: not capped and not counted (wallet or block).
    function test_cap_buybackExempt() public {
        _launch(0);
        _at(4);
        _swap(bbRouter, true, int256(3 * WALLET_CAP));
        assertEq(hook.walletBought(ORIGIN), 0, "not counted");
        _swap(swapRouter, true, int256(WALLET_CAP));
        _as(makeAddr("b"), int256(WALLET_CAP));
    }

    // ---------------- views, storage, gas ----------------

    function test_launchGuardView() public {
        _launch(0);
        (uint64 lb, uint64 capStart, uint64 capEnd) = hook.launchGuard();
        assertEq(lb, launchBlock);
        assertEq(capStart, launchBlock + 4);
        assertEq(capEnd, launched + 4 minutes);
    }

    /// Writes per swap inside the window: the wallet and block slots (from block 0); after the window neither.
    function test_cap_storageAndGas() public {
        _launch(0);
        uint256[6] memory g;
        uint256[6] memory w;
        _at(2);
        _swap(swapRouter, true, -0.01 ether); // warm the wallet and block slots (first writes: zero → nonzero)
        _at(3);
        (g[0], w[0]) = _measure(true);
        _at(4);
        _swap(swapRouter, true, -0.01 ether); // a new block
        _at(5);
        (g[1], w[1]) = _measure(true);
        (g[2], w[2]) = _measure(false);
        vm.warp(launched + 4 minutes);
        _at(9);
        _swap(swapRouter, true, -0.01 ether); // the first FeeVault claim (zero → nonzero in the PoolManager)
        (g[3], w[3]) = _measure(true);
        (g[4], w[4]) = _measure(false);
        assertEq(w[0], 3, "k<4: observables + wallet + block");
        assertEq(w[1], 3, "window: + block");
        assertEq(w[2], 2, "window sell: lowers the block net only");
        assertEq(w[3], 1, "after the window: observables only");
        assertEq(w[4], 1, "after the window, a sell too");
        console.log("buy gas k<4", g[0]);
        console.log("buy gas in window", g[1]);
        console.log("sell gas in window", g[2]);
        console.log("buy gas after window", g[3]);
        console.log("sell gas after window", g[4]);
    }

    function _measure(bool buy) internal returns (uint256 gasUsed, uint256 writes) {
        vm.record();
        _swap(swapRouter, buy, buy ? -0.01 ether : -int256(1_000 ether));
        (, bytes32[] memory wr) = vm.accesses(address(hook));
        return (vm.lastCallGas().gasTotalUsed, wr.length);
    }
}
