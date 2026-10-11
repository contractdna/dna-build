// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {DNAHook} from "../../src/DNAHook.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {BuybackBurn} from "../../src/BuybackBurn.sol";
import {LiquidityVault} from "../../src/LiquidityVault.sol";
import {PlatformRevenue} from "../../src/PlatformRevenue.sol";
import {ModuleRegistry} from "../../src/ModuleRegistry.sol";
import {AdaptiveFee} from "../../src/modules/AdaptiveFee.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {IDNAHook, Route} from "../../src/interfaces/IDNA.sol";
import {Ret, Reverter, GasBurner} from "../DNAHook.t.sol";
import {MockSplit} from "../Vaults.t.sol";
import {LaunchPlanner} from "../../script/Launch.s.sol";

/// Random actor over the fully launched local system (real launch pipeline: Programmable Router + graph factory,
/// Bootstrap, post-launch vaults). Every action is try/caught and classified, so the invariants read ghost counters.
contract Handler is Test {
    using StateLibrary for IPoolManager;

    IPoolManager immutable pm;
    DNAHook immutable hook;
    IERC20 immutable token;
    ModuleRegistry immutable registry;
    FeeVault immutable fv;
    PlatformRevenue immutable pr;
    BuybackBurn immutable bb;
    LiquidityVault immutable lv;
    address immutable safe;
    address immutable recipient;
    PoolKey key;
    PoolId pid;

    PoolSwapTest immutable swapper;
    PoolModifyLiquidityTest immutable lpRouter;
    address[] public modules;
    mapping(address => bool) public bad; // fee modules that fail / misbehave
    mapping(address => bool) public isSplit;
    mapping(address => bytes32[4]) splitParams; // [buyback, lp, treasury, game]
    address goodSplit;

    // ---- ghosts ----
    uint256 public feesAccrued; // project + platform minted by swaps (incl. Bootstrap's initial buy and buybacks)
    uint256 public paidOut; // treasury ETH to Safe + platform ETH to recipient + buyback spend + LP-vault adds
    uint256 public feeViolations;
    string public lastViolation;
    uint256 public unexpectedSwapReverts;
    bytes public lastUnexpected;
    uint256 public removeRevertsByHook;
    uint256 public unexpectedOpReverts; // vault ops reverting with anything but their designed errors
    uint256 public lastSupply;
    bool public supplyIncreased;
    uint256 public registryViolations; // endCanary / plate-reuse expectations broken
    mapping(address => bool) wasRouted; // fee module that has sat in the shadow slot (plate reuse coverage)

    struct LvPos {
        int24 lower;
        int24 upper;
        uint128 liquidity;
        uint256 salt;
    }

    LvPos[] public lvPositions;

    struct LpPos {
        int24 lower;
        int24 upper;
        uint128 liquidity;
    }

    LpPos[] public lpPositions; // salt = index

    mapping(bytes32 => uint256) public calls;

    constructor(
        IPoolManager pm_,
        DNAHook hook_,
        ModuleRegistry registry_,
        FeeVault fv_,
        PlatformRevenue pr_,
        BuybackBurn bb_,
        LiquidityVault lv_,
        address safe_
    ) {
        (pm, hook, registry, fv, pr, bb, lv, safe) = (pm_, hook_, registry_, fv_, pr_, bb_, lv_, safe_);
        token = IERC20(hook_.token());
        recipient = pr_.recipient();
        key = hook_.poolKey();
        pid = key.toId();
        swapper = new PoolSwapTest(pm_);
        lpRouter = new PoolModifyLiquidityTest(pm_);
        token.approve(address(swapper), type(uint256).max);
        token.approve(address(lpRouter), type(uint256).max);

        modules.push(address(new AdaptiveFee()));
        modules.push(address(new AdaptiveFee()));
        address[6] memory b = [
            address(new Reverter()),
            address(new GasBurner()),
            address(new Ret(abi.encode(uint256(1 << 24)))), // > uint24
            address(new Ret(hex"01")), // short returndata
            address(new Ret(abi.encode(type(uint256).max))),
            address(new Ret(abi.encode(uint256(60_000)))) // valid word above the 5% cap: clamped
        ];
        for (uint256 i; i < b.length; ++i) {
            modules.push(b[i]);
            bad[b[i]] = true;
        }
        // split modules (Kind.Split): one valid, one returndata bomb, one out of bounds → FeeVault.currentSplit path
        goodSplit = address(new MockSplit());
        address bomb = address(new MockSplit());
        address oob = address(new MockSplit());
        splitParams[goodSplit] =
            [bytes32(uint256(4000)), bytes32(uint256(3000)), bytes32(uint256(2000)), bytes32(uint256(1000))];
        splitParams[bomb] = [bytes32(uint256(5000)), bytes32(uint256(3000)), bytes32(uint256(2000)), 0];
        MockSplit(bomb).setMode(4);
        splitParams[oob] = [bytes32(uint256(5000)), bytes32(uint256(5000)), 0, 0];
        address[3] memory sp = [goodSplit, bomb, oob];
        for (uint256 i; i < sp.length; ++i) {
            modules.push(sp[i]);
            isSplit[sp[i]] = true;
        }
        feesAccrued = _claims(address(fv_)) + _claims(address(pr_)); // Bootstrap's initial buy
        lastSupply = token.totalSupply();
    }

    receive() external payable {}

    /// Supply never increases across any action. `calls[...]` counts only actions that actually ran.
    modifier track() {
        _;
        uint256 s = token.totalSupply();
        if (s > lastSupply) supplyIncreased = true;
        lastSupply = s;
    }

    // ================================================================ actions

    /// Random buy/sell, exact-in/exact-out. Checks every fee against FeeMath and the trader's actual ETH flow.
    function swap(uint256 seed, uint256 amt) external track {
        calls["swap"]++;
        bool buy = seed & 1 == 0;
        bool exactIn = seed & 2 == 0;
        uint256 dna = token.balanceOf(address(this));
        if (!buy && dna == 0) buy = true;
        int256 specified;
        if (buy) {
            specified = exactIn ? -int256(bound(amt, 1, 5 ether)) : int256(bound(amt, 1, 1_000_000 ether));
        } else {
            uint256 poolEth = address(pm).balance - vaultClaims();
            if (!exactIn && poolEth < 4) exactIn = true;
            specified = exactIn ? -int256(bound(amt, 1, dna)) : int256(bound(amt, 1, poolEth / 4));
        }

        uint256 eth0 = address(this).balance;
        uint256 fv0 = _claims(address(fv));
        uint256 pr0 = _claims(address(pr));
        Route memory r = hook.route();
        vm.recordLogs();
        try swapper.swap{value: buy ? (exactIn ? uint256(-specified) : 10_000 ether) : 0}(
            key,
            SwapParams(buy, specified, buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) {
            if (bad[r.active] || (bad[r.canary] && _inCanary(r))) calls["swap.badModuleRouted"]++;
            uint256 project = _claims(address(fv)) - fv0;
            uint256 platform = _claims(address(pr)) - pr0;
            feesAccrued += project + platform;
            uint256 ethFlow = buy ? eth0 - address(this).balance : address(this).balance - eth0;
            _checkFee(buy, exactIn, ethFlow, project, platform);
        } catch (bytes memory err) {
            if (_legitSwapRevert(err)) {
                calls["swap.legitRevert"]++;
            } else {
                unexpectedSwapReverts++;
                lastUnexpected = err;
            }
        }
    }

    /// Third-party LP around the current price (both tokens).
    function lpAdd(uint256 w, uint256 ethAmt) external track {
        (uint160 sqrtP, int24 tick,,) = pm.getSlot0(pid);
        int24 width = int24(int256(bound(w, 10, 20_000)));
        int24 lower = tick - width < TickMath.MIN_TICK ? TickMath.MIN_TICK : tick - width;
        int24 upper = tick + width > TickMath.MAX_TICK ? TickMath.MAX_TICK : tick + width;
        uint256 ethBudget = bound(ethAmt, 0.001 ether, 2 ether);
        uint128 l = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP,
            TickMath.getSqrtPriceAtTick(lower),
            TickMath.getSqrtPriceAtTick(upper),
            ethBudget,
            token.balanceOf(address(this)) / 2
        );
        if (l < 1e12) return;
        calls["lpAdd"]++;
        try lpRouter.modifyLiquidity{value: ethBudget + 10}(
            key, ModifyLiquidityParams(lower, upper, int256(uint256(l)), bytes32(lpPositions.length)), ""
        ) {
            lpPositions.push(LpPos(lower, upper, l));
        } catch {
            calls["lpAdd.revert"]++;
        }
    }

    /// Third party removes part or all of one of its positions. Must never revert because of the hook.
    function lpRemove(uint256 i, uint256 frac) external track {
        if (lpPositions.length == 0) return;
        i = bound(i, 0, lpPositions.length - 1);
        LpPos storage p = lpPositions[i];
        if (p.liquidity == 0) return;
        calls["lpRemove"]++;
        uint128 amount = frac % 2 == 0 ? p.liquidity : p.liquidity / 2;
        try lpRouter.modifyLiquidity(
            key, ModifyLiquidityParams(p.lower, p.upper, -int256(uint256(amount)), bytes32(i)), ""
        ) {
            p.liquidity -= amount;
        } catch (bytes memory err) {
            // the test router's own `assert` (zero amounts on dust) is not the hook; a hook failure is WrappedError
            if (bytes4(err) == CustomRevert.WrappedError.selector) removeRevertsByHook++;
            else calls["lpRemove.routerRevert"]++;
        }
    }

    /// Also checks the split actually applied: the valid module's 4000/3000/2000/1000, else (bomb, out of bounds,
    /// none) the 3500/3500/3000/0 baseline.
    function distribute() external track {
        calls["distribute"]++;
        uint256 amount = _claims(address(fv));
        uint256 s0 = safe.balance;
        uint256 b0 = _claims(address(bb));
        uint256 l0 = _claims(address(lv));
        uint256 g0 = _claims(fv.gamePot());
        address routed = registry.splitRoute().module;
        if (routed != address(0)) calls["distribute.splitRouted"]++;
        try fv.distribute() {
            paidOut += safe.balance - s0;
            (uint256 b, uint256 l, uint256 g) = routed == goodSplit ? (4000, 3000, 1000) : (3500, 3500, 0);
            _require(_claims(address(bb)) - b0 == amount * b / 10_000, "buyback share != split");
            _require(_claims(address(lv)) - l0 == amount * l / 10_000, "LP share != split");
            _require(_claims(fv.gamePot()) - g0 == amount * g / 10_000, "game share != split");
            _require(
                safe.balance - s0 == amount - amount * b / 10_000 - amount * l / 10_000 - amount * g / 10_000,
                "treasury != remainder"
            );
            if (routed == goodSplit) calls["distribute.moduleSplit"]++;
        } catch (bytes memory err) {
            _expect(err, FeeVault.BelowMinimum.selector, bytes4(0), bytes4(0), "distribute.revert");
        }
    }

    function buyback() external track {
        calls["buyback"]++;
        uint256 c0 = _claims(address(bb));
        uint256 fv0 = _claims(address(fv));
        uint256 pr0 = _claims(address(pr));
        try bb.process() {
            paidOut += c0 - _claims(address(bb));
            feesAccrued += _claims(address(pr)) - pr0; // a buyback pays the platform fee (no project fee)
            _require(_claims(address(fv)) == fv0, "buyback paid a project fee");
        } catch (bytes memory err) {
            _expect(
                err, BuybackBurn.CoolingDown.selector, BuybackBurn.NothingToBuy.selector, bytes4(0), "buyback.revert"
            );
        }
    }

    function addVaultLiquidity() external track {
        calls["lvAdd"]++;
        uint256 c0 = _claims(address(lv));
        vm.recordLogs();
        try lv.add() {
            paidOut += c0 - _claims(address(lv));
            Vm.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 i; i < logs.length; ++i) {
                if (logs[i].emitter == address(lv) && logs[i].topics[0] == LiquidityVault.LiquidityAdded.selector) {
                    (int24 lo, int24 hi, uint128 l,) = abi.decode(logs[i].data, (int24, int24, uint128, uint256));
                    lvPositions.push(LvPos(lo, hi, l, uint256(logs[i].topics[1])));
                }
            }
        } catch (bytes memory err) {
            _expect(
                err,
                LiquidityVault.CoolingDown.selector,
                LiquidityVault.NoLiquidity.selector,
                LiquidityVault.BadWidth.selector,
                "lvAdd.revert"
            );
        }
    }

    function claimPlatform() external track {
        calls["claim"]++;
        uint256 r0 = recipient.balance;
        try pr.claim() {
            paidOut += recipient.balance - r0;
        } catch (bytes memory err) {
            _expect(err, PlatformRevenue.NothingToClaim.selector, bytes4(0), bytes4(0), "claim.revert");
        }
    }

    /// Safe or agent (level 5) ends the fee canary at once: the plate returns to Proposed (reusable), only the canary
    /// leaves the route, and neither the 5-day clock nor the agent's rollback quota moves.
    function endCanary(uint256 seed) external track {
        calls["endCanary"]++;
        Route memory r0 = registry.route();
        uint256 rb = registry.lastRollbackBlock();
        uint8 idx = registry.agentRollbackIdx();
        vm.prank(seed % 2 == 0 ? safe : registry.agent());
        try registry.endCanary() {
            calls["endCanary.ok"]++;
            Route memory r = hook.route();
            _registryRequire(
                r.canary == address(0) && r.canaryLen == 0 && r.active == r0.active && r.shadow == r0.shadow,
                "endCanary route"
            );
            _registryRequire(
                registry.getModule(r0.canary).status == ModuleRegistry.Status.Proposed, "ended canary not Proposed"
            );
            _registryRequire(
                registry.lastRollbackBlock() == rb && registry.agentRollbackIdx() == idx, "endCanary quota"
            );
        } catch (bytes memory err) {
            _expect(
                err, ModuleRegistry.NoCanary.selector, ModuleRegistry.BreakerTripped.selector, 0, "endCanary.revert"
            );
        }
    }

    function warp(uint256 secs, uint256 blocks) external track {
        calls["warp"]++;
        vm.warp(block.timestamp + bound(secs, 1, 2 days));
        vm.roll(block.number + bound(blocks, 1, 2_000));
    }

    /// Safe moves one module 1-4 lifecycle steps, each queue → +1 h → execute: register → shadow → canary → active →
    /// rollback. Bad modules included. A tripped breaker blocks execute; then anyone rolls back.
    function registryStep(uint256 seed) external track {
        calls["registry"]++;
        address m = modules[seed % modules.length];
        for (uint256 n = 1 + (seed >> 32) % 4; n > 0 && _step(m, seed); --n) {}
    }

    function _step(address m, uint256 seed) internal returns (bool) {
        ModuleRegistry.Status s = registry.getModule(m).status;
        ModuleRegistry.Op op;
        bytes memory data;
        if (
            s == ModuleRegistry.Status.None || s == ModuleRegistry.Status.Retired
                || s == ModuleRegistry.Status.RolledBack
        ) {
            bytes32[4] memory p; // params fixed: min = max = p
            if (isSplit[m]) {
                p = splitParams[m];
            } else if (!bad[m]) {
                (p[0], p[1], p[2]) = m == modules[0]
                    ? (bytes32(uint256(10_000)), bytes32(uint256(1e4)), bytes32(uint256(50_000)))
                    : (bytes32(uint256(30_000)), bytes32(0), bytes32(uint256(30_000)));
            }
            op = ModuleRegistry.Op.Register;
            data = abi.encode(m, _kind(m), bytes32(0), p, p, p);
        } else if (s == ModuleRegistry.Status.Proposed) {
            (op, data) = (ModuleRegistry.Op.SetShadow, abi.encode(m));
            if (wasRouted[m]) calls["registry.plateReuse"]++; // back from a displaced / ended slot
        } else if (s == ModuleRegistry.Status.Shadow) {
            op = ModuleRegistry.Op.SetCanary;
            data = abi.encode(m, uint64(block.number), uint32(bound(seed >> 8, 51, 400)), uint32(50));
        } else if (s == ModuleRegistry.Status.Canary) {
            (op, data) = (ModuleRegistry.Op.PromoteActive, abi.encode(m));
        } else {
            vm.prank(safe);
            registry.rollback(_kind(m));
            calls["registry.safeRollback"]++;
            return false;
        }
        Route memory r0 = registry.route();
        vm.prank(safe);
        uint256 id = registry.queue(op, data);
        vm.warp(block.timestamp + 1 hours);
        vm.roll(block.number + 300);
        try registry.execute(id) {
            calls["registry.executed"]++;
            if (!isSplit[m]) {
                // plate reuse: a displaced shadow / canary / active goes back to Proposed, never Retired
                address displaced = op == ModuleRegistry.Op.SetShadow
                    ? r0.shadow
                    : op == ModuleRegistry.Op.SetCanary
                        ? r0.canary
                        : op == ModuleRegistry.Op.PromoteActive ? r0.active : address(0);
                if (displaced != address(0)) {
                    calls["registry.displaced"]++;
                    _registryRequire(
                        registry.getModule(displaced).status == ModuleRegistry.Status.Proposed, "displaced not Proposed"
                    );
                }
                if (op == ModuleRegistry.Op.SetShadow) wasRouted[m] = true;
            }
            return true;
        } catch (bytes memory err) {
            if (bytes4(err) != ModuleRegistry.BreakerTripped.selector) {
                calls["registry.unexpectedRevert"]++;
                return false;
            }
            vm.prank(makeAddr("anyone"));
            registry.rollback(ModuleRegistry.Kind.Fee); // breaker tripped: permissionless
            uint256[] memory ids = new uint256[](1);
            ids[0] = id;
            vm.prank(safe);
            registry.cancel(ids);
            calls["registry.breakerRollback"]++;
            return false;
        }
    }

    // ================================================================ checks

    function _kind(address m) internal view returns (ModuleRegistry.Kind) {
        return isSplit[m] ? ModuleRegistry.Kind.Split : ModuleRegistry.Kind.Fee;
    }

    /// Same window test as DNAHook._projectPips.
    function _inCanary(Route memory r) internal view returns (bool) {
        return r.canary != address(0) && block.number >= r.canaryStart && r.canaryPeriod != 0
            && (block.number - r.canaryStart) % r.canaryPeriod < r.canaryLen;
    }

    /// A vault op may only revert with its designed errors (cooldowns, minimums, empty); anything else is counted.
    function _expect(bytes memory err, bytes4 a, bytes4 b, bytes4 c, bytes32 name) internal {
        bytes4 sel = bytes4(err);
        if (err.length >= 4 && sel != 0 && (sel == a || sel == b || sel == c)) {
            calls[name]++;
        } else {
            unexpectedOpReverts++;
            lastUnexpected = err;
        }
    }

    /// SPEC §8.1 on one trader swap, from the hook's FeeTaken event cross-checked against minted claims and the
    /// trader's own ETH flow (buy: gross = ETH paid; sell: gross = ETH received + fee).
    function _checkFee(bool buy, bool exactIn, uint256 ethFlow, uint256 project, uint256 platform) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(hook) || logs[i].topics[0] != IDNAHook.FeeTaken.selector) continue;
            n++;
            (,, uint256 gross, uint256 ep, uint256 eq, uint24 pips) =
                abi.decode(logs[i].data, (bool, bool, uint256, uint256, uint256, uint24));
            uint256 fee = project + platform;
            _require(ep == project && eq == platform, "event != minted claims");
            _require(pips <= 50_000, "project fee > 5%");
            _require(project == gross * pips / 1e6, "project != floor(gross*pips)");
            uint256 nominal = gross * hook.PLATFORM_FEE() / 1e6;
            _require(platform >= nominal && platform <= nominal + (exactIn ? 1 : 2), "platform out of bounds");
            _require(
                exactIn
                    ? fee == FeeMath.fromGross(gross, pips + hook.PLATFORM_FEE())
                    : fee == FeeMath.fromNet(gross - fee, pips + hook.PLATFORM_FEE()),
                "fee != FeeMath"
            );
            _require(buy ? gross == ethFlow : gross == ethFlow + fee, "gross != trader ETH flow");
        }
        if (n == 0) _require(project == 0 && platform == 0, "claims minted without FeeTaken");
        _require(n <= 1, "two fees in one swap");
    }

    function _registryRequire(bool ok, string memory why) internal {
        if (!ok) {
            registryViolations++;
            lastViolation = why;
        }
    }

    function moduleCount() external view returns (uint256) {
        return modules.length;
    }

    function _require(bool ok, string memory why) internal {
        if (!ok) {
            feeViolations++;
            lastViolation = why;
        }
    }

    /// Reverts that are by design, never module-caused: exact-out sell partial fill (PartialNativeFill) and the
    /// trader not holding enough DNA for an exact-out sell.
    function _legitSwapRevert(bytes memory err) internal view returns (bool) {
        if (bytes4(err) == IERC20Errors.ERC20InsufficientBalance.selector) return true;
        if (bytes4(err) != CustomRevert.WrappedError.selector) return false;
        bytes memory body = new bytes(err.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = err[i + 4];
        }
        (address target,, bytes memory reason,) = abi.decode(body, (address, bytes4, bytes, bytes));
        return target == address(hook) && bytes4(reason) == DNAHook.PartialNativeFill.selector;
    }

    function _claims(address a) internal view returns (uint256) {
        return pm.balanceOf(a, 0);
    }

    function vaultClaims() public view returns (uint256) {
        return _claims(address(fv)) + _claims(address(pr)) + _claims(address(bb)) + _claims(address(lv))
            + _claims(fv.gamePot());
    }

    function lvCount() external view returns (uint256) {
        return lvPositions.length;
    }
}

