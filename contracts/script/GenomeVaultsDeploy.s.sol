// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GenomeVaults} from "../src/GenomeVaults.sol";

/// The Safe's deploy batch for GenomeVaults: one call to the deterministic CREATE2 deployer (salt ++ init code). No
/// fund in the batch: `fund` reverts until a vault is live (engine/scripts/vault-fund.ts writes those batches). Pure
/// planning: the predicted address, the code hash the site pins, and the Safe Transaction Builder JSON. Nothing here
/// broadcasts.
contract GenomeVaultsPlanner {
    address public constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    struct Tx {
        address to;
        uint256 value;
        bytes data;
        string label;
    }

    struct Plan {
        address vaults;
        bytes32 initCodeHash;
        Tx[] txs;
    }

    function initCode(address safe, address dna, string memory artBase) public pure returns (bytes memory) {
        return abi.encodePacked(type(GenomeVaults).creationCode, abi.encode(safe, dna, artBase));
    }

    function predict(bytes32 salt, bytes memory init) public pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, keccak256(init))))));
    }

    /// The runtime code hash the deployed contract will have (immutables included): a throwaway deploy in this VM.
    function codehash(address safe, address dna, string memory artBase) public returns (bytes32) {
        return address(new GenomeVaults(safe, IERC20(dna), artBase)).codehash;
    }

    function plan(address safe, address dna, string memory artBase, bytes32 salt) public pure returns (Plan memory p) {
        require(safe != address(0) && dna != address(0), "vaults: zero address");
        bytes memory init = initCode(safe, dna, artBase);
        p.vaults = predict(salt, init);
        p.initCodeHash = keccak256(init);
        p.txs = new Tx[](1);
        p.txs[0] = Tx(CREATE2_DEPLOYER, 0, bytes.concat(salt, init), "deploy GenomeVaults (CREATE2)");
    }

    /// Safe Transaction Builder batch file (tx-builder 1.18.x) with the checksum the app verifies on import
    /// (apps/tx-builder/src/lib/checksum.ts: keccak of a key-sorted serialization with meta.name = null).
    function batchJson(Plan memory p, address safe, uint256 createdAtMs) public pure returns (string memory) {
        string memory name = "DNA Genome Vaults: deploy";
        string memory desc = "CREATE2 deploy of GenomeVaults (safe, DNA, art base) through the deterministic deployer";
        string memory txJson;
        string memory txSer;
        for (uint256 i; i < p.txs.length; ++i) {
            string memory to = q(_hex(abi.encodePacked(p.txs[i].to)));
            string memory value = q(_dec(p.txs[i].value));
            string memory data = q(_hex(p.txs[i].data));
            string memory sep = i == 0 ? "" : ",";
            txJson = string.concat(txJson, sep, '{"to":', to, ',"value":', value, ',"data":', data, "}");
            txSer = string.concat(txSer, sep, '{["data","to","value"]', data, ",", to, ",", value, ",}");
        }
        string memory safeStr = q(_hex(abi.encodePacked(safe)));
        string memory created = _dec(createdAtMs);
        string memory ser = string.concat(
            '{["chainId","createdAt","meta","transactions","version"]"1",', created,
            ',{["createdFromSafeAddress","description","name","txBuilderVersion"]', safeStr, ",", q(desc), ',null,"1.18.3",},[', txSer, '],"1.0",}'
        );
        return string.concat(
            '{"version":"1.0","chainId":"1","createdAt":', created, ',"meta":{"name":', q(name), ',"description":', q(desc),
            ',"txBuilderVersion":"1.18.3","createdFromSafeAddress":', safeStr, ',"checksum":', q(_hex(abi.encodePacked(keccak256(bytes(ser))))),
            '},"transactions":[', txJson, "]}"
        );
    }

    function q(string memory s) internal pure returns (string memory) {
        return string.concat('"', s, '"');
    }

    function _dec(uint256 x) internal pure returns (string memory) {
        if (x == 0) return "0";
        bytes memory b;
        while (x != 0) {
            b = bytes.concat(bytes1(uint8(48 + x % 10)), b);
            x /= 10;
        }
        return string(b);
    }

    function _hex(bytes memory b) internal pure returns (string memory) {
        bytes16 digits = "0123456789abcdef";
        bytes memory out = new bytes(2 + b.length * 2);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i; i < b.length; ++i) {
            out[2 + i * 2] = digits[uint8(b[i]) >> 4];
            out[3 + i * 2] = digits[uint8(b[i]) & 0xf];
        }
        return string(out);
    }
}

/// Prints the plan; never broadcasts. Env: SAFE, DNA (required); ART_BASE ("", e.g. ipfs://<cid>/), SALT (bytes32, 0).
/// `forge script script/GenomeVaultsDeploy.s.sol` → import the JSON line in the Safe Transaction Builder. The predicted
/// address and code hash go into web/app/vaults/vaults.ts.
contract GenomeVaultsDeploy is Script, GenomeVaultsPlanner {
    function run() external {
        address safe = vm.envAddress("SAFE");
        address dna = vm.envAddress("DNA");
        string memory artBase = vm.envOr("ART_BASE", string(""));
        bytes32 salt = vm.envOr("SALT", bytes32(0));
        Plan memory p = plan(safe, dna, artBase, salt);
        // without --fork-url DNA has no code here; the constructor's check needs some, and the runtime code hash does
        // not depend on it
        if (dna.code.length == 0) {
            console.log("note: no fork, DNA has no code locally; the code hash below is computed with a stand-in");
            vm.etch(dna, hex"00");
        }
        console.log("GenomeVaults (predicted)", p.vaults);
        console.log("init code hash", vm.toString(p.initCodeHash));
        console.log("runtime codehash", vm.toString(codehash(safe, dna, artBase)));
        if (p.vaults.code.length != 0) console.log("note: already deployed at that address (same salt and init code)");
        for (uint256 i; i < p.txs.length; ++i) {
            console.log(string.concat(vm.toString(i + 1), ". ", p.txs[i].label));
        }
        console.log("--- Safe Transaction Builder JSON (one line) ---");
        console.log(batchJson(p, safe, vm.unixTime()));
    }
}
