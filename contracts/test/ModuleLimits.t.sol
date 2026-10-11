// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {ModuleLimits} from "./modules/ModuleConformance.sol";

/// The limits the Sequencer's module conformance suite tests against are the hook's and FeeVault's own.
contract ModuleLimitsTest is Test {
    FeeVault internal vault;

    function setUp() public {
        vault = new FeeVault(IPoolManager(address(0x1001)), address(0x1002), address(0x1003), address(0x1004), address(0x1005), address(0x1006));
    }

    /// the hook's constants are pinned against its source by engine/test/seq-modules.test.ts (the hook can't be deployed
    /// here without its address flags)
    function test_capsAreTheVaults() public view {
        assertEq(ModuleLimits.GAS_CAP, vault.SPLIT_GAS_CAP());
    }

    function testFuzz_splitRuleIsFeeVaults(uint256 b, uint256 l, uint256 t, uint256 g) public view {
        b = bound(b, 0, 12_000);
        l = bound(l, 0, 12_000);
        t = bound(t, 0, 12_000);
        g = bound(g, 0, 12_000);
        assertEq(ModuleLimits.splitValid(b, l, t, g), vault.isValid(b, l, t, g));
    }

    function test_splitRuleEdges() public view {
        uint16[4][6] memory cases = [
            [uint16(3500), 3500, 3000, 0], [uint16(5000), 2000, 1000, 2000], [uint16(2000), 5000, 1000, 2000],
            [uint16(1999), 5000, 1001, 2000], [uint16(3500), 3500, 3000, 1], [uint16(4000), 2000, 4000, 0]
        ];
        for (uint256 i; i < cases.length; ++i) {
            (uint256 b, uint256 l, uint256 t, uint256 g) = (cases[i][0], cases[i][1], cases[i][2], cases[i][3]);
            assertEq(ModuleLimits.splitValid(b, l, t, g), vault.isValid(b, l, t, g));
        }
    }
}
