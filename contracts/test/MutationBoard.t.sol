// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DNAToken} from "../src/DNAToken.sol";
import {ConvictionVault} from "../src/ConvictionVault.sol";
import {MutationBoard} from "../src/MutationBoard.sol";
import {IModuleRegistry} from "../src/interfaces/IDNA.sol";
import {RolesRegistry, MockPot} from "./ConvictionVault.t.sol";

contract MutationBoardTest is Test {
    DNAToken token;
    RolesRegistry reg;
    ConvictionVault vault;
    MutationBoard board;
    address safe = makeAddr("safe");
    address agent = makeAddr("agent");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint256 constant L = 10_000 ether;
    bytes32[3] opts = [keccak256("A"), keccak256("B"), keccak256("C")];

    function setUp() public {
        vm.warp(1_760_000_000);
        token = new DNAToken(address(this));
        reg = new RolesRegistry(safe, agent, makeAddr("anchor"));
        address[] memory none;
        vault = new ConvictionVault(IModuleRegistry(address(reg)), safe, none);
        MockPot pot = new MockPot();
        pot.setVault(address(vault), address(token));
        vm.prank(safe);
        vault.initialize(address(pot));
        board = new MutationBoard(vault, IModuleRegistry(address(reg)));
        address[2] memory who = [alice, bob];
        for (uint256 i; i < 2; ++i) {
            token.transfer(who[i], 10_000_000 ether);
            vm.prank(who[i]);
            token.approve(address(vault), type(uint256).max);
        }
    }

    function _lock(address who, uint256 amount, uint8 tier) internal returns (uint256 id) {
        vm.prank(who);
        id = vault.lock(amount, tier);
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _propose() internal returns (uint256 id) {
        vm.prank(agent);
        id = board.propose(opts);
    }

    function _tally(uint256 id) internal view returns (uint256[3] memory t) {
        (,,,,, t) = board.ballots(id);
    }

    // ---------- ballots ----------

    function test_propose_rolesAndCadence() public {
        vm.prank(alice);
        vm.expectRevert(MutationBoard.Unauthorized.selector);
        board.propose(opts);
        reg.setLevel(4);
        vm.prank(agent);
        vm.expectRevert(MutationBoard.Unauthorized.selector);
        board.propose(opts);
        reg.setLevel(5);
        reg.setPaused(true);
        vm.prank(agent);
        vm.expectRevert(MutationBoard.Unauthorized.selector);
        board.propose(opts);
        reg.setPaused(false);
        uint256 id = _propose();
        (, uint256 start, uint256 end,,,) = board.ballots(id);
        assertEq(start, block.timestamp + 1 hours, "veto window");
        assertEq(end, start + 24 hours);
        vm.warp(block.timestamp + 48 hours - 1);
        vm.prank(safe);
        vm.expectRevert(MutationBoard.TooSoon.selector);
        board.propose(opts);
        vm.warp(block.timestamp + 1);
        vm.prank(safe);
        board.propose(opts);
    }

    function test_vote_weightsAtStart_reVote_owner() public {
        uint256 a1 = _lock(alice, L, 2); // x3 (7 d term running at the start)
        uint256 b1 = _lock(bob, L, 0); // x2 (12 h term over: still x2)
        vm.warp(block.timestamp + 1 days);
        uint256 young = _lock(bob, 100 * L, 0); // younger than MIN_AGE at the start: weight 0
        uint256 id = _propose();
        vm.prank(alice);
        vm.expectRevert(MutationBoard.NotVoting.selector);
        board.vote(id, 0, _ids(a1));
        vm.warp(block.timestamp + 1 hours);
        vm.prank(bob);
        vm.expectRevert(MutationBoard.NotOwner.selector);
        board.vote(id, 0, _ids(a1));
        vm.prank(alice);
        vm.expectRevert(MutationBoard.BadOption.selector);
        board.vote(id, 3, _ids(a1));
        vm.prank(alice);
        board.vote(id, 0, _ids(a1));
        vm.prank(bob);
        board.vote(id, 1, _ids(b1));
        vm.prank(bob);
        board.vote(id, 1, _ids(young));
        assertEq(_tally(id)[0], 30_000 ether);
        assertEq(_tally(id)[1], 20_000 ether, "young position weighs 0");
        // re-vote moves the stored prior weight, never double counts
        vm.prank(alice);
        board.vote(id, 2, _ids(a1));
        vm.prank(alice);
        board.vote(id, 2, _ids(a1));
        assertEq(_tally(id)[0], 0);
        assertEq(_tally(id)[2], 30_000 ether);
        vm.warp(block.timestamp + 72 hours);
        vm.prank(alice);
        vm.expectRevert(MutationBoard.NotVoting.selector);
        board.vote(id, 0, _ids(a1));
        assertEq(board.winner(id), 2);
    }

    function test_winner_tiesAndZeroToLowest() public {
        uint256 id = _propose();
        vm.expectRevert(MutationBoard.NotOver.selector);
        board.winner(id);
        vm.warp(block.timestamp + 73 hours);
        assertEq(board.winner(id), 0, "no votes: lowest index");
    }

    function test_ballotRun_checksQueueAndWinner() public {
        uint256 id = _propose();
        vm.warp(block.timestamp + 73 hours);
        reg.setProposer(7, safe);
        vm.startPrank(agent);
        vm.expectRevert(MutationBoard.NotAgentOp.selector);
        board.ballotRun(id, 0, 7); // queued by the Safe, not the agent
        vm.expectRevert(MutationBoard.NotAgentOp.selector);
        board.ballotRun(id, 0, 8); // not queued
        reg.setProposer(8, agent);
        vm.expectRevert(MutationBoard.NotWinner.selector);
        board.ballotRun(id, 1, 8);
        board.ballotRun(id, 0, 8);
        vm.expectRevert(MutationBoard.Resolved.selector);
        board.ballotSkipped(id, bytes32("x"));
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(MutationBoard.Unauthorized.selector);
        board.ballotSkipped(id, bytes32("x"));
    }

    function test_ballot_safeCancel() public {
        uint256 id = _propose();
        vm.prank(safe);
        board.cancelBallot(id);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        vm.expectRevert(MutationBoard.NotVoting.selector);
        board.vote(id, 0, new uint256[](0));
        vm.warp(block.timestamp + 72 hours);
        vm.prank(agent);
        vm.expectRevert(MutationBoard.Resolved.selector);
        board.ballotSkipped(id, bytes32("x"));
    }

    /// A veto inside the 1 h window frees the weekly slot; a veto after voting opened does not.
    function test_ballot_earlyVetoFreesSlot() public {
        uint256 id = _propose();
        vm.prank(safe);
        board.cancelBallot(id);
        uint256 id2 = _propose(); // same block: the slot is free again
        vm.warp(block.timestamp + 1 hours);
        vm.prank(safe);
        board.cancelBallot(id2); // voting already open: the week stays spent
        vm.prank(safe);
        vm.expectRevert(MutationBoard.TooSoon.selector);
        board.propose([bytes32("a"), bytes32("b"), bytes32("c")]);
    }

    // ---------- mysteries ----------

    function test_mystery_sealRevealRun() public {
        bytes32 salt = keccak256("salt");
        bytes memory payload = abi.encode("setParams", uint256(25_000));
        bytes32 c = keccak256(abi.encodePacked(salt, payload));
        vm.startPrank(agent);
        vm.expectRevert(MutationBoard.BadSeal.selector);
        board.seal(c, block.timestamp + 2 days - 1);
        vm.expectRevert(MutationBoard.BadSeal.selector);
        board.seal(c, block.timestamp + 7 days + 1);
        vm.expectRevert(MutationBoard.BadSeal.selector);
        board.seal(bytes32(0), block.timestamp + 2 days); // an empty commitment could never be revealed
        uint256 id = board.seal(c, block.timestamp + 2 days);
        vm.expectRevert(MutationBoard.MysteryPending.selector);
        board.seal(c, block.timestamp + 7 days); // a valid window: only the pending seal blocks it
        vm.stopPrank();
        vm.expectRevert(MutationBoard.BadReveal.selector);
        board.reveal(id, salt, payload); // before revealAt
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(MutationBoard.BadReveal.selector);
        board.reveal(id, bytes32(0), payload);
        board.reveal(id, salt, payload); // anyone
        assertEq(board.pendingMystery(), 0);
        reg.setProposer(3, agent);
        vm.prank(agent);
        board.mysteryRun(id, 3);
        (,, MutationBoard.MysteryStatus st,) = board.mysteries(id);
        assertEq(uint8(st), uint8(MutationBoard.MysteryStatus.Run));
    }

    function test_mystery_brokenRejectedCancelled() public {
        bytes32 c = keccak256(abi.encodePacked(bytes32("s"), "p"));
        vm.prank(agent);
        uint256 id = board.seal(c, block.timestamp + 7 days);
        vm.warp(block.timestamp + 7 days + 24 hours - 1);
        vm.expectRevert(MutationBoard.BadStatus.selector);
        board.markBroken(id);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(MutationBoard.BadReveal.selector);
        board.reveal(id, bytes32("s"), "p"); // window closed
        board.markBroken(id);

        vm.prank(safe);
        uint256 id2 = board.seal(c, block.timestamp + 7 days); // REVEAL_MAX itself is allowed
        vm.prank(alice);
        vm.expectRevert(MutationBoard.Unauthorized.selector);
        board.cancelSeal(id2);
        vm.prank(safe);
        board.cancelSeal(id2); // "cancelled by guardian"

        vm.prank(agent);
        uint256 id3 = board.seal(c, block.timestamp + 7 days);
        vm.warp(block.timestamp + 7 days);
        board.reveal(id3, bytes32("s"), "p");
        vm.prank(alice);
        vm.expectRevert(MutationBoard.Unauthorized.selector);
        board.mysteryRejected(id3, bytes32("gates"));
        vm.prank(agent);
        board.mysteryRejected(id3, bytes32("gates"));
        vm.prank(agent);
        vm.expectRevert(MutationBoard.BadStatus.selector);
        board.mysteryRun(id3, 1);
    }

    function test_payloadCap() public {
        bytes memory big = new bytes(2049);
        bytes32 c = keccak256(abi.encodePacked(bytes32(0), big));
        vm.prank(agent);
        uint256 id = board.seal(c, block.timestamp + 7 days);
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(MutationBoard.BadReveal.selector);
        board.reveal(id, bytes32(0), big);
    }
}
