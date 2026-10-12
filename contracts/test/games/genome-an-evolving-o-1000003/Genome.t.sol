// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {GameKitConformance} from "../GameKitConformance.sol";
import {Genome} from "../../../src/games/genome-an-evolving-o-1000003/Genome.sol";

/// Genome's rules, on top of the kit's conformance suite. Time is the test's: every act waits the way a player would.
contract GenomeTest is GameKitConformance {
    Genome internal g;

    /// One genome, as `genomeOf` returns it.
    struct Gen {
        bytes32 seed;
        bytes traits;
        uint256 mutations;
        uint256 scars;
        uint256 lastAct;
    }

    function setUp() public virtual override {
        super.setUp();
        g = Genome(address(game));
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(Genome).creationCode;
    }

    /// A player with no genome claims one; a player with one mutates, once its cooldown is over.
    function _play(address player) internal override {
        if (_genome(player).seed == 0) {
            _claimAs(player);
            return;
        }
        uint256 at = g.nextMutateAt(player);
        if (block.timestamp < at) vm.warp(at);
        _mutateAs(player);
    }

    function _closeRounds() internal override {
        skip(1 days);
    }

    function _genome(address who) internal view returns (Gen memory x) {
        (x.seed, x.traits, x.mutations, x.scars, x.lastAct) = g.genomeOf(who);
    }

    function _svgOf(address who) internal view returns (bytes memory) {
        return bytes(g.svg(who));
    }

    function _claimAs(address who) internal {
        vm.prank(who);
        g.claimGenome();
    }

    function _mutateAs(address who) internal {
        vm.prank(who);
        g.mutate();
    }

    /// How many times `needle` occurs in `hay`.
    function _count(bytes memory hay, bytes memory needle) internal pure returns (uint256 n) {
        for (uint256 i; i + needle.length <= hay.length; ++i) {
            bool hit = true;
            for (uint256 j; j < needle.length; ++j) {
                if (hay[i + j] != needle[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) ++n;
        }
    }

    function test_params_inBounds() public view {
        assertEq(g.COOLDOWN(), 1 days);
        assertEq(g.SCAR_AFTER(), 2 days);
        assertEq(g.MAX_TRAITS(), 32);
        assertEq(g.MAX_SCARS(), 255);
    }

    function test_claim_givesGenome_seedSet_noTraits_zeroCounts() public {
        address a = makeAddr("a");
        _claimAs(a);
        Gen memory x = _genome(a);
        assertTrue(x.seed != bytes32(0), "a seed is set");
        assertEq(x.traits.length, 0, "no traits");
        assertEq(x.mutations, 0, "no mutations");
        assertEq(x.scars, 0, "no scars");
        assertEq(x.lastAct, block.timestamp, "the claim is the first act");
        assertEq(g.genomes(), 1);
        assertEq(g.lastActor(), a);
    }

    function test_claim_twiceReverts_AlreadyClaimed() public {
        address a = makeAddr("a");
        _claimAs(a);
        vm.prank(a);
        vm.expectRevert(Genome.AlreadyClaimed.selector);
        g.claimGenome();
    }

    function test_mutate_withoutGenome_reverts_NoGenome() public {
        vm.prank(makeAddr("a"));
        vm.expectRevert(Genome.NoGenome.selector);
        g.mutate();
    }

    function test_mutate_cooldown() public {
        address a = makeAddr("a");
        _claimAs(a);
        skip(1 days - 1);
        vm.prank(a);
        vm.expectRevert(Genome.TooSoon.selector);
        g.mutate();
        skip(1);
        _mutateAs(a);
        assertEq(_genome(a).mutations, 1);
    }

    function test_mutate_onTime_addsOneTrait() public {
        address a = makeAddr("a");
        _claimAs(a);
        skip(1 days);
        _mutateAs(a);
        Gen memory x = _genome(a);
        assertEq(x.traits.length, 1, "one trait");
        assertEq(x.mutations, 1);
        assertEq(x.scars, 0);
    }

    function test_boundary_48hIsMutation_48hPlus1IsScar() public {
        address a = makeAddr("a");
        _claimAs(a);
        skip(2 days);
        _mutateAs(a);
        assertEq(_genome(a).mutations, 1, "48h after the last act is still a mutation");
        assertEq(_genome(a).scars, 0);
        skip(2 days + 1);
        _mutateAs(a);
        assertEq(_genome(a).scars, 1, "48h and one second is a scar");
        assertEq(_genome(a).mutations, 1);
    }

    function test_scar_noTraitAdded_lastActUpdated() public {
        address a = makeAddr("a");
        _claimAs(a);
        skip(3 days);
        uint256 at = block.timestamp;
        _mutateAs(a);
        Gen memory x = _genome(a);
        assertEq(x.traits.length, 0, "a scar adds no trait");
        assertEq(x.mutations, 0);
        assertEq(x.scars, 1);
        assertEq(x.lastAct, at, "the scar is the last act");
    }

    function test_scars_stopAt255() public {
        address a = makeAddr("a");
        _claimAs(a);
        for (uint256 i; i < 255; ++i) {
            skip(3 days);
            _mutateAs(a);
        }
        assertEq(_genome(a).scars, 255);
        skip(3 days);
        _mutateAs(a);
        assertEq(_genome(a).scars, 255, "scars stop at 255");
        assertEq(_genome(a).mutations, 0);
    }

    function test_traits_capAt32_thenTimelyMutateReverts_Full() public {
        address a = makeAddr("a");
        _claimAs(a);
        for (uint256 i; i < 32; ++i) {
            skip(1 days);
            _mutateAs(a);
        }
        assertEq(_genome(a).traits.length, 32);
        assertEq(_genome(a).mutations, 32);
        skip(1 days);
        vm.prank(a);
        vm.expectRevert(Genome.TraitsFull.selector);
        g.mutate();
        assertEq(_genome(a).mutations, 32, "a full genome gains no trait");
        skip(3 days);
        _mutateAs(a);
        assertEq(_genome(a).scars, 1, "a late mutate is still a scar");
    }

    function test_traitByte_matchesKeccak() public {
        address a = makeAddr("a");
        _claimAs(a);
        bytes32 seed = _genome(a).seed;
        skip(1 days);
        uint256 at1 = block.timestamp;
        _mutateAs(a);
        skip(1 days);
        uint256 at2 = block.timestamp;
        _mutateAs(a);
        bytes memory traits = _genome(a).traits;
        assertEq(traits.length, 2);
        assertEq(uint8(traits[0]), uint8(bytes1(keccak256(abi.encode(seed, uint256(1), at1)))), "first trait");
        assertEq(uint8(traits[1]), uint8(bytes1(keccak256(abi.encode(seed, uint256(2), at2)))), "second trait");
    }

    function test_genomesIndependentPerAddress() public {
        address a = makeAddr("a");
        address b = makeAddr("b");
        _claimAs(a);
        _claimAs(b);
        assertEq(g.genomes(), 2);
        assertTrue(_genome(a).seed != _genome(b).seed, "each genome has its own seed");
        uint256 bAct = _genome(b).lastAct;
        skip(1 days);
        _mutateAs(a);
        assertEq(_genome(a).mutations, 1);
        assertEq(_genome(b).mutations, 0, "b is untouched");
        assertEq(_genome(b).traits.length, 0);
        assertEq(_genome(b).lastAct, bAct, "b's last act is its own");
    }

    function test_paused_blocksClaimAndMutate_unpauseRestores() public {
        address a = makeAddr("a");
        _claimAs(a);
        skip(1 days);
        vm.prank(safe);
        g.pause(true);
        vm.prank(makeAddr("b"));
        vm.expectRevert(abi.encodeWithSignature("NotLive()"));
        g.claimGenome();
        vm.prank(a);
        vm.expectRevert(abi.encodeWithSignature("NotLive()"));
        g.mutate();
        assertEq(_genome(a).mutations, 0, "paused: nothing changes");
        vm.prank(safe);
        g.pause(false);
        _mutateAs(a);
        assertEq(_genome(a).mutations, 1, "unpaused: the mutate goes through");
    }

    function test_onlySafePauses() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(abi.encodeWithSignature("NotSafe()"));
        g.pause(true);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSignature("NotSafe()"));
        g.pause(true);
        assertFalse(g.paused(), "only the Safe pauses");
        vm.prank(safe);
        g.pause(true);
        assertTrue(g.paused());
        vm.prank(safe);
        g.pause(false);
    }

    function test_svg_noGenomeReverts_rectPerTrait_scarCount() public {
        address a = makeAddr("a");
        vm.expectRevert(Genome.NoGenome.selector);
        g.svg(a);
        _claimAs(a);
        assertEq(_count(_svgOf(a), bytes("<rect")), 0, "no traits, no rect");
        assertEq(_count(_svgOf(a), bytes("stroke-dasharray")), 0, "no scars, no dashed line");
        for (uint256 i; i < 3; ++i) {
            skip(1 days);
            _mutateAs(a);
        }
        assertEq(_count(_svgOf(a), bytes("<rect")), 3, "one rect per trait");
        skip(3 days);
        _mutateAs(a);
        assertEq(_count(_svgOf(a), bytes("<rect")), 3, "a scar adds no rect");
        assertEq(_count(_svgOf(a), bytes("stroke-dasharray")), 1, "all the scars are one dashed line");
        assertEq(_count(_svgOf(a), bytes('data-scars="1"')), 1, "the dashed line carries the scar count");
    }

    function test_lastSvg_emptyThenLastActor() public {
        assertEq(bytes(g.lastSvg()).length, 0, "empty before any play");
        assertEq(g.lastActor(), address(0));
        address a = makeAddr("a");
        _claimAs(a);
        assertEq(g.lastActor(), a);
        assertEq(g.lastSvg(), g.svg(a));
    }

    function test_gas_claim_mutate_svgAtMax_under200k() public {
        address a = makeAddr("a");
        vm.prank(a);
        uint256 left = gasleft();
        g.claimGenome();
        assertLt(left - gasleft(), 200_000, "claim");
        for (uint256 i; i < 31; ++i) {
            skip(1 days);
            _mutateAs(a);
        }
        skip(1 days);
        vm.prank(a);
        left = gasleft();
        g.mutate();
        assertLt(left - gasleft(), 200_000, "mutate to the cap");
        assertEq(_genome(a).traits.length, 32);
        for (uint256 i; i < 255; ++i) {
            skip(3 days);
            _mutateAs(a);
        }
        assertEq(_genome(a).scars, 255);
        left = gasleft();
        g.svg(a);
        assertLt(left - gasleft(), 200_000, "svg at max traits and max scars");
    }

    function test_nothingOwed_ever() public {
        address a = makeAddr("a");
        uint256 held = address(game).balance;
        _claimAs(a);
        skip(1 days);
        _mutateAs(a);
        skip(5 days);
        _mutateAs(a);
        assertEq(g.owedTotal(), 0, "genomes pay nothing");
        assertEq(g.owed(a), 0);
        assertEq(address(game).balance, held, "the game's money does not move");
        _assertSolvent();
    }

    function test_lastActor_followsMutateAndScar() public {
        address a = makeAddr("a");
        address b = makeAddr("b");
        _claimAs(a);
        _claimAs(b);
        assertEq(g.lastActor(), b);
        skip(1 days);
        _mutateAs(a);
        assertEq(g.lastActor(), a, "a mutate sets the last actor");
        assertEq(g.lastSvg(), g.svg(a));
        skip(3 days);
        _mutateAs(b);
        assertEq(g.lastActor(), b, "a scar sets the last actor");
        assertEq(g.lastSvg(), g.svg(b));
        assertEq(g.genomes(), 2, "mutates do not count as genomes");
    }

    function test_failedActs_changeNothing() public {
        address a = makeAddr("a");
        _claimAs(a);
        address b = makeAddr("b");
        _claimAs(b);
        skip(1 days - 1);
        Gen memory before_ = _genome(a);
        vm.prank(a);
        vm.expectRevert(Genome.TooSoon.selector);
        g.mutate();
        assertEq(g.lastActor(), b, "a failed mutate leaves the last actor");
        assertEq(_genome(a).lastAct, before_.lastAct);
    }

    function test_svg_exactLayout_tenTraits_andScarCount() public {
        address a = makeAddr("a");
        _claimAs(a);
        for (uint256 i; i < 10; ++i) {
            skip(1 days);
            _mutateAs(a);
        }
        Gen memory x = _genome(a);
        bytes memory got = _svgOf(a);
        assertEq(_count(got, bytes('x="00"')), 2, "cell 0 and cell 8");
        assertEq(_count(got, bytes('x="70"')), 1);
        assertEq(_count(got, bytes('x="10"')), 2, "cell 1 and cell 9");
        assertEq(_count(got, bytes('y="00"')), 8);
        assertEq(_count(got, bytes('y="10"')), 2);
        assertEq(_count(got, bytes("</svg>")), 1);
        // scar counts of several digits
        for (uint256 i; i < 12; ++i) {
            skip(3 days);
            _mutateAs(a);
        }
        assertEq(_count(_svgOf(a), bytes('data-scars="12"')), 1);
        assertEq(_count(_svgOf(a), bytes("<rect")), 10);
        // hue digits of every cell are 3 digits below 360
        for (uint256 i; i < 10; ++i) {
            uint256 h = (uint256(uint8(x.traits[i])) * 360) / 256;
            string memory s = h < 10 ? string.concat("00", vm.toString(h)) : h < 100 ? string.concat("0", vm.toString(h)) : vm.toString(h);
            assertGe(_count(_svgOf(a), bytes(string.concat("hsl(", s, ",70%,50%)"))), 1, "hue");
        }
    }

    function test_svg_scarsAt255And100() public {
        address a = makeAddr("a");
        _claimAs(a);
        for (uint256 i; i < 100; ++i) {
            skip(3 days);
            _mutateAs(a);
        }
        assertEq(_count(_svgOf(a), bytes('data-scars="100"')), 1);
        for (uint256 i; i < 155; ++i) {
            skip(3 days);
            _mutateAs(a);
        }
        assertEq(_count(_svgOf(a), bytes('data-scars="255"')), 1);
    }

    function test_mutate_afterScar_cooldownRestarts() public {
        address a = makeAddr("a");
        _claimAs(a);
        skip(3 days);
        _mutateAs(a);
        skip(1 days - 1);
        vm.prank(a);
        vm.expectRevert(Genome.TooSoon.selector);
        g.mutate();
        skip(1);
        _mutateAs(a);
        assertEq(_genome(a).mutations, 1, "a mutate 24h after a scar is timely");
        assertEq(_genome(a).scars, 1);
    }

    function test_nextMutateAt() public {
        address a = makeAddr("a");
        assertEq(g.nextMutateAt(a), 0);
        _claimAs(a);
        assertEq(g.nextMutateAt(a), block.timestamp + 1 days);
        skip(1 days);
        _mutateAs(a);
        assertEq(g.nextMutateAt(a), block.timestamp + 1 days);
    }

    function testFuzz_longRun(uint8 steps, uint32 seedWait) public {
        address a = makeAddr("a");
        _claimAs(a);
        uint256 muts;
        uint256 sc;
        uint256 last = block.timestamp;
        uint256 w = uint256(seedWait);
        for (uint256 i; i < uint256(steps) % 60; ++i) {
            w = uint256(keccak256(abi.encode(w))) % 5 days;
            skip(w);
            uint256 el = block.timestamp - last;
            vm.prank(a);
            try g.mutate() {
                assertGe(el, 1 days);
                if (el <= 2 days) ++muts;
                else if (sc < 255) ++sc;
                last = block.timestamp;
            } catch {
                assertTrue(el < 1 days || (el <= 2 days && muts == 32));
            }
        }
        Gen memory x = _genome(a);
        assertEq(x.mutations, muts);
        assertEq(x.scars, sc);
        assertEq(x.traits.length, muts);
    }

    function testFuzz_otherCannotTouchMine(address other) public {
        address a = makeAddr("a");
        vm.assume(other != address(0) && other != a);
        _claimAs(a);
        skip(1 days);
        vm.prank(other);
        vm.expectRevert(Genome.NoGenome.selector);
        g.mutate();
        assertEq(_genome(a).mutations, 0);
    }

    function testFuzz_mutateTiming(uint32 wait) public {
        address a = makeAddr("a");
        _claimAs(a);
        uint256 w = uint256(wait);
        skip(w);
        if (w < 1 days) {
            vm.prank(a);
            vm.expectRevert(Genome.TooSoon.selector);
            g.mutate();
            assertEq(_genome(a).mutations, 0, "too soon: nothing changes");
        } else if (w <= 2 days) {
            _mutateAs(a);
            assertEq(_genome(a).mutations, 1, "within 48h: a mutation");
            assertEq(_genome(a).scars, 0);
        } else {
            _mutateAs(a);
            assertEq(_genome(a).scars, 1, "after 48h: a scar");
            assertEq(_genome(a).mutations, 0);
        }
    }
}

