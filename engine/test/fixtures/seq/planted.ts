// Planted violations for the Sequencer's gates: each entry is one small Solidity file that breaks exactly one rule,
// and the message the gate must report. Source fixtures inherit GameKit (slug "planted"); test fixtures use forge-std.
const kit = (name: string, body: string, head = "") => `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GameKit} from "../GameKit.sol";
${head}
contract ${name} is GameKit {
${body}
    function _roundOpen() internal pure override returns (bool) {
        return false;
    }
}
`;

/** G3, game sources. */
export const SRC: Record<string, { code: string; want: RegExp }> = {
  Delegate: { code: kit("Delegate", `    function f(address t) external {\n        (bool ok,) = t.delegatecall("");\n        require(ok);\n    }`), want: /delegatecall/ },
  LowCall: { code: kit("LowCall", `    function f(address t) external {\n        (bool ok,) = t.call("");\n        require(ok);\n    }`), want: /low-level \.call/ },
  Send: { code: kit("Send", `    function f(address payable t) external {\n        t.transfer(1);\n    }`), want: /low-level \.transfer/ },
  Destruct: { code: kit("Destruct", `    function f() external {\n        selfdestruct(payable(msg.sender));\n    }`), want: /selfdestruct/ },
  Creates: { code: kit("Creates", `    function f() external {\n        new Child();\n    }`, "contract Child {}\n"), want: /new/ },
  Assembly: { code: kit("Assembly", `    function f() external view returns (uint256 x) {\n        assembly {\n            x := gas()\n        }\n    }`), want: /inline assembly/ },
  Origin: { code: kit("Origin", `    function f() external view returns (address) {\n        return tx.origin;\n    }`), want: /tx\.origin/ },
  Randao: { code: kit("Randao", `    function f() external view returns (uint256) {\n        return block.prevrandao;\n    }`), want: /block\.prevrandao/ },
  Blockhash: { code: kit("Blockhash", `    function f() external view returns (bytes32) {\n        return blockhash(block.number - 1);\n    }`), want: /blockhash/ },
  External: { code: kit("External", `    function f(address t) external view returns (uint256) {\n        return IThing(t).thing();\n    }`, "interface IThing {\n    function thing() external view returns (uint256);\n}\n"), want: /external call thing/ },
  SelfCall: { code: kit("SelfCall", `    function f() external view returns (uint256) {\n        return this.g();\n    }\n\n    function g() external pure returns (uint256) {\n        return 1;\n    }`), want: /external call g/ },
  EmitsPlayed: { code: kit("EmitsPlayed", `    function f(address p) external {\n        emit Played(p, 0);\n    }`), want: /emits Played itself/ },
  Unchecked: { code: kit("Unchecked", `    function f(uint256 a) external pure returns (uint256) {\n        unchecked {\n            return a + 1;\n        }\n    }`), want: /unchecked/ },
  Payable: { code: kit("Payable", `    function f() external payable {}`), want: /f\(\) is payable/ },
  Receives: { code: kit("Receives", `    receive() external payable {}`), want: /receive/ },
  Immutable: { code: kit("Immutable", `    uint256 internal immutable born = block.timestamp;\n\n    function f() external view returns (uint256) {\n        return born;\n    }`), want: /an immutable/ },
};

const test = (name: string, body: string) => `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";

contract ${name} is Test {
    function test_x() public {
${body}
    }
}
`;
/** Allowed: a game source that makes a new array (not a contract). */
/** A cheatcode reached through an interface in the game's source (named like the cheatcode, called by a test at an
 *  address built by arithmetic, not the cheatcode address literal): CHEAT_SRC is refused, CHEAT_CALLER alone is not. */
export const CHEAT_SRC = kit("CheatSrc", `    function f() external {}`, "interface ICheatsSrc {\n    function etch(address, bytes calldata) external;\n}\n");
export const CHEAT_CALLER = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ICheatsSrc} from "../../../src/games/planted/CheatSrc.sol";

