// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Swap fee math on the gross ETH leg (pips = 1e-6). Adapted from CLAUS FeeMath (MIT) for a dynamic project fee.
/// @dev total = project + platform. Exact-input: fee = gross·total. Exact-output: fee chosen so that net = gross − fee
///      is exactly the requested amount (ceil). Project share = floor(gross·project); the platform gets the remainder,
///      so project + platform == fee exactly and platform ≥ its nominal share.
library FeeMath {
    uint256 internal constant ONE = 1_000_000;

    function fromGross(uint256 gross, uint24 totalPips) internal pure returns (uint256) {
        return Math.mulDiv(gross, totalPips, ONE);
    }

    function fromNet(uint256 net, uint24 totalPips) internal pure returns (uint256) {
        return Math.mulDiv(net, totalPips, ONE - totalPips, Math.Rounding.Ceil);
    }

    /// @return project share of `fee` taken on `gross` (≤ fee); platform = fee − project.
    function projectShare(uint256 gross, uint256 fee, uint24 projectPips) internal pure returns (uint256 project) {
        project = Math.mulDiv(gross, projectPips, ONE);
        if (project > fee) project = fee; // unreachable for valid pips; keeps the split exact under any input
    }
}
