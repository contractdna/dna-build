// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice What a fee policy may see. Built by the hook from its own observables; policies are pure views.
struct FeeContext {
    bool zeroForOne; // true = ETH -> DNA (buy)
    bool exactInput;
    uint256 amount; // |amountSpecified|, in the SPECIFIED currency (DNA for exact-out buys and exact-in sells)
    uint160 sqrtPriceX96;
    int24 tick;
    uint32 volEma; // EMA of |Δtick| per swap, ×1e2
    uint64 blockNumber;
}

/// @notice Registered fee modules. Called with STATICCALL and a gas cap. The hook reads the 32-byte return word as
///         uint256 and clamps it to the constitution cap; revert, OOG or any other return size => baseline.
interface IFeePolicy {
    function projectFee(FeeContext calldata ctx, bytes32[4] calldata params) external view returns (uint24 pips);
}

/// @notice Registered split modules. FeeVault reads the four 32-byte words as uint256 (any other return size =>
///         baseline) and uses the result only if every share is within the immutable bounds and the sum is exactly
///         10_000; otherwise it uses the baseline 3500/3500/3000/0. No clamping, no renormalization. The wei rounding
///         remainder goes to treasury.
interface ISplitPolicy {
    function split(bytes32[4] calldata params)
        external
        view
        returns (uint16 buybackBps, uint16 lpBps, uint16 treasuryBps, uint16 gameBps);
}
