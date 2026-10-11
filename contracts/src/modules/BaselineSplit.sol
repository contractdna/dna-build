// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ISplitPolicy} from "../interfaces/IPolicies.sol";

/// @title BaselineSplit — launch split policy: 35% buyback / 30% LP / 25% treasury / 10% games
/// @notice The module the Safe registers at T0 (the name is historical). FeeVault's own immutable fallback stays
///         3500/3500/3000/0, so rolling this module back turns the games off.
contract BaselineSplit is ISplitPolicy {
    /// @notice Fixed split; params ignored.
    /// @return buybackBps 3500
    /// @return lpBps 3000
    /// @return treasuryBps 2500
    /// @return gameBps 1000
    function split(bytes32[4] calldata)
        external
        pure
        returns (uint16 buybackBps, uint16 lpBps, uint16 treasuryBps, uint16 gameBps)
    {
        return (3500, 3000, 2500, 1000);
    }
}
