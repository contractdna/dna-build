// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {DNAHook} from "../src/DNAHook.sol";
import {DNAToken} from "../src/DNAToken.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {ModuleRegistry} from "../src/ModuleRegistry.sol";
import {ParamSplit} from "../src/modules/ParamSplit.sol";
import {DirectionalFee} from "../src/modules/DirectionalFee.sol";
import {SizeTierFee} from "../src/modules/SizeTierFee.sol";
import {FeeContext, IFeePolicy} from "../src/interfaces/IPolicies.sol";
import {IDNAHook, Route} from "../src/interfaces/IDNA.sol";
import {LaunchPlanner} from "../script/Launch.s.sol";
import {ModulePlates, RegisterModules} from "../script/RegisterModules.s.sol";

/// @dev Swap + read the FeeTaken pips, and the fee the module itself answers for the same context the hook builds.
abstract contract SwapProbe is Test {
    using StateLibrary for IPoolManager;

    function _pm() internal view virtual returns (IPoolManager);
    function _hook() internal view virtual returns (DNAHook);
    function _router() internal view virtual returns (PoolSwapTest);

    /// The context DNAHook._context builds for this swap (pre-swap slot0 and observables).
    function _ctxFor(bool buy, bool exactIn, uint256 amt) internal view returns (FeeContext memory ctx) {
        DNAHook h = _hook();
        (uint160 sqrtP, int24 tick,,) = _pm().getSlot0(h.poolKey().toId());
        (, uint32 volEma,,) = h.observables();
        ctx = FeeContext(buy, exactIn, amt, sqrtP, tick, volEma, uint64(block.number));
    }

    /// Swap and return the hook's charged project pips; fails the test on a ModuleFailed event.
    function _swap(bool buy, bool exactIn, uint256 amt) internal returns (uint24 pips) {
        vm.recordLogs();
        _router().swap{value: buy ? (exactIn ? amt : 1_000 ether) : 0}(
            _hook().poolKey(),
            SwapParams(
                buy,
                exactIn ? -int256(amt) : int256(amt),
                buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(_hook())) continue;
            assertTrue(logs[i].topics[0] != IDNAHook.ModuleFailed.selector, "module failed");
            if (logs[i].topics[0] != IDNAHook.FeeTaken.selector) continue;
            (,,,,, pips) = abi.decode(logs[i].data, (bool, bool, uint256, uint256, uint256, uint24));
            n++;
        }
        assertEq(n, 1, "one FeeTaken per swap");
    }

    /// Swap and check the charged pips are exactly the module's answer (clamped to the constitution's 5%).
    function _swapChecked(address module, bytes32[4] memory params, bool buy, bool exactIn, uint256 amt)
        internal
        returns (uint24 pips)
    {
        uint256 want = IFeePolicy(module).projectFee(_ctxFor(buy, exactIn, amt), params);
        if (want > 50_000) want = 50_000;
        pips = _swap(buy, exactIn, amt);
        assertEq(pips, want, "hook pips != module answer");
    }
}

/// Real DNAHook (registry = this test) with each fee module routed active under arbitrary, unbounded params: every
/// swap leg goes through the hook's gas-capped STATICCALL and never charges above the module's cap or 5%.
contract ModuleLibraryHookTest is SwapProbe, Deployers {
    DNAHook hook;
    DNAToken token;
    DirectionalFee dir;
    SizeTierFee tier;

    function _pm() internal view override returns (IPoolManager) {
        return manager;
    }

    function _hook() internal view override returns (DNAHook) {
        return hook;
    }

    function _router() internal view override returns (PoolSwapTest) {
        return swapRouter;
    }

    function setUp() public {
        deployFreshManagerAndRouters();
        token = new DNAToken(address(this));
        address at = address(uint160(0x4444 << 144) | uint160(Hooks.ALL_HOOK_MASK));
        deployCodeTo(
            "DNAHook.sol:DNAHook",
            abi.encode(manager, address(token), address(this), makeAddr("fv"), makeAddr("pr"), makeAddr("bb")),
            at
        );
        hook = DNAHook(at);
        key = hook.poolKey();
        manager.initialize(key, SQRT_PRICE_1_1);
        vm.deal(address(this), 1e24);
        token.approve(address(modifyLiquidityRouter), type(uint256).max);
        token.approve(address(swapRouter), type(uint256).max);
        vm.warp(block.timestamp + hook.LAUNCH_CAP_WINDOW()); // no new liquidity inside the launch window
        modifyLiquidityRouter.modifyLiquidity{value: 1e22}(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e22, salt: 0}), ""
        );
        vm.roll(block.number + hook.LAUNCH_TAX_BLOCKS()); // past the launch tax (test/LaunchGuard.t.sol)
        vm.warp(block.timestamp + 1 hours);
        dir = new DirectionalFee();
        tier = new SizeTierFee();
    }

    function testFuzz_hookPath_anyParamsNeverAboveCap(
        bool useTier,
        bytes32[4] memory p,
        uint256 amt,
        bool buy,
        bool exactIn
    ) public {
        address m = useTier ? address(tier) : address(dir);
        Route memory r;
        (r.active, r.activeParams) = (m, p);
        hook.setRoute(r);
        uint24 pips = _swapChecked(m, p, buy, exactIn, bound(amt, 1e6, 20 ether));
        assertLe(pips, uint24(uint256(p[2])), "above module cap");
        assertLe(pips, hook.MAX_PROJECT_FEE());
        (uint32 fails,) = hook.breaker();
        assertEq(fails, 0);
    }
}

