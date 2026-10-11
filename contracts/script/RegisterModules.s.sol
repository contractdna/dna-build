// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {CommonBase} from "forge-std/Base.sol";
import {ModuleRegistry} from "../src/ModuleRegistry.sol";
import {ParamSplit} from "../src/modules/ParamSplit.sol";
import {DirectionalFee} from "../src/modules/DirectionalFee.sol";
import {SizeTierFee} from "../src/modules/SizeTierFee.sol";

/// @notice The module-library plates (ParamSplit, DirectionalFee, SizeTierFee): CREATE2 addresses, start params and
///         registry bounds. Every fee plate keeps the AdaptiveFee envelope: any in-bounds params give a project fee in
///         [1%, 3.5%]. The split plate's bounds are FeeVault's own.
abstract contract ModulePlates is CommonBase {
    struct Plate {
        string name;
        bytes initCode;
        ModuleRegistry.Kind kind;
        bytes32[4] params;
        bytes32[4] lo;
        bytes32[4] hi;
    }

    function plates() internal pure returns (Plate[3] memory p) {
        // [buyback, lp, treasury, games] bps; starts at BaselineSplit's 3500/3000/2500/1000
        p[0] = Plate(
            "param-split-v1",
            type(ParamSplit).creationCode,
            ModuleRegistry.Kind.Split,
            _w(3500, 3000, 2500, 1000),
            _w(2000, 2000, 1000, 0),
            _w(5000, 5000, 4000, 2000)
        );
        // [buy base pips, multiplier ×1e4, cap pips, sell base pips]; starts as AdaptiveFee plate B (2% both ways, 1.0x)
        p[1] = Plate(
            "directional-fee-v1",
            type(DirectionalFee).creationCode,
            ModuleRegistry.Kind.Fee,
            _w(20_000, 10_000, 35_000, 20_000),
            _w(10_000, 1_000, 10_000, 10_000),
            _w(35_000, 18_000, 35_000, 35_000)
        );
        // [base pips, step pips per tier, cap pips, first tier T in wei of ETH]; tiers at T, 4T, 16T.
        // Starts 2% under 1 ETH, +0.5% at 1, 4 and 16 ETH (3.5% cap).
        p[2] = Plate(
            "size-tier-fee-v1",
            type(SizeTierFee).creationCode,
            ModuleRegistry.Kind.Fee,
            _w(20_000, 5_000, 35_000, 1 ether),
            _w(10_000, 0, 10_000, 0.1 ether),
            _w(35_000, 5_000, 35_000, 10 ether)
        );
    }

    function plateSalt(Plate memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode("dna.plate", p.name));
    }

    function plateAddress(Plate memory p) internal pure returns (address) {
        return vm.computeCreate2Address(plateSalt(p), keccak256(p.initCode), CREATE2_FACTORY);
    }

    /// @notice specHash = keccak256 of the engine's manifest file bytes (engine/modules/<name>.json; the indexer keys
    ///         manifests by the same hash). The registry stores it once, at Register.
    function plateSpecHash(Plate memory p) internal view returns (bytes32) {
        return keccak256(bytes(vm.readFile(string.concat("../engine/modules/", p.name, ".json"))));
    }

    /// @notice Calls, in order: three CREATE2 deploys via 0x4e59 (anyone may send them; the Safe can batch them), then
    ///         three `registry.queue(Register, …)` (Safe only), each executable by anyone 1 h later.
    function registerBatch(address registry) internal view returns (address[] memory to, bytes[] memory data) {
        Plate[3] memory ps = plates();
        to = new address[](6);
        data = new bytes[](6);
        for (uint256 i; i < 3; ++i) {
            Plate memory p = ps[i];
            (to[i], data[i]) = (CREATE2_FACTORY, abi.encodePacked(plateSalt(p), p.initCode));
            to[3 + i] = registry;
            data[3 + i] = abi.encodeCall(
                ModuleRegistry.queue,
                (
                    ModuleRegistry.Op.Register,
                    abi.encode(plateAddress(p), p.kind, plateSpecHash(p), p.params, p.lo, p.hi)
                )
            );
        }
    }

    function _w(uint256 a, uint256 b, uint256 c, uint256 d) private pure returns (bytes32[4] memory) {
        return [bytes32(a), bytes32(b), bytes32(c), bytes32(d)];
    }
}

/// @notice Prints the Safe transactions that deploy and register the module-library plates. Prints only: it never
///         broadcasts and never signs. `REGISTRY=0x… forge script script/RegisterModules.s.sol`
contract RegisterModules is Script, ModulePlates {
    function run() external view {
        address registry = vm.envAddress("REGISTRY");
        (address[] memory to, bytes[] memory data) = registerBatch(registry);
        Plate[3] memory ps = plates();
        for (uint256 i; i < 3; ++i) {
            console.log("plate", ps[i].name, plateAddress(ps[i]));
            console.log("  specHash (keccak256 of engine/modules/<name>.json)");
            console.logBytes32(plateSpecHash(ps[i]));
        }
        for (uint256 i; i < to.length; ++i) {
            console.log(i < 3 ? "deploy (value 0) to" : "Safe queue Register (value 0) to", to[i]);
            console.logBytes(data[i]);
        }
        console.log("then, 1 h after each queue: registry.execute(id), callable by anyone");
    }
}
