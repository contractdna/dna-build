// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {AdaptiveFee} from "../src/modules/AdaptiveFee.sol";
import {ParamSplit} from "../src/modules/ParamSplit.sol";
import {DirectionalFee} from "../src/modules/DirectionalFee.sol";
import {SizeTierFee} from "../src/modules/SizeTierFee.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {FeeContext, IFeePolicy, ISplitPolicy} from "../src/interfaces/IPolicies.sol";

/// Unit, fuzz, boundary and gas tests for the W3 module library. Every module is also called the way the hook and
/// FeeVault call it: raw STATICCALL, gas-capped, returndata size checked.
contract ModuleLibraryTest is Test {
    ParamSplit split;
    DirectionalFee dir;
    SizeTierFee tier;
    AdaptiveFee adaptive;
    FeeVault vault; // only for its pure isValid()

    uint256 constant GAS_CAP = 40_000; // DNAHook.MODULE_GAS_CAP == FeeVault.SPLIT_GAS_CAP
    uint256 constant Q192 = 1 << 192;

    function setUp() public {
        split = new ParamSplit();
        dir = new DirectionalFee();
        tier = new SizeTierFee();
        adaptive = new AdaptiveFee();
        vault = new FeeVault(IPoolManager(address(1)), address(0), address(2), address(3), address(4), address(5));
    }

    // ================================================================ helpers

    function _ctx(bool zeroForOne, bool exactIn, uint256 amount, uint160 sqrtP, uint32 volEma)
        internal
        view
        returns (FeeContext memory)
    {
        return FeeContext(zeroForOne, exactIn, amount, sqrtP, 0, volEma, uint64(block.number));
    }

    function _w(uint256 a, uint256 b, uint256 c, uint256 d) internal pure returns (bytes32[4] memory) {
        return [bytes32(a), bytes32(b), bytes32(c), bytes32(d)];
    }

    /// Exactly what DNAHook._staticcallPips does: STATICCALL, gas cap, ok only for a 32-byte answer.
    function _hookCall(address m, FeeContext memory ctx, bytes32[4] memory p, uint256 gasCap)
        internal
        view
        returns (bool ok, uint256 v, uint256 used, uint256 total)
    {
        bytes memory data = abi.encodeCall(IFeePolicy.projectFee, (ctx, p));
        uint256 g = gasleft();
        assembly ("memory-safe") {
            let out := mload(0x40)
            ok := staticcall(gasCap, m, add(data, 0x20), mload(data), out, 0x20)
            if iszero(eq(returndatasize(), 0x20)) { ok := 0 }
            v := mload(out)
        }
        total = g - gasleft();
        used = vm.lastCallGas().gasTotalUsed;
    }

    /// Exactly what FeeVault.currentSplit does: STATICCALL, 40k cap, ok only for 4 words.
    function _vaultCall(bytes32[4] memory p)
        internal
        view
        returns (bool ok, uint256 b, uint256 l, uint256 t, uint256 g, uint256 used, uint256 total)
    {
        bytes memory data = abi.encodeCall(ISplitPolicy.split, (p));
        address m = address(split);
        uint256 g0 = gasleft();
        assembly ("memory-safe") {
            let out := mload(0x40)
            ok := staticcall(GAS_CAP, m, add(data, 0x20), mload(data), out, 0x80)
            if iszero(eq(returndatasize(), 0x80)) { ok := 0 }
            b := mload(out)
            l := mload(add(out, 0x20))
            t := mload(add(out, 0x40))
            g := mload(add(out, 0x60))
        }
        total = g0 - gasleft();
        used = vm.lastCallGas().gasTotalUsed;
    }

    function _eq4(uint256 b, uint256 l, uint256 t, uint256 g, uint256[4] memory e) internal pure {
        assertEq(b, e[0], "buyback");
        assertEq(l, e[1], "lp");
        assertEq(t, e[2], "treasury");
        assertEq(g, e[3], "games");
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    // ================================================================ ParamSplit

    function test_paramSplit_validParamsPassThrough() public view {
        (uint16 b, uint16 l, uint16 t, uint16 g) = split.split(_w(4000, 3000, 2000, 1000));
        _eq4(b, l, t, g, [uint256(4000), 3000, 2000, 1000]);
        // every corner FeeVault accepts
        (b, l, t, g) = split.split(_w(5000, 2000, 1000, 2000));
        _eq4(b, l, t, g, [uint256(5000), 2000, 1000, 2000]);
        (b, l, t, g) = split.split(_w(2000, 5000, 3000, 0));
        _eq4(b, l, t, g, [uint256(2000), 5000, 3000, 0]);
        (b, l, t, g) = split.split(_w(2000, 2000, 4000, 2000));
        _eq4(b, l, t, g, [uint256(2000), 2000, 4000, 2000]);
    }

    function test_paramSplit_invalidFallsBackToBaselineSplit() public view {
        bytes32[4][9] memory bad = [
            _w(0, 0, 0, 0), // zero
            _w(3500, 3000, 2500, 999), // sum 9999
            _w(3500, 3000, 2500, 1001), // sum 10001
            _w(1999, 3500, 2500, 2001), // buyback low (sum ok)
            _w(5001, 2000, 1000, 1999), // buyback high
            _w(3500, 5001, 1000, 499), // lp high
            _w(4000, 4100, 900, 1000), // treasury low
            _w(2000, 2000, 3900, 2100), // games high
            _w(3500 + (1 << 16), 3000, 2500, 1000) // dirty high bits: whole word is checked, no truncation
        ];
        for (uint256 i; i < bad.length; ++i) {
            (uint16 b, uint16 l, uint16 t, uint16 g) = split.split(bad[i]);
            _eq4(b, l, t, g, [uint256(3500), 3000, 2500, 1000]);
        }
        (uint16 b2, uint16 l2, uint16 t2, uint16 g2) = split.split(_w(type(uint256).max, 1, 1, type(uint256).max));
        _eq4(b2, l2, t2, g2, [uint256(3500), 3000, 2500, 1000]);
    }

    /// Any params: the call never fails, returns exactly 4 words, FeeVault accepts them, and they are the params iff the
    /// params are valid (else BaselineSplit).
    function testFuzz_paramSplit_alwaysAcceptedByFeeVault(bytes32 b, bytes32 l, bytes32 t, bytes32 g) public view {
        (bool ok, uint256 rb, uint256 rl, uint256 rt, uint256 rg,,) = _vaultCall([b, l, t, g]);
        assertTrue(ok, "call failed");
        assertTrue(vault.isValid(rb, rl, rt, rg), "FeeVault would reject");
        if (vault.isValid(uint256(b), uint256(l), uint256(t), uint256(g))) {
            _eq4(rb, rl, rt, rg, [uint256(b), uint256(l), uint256(t), uint256(g)]);
        } else {
            _eq4(rb, rl, rt, rg, [uint256(3500), 3000, 2500, 1000]);
        }
    }

    /// Same, biased into the valid region (random words mostly fail the bounds).
    function testFuzz_paramSplit_inBoundsRegion(uint256 b, uint256 l, uint256 t) public view {
        b = bound(b, 1990, 5010);
        l = bound(l, 1990, 5010);
        t = bound(t, 990, 4010);
        uint256 g = 10_000 - _min(b + l + t, 10_000) + (b % 3 == 0 ? 1 : 0); // sometimes off by one
        (bool ok, uint256 rb, uint256 rl, uint256 rt, uint256 rg,,) =
            _vaultCall([bytes32(b), bytes32(l), bytes32(t), bytes32(g)]);
        assertTrue(ok && vault.isValid(rb, rl, rt, rg));
        if (vault.isValid(b, l, t, g)) _eq4(rb, rl, rt, rg, [b, l, t, g]);
        else _eq4(rb, rl, rt, rg, [uint256(3500), 3000, 2500, 1000]);
    }

    function test_paramSplit_gas() public {
        (uint256 worst, uint256 worstTotal) = (0, 0);
        bytes32[4][3] memory ps = [
            _w(3500, 3000, 2500, 1000), // valid: every check runs
            _w(3500, 3000, 2500, 999), // fails only on the sum
            _w(type(uint256).max, type(uint256).max, type(uint256).max, type(uint256).max)
        ];
        for (uint256 i; i < ps.length; ++i) {
            vm.cool(address(split)); // the hook / vault pay a cold account access on every swap / distribute
            (bool ok,,,,, uint256 used, uint256 total) = _vaultCall(ps[i]);
            assertTrue(ok);
            if (used > worst) worst = used;
            if (total > worstTotal) worstTotal = total;
        }
        console.log("ParamSplit worst case: module gas (vs 40k cap)", worst, "| cold call total", worstTotal);
        assertLt(worst, GAS_CAP / 10, "under a tenth of the 40k cap");
    }

    // ================================================================ DirectionalFee

    function test_directionalFee_formula() public view {
        bytes32[4] memory p = _w(15_000, 10_000, 35_000, 25_000); // buy 1.5%, mult 1.0x, cap 3.5%, sell 2.5%
        assertEq(dir.projectFee(_ctx(true, true, 1 ether, 1 << 96, 0), p), 15_000, "buy base");
        assertEq(dir.projectFee(_ctx(false, true, 1 ether, 1 << 96, 0), p), 25_000, "sell base");
        assertEq(dir.projectFee(_ctx(true, false, 1 ether, 1 << 96, 2_000), p), 17_000, "buy + 1.0x * 2000");
        assertEq(dir.projectFee(_ctx(false, false, 1 ether, 1 << 96, 2_000), p), 27_000, "sell + vol");
        assertEq(dir.projectFee(_ctx(false, true, 1 ether, 1 << 96, 1_000_000), p), 35_000, "capped");
        assertEq(dir.projectFee(_ctx(true, true, 0, 0, type(uint32).max), _w(0, 0, 0, 0)), 0, "zero cap");
    }

    /// pips == min(base(side) + mult·volEma/1e4, cap) on the low bits of each word; ≤ cap; never reverts.
    function testFuzz_directionalFee_matchesReference(
        bool zeroForOne,
        bool exactIn,
        uint256 amount,
        uint160 sqrtP,
        uint32 volEma,
        bytes32[4] memory p
    ) public view {
        (bool ok, uint256 v,,) = _hookCall(address(dir), _ctx(zeroForOne, exactIn, amount, sqrtP, volEma), p, GAS_CAP);
        assertTrue(ok);
        uint256 base = zeroForOne ? uint24(uint256(p[0])) : uint24(uint256(p[3]));
        uint256 cap = uint24(uint256(p[2]));
        assertEq(v, _min(base + uint256(uint32(uint256(p[1]))) * volEma / 1e4, cap));
        assertLe(v, cap);
    }

    /// With sell base == buy base it is exactly AdaptiveFee (same slots 0-2).
    function testFuzz_directionalFee_equalsAdaptiveWhenSymmetric(
        bool zeroForOne,
        uint32 volEma,
        bytes32 base,
        bytes32 mult,
        bytes32 cap
    ) public view {
        FeeContext memory ctx = _ctx(zeroForOne, true, 1 ether, 1 << 96, volEma);
        assertEq(dir.projectFee(ctx, [base, mult, cap, base]), adaptive.projectFee(ctx, [base, mult, cap, bytes32(0)]));
    }

    /// Gas does not depend on the input (branchless select + min): the module's own frame costs the same every time.
    function testFuzz_directionalFee_constantGas(bool z, bool e, uint256 amount, uint32 volEma, bytes32[4] memory p)
        public
        view
    {
        (,, uint256 refGas,) = _hookCall(address(dir), _ctx(false, false, 0, 0, 0), _w(0, 0, 0, 0), GAS_CAP);
        (,, uint256 xGas,) = _hookCall(address(dir), _ctx(z, e, amount, uint160(amount), volEma), p, GAS_CAP);
        assertEq(xGas, refGas);
    }

    function test_directionalFee_gas() public {
        vm.cool(address(dir));
        (bool ok,, uint256 used, uint256 total) = _hookCall(
            address(dir),
            _ctx(false, false, type(uint256).max, type(uint160).max, type(uint32).max),
            _w(type(uint256).max, type(uint256).max, type(uint256).max, type(uint256).max),
            GAS_CAP
        );
        assertTrue(ok);
        console.log("DirectionalFee (constant): module gas (vs 40k cap)", used, "| cold call total", total);
        assertLt(used, GAS_CAP / 10, "under a tenth of the 40k cap");
    }

    // ================================================================ SizeTierFee

    uint256 constant T1 = 1 ether;
    bytes32[4] P_TIER = [bytes32(uint256(20_000)), bytes32(uint256(5_000)), bytes32(uint256(35_000)), bytes32(T1)];

    function test_sizeTier_ethLegs() public view {
        // ETH specified: exact-in buy (zeroForOne, exactIn) and exact-out sell (!zeroForOne, !exactIn)
        bool[2] memory z = [true, false];
        for (uint256 i; i < 2; ++i) {
            bool e = z[i];
            assertEq(tier.projectFee(_ctx(z[i], e, 0, 1 << 96, 0), P_TIER), 20_000);
            assertEq(tier.projectFee(_ctx(z[i], e, T1 - 1, 1 << 96, 0), P_TIER), 20_000);
            assertEq(tier.projectFee(_ctx(z[i], e, T1, 1 << 96, 0), P_TIER), 25_000);
            assertEq(tier.projectFee(_ctx(z[i], e, 4 * T1 - 1, 1 << 96, 0), P_TIER), 25_000);
            assertEq(tier.projectFee(_ctx(z[i], e, 4 * T1, 1 << 96, 0), P_TIER), 30_000);
            assertEq(tier.projectFee(_ctx(z[i], e, 16 * T1 - 1, 1 << 96, 0), P_TIER), 30_000);
            assertEq(tier.projectFee(_ctx(z[i], e, 16 * T1, 1 << 96, 0), P_TIER), 35_000);
            assertEq(tier.projectFee(_ctx(z[i], e, type(uint256).max, 1 << 96, 0), P_TIER), 35_000);
        }
    }

    function test_sizeTier_dnaLegs() public view {
        // DNA specified: exact-out buy (zeroForOne, !exactIn) and exact-in sell (!zeroForOne, exactIn).
        // sqrtP = 1000·2^96 ⇒ 1e6 DNA per ETH ⇒ 1 ETH of value = 1e6 DNA.
        uint160 s = uint160(1000 << 96);
        bool[2] memory z = [true, false];
        for (uint256 i; i < 2; ++i) {
            bool e = !z[i];
            assertEq(tier.projectFee(_ctx(z[i], e, 1e6 * T1 - 1, s, 0), P_TIER), 20_000);
            assertEq(tier.projectFee(_ctx(z[i], e, 1e6 * T1, s, 0), P_TIER), 25_000);
            assertEq(tier.projectFee(_ctx(z[i], e, 4e6 * T1 - 1, s, 0), P_TIER), 25_000);
            assertEq(tier.projectFee(_ctx(z[i], e, 4e6 * T1, s, 0), P_TIER), 30_000);
            assertEq(tier.projectFee(_ctx(z[i], e, 16e6 * T1, s, 0), P_TIER), 35_000);
            // same DNA amount on an ETH leg is read as ETH: top tier
            assertEq(tier.projectFee(_ctx(z[i], !e, 1e6 * T1 - 1, s, 0), P_TIER), 35_000);
        }
    }

    function test_sizeTier_capAndZeroThreshold() public view {
        // step pushes past cap: clamped
        assertEq(tier.projectFee(_ctx(true, true, 100 ether, 1 << 96, 0), _w(30_000, 5_000, 32_000, T1)), 32_000);
        // T = 0: every size is past all three thresholds
        assertEq(tier.projectFee(_ctx(true, true, 0, 1 << 96, 0), _w(10_000, 1_000, 50_000, 0)), 13_000);
        // sqrtP = 0 (no real pool has it) is read as MIN_SQRT_PRICE, no division by zero
        assertEq(tier.projectFee(_ctx(true, false, 1, 0, 0), P_TIER), 35_000);
    }

    /// Reference: v ≥ k ⟺ amount·2^192 ≥ k·s² (exact, 512-bit compare written here without FullMath).
    function _crosses(uint256 amount, uint256 k, uint256 s) internal pure returns (bool) {
        (uint256 rHi, uint256 rLo) = _mul512(k * s, s); // k < 2^84, s < 2^160: k·s fits
        (uint256 lHi, uint256 lLo) = (amount >> 64, amount << 192);
        return lHi > rHi || (lHi == rHi && lLo >= rLo);
    }

    function _mul512(uint256 a, uint256 b) internal pure returns (uint256 hi, uint256 lo) {
        assembly {
            let mm := mulmod(a, b, not(0))
            lo := mul(a, b)
            hi := sub(sub(mm, lo), lt(mm, lo))
        }
    }

    function _refTier(bool z, bool e, uint256 amount, uint256 s, uint256 t, bytes32[4] memory p)
        internal
        pure
        returns (uint256)
    {
        if (s < TickMath.MIN_SQRT_PRICE) s = TickMath.MIN_SQRT_PRICE;
        uint256 n;
        if (amount > 2 ** 95) {
            n = 3; // beyond any real size: top tier
        } else if (e == z) {
            n = (amount >= t ? 1 : 0) + (amount >= 4 * t ? 1 : 0) + (amount >= 16 * t ? 1 : 0);
        } else {
            n = (_crosses(amount, t, s) ? 1 : 0) + (_crosses(amount, 4 * t, s) ? 1 : 0)
                + (_crosses(amount, 16 * t, s) ? 1 : 0);
        }
        uint256 raw = uint256(uint24(uint256(p[0]))) + uint256(uint24(uint256(p[1]))) * n;
        return _min(raw, uint24(uint256(p[2])));
    }

    /// All four leg combinations, any price, any amount, any params: equals the exact reference, ≤ cap, never fails.
    function testFuzz_sizeTier_allLegsMatchReference(
        bool zeroForOne,
        bool exactIn,
        uint256 amount,
        uint160 sqrtP,
        bytes32[4] memory p
    ) public view {
        uint256 t = uint80(uint256(p[3]));
        (bool ok, uint256 v,,) = _hookCall(address(tier), _ctx(zeroForOne, exactIn, amount, sqrtP, 0), p, GAS_CAP);
        assertTrue(ok, "call failed");
        assertEq(v, _refTier(zeroForOne, exactIn, amount, sqrtP, t, p));
        assertLe(v, uint24(uint256(p[2])));
    }

    /// Same, with realistic sizes and prices and amounts placed around the tier edges of the DNA legs.
    function testFuzz_sizeTier_dnaLegEdges(bool buy, uint256 sqrtP, uint256 t, uint8 k, int8 nudge) public view {
        sqrtP = bound(sqrtP, uint256(1) << 96, uint256(1) << 109); // 1 to 2^26 DNA per ETH (DNA's realistic range)
        t = bound(t, 0.01 ether, 10 ether);
        uint256 edge = [t, 4 * t, 16 * t][k % 3];
        // DNA amount worth exactly `edge` ETH at spot, rounded up, then nudged a few wei either side
        uint256 dna = FullMath.mulDivRoundingUp(edge, sqrtP * sqrtP, Q192);
        dna = uint256(int256(dna) + nudge);
        bytes32[4] memory p = _w(20_000, 5_000, 50_000, t);
        bool exactIn = !buy; // DNA specified: exact-out buy, exact-in sell
        uint256 got = tier.projectFee(_ctx(buy, exactIn, dna, uint160(sqrtP), 0), p);
        assertEq(got, _refTier(buy, exactIn, dna, sqrtP, t, p));
    }

    /// Monotone in size: a bigger trade on the same leg never pays a lower fee.
    function testFuzz_sizeTier_monotone(bool z, bool e, uint256 a, uint256 b, uint160 sqrtP, uint64 t) public view {
        (a, b) = a < b ? (a, b) : (b, a);
        bytes32[4] memory p = _w(20_000, 5_000, 35_000, t);
        assertLe(tier.projectFee(_ctx(z, e, a, sqrtP, 0), p), tier.projectFee(_ctx(z, e, b, sqrtP, 0), p));
    }

    function test_sizeTier_gas() public {
        (uint256 worst, uint256 worstTotal) = (0, 0);
        uint160[4] memory prices =
            [TickMath.MIN_SQRT_PRICE, uint160(1 << 96), uint160(1000 << 96), TickMath.MAX_SQRT_PRICE - 1];
        uint256[4] memory amounts = [uint256(0), 1 ether, 2 ** 95, type(uint256).max];
        for (uint256 i; i < 4; ++i) {
            for (uint256 j; j < 4; ++j) {
                for (uint256 leg; leg < 4; ++leg) {
                    vm.cool(address(tier));
                    (bool ok,, uint256 used, uint256 total) = _hookCall(
                        address(tier),
                        _ctx(leg & 1 == 0, leg & 2 == 0, amounts[j], prices[i], 0),
                        _w(type(uint256).max, type(uint256).max, type(uint256).max, type(uint256).max),
                        GAS_CAP
                    );
                    assertTrue(ok);
                    if (used > worst) worst = used;
                    if (total > worstTotal) worstTotal = total;
                }
            }
        }
        console.log("SizeTierFee worst case: module gas (vs 40k cap)", worst, "| cold call total", worstTotal);
        assertLt(worst, GAS_CAP / 10, "under a tenth of the 40k cap");
    }

    // ================================================================ hook path: malformed params never exceed the cap

    /// Every fee module, called exactly like the hook calls it (40k STATICCALL), with arbitrary words and context:
    /// answers a 32-byte word ≤ its own cap (low 24 bits of params[2]) and ≤ uint24, never fails, never runs out of gas.
    function testFuzz_feeModules_hookCallNeverAboveCap(
        uint8 which,
        bool zeroForOne,
        bool exactIn,
        uint256 amount,
        uint160 sqrtP,
        uint32 volEma,
        bytes32[4] memory p
    ) public view {
        address m = which % 2 == 0 ? address(dir) : address(tier);
        (bool ok, uint256 v,,) = _hookCall(m, _ctx(zeroForOne, exactIn, amount, sqrtP, volEma), p, GAS_CAP);
        assertTrue(ok, "hook would fall back to baseline");
        assertLe(v, uint24(uint256(p[2])), "above module cap");
        assertLe(v, type(uint24).max);
    }

    /// Garbage calldata (wrong length / dirty bool or uint160 in the context) can only fail, never answer above cap.
    function testFuzz_feeModules_garbageCalldata(uint8 which, bytes memory junk) public view {
        address m = which % 2 == 0 ? address(dir) : address(tier);
        bytes memory data = abi.encodePacked(IFeePolicy.projectFee.selector, junk);
        (bool ok, bytes memory ret) = m.staticcall{gas: GAS_CAP}(data);
        if (ok) {
            assertEq(ret.length, 32);
            // the cap word is at offset 4 + 7·32 + 2·32 (ctx is 7 static words, then params[0..3])
            uint256 cap = junk.length >= 10 * 32 ? uint24(uint256(_word(junk, 9 * 32))) : 0;
            assertLe(abi.decode(ret, (uint256)), cap);
        }
    }

    function _word(bytes memory b, uint256 off) internal pure returns (bytes32 w) {
        assembly {
            w := mload(add(add(b, 0x20), off))
        }
    }
}
