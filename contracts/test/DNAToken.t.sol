// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DNAToken} from "../src/DNAToken.sol";

contract DNATokenTest is Test {
    DNAToken token;
    address bootstrap = makeAddr("bootstrap");

    function setUp() public {
        token = new DNAToken(bootstrap);
    }

    function test_fixedSupplyToRecipient() public view {
        assertEq(token.totalSupply(), 1_000_000_000 ether);
        assertEq(token.balanceOf(bootstrap), 1_000_000_000 ether);
        assertEq(token.name(), "DNA");
        assertEq(token.symbol(), "DNA");
        assertEq(token.decimals(), 18);
    }

    /// No owner and no mint path exist: the only supply change is a holder burning their own balance.
    function test_noPrivilegedSelectors() public {
        bytes4[5] memory forbidden = [
            bytes4(keccak256("owner()")),
            bytes4(keccak256("mint(address,uint256)")),
            bytes4(keccak256("pause()")),
            bytes4(keccak256("transferOwnership(address)")),
            bytes4(keccak256("blacklist(address)"))
        ];
        for (uint256 i; i < forbidden.length; i++) {
            (bool ok,) = address(token).call(abi.encodeWithSelector(forbidden[i]));
            assertFalse(ok);
        }
    }

    function testFuzz_burnOnlyDecreasesSupply(uint256 amount) public {
        amount = bound(amount, 0, 1_000_000_000 ether);
        vm.prank(bootstrap);
        token.burn(amount);
        assertEq(token.totalSupply(), 1_000_000_000 ether - amount);
    }

    function test_tokenURI() public view {
        bytes memory uri = bytes(token.tokenURI());
        assertLe(uri.length, 16_384);
        bytes memory prefix = "data:application/json,";
        for (uint256 i; i < prefix.length; i++) {
            assertEq(uri[i], prefix[i]);
        }
        // the frozen URLs: genomedna.xyz, X link from the single X_HANDLE constant
        assertTrue(vm.contains(string(uri), "\"x\":\"https://x.com/contractdna\""));
        assertTrue(vm.contains(string(uri), "\"image\":\"https://genomedna.xyz/token.png\""));
        assertTrue(vm.contains(string(uri), "\"name\":\"DNA\",\"symbol\":\"DNA\""));
    }
}
