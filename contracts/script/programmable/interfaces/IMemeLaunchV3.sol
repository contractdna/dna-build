// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";

// DNA vendoring note: the verified Router source (Etherscan/Blockscout 0x8622DD5bAb44185f2A458ac90384Ac99248f8d56,
// MIT) imports these two structs from `uerc20-factory` and `ClassicInitialBuyVestingWalletV1.sol`. They are inlined
// here verbatim (same ABI) so the Router compiles without those repos. Only the Classic route uses them.
// Mainnet launches now go through its unverified successor 0xBE4bF6Ac8c6F012E1C8f25747A9fBccB2FDAC4C3, whose runtime
// differs only in MAX_PERMIT_LIFETIME (1 h -> 24 h) plus its self-address, domain separator and metadata.
struct UERC20Metadata {
    string description;
    string website;
    string image;
    bytes extraData;
}

enum ClassicInitialBuyCustodyMode {
    Unlocked,
    FixedLock,
    LinearVesting,
    CliffLinearVesting
}

struct ClassicInitialBuyCustodyConfig {
    ClassicInitialBuyCustodyMode mode;
    uint16 durationDays;
    uint16 cliffDays;
}

/// @notice Minimal exact interface for the future-only router-aware Classic launcher.
interface IMemeLaunchV3 {
    struct LaunchParameters {
        string name;
        string symbol;
        uint16 buySwapFeeBps;
        uint16 sellSwapFeeBps;
        bytes32 creatorSalt;
        UERC20Metadata metadata;
        address[] rewardBeneficiaries;
        uint16[] rewardSharesBps;
        ClassicInitialBuyCustodyConfig initialBuyCustody;
    }

    struct LaunchResult {
        address token;
        address rewardVault;
        address positionRecipient;
        uint256 positionTokenId;
        uint256 tokenLiquidityAmount;
        uint256 lockedTokenDust;
        uint256 initialBuyNativeAmount;
        uint256 initialBuyTokenAmount;
        address initialBuyCustody;
        bytes32 poolId;
        bytes32 launchHash;
    }

    function ROUTER() external view returns (address);

    function poolManager() external view returns (IPoolManager);

    function feeHook() external view returns (address);

    function poolKey(address token) external view returns (PoolKey memory);

    function launchFor(address launchWallet, LaunchParameters calldata parameters)
        external
        payable
        returns (LaunchResult memory result);
}
