// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {GameKitConformance} from "../GameKitConformance.sol";
import {WordHunt} from "../../../src/games/word-hunt-free-guess-1000006/WordHunt.sol";

contract WordHuntTest is GameKitConformance {
    string internal constant WORD = "apple";
    uint64 internal constant ROUND_BLOCKS = 100;

    function _creationCode() internal pure override returns (bytes memory) {
        return type(WordHunt).creationCode;
    }

    function _wh() internal view returns (WordHunt) {
        return WordHunt(address(game));
    }

    /// Opens a round for WORD when none is running: the Safe opens it.
    function _openIfNeeded() internal {
        WordHunt g = _wh();
        if (g.round() != 0 && g.winner() == address(0) && block.number < g.endBlock()) return;
        vm.prank(safe);
        g.openRound(keccak256(bytes(WORD)), ROUND_BLOCKS);
    }

    /// One player plays once: commits a wrong guess if it has no open commit, else reveals the wrong guess a block on.
    function _play(address player) internal override {
        _openIfNeeded();
        WordHunt g = _wh();
        (bytes32 h, uint64 blk) = g.commits(g.round(), player);
        if (h == bytes32(0)) {
            bytes32 c = g.hashGuess("wrong", player);
            vm.prank(player);
            g.commitGuess(c);
        } else {
            if (blk == block.number) vm.roll(block.number + 1);
            vm.prank(player);
            g.revealGuess("wrong");
        }
    }

    /// Rolls to the round's end and closes it if nobody won.
    function _closeRounds() internal override {
        WordHunt g = _wh();
        if (g.round() == 0 || g.winner() != address(0) || g.closed()) return;
        if (block.number < g.endBlock()) vm.roll(g.endBlock());
        g.closeRound();
    }

    function _commitAs(address p, string memory guess) internal {
        bytes32 c = keccak256(abi.encode(guess, p));
        vm.prank(p);
        _wh().commitGuess(c);
    }

    function _revealAs(address p, string memory guess) internal {
        vm.prank(p);
        _wh().revealGuess(guess);
    }

    function _openAsSafe(string memory word_, uint64 blocks) internal {
        vm.prank(safe);
        _wh().openRound(keccak256(bytes(word_)), blocks);
    }

    function test_params_inBounds() public view {
        WordHunt g = _wh();
        assertEq(g.MIN_BLOCKS(), 10);
        assertEq(g.MAX_BLOCKS(), 50_400);
        assertEq(g.MAX_LEN(), 32);
    }

    function test_onlySafeOrKeeperOpens() public {
        WordHunt g = _wh();
        address stranger = makeAddr("wordhunt.stranger");
        address k = makeAddr("wordhunt.keeper");
        vm.prank(stranger);
        vm.expectRevert(WordHunt.NotSetter.selector);
        g.openRound(keccak256(bytes(WORD)), ROUND_BLOCKS);
        vm.prank(safe);
        g.setKeeper(k);
        vm.prank(k);
        g.openRound(keccak256(bytes(WORD)), ROUND_BLOCKS);
        assertEq(g.round(), 1);
    }

    function test_setKeeper_safeOnly_zeroClears() public {
        WordHunt g = _wh();
        address k = makeAddr("wordhunt.keeper");
        vm.prank(k);
        vm.expectRevert(bytes4(keccak256("NotSafe()")));
        g.setKeeper(k);
        vm.prank(safe);
        g.setKeeper(k);
        assertEq(g.keeper(), k);
        vm.prank(safe);
        g.setKeeper(address(0));
        assertEq(g.keeper(), address(0));
        vm.prank(k);
        vm.expectRevert(WordHunt.NotSetter.selector);
        g.openRound(keccak256(bytes(WORD)), ROUND_BLOCKS);
    }

    function test_openRound_rejectsBadLength_zeroHash_andWhileRunning() public {
        WordHunt g = _wh();
        bytes32 h = keccak256(bytes(WORD));
        vm.startPrank(safe);
        vm.expectRevert(WordHunt.BadLength.selector);
        g.openRound(h, 9);
        vm.expectRevert(WordHunt.BadLength.selector);
        g.openRound(h, 50_401);
        vm.expectRevert(WordHunt.ZeroHash.selector);
        g.openRound(bytes32(0), ROUND_BLOCKS);
        g.openRound(h, ROUND_BLOCKS);
        vm.expectRevert(WordHunt.RoundRunning.selector);
        g.openRound(h, ROUND_BLOCKS);
        vm.stopPrank();
    }

    function test_duplicateCommitReverts() public {
        _openAsSafe(WORD, ROUND_BLOCKS);
        address a = makeAddr("wordhunt.a");
        _commitAs(a, WORD);
        vm.expectRevert(WordHunt.AlreadyCommitted.selector);
        _commitAs(a, "other");
    }

    function test_revealSameBlockReverts_andNoCommitReverts() public {
        _openAsSafe(WORD, ROUND_BLOCKS);
        address a = makeAddr("wordhunt.a");
        vm.expectRevert(WordHunt.NoCommit.selector);
        _revealAs(a, WORD);
        _commitAs(a, WORD);
        vm.expectRevert(WordHunt.SameBlock.selector);
        _revealAs(a, WORD);
    }

    function test_copiedRevealFromAnotherAddressFails() public {
        _openAsSafe(WORD, ROUND_BLOCKS);
        address a = makeAddr("wordhunt.a");
        address b = makeAddr("wordhunt.b");
        bytes32 hA = keccak256(abi.encode(WORD, a));
        _commitAs(a, WORD);
        vm.prank(b);
        _wh().commitGuess(hA);
        vm.roll(block.number + 1);
        vm.expectRevert(WordHunt.BadReveal.selector);
        _revealAs(b, WORD);
        _revealAs(a, WORD);
        assertEq(_wh().winner(), a);
        assertEq(_wh().wins(a), 1);
    }

    function test_correctRevealWins() public {
        _openAsSafe(WORD, ROUND_BLOCKS);
        address a = makeAddr("wordhunt.a");
        _commitAs(a, WORD);
        vm.roll(block.number + 1);
        vm.expectEmit(true, true, false, true);
        emit WordHunt.Win(1, a);
        _revealAs(a, WORD);
        assertEq(_wh().winner(), a);
        assertEq(_wh().wins(a), 1);
        address b = makeAddr("wordhunt.b");
        vm.expectRevert(WordHunt.RoundOver.selector);
        _commitAs(b, "pear");
        vm.expectRevert(WordHunt.RoundOver.selector);
        _revealAs(a, "pear");
    }

    function test_firstCorrectRevealIsOnlyWinner() public {
        _openAsSafe(WORD, ROUND_BLOCKS);
        address a = makeAddr("wordhunt.a");
        address b = makeAddr("wordhunt.b");
        _commitAs(a, WORD);
        _commitAs(b, WORD);
        vm.roll(block.number + 1);
        _revealAs(a, WORD);
        vm.expectRevert(WordHunt.RoundOver.selector);
        _revealAs(b, WORD);
        assertEq(_wh().winner(), a);
        assertEq(_wh().wins(b), 0);
    }

    function test_wrongRevealEmitsMiss_andAllowsNewCommit() public {
        _openAsSafe(WORD, ROUND_BLOCKS);
        address a = makeAddr("wordhunt.a");
        _commitAs(a, "pear");
        vm.roll(block.number + 1);
        vm.expectEmit(true, true, false, false);
        emit WordHunt.Miss(1, a);
        _revealAs(a, "pear");
        assertEq(_wh().winner(), address(0));
        _commitAs(a, WORD);
        vm.roll(block.number + 1);
        _revealAs(a, WORD);
        assertEq(_wh().winner(), a);
    }

    function test_guessLengthBounds() public {
        _openAsSafe(WORD, ROUND_BLOCKS);
        address a = makeAddr("wordhunt.a");
        vm.expectRevert(WordHunt.BadGuess.selector);
        _revealAs(a, "");
        bytes memory tooLong = new bytes(33);
        vm.expectRevert(WordHunt.BadGuess.selector);
        _revealAs(a, string(tooLong));
        bytes memory maxLen = new bytes(32);
        vm.expectRevert(WordHunt.NoCommit.selector);
        _revealAs(a, string(maxLen));
    }

    function test_closeRound() public {
        _openAsSafe(WORD, ROUND_BLOCKS);
        WordHunt g = _wh();
        vm.expectRevert(WordHunt.NotEnded.selector);
        g.closeRound();
        vm.roll(g.endBlock());
        vm.expectEmit(true, false, false, false);
        emit WordHunt.RoundClosed(1);
        g.closeRound();
        assertEq(g.winner(), address(0));
        assertTrue(g.closed());
        vm.expectRevert(WordHunt.NothingToClose.selector);
        g.closeRound();
        address a = makeAddr("wordhunt.a");
        vm.expectRevert(WordHunt.RoundOver.selector);
        _commitAs(a, WORD);
    }

    function test_pausedRoundRejectsCommitAndReveal() public {
        _openAsSafe(WORD, ROUND_BLOCKS);
        address a = makeAddr("wordhunt.a");
        _commitAs(a, WORD);
        vm.roll(block.number + 1);
        vm.prank(safe);
        _wh().pause(true);
        address b = makeAddr("wordhunt.b");
        vm.expectRevert(bytes4(keccak256("NotLive()")));
        _commitAs(b, WORD);
        vm.expectRevert(bytes4(keccak256("NotLive()")));
        _revealAs(a, WORD);
        vm.prank(safe);
        _wh().pause(false);
        _revealAs(a, WORD);
        assertEq(_wh().winner(), a);
    }

    function test_neverCredits() public {
        _openAsSafe(WORD, ROUND_BLOCKS);
        address a = makeAddr("wordhunt.a");
        _commitAs(a, WORD);
        vm.roll(block.number + 1);
        _revealAs(a, WORD);
        assertEq(_wh().owedTotal(), 0);
        assertEq(_wh().owed(a), 0);
    }

    function testFuzz_commitRevealOrdering(uint8 gap, string memory guess) public {
        vm.assume(bytes(guess).length >= 1 && bytes(guess).length <= 32);
        _openAsSafe(WORD, ROUND_BLOCKS);
        WordHunt g = _wh();
        address a = makeAddr("wordhunt.fuzz");
        _commitAs(a, guess);
        if (gap == 0) {
            vm.expectRevert(WordHunt.SameBlock.selector);
            _revealAs(a, guess);
            return;
        }
        vm.roll(block.number + uint256(gap));
        if (block.number >= g.endBlock()) {
            vm.expectRevert(WordHunt.RoundOver.selector);
            _revealAs(a, guess);
            return;
        }
        _revealAs(a, guess);
        bool hit = keccak256(bytes(guess)) == keccak256(bytes(WORD));
        assertEq(g.winner() == a, hit);
        assertEq(g.wins(a), hit ? 1 : 0);
    }

    function test_openRound_acceptsBoundaryLengths() public {
        WordHunt g = _wh();
        bytes32 h = keccak256(bytes(WORD));
        vm.prank(safe);
        g.openRound(h, 10);
        assertEq(g.endBlock(), block.number + 10);
        vm.roll(g.endBlock());
        vm.prank(safe);
        g.openRound(h, 50_400);
        assertEq(g.endBlock(), block.number + 50_400);
        assertEq(g.round(), 2);
    }

    function test_closeRound_neverOnWonOrUnopenedRound() public {
        WordHunt g = _wh();
        vm.expectRevert(WordHunt.NothingToClose.selector);
        g.closeRound();
        _openAsSafe(WORD, ROUND_BLOCKS);
        address a = makeAddr("wordhunt.a");
        _commitAs(a, WORD);
        vm.roll(block.number + 1);
        _revealAs(a, WORD);
        vm.roll(g.endBlock() + 1);
        vm.expectRevert(WordHunt.NothingToClose.selector);
        g.closeRound();
        assertFalse(g.closed());
    }

    function test_endBlockBoundary_commitAndReveal() public {
        WordHunt g = _wh();
        _openAsSafe(WORD, 20);
        address a = makeAddr("wordhunt.a");
        address b = makeAddr("wordhunt.b");
        uint256 end = g.endBlock();
        vm.roll(end - 2);
        _commitAs(a, WORD);
        vm.roll(end - 1);
        _commitAs(b, WORD);
        vm.roll(end);
        vm.expectRevert(WordHunt.RoundOver.selector);
        _revealAs(a, WORD);
        vm.expectRevert(WordHunt.RoundOver.selector);
        _commitAs(makeAddr("wordhunt.c"), WORD);
        assertEq(g.winner(), address(0));
    }

    function test_revealOneBlockAfterCommitWorks() public {
        _openAsSafe(WORD, ROUND_BLOCKS);
        address a = makeAddr("wordhunt.a");
        _commitAs(a, WORD);
        vm.roll(block.number + 1);
        _revealAs(a, WORD);
        assertEq(_wh().winner(), a);
    }

    function test_revealConsumesCommit_andMissDoesNotWin() public {
        _openAsSafe(WORD, ROUND_BLOCKS);
        address a = makeAddr("wordhunt.a");
        _commitAs(a, "pear");
        vm.roll(block.number + 1);
        _revealAs(a, "pear");
        (bytes32 h,) = _wh().commits(1, a);
        assertEq(h, bytes32(0));
        vm.expectRevert(WordHunt.NoCommit.selector);
        _revealAs(a, "pear");
        assertEq(_wh().wins(a), 0);
        assertEq(_wh().winner(), address(0));
    }

    function test_commitZeroHashReverts_andStoresBlock() public {
        _openAsSafe(WORD, ROUND_BLOCKS);
        address a = makeAddr("wordhunt.a");
        vm.prank(a);
        vm.expectRevert(WordHunt.ZeroHash.selector);
        _wh().commitGuess(bytes32(0));
        _commitAs(a, WORD);
        (bytes32 h, uint64 blk) = _wh().commits(1, a);
        assertEq(h, keccak256(abi.encode(WORD, a)));
        assertEq(uint256(blk), block.number);
    }

    function test_commitWithoutRound_reverts() public {
        vm.expectRevert(WordHunt.RoundOver.selector);
        _commitAs(makeAddr("wordhunt.a"), WORD);
        vm.expectRevert(WordHunt.RoundOver.selector);
        _revealAs(makeAddr("wordhunt.a"), WORD);
    }

    function test_nextRound_resetsWinner_commitsPerRound_winsAccumulate() public {
        WordHunt g = _wh();
        _openAsSafe(WORD, ROUND_BLOCKS);
        address a = makeAddr("wordhunt.a");
        _commitAs(a, WORD);
        vm.roll(block.number + 1);
        _revealAs(a, WORD);
        _openAsSafe(WORD, ROUND_BLOCKS);
        assertEq(g.round(), 2);
        assertEq(g.winner(), address(0));
        assertFalse(g.closed());
        _commitAs(a, WORD);
        vm.roll(block.number + 1);
        _revealAs(a, WORD);
        assertEq(g.wins(a), 2);
    }

    function test_openAfterUnclosedEnd_andStaleCommitUnusable() public {
        WordHunt g = _wh();
        _openAsSafe(WORD, ROUND_BLOCKS);
        address a = makeAddr("wordhunt.a");
        _commitAs(a, WORD);
        vm.roll(g.endBlock());
        _openAsSafe("other", ROUND_BLOCKS);
        vm.expectRevert(WordHunt.NoCommit.selector);
        _revealAs(a, WORD);
        assertEq(g.wordHash(), keccak256(bytes("other")));
    }

    function test_pausedRejectsOpen_notClose() public {
        WordHunt g = _wh();
        _openAsSafe(WORD, 10);
        vm.prank(safe);
        g.pause(true);
        vm.roll(g.endBlock());
        g.closeRound();
        vm.prank(safe);
        vm.expectRevert(bytes4(keccak256("NotLive()")));
        g.openRound(keccak256(bytes(WORD)), 10);
    }

    function test_keeperCanOpen_butNotSetKeeper() public {
        WordHunt g = _wh();
        address k = makeAddr("wordhunt.keeper");
        vm.prank(safe);
        g.setKeeper(k);
        vm.prank(k);
        vm.expectRevert(bytes4(keccak256("NotSafe()")));
        g.setKeeper(address(1));
    }

    function testFuzz_hashBindsSender(address a, address b) public view {
        vm.assume(a != b);
        assertTrue(_wh().hashGuess(WORD, a) != _wh().hashGuess(WORD, b));
    }
}

