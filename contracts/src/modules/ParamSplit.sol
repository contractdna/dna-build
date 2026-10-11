// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ISplitPolicy} from "../interfaces/IPolicies.sol";

/// @title ParamSplit — fee split set by its params, inside FeeVault's bounds
/// @notice Returns the four shares stored in its params, in basis points: [0] buyback, [1] LP, [2] treasury, [3] games.
///         They are used only if FeeVault would accept them: buyback 2000–5000, LP 2000–5000, treasury 1000–4000,
///         games 0–2000, summing to exactly 10_000. Anything else returns BaselineSplit's 3500/3000/2500/1000, so this
///         module never reverts and never hands FeeVault a split it would reject. Each word is checked whole (no
///         truncation). No loops, no storage, no external calls.
contract ParamSplit is ISplitPolicy {
    /// @notice The split for these params.
    /// @param params [buyback, lp, treasury, games] in bps.
    /// @return buybackBps params[0] if valid, else 3500
    /// @return lpBps params[1] if valid, else 3000
    /// @return treasuryBps params[2] if valid, else 2500
    /// @return gameBps params[3] if valid, else 1000
    function split(bytes32[4] calldata params)
        external
        pure
        returns (uint16 buybackBps, uint16 lpBps, uint16 treasuryBps, uint16 gameBps)
    {
        uint256 b = uint256(params[0]);
        uint256 l = uint256(params[1]);
        uint256 t = uint256(params[2]);
        uint256 g = uint256(params[3]);
        // same rule as FeeVault.isValid; every term is bounded before the sum, so the sum can't overflow
        bool valid = b >= 2000 && b <= 5000 && l >= 2000 && l <= 5000 && t >= 1000 && t <= 4000 && g <= 2000
            && b + l + t + g == 10_000;
        if (!valid) return (3500, 3000, 2500, 1000);
        return (uint16(b), uint16(l), uint16(t), uint16(g));
    }
}
