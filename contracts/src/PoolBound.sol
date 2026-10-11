// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IDNAHook, IInitializable} from "./interfaces/IDNA.sol";

/// @notice Shared wiring for vaults that act on the canonical pool. Deployed at a precomputed address with
///         `(poolManager, initializer)` (never the hook: the hook's constructor takes this address), then bound to
///         the hook exactly once by `initializer` (front-run proof).
interface IBaseHook {
    function poolManager() external view returns (IPoolManager);
}

abstract contract PoolBound is IInitializable {
    IPoolManager public immutable poolManager;
    address public immutable initializer;
    address public hook;
    address public token;

    error AlreadyInitialized();
    error NotInitialized();
    error NotInitializer();
    error NotPoolManager();
    error WrongHook();
    error ZeroAddress();

    constructor(IPoolManager poolManager_, address initializer_) {
        if (address(poolManager_) == address(0) || initializer_ == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
        initializer = initializer_;
    }

    function initialize(address hook_) public virtual {
        if (msg.sender != initializer) revert NotInitializer();
        if (hook != address(0)) revert AlreadyInitialized();
        if (hook_.code.length == 0 || IBaseHook(hook_).poolManager() != poolManager) revert WrongHook();
        PoolKey memory k = IDNAHook(hook_).poolKey();
        if (address(k.hooks) != hook_ || Currency.unwrap(k.currency1) == address(0)) revert WrongHook();
        hook = hook_;
        token = Currency.unwrap(k.currency1);
    }

    /// @dev Canonical PoolKey (SPEC §1): (ETH, DNA, DYNAMIC_FEE_FLAG, tickSpacing 1, hook).
    function _key() internal view returns (PoolKey memory) {
        if (hook == address(0)) revert NotInitialized();
        return PoolKey(Currency.wrap(address(0)), Currency.wrap(token), LPFeeLibrary.DYNAMIC_FEE_FLAG, 1, IHooks(hook));
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }
}