/// Full local launch (same pipeline as the system invariants). The Safe deploys and registers the module-library
/// plates with the RegisterModules batch, walks each through shadow → canary → active, and swaps run through the hook.
contract ModuleLibraryIntegrationTest is SwapProbe, LaunchPlanner, ModulePlates {
    Config c;
    Addrs a;
    PoolSwapTest swapper;
    ModuleRegistry reg;
    address[3] mods; // ParamSplit, DirectionalFee, SizeTierFee

    function _pm() internal view override returns (IPoolManager) {
        return c.poolManager;
    }

    function _hook() internal view override returns (DNAHook) {
        return DNAHook(a.hook);
    }

    function _router() internal view override returns (PoolSwapTest) {
        return swapper;
    }

    receive() external payable {}

    function setUp() public {
        c = localConfig();
        Plan memory p = plan(c);
        a = p.a;
        launch(c, p);
        postLaunch(c, p);
        reg = ModuleRegistry(a.registry);
        swapper = new PoolSwapTest(c.poolManager);
        IERC20(a.token).approve(address(swapper), type(uint256).max);
        vm.deal(address(this), 10_000 ether);
        vm.warp(block.timestamp + 1 hours); // past the launch fee decay
        vm.roll(block.number + DNAHook(a.hook).LAUNCH_TAX_BLOCKS()); // and the launch tax (test/LaunchGuard.t.sol)

        // the printed batch, sent as the Safe: 3 CREATE2 deploys + 3 queued Registers, executed 1 h later
        (address[] memory to, bytes[] memory data) = registerBatch(a.registry);
        for (uint256 i; i < to.length; ++i) {
            vm.prank(c.safe);
            (bool ok,) = to[i].call(data[i]);
            assertTrue(ok, "batch call failed");
        }
        vm.warp(block.timestamp + 1 hours);
        for (uint256 id = reg.nextId() - 2; id <= reg.nextId(); ++id) {
            reg.execute(id);
        }
        Plate[3] memory ps = plates();
        for (uint256 i; i < 3; ++i) {
            mods[i] = plateAddress(ps[i]);
            assertGt(mods[i].code.length, 0);
            ModuleRegistry.Module memory m = reg.getModule(mods[i]);
            assertEq(uint8(m.status), uint8(ModuleRegistry.Status.Proposed));
            assertEq(m.codehash, mods[i].codehash);
            // the spec hash is the engine manifest's (engine/src/indexer.ts keys manifests by keccak256(file bytes))
            string memory json = vm.readFile(string.concat("../engine/modules/", ps[i].name, ".json"));
            assertEq(m.specHash, keccak256(bytes(json)), "specHash = keccak256(manifest bytes)");
            assertEq(
                string.concat(vm.parseJsonString(json, ".name"), "-", vm.parseJsonString(json, ".version")), ps[i].name
            );
            assertEq(
                vm.parseJsonString(json, ".kind"), ps[i].kind == ModuleRegistry.Kind.Fee ? "FeePolicy" : "SplitPolicy"
            );
        }
        // a few buys so sells have ETH to come out of, and FeeVault has enough to distribute
        for (uint256 i; i < 4; ++i) {
            _swap(true, true, 1 ether);
        }
    }

    function _safeRun(ModuleRegistry.Op op, bytes memory data) internal {
        vm.prank(c.safe);
        uint256 id = reg.queue(op, data);
        vm.warp(block.timestamp + 1 hours);
        vm.roll(block.number + 300);
        reg.execute(id);
    }

    /// Safe path: Proposed → Shadow → Canary → Active.
    function _activate(address m) internal {
        _safeRun(ModuleRegistry.Op.SetShadow, abi.encode(m));
        _safeRun(ModuleRegistry.Op.SetCanary, abi.encode(m, uint64(block.number), uint32(300), uint32(50)));
        _safeRun(ModuleRegistry.Op.PromoteActive, abi.encode(m));
        assertEq(uint8(reg.getModule(m).status), uint8(ModuleRegistry.Status.Active));
    }

    function _params(address m) internal view returns (bytes32[4] memory) {
        return reg.getModule(m).params;
    }

    // ---------------------------------------------------------------- fee plates

    function test_directionalFee_activeThroughHook() public {
        address m = mods[1];
        _activate(m);
        assertEq(DNAHook(a.hook).route().active, m);
        // start params (2% both ways, 1.0x vol), every leg
        _dirSwap(m, true, true, 0.2 ether); // ETH in
        _dirSwap(m, true, false, 1e6 ether); // DNA out
        _dirSwap(m, false, true, 1e6 ether); // DNA in
        _dirSwap(m, false, false, 0.1 ether); // ETH out
        // the Safe sets buys 1%, sells 2.5%, lowest vol multiplier (0.1x)
        bytes32[4] memory p =
            [bytes32(uint256(10_000)), bytes32(uint256(1_000)), bytes32(uint256(35_000)), bytes32(uint256(25_000))];
        _safeRun(ModuleRegistry.Op.SetParams, abi.encode(m, p));
        _dirSwap(m, true, true, 0.2 ether);
        _dirSwap(m, true, false, 1e6 ether);
        _dirSwap(m, false, true, 1e6 ether);
        _dirSwap(m, false, false, 0.1 ether);
    }

    /// Swap and check the charged pips against the formula written out here (independent of the module's code):
    /// min(base(side) + multiplier·volEma/1e4, cap).
    function _dirSwap(address m, bool buy, bool exactIn, uint256 amt) internal {
        bytes32[4] memory p = _params(m);
        (, uint32 volEma,,) = DNAHook(a.hook).observables();
        uint256 want = uint256(buy ? p[0] : p[3]) + uint256(p[1]) * volEma / 1e4;
        if (want > uint256(p[2])) want = uint256(p[2]);
        assertEq(_swapChecked(m, p, buy, exactIn, amt), want, buy ? "buy fee" : "sell fee");
    }

    function test_sizeTierFee_activeThroughHook_allLegs() public {
        address m = mods[2];
        _activate(m);
        // T = 0.1 ETH: tiers at 0.1 / 0.4 / 1.6 ETH; 1% base +0.5% per tier
        bytes32[4] memory p =
            [bytes32(uint256(10_000)), bytes32(uint256(5_000)), bytes32(uint256(35_000)), bytes32(uint256(0.1 ether))];
        _safeRun(ModuleRegistry.Op.SetParams, abi.encode(m, p));

        // ETH legs: exact-in buy, exact-out sell
        assertEq(_swapChecked(m, p, true, true, 0.05 ether), 10_000);
        assertEq(_swapChecked(m, p, true, true, 2 ether), 25_000);
        assertEq(_swapChecked(m, p, false, false, 0.01 ether), 10_000);
        assertEq(_swapChecked(m, p, false, false, 0.5 ether), 20_000);

        // DNA legs: exact-out buy, exact-in sell; sized from the spot value of the DNA amount
        uint256 dnaPerEth = _dnaPerEth();
        assertEq(_swapChecked(m, p, true, false, dnaPerEth / 20), 10_000); // ~0.05 ETH
        assertEq(_swapChecked(m, p, true, false, dnaPerEth / 2), 20_000); // ~0.5 ETH
        assertEq(_swapChecked(m, p, false, true, dnaPerEth / 20), 10_000);
        assertEq(_swapChecked(m, p, false, true, dnaPerEth * 2), 25_000); // ~2 ETH
    }

    /// DNA wei per 1 ETH at the current spot price.
    function _dnaPerEth() internal view returns (uint256) {
        uint256 s = _ctxFor(true, true, 0).sqrtPriceX96;
        return 1 ether * (s * s / (1 << 96)) / (1 << 96);
    }

    // ---------------------------------------------------------------- split plate

    function _distribute() internal returns (uint256 amount, uint256 b, uint256 l, uint256 g, uint256 t) {
        FeeVault fv = FeeVault(a.feeVault);
        amount = c.poolManager.balanceOf(a.feeVault, 0);
        uint256 b0 = c.poolManager.balanceOf(a.buybackBurn, 0);
        uint256 l0 = c.poolManager.balanceOf(a.liquidityVault, 0);
        uint256 g0 = c.poolManager.balanceOf(a.gamePot, 0);
        uint256 t0 = c.safe.balance;
        fv.distribute();
        b = c.poolManager.balanceOf(a.buybackBurn, 0) - b0;
        l = c.poolManager.balanceOf(a.liquidityVault, 0) - l0;
        g = c.poolManager.balanceOf(a.gamePot, 0) - g0;
        t = c.safe.balance - t0;
    }

    function _assertSplit(uint256[4] memory bps) internal {
        (uint256 amount, uint256 b, uint256 l, uint256 g, uint256 t) = _distribute();
        assertGe(amount, FeeVault(a.feeVault).MIN_DISTRIBUTE());
        assertEq(b, amount * bps[0] / 10_000, "buyback");
        assertEq(l, amount * bps[1] / 10_000, "lp");
        assertEq(g, amount * bps[3] / 10_000, "games");
        assertEq(t, amount - b - l - g, "treasury = remainder");
    }

    function _refill() internal {
        for (uint256 i; i < 4; ++i) {
            _swap(true, true, 1 ether);
        }
    }

    function test_paramSplit_activeThroughFeeVault() public {
        address m = mods[0];
        _activate(m);
        (uint256 b, uint256 l, uint256 t, uint256 g, bool baseline) = FeeVault(a.feeVault).currentSplit();
        assertEq(b + l + t + g, 10_000);
        assertFalse(baseline);
        _assertSplit([uint256(3500), 3000, 2500, 1000]);

        // the Safe moves the split: params pass straight through
        _safeRun(
            ModuleRegistry.Op.SetParams,
            abi.encode(
                m, [bytes32(uint256(4000)), bytes32(uint256(2500)), bytes32(uint256(2000)), bytes32(uint256(1500))]
            )
        );
        _refill();
        _assertSplit([uint256(4000), 2500, 2000, 1500]);

        // each word inside the registry bounds but the sum is 16_000: the module answers BaselineSplit, not a revert
        _safeRun(
            ModuleRegistry.Op.SetParams,
            abi.encode(
                m, [bytes32(uint256(5000)), bytes32(uint256(5000)), bytes32(uint256(4000)), bytes32(uint256(2000))]
            )
        );
        (,,,, baseline) = FeeVault(a.feeVault).currentSplit();
        assertFalse(baseline, "module answer used");
        _refill();
        _assertSplit([uint256(3500), 3000, 2500, 1000]);
    }

    /// Split changes by the agent need level 9; until then only the Safe moves them.
    function test_paramSplit_agentNeedsLevel9() public {
        address m = mods[0];
        _activate(m);
        bytes memory op = abi.encode(
            m, [bytes32(uint256(4000)), bytes32(uint256(2500)), bytes32(uint256(2000)), bytes32(uint256(1500))]
        );
        vm.prank(c.agent);
        vm.expectRevert(ModuleRegistry.NotAllowedAtLevel.selector);
        reg.queue(ModuleRegistry.Op.SetParams, op);

        _safeRun(ModuleRegistry.Op.SetLevel, abi.encode(uint8(8)));
        vm.prank(c.agent);
        vm.expectRevert(ModuleRegistry.NotAllowedAtLevel.selector);
        reg.queue(ModuleRegistry.Op.SetParams, op);

        _safeRun(ModuleRegistry.Op.SetLevel, abi.encode(uint8(9)));
        vm.prank(c.agent);
        uint256 id = reg.queue(ModuleRegistry.Op.SetParams, op);
        vm.warp(block.timestamp + 1 hours);
        reg.execute(id);
        assertEq(uint256(reg.splitRoute().params[0]), 4000);
    }

    /// Registry bounds: a split or fee param outside the plate bounds never reaches the module.
    function test_plateBoundsEnforced() public {
        vm.prank(c.safe);
        uint256 id = reg.queue(
            ModuleRegistry.Op.SetParams,
            abi.encode(
                mods[0],
                [bytes32(uint256(5001)), bytes32(uint256(2000)), bytes32(uint256(1000)), bytes32(uint256(1999))]
            )
        );
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(ModuleRegistry.OutOfBounds.selector, 0));
        reg.execute(id);
        vm.prank(c.safe);
        id = reg.queue(
            ModuleRegistry.Op.SetParams,
            abi.encode(
                mods[2],
                [
                    bytes32(uint256(20_000)),
                    bytes32(uint256(5_000)),
                    bytes32(uint256(35_000)),
                    bytes32(uint256(11 ether))
                ]
            )
        );
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(ModuleRegistry.OutOfBounds.selector, 3));
        reg.execute(id);
    }

    /// The script only prints: no broadcast, no state change.
    function test_registerModulesScript_printsOnly() public {
        vm.setEnv("REGISTRY", vm.toString(a.registry));
        uint256 n = reg.nextId();
        new RegisterModules().run();
        assertEq(reg.nextId(), n);
    }
}
