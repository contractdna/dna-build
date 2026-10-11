// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IFeePolicy, FeeContext} from "../interfaces/IPolicies.sol";

/// @title DirectionalFee — separate buy and sell fees, plus the AdaptiveFee volatility term
/// @notice Buys (ETH → DNA, `zeroForOne`) start from one base fee and sells from another; both add
///         multiplier·volEma/1e4 and stop at the cap: pips = min(base(side) + multiplier·volEma/1e4, cap).
///         Params, each read from the low bits of its word (so the math can't overflow), slots 0–2 as in AdaptiveFee:
///         [0] buy base pips (uint24), [1] multiplier ×1e4 (uint32), [2] cap pips (uint24), [3] sell base pips (uint24).
///         With [3] == [0] it charges exactly what AdaptiveFee charges. No loops, no branches on input: constant gas.
///         The registry bounds the params; the hook still clamps the result to MAX_PROJECT_FEE.
contract DirectionalFee is IFeePolicy {
    /// @notice Project fee in pips for a swap.
    /// @param ctx Swap context built by the hook; uses `zeroForOne` (true = buy) and `volEma`.
    /// @param params [buy base, multiplier ×1e4, cap, sell base].
    /// @return pips min(base(side) + multiplier·volEma/1e4, cap).
    function projectFee(FeeContext calldata ctx, bytes32[4] calldata params) external pure returns (uint24 pips) {
        uint256 buy = uint24(uint256(params[0]));
        uint256 mult = uint32(uint256(params[1]));
        uint256 cap = uint24(uint256(params[2]));
        uint256 sell = uint24(uint256(params[3]));
        bool isBuy = ctx.zeroForOne;
        uint256 volEma = ctx.volEma;
        assembly ("memory-safe") {
            // unchecked on purpose: mult, volEma < 2^32 and every base < 2^24, so nothing can overflow
            let raw := add(xor(sell, mul(xor(buy, sell), isBuy)), div(mul(mult, volEma), 10000)) // (isBuy ? buy : sell) + vol
            pips := xor(cap, mul(xor(raw, cap), lt(raw, cap))) // branchless min(raw, cap)
        }
    }
}
