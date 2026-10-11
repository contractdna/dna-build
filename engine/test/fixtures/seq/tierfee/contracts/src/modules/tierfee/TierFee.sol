// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FeeContext, IFeePolicy} from "../../interfaces/IPolicies.sol";

/// @title TierFee: a bigger swap pays one or two steps more
/// @notice Params, each read from the low bits of its word: [0] base pips (uint24), [1] step pips (uint24), [2] cap pips
///         (uint24), [3] tier size T in units of the specified amount (uint80). One step at T, two at 4T.
contract TierFee is IFeePolicy {
    uint256 private constant HARD_CAP = 50_000;

    function projectFee(FeeContext calldata ctx, bytes32[4] calldata params) external pure returns (uint24 pips) {
        uint256 base = uint24(uint256(params[0]));
        uint256 step = uint24(uint256(params[1]));
        uint256 cap = uint24(uint256(params[2]));
        uint256 t = uint80(uint256(params[3]));
        if (cap > HARD_CAP) cap = HARD_CAP;
        uint256 tiers;
        if (t != 0 && ctx.amount >= t) tiers = 1;
        if (t != 0 && ctx.amount / 4 >= t) tiers = 2;
        uint256 raw = base + step * tiers;
        pips = uint24(raw < cap ? raw : cap);
    }
}
