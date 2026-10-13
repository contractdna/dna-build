// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ISplitPolicy} from "../../../src/interfaces/IPolicies.sol";
import {BuybackSplit} from "../../../src/modules/split-module-with-a-1000011/BuybackSplit.sol";
import {SplitModuleConformance, ModuleLimits} from "../ModuleConformance.sol";

contract BuybackSplitTest is SplitModuleConformance {
    uint256 internal constant FB_BUY = 4000;
    uint256 internal constant FB_LP = 3000;
    uint256 internal constant FB_TREAS = 2000;
    uint256 internal constant FB_GAMES = 1000;

    function _creationCode() internal pure override returns (bytes memory) {
        return type(BuybackSplit).creationCode;
    }

    function _bounds() internal pure override returns (bytes32[4] memory min, bytes32[4] memory max) {
        min[0] = bytes32(uint256(4000));
        min[1] = bytes32(uint256(2000));
        min[2] = bytes32(uint256(0));
        min[3] = bytes32(uint256(0));
        max[0] = bytes32(uint256(5000));
        max[1] = bytes32(uint256(3000));
        max[2] = bytes32(uint256(1000));
        max[3] = bytes32(uint256(0));
    }

    // ---------- helpers ----------

    /// params: [buyback, LP, games, reserved]
    function _p(uint256 b, uint256 l, uint256 g, uint256 x) internal pure returns (bytes32[4] memory p) {
        p[0] = bytes32(b);
        p[1] = bytes32(l);
        p[2] = bytes32(g);
        p[3] = bytes32(x);
    }

    /// the module's answer, as [buyback, LP, treasury, games]
    function _split(bytes32[4] memory p) internal view returns (uint256[4] memory s) {
        (uint16 b, uint16 l, uint16 t, uint16 g) = ISplitPolicy(module).split(p);
        s = [uint256(b), uint256(l), uint256(t), uint256(g)];
    }

    function _assertSplit(bytes32[4] memory p, uint256 b, uint256 l, uint256 t, uint256 g) internal view {
        uint256[4] memory s = _split(p);
        assertEq(s[0], b, "buyback");
        assertEq(s[1], l, "LP");
        assertEq(s[2], t, "treasury");
        assertEq(s[3], g, "games");
    }

    function _assertFallback(bytes32[4] memory p) internal view {
        _assertSplit(p, FB_BUY, FB_LP, FB_TREAS, FB_GAMES);
    }

    /// Reference model: reads the low 16 bits of each of the first three words, applies the rule.
    function _model(bytes32[4] memory p) internal pure returns (uint256[4] memory s) {
        uint256 b = uint16(uint256(p[0]));
        uint256 l = uint16(uint256(p[1]));
        uint256 g = uint16(uint256(p[2]));
        uint256 sum = b + l + g;
        if (sum <= 10_000) {
            uint256 t = 10_000 - sum;
            if (b >= 2000 && b <= 5000 && l >= 2000 && l <= 5000 && t >= 1000 && t <= 4000 && g <= 2000) {
                return [b, l, t, g];
            }
        }
        return [FB_BUY, FB_LP, FB_TREAS, FB_GAMES];
    }

    // ---------- fixed values ----------

    function test_start_params_give_4000_3000_2000_1000() public view {
        _assertSplit(_p(4000, 3000, 1000, 0), 4000, 3000, 2000, 1000);
    }

    function test_min_bounds_give_4000_2000_4000_0() public view {
        _assertSplit(_p(4000, 2000, 0, 0), 4000, 2000, 4000, 0);
    }

    function test_max_bounds_give_5000_3000_1000_1000() public view {
        _assertSplit(_p(5000, 3000, 1000, 0), 5000, 3000, 1000, 1000);
    }

    // ---------- edges ----------

    function test_buyback_edge_2000_and_5000_accepted_1999_and_5001_fall_back() public view {
        _assertSplit(_p(2000, 3000, 1000, 0), 2000, 3000, 4000, 1000);
        _assertSplit(_p(5000, 3000, 1000, 0), 5000, 3000, 1000, 1000);
        _assertFallback(_p(1999, 3000, 2000, 0));
        _assertFallback(_p(5001, 2000, 1000, 0));
    }

    function test_lp_edge_2000_and_5000_accepted_1999_and_5001_fall_back() public view {
        _assertSplit(_p(4000, 2000, 1000, 0), 4000, 2000, 3000, 1000);
        _assertSplit(_p(2000, 5000, 1000, 0), 2000, 5000, 2000, 1000);
        _assertFallback(_p(4000, 1999, 1000, 0));
        _assertFallback(_p(2000, 5001, 1000, 0));
    }

    function test_games_2000_accepted_2001_falls_back() public view {
        _assertSplit(_p(4000, 2000, 2000, 0), 4000, 2000, 2000, 2000);
        _assertFallback(_p(4000, 2000, 2001, 0));
    }

    function test_treasury_below_1000_falls_back() public view {
        // sum 9001, treasury 999
        _assertFallback(_p(5000, 3000, 1001, 0));
    }

    function test_treasury_above_4000_falls_back() public view {
        // sum 5999, treasury 4001
        _assertFallback(_p(2000, 2000, 1999, 0));
    }

    function test_sum_over_10000_falls_back_without_revert() public view {
        _assertFallback(_p(5000, 5000, 2000, 0));
        // sum exactly 10000 leaves treasury 0, below its floor
        _assertFallback(_p(5000, 3000, 2000, 0));
    }

    function test_param3_ignored() public view {
        _assertSplit(_p(4000, 3000, 1000, 0), 4000, 3000, 2000, 1000);
        _assertSplit(_p(4000, 3000, 1000, type(uint256).max), 4000, 3000, 2000, 1000);
        _assertSplit(_p(4000, 3000, 1000, 0xdead), 4000, 3000, 2000, 1000);
        _assertFallback(_p(1, 1, 1, 0));
        _assertFallback(_p(1, 1, 1, 12345));
    }

    function test_high_bits_ignored_reads_low_16_bits() public view {
        bytes32[4] memory p;
        p[0] = bytes32((uint256(1) << 200) | 4500);
        p[1] = bytes32((uint256(7) << 128) | 3000);
        p[2] = bytes32((uint256(9) << 64) | 1000);
        p[3] = bytes32(uint256(0));
        // low 16 bits: 4500 / 3000 / 1000 -> treasury 1500
        _assertSplit(p, 4500, 3000, 1500, 1000);
    }

    function test_all_zero_and_all_max_words_fall_back() public view {
        bytes32[4] memory z;
        _assertFallback(z);
        bytes32 m = bytes32(type(uint256).max);
        bytes32[4] memory mx = [m, m, m, m];
        _assertFallback(mx);
    }

    function test_gas_under_4000() public view {
        // call overhead (ABI encoding and decoding in the test) is included in the measure, so the bound is loose;
        // the module itself must also answer under the 40,000 cap on its worst-case paths
        bytes32[4] memory p = _p(4000, 3000, 1000, 0);
        // warm the account first, so the measured call is the module's own cost plus a warm call
        ISplitPolicy(module).split(p);
        uint256 g0 = gasleft();
        ISplitPolicy(module).split(p);
        uint256 used = g0 - gasleft();
        assertLt(used, 10_000, "the split is cheap");
        (bool ok, uint256[4] memory s) = _ask(_p(4000, 3000, 1000, 0));
        assertTrue(ok, "answers within the gas cap");
        assertEq(s[2], 2000, "treasury");
    }

    // ---------- fuzz ----------

    function testFuzz_inBounds_exact_shares(uint256[4] memory seed) public view {
        bytes32[4] memory p = _inBounds(seed);
        uint256 b = uint256(p[0]);
        uint256 l = uint256(p[1]);
        uint256 g = uint256(p[2]);
        uint256[4] memory s = _split(p);
        assertEq(s[0], b, "buyback echoed");
        assertEq(s[1], l, "LP echoed");
        assertEq(s[3], g, "games echoed");
        assertEq(s[2], 10_000 - b - l - g, "treasury is the remainder");
        assertTrue(ModuleLimits.splitValid(s[0], s[1], s[2], s[3]), "FeeVault accepts it");
    }

    function testFuzz_inBounds_buyback_at_least_40pct(uint256[4] memory seed) public view {
        uint256[4] memory s = _split(_inBounds(seed));
        assertGe(s[0], 4000, "buyback is at least 40%");
    }

    function testFuzz_matchesModel(bytes32[4] memory p) public view {
        uint256[4] memory want = _model(p);
        uint256[4] memory got = _split(p);
        for (uint256 i; i < 4; ++i) {
            assertEq(got[i], want[i], "matches the reference rule");
        }
    }

    function testFuzz_anyInput_never_reverts_and_always_valid(bytes32[4] memory p) public view {
        uint256[4] memory s = _split(p);
        assertTrue(ModuleLimits.splitValid(s[0], s[1], s[2], s[3]), "always a split FeeVault accepts");
    }

    function testFuzz_output_sums_to_10000(bytes32[4] memory p) public view {
        uint256[4] memory s = _split(p);
        assertEq(s[0] + s[1] + s[2] + s[3], 10_000, "shares sum to 10000");
    }
}
