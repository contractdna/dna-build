// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

/// @title PlatformRevenue
/// @notice Holds the ERC-6909 ETH claims (id 0) the hook mints as the platform fee. Anyone may push them, as ETH, to
///         the one immutable recipient. No owner, no upgrade, no other destination. Adapted from CLAUS (MIT).
contract PlatformRevenue {
    IPoolManager public immutable poolManager;
    address public immutable recipient;

    error NothingToClaim();
    error NotPoolManager();
    error ZeroAddress();

    event Claimed(address indexed recipient, uint256 amount);

    constructor(IPoolManager poolManager_, address recipient_) {
        if (address(poolManager_) == address(0) || recipient_ == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
        recipient = recipient_;
    }

    /// @notice Burn all ETH claims and send the ETH to `recipient`. Re-entry from the recipient hits the
    ///         PoolManager's `AlreadyUnlocked`.
    function claim() external {
        if (poolManager.balanceOf(address(this), 0) == 0) revert NothingToClaim();
        poolManager.unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        uint256 amount = poolManager.balanceOf(address(this), 0);
        poolManager.burn(address(this), 0, amount);
        poolManager.take(Currency.wrap(address(0)), recipient, amount);
        emit Claimed(recipient, amount);
        return "";
    }
}
