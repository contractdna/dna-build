// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {DNAHook} from "../../src/DNAHook.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {ModuleRegistry} from "../../src/ModuleRegistry.sol";
import {ParamSplit} from "../../src/modules/ParamSplit.sol";
import {FeeContext, IFeePolicy} from "../../src/interfaces/IPolicies.sol";
import {IDNAHook} from "../../src/interfaces/IDNA.sol";
import {LaunchPlanner} from "../../script/Launch.s.sol";
import {ModulePlates} from "../../script/RegisterModules.s.sol";

/// Random actor over the launched system with the module-library plates registered by the Safe: random in-bounds
/// params (Safe SetParams), fee-plate rotation (shadow → canary → active), swaps on every leg, distributions.
/// Every call is try/caught and classified; the invariants read the counters.
contract LibraryHandler is Test {
    using StateLibrary for IPoolManager;

    IPoolManager immutable pm;
    DNAHook immutable hook;
    ModuleRegistry immutable reg;
    FeeVault immutable fv;
    address immutable safe;
    IERC20 immutable token;
    PoolSwapTest immutable swapper;
    address immutable split; // ParamSplit plate
    address[2] fees; // DirectionalFee, SizeTierFee plates
    ModulePlates.Plate[3] plates; // bounds, in the order split, directional, size tier

    uint256 public violations;
    string public lastViolation;
    mapping(bytes32 => uint256) public calls;

    constructor(
        DNAHook hook_,
        ModuleRegistry reg_,
        FeeVault fv_,
        address safe_,
        address[3] memory mods,
        ModulePlates.Plate[3] memory ps
    ) {
        (hook, reg, fv, safe) = (hook_, reg_, fv_, safe_);
        pm = IPoolManager(address(hook_.poolManager()));
        token = IERC20(hook_.token());
        swapper = new PoolSwapTest(pm);
        token.approve(address(swapper), type(uint256).max);
        split = mods[0];
        fees = [mods[1], mods[2]];
        for (uint256 i; i < 3; ++i) {
            plates[i] = ps[i];
        }
    }

    receive() external payable {}

    function _fail(string memory why) internal {
        violations++;
        lastViolation = why;
    }

    function _safeRun(ModuleRegistry.Op op, bytes memory data) internal returns (bool) {
        vm.prank(safe);
        uint256 id = reg.queue(op, data);
        vm.warp(block.timestamp + 1 hours);
        vm.roll(block.number + 300);
        try reg.execute(id) {
            return true;
        } catch {
            _fail("Safe op reverted");
            return false;
        }
    }

    // ================================================================ actions

    /// Random in-bounds params for one plate (split sums are random too: off-sum ⇒ BaselineSplit answer).
    function setParams(uint256 which, uint256 r0, uint256 r1, uint256 r2, uint256 r3) external {
        which %= 3;
        ModulePlates.Plate memory p = plates[which];
        uint256[4] memory r = [r0, r1, r2, r3];
        bytes32[4] memory v;
        for (uint256 i; i < 4; ++i) {
            v[i] = bytes32(bound(r[i], uint256(p.lo[i]), uint256(p.hi[i])));
        }
        if (which == 0 && r3 % 2 == 0) {
            // half the time aim for a valid split: games = 10_000 − the rest, if that lands inside its bounds
            uint256 rest = uint256(v[0]) + uint256(v[1]) + uint256(v[2]);
            if (rest <= 10_000 && 10_000 - rest <= 2000) v[3] = bytes32(10_000 - rest);
        }
        address m = which == 0 ? split : fees[which - 1];
        if (_safeRun(ModuleRegistry.Op.SetParams, abi.encode(m, v))) calls["setParams"]++;
    }

    /// Walk the inactive fee plate through shadow → canary → active; the displaced one returns to Proposed.
    function rotate() external {
        address next = reg.route().active == fees[0] ? fees[1] : fees[0];
        bool ok = _safeRun(ModuleRegistry.Op.SetShadow, abi.encode(next))
            && _safeRun(ModuleRegistry.Op.SetCanary, abi.encode(next, uint64(block.number), uint32(300), uint32(50)))
            && _safeRun(ModuleRegistry.Op.PromoteActive, abi.encode(next));
        if (ok) calls["rotate"]++;
    }

    /// Any leg, sized well inside the pool. The project fee must be the active plate's answer and inside [1%, 3.5%].
    function swap(uint256 seed, uint256 amt) external {
        (bool buy, bool exactIn, uint256 a, uint256 want) = _plan(seed, amt);
        SwapParams memory sp = SwapParams(
            buy, exactIn ? -int256(a) : int256(a), buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        );
        vm.recordLogs();
        try swapper.swap{value: buy ? (exactIn ? a : 1_000 ether) : 0}(
            hook.poolKey(), sp, PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}), ""
        ) {
            calls["swap"]++;
            _checkLogs(want);
        } catch {
            _fail("swap reverted");
        }
    }

    /// Leg + size, and the active plate's answer for the context the hook will build.
    function _plan(uint256 seed, uint256 amt) internal view returns (bool buy, bool exactIn, uint256 a, uint256 want) {
        buy = seed & 1 == 0;
        exactIn = seed & 2 == 0;
        (uint160 sqrtP, int24 tick,,) = pm.getSlot0(hook.poolKey().toId());
        uint256 dnaPerEth = 1 ether * (uint256(sqrtP) * sqrtP / (1 << 96)) / (1 << 96);
        uint256 dna = token.balanceOf(address(this));
        // sell caps: DNA in (exact-in) or ETH out (exact-out), well inside what we hold and the pool's ETH
        uint256 sellCap = exactIn ? _min(dna, dnaPerEth / 5) : _min(0.1 ether, dna * 1 ether / dnaPerEth / 4);
        if (!buy && sellCap < 1e9) buy = true;
        if (buy) a = exactIn ? bound(amt, 1e9, 2 ether) : bound(amt, 1e9, dnaPerEth / 5);
        else a = bound(amt, 1e9, sellCap);
        (, uint32 volEma,,) = hook.observables();
        FeeContext memory ctx = FeeContext(buy, exactIn, a, sqrtP, tick, volEma, uint64(block.number));
        want = IFeePolicy(reg.route().active).projectFee(ctx, reg.route().activeParams);
    }

    function _checkLogs(uint256 want) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(hook)) continue;
            if (logs[i].topics[0] == IDNAHook.ModuleFailed.selector) _fail("ModuleFailed");
            if (logs[i].topics[0] != IDNAHook.FeeTaken.selector) continue;
            (,,,,, uint24 pips) = abi.decode(logs[i].data, (bool, bool, uint256, uint256, uint256, uint24));
            if (pips != want) _fail("pips != module answer");
            if (pips < 10_000 || pips > 35_000) _fail("pips outside the plate envelope [1%, 3.5%]");
        }
    }

    /// FeeVault applies exactly ParamSplit's answer for the routed params, and never falls back to its own baseline.
    function distribute() external {
        if (pm.balanceOf(address(fv), 0) < fv.MIN_DISTRIBUTE()) return;
        (uint16 b, uint16 l, uint16 t, uint16 g) = ParamSplit(split).split(reg.splitRoute().params);
        (uint256 cb, uint256 cl, uint256 ct, uint256 cg, bool baseline) = fv.currentSplit();
        if (baseline) _fail("FeeVault baseline used");
        if (cb != b || cl != l || ct != t || cg != g) _fail("split != module answer");
        if (!fv.isValid(cb, cl, ct, cg)) _fail("invalid split");
        try fv.distribute() {
            calls["distribute"]++;
        } catch {
            _fail("distribute reverted");
        }
    }

    function _min(uint256 x, uint256 y) internal pure returns (uint256) {
        return x < y ? x : y;
    }
}

