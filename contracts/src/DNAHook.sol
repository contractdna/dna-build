// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {FeeMath} from "./libraries/FeeMath.sol";
import {FeeContext, IFeePolicy} from "./interfaces/IPolicies.sol";
import {IDNAHook, Route} from "./interfaces/IDNA.sol";

/// @title DNAHook
/// @notice The one permanent hook of the DNA/ETH pool. Immutable. Enforces the constitution (fee cap, fixed platform
///         fee, canary bound, canonical pool) and asks registered fee modules — via gas-capped STATICCALL — what to
///         charge inside those bounds. Fees are taken in ETH via return deltas and minted as ERC-6909 claims to fixed
///         vaults. The hook never calls swap, modifyLiquidity or unlock, and never blocks liquidity removal.
///         Launch guard: for the first 9 blocks a launch tax steps down 90%..10% (plus the platform fee), all of it to
///         buyback-and-burn. Until 4 minutes after launch: at most 2% of the original supply can leave the pool per
///         block (net of sells); from block 4 (the 50% tax) each sending wallet can buy at most 1% in all (gross: its
///         sells do not count back; its buys count from block 0); and nobody can add liquidity (removing is never
///         blocked). After that only the 5% project-fee cap applies. The launch buy (the first swap of the pool's own
///         initialization transaction) pays the normal fee and is neither capped nor counted, and that transaction adds
///         the launch liquidity; DNA's own buybacks are never taxed, capped or counted. Fixed in code: no owner, no
///         setter.
contract DNAHook is BaseHook, IDNAHook {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeCast for uint256;

    // ---------------- constitution ----------------
    uint24 public constant MAX_PROJECT_FEE = 50_000; // 5.00%
    /// @dev 2.20%: with Programmable's 0.30% on top, traders pay 2.5% after the launch hour.
    uint24 public constant BASELINE_PROJECT_FEE = 22_000;
    /// @dev 3.00% at pool initialization, sliding linearly to the baseline over LAUNCH_DECAY (3.3% → 2.5% for traders).
    ///      Set it to BASELINE_PROJECT_FEE for a flat baseline: the formula then always returns the baseline.
    uint24 public constant LAUNCH_PROJECT_FEE = 30_000;
    uint64 public constant LAUNCH_DECAY = 1 hours; // ... over exactly this long
    /// @dev 0.30%, on top: Programmable's profile 3.6.0 binds `programmableFeeHundredthsOfBip` const "3000" on every
    ///      successful pool swap.
    uint24 public constant PLATFORM_FEE = 3_000;
    uint24 public constant CANARY_MAX_DELTA = 10_000; // ±1 point vs the active fee
    uint256 public constant MODULE_GAS_CAP = 40_000;
    uint256 public constant GAS_RESERVE = 30_000;
    uint256 public constant SHADOW_GAS_CAP = 30_000;
    uint64 public constant SHADOW_EVERY = 10;
    uint64 public constant BREAKER_WINDOW = 300; // blocks
    /// @dev Launch tax, in project pips: LAUNCH_TAX in the pool's first block, LAUNCH_TAX_STEP less each block after,
    ///      none from LAUNCH_TAX_BLOCKS on (90%, 80% .. 10%, then the fee above).
    uint24 public constant LAUNCH_TAX = 900_000;
    uint24 public constant LAUNCH_TAX_STEP = 100_000;
    uint64 public constant LAUNCH_TAX_BLOCKS = 9;
    /// @dev Until LAUNCH_CAP_WINDOW after initialization: at most LAUNCH_BLOCK_CAP DNA (2% of the original 1B supply)
    ///      out of the pool per block, net (buys add the DNA they take out, sells subtract the DNA they put in, floored
    ///      at 0), from block 0; at most LAUNCH_WALLET_CAP (1%) bought per sending wallet, gross (sells do not lower
    ///      it), recorded from block 0 and enforced from block LAUNCH_CAP_START; and no liquidity added outside the
    ///      initialization transaction (a position added and removed around a sell would hand the DNA back uncounted).
    uint64 public constant LAUNCH_CAP_START = 4;
    uint64 public constant LAUNCH_CAP_WINDOW = 4 minutes;
    uint256 public constant LAUNCH_BLOCK_CAP = 20_000_000e18;
    uint256 public constant LAUNCH_WALLET_CAP = 10_000_000e18;
    uint256 private constant ETH_ID = 0; // ERC-6909 id of native ETH (currency0)

    // ---------------- wiring (all immutable) ----------------
    address public immutable override token;
    address public immutable registry;
    address public immutable feeVault;
    address public immutable platformRevenue;
    address public immutable buybackBurn;

    // ---------------- state ----------------
    PoolId public poolId; // set once by beforeInitialize
    Route internal _route; // pushed by the registry; zero modules = baseline

    struct Obs {
        int24 lastTick;
        uint32 volEma;
        uint40 lastBlock; // uint40 (blocks, timestamps): one slot with launchBlock, which every swap reads
        uint64 swapCount;
        uint40 launchedAt; // block.timestamp of the pool's initialization; written once, by beforeInitialize
        uint40 launchBlock; // block.number of the pool's initialization; written once, by beforeInitialize
    }
    Obs internal _obs;
    uint32 internal _failCount;
    uint64 internal _failWindowStart;

    struct Cap {
        uint64 blockNumber;
        uint128 net; // DNA out of the pool, net of sells, in `blockNumber`; written only inside the launch cap window
    }
    Cap internal _cap;
    /// @notice DNA bought (gross: sells do not lower it) by each sending wallet, tx.origin, inside the launch cap
    ///         window; frozen after it. Per sending wallet only: tokens moved to another wallet are not tracked, and
    ///         every user of one smart-wallet bundler shares its origin. Accepted for a 4-minute window.
    mapping(address => uint256) public walletBought;

    // transient: project pips, written in beforeSwap, read in afterSwap
    uint256 private constant T_SLOT = 0x646e612e686f6f6b2e7069707300000000000000000000000000000000000000; // "dna.hook.pips"
    // transient: nonzero from the pool's initialization until the first swap after it (the launch buy) completes
    uint256 private constant T_LAUNCH = 0x646e612e686f6f6b2e6c61756e63680000000000000000000000000000000000; // "dna.hook.launch"
    // transient: nonzero for the whole initialization transaction (never cleared): it adds the launch liquidity
    uint256 private constant T_INIT = 0x646e612e686f6f6b2e696e697400000000000000000000000000000000000000; // "dna.hook.init"

    error WrongPool();
    error OnlyRegistry();
    error OutOfGasBudget();
    error PartialNativeFill();
    error LaunchCapExceeded(); // the block's net
    error WalletCapExceeded(); // the sending wallet's gross buys
    error LiquidityLocked(); // adding liquidity inside the launch cap window, outside the initialization transaction

    constructor(
        IPoolManager poolManager_,
        address token_,
        address registry_,
        address feeVault_,
        address platformRevenue_,
        address buybackBurn_
    ) BaseHook(poolManager_) {
        token = token_;
        registry = registry_;
        feeVault = feeVault_;
        platformRevenue = platformRevenue_;
        buybackBurn = buybackBurn_;
    }

    /// @notice All 14 callbacks are enabled (and implemented) so future modules never need a new hook address.
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: true,
            beforeAddLiquidity: true,
            afterAddLiquidity: true,
            beforeRemoveLiquidity: true,
            afterRemoveLiquidity: true,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: true,
            afterDonate: true,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: true,
            afterRemoveLiquidityReturnDelta: true
        });
    }

    // ================= registry =================

    /// @notice Replace the fee route. Only the registry; resets the failure breaker for the new route epoch.
    function setRoute(Route calldata r) external override {
        if (msg.sender != registry) revert OnlyRegistry();
        _route = r;
        _failCount = 0;
        _failWindowStart = uint64(block.number);
        emit RouteSet(r.active, r.canary, r.shadow);
    }

    // ================= views =================

    function route() external view returns (Route memory) {
        return _route;
    }

    function breaker() external view override returns (uint32 failCount, uint64 windowStart) {
        return (_failCount, _failWindowStart);
    }

    function observables() external view override returns (int24, uint32, uint64, uint64) {
        Obs memory o = _obs;
        return (o.lastTick, o.volEma, o.lastBlock, o.swapCount);
    }

    /// @notice The baseline project fee now (pips): the launch tax for the first LAUNCH_TAX_BLOCKS blocks, then 3%
    ///         at initialization, linearly down to the baseline (2.2%) over LAUNCH_DECAY, then the baseline (2.2%).
    function baselineFee() external view override returns (uint24) {
        Obs memory o = _obs;
        uint24 tax = _launchTax(o.launchBlock);
        return tax != 0 ? tax : _baseline(o.launchedAt);
    }

    /// @notice The pool's first block (the launch tax runs LAUNCH_TAX_BLOCKS blocks from it), the first block the
    ///         wallet cap is enforced in (the block cap is from the first block), and the time both caps end.
    function launchGuard() external view returns (uint64 launchBlock, uint64 capStartBlock, uint64 capEnd) {
        Obs memory o = _obs;
        return (o.launchBlock, o.launchBlock + LAUNCH_CAP_START, o.launchedAt + LAUNCH_CAP_WINDOW);
    }

    function poolKey() public view returns (PoolKey memory) {
        return PoolKey({
            currency0: CurrencyLibrary.ADDRESS_ZERO,
            currency1: Currency.wrap(token),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 1,
            hooks: IHooks(address(this))
        });
    }

    // ================= initialize =================

    /// @dev Only the canonical (ETH, DNA, dynamic, 1) pool, only once. Every other pool using this hook reverts.
    function _beforeInitialize(address, PoolKey calldata key, uint160) internal override returns (bytes4) {
        if (
            PoolId.unwrap(poolId) != 0 || Currency.unwrap(key.currency0) != address(0)
                || Currency.unwrap(key.currency1) != token || key.fee != LPFeeLibrary.DYNAMIC_FEE_FLAG
                || key.tickSpacing != 1
        ) revert WrongPool();
        poolId = key.toId();
        // once: poolId != 0 above refuses any second initialization
        (_obs.launchedAt, _obs.launchBlock) = (uint40(block.timestamp), uint40(block.number));
        assembly ("memory-safe") {
            tstore(T_LAUNCH, 1)
            tstore(T_INIT, 1)
        }
        return this.beforeInitialize.selector;
    }

    /// @dev Dynamic LP fee starts at 0 and this hook never changes it: all fees are hook fees.
    function _afterInitialize(address, PoolKey calldata, uint160, int24) internal pure override returns (bytes4) {
        return this.afterInitialize.selector;
    }

    // ================= liquidity + donate: pure passthrough (removal can never be blocked) =================

    /// @dev No liquidity is added inside the launch cap window except by the initialization transaction.
    function _beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal
        view
        override
        returns (bytes4)
    {
        bool initTx;
        assembly ("memory-safe") { initTx := tload(T_INIT) }
        if (block.timestamp < _obs.launchedAt + LAUNCH_CAP_WINDOW && !initTx) revert LiquidityLocked();
        return this.beforeAddLiquidity.selector;
    }

    function _afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) internal pure override returns (bytes4, BalanceDelta) {
        return (this.afterAddLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    function _beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        return this.beforeRemoveLiquidity.selector;
    }

    function _afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) internal pure override returns (bytes4, BalanceDelta) {
        return (this.afterRemoveLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    function _beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        return this.beforeDonate.selector;
    }

    function _afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        return this.afterDonate.selector;
    }

    // ================= swap =================

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(poolId)) revert WrongPool();

        // DNA's own buybacks pay no project fee (and call no module); the platform fee is charged on every swap.
        uint24 pips = sender == buybackBurn ? 0 : _projectPips(key, params);
        _tstore(pips);

        uint256 fee;
        if (_nativeSpecified(params)) {
            (uint256 gross, uint256 f) = _feeOnSpecified(params, pips);
            fee = f;
            _accrue(gross, fee, pips, params);
        }
        return (this.beforeSwap.selector, toBeforeSwapDelta(fee.toInt128(), 0), 0);
    }

    function _afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) internal override returns (bytes4, int128) {
        int128 hookFee = _settleAfter(params, delta.amount0(), uint24(_tload()));
        _capNet(sender, delta.amount1());
        _observe(key);
        return (this.afterSwap.selector, hookFee);
    }

    /// @dev ETH specified: assert the pool moved exactly the ETH the fee was computed on. Else: fee on the actual ETH leg.
    function _settleAfter(SwapParams calldata params, int128 ethDelta, uint24 pips) private returns (int128) {
        bool exactIn = params.amountSpecified < 0;
        uint256 ethAmount = ethDelta < 0 ? uint256(-int256(ethDelta)) : uint256(int256(ethDelta));
        if (_nativeSpecified(params)) {
            (uint256 g, uint256 f) = _feeOnSpecified(params, pips);
            if (ethAmount != (exactIn ? g - f : g)) revert PartialNativeFill();
            return 0;
        }
        uint256 fee = exactIn
            ? FeeMath.fromGross(ethAmount, pips + PLATFORM_FEE)
            : FeeMath.fromNet(ethAmount, pips + PLATFORM_FEE);
        _accrue(exactIn ? ethAmount : ethAmount + fee, fee, pips, params);
        return fee.toInt128();
    }

    // ================= fee internals =================

    /// @dev ETH (currency0) is the specified side iff exactInput == zeroForOne.
    function _nativeSpecified(SwapParams calldata p) private pure returns (bool) {
        return (p.amountSpecified < 0) == p.zeroForOne;
    }

    /// @return gross ETH the fee is levied on, fee total (project + platform) — for the ETH-specified case.
    function _feeOnSpecified(SwapParams calldata p, uint24 pips) private pure returns (uint256 gross, uint256 fee) {
        uint24 total = pips + PLATFORM_FEE;
        bool exactIn = p.amountSpecified < 0;
        uint256 requested = exactIn ? uint256(-p.amountSpecified) : uint256(p.amountSpecified);
        fee = exactIn ? FeeMath.fromGross(requested, total) : FeeMath.fromNet(requested, total);
        gross = exactIn ? requested : requested + fee; // exact-out: trader receives `requested`, pool releases gross
    }

    function _accrue(uint256 gross, uint256 fee, uint24 pips, SwapParams calldata p) private {
        if (fee == 0) return;
        uint256 project = FeeMath.projectShare(gross, fee, pips);
        uint256 platform = fee - project;
        // simplification: only the launch tax exceeds MAX_PROJECT_FEE (module answers are clamped to it), so the pips
        // alone say the project share goes to buyback-and-burn
        if (project != 0) poolManager.mint(pips > MAX_PROJECT_FEE ? buybackBurn : feeVault, ETH_ID, project);
        if (platform != 0) poolManager.mint(platformRevenue, ETH_ID, platform);
        emit FeeTaken(p.zeroForOne, p.amountSpecified < 0, gross, project, platform, pips);
    }

    /// @dev The launch tax if in force (no module is asked), else route → module result, clamped to the constitution.
    ///      Any module failure falls back to baseline.
    function _projectPips(PoolKey calldata key, SwapParams calldata p) private returns (uint24) {
        uint24 tax = _launchTax(_obs.launchBlock);
        if (tax != 0) return tax;
        Route storage r = _route;
        address active = r.active;
        uint24 base = _baseline(_obs.launchedAt);
        bool inCanary = r.canary != address(0) && block.number >= r.canaryStart && r.canaryPeriod != 0
            && (block.number - r.canaryStart) % r.canaryPeriod < r.canaryLen;
        address shadow = r.shadow;
        uint64 count = _obs.swapCount;
        bool doShadow = shadow != address(0) && count % SHADOW_EVERY == 0;

        if (active == address(0) && !inCanary && !doShadow) return base; // no module call: gas-independent

        FeeContext memory ctx = _context(key, p);
        uint24 pips = base;
        if (active != address(0) || inCanary) {
            // the fee must never depend on how much gas the trader sent
            if (gasleft() < (inCanary ? 2 : 1) * MODULE_GAS_CAP + GAS_RESERVE) revert OutOfGasBudget();
            if (active != address(0)) pips = _ask(active, ctx, r.activeParams, base);
            if (inCanary) {
                uint24 c = _ask(r.canary, ctx, r.canaryParams, base);
                uint24 lo = pips > CANARY_MAX_DELTA ? pips - CANARY_MAX_DELTA : 0;
                uint24 hi = pips + CANARY_MAX_DELTA;
                pips = c < lo ? lo : (c > hi ? hi : c);
            }
        }
        // both inputs ≤ MAX_PROJECT_FEE (clamped in _ask), so the canary clamp result is too: no overflow, no re-clamp

        if (doShadow && gasleft() > SHADOW_GAS_CAP + GAS_RESERVE) {
            (bool ok, uint256 v) =
                _staticcallPips(shadow, abi.encodeCall(IFeePolicy.projectFee, (ctx, r.shadowParams)), SHADOW_GAS_CAP);
            if (ok) emit ShadowFee(shadow, v > MAX_PROJECT_FEE ? MAX_PROJECT_FEE : uint24(v)); // shadow failures are ignored
        }
        return pips;
    }

    /// @dev One module call; failure (revert, OOG, wrong return size, > uint24) → `base` (the baseline now) and a breaker
    ///      tick. A valid answer is clamped to MAX_PROJECT_FEE here, at the source, so later math can't overflow uint24.
    function _ask(address module, FeeContext memory ctx, bytes32[4] storage params, uint24 base)
        private
        returns (uint24)
    {
        (bool ok, uint256 v) =
            _staticcallPips(module, abi.encodeCall(IFeePolicy.projectFee, (ctx, params)), MODULE_GAS_CAP);
        if (!ok || v > type(uint24).max) {
            _fail(module);
            return base;
        }
        return v > MAX_PROJECT_FEE ? MAX_PROJECT_FEE : uint24(v);
    }

    /// @dev STATICCALL copying at most 32 bytes back (no returndata bomb); ok only for exactly 32 bytes.
    function _staticcallPips(address target, bytes memory data, uint256 gasCap)
        private
        view
        returns (bool ok, uint256 v)
    {
        assembly ("memory-safe") {
            let out := mload(0x40)
            ok := staticcall(gasCap, target, add(data, 0x20), mload(data), out, 0x20)
            if iszero(eq(returndatasize(), 0x20)) { ok := 0 }
            v := mload(out)
        }
    }

    /// @dev 3% at `launchedAt`, linearly to the baseline (2.2%) at `launchedAt + LAUNCH_DECAY`, the baseline after (and
    ///      before any initialization).
    function _baseline(uint64 launchedAt) private view returns (uint24) {
        uint256 elapsed = block.timestamp - launchedAt;
        if (elapsed >= LAUNCH_DECAY) return BASELINE_PROJECT_FEE;
        return uint24(
            BASELINE_PROJECT_FEE + uint256(LAUNCH_PROJECT_FEE - BASELINE_PROJECT_FEE) * (LAUNCH_DECAY - elapsed)
                / LAUNCH_DECAY
        );
    }

    /// @dev LAUNCH_TAX − k·LAUNCH_TAX_STEP in the k-th block after initialization (k < LAUNCH_TAX_BLOCKS), else 0.
    ///      0 in the initialization transaction itself: the launch buy pays the normal fee.
    function _launchTax(uint256 launchBlock) private view returns (uint24) {
        uint256 k = block.number - launchBlock;
        if (k >= LAUNCH_TAX_BLOCKS || _launchTx()) return 0;
        return uint24(LAUNCH_TAX - k * LAUNCH_TAX_STEP);
    }

    /// @dev The launch caps, inside LAUNCH_CAP_WINDOW. `dnaOut` is the pool's DNA delta to the swapper: > 0 on a buy
    ///      (adds to the block net and the origin's gross; may revert), < 0 on a sell (subtracts from the block net,
    ///      floored at 0; never reverts). The block net is enforced from block 0 (a sell against an older block is
    ///      ignored); the origin's gross is recorded from block 0 and enforced from block LAUNCH_CAP_START. Buybacks
    ///      and the launch buy are exempt and not counted; the launch buy also ends its exemption, so it covers exactly
    ///      one swap. After the window: one comparison, no storage write.
    ///      simplification: the block net also bounds every single swap and the origin's gross every transaction (all
    ///      of a transaction's swaps share its block and origin), so there is no per-swap or per-transaction counter.
    function _capNet(address sender, int128 dnaOut) private {
        if (block.timestamp >= _obs.launchedAt + LAUNCH_CAP_WINDOW) return;
        if (_launchTx()) {
            // the init tx always falls inside the window (it sets launchedAt), so the flag is always cleared here
            assembly ("memory-safe") { tstore(T_LAUNCH, 0) }
            return;
        }
        if (sender == buybackBurn || dnaOut == 0) return;
        Cap memory c = _cap;
        uint256 n = c.blockNumber == block.number ? c.net : 0;
        if (dnaOut > 0) {
            uint256 bought = uint128(dnaOut);
            uint256 w = walletBought[tx.origin] + bought;
            if (w > LAUNCH_WALLET_CAP && block.number >= _obs.launchBlock + LAUNCH_CAP_START) {
                revert WalletCapExceeded();
            }
            walletBought[tx.origin] = w;
            n += bought;
            if (n > LAUNCH_BLOCK_CAP) revert LaunchCapExceeded();
        } else {
            if (n == 0) return; // nothing bought in this block yet: a sell earns no room
            uint256 sold = uint256(-int256(dnaOut));
            n = sold >= n ? 0 : n - sold;
        }
        _cap = Cap(uint64(block.number), uint128(n));
    }

    function _launchTx() private view returns (bool t) {
        assembly ("memory-safe") { t := tload(T_LAUNCH) }
    }

    function _fail(address module) private {
        uint64 start = _failWindowStart;
        uint32 n;
        if (block.number > start + BREAKER_WINDOW) {
            n = 1;
            _failWindowStart = uint64(block.number);
        } else {
            n = _failCount + 1;
        }
        _failCount = n;
        emit ModuleFailed(module, n);
    }

    function _context(PoolKey calldata key, SwapParams calldata p) private view returns (FeeContext memory ctx) {
        (uint160 sqrtPriceX96, int24 tick,,) = poolManager.getSlot0(key.toId());
        bool exactIn = p.amountSpecified < 0;
        ctx = FeeContext({
            zeroForOne: p.zeroForOne,
            exactInput: exactIn,
            amount: exactIn ? uint256(-p.amountSpecified) : uint256(p.amountSpecified),
            sqrtPriceX96: sqrtPriceX96,
            tick: tick,
            volEma: _obs.volEma,
            blockNumber: uint64(block.number)
        });
    }

    /// @dev Observables for fee modules and the site: EMA of |Δtick| per swap (×100, α = 1/8).
    function _observe(PoolKey calldata key) private {
        (, int24 tick,,) = poolManager.getSlot0(key.toId());
        Obs memory o = _obs;
        uint256 move =
            o.swapCount == 0 ? 0 : uint256(int256(tick > o.lastTick ? tick - o.lastTick : o.lastTick - tick)) * 100;
        uint256 ema = (uint256(o.volEma) * 7 + move) / 8;
        _obs = Obs({
            lastTick: tick,
            volEma: ema > type(uint32).max ? type(uint32).max : uint32(ema),
            lastBlock: uint40(block.number),
            swapCount: o.swapCount + 1,
            launchedAt: o.launchedAt,
            launchBlock: o.launchBlock
        });
    }

    function _tstore(uint256 v) private {
        assembly ("memory-safe") { tstore(T_SLOT, v) }
    }

    function _tload() private view returns (uint256 v) {
        assembly ("memory-safe") { v := tload(T_SLOT) }
    }
}
