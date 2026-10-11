// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IFeePolicy, FeeContext} from "../interfaces/IPolicies.sol";

/// @title AdaptiveFee — launch fee policy: pips = min(base + multiplier·volEma / 1e4, cap)
/// @notice No loops, no external calls, no branches on input: gas is the same for every input (SPEC §7).
///         Params (each read from the low bits of its word, so the math can never overflow):
///         [0] base pips (uint24), [1] multiplier ×1e4 (uint32), [2] cap pips (uint24), [3] unused.
///         The registry bounds the params; the hook still clamps the result to MAX_PROJECT_FEE.
contract AdaptiveFee is IFeePolicy {
    /// @notice Project fee in pips for a swap.
    /// @param ctx Swap context built by the hook; only `volEma` (EMA of |Δtick| ×1e2) is used.
    /// @param params [base, multiplier ×1e4, cap, unused].
    /// @return pips min(base + multiplier·volEma/1e4, cap).
    function projectFee(FeeContext calldata ctx, bytes32[4] calldata params) external pure returns (uint24 pips) {
        uint256 base = uint24(uint256(params[0]));
        uint256 mult = uint32(uint256(params[1]));
        uint256 cap = uint24(uint256(params[2]));
        uint256 raw = base + mult * ctx.volEma / 1e4; // < 2^65, no overflow
        assembly ("memory-safe") {
            pips := xor(cap, mul(xor(raw, cap), lt(raw, cap))) // branchless min(raw, cap)
        }
    }
}
