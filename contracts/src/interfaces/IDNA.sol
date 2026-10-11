// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

/// @notice Fee route the registry pushes into the hook. Read by the hook from its own storage (no cross-contract read
///         in the swap path). A zero module address means "baseline". canary == 0 means no canary; the hook treats
///         canaryPeriod == 0 as never in window (the registry enforces 50 <= canaryLen < canaryPeriod).
struct Route {
    address active;
    address canary;
    address shadow;
    uint64 canaryStart; // first block of the canary schedule
    uint32 canaryPeriod; // schedule repeats every `canaryPeriod` blocks
    uint32 canaryLen; // canary is live for the first `canaryLen` blocks of each period (≥ 50)
    bytes32[4] activeParams;
    bytes32[4] canaryParams;
    bytes32[4] shadowParams;
}

/// @notice Split route the registry exposes to FeeVault (not in the swap path).
struct SplitRoute {
    address module; // zero = baseline 3500/3500/3000/0
    bytes32[4] params;
}

interface IDNAHook {
    event RouteSet(address active, address canary, address shadow);
    event ShadowFee(address indexed module, uint24 pips);
    event ModuleFailed(address indexed module, uint32 failCount);
    event FeeTaken(bool buy, bool exactInput, uint256 gross, uint256 project, uint256 platform, uint24 pips);

    function setRoute(Route calldata route) external;
    function breaker() external view returns (uint32 failCount, uint64 windowStart);
    function observables() external view returns (int24 lastTick, uint32 volEma, uint64 lastBlock, uint64 swapCount);
    function baselineFee() external view returns (uint24);
    function poolKey() external view returns (PoolKey memory);
    function route() external view returns (Route memory);
    function token() external view returns (address);
}

interface IModuleRegistry {
    function splitRoute() external view returns (SplitRoute memory);
    function safe() external view returns (address);
    function agent() external view returns (address);
    function anchorKey() external view returns (address);
    function agentPaused() external view returns (bool);
    function level() external view returns (uint8);
}

/// @notice One-shot wiring for contracts deployed at precomputed addresses. Front-run proof: callable only by the
///         immutable `initializer`, only once, and only with `hook.code.length != 0`.
interface IInitializable {
    function initialize(address hook) external;
}
