// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {FeeContext, IFeePolicy, ISplitPolicy} from "../../src/interfaces/IPolicies.sol";

/// The limits a module answers inside, as the hook and FeeVault apply them. They live in those contracts, so no module
/// can change them; test/ModuleLimits.t.sol pins these copies to the contracts' own constants.
library ModuleLimits {
    /// DNAHook.MODULE_GAS_CAP and FeeVault.SPLIT_GAS_CAP
    uint256 internal constant GAS_CAP = 40_000;
    /// DNAHook.MAX_PROJECT_FEE (pips)
    uint256 internal constant MAX_FEE = 50_000;

    /// FeeVault.isValid: each share within its bounds and the four summing to exactly 10,000
    function splitValid(uint256 b, uint256 l, uint256 t, uint256 g) internal pure returns (bool) {
        return b >= 2000 && b <= 5000 && l >= 2000 && l <= 5000 && t >= 1000 && t <= 4000 && g <= 2000
            && b + l + t + g == 10_000;
    }
}

/// What every Sequencer module keeps, whatever it computes. Its test gives the module's creation code (`_creationCode`:
/// `type(M).creationCode`; the suite deploys it, as the CREATE2 deployer will, with nothing to fill in) and the bounds the
/// registry is asked to hold its params in (`_bounds`: the lowest and highest value of each param word, compared as
/// uint256). The bounds are reported once (ModuleBounds), and the build's gates compare them with SPEC.json: the bounds
/// proposed to the Safe are the bounds these tests ran with.
abstract contract ModuleConformance is Test {
    event ModuleBounds(bytes32[4] min, bytes32[4] max);
    event ModuleCode(bytes32 codehash);

    /// the module under test
    address internal module;

    function _creationCode() internal pure virtual returns (bytes memory);
    function _bounds() internal pure virtual returns (bytes32[4] memory min, bytes32[4] memory max);

    function setUp() public virtual {
        bytes memory code = _creationCode();
        address m;
        assembly ("memory-safe") {
            m := create(0, add(code, 0x20), mload(code))
        }
        require(m != address(0), "the module did not deploy");
        module = m;
    }

    function _module() internal view returns (address) {
        return module;
    }

    /// Params inside the bounds, from any seed.
    function _inBounds(uint256[4] memory seed) internal pure returns (bytes32[4] memory p) {
        (bytes32[4] memory lo, bytes32[4] memory hi) = _bounds();
        for (uint256 i; i < 4; ++i) {
            p[i] = bytes32(_bound(seed[i], uint256(lo[i]), uint256(hi[i])));
        }
    }

    function test_conformance_bounds() public {
        (bytes32[4] memory lo, bytes32[4] memory hi) = _bounds();
        for (uint256 i; i < 4; ++i) {
            assertLe(uint256(lo[i]), uint256(hi[i]), "each param's lowest value is at most its highest");
        }
        emit ModuleBounds(lo, hi);
    }

    /// the code the suite ran on: the gates require it to be the module's own compile (not a stand-in)
    function test_conformance_code() public {
        assertGt(_module().code.length, 0, "the module is deployed");
        emit ModuleCode(_module().codehash);
    }
}

/// A fee module: asked as the hook asks it (STATICCALL, 40,000 gas, exactly one word back), it always answers, inside the
/// gas cap, for any context and any params; for params inside its bounds the answer is at most the hook's fee cap.
abstract contract FeeModuleConformance is ModuleConformance {
    /// One call as the hook makes it.
    function _ask(FeeContext memory ctx, bytes32[4] memory p) internal view returns (bool ok, uint256 pips) {
        (bool s, bytes memory ret) = _module().staticcall{gas: ModuleLimits.GAS_CAP}(abi.encodeCall(IFeePolicy.projectFee, (ctx, p)));
        ok = s && ret.length == 32;
        if (ok) pips = abi.decode(ret, (uint256));
    }

    function testFuzz_conformance_inBounds(FeeContext memory ctx, uint256[4] memory seed) public view {
        (bool ok, uint256 pips) = _ask(ctx, _inBounds(seed));
        assertTrue(ok, "answers one word within the gas cap");
        assertLe(pips, ModuleLimits.MAX_FEE, "at most the hook's fee cap inside the bounds");
    }

    function testFuzz_conformance_anyInput(FeeContext memory ctx, bytes32[4] memory p) public view {
        (bool ok,) = _ask(ctx, p);
        assertTrue(ok, "answers one word within the gas cap, whatever it is asked");
    }

    function test_conformance_extremes() public view {
        (bytes32[4] memory lo, bytes32[4] memory hi) = _bounds();
        uint160[3] memory prices = [uint160(4295128739), uint160(79228162514264337593543950336), type(uint160).max];
        uint256[4] memory amounts = [uint256(0), 1, 1e30, type(uint256).max];
        for (uint256 i; i < prices.length; ++i) {
            for (uint256 j; j < amounts.length; ++j) {
                for (uint256 k; k < 4; ++k) {
                    FeeContext memory ctx = FeeContext({
                        zeroForOne: k % 2 == 0, exactInput: k < 2, amount: amounts[j], sqrtPriceX96: prices[i],
                        tick: k == 3 ? type(int24).min : type(int24).max, volEma: type(uint32).max, blockNumber: type(uint64).max
                    });
                    (bool ok1,) = _ask(ctx, lo);
                    (bool ok2,) = _ask(ctx, hi);
                    assertTrue(ok1 && ok2, "answers within the gas cap at the extremes");
                }
            }
        }
    }
}

/// A split module: asked as FeeVault asks it (STATICCALL, 40,000 gas, exactly four words back), it always answers inside
/// the gas cap; for params inside its bounds the split is one FeeVault accepts.
abstract contract SplitModuleConformance is ModuleConformance {
    function _ask(bytes32[4] memory p) internal view returns (bool ok, uint256[4] memory s) {
        (bool r, bytes memory ret) = _module().staticcall{gas: ModuleLimits.GAS_CAP}(abi.encodeCall(ISplitPolicy.split, (p)));
        ok = r && ret.length == 128;
        if (ok) s = abi.decode(ret, (uint256[4]));
    }

    function testFuzz_conformance_inBounds(uint256[4] memory seed) public view {
        (bool ok, uint256[4] memory s) = _ask(_inBounds(seed));
        assertTrue(ok, "answers four words within the gas cap");
        assertTrue(ModuleLimits.splitValid(s[0], s[1], s[2], s[3]), "a split FeeVault accepts inside the bounds");
    }

    function testFuzz_conformance_anyInput(bytes32[4] memory p) public view {
        (bool ok,) = _ask(p);
        assertTrue(ok, "answers four words within the gas cap, whatever it is asked");
    }
}