contract ModuleLibraryInvariantTest is Test, LaunchPlanner, ModulePlates {
    LibraryHandler h;
    Addrs a;
    address[3] mods;

    function setUp() public {
        Config memory c = localConfig();
        Plan memory p = plan(c);
        a = p.a;
        launch(c, p);
        postLaunch(c, p);
        ModuleRegistry reg = ModuleRegistry(a.registry);
        vm.warp(block.timestamp + 1 hours);
        vm.roll(block.number + DNAHook(a.hook).LAUNCH_TAX_BLOCKS()); // past the launch tax (test/LaunchGuard.t.sol)

        (address[] memory to, bytes[] memory data) = registerBatch(a.registry);
        for (uint256 i; i < to.length; ++i) {
            vm.prank(c.safe);
            (bool ok,) = to[i].call(data[i]);
            require(ok, "batch call failed");
        }
        vm.warp(block.timestamp + 1 hours);
        for (uint256 id = reg.nextId() - 2; id <= reg.nextId(); ++id) {
            reg.execute(id);
        }
        Plate[3] memory ps = plates();
        for (uint256 i; i < 3; ++i) {
            mods[i] = plateAddress(ps[i]);
        }
        h = new LibraryHandler(DNAHook(a.hook), reg, FeeVault(a.feeVault), c.safe, mods, ps);
        vm.deal(address(h), 1_000_000 ether);
        // ParamSplit active (split route) and DirectionalFee active (fee route), both via the Safe
        for (uint256 i; i < 2; ++i) {
            ModuleRegistry.Op[3] memory ops =
                [ModuleRegistry.Op.SetShadow, ModuleRegistry.Op.SetCanary, ModuleRegistry.Op.PromoteActive];
            for (uint256 k; k < 3; ++k) {
                bytes memory d =
                    k == 1 ? abi.encode(mods[i], uint64(block.number), uint32(300), uint32(50)) : abi.encode(mods[i]);
                vm.prank(c.safe);
                uint256 id = reg.queue(ops[k], d);
                vm.warp(block.timestamp + 1 hours);
                reg.execute(id);
            }
        }

        bytes4[] memory s = new bytes4[](5);
        (s[0], s[1], s[2], s[3], s[4]) =
        (
            LibraryHandler.swap.selector,
            LibraryHandler.swap.selector,
            LibraryHandler.setParams.selector,
            LibraryHandler.rotate.selector,
            LibraryHandler.distribute.selector
        );
        targetSelector(FuzzSelector(address(h), s));
        targetContract(address(h));
    }

    /// Fee plate answers are charged exactly, inside [1%, 3.5%]; FeeVault always applies ParamSplit's (valid) answer;
    /// no swap, distribute or Safe op reverts.
    function invariant_libraryPlatesBehave() public view {
        assertEq(h.violations(), 0, h.lastViolation());
    }

    /// The routes only ever hold library plates.
    function invariant_routesHoldLibraryPlates() public view {
        ModuleRegistry reg = ModuleRegistry(a.registry);
        address active = reg.route().active;
        assertTrue(active == mods[1] || active == mods[2]);
        assertEq(reg.splitRoute().module, mods[0]);
    }

    function afterInvariant() external view {
        console.log("swap", h.calls("swap"), "distribute", h.calls("distribute"));
        console.log("setParams", h.calls("setParams"), "rotate", h.calls("rotate"));
    }
}
