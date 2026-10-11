// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IDNAHook} from "./interfaces/IDNA.sol";

/// @title Bootstrap
/// @notice One-shot launch initializer, the last target of the Programmable launch graph. In one call it opens the
///         DNA/ETH pool, puts the whole DNA supply into one DNA-only position owned by 0xdEaD (locked forever), buys
///         DNA with `buyEth` of the ETH it was sent (the launch buy: normal hook fees, the one swap the hook's launch
///         guard exempts), then locks the rest of the ETH with the DNA it bought as a full-range position, also owned
///         by 0xdEaD, sized by both sides (whichever runs short limits it). Left over: the DNA the full-range position
///         did not pair is burned (with the main position's rounding dust); the ETH it did not pair goes to the Safe,
///         with any ETH forced into this contract. With the default split (ETH-limited) that ETH is at most
///         ceil(2^96 / sqrtPrice) + 1 wei (one unit of liquidity: 1 wei above tick 0). Pattern adapted from CLAUS
///         Bootstrap (MIT).
/// @dev Positions are minted straight to 0xdEaD (PositionManager.transferFrom reverts while the PoolManager is
///      unlocked, and nobody can approve for 0xdEaD later). Each is paid with the exact amounts the pool charges (same
///      rounding): the DNA transferred to the PositionManager, the ETH sent with the call, both settled from its own
///      balance (SETTLE, payerIsUser = false), so no Permit2 approval exists and nothing stays in the PositionManager.
///      `buyEth` is computed off-chain (script/Launch.s.sol, LaunchSplit: the launch is atomic and first, so the buy is
///      deterministic) a little above the exact split, so the full-range position is ETH-limited; a smaller `buyEth`
///      still launches, DNA-limited, its unpaired ETH going to the Safe.
contract Bootstrap is IUnlockCallback {
    using StateLibrary for IPoolManager;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    /// @notice Lowest allowed lower tick. Below ~-30,000 a boundary tick's maxLiquidityPerTick can be saturated for
    ///         less than the whole supply ("boundary-tick saturation"), griefing any later position that
    ///         shares that tick. CLAUS uses 1,107.
    int24 public constant MIN_TICK_LOWER = -30_000;

    address public immutable safe;
    IPositionManager public immutable positionManager;
    IPoolManager public immutable poolManager;
    /// @notice The only caller of `initialize`: Programmable's graph deployer (ProgrammableCreate2GraphDeployerV1,
    ///         mainnet 0xB012e4A8F2c5FC4E8E4faCA9D5Ad6FfF13FBA887), which deploys every graph target and then calls each
    ///         target's initializer itself. The Router never calls targets directly.
    address public immutable factory;

    bool public launched;

    /// @param sqrtPriceX96 Opening price (DNA per ETH, ETH = currency0).
    /// @param tickLower Lower tick of the DNA-only position (>= MIN_TICK_LOWER).
    /// @param tickUpper Upper tick of the position; must be <= the opening tick so the position holds only DNA.
    /// @param minDnaOut Minimum DNA the launch buy must return.
    /// @param buyEth ETH (of msg.value) the launch buy spends; the rest seeds the full-range position.
    struct LaunchParams {
        uint160 sqrtPriceX96;
        int24 tickLower;
        int24 tickUpper;
        uint256 minDnaOut;
        uint256 buyEth;
    }

    error NotFactory();
    error NotPoolManager();
    error AlreadyLaunched();
    error InvalidParams();
    error InsufficientOutput();
    error PostconditionFailed();

    event Launched(
        address indexed token,
        address indexed hook,
        uint256 indexed positionId,
        uint256 fullRangeId,
        uint256 dnaBought,
        uint256 dnaBurned,
        uint256 ethDust
    );

    constructor(address safe_, IPositionManager positionManager_, address factory_) {
        if (safe_ == address(0) || factory_ == address(0)) revert InvalidParams();
        safe = safe_;
        positionManager = positionManager_;
        poolManager = positionManager_.poolManager();
        factory = factory_;
    }

    /// @notice Open the pool, lock the supply as LP, buy with `buyEth`, lock the bought DNA and the rest of `msg.value`
    ///         as full-range LP, burn the DNA left over. Factory-only, once. Returns the main position's id (the
    ///         full-range one is the next id).
    function initialize(address token, address hook, LaunchParams calldata p)
        external
        payable
        returns (uint256 positionId)
    {
        if (msg.sender != factory) revert NotFactory();
        if (launched) revert AlreadyLaunched();
        launched = true;

        PoolKey memory key = IDNAHook(hook).poolKey();
        if (
            p.buyEth == 0 || p.buyEth >= msg.value || Currency.unwrap(key.currency1) != token
                || p.tickLower < MIN_TICK_LOWER || p.tickLower >= p.tickUpper
        ) revert InvalidParams(); // the launch buy and the full-range ETH are both mandatory
        uint256 pmEth = address(poolManager).balance;
        // The position must sit entirely below the opening price (DNA-only, no ETH needed).
        if (poolManager.initialize(key, p.sqrtPriceX96) < p.tickUpper) revert InvalidParams();

        // 1. Whole supply → one DNA-only position [tickLower, tickUpper), owned by 0xdEaD.
        positionId = _mintMain(key, token, p.tickLower, p.tickUpper);

        // 2. The launch buy, through the hook like any trader (exempt from the launch guard: first swap of the init tx).
        uint256 bought = abi.decode(poolManager.unlock(abi.encode(key, p.buyEth)), (uint256));
        if (bought < p.minDnaOut) revert InsufficientOutput();

        // 3. The rest of the ETH + the DNA it needs → one full-range position, owned by 0xdEaD.
        uint256 lpEth = msg.value - p.buyEth;
        (uint256 fullRangeId, uint256 eth) = _mintFullRange(key, token, bought, lpEth);

        // 4. Burn every DNA held (the DNA the full-range position did not need + rounding dust); any ETH left (the
        //    full-range dust + forced ETH) → Safe.
        uint256 burned = IERC20(token).balanceOf(address(this));
        ERC20Burnable(token).burn(burned);
        uint256 dust = address(this).balance;
        if (dust != 0) {
            (bool ok,) = safe.call{value: dust}("");
            if (!ok) revert PostconditionFailed();
        }
        // the pool got the launch buy (pool share + fee claims) and the full-range ETH; it holds every DNA left
        if (
            IERC20(token).balanceOf(address(this)) != 0 || address(this).balance != 0
                || address(poolManager).balance - pmEth != p.buyEth + eth
                || IERC20(token).balanceOf(address(poolManager)) != IERC20(token).totalSupply()
        ) revert PostconditionFailed();
        emit Launched(token, hook, positionId, fullRangeId, bought, burned, lpEth - eth);
    }

    function _mintMain(PoolKey memory key, address token, int24 tickLower, int24 tickUpper)
        private
        returns (uint256 id)
    {
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(tickUpper);
        uint128 liquidity =
            LiquidityAmounts.getLiquidityForAmount1(sqrtLower, sqrtUpper, IERC20(token).balanceOf(address(this)));
        // Exactly what the pool charges for +liquidity below the price (same rounding), so nothing stays in the PosM.
        uint256 amount = SqrtPriceMath.getAmount1Delta(sqrtLower, sqrtUpper, liquidity, true);
        if (!IERC20(token).transfer(address(positionManager), amount)) revert PostconditionFailed();
        bytes[] memory params = new bytes[](2);
        params[0] =
            abi.encode(key, tickLower, tickUpper, uint256(liquidity), uint128(0), uint128(amount), DEAD, bytes(""));
        params[1] = abi.encode(key.currency1, uint256(0), false); // SETTLE open delta, paid from the PosM's balance
        id = positionManager.nextTokenId();
        positionManager.modifyLiquidities(
            abi.encode(abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE)), params), block.timestamp
        );
        if (IERC721(address(positionManager)).ownerOf(id) != DEAD) revert PostconditionFailed();
    }

    /// @dev Sized by both sides at the post-buy price: the most liquidity `lpEth` and `bought` can pay for. The side
    ///      that runs short limits it; the other side's remainder is left (DNA: burned by the caller; ETH: to the Safe).
    function _mintFullRange(PoolKey memory key, address token, uint256 bought, uint256 lpEth)
        private
        returns (uint256 id, uint256 eth)
    {
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        uint128 l0 = LiquidityAmounts.getLiquidityForAmount0(sqrtP, TickMath.MAX_SQRT_PRICE, lpEth);
        uint128 l1 = LiquidityAmounts.getLiquidityForAmount1(TickMath.MIN_SQRT_PRICE, sqrtP, bought);
        uint128 liquidity = l0 < l1 ? l0 : l1;
        // rounded up from a liquidity rounded down from each side: eth ≤ lpEth, dna ≤ bought
        eth = SqrtPriceMath.getAmount0Delta(sqrtP, TickMath.MAX_SQRT_PRICE, liquidity, true);
        uint256 dna = SqrtPriceMath.getAmount1Delta(TickMath.MIN_SQRT_PRICE, sqrtP, liquidity, true);
        if (!IERC20(token).transfer(address(positionManager), dna)) revert PostconditionFailed();
        bytes[] memory params = new bytes[](3);
        // tickSpacing 1: the usable range is the whole tick range
        params[0] = abi.encode(
            key, TickMath.MIN_TICK, TickMath.MAX_TICK, uint256(liquidity), uint128(eth), uint128(dna), DEAD, bytes("")
        );
        params[1] = abi.encode(key.currency0, uint256(0), false); // SETTLE: the ETH sent with the call
        params[2] = abi.encode(key.currency1, uint256(0), false); // SETTLE: the DNA transferred above
        id = positionManager.nextTokenId();
        positionManager.modifyLiquidities{value: eth}(
            abi.encode(
                abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE), uint8(Actions.SETTLE)), params
            ),
            block.timestamp
        );
        if (IERC721(address(positionManager)).ownerOf(id) != DEAD) revert PostconditionFailed();
    }

    /// @dev Exact-in ETH → DNA, no price limit (the only liquidity is our own position; `minDnaOut` bounds it).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, uint256 amountIn) = abi.decode(data, (PoolKey, uint256));
        BalanceDelta d = poolManager.swap(key, SwapParams(true, -int256(amountIn), TickMath.MIN_SQRT_PRICE + 1), "");
        uint256 bought = uint256(int256(d.amount1()));
        poolManager.settle{value: uint256(-int256(d.amount0()))}();
        poolManager.take(key.currency1, address(this), bought);
        return abi.encode(bought);
    }
}
