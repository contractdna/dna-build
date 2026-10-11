// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Vm, VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import {DNAHook} from "../../src/DNAHook.sol";
import {AdaptiveFee} from "../../src/modules/AdaptiveFee.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {Route, IDNAHook} from "../../src/interfaces/IDNA.sol";
import {FeeContext} from "../../src/interfaces/IPolicies.sol";
import {LaunchPlanner} from "../../script/Launch.s.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
    function poolManager() external view returns (IPoolManager);
}

/// @dev UR "V2_0" action ABI for SWAP_EXACT_IN_SINGLE (no minHopPriceX36): the encoding Programmable's swap route
///      sends to this router (`@uniswap/v4-sdk` Actions + URVersion.V2_0, as
///      Programmable's stamped Ethereum swap route builds it). Proven against the deployed bytecode by the swaps below.
struct ExactInputSingleV20 {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    bytes hookData;
}

/// Burns the whole gas it is given (worst-case module: every call fails by OOG at its cap).
contract CapBurner {
    fallback() external {
        while (true) {}
    }
}

/// Swaps through the REAL Universal Router with Programmable's auto swap-route shape:
/// V4_SWAP[SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL] + SWEEP(native → msg.sender), exact-in, empty hookData; sells
/// approve token → Permit2 → router. Every swap checks the route's own limits: ≤ 2,000,000 gas, no CREATE*, ≤ 96
/// reached accounts, exactly one PoolManager.take by the router. Shared by this suite and test/fork/Rehearsal.t.sol.
abstract contract URSwaps is Test, LaunchPlanner {
    // The v4 Universal Router Programmable's swap route uses ("UR 2.1"). Sources: Uniswap/contracts
    // deployments/json/1.json + deployments/1.md ("Universal Router", deployed 2025-11-19 from universal-router
    // d2d9c4a, v4PoolManager 0x0000…4444…8A90, spokePool = the 2.1-generation constructor); address + runtime hash
    // as pinned by Programmable's stamped Ethereum swap route. Uniswap/universal-router's own
    // deploy-addresses/mainnet.json does not list it (it lists 2.0 0x66a9…, 2.1.1 0x4C82…, 2.1.2 0x2361…).
    // Code hash and poolManager() are asserted on-chain in setUp.
    IUniversalRouter constant UR = IUniversalRouter(0xd92A36B0000531EF3063dEd4De20A0783308446C);
    bytes32 constant UR_RUNTIME_HASH = 0x41ccd905c8e4de29ce9536ff49233b79e3085a0987d490664e703ee1e7b1dc49;
    IAllowanceTransfer constant PERMIT2 = IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    uint8 constant V4_SWAP = 0x10;
    uint8 constant SWEEP = 0x04;
    uint8 constant SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 constant SETTLE_ALL = 0x0c;
    uint8 constant TAKE_ALL = 0x0f;
    address constant MSG_SENDER = address(1); // ActionConstants.MSG_SENDER
    uint256 constant ROUTE_GAS_LIMIT = 2_000_000;

    Config c;
    Addrs a;
    PoolKey key;
    IPoolManager pm;
    address trader = makeAddr("trader");

    struct Swap {
        uint256 gas;
        uint256 gross;
        uint256 project;
        uint256 platform;
        uint24 pips;
        uint256 ethDelta; // buy: ETH paid · sell: ETH received
        uint256 tokenDelta;
        bool shadowed;
        uint256 moduleFailures;
    }

    /// Forks mainnet (skips the test without MAINNET_RPC_URL) and checks the pinned router.
    function _fork() internal {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        vm.skip(bytes(rpc).length == 0);
        vm.createSelectFork(rpc);
        assertEq(address(UR).codehash, UR_RUNTIME_HASH, "UR runtime != Programmable-pinned router");
        assertEq(address(UR.poolManager()), 0x000000000004444c5dc75cB358380D2e3dE08A90, "UR not on the v4 PoolManager");
    }

    /// After launch: pool handles + a funded trader.
    function _wire() internal {
        pm = c.poolManager;
        key = DNAHook(a.hook).poolKey();
        vm.deal(trader, 100 ether);
    }

    // ------------------------------------------------------------------ swaps

    function _buy(uint256 amountIn) internal returns (Swap memory s) {
        uint256 eth0 = trader.balance;
        uint256 m0 = IERC20(a.token).balanceOf(trader);
        s = _exec(true, amountIn, amountIn);
        s.ethDelta = eth0 - trader.balance;
        s.tokenDelta = IERC20(a.token).balanceOf(trader) - m0;
        assertEq(s.ethDelta, amountIn, "trader paid exactly amountIn (SWEEP refunds nothing)");
        assertGt(s.tokenDelta, 0);
    }

    function _sell(uint256 amountIn) internal returns (Swap memory s) {
        vm.startPrank(trader);
        IERC20(a.token).approve(address(PERMIT2), amountIn); // bounded to the request, like Programmable
        PERMIT2.approve(a.token, address(UR), uint160(amountIn), uint48(block.timestamp + 300 + 3600));
        vm.stopPrank();
        uint256 eth0 = trader.balance;
        uint256 m0 = IERC20(a.token).balanceOf(trader);
        s = _exec(false, amountIn, 0);
        s.ethDelta = trader.balance - eth0;
        s.tokenDelta = m0 - IERC20(a.token).balanceOf(trader);
        assertEq(s.tokenDelta, amountIn, "trader paid exactly amountIn");
        assertGt(s.ethDelta, 0);
    }

    /// One UR.execute as its own isolated tx; records gas (incl. intrinsic), fee claims, events and the call trace.
    function _exec(bool buy, uint256 amountIn, uint256 value) internal returns (Swap memory s) {
        (bytes memory commands, bytes[] memory inputs) = _urInputs(key, buy, amountIn, 1);

        uint256 fv0 = pm.balanceOf(a.feeVault, 0);
        uint256 pr0 = pm.balanceOf(a.platformRevenue, 0);
        vm.recordLogs();
        vm.startStateDiffRecording();
        vm.prank(trader);
        UR.execute{value: value}(commands, inputs, block.timestamp + 300);
        s.gas = vm.lastFrameGas().gasTotalUsed;
        _checkTrace(vm.stopAndReturnStateDiff(), buy);

        s.project = pm.balanceOf(a.feeVault, 0) - fv0;
        s.platform = pm.balanceOf(a.platformRevenue, 0) - pr0;
        _readHookEvents(s);
        assertLe(s.gas, ROUTE_GAS_LIMIT, "Programmable swap route: > 2,000,000 gas");
        assertEq(address(UR).balance, 0, "no ETH left in the router");
    }

    /// The router input of one exact-in swap in the hook pool (ETH = currency0, DNA = currency1): the swap box on the
    /// site builds the same bytes (test/URCalldata.t.sol pins them for both encoders). minOut bounds the swap and the
    /// take; the fork swaps here pass 1.
    function _urInputs(PoolKey memory k, bool buy, uint256 amountIn, uint256 minOut)
        internal
        pure
        returns (bytes memory commands, bytes[] memory inputs)
    {
        Currency eth = k.currency0;
        Currency dna = k.currency1;
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputSingleV20(k, buy, uint128(amountIn), uint128(minOut), ""));
        params[1] = abi.encode(buy ? eth : dna, amountIn);
        params[2] = abi.encode(buy ? dna : eth, minOut);
        inputs = new bytes[](2);
        inputs[0] = abi.encode(abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL), params);
        inputs[1] = abi.encode(address(0), MSG_SENDER, uint256(0));
        commands = abi.encodePacked(V4_SWAP, SWEEP);
    }

    function _readHookEvents(Swap memory s) internal view {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 feeEvents;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != a.hook) continue;
            bytes32 t0 = logs[i].topics[0];
            if (t0 == IDNAHook.FeeTaken.selector) {
                feeEvents++;
                uint256 project;
                uint256 platform;
                (,, s.gross, project, platform, s.pips) =
                    abi.decode(logs[i].data, (bool, bool, uint256, uint256, uint256, uint24));
                assertEq(project, s.project, "event project == minted claims");
                assertEq(platform, s.platform, "event platform == minted claims");
            } else if (t0 == IDNAHook.ShadowFee.selector) {
                s.shadowed = true;
            } else if (t0 == IDNAHook.ModuleFailed.selector) {
                s.moduleFailures++;
            }
        }
        assertEq(feeEvents, 1, "one fee per swap");
    }

    /// Programmable's trace rules: no CREATE/CREATE2, ≤ 96 reached accounts, exactly one PoolManager.take by the
    /// router (to the trader, in the output currency).
    function _checkTrace(VmSafe.AccountAccess[] memory acc, bool buy) internal view {
        address[] memory seen = new address[](acc.length);
        uint256 n;
        uint256 takes;
        for (uint256 i; i < acc.length; ++i) {
            assertTrue(acc[i].kind != VmSafe.AccountAccessKind.Create, "CREATE in swap");
            assertTrue(acc[i].kind != VmSafe.AccountAccessKind.SelfDestruct, "SELFDESTRUCT in swap");
            assertTrue(acc[i].kind != VmSafe.AccountAccessKind.CallCode, "CALLCODE in swap");
            bool dup;
            for (uint256 j; j < n && !dup; ++j) {
                dup = seen[j] == acc[i].account;
            }
            if (!dup) seen[n++] = acc[i].account;
            if (
                acc[i].account == address(pm) && acc[i].kind == VmSafe.AccountAccessKind.Call && acc[i].data.length >= 4
                    && bytes4(acc[i].data) == IPoolManager.take.selector
            ) {
                takes++;
                assertEq(acc[i].accessor, address(UR), "take by the router");
                (Currency cur, address to,) = abi.decode(_tail(acc[i].data), (Currency, address, uint256));
                assertEq(Currency.unwrap(cur), buy ? a.token : address(0), "take output currency");
                assertEq(to, trader, "take to trader");
            }
        }
        assertEq(takes, 1, "exactly one PoolManager.take");
        assertLe(n, 96, "> 96 reached accounts");
    }

    // ------------------------------------------------------------------ fee checks

    /// Exact FeeMath: exact-in buy (ETH specified): gross = amountIn, fee = fromGross(gross, pips + PLATFORM_FEE).
    /// Exact-in sell (ETH unspecified): gross = pool's ETH out, fee = fromGross(gross, T), trader gets gross − fee.
    /// Both: project = floor(gross·pips/1e6), platform = fee − project ∈ [floor(gross·0.3%), +1].
    function _checkFees(Swap memory s, bool buy, uint24 pips) internal view {
        assertEq(s.pips, pips, "pips");
        uint24 pf = DNAHook(a.hook).PLATFORM_FEE();
        uint256 fee = FeeMath.fromGross(s.gross, pips + pf);
        if (buy) assertEq(s.gross, s.ethDelta, "buy gross == ETH paid");
        else assertEq(s.ethDelta, s.gross - fee, "sell: trader gets gross - fee");
        assertEq(s.project, s.gross * pips / 1e6, "project == floor(gross*pips)");
        assertEq(s.project + s.platform, fee, "project + platform == fee");
        assertGe(s.platform, s.gross * pf / 1e6);
        assertLe(s.platform, s.gross * pf / 1e6 + 1);
        assertLe(pips, 50_000, "<= 5%");
    }

    // ------------------------------------------------------------------ route helpers

    function _params(uint256 base, uint256 mult, uint256 cap) internal pure returns (bytes32[4] memory p) {
        (p[0], p[1], p[2]) = (bytes32(base), bytes32(mult), bytes32(cap));
    }

    /// Route pushed as the registry would (pranked): active + canary (in window now) + shadow.
    function _setRoute(address act, address can, address sh, bytes32[4] memory ap, bytes32[4] memory cp) internal {
        Route memory r;
        (r.active, r.canary, r.shadow) = (act, can, sh);
        (r.activeParams, r.canaryParams, r.shadowParams) = (ap, cp, ap);
        (r.canaryStart, r.canaryPeriod, r.canaryLen) = (uint64(block.number), 100, 50);
        vm.prank(a.registry);
        DNAHook(a.hook).setRoute(r);
    }

    /// Small buys until the next swap is a shadow turn (swapCount % 10 == 0).
    function _alignShadowTurn() internal {
        (,,, uint64 n) = DNAHook(a.hook).observables();
        for (; n % 10 != 0; ++n) {
            _buy(0.001 ether);
        }
    }

    /// The hook's result for the next swap: active, then the canary clamped to active ± 1 point.
    function _expectedPips(address act, address can, bytes32[4] memory ap, bytes32[4] memory cp, bool buy)
        internal
        view
        returns (uint24)
    {
        (, uint32 volEma,,) = DNAHook(a.hook).observables();
        FeeContext memory ctx;
        (ctx.zeroForOne, ctx.volEma) = (buy, volEma);
        uint24 x = AdaptiveFee(act).projectFee(ctx, ap);
        uint24 y = AdaptiveFee(can).projectFee(ctx, cp);
        uint24 lo = x > 10_000 ? x - 10_000 : 0;
        uint24 hi = x + 10_000;
        return y < lo ? lo : (y > hi ? hi : y);
    }

    function _tail(bytes memory data) internal pure returns (bytes memory out) {
        out = new bytes(data.length - 4);
        for (uint256 i; i < out.length; ++i) {
            out[i] = data[i + 4];
        }
    }
}

