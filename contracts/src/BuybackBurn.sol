// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {PoolBound} from "./PoolBound.sol";

/// @title BuybackBurn
/// @notice Spends its ERC-6909 ETH claims buying DNA on the canonical pool and burns every DNA it holds.
///         Anyone may call, every 1 h, ≤ 1 ETH, price move ≤ 0.50% (partial fill allowed; unspent ETH stays as claims).
///         Claims below MIN_SIZE are dust: `NothingToBuy` (a revert, so the cooldown is not spent) until more arrive.
///         The hook charges this sender no project fee, only the platform fee (0.30%), like on any swap. Swap/settle
///         pattern adapted from CLAUS FeeProcessor (MIT).
contract BuybackBurn is PoolBound {
    using StateLibrary for IPoolManager;

    uint256 public constant MAX_SIZE = 1 ether;
    uint256 public constant MIN_SIZE = 1e12; // 0.000001 ETH: dust below it (and g − n, c stay positive)
    uint256 public constant COOLDOWN = 1 hours; // caps buyback throughput at ≤ 24 ETH/day
    uint24 public constant PLATFORM_FEE = 3_000; // = DNAHook.PLATFORM_FEE (0.30%, pips), what this contract's swaps pay
    uint256 private constant MAX_PROTOCOL_FEE = 1_000; // v4 ProtocolFeeLibrary.MAX_PROTOCOL_FEE (0.10%, pips)
    uint256 private constant MAX_STEPS = 64; // swap steps inside the 0.5% band: ≤ 51 ticks + 1 bitmap word edge + the last
    uint256 private constant DNA_SLACK = 2 ** 32 + MAX_STEPS; // DNA wei the pool's rounding can add to `out` (see below)

    uint256 public lastProcess;

    error CoolingDown();
    error NothingToBuy();

    event Buyback(uint256 spent, uint256 burned, uint256 pending);

    constructor(IPoolManager poolManager_, address initializer_) PoolBound(poolManager_, initializer_) {}

    function process() external {
        if (block.timestamp < lastProcess + COOLDOWN) revert CoolingDown();
        uint256 size = poolManager.balanceOf(address(this), 0);
        if (size > MAX_SIZE) size = MAX_SIZE;
        if (size < MIN_SIZE) revert NothingToBuy();
        lastProcess = block.timestamp;
        uint256 spent = abi.decode(poolManager.unlock(abi.encode(size)), (uint256));
        uint256 burned = ERC20Burnable(token).balanceOf(address(this)); // includes any DNA sent here
        if (burned != 0) ERC20Burnable(token).burn(burned);
        emit Buyback(spent, burned, poolManager.balanceOf(address(this), 0));
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        uint256 size = abi.decode(data, (uint256));
        PoolKey memory key = _key();
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        uint160 limit = uint160(uint256(sqrtP) * 9975 / 10_000); // 0.50% in price
        if (limit <= TickMath.MIN_SQRT_PRICE) limit = TickMath.MIN_SQRT_PRICE + 1;

        // Exact-output buy: the hook then takes its fee on the ETH the pool actually took, so a fill that stops at the
        // limit pays only on what filled (an exact-input fill that stops short reverts in the hook: PartialNativeFill).
        // Budget, so that spent ≤ size in any pool state (n = swap steps ≤ MAX_STEPS; P(limit) = (limit / 2^96)^2):
        //  - spent = pool ETH + the hook's fromNet(pool ETH), and g + fromNet(g) ≤ size for g = floor(size·(1 − 0.30%)).
        //  - pool ETH = Σ (amountIn + protocol fee) ≤ Σ amountIn / (1 − 0.10%) + n (the v4 fee rounds up < 1 wei a
        //    step; 0.10% = the highest protocol fee v4 allows), so Σ amountIn ≤ c + 2n keeps pool ETH ≤ g for
        //    c = floor((g − n)·(1 − 0.10%)) − 2n.
        //  - Σ amountIn ≤ A + 2n (getAmount0Delta rounds up < 2 wei a step), A = the exact ETH for the price move. The
        //    price never passes the limit, so each DNA costs ≤ 1 / P(limit) ETH: A ≤ D / P(limit), D = the exact DNA
        //    bought ≤ out + n (amountOut floors < 1 wei a step) + 2^32 (the last step's price is rounded at most one
        //    Q96 unit past `out`, worth < L / 2^96 ≤ 2^32 DNA wei since L < 2^128).
        //  - out = floor(c·P(limit)) − DNA_SLACK gives D ≤ c·P(limit), so A ≤ c, Σ amountIn ≤ c + 2n, pool ETH ≤ g.
        // n: the band spans 50.07 ticks, so ≤ 51 initialized ticks, ≤ 1 tick-bitmap word edge and the last step.
        uint256 g = FullMath.mulDiv(size, 1e6 - PLATFORM_FEE, 1e6);
        uint256 c = FullMath.mulDiv(g - MAX_STEPS, 1e6 - MAX_PROTOCOL_FEE, 1e6) - 2 * MAX_STEPS;
        uint256 dna = FullMath.mulDiv(FullMath.mulDiv(c, limit, FixedPoint96.Q96), limit, FixedPoint96.Q96);
        if (dna <= DNA_SLACK) revert NothingToBuy(); // DNA priced so high the budget buys nothing past the rounding slack
        uint256 out = dna - DNA_SLACK;
        BalanceDelta d = poolManager.swap(key, SwapParams(true, int256(out), limit), "");
        uint256 spent = uint256(int256(-d.amount0())); // pool ETH + platform fee
        uint256 bought = uint256(int256(d.amount1()));
        poolManager.burn(address(this), 0, spent); // pay from claims; the rest stays as claims
        if (bought != 0) poolManager.take(key.currency1, address(this), bought);
        return abi.encode(spent);
    }
}
