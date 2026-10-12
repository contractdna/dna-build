// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FeeModuleConformance} from "../ModuleConformance.sol";
import {FeeContext, IFeePolicy} from "../../../src/interfaces/IPolicies.sol";
import {TimeOfDayFee} from "../../../src/modules/time-of-day-fee-modu-1000007/TimeOfDayFee.sol";

/// Tests for TimeOfDayFee: four window rates, one per six hours of block time (1800 blocks an hour, 43200 a day).
/// Every call goes through the deployed `module` address via IFeePolicy.
contract TimeOfDayFeeTest is FeeModuleConformance {
    uint256 internal constant BLOCKS_PER_HOUR = 1800;
    uint256 internal constant BLOCKS_PER_DAY = 43_200;
    uint256 internal constant MIN_RATE = 10_000;
    uint256 internal constant MAX_RATE = 30_000;
    /// A quarter of the cap: the measure includes the cold-account access (2,600) and the call overhead (about 6,000 in all).
    uint256 internal constant GAS_BUDGET = 10_000;

    function _creationCode() internal pure override returns (bytes memory) {
        return type(TimeOfDayFee).creationCode;
    }

    function _bounds() internal pure override returns (bytes32[4] memory min, bytes32[4] memory max) {
        for (uint256 i; i < 4; ++i) {
            min[i] = bytes32(MIN_RATE);
            max[i] = bytes32(MAX_RATE);
        }
    }

    /// Four rates in the given order, one per window.
    function _rates(uint256 w0, uint256 w1, uint256 w2, uint256 w3) internal pure returns (bytes32[4] memory p) {
        p[0] = bytes32(w0);
        p[1] = bytes32(w1);
        p[2] = bytes32(w2);
        p[3] = bytes32(w3);
    }

    /// Four distinct in-bounds rates, one range per window, from any seed.
    function _distinct(uint256[4] memory seed) internal pure returns (bytes32[4] memory p) {
        p[0] = bytes32(_bound(seed[0], 10_000, 14_999));
        p[1] = bytes32(_bound(seed[1], 15_000, 19_999));
        p[2] = bytes32(_bound(seed[2], 20_000, 24_999));
        p[3] = bytes32(_bound(seed[3], 25_000, 30_000));
    }

    /// A swap context that only differs from the others in its block number.
    function _ctx(uint64 blockNo) internal pure returns (FeeContext memory) {
        return FeeContext({
            zeroForOne: true,
            exactInput: true,
            amount: 1 ether,
            sqrtPriceX96: 79_228_162_514_264_337_593_543_950_336,
            tick: 0,
            volEma: 0,
            blockNumber: blockNo
        });
    }

    /// The fee the module answers for a block, with the given rates.
    function _fee(uint64 blockNo, bytes32[4] memory p) internal view returns (uint256) {
        return IFeePolicy(module).projectFee(_ctx(blockNo), p);
    }

    /// The window (0 to 3) the formula gives a block: hour = (block / 1800) % 24, window = hour / 6.
    function _window(uint256 blockNo) internal pure returns (uint256) {
        return ((blockNo / BLOCKS_PER_HOUR) % 24) / 6;
    }

    /// Hours 0, 5 answer window 0; 6, 11 window 1; 12, 17 window 2; 18, 23 window 3, each with its own rate.
    function test_eachWindowReturnsItsRate() public view {
        bytes32[4] memory p = _rates(11_000, 16_000, 22_000, 28_000);
        uint256[8] memory hourList = [uint256(0), 5, 6, 11, 12, 17, 18, 23];
        uint256[8] memory want = [uint256(11_000), 11_000, 16_000, 16_000, 22_000, 22_000, 28_000, 28_000];
        for (uint256 i; i < hourList.length; ++i) {
            uint64 blockNo = uint64(hourList[i] * BLOCKS_PER_HOUR + 900);
            assertEq(_fee(blockNo, p), want[i], "the hour's window answers its rate");
        }
    }

    /// All 24 hours, from their first block to their last: each hour belongs to the window of its six.
    function test_everyHourMapsToItsWindow() public view {
        bytes32[4] memory p = _rates(11_000, 16_000, 22_000, 28_000);
        for (uint256 h; h < 24; ++h) {
            uint256 first = h * BLOCKS_PER_HOUR;
            uint256 last = first + BLOCKS_PER_HOUR - 1;
            assertEq(_fee(uint64(first), p), uint256(p[h / 6]), "first block of the hour");
            assertEq(_fee(uint64(last), p), uint256(p[h / 6]), "last block of the hour");
        }
    }

    /// The edges: block 1799 is hour 0 and 1800 is hour 1 (both window 0); 10799 is window 0, 10800 window 1; 43199 is
    /// window 3, and 43200 wraps to hour 0 and window 0.
    function test_hourBoundaries() public view {
        bytes32[4] memory p = _rates(11_000, 16_000, 22_000, 28_000);
        assertEq(_fee(1799, p), 11_000, "block 1799 is hour 0, window 0");
        assertEq(_fee(1800, p), 11_000, "block 1800 is hour 1, window 0");
        assertEq(_fee(10_799, p), 11_000, "block 10799 is window 0");
        assertEq(_fee(10_800, p), 16_000, "block 10800 is window 1");
        assertEq(_fee(43_199, p), 28_000, "block 43199 is window 3");
        assertEq(_fee(43_200, p), 11_000, "block 43200 wraps to window 0");
    }

    /// Any block, distinct in-bounds rates: the answer is the rate of the window its hour falls in.
    function testFuzz_everyHourMapsToItsWindow(uint64 blockNo, uint256[4] memory seed) public view {
        bytes32[4] memory p = _distinct(seed);
        assertEq(_fee(blockNo, p), uint256(p[_window(blockNo)]), "the block's window answers its rate");
    }

    /// A day later (43200 blocks) the same window answers, whenever the later block number does not overflow.
    function testFuzz_cycleRepeatsDaily(uint64 blockNo, uint256[4] memory seed) public view {
        uint64 early = uint64(_bound(uint256(blockNo), 0, type(uint64).max - BLOCKS_PER_DAY));
        bytes32[4] memory p = _distinct(seed);
        assertEq(_fee(early, p), _fee(early + uint64(BLOCKS_PER_DAY), p), "a day later answers the same");
    }

    /// Any context, params inside the bounds: the fee is a rate in [10,000, 30,000] (1% to 3%).
    function testFuzz_inBoundsFeeWithinRange(FeeContext memory ctx, uint256[4] memory seed) public view {
        bytes32[4] memory p = _inBounds(seed);
        uint256 fee = IFeePolicy(module).projectFee(ctx, p);
        assertGe(fee, MIN_RATE, "not below the floor");
        assertLe(fee, MAX_RATE, "not above the ceiling");
    }

    /// Rates under the floor (0 and 9,999) answer the floor, in every window.
    function test_clampLow() public view {
        bytes32[4] memory zeros = _rates(0, 0, 0, 0);
        bytes32[4] memory justUnder = _rates(9_999, 9_999, 9_999, 9_999);
        for (uint256 w; w < 4; ++w) {
            uint64 blockNo = uint64(6 * w * BLOCKS_PER_HOUR);
            assertEq(_fee(blockNo, zeros), MIN_RATE, "0 answers the floor");
            assertEq(_fee(blockNo, justUnder), MIN_RATE, "9,999 answers the floor");
        }
    }

    /// Rates over the ceiling (30,001, 50,001 and the largest 24-bit value) answer the ceiling, in every window.
    function test_clampHigh() public view {
        bytes32[4] memory justOver = _rates(30_001, 30_001, 30_001, 30_001);
        bytes32[4] memory far = _rates(50_001, 50_001, 50_001, 50_001);
        bytes32[4] memory maxed = _rates(16_777_215, 16_777_215, 16_777_215, 16_777_215);
        for (uint256 w; w < 4; ++w) {
            uint64 blockNo = uint64(6 * w * BLOCKS_PER_HOUR);
            assertEq(_fee(blockNo, justOver), MAX_RATE, "30,001 answers the ceiling");
            assertEq(_fee(blockNo, far), MAX_RATE, "50,001 answers the ceiling");
            assertEq(_fee(blockNo, maxed), MAX_RATE, "the largest 24-bit rate answers the ceiling");
        }
    }

    /// The two bounds themselves (10,000 and 30,000) come back unchanged.
    function test_boundsExact() public view {
        bytes32[4] memory p = _rates(MIN_RATE, MAX_RATE, MIN_RATE, MAX_RATE);
        assertEq(_fee(0, p), MIN_RATE, "window 0: 10,000 is unchanged");
        assertEq(_fee(uint64(6 * BLOCKS_PER_HOUR), p), MAX_RATE, "window 1: 30,000 is unchanged");
        assertEq(_fee(uint64(12 * BLOCKS_PER_HOUR), p), MIN_RATE, "window 2: 10,000 is unchanged");
        assertEq(_fee(uint64(18 * BLOCKS_PER_HOUR), p), MAX_RATE, "window 3: 30,000 is unchanged");
    }

    /// Whatever the params are (any word, any window), the fee is a rate in [10,000, 30,000].
    function testFuzz_anyParamsWithinRange(uint64 blockNo, bytes32[4] memory p) public view {
        uint256 fee = _fee(blockNo, p);
        assertGe(fee, MIN_RATE, "not below the floor");
        assertLe(fee, MAX_RATE, "not above the ceiling");
    }

    /// For any words: the answer is the window's low 24 bits, clamped to [10,000, 30,000], and nothing else.
    function testFuzz_clampMatchesFormula(uint64 blockNo, uint256[4] memory words) public view {
        bytes32[4] memory p = _rates(words[0], words[1], words[2], words[3]);
        uint256 raw = uint256(p[_window(blockNo)]) & 0xFFFFFF;
        uint256 want = raw < MIN_RATE ? MIN_RATE : raw > MAX_RATE ? MAX_RATE : raw;
        assertEq(_fee(blockNo, p), want, "the window's low 24 bits, clamped");
    }

    /// Only the low 24 bits of a word are read: bits above them (bit 24, bit 200, the whole top) change nothing.
    function test_readsLowBitsOnly() public view {
        uint256 bit24 = (1 << 24) | 20_000;
        uint256 bit200 = (1 << 200) | 20_000;
        uint256 top = (uint256(type(uint232).max) << 24) | 20_000;
        uint256[3] memory dirty = [bit24, bit200, top];
        for (uint256 i; i < dirty.length; ++i) {
            bytes32[4] memory p = _rates(dirty[i], dirty[i], dirty[i], dirty[i]);
            for (uint256 w; w < 4; ++w) {
                assertEq(_fee(uint64(6 * w * BLOCKS_PER_HOUR), p), 20_000, "only the low 24 bits count");
            }
        }
    }

    /// Only the block number matters: two contexts with the same block number, differing in every other field, answer alike.
    function testFuzz_ignoresOtherContext(FeeContext memory a, FeeContext memory b, uint256[4] memory seed) public view {
        b.blockNumber = a.blockNumber;
        bytes32[4] memory p = _distinct(seed);
        assertEq(
            uint256(IFeePolicy(module).projectFee(a, p)),
            uint256(IFeePolicy(module).projectFee(b, p)),
            "zeroForOne, exactInput, amount, price, tick and volEma are ignored"
        );
    }

    /// The largest block number answers without reverting. 2^64 - 1 is hour 14, so it is window 2.
    function test_maxBlockNumber() public view {
        uint256 hour = (uint256(type(uint64).max) / BLOCKS_PER_HOUR) % 24;
        assertEq(hour, 14, "2^64 - 1 is hour 14");
        bytes32[4] memory p = _rates(11_000, 16_000, 22_000, 28_000);
        assertEq(_fee(type(uint64).max, p), uint256(p[hour / 6]), "the largest block answers its window's rate");
        assertEq(_fee(type(uint64).max, p), 22_000, "window 2");
    }

    /// Gas one call uses, through the interface (a revert would fail the test). The context is built before the measure
    /// starts; the measure includes the call's encoding, the cold-account access and the decoding.
    function _gasOf(uint64 blockNo, bytes32[4] memory p) internal view returns (uint256 used) {
        FeeContext memory ctx = _ctx(blockNo);
        IFeePolicy policy = IFeePolicy(module);
        uint256 before = gasleft();
        policy.projectFee(ctx, p);
        used = before - gasleft();
    }

    /// The worst call over all 24 hours, with in-bounds rates and with rates outside the clamp, uses under 4,000 gas.
    function test_gasWellUnderCap() public view {
        bytes32[4] memory within = _rates(10_000, 30_000, 12_345, 27_777);
        bytes32[4] memory beyond = _rates(0, 16_777_215, 1, 50_001);
        uint256 worst;
        for (uint256 h; h < 24; ++h) {
            uint64 blockNo = uint64(h * BLOCKS_PER_HOUR + 900);
            uint256 a = _gasOf(blockNo, within);
            uint256 b = _gasOf(blockNo, beyond);
            if (a > worst) worst = a;
            if (b > worst) worst = b;
        }
        assertLt(worst, GAS_BUDGET, "the call uses well under the 40,000 cap");
    }

    /// Any block, any params: the call uses under 4,000 gas.
    function testFuzz_gasWellUnderCap(uint64 blockNo, bytes32[4] memory p) public view {
        assertLt(_gasOf(blockNo, p), GAS_BUDGET, "the call uses well under the 40,000 cap");
    }
}