/// Random claims, mutates, claims and time for the invariant run (every call may fail).
contract GenomeHandler is Test {
    Genome internal g;
    address[4] internal actors = [address(0xA1), address(0xA2), address(0xA3), address(0xA4)];

    constructor(Genome g_) {
        g = g_;
    }

    function claimGenome(uint256 who) external {
        vm.prank(actors[who % 4]);
        try g.claimGenome() {} catch {}
    }

    function mutate(uint256 who) external {
        vm.prank(actors[who % 4]);
        try g.mutate() {} catch {}
    }

    function claim(uint256 who) external {
        address a = actors[who % 4];
        if (g.owed(a) == 0) return;
        vm.prank(a);
        g.claim();
    }

    function pass(uint32 s) external {
        skip(uint256(s) % (3 days + 1));
    }

    function actor(uint256 i) external view returns (address) {
        return actors[i % 4];
    }
}

/// The invariant run on the genome the conformance setUp deployed and funded through the real factory.
contract GenomeInvariantTest is GenomeTest {
    GenomeHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new GenomeHandler(g);
        targetContract(address(handler));
    }

    function invariant_solvent_nothingOwed_traitsEqualMutations_capsHold() public view {
        _assertSolvent();
        assertEq(game.owedTotal(), 0, "nothing is owed: genomes pay nothing");
        for (uint256 i; i < 4; ++i) {
            Gen memory x = _genome(handler.actor(i));
            assertEq(x.traits.length, x.mutations, "one trait per mutation");
            assertLe(x.mutations, 32, "traits cap at 32");
            assertLe(x.scars, 255, "scars cap at 255");
        }
    }
}
