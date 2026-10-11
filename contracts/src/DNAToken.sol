// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title DNA
/// @notice Fixed supply, minted once. No owner, no mint, no pause, no blacklist, no transfer tax.
///         All market mechanics live in the pool hook; the token itself never changes.
contract DNAToken is ERC20, ERC20Burnable {
    uint256 public constant SUPPLY = 1_000_000_000 ether;

    /// @dev The X handle in `tokenURI` (https://x.com/<X_HANDLE>): x.com/contractdna. It is in the token
    ///      initCode and so every launch address. engine/scripts/route-a.ts reads this literal for the pack config's X
    ///      link, so this line is the single place to change. Every mainnet path still fails closed unless env
    ///      X_HANDLE_CONFIRMED equals it.
    string public constant X_HANDLE = "contractdna";

    constructor(address recipient) ERC20("DNA", "DNA") {
        _mint(recipient, SUPPLY);
    }

    /// @notice Inline metadata read by launch platforms and explorers (never fetched remotely). Lives in bytecode, so it
    ///         is frozen forever and costs no launch-tx storage. Display rules: description <= 280 bytes, https-only URLs.
    function tokenURI() external pure returns (string memory) {
        return string.concat(
            "data:application/json,{\"name\":\"DNA\",\"symbol\":\"DNA\","
            "\"description\":\"A token whose Uniswap v4 hook learns its own fees in public, inside an immutable constitution. Every change is queued, tested, and visible. Watch it learn.\","
            "\"website\":\"https://genomedna.xyz\",\"external_url\":\"https://genomedna.xyz\",\"x\":\"https://x.com/",
            X_HANDLE,
            "\",\"image\":\"https://genomedna.xyz/token.png\"}"
        );
    }
}