contract CheatCaller is Test {
    function test_x() public {
        ICheatsSrc(address(uint160(0x007109709ecfa91a80626ff3989d68f67f5b1dd12c) + 1)).etch(address(1), hex"00");
    }
}
`;
export const ARRAY_OK = kit("ArrayOk", `    function f(uint256 n) external pure returns (uint256[] memory a) {\n        a = new uint256[](n);\n    }`);

/** G3, game tests. */
export const TEST: Record<string, { code: string; want: RegExp }> = {
  Ffi: { code: test("Ffi", `        string[] memory c = new string[](1);\n        c[0] = "id";\n        vm.ffi(c);`), want: /vm\.ffi/ },
  Env: { code: test("Env", `        vm.envString("ANTHROPIC_API_KEY");`), want: /vm\.envString/ },
  ReadFile: { code: test("ReadFile", `        vm.readFile("/etc/passwd");`), want: /vm\.readFile/ },
  WriteFile: { code: test("WriteFile", `        vm.writeFile("x", "y");`), want: /vm\.writeFile/ },
  Rpc: { code: test("Rpc", `        vm.rpc("eth_chainId", "[]");`), want: /vm\.rpc/ },
  RpcUrl: { code: test("RpcUrl", `        vm.rpcUrl("mainnet");`), want: /vm\.rpcUrl/ },
  Fork: { code: test("Fork", `        vm.createSelectFork("mainnet");`), want: /vm\.createSelectFork/ },
  SetEnv: { code: test("SetEnv", `        vm.setEnv("A", "B");`), want: /vm\.setEnv/ },
  Serialize: { code: test("Serialize", `        vm.serializeUint("a", "b", 1);`), want: /vm\.serializeUint/ },
  Prompt: { code: test("Prompt", `        vm.prompt("?");`), want: /vm\.prompt/ },
  Gas: { code: test("Gas", `        vm.pauseGasMetering();`), want: /vm\.pauseGasMetering/ },
  Aliased: { code: test("Aliased", `        Vm v = vm;\n        v.envUint("X");`), want: /vm\.envUint/ },
  Url: { code: test("Url", `        string memory u = "https://example.com";\n        u;`), want: /URL in a test/ },
  LowLevel: { code: test("LowLevel", `        (bool ok,) = address(vm).call(abi.encodeWithSignature("ffi(string[])", new string[](0)));\n        ok;`), want: /low-level \.call in a test/ },
  Asm: { code: test("Asm", `        assembly {\n            pop(0)\n        }`), want: /inline assembly in a test/ },
  AddressOfVm: { code: test("AddressOfVm", `        address a = address(vm);\n        a;`), want: /converted \(address\(vm\)\)/ },
  HevmSeed: { code: test("HevmSeed", `        address a = address(uint160(uint256(keccak256("hevm cheat code"))));\n        a;`), want: /cheatcode address's seed/ },
  Redeclared: { code: `// SPDX-License-Identifier: MIT\npragma solidity 0.8.26;\n\nimport {Test} from "forge-std/Test.sol";\n\ninterface ICheats {\n    function ffi(string[] calldata) external returns (bytes memory);\n}\n\ncontract Redeclared is Test {\n    function test_x() public pure {}\n}\n`, want: /named like a banned cheatcode \(ffi\)/ },
  ConcatUrl: { code: test("ConcatUrl", `        string memory u = string.concat("https:", "//x.example");\n        u;`), want: /URL assembled with string.concat/ },
  PackedUrl: { code: test("PackedUrl", `        bytes memory u = abi.encodePacked("//", "x.example");\n        u;`), want: /URL assembled with abi.encodePacked/ },
  Etch: { code: test("Etch", `        vm.etch(address(1), hex"00");`), want: /cheatcode vm\.etch/ },
  DeployCode: { code: test("DeployCode", `        vm.deployCode("GameFactory.sol:GameFactory");`), want: /cheatcode vm\.deployCode/ },
  StdDeployCode: { code: test("StdDeployCode", `        deployCode("GameFactory.sol:GameFactory");`), want: /deploys code from an artifact \(deployCode\)/ },
  HevmAddress: { code: test("HevmAddress", `        address a = 0x7109709ECfa91a80626fF3989D68f67F5b1DD12D;\n        a;`), want: /the cheatcode address/ },
};

/** Allowed: a test that deploys one of the game's sources with new (forge must not rewrite it into a cheatcode call),
 *  then a planted vm.etch on line ETCH_LINE, which G3 must report at that line. */
export const NEW_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ArrayOk} from "../../../src/games/planted/ArrayOk.sol";

contract NewSource is Test {
    function test_x() public {
        ArrayOk a = new ArrayOk();
        new ArrayOk();
        vm.etch(address(a), hex"00");
    }
}
`;
export const ETCH_LINE = 11;
