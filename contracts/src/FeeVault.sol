// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IModuleRegistry} from "./interfaces/IDNA.sol";
import {ISplitPolicy} from "./interfaces/IPolicies.sol";

/// @title FeeVault
/// @notice Receives the project fee as ERC-6909 ETH claims (id 0) minted by the hook and splits them four ways:
///         buyback, LP and game shares move as claims (`transfer`, no unlock); the treasury share is burned and paid
///         as ETH to the Safe. The split comes from the registry's split module, accepted only if every share is
///         inside its constitutional bounds and the shares sum to exactly 10_000 bps; anything else (code-less
///         registry, zero module, revert, out-of-gas, malformed or out-of-bounds output) means the 3500/3500/3000/0
///         baseline. The baseline sends nothing to games: any rollback or module failure turns the games off.
/// @dev No initializer: nothing here depends on the hook. Constructor args are all addresses whose own init code never
///      contains FeeVault's address (registry/buyback/LP vault/GamePot take `(…, initializer)`, Safe is external), so
///      the chain `hook ← FeeVault ← {registry, BuybackBurn, LiquidityVault, GamePot, Safe}` is acyclic.
contract FeeVault {
    uint256 public constant MIN_DISTRIBUTE = 0.05 ether;
    uint256 public constant SPLIT_GAS_CAP = 40_000;
    uint256 internal constant GAS_GUARD = SPLIT_GAS_CAP + 30_000;

    uint256 public constant BASELINE_BUYBACK = 3500;
    uint256 public constant BASELINE_LP = 3500;
    uint256 public constant BASELINE_TREASURY = 3000;
    uint256 public constant BASELINE_GAME = 0;

    IPoolManager public immutable poolManager;
    address public immutable registry;
    address public immutable buybackBurn;
    address public immutable liquidityVault;
    address public immutable gamePot;
    address public immutable safe;

    /// @notice Sum of every `distribute()` amount (all four shares), in wei.
    uint256 public totalDistributed;

    error BelowMinimum();
    error NotPoolManager();
    error OutOfGasBudget();
    error ZeroAddress();

    event Distributed(uint256 amount, uint256 buyback, uint256 lp, uint256 treasury, uint256 game, bool baseline);

    constructor(
        IPoolManager poolManager_,
        address registry_,
        address buybackBurn_,
        address liquidityVault_,
        address gamePot_,
        address safe_
    ) {
        if (
            address(poolManager_) == address(0) || buybackBurn_ == address(0) || liquidityVault_ == address(0)
                || gamePot_ == address(0) || safe_ == address(0)
        ) revert ZeroAddress();
        poolManager = poolManager_;
        registry = registry_; // may be zero / code-less: baseline forever
        buybackBurn = buybackBurn_;
        liquidityVault = liquidityVault_;
        gamePot = gamePot_;
        safe = safe_;
    }

    /// @notice Split all held claims. Anyone; needs ≥ MIN_DISTRIBUTE so dust calls are pointless.
    function distribute() external {
        uint256 amount = poolManager.balanceOf(address(this), 0);
        if (amount < MIN_DISTRIBUTE) revert BelowMinimum();
        (uint256 b, uint256 l,, uint256 g, bool baseline) = currentSplit();
        uint256 buyback = amount * b / 10_000;
        uint256 lp = amount * l / 10_000;
        uint256 game = amount * g / 10_000;
        uint256 treasury = amount - buyback - lp - game; // rounding remainder → treasury; exact sum by construction
        totalDistributed += amount;
        poolManager.transfer(buybackBurn, 0, buyback);
        poolManager.transfer(liquidityVault, 0, lp);
        if (game != 0) poolManager.transfer(gamePot, 0, game);
        poolManager.unlock(abi.encode(treasury));
        emit Distributed(amount, buyback, lp, treasury, game, baseline);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        uint256 treasury = abi.decode(data, (uint256));
        poolManager.burn(address(this), 0, treasury);
        poolManager.take(Currency.wrap(address(0)), safe, treasury);
        return "";
    }

    /// @notice The split `distribute()` would use now, in bps.
    function currentSplit()
        public
        view
        returns (uint256 buyback, uint256 lp, uint256 treasury, uint256 game, bool baseline)
    {
        (bool ok, bytes memory ret) = registry.staticcall(abi.encodeCall(IModuleRegistry.splitRoute, ()));
        // SplitRoute is static: (address, bytes32[4]) = 5 words. Decode the address as a word so dirty bits can't revert.
        if (ok && ret.length == 160) {
            (uint256 module, bytes32[4] memory params) = abi.decode(ret, (uint256, bytes32[4]));
            if (module != 0 && module <= type(uint160).max) {
                // The caller must leave the module its full gas cap, else they could force the baseline.
                if (gasleft() < GAS_GUARD) revert OutOfGasBudget();
                bytes memory data = abi.encodeCall(ISplitPolicy.split, (params));
                // Copy at most 128 bytes back (no returndata bomb); ok only for exactly 128 bytes (4 words).
                assembly ("memory-safe") {
                    let out := mload(0x40)
                    ok := staticcall(SPLIT_GAS_CAP, module, add(data, 0x20), mload(data), out, 0x80)
                    if iszero(eq(returndatasize(), 0x80)) { ok := 0 }
                    buyback := mload(out)
                    lp := mload(add(out, 0x20))
                    treasury := mload(add(out, 0x40))
                    game := mload(add(out, 0x60))
                }
                if (ok && isValid(buyback, lp, treasury, game)) return (buyback, lp, treasury, game, false);
            }
        }
        return (BASELINE_BUYBACK, BASELINE_LP, BASELINE_TREASURY, BASELINE_GAME, true);
    }

    /// @notice Valid iff each share is within its bounds and they sum to exactly 10_000. No clamping, no renormalizing.
    ///         Bounds: buyback 2000–5000, LP 2000–5000, treasury 1000–4000, games 0–2000.
    function isValid(uint256 b, uint256 l, uint256 t, uint256 g) public pure returns (bool) {
        // each term ≤ 5000 is checked before the sum, so the sum can't overflow on dirty words
        return b >= 2000 && b <= 5000 && l >= 2000 && l <= 5000 && t >= 1000 && t <= 4000 && g <= 2000
            && b + l + t + g == 10_000;
    }
}
