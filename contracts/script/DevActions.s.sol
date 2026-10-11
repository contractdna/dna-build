// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {DNAToken} from "../src/DNAToken.sol";
import {DNAHook} from "../src/DNAHook.sol";
import {ModuleRegistry} from "../src/ModuleRegistry.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {BuybackBurn} from "../src/BuybackBurn.sol";
import {LiquidityVault} from "../src/LiquidityVault.sol";
import {AdaptiveFee} from "../src/modules/AdaptiveFee.sol";
import {BaselineSplit} from "../src/modules/BaselineSplit.sol";
import {FeeContext} from "../src/interfaces/IPolicies.sol";

/// @dev Local-only fee module that always reverts: every call is a hook failure (baseline fee + ModuleFailed).
contract RevertingFee {
    function projectFee(FeeContext calldata, bytes32[4] calldata) external pure returns (uint24) {
        revert("dev: always reverts");
    }
}

/// @title DevActions — drive a LaunchLocal deployment through every event the engine indexes (anvil only)
/// @notice Each entry point is one `forge script script/DevActions.s.sol --sig "<fn>()" --rpc-url $RPC --broadcast`.
///         Reads engine/deployments/31337.json. Roles: anvil account 0 = Safe, 4 = trader (anyone).
///         TIME TRAVEL (cannot happen inside a broadcast script; do it between runs):
///           - every registry op waits MIN_DELAY = 1 h: `cast rpc evm_increaseTime 3600 && cast rpc evm_mine`
///             between two `advance()` runs.
///           - BuybackBurn.process / LiquidityVault.add cool down 4 h: a second `distribute()` needs
///             `cast rpc evm_increaseTime 14400 && cast rpc evm_mine` first.
///         Typical order (engine/scripts/e2e.sh): swaps · advance ×3 (+1 h each) · rollback · advance ×3 (+1 h each)
///         · swaps · distribute · cancelDemo.
///         Module lifecycle `advance()` drives (one step per 1 h):
///           reverting fee: Register → SetShadow → SetCanary → (rollback() trips the breaker; anyone rolls back)
///           adaptive fee:  Register → SetShadow (once the bad one left the shadow slot) → SetCanary (once it was
///                          rolled back) → PromoteActive
///           baseline split: Register → SetShadow → SetCanary → PromoteActive (status bookkeeping for Split kind)
contract DevActions is Script {
    // anvil default keys (public test keys, never use elsewhere)
    uint256 internal constant SAFE_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant TRADER_KEY = 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a;
    bytes32 internal constant SALT = keccak256("dna.dev");
    string internal constant DEPLOYMENT = "../engine/deployments/31337.json";

    // canary schedule: live for the first 500 of every 1000 blocks from the queue block (DevActions mines far fewer)
    uint32 internal constant PERIOD = 1000;
    uint32 internal constant LEN = 500;

    ModuleRegistry registry;
    DNAHook hook;
    IPoolManager pm;
    DNAToken token;
    FeeVault feeVault;
    BuybackBurn buyback;
    LiquidityVault lpVault;

    function setUp() public {
        require(block.chainid == 31337, "DevActions: anvil only");
        string memory j = vm.readFile(DEPLOYMENT);
        registry = ModuleRegistry(vm.parseJsonAddress(j, ".registry"));
        hook = DNAHook(vm.parseJsonAddress(j, ".hook"));
        pm = IPoolManager(vm.parseJsonAddress(j, ".poolManager"));
        token = DNAToken(vm.parseJsonAddress(j, ".token"));
        feeVault = FeeVault(vm.parseJsonAddress(j, ".feeVault"));
        buyback = BuybackBurn(vm.parseJsonAddress(j, ".buybackBurn"));
        lpVault = LiquidityVault(vm.parseJsonAddress(j, ".liquidityVault"));
    }

    // ------------------------------------------------------------------ entry points

    /// @notice Trader buys with 3 ETH (exact-in, ETH specified: FeeTaken from beforeSwap) and sells half its DNA
    ///         (exact-in, DNA specified: FeeTaken from afterSwap). 3 ETH puts FeeVault above MIN_DISTRIBUTE.
    function swaps() external {
        vm.startBroadcast(TRADER_KEY);
        PoolSwapTest r = _router();
        _swap(r, true, 3 ether);
        token.approve(address(r), type(uint256).max);
        _swap(r, false, token.balanceOf(vm.addr(TRADER_KEY)) / 2);
        vm.stopBroadcast();
    }

    /// @notice Safe: execute every op whose 1 h delay passed, then queue each module's next lifecycle step.
    function advance() external {
        vm.startBroadcast(SAFE_KEY);
        (address good, address bad, address split) = _modules();
        uint256 n = registry.nextId();
        for (uint256 id = 1; id <= n; ++id) {
            (,, uint64 queuedAt,) = registry.queued(id);
            if (queuedAt != 0 && block.timestamp >= queuedAt + registry.MIN_DELAY()) registry.execute(id);
        }
        ModuleRegistry.Status g = _status(good);
        ModuleRegistry.Status b = _status(bad);
        ModuleRegistry.Status s = _status(split);
        if (!_pending(bad)) {
            if (b == ModuleRegistry.Status.None) _register(bad, ModuleRegistry.Kind.Fee, "dev-reverting-fee-v0");
            else if (b == ModuleRegistry.Status.Proposed) _op(ModuleRegistry.Op.SetShadow, abi.encode(bad));
            else if (b == ModuleRegistry.Status.Shadow) _canary(bad);
        }
        if (!_pending(good)) {
            if (g == ModuleRegistry.Status.None) {
                _register(good, ModuleRegistry.Kind.Fee, "adaptive-fee-v1");
            }
            // one shadow slot and one canary slot: wait for the bad module to leave them
            else if (g == ModuleRegistry.Status.Proposed && b >= ModuleRegistry.Status.Canary) {
                _op(ModuleRegistry.Op.SetShadow, abi.encode(good));
            } else if (g == ModuleRegistry.Status.Shadow && b == ModuleRegistry.Status.RolledBack) {
                _canary(good);
            } else if (g == ModuleRegistry.Status.Canary) {
                _op(ModuleRegistry.Op.PromoteActive, abi.encode(good));
            }
        }
        if (!_pending(split)) {
            if (s == ModuleRegistry.Status.None) _register(split, ModuleRegistry.Kind.Split, "baseline-split-v1");
            else if (s == ModuleRegistry.Status.Proposed) _op(ModuleRegistry.Op.SetShadow, abi.encode(split));
            else if (s == ModuleRegistry.Status.Shadow) _canary(split);
            else if (s == ModuleRegistry.Status.Canary) _op(ModuleRegistry.Op.PromoteActive, abi.encode(split));
        }
        vm.stopBroadcast();
        console.log("statuses good/bad/split", uint8(_status(good)), uint8(_status(bad)), uint8(_status(split)));
    }

    /// @notice With the reverting module in its canary window: three small buys fail it three times (breaker),
    ///         then the trader (anyone) rolls the fee route back to baseline.
    function rollback() external {
        (, address bad,) = _modules();
        require(_status(bad) == ModuleRegistry.Status.Canary, "reverting module is not canary yet");
        vm.startBroadcast(TRADER_KEY);
        PoolSwapTest r = _router();
        for (uint256 i; i < 3; ++i) {
            _swap(r, true, 0.01 ether);
        }
        registry.rollback(ModuleRegistry.Kind.Fee);
        vm.stopBroadcast();
    }

    /// @notice Anyone: split FeeVault, buy back + burn, add auto-liquidity. Cooldowns: 4 h between process/add runs.
    function distribute() external {
        vm.startBroadcast(TRADER_KEY);
        feeVault.distribute();
        buyback.process();
        lpVault.add();
        vm.stopBroadcast();
    }

    /// @notice Safe queues a level raise and cancels it at once (a guardian intervention: Queued + Cancelled).
    function cancelDemo() external {
        vm.startBroadcast(SAFE_KEY);
        uint256 id = registry.queue(ModuleRegistry.Op.SetLevel, abi.encode(uint8(6)));
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        registry.cancel(ids);
        vm.stopBroadcast();
    }

    // ------------------------------------------------------------------ helpers

    /// @dev Deterministic CREATE2 (0x4e59) addresses, deployed on first use (inside the caller's broadcast).
    function _modules() internal returns (address good, address bad, address split) {
        good = _deploy(type(AdaptiveFee).creationCode);
        bad = _deploy(type(RevertingFee).creationCode);
        split = _deploy(type(BaselineSplit).creationCode);
    }

    function _router() internal returns (PoolSwapTest) {
        return PoolSwapTest(_deploy(abi.encodePacked(type(PoolSwapTest).creationCode, abi.encode(pm))));
    }

    function _deploy(bytes memory init) internal returns (address a) {
        a = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, SALT, keccak256(init))))));
        if (a.code.length == 0) {
            (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(SALT, init));
            require(ok && a.code.length != 0, "create2 failed");
        }
    }

    function _swap(PoolSwapTest r, bool buy, uint256 amountIn) internal {
        PoolKey memory key = hook.poolKey();
        r.swap{value: buy ? amountIn : 0}(
            key,
            SwapParams(buy, -int256(amountIn), buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _status(address m) internal view returns (ModuleRegistry.Status) {
        return registry.getModule(m).status;
    }

    /// @dev True if some queued (not executed/cancelled) op targets `m` (every module op's first word is the module).
    function _pending(address m) internal view returns (bool) {
        uint256 n = registry.nextId();
        for (uint256 id = 1; id <= n; ++id) {
            (ModuleRegistry.Op op,, uint64 queuedAt, bytes memory data) = registry.queued(id);
            if (queuedAt != 0 && op <= ModuleRegistry.Op.SetParams && abi.decode(data, (address)) == m) return true;
        }
        return false;
    }

    function _op(ModuleRegistry.Op op, bytes memory data) internal {
        registry.queue(op, data);
    }

    function _canary(address m) internal {
        _op(ModuleRegistry.Op.SetCanary, abi.encode(m, uint64(block.number), PERIOD, LEN));
    }

    /// @dev specHash = keccak256 of the manifest file's exact bytes (the engine hashes the same file).
    function _register(address m, ModuleRegistry.Kind kind, string memory manifest) internal {
        bytes32 spec = keccak256(bytes(vm.readFile(string.concat("../engine/modules/", manifest, ".json"))));
        bytes32[4] memory p;
        bytes32[4] memory lo;
        bytes32[4] memory hi;
        if (keccak256(bytes(manifest)) == keccak256("adaptive-fee-v1")) {
            // AdaptiveFee: [base pips, multiplier ×1e4, cap pips, unused]
            p = [bytes32(uint256(20_000)), bytes32(uint256(13_000)), bytes32(uint256(50_000)), bytes32(0)];
            lo = [bytes32(uint256(10_000)), bytes32(uint256(10_000)), bytes32(0), bytes32(0)];
            hi = [bytes32(uint256(50_000)), bytes32(uint256(18_000)), bytes32(uint256(50_000)), bytes32(0)];
        }
        _op(ModuleRegistry.Op.Register, abi.encode(m, kind, spec, p, lo, hi));
    }
}