/// System invariants (SPEC §8) over the real launch pipeline, run locally.
/// CI: runs 64 × depth 64 (foundry.toml [invariant]). Deeper: FOUNDRY_INVARIANT_RUNS=1000 FOUNDRY_INVARIANT_DEPTH=256
/// forge test --mc SystemInvariantTest -vv
contract SystemInvariantTest is Test, LaunchPlanner {
    using StateLibrary for IPoolManager;

    Handler h;
    Config c;
    Addrs a;
    uint256 launchPosition;

    function setUp() public {
        c = localConfig();
        Plan memory p = plan(c);
        a = p.a;
        launchPosition = c.positionManager.nextTokenId();
        launch(c, p);
        postLaunch(c, p);
        // the fee bounds below hold once the launch tax and the launch cap are over (both: test/LaunchGuard.t.sol)
        vm.roll(block.number + DNAHook(a.hook).LAUNCH_TAX_BLOCKS());
        vm.warp(block.timestamp + DNAHook(a.hook).LAUNCH_CAP_WINDOW());
        h = new Handler(
            c.poolManager,
            DNAHook(a.hook),
            ModuleRegistry(a.registry),
            FeeVault(a.feeVault),
            PlatformRevenue(a.platformRevenue),
            BuybackBurn(a.buybackBurn),
            LiquidityVault(a.liquidityVault),
            c.safe
        );
        vm.deal(address(h), 10_000_000 ether);

        bytes4[] memory s = new bytes4[](11);
        (s[0], s[1], s[2], s[3]) =
        (Handler.swap.selector, Handler.lpAdd.selector, Handler.lpRemove.selector, Handler.distribute.selector);
        (s[4], s[5], s[6]) =
        (Handler.buyback.selector, Handler.addVaultLiquidity.selector, Handler.claimPlatform.selector);
        (s[7], s[8], s[9]) = (Handler.warp.selector, Handler.registryStep.selector, Handler.swap.selector);
        s[10] = Handler.endCanary.selector;
        targetSelector(FuzzSelector(address(h), s));
        targetContract(address(h));
    }

    /// §8.1: project fee ≤ 5%, platform within FeeMath bounds, fee == FeeMath on the trader's actual ETH flow.
    /// §8.7: distribute() applied exactly the routed valid split, else the baseline (bomb / out-of-bounds modules).
    function invariant_feeAndSplitBounds() public view {
        assertEq(h.feeViolations(), 0, h.lastViolation());
    }

    /// §8.6: a module (revert, OOG, garbage, out of range) never makes a swap revert.
    function invariant_noSwapRevertsFromModules() public view {
        assertEq(h.unexpectedSwapReverts(), 0, string(h.lastUnexpected()));
    }

    /// Vault ops revert only with their designed errors; Safe registry ops never revert unexpectedly.
    function invariant_noUnexpectedReverts() public view {
        assertEq(h.unexpectedOpReverts(), 0, string(h.lastUnexpected()));
        assertEq(h.calls("registry.unexpectedRevert"), 0);
    }

    /// §8.8 plate reuse: endCanary / displacement return plates to Proposed; the fee slot invariant holds (a Fee module
    /// is Shadow / Canary / Active iff it sits in that route slot) and the hook runs exactly the registry's route.
    function invariant_registrySlotsAndPlateReuse() public view {
        assertEq(h.registryViolations(), 0, h.lastViolation());
        ModuleRegistry reg = ModuleRegistry(a.registry);
        Route memory r = reg.route();
        assertEq(keccak256(abi.encode(r)), keccak256(abi.encode(DNAHook(a.hook).route())), "hook route != registry");
        for (uint256 i; i < h.moduleCount(); ++i) {
            address m = h.modules(i);
            if (h.isSplit(m)) continue;
            ModuleRegistry.Status st = reg.getModule(m).status;
            assertEq(st == ModuleRegistry.Status.Shadow, r.shadow == m, "shadow slot");
            assertEq(st == ModuleRegistry.Status.Canary, r.canary == m, "canary slot");
            assertEq(st == ModuleRegistry.Status.Active, r.active == m, "active slot");
        }
    }

    /// §8.4: removing liquidity never reverts because of the hook.
    function invariant_removeNeverBlockedByHook() public view {
        assertEq(h.removeRevertsByHook(), 0);
    }

    function invariant_hookHoldsNothing() public view {
        IPoolManager pm = c.poolManager;
        assertEq(pm.balanceOf(a.hook, 0), 0, "hook ETH claims");
        assertEq(pm.balanceOf(a.hook, uint256(uint160(a.token))), 0, "hook DNA claims");
        assertEq(a.hook.balance, 0);
        assertEq(IERC20(a.token).balanceOf(a.hook), 0);
    }

    /// §8.10
    function invariant_supplyNeverIncreases() public view {
        assertFalse(h.supplyIncreased());
        assertLe(IERC20(a.token).totalSupply(), 1_000_000_000 ether);
    }

    /// §8.9
    function invariant_launchLpDeadOwned() public view {
        assertEq(IERC721(address(c.positionManager)).ownerOf(launchPosition), address(0xdEaD));
    }

    /// §8.9: every LiquidityVault position keeps (at least) the liquidity it was created with.
    function invariant_vaultLiquidityNeverDecreases() public view {
        PoolId pid = DNAHook(a.hook).poolKey().toId();
        uint256 n = h.lvCount();
        assertEq(n, LiquidityVault(a.liquidityVault).positions());
        for (uint256 i; i < n; ++i) {
            (int24 lo, int24 hi, uint128 l, uint256 salt) = h.lvPositions(i);
            (uint128 now_,,) = c.poolManager.getPositionInfo(pid, a.liquidityVault, lo, hi, bytes32(salt));
            assertGe(now_, l);
        }
    }

    /// Every fee wei is either still a vault claim or was paid out (Safe treasury, platform recipient, buyback spend,
    /// LP-vault liquidity). The PoolManager holds at least the ETH backing those claims.
    function invariant_feeConservation() public view {
        assertEq(h.vaultClaims() + h.paidOut(), h.feesAccrued());
        assertGe(address(c.poolManager).balance, h.vaultClaims());
    }

    /// @dev registryStep seed that picks module `idx` and runs `steps` lifecycle steps.
    function _seed(uint256 idx, uint256 steps) internal view returns (uint256 s) {
        uint256 n = h.moduleCount();
        s = (steps - 1) << 32;
        s += (n + idx - s % n) % n;
    }

    /// Deterministic coverage: the handler's endCanary, displacement and plate-reuse paths all run and keep every
    /// invariant, so the fuzzed suite can't silently skip them.
    function test_handlerReachesEndCanaryAndPlateReuse() public {
        h.registryStep(_seed(0, 3)); // plate 0: register → shadow → canary
        assertEq(ModuleRegistry(a.registry).route().canary, h.modules(0));
        h.endCanary(0); // Safe ends it: plate 0 → Proposed
        h.registryStep(_seed(0, 1)); // plate 0 back to the shadow slot without re-register
        h.registryStep(_seed(1, 2)); // plate 1: register → shadow, displacing plate 0
        h.endCanary(1); // agent, no canary now: NoCanary (designed revert)
        assertEq(h.calls("endCanary.ok"), 1);
        assertEq(h.calls("endCanary.revert"), 1);
        assertEq(h.calls("registry.plateReuse"), 1);
        assertEq(h.calls("registry.displaced"), 1);
        assertEq(
            uint8(ModuleRegistry(a.registry).getModule(h.modules(0)).status), uint8(ModuleRegistry.Status.Proposed)
        );
        invariant_registrySlotsAndPlateReuse();
        invariant_noUnexpectedReverts();
    }

    function afterInvariant() external view {
        string[24] memory k = [
            "swap",
            "swap.badModuleRouted",
            "swap.legitRevert",
            "lpAdd",
            "lpAdd.revert",
            "lpRemove",
            "lpRemove.routerRevert",
            "distribute",
            "distribute.revert",
            "distribute.splitRouted",
            "distribute.moduleSplit",
            "buyback",
            "lvAdd",
            "claim",
            "registry",
            "registry.executed",
            "registry.breakerRollback",
            "registry.safeRollback",
            "registry.unexpectedRevert",
            "registry.displaced",
            "registry.plateReuse",
            "endCanary",
            "endCanary.ok",
            "endCanary.revert"
        ];
        for (uint256 i; i < k.length; ++i) {
            console.log(k[i], h.calls(bytes32(bytes(k[i]))));
        }
        console.log("lv positions", h.lvCount(), "fees accrued", h.feesAccrued());
    }
}
