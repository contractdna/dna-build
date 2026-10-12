// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GameKit} from "../GameKit.sol";

/// Genome (no payouts): any address claims one genome, once. A mutate waits COOLDOWN after the genome's last act. Within
/// SCAR_AFTER of that act it adds a trait (a timely mutate on a full genome reverts); later it adds a scar, up to
/// MAX_SCARS. Nothing is credited and nothing is owed: `_roundOpen` is always false.
contract Genome is GameKit {
    /// Time between two acts on one genome.
    uint256 public constant COOLDOWN = 1 days;
    /// A mutate up to this long after the last act is timely (adds a trait); after it, a scar.
    uint256 public constant SCAR_AFTER = 2 days;
    /// Traits one genome holds at most (the svg grid has 8 x 4 cells).
    uint256 public constant MAX_TRAITS = 32;
    /// Scars one genome holds at most.
    uint256 public constant MAX_SCARS = 255;

    /// One genome. `claimed` tells a claimed genome from an empty slot.
    struct Record {
        bytes32 seed;
        bytes traits;
        uint8 mutations;
        uint8 scars;
        uint64 lastAct;
        bool claimed;
    }

    mapping(address player => Record) private _genome;
    /// Genomes claimed so far.
    uint256 public genomes;
    /// The last address that claimed or mutated (address(0) before any play).
    address public lastActor;

    error AlreadyClaimed();
    error NoGenome();
    error TooSoon();
    error TraitsFull();

    /// Claim this address's genome, once. Its seed is fixed now; the claim also counts as the genome's first act.
    function claimGenome() external whenLive {
        Record storage g = _genome[msg.sender];
        if (g.claimed) revert AlreadyClaimed();
        g.claimed = true;
        g.seed = keccak256(abi.encode(msg.sender, block.timestamp, block.number));
        g.lastAct = uint64(block.timestamp);
        ++genomes;
        lastActor = msg.sender;
        _played(0);
    }

    /// Mutate once per COOLDOWN. Within SCAR_AFTER of the last act it adds a trait (reverts once full); later it adds a
    /// scar (stops at MAX_SCARS). Either way the genome's last act becomes now.
    function mutate() external whenLive {
        Record storage g = _genome[msg.sender];
        if (!g.claimed) revert NoGenome();
        uint256 last = g.lastAct;
        if (block.timestamp < last + COOLDOWN) revert TooSoon();
        if (block.timestamp <= last + SCAR_AFTER) {
            if (g.mutations == MAX_TRAITS) revert TraitsFull();
            ++g.mutations;
            g.traits.push(bytes1(keccak256(abi.encode(g.seed, g.mutations, block.timestamp))));
        } else if (g.scars < MAX_SCARS) {
            ++g.scars;
        }
        g.lastAct = uint64(block.timestamp);
        lastActor = msg.sender;
        _played(0);
    }

    /// A player's genome: its seed, its trait bytes, its mutation and scar counts, and when it last acted.
    function genomeOf(address who)
        external
        view
        returns (bytes32 seed, bytes memory traits, uint256 mutations, uint256 scars, uint256 lastAct)
    {
        Record storage g = _genome[who];
        return (g.seed, g.traits, g.mutations, g.scars, g.lastAct);
    }

    /// When this address's next mutate counts as on time (0 when it has no genome).
    function nextMutateAt(address who) external view returns (uint256) {
        Record storage g = _genome[who];
        if (!g.claimed) return 0;
        return uint256(g.lastAct) + COOLDOWN;
    }

    /// The genome as SVG: one 10-unit cell per trait on an 8 x 4 grid, its hue set by the trait byte, and one dashed line
    /// for the scars (their count in data-scars). Reverts for an address with no genome.
    function svg(address who) public view returns (string memory) {
        Record storage g = _genome[who];
        if (!g.claimed) revert NoGenome();
        bytes memory tr = g.traits;
        bytes memory cells = "";
        for (uint256 i = 0; i < tr.length; ++i) {
            cells = bytes.concat(cells, _cell(i, uint8(tr[i])));
        }
        string memory scarLine = "";
        if (g.scars > 0) {
            scarLine = string.concat(
                '<line x1="0" y1="39" x2="80" y2="39" stroke="black" stroke-dasharray="4 2" data-scars="',
                _dec(g.scars),
                '"/>'
            );
        }
        return string(bytes.concat('<svg viewBox="0 0 80 40" width="320" height="160">', cells, bytes(scarLine), "</svg>"));
    }

    /// The SVG of the last address that played; empty before any play.
    function lastSvg() external view returns (string memory) {
        if (lastActor == address(0)) return "";
        return svg(lastActor);
    }

    /// Nothing is ever owed, so no round is open.
    function _roundOpen() internal pure override returns (bool) {
        return false;
    }

    /// One trait as an SVG rect: cell i of the 8 x 4 grid, its hue from the trait byte b.
    function _cell(uint256 i, uint8 b) private pure returns (bytes memory) {
        uint256 h = (uint256(b) * 360) / 256;
        return bytes.concat(
            '<rect x="',
            bytes1(uint8(48 + (i % 8))),
            "0",
            '" y="',
            bytes1(uint8(48 + (i / 8))),
            "0",
            '" width="10" height="10" fill="hsl(',
            bytes1(uint8(48 + h / 100)),
            bytes1(uint8(48 + (h / 10) % 10)),
            bytes1(uint8(48 + h % 10)),
            ',70%,50%)"/>'
        );
    }

    /// Decimal digits of v.
    function _dec(uint256 v) private pure returns (string memory) {
        if (v >= 100) {
            return string(
                bytes.concat(
                    bytes1(uint8(48 + (v / 100) % 10)), bytes1(uint8(48 + (v / 10) % 10)), bytes1(uint8(48 + v % 10))
                )
            );
        }
        if (v >= 10) {
            return string(bytes.concat(bytes1(uint8(48 + (v / 10) % 10)), bytes1(uint8(48 + v % 10))));
        }
        return string(bytes.concat(bytes1(uint8(48 + v % 10))));
    }
}
