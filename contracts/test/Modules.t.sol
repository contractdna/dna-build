// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AdaptiveFee} from "../src/modules/AdaptiveFee.sol";
import {BaselineSplit} from "../src/modules/BaselineSplit.sol";
import {FeeContext} from "../src/interfaces/IPolicies.sol";

contract ModulesTest is Test {
    AdaptiveFee fee;
    BaselineSplit split;

    function setUp() public {
        fee = new AdaptiveFee();
        split = new BaselineSplit();
    }

    function _ctx(uint32 volEma, uint256 amount, bool z) internal view returns (FeeContext memory) {
        return FeeContext(z, !z, amount, uint160(amount), int24(int256(amount % 887_272)), volEma, uint64(block.number));
    }

    function _p(uint256 base, uint256 mult, uint256 cap) internal pure returns (bytes32[4] memory) {
        return [bytes32(base), bytes32(mult), bytes32(cap), bytes32(0)];
    }

    function test_adaptiveFee_formula() public view {
        assertEq(fee.projectFee(_ctx(0, 1 ether, true), _p(20_000, 5_000, 50_000)), 20_000); // base only
        assertEq(fee.projectFee(_ctx(1_000, 1 ether, true), _p(20_000, 5_000, 50_000)), 20_500); // + 5000·1000/1e4
        assertEq(fee.projectFee(_ctx(1_000_000, 1 ether, true), _p(20_000, 5_000, 50_000)), 50_000); // capped
        assertEq(fee.projectFee(_ctx(type(uint32).max, 0, false), _p(type(uint256).max, type(uint256).max, 0)), 0);
    }

    /// pips == min(base + mult·volEma/1e4, cap) on the low bits of each param; never above cap or uint24.
    function testFuzz_adaptiveFee_bounds(uint32 volEma, uint256 amount, bytes32 b, bytes32 m, bytes32 c) public view {
        uint24 pips = fee.projectFee(_ctx(volEma, amount, amount % 2 == 0), [b, m, c, bytes32(amount)]);
        uint256 base = uint24(uint256(b));
        uint256 mult = uint32(uint256(m));
        uint256 cap = uint24(uint256(c));
        uint256 raw = base + mult * volEma / 1e4;
        assertEq(pips, raw < cap ? raw : cap);
        assertLe(pips, cap);
    }

    /// Gas is input-independent: every fuzzed (ctx, params) costs exactly what a reference call costs.
    function testFuzz_adaptiveFee_constantGas(uint32 volEma, uint256 amount, bytes32 b, bytes32 m, bytes32 c)
        public
        view
    {
        FeeContext memory ref = _ctx(0, 0, false);
        bytes32[4] memory refP = _p(0, 0, 0);
        FeeContext memory x = _ctx(volEma, amount, amount % 2 == 1);
        bytes32[4] memory xp = [b, m, c, bytes32(amount)];
        fee.projectFee(ref, refP); // warm the account

        uint256 g = gasleft();
        fee.projectFee(ref, refP);
        uint256 refGas = g - gasleft();
        g = gasleft();
        fee.projectFee(x, xp);
        uint256 xGas = g - gasleft();
        assertEq(xGas, refGas);
    }

    function test_baselineSplit() public view {
        (uint16 bb, uint16 lp, uint16 tr, uint16 gm) =
            split.split([bytes32(uint256(1)), bytes32(0), bytes32(0), bytes32(0)]);
        assertEq(bb, 3500);
        assertEq(lp, 3000);
        assertEq(tr, 2500);
        assertEq(gm, 1000);
        assertEq(uint256(bb) + lp + tr + gm, 10_000);
    }
}
