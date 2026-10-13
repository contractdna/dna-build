// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ISplitPolicy} from "../../interfaces/IPolicies.sol";

/// @notice Buyback split: reserves a set share of fees for buying back DNA. Params (low 16 bits of each word):
///         [0] buyback bps, [1] LP bps, [2] games bps, [3] reserved and ignored. Treasury takes the remainder.
///         Invalid params answer the fallback 4000 / 3000 / 2000 / 1000.
contract BuybackSplit is ISplitPolicy {
    function split(bytes32[4] calldata params)
        external
        pure
        returns (uint16 buybackBps, uint16 lpBps, uint16 treasuryBps, uint16 gameBps)
    {
        uint256 b = uint16(uint256(params[0]));
        uint256 l = uint16(uint256(params[1]));
        uint256 g = uint16(uint256(params[2]));
        // every term is at most 65535, so the sum can't overflow; it is checked before the subtraction
        uint256 sum = b + l + g;
        if (b >= 2000 && b <= 5000 && l >= 2000 && l <= 5000 && g <= 2000 && sum <= 10_000) {
            uint256 t = 10_000 - sum;
            if (t >= 1000 && t <= 4000) {
                return (uint16(b), uint16(l), uint16(t), uint16(g));
            }
        }
        return (4000, 3000, 2000, 1000);
    }
}