/// Commits, reveals, rolls, opens rounds, closes and claims at random, for the invariant run.
contract WordHuntHandler is Test {
    WordHunt internal g;
    address internal safeAddr;
    address[3] internal actors = [address(0xA1), address(0xA2), address(0xA3)];

    constructor(WordHunt g_) {
        g = g_;
        safeAddr = g_.safe();
    }

    function _guess(uint256 which) internal pure returns (string memory) {
        return which % 2 == 0 ? "apple" : "pear";
    }

    function doCommit(uint256 who, uint256 which) external {
        address a = actors[who % 3];
        string memory guess = _guess(which);
        bytes32 c = keccak256(abi.encode(guess, a));
        vm.prank(a);
        try g.commitGuess(c) {} catch {}
    }

    function doReveal(uint256 who, uint256 which) external {
        address a = actors[who % 3];
        string memory guess = _guess(which);
        vm.prank(a);
        try g.revealGuess(guess) {} catch {}
    }

    function doOpen(uint256 blocks) external {
        uint64 len = uint64(bound(blocks, 10, 150));
        vm.prank(safeAddr);
        try g.openRound(keccak256(bytes("apple")), len) {} catch {}
    }

    function doClose() external {
        if (block.number < g.endBlock()) return;
        try g.closeRound() {} catch {}
    }

    function doClaim(uint256 who) external {
        address a = actors[who % 3];
        if (g.owed(a) == 0) return;
        vm.prank(a);
        try g.claim() {} catch {}
    }

    function advance(uint32 n) external {
        vm.roll(block.number + bound(n, 1, 20));
    }

    function winsSum() external view returns (uint256 sum) {
        for (uint256 i; i < 3; ++i) {
            sum += g.wins(actors[i]);
        }
    }
}

/// The invariant run on the game the conformance setUp deployed and funded through the real factory.
contract WordHuntInvariantTest is WordHuntTest {
    WordHuntHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new WordHuntHandler(WordHunt(address(game)));
        targetContract(address(handler));
    }

    function invariant_solventAndNothingOwed() public view {
        assertGe(address(game).balance, game.owedTotal());
        assertEq(game.owedTotal(), 0);
    }

    function invariant_winsNeverExceedRounds() public view {
        assertLe(handler.winsSum(), WordHunt(address(game)).round());
    }
}
