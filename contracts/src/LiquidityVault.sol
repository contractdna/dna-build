// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {PoolBound} from "./PoolBound.sol";

/// @title LiquidityVault
/// @notice Turns its ERC-6909 ETH claims into permanent ETH-only liquidity just above the current price.
///         Positions are owned by this contract and there is no decrease, withdraw or collect path: liquidity only grows.
contract LiquidityVault is PoolBound {
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    uint256 public constant COOLDOWN = 4 hours;
    /// @notice Fixed range width (≈ +22% above price at tickSpacing 1). Constant so no caller can pick the shape.
    uint24 public constant WIDTH = 2_000;

    uint256 public lastAdd;
    uint256 public positions; // next salt

    error CoolingDown();
    error BadWidth();
    error NoLiquidity();
    error PendingDelta();

    event LiquidityAdded(uint256 indexed salt, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 eth);

    constructor(IPoolManager poolManager_, address initializer_) PoolBound(poolManager_, initializer_) {}

    /// @notice Add all claims as liquidity over [tick + 2, tick + 2 + WIDTH] (capped at MAX_TICK).
    function add() external {
        if (block.timestamp < lastAdd + COOLDOWN) revert CoolingDown();
        lastAdd = block.timestamp;
        poolManager.unlock("");
    }

    function unlockCallback(bytes calldata) external onlyPoolManager returns (bytes memory) {
        PoolKey memory key = _key();
        (, int24 tick,,) = poolManager.getSlot0(key.toId());
        // ETH is currency0: a range strictly above the price holds only ETH. slot0.tick ≤ tick(sqrtP), so +2 clears it.
        int256 lower = int256(tick) + 2;
        if (lower >= TickMath.MAX_TICK) revert BadWidth();
        int256 upper = lower + int256(uint256(WIDTH));
        if (upper > TickMath.MAX_TICK) upper = TickMath.MAX_TICK;
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(int24(lower));
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(int24(upper));

        uint256 budget = poolManager.balanceOf(address(this), 0);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmount0(sqrtLower, sqrtUpper, budget);
        if (liquidity == 0) revert NoLiquidity();
        // = what the pool charges; provably <= budget (floor L, ceil amount), so no check
        uint256 need = SqrtPriceMath.getAmount0Delta(sqrtLower, sqrtUpper, liquidity, true);

        uint256 salt = positions++;
        poolManager.burn(address(this), 0, need);
        poolManager.modifyLiquidity(
            key, ModifyLiquidityParams(int24(lower), int24(upper), int256(uint256(liquidity)), bytes32(salt)), ""
        );
        if (
            poolManager.currencyDelta(address(this), key.currency0) != 0
                || poolManager.currencyDelta(address(this), key.currency1) != 0
        ) revert PendingDelta();
        emit LiquidityAdded(salt, int24(lower), int24(upper), liquidity, need);
        return "";
    }
}
