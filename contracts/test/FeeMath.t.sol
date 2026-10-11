// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {FeeMath} from "../src/libraries/FeeMath.sol";

contract FeeMathTest is Test {
    uint24 constant PLATFORM = 1_000;
    uint24 constant MAX_PROJECT = 50_000;

    function _bound(uint256 amount, uint24 project) internal pure returns (uint256, uint24) {
        return (bound(amount, 1, 1e30), uint24(bound(project, 0, MAX_PROJECT)));
    }

    /// exact-input: fee is the gross share; split is exact; platform gets at least its nominal 0.10%.
    function testFuzz_exactInput(uint256 gross, uint24 project) public pure {
        (gross, project) = _bound(gross, project);
        uint24 total = project + PLATFORM;
        uint256 fee = FeeMath.fromGross(gross, total);
        uint256 p = FeeMath.projectShare(gross, fee, project);
        assertLe(p, fee);
        assertGe(fee - p, (gross * PLATFORM) / 1e6, "platform under-paid");
        assertLe(fee - p, (gross * PLATFORM) / 1e6 + 1, "platform over-paid");
        assertLe(fee, gross);
    }

    /// exact-output: the trader receives exactly `net`; the fee is never under-charged vs the gross it implies.
    function testFuzz_exactOutput(uint256 net, uint24 project) public pure {
        (net, project) = _bound(net, project);
        uint24 total = project + PLATFORM;
        uint256 fee = FeeMath.fromNet(net, total);
        uint256 gross = net + fee;
        assertGe(fee * 1e6, gross * total, "under-charged"); // ceil(net·T/(1e6−T)) ⇔ fee·1e6 ≥ (net+fee)·T, exactly
        uint256 p = FeeMath.projectShare(gross, fee, project);
        assertLe(p, fee);
        assertGe(fee - p, (gross * PLATFORM) / 1e6, "platform under-paid");
        assertLe(fee - p, (gross * PLATFORM) / 1e6 + 2, "platform over-paid");
    }

    /// The launch tax: project 10%..90% + the 0.30% platform fee (total up to 903_000 pips, still < ONE): both paths
    /// keep the exact split, never under-charge, and do not overflow up to 1e30 wei.
    function testFuzz_launchTax(uint256 amount, uint256 step, bool exactIn) public pure {
        amount = bound(amount, 1, 1e30);
        uint24 project = uint24(bound(step, 1, 9) * 100_000);
        uint24 total = project + 3_000;
        uint256 fee = exactIn ? FeeMath.fromGross(amount, total) : FeeMath.fromNet(amount, total);
        uint256 gross = exactIn ? amount : amount + fee;
        if (!exactIn) assertGe(fee * 1e6, gross * total, "under-charged");
        else assertLe(fee, gross);
        uint256 p = FeeMath.projectShare(gross, fee, project);
        assertEq(p, gross * project / 1e6, "project = floor(gross*project)");
        assertGe(fee - p, (gross * 3_000) / 1e6, "platform under-paid");
        assertLe(fee - p, (gross * 3_000) / 1e6 + 2, "platform over-paid");
    }

    function test_launchTaxExtremes() public pure {
        // 90.3% of 1 ETH paid in; to receive exactly 1 ETH out the fee is ceil(1e18·903000/97000)
        assertEq(FeeMath.fromGross(1 ether, 903_000), 0.903 ether);
        assertEq(FeeMath.fromNet(1 ether, 903_000), 9_309_278_350_515_463_918);
        // the largest swap amount v4 allows (int128): no overflow
        assertEq(
            FeeMath.fromNet(uint128(type(int128).max), 903_000), 1_583_891_635_719_625_940_759_934_384_076_735_540_944
        );
    }

    function test_examples() public pure {
        // 1 ETH buy at 2% + 0.1%: 0.021 ETH fee, 0.02 project, 0.001 platform
        uint256 fee = FeeMath.fromGross(1 ether, 21_000);
        assertEq(fee, 0.021 ether);
        assertEq(FeeMath.projectShare(1 ether, fee, 20_000), 0.02 ether);
        // receive exactly 1 ETH (exact-out sell): gross = 1/(1-0.021)
        uint256 f2 = FeeMath.fromNet(1 ether, 21_000);
        assertEq(f2, 21_450_459_652_706_844); // ceil(1e18·21000/979000)
    }
}