/// Real launch on a mainnet fork (mocked EIP-1271 permit), then UR swaps on the baseline and worst-case routes.
/// Skipped without MAINNET_RPC_URL (MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com forge test --mc UniversalRouterFork -vv).
contract UniversalRouterForkTest is URSwaps {
    function setUp() public {
        _fork();
        c = mainnetConfig();
        Plan memory p = plan(c);
        a = p.a;
        launch(c, p);
        postLaunch(c, p);
        _wire();
        launched = block.timestamp;
        vm.roll(block.number + DNAHook(a.hook).LAUNCH_TAX_BLOCKS()); // past the launch tax (test/LaunchGuard.t.sol)
        vm.warp(launched + 1 hours); // steady state: the launch fee (3% → 2.2% over the first hour) is over
    }

    uint256 launched;

    /// The launch fee through the real Universal Router: 3% at the launch, 2.6% at +30 min, 2.2% from +1 h (derived from
    /// LAUNCH_PROJECT_FEE, so a flat-2% switch still passes).
    function test_ur_launchFeeDecay() public {
        uint256[3] memory t = [uint256(0), 30 minutes, 1 hours];
        uint24 l = DNAHook(a.hook).LAUNCH_PROJECT_FEE();
        uint24 b = DNAHook(a.hook).BASELINE_PROJECT_FEE();
        uint24[3] memory want = [l, b + (l - b) / 2, b];
        for (uint256 i; i < 3; i++) {
            vm.warp(launched + t[i]);
            _checkFees(_buy(0.005 ether), true, want[i]); // under the launch caps (1% of supply ≈ 0.02 ETH at t = 0)
            _checkFees(_sell(IERC20(a.token).balanceOf(trader) / 2), false, want[i]);
        }
    }

    /// The quotes the site's swap box shows: the v4 Quoter's exact-in quote is exactly what the router swap then pays
    /// (Uniswap's v4 Quoter, Uniswap/contracts deployments/1.md).
    function test_quoter_matchesRouter() public {
        IV4Quoter quoter = IV4Quoter(0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203);
        assertEq(address(quoter.poolManager()), address(pm), "quoter on the v4 PoolManager");
        (uint256 q,) = quoter.quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(key, true, 0.5 ether, ""));
        assertEq(_buy(0.5 ether).tokenDelta, q, "buy quote == DNA received");
        uint256 amt = IERC20(a.token).balanceOf(trader) / 2;
        (q,) = quoter.quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(key, false, uint128(amt), ""));
        assertEq(_sell(amt).ethDelta, q, "sell quote == ETH received");
    }

    function test_ur_buyAndSell_baseline() public {
        Swap memory b = _buy(0.5 ether);
        _checkFees(b, true, DNAHook(a.hook).BASELINE_PROJECT_FEE());
        console.log("UR buy  gas (baseline route):", b.gas);

        Swap memory s = _sell(IERC20(a.token).balanceOf(trader) / 2);
        _checkFees(s, false, DNAHook(a.hook).BASELINE_PROJECT_FEE());
        console.log("UR sell gas (baseline route):", s.gas);
    }

    /// Worst realistic module path: AdaptiveFee active + AdaptiveFee canary in window + AdaptiveFee shadow turn.
    function test_ur_worstCaseRoute_adaptiveFee() public {
        _buy(1 ether); // stock DNA + move volEma off zero
        (address act, address can, address sh) =
            (address(new AdaptiveFee()), address(new AdaptiveFee()), address(new AdaptiveFee()));
        _setRoute(act, can, sh, _params(15_000, 2e4, 50_000), _params(28_000, 1e4, 50_000));

        _alignShadowTurn();
        uint24 want = _expectedPips(act, can, _params(15_000, 2e4, 50_000), _params(28_000, 1e4, 50_000), true);
        Swap memory b = _buy(0.5 ether);
        assertTrue(b.shadowed, "shadow turn");
        assertEq(b.moduleFailures, 0);
        _checkFees(b, true, want);
        console.log("UR buy  gas (active+canary+shadow AdaptiveFee):", b.gas, "pips", b.pips);

        _alignShadowTurn();
        want = _expectedPips(act, can, _params(15_000, 2e4, 50_000), _params(28_000, 1e4, 50_000), false);
        Swap memory s = _sell(IERC20(a.token).balanceOf(trader) / 3);
        assertTrue(s.shadowed, "shadow turn");
        _checkFees(s, false, want);
        console.log("UR sell gas (active+canary+shadow AdaptiveFee):", s.gas, "pips", s.pips);
    }

    /// Absolute worst: all three modules burn their whole gas cap (active/canary fail → baseline + breaker tick).
    function test_ur_worstCaseRoute_capBurners() public {
        _buy(1 ether);
        (address act, address can, address sh) =
            (address(new CapBurner()), address(new CapBurner()), address(new CapBurner()));
        bytes32[4] memory z;
        _setRoute(act, can, sh, z, z);

        _alignShadowTurn();
        Swap memory b = _buy(0.5 ether);
        assertEq(b.moduleFailures, 2, "active + canary failed");
        assertFalse(b.shadowed, "shadow OOG is ignored, never emitted");
        _checkFees(b, true, DNAHook(a.hook).BASELINE_PROJECT_FEE());
        console.log("UR buy  gas (3 modules burning full cap):", b.gas);

        _alignShadowTurn();
        Swap memory s = _sell(IERC20(a.token).balanceOf(trader) / 3);
        _checkFees(s, false, DNAHook(a.hook).BASELINE_PROJECT_FEE());
        console.log("UR sell gas (3 modules burning full cap):", s.gas);
    }
}
