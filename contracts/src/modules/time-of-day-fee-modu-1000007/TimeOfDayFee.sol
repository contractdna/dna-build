// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IFeePolicy, FeeContext} from "../../interfaces/IPolicies.sol";

/// @title TimeOfDayFee: one fee rate per six-hour window of the day
/// @notice The day is four windows of six hours: window 0 is hours 0-5, window 1 hours 6-11, window 2 hours 12-17 and
///         window 3 hours 18-23. Param i is the rate for window i: pips read from the low 24 bits of its word, clamped to
///         [MIN_RATE, MAX_RATE] = [10,000, 30,000] (1% to 3%). Any params therefore give a fee inside that range.
///         The hour comes from block time, not from a clock: hour = (blockNumber / BLOCKS_PER_HOUR) % 24, with
///         BLOCKS_PER_HOUR = 1800 (3600 seconds at 2-second blocks). It tracks block-time hours, not exact UTC: it
///         drifts from UTC wherever the chain's blocks are not 2 seconds apart.
///         Pure: the answer depends only on ctx.blockNumber and params. Keeps no state and makes no external calls.
///         No loops, so gas is bounded and far under the hook's 40,000 cap. The registry bounds the params; the hook
///         still clamps the result to MAX_PROJECT_FEE.
contract TimeOfDayFee is IFeePolicy {
    /// Blocks per hour: 3600 seconds at 2 seconds per block.
    uint256 private constant BLOCKS_PER_HOUR = 1800;
    /// Lowest fee the module answers, in pips (1%).
    uint256 private constant MIN_RATE = 10_000;
    /// Highest fee the module answers, in pips (3%).
    uint256 private constant MAX_RATE = 30_000;

    /// @notice Project fee in pips for a swap, from the window of the hour its block falls in.
    /// @param ctx Swap context built by the hook; only `blockNumber` is used.
    /// @param params [window 0 rate, window 1 rate, window 2 rate, window 3 rate], in pips, each read from its low 24 bits.
    /// @return pips The rate of the window, clamped to [10,000, 30,000].
    function projectFee(FeeContext calldata ctx, bytes32[4] calldata params) external pure returns (uint24 pips) {
        uint256 hourOfDay = (uint256(ctx.blockNumber) / BLOCKS_PER_HOUR) % 24;
        uint256 window = hourOfDay / 6; // 0 for hours 0-5, 1 for 6-11, 2 for 12-17, 3 for 18-23
        uint256 rate;
        if (window == 0) {
            rate = uint24(uint256(params[0]));
        } else if (window == 1) {
            rate = uint24(uint256(params[1]));
        } else if (window == 2) {
            rate = uint24(uint256(params[2]));
        } else {
            rate = uint24(uint256(params[3]));
        }
        if (rate < MIN_RATE) {
            rate = MIN_RATE;
        } else if (rate > MAX_RATE) {
            rate = MAX_RATE;
        }
        pips = uint24(rate);
    }
}
