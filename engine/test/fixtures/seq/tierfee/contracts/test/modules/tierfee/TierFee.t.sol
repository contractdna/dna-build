// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FeeContext} from "../../../src/interfaces/IPolicies.sol";
import {TierFee} from "../../../src/modules/tierfee/TierFee.sol";
import {FeeModuleConformance} from "../ModuleConformance.sol";

contract TierFeeTest is FeeModuleConformance {
    function _creationCode() internal pure override returns (bytes memory) {
        return type(TierFee).creationCode;
    }

    function _bounds() internal pure override returns (bytes32[4] memory lo, bytes32[4] memory hi) {
        lo = [bytes32(uint256(10_000)), bytes32(0), bytes32(uint256(10_000)), bytes32(uint256(1e17))];
        hi = [bytes32(uint256(35_000)), bytes32(uint256(5_000)), bytes32(uint256(35_000)), bytes32(uint256(1e19))];
    }

    function _p(uint256 base, uint256 step, uint256 cap, uint256 t) internal pure returns (bytes32[4] memory) {
        return [bytes32(base), bytes32(step), bytes32(cap), bytes32(t)];
    }

    function _fee(uint256 amount, bytes32[4] memory p) internal view returns (uint256) {
        return TierFee(module).projectFee(FeeContext(true, true, amount, 2 ** 96, 0, 0, 1), p);
    }

    function test_tiers() public view {
        bytes32[4] memory p = _p(20_000, 5_000, 35_000, 1 ether);
        assertEq(_fee(0, p), 20_000);
        assertEq(_fee(1 ether - 1, p), 20_000);
        assertEq(_fee(1 ether, p), 25_000);
        assertEq(_fee(4 ether - 1, p), 25_000);
        assertEq(_fee(4 ether, p), 30_000);
        assertEq(_fee(100 ether, p), 30_000);
    }

    function test_cap() public view {
        bytes32[4] memory p = _p(30_000, 5_000, 32_000, 1 ether);
        assertEq(_fee(0, p), 30_000);
        assertEq(_fee(1 ether, p), 32_000);
        assertEq(_fee(4 ether, p), 32_000);
    }

    function test_hardCap() public view {
        assertEq(_fee(4 ether, _p(48_000, 5_000, 60_000, 1 ether)), 50_000);
        assertEq(_fee(0, _p(49_000, 5_000, 60_000, 1 ether)), 49_000);
    }

    function test_noTierSize() public view {
        assertEq(_fee(100 ether, _p(20_000, 5_000, 35_000, 0)), 20_000);
    }

    function testFuzz_biggerNeverCheaper(uint256 a, uint256 b, uint256[4] memory seed) public view {
        bytes32[4] memory p = _inBounds(seed);
        a = bound(a, 0, 1e24);
        b = bound(b, a, 1e24);
        assertLe(_fee(a, p), _fee(b, p));
    }
}
