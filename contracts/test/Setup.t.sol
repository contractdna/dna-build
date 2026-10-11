// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BaseHook} from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

// Toolchain smoke check — proves all pinned deps resolve against one v4-core (d153b048, ABI = deployed v4.0.0)
contract SetupTest is Test {
    function test_toolchain() public pure {
        assertEq(Hooks.ALL_HOOK_MASK, (1 << 14) - 1);
        assertEq(type(BaseHook).name, "BaseHook");
        assertTrue(type(IPositionManager).interfaceId != 0);
        assertEq(type(TimelockController).name, "TimelockController");
    }
}
