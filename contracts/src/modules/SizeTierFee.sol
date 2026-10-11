// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IFeePolicy, FeeContext} from "../interfaces/IPolicies.sol";

/// @title SizeTierFee — the fee steps up with the trade's size in ETH
/// @notice Bigger trades pay more, to make sniping and whale dumps costlier. Three fixed tiers at T, 4T and 16T wei of
///         ETH; each tier crossed adds `step`: pips = min(base + step·tiersCrossed, cap).
///         Params, each read from the low bits of its word (so the math can't overflow):
///         [0] base pips (uint24), [1] step pips per tier (uint24), [2] cap pips (uint24), [3] T, wei of ETH (uint80).
///
///         Size is measured in ETH on every leg. The hook gives `ctx.amount` in the SPECIFIED currency:
///         - ETH specified (exact-in buy, exact-out sell): size = amount.
///         - DNA specified (exact-out buy, exact-in sell): size = the DNA amount's ETH value at the pre-swap spot price,
///           amount·2^192 / sqrtPriceX96², rounded down (exact: computed as mulDiv(amount, 2^192, s) / s).
///         The spot value ignores price impact: an exact-out buy pays a bit more ETH than its size, an exact-in sell
///         receives a bit less. Splitting a trade into smaller swaps avoids the tiers (each swap pays the base fee).
///         An amount above 2^95 (more DNA than exists, or ~4e10 ETH) is treated as the top tier; a sqrtPriceX96 below
///         MIN_SQRT_PRICE (never seen in a live pool) is read as MIN_SQRT_PRICE. Both keep the math in range: the
///         module never reverts on any well-formed input. No loops; gas is bounded (far under the hook's 40k cap).
///         The registry bounds the params; the hook still clamps the result to MAX_PROJECT_FEE.
contract SizeTierFee is IFeePolicy {
    uint256 private constant MAX_AMOUNT = 2 ** 95;

    /// @notice Project fee in pips for a swap.
    /// @param ctx Swap context built by the hook; uses `zeroForOne`, `exactInput`, `amount` and `sqrtPriceX96`.
    /// @param params [base, step, cap, T in wei of ETH].
    /// @return pips min(base + step·(size ≥ T) + step·(size ≥ 4T) + step·(size ≥ 16T), cap).
    function projectFee(FeeContext calldata ctx, bytes32[4] calldata params) external pure returns (uint24 pips) {
        uint256 base = uint24(uint256(params[0]));
        uint256 step = uint24(uint256(params[1]));
        uint256 cap = uint24(uint256(params[2]));
        uint256 t = uint80(uint256(params[3]));

        uint256 amount = ctx.amount;
        uint256 tiers = 3;
        if (amount <= MAX_AMOUNT) {
            uint256 size = amount; // ETH is the specified currency iff exactInput == zeroForOne
            if (ctx.exactInput != ctx.zeroForOne) {
                uint256 s = ctx.sqrtPriceX96;
                if (s < TickMath.MIN_SQRT_PRICE) s = TickMath.MIN_SQRT_PRICE;
                // amount ≤ 2^95 and 2^192 / s < 2^160: the mulDiv result fits in 256 bits
                size = FullMath.mulDiv(amount, 1 << 192, s) / s; // floor(floor(x / s) / s) == floor(x / s²)
            }
            // t < 2^80: 16t can't overflow
            tiers = (size >= t ? 1 : 0) + (size >= 4 * t ? 1 : 0) + (size >= 16 * t ? 1 : 0);
        }
        uint256 raw = base + step * tiers; // < 2^27
        pips = uint24(raw < cap ? raw : cap);
    }
}
