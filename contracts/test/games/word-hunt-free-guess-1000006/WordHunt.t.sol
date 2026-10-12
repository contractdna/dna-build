// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {GameKit, GameKitConformance} from "../GameKitConformance.sol";
import {WordHunt} from "../../../src/games/word-hunt-free-guess-1000006/WordHunt.sol";

contract WordHuntTest is GameKitConformance {
    WordHunt internal g;

    bytes32 internal constant WORD_HASH = keccak256("apple");
    string internal constant MAX_32 = "abcdefghijklmnopqrstuvwxyz012345";
    string internal constant LONG_33 = "abcdefghijklmnopqrstuvwxyz0123456";

    function setUp() public virtual override {
        super.setUp();
        g = WordHunt(address(game));
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(WordHunt).creationCode;
    }

    /// One play: opens a round as the Safe when none is open (closing an expired one first), then commits "pear" when
    /// the player has no commit, or reveals "pear" a block later when it does.
    function _play(address player) internal override {
        if (!g.roundOpen()) {
            if (g.roundId() != 0 && !g.closed()) g.closeRound();
            vm.prank(safe);
            g.openRound(WORD_HASH, 100);
        }
        uint256 r = g.roundId();
        if (g.commitHash(r, player) == bytes32(0)) {
            bytes32 h = g.commitHashOf("pear", player);
            vm.prank(player);
            g.commitGuess(h);
        } else {
            vm.roll(block.number + 1);
            vm.prank(player);
            g.revealGuess("pear");
        }
    }

    /// Rolls past the open round's end and closes it (an empty close when nobody won).
    function _closeRounds() internal override {
        if (g.roundId() == 0 || g.closed()) return;
        if (block.number <= g.endBlock()) vm.roll(uint256(g.endBlock()) + 1);
        g.closeRound();
    }

    function test_params_inBounds() public view {
        assertEq(uint256(g.MIN_BLOCKS()), 10);
        assertEq(uint256(g.MAX_BLOCKS()), 50400);
        assertEq(uint256(g.MAX_LEN()), 32);
    }

    function test_onlySafeOrKeeperOpens() public {
        address stranger = makeAddr("wordhunt.stranger");
        vm.prank(stranger);
        vm.expectRevert(WordHunt.NotSetter.selector);
        g.openRound(WORD_HASH, 100);

        vm.prank(stranger);
        vm.expectRevert(GameKit.NotSafe.selector);
        g.setKeeper(stranger);

        address keeper = makeAddr("wordhunt.keeper");
        vm.prank(safe);
        g.setKeeper(keeper);
        assertEq(g.keeper(), keeper);
        vm.prank(keeper);
        g.openRound(WORD_HASH, 100);
        assertEq(g.roundId(), 1);
        assertTrue(g.roundOpen());
    }

    function test_openRound_rejectsZeroHashAndLengthOutOfBounds() public {
        vm.prank(safe);
        vm.expectRevert(WordHunt.BadHash.selector);
        g.openRound(bytes32(0), 100);

        uint64 lo = uint64(g.MIN_BLOCKS());
        vm.prank(safe);
        vm.expectRevert(WordHunt.BadLength.selector);
        g.openRound(WORD_HASH, lo - 1);

        uint64 hi = uint64(g.MAX_BLOCKS());
        vm.prank(safe);
        vm.expectRevert(WordHunt.BadLength.selector);
        g.openRound(WORD_HASH, hi + 1);

        vm.prank(safe);
        g.openRound(WORD_HASH, lo);
        assertEq(uint256(g.endBlock()), block.number + lo);
        _closeRounds();
        vm.prank(safe);
        g.openRound(WORD_HASH, hi);
        assertEq(uint256(g.endBlock()), block.number + hi);
    }

    function test_cannotOpenWhileARoundIsOpen_andOpeningWorksAfterCloseRound() public {
        vm.prank(safe);
        g.openRound(WORD_HASH, 100);
        vm.prank(safe);
        vm.expectRevert(WordHunt.RoundIsOpen.selector);
        g.openRound(WORD_HASH, 100);

        _closeRounds();
        vm.prank(safe);
        g.openRound(WORD_HASH, 100);
        assertEq(g.roundId(), 2);
    }

    function _openRound() internal {
        vm.prank(safe);
        g.openRound(WORD_HASH, 100);
    }

    function _commitAs(address p, string memory guess) internal {
        bytes32 h = g.commitHashOf(guess, p);
        vm.prank(p);
        g.commitGuess(h);
    }

    function _revealAs(address p, string memory guess) internal {
        vm.prank(p);
        g.revealGuess(guess);
    }

    function test_correctRevealWins() public {
        address a = makeAddr("wordhunt.a");
        _openRound();
        _commitAs(a, "apple");
        vm.roll(block.number + 1);
        vm.recordLogs();
        _revealAs(a, "apple");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool won;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(g) && logs[i].topics[0] == WordHunt.Win.selector) won = true;
        }
        assertTrue(won, "a right reveal emits Win");
        assertEq(g.winner(), a);
        assertEq(g.winnerOf(1), a);
        assertEq(g.wins(a), 1);
        assertTrue(g.closed());
        assertFalse(g.roundOpen());
    }

    function test_onlyFirstCorrectRevealWins() public {
        address a = makeAddr("wordhunt.first");
        address b = makeAddr("wordhunt.second");
        _openRound();
        _commitAs(a, "apple");
        _commitAs(b, "apple");
        vm.roll(block.number + 1);
        _revealAs(a, "apple");
        vm.prank(b);
        vm.expectRevert(WordHunt.NoOpenRound.selector);
        g.revealGuess("apple");
        assertEq(g.winner(), a);
        assertEq(g.wins(a), 1);
        assertEq(g.wins(b), 0);
    }

    function test_wrongRevealDoesNotWin_andClearsTheCommit() public {
        address a = makeAddr("wordhunt.wrong");
        _openRound();
        _commitAs(a, "pear");
        assertTrue(g.commitHash(1, a) != bytes32(0));
        vm.roll(block.number + 1);
        _revealAs(a, "pear");
        assertEq(g.winner(), address(0));
        assertEq(g.wins(a), 0);
        assertFalse(g.closed());
        assertTrue(g.roundOpen());
        assertEq(g.commitHash(1, a), bytes32(0), "the reveal clears the commit");
    }

    function test_duplicateCommitReverts() public {
        address a = makeAddr("wordhunt.dup");
        _openRound();
        _commitAs(a, "apple");
        bytes32 dup = g.commitHashOf("pear", a);
        vm.prank(a);
        vm.expectRevert(WordHunt.AlreadyCommitted.selector);
        g.commitGuess(dup);
    }

    function test_revealInSameBlockReverts() public {
        address a = makeAddr("wordhunt.sameBlock");
        _openRound();
        _commitAs(a, "apple");
        vm.prank(a);
        vm.expectRevert(WordHunt.SameBlock.selector);
        g.revealGuess("apple");
        vm.roll(block.number + 1);
        _revealAs(a, "apple");
        assertEq(g.winner(), a, "the same reveal works one block later");
    }

    function test_revealWithoutCommitReverts() public {
        address a = makeAddr("wordhunt.nocommit");
        _openRound();
        vm.roll(block.number + 1);
        vm.prank(a);
        vm.expectRevert(WordHunt.NoCommit.selector);
        g.revealGuess("apple");
        _commitAs(a, "apple");
        vm.roll(block.number + 1);
        _revealAs(a, "apple");
        assertEq(g.winner(), a, "with a commit the same reveal wins");
    }

    function test_copiedRevealFromAnotherAddressFails() public {
        address a = makeAddr("wordhunt.owner");
        address b = makeAddr("wordhunt.copier");
        _openRound();
        _commitAs(a, "apple");
        bytes32 copied = g.commitHashOf("apple", a);
        vm.prank(b);
        g.commitGuess(copied);
        vm.roll(block.number + 1);
        vm.prank(b);
        vm.expectRevert(WordHunt.WrongCommit.selector);
        g.revealGuess("apple");
        _revealAs(a, "apple");
        assertEq(g.winner(), a);
        assertEq(g.wins(b), 0);
    }

    function test_guessLengthBounds() public {
        address a = makeAddr("wordhunt.empty");
        address b = makeAddr("wordhunt.long");
        address c = makeAddr("wordhunt.max");
        _openRound();
        _commitAs(a, "");
        _commitAs(b, LONG_33);
        _commitAs(c, MAX_32);
        vm.roll(block.number + 1);
        vm.prank(a);
        vm.expectRevert(WordHunt.BadGuessLength.selector);
        g.revealGuess("");
        vm.prank(b);
        vm.expectRevert(WordHunt.BadGuessLength.selector);
        g.revealGuess(LONG_33);
        _revealAs(c, MAX_32);
        assertEq(g.winner(), address(0), "a 32-byte wrong guess is accepted and loses");
        assertEq(g.wins(c), 0);
    }

    function test_afterEndBlock_roundShutsAndClosesEmpty() public {
        address a = makeAddr("wordhunt.end");
        address b = makeAddr("wordhunt.endLate");
        _openRound();
        _commitAs(a, "pear");
        vm.roll(g.endBlock());
        vm.expectRevert(WordHunt.RoundRunning.selector);
        g.closeRound();
        vm.roll(uint256(g.endBlock()) + 1);
        bytes32 hb = g.commitHashOf("apple", b);
        vm.prank(b);
        vm.expectRevert(WordHunt.NoOpenRound.selector);
        g.commitGuess(hb);
        vm.prank(a);
        vm.expectRevert(WordHunt.NoOpenRound.selector);
        g.revealGuess("pear");
        g.closeRound();
        assertTrue(g.closed());
        assertEq(g.winner(), address(0), "a round with no winner closes empty");
        assertEq(g.wins(a), 0);
    }

    function test_pausedRoundRejectsGuesses() public {
        address a = makeAddr("wordhunt.paused");
        address b = makeAddr("wordhunt.pausedLate");
        _openRound();
        _commitAs(a, "apple");
        vm.roll(block.number + 1);
        vm.prank(safe);
        g.pause(true);
        bytes32 hb = g.commitHashOf("apple", b);
        vm.prank(b);
        vm.expectRevert(GameKit.NotLive.selector);
        g.commitGuess(hb);
        vm.prank(a);
        vm.expectRevert(GameKit.NotLive.selector);
        g.revealGuess("apple");
        vm.prank(safe);
        g.pause(false);
        _revealAs(a, "apple");
        assertEq(g.winner(), a, "after unpause the same reveal wins");
        vm.prank(safe);
        g.pause(true);
        vm.prank(safe);
        vm.expectRevert(GameKit.NotLive.selector);
        g.openRound(WORD_HASH, 100);
        vm.prank(safe);
        g.pause(false);
        _openRound();
        assertEq(g.roundId(), 2, "opening works again once unpaused");
    }

    function test_onlyTheSafePauses() public {
        address keeper = makeAddr("wordhunt.keeperPause");
        vm.prank(safe);
        g.setKeeper(keeper);
        vm.prank(keeper);
        vm.expectRevert(GameKit.NotSafe.selector);
        g.pause(true);
        assertFalse(g.paused());
        vm.prank(safe);
        g.pause(true);
        assertTrue(g.paused());
    }

    function test_commitsAreKeptPerRound() public {
        address a = makeAddr("wordhunt.perRound");
        _openRound();
        _commitAs(a, "pear");
        _closeRounds();
        _openRound();
        assertEq(g.commitHash(2, a), bytes32(0), "round 2 starts with no commits");
        vm.roll(block.number + 1);
        vm.prank(a);
        vm.expectRevert(WordHunt.NoCommit.selector);
        g.revealGuess("pear");
        _commitAs(a, "apple");
        vm.roll(block.number + 1);
        _revealAs(a, "apple");
        assertEq(g.winnerOf(2), a);
    }

    function test_lastBlockStillOpen_commitAndRevealWork() public {
        address a = makeAddr("wordhunt.lastBlock");
        _openRound();
        vm.roll(uint256(g.endBlock()) - 1);
        _commitAs(a, "apple");
        vm.roll(uint256(g.endBlock()));
        assertTrue(g.roundOpen());
        _revealAs(a, "apple");
        assertEq(g.winner(), a);
        assertEq(g.winnerOf(1), a);
    }

    function test_closeRound_noRoundOrTwiceOrAfterWinReverts() public {
        vm.expectRevert(WordHunt.NoOpenRound.selector);
        g.closeRound();
        _openRound();
        vm.roll(uint256(g.endBlock()) + 1);
        g.closeRound();
        vm.expectRevert(WordHunt.NoOpenRound.selector);
        g.closeRound();
        _openRound();
        address a = makeAddr("wordhunt.closeWon");
        _commitAs(a, "apple");
        vm.roll(block.number + 1);
        _revealAs(a, "apple");
        vm.roll(uint256(g.endBlock()) + 1);
        vm.expectRevert(WordHunt.NoOpenRound.selector);
        g.closeRound();
        assertEq(g.winnerOf(2), a);
    }

    function test_newRoundResetsWinner_keepsHistoryAndWins() public {
        address a = makeAddr("wordhunt.history");
        _openRound();
        _commitAs(a, "apple");
        vm.roll(block.number + 1);
        _revealAs(a, "apple");
        _openRound();
        assertEq(g.winner(), address(0));
        assertFalse(g.closed());
        assertEq(g.winnerOf(1), a);
        assertEq(g.wins(a), 1);
        _commitAs(a, "apple");
        vm.roll(block.number + 1);
        _revealAs(a, "apple");
        assertEq(g.wins(a), 2);
        assertEq(g.winnerOf(2), a);
    }

    function test_commitNoRoundOrZeroHashReverts_andKeeperCanBeCleared() public {
        address a = makeAddr("wordhunt.zero");
        vm.prank(a);
        vm.expectRevert(WordHunt.NoOpenRound.selector);
        g.commitGuess(bytes32(uint256(1)));
        _openRound();
        vm.prank(a);
        vm.expectRevert(WordHunt.BadHash.selector);
        g.commitGuess(bytes32(0));
        address k = makeAddr("wordhunt.k");
        vm.prank(safe);
        g.setKeeper(k);
        vm.prank(safe);
        g.setKeeper(address(0));
        _closeRounds();
        vm.prank(k);
        vm.expectRevert(WordHunt.NotSetter.selector);
        g.openRound(WORD_HASH, 100);
    }

    function test_reCommitAfterWrongReveal_andWrongReveal_keepsOtherCommits() public {
        address a = makeAddr("wordhunt.recommit");
        address b = makeAddr("wordhunt.other");
        _openRound();
        _commitAs(a, "pear");
        _commitAs(b, "apple");
        vm.roll(block.number + 1);
        _revealAs(a, "pear");
        assertTrue(g.commitHash(1, b) != bytes32(0));
        _commitAs(a, "apple");
        vm.roll(block.number + 1);
        _revealAs(a, "apple");
        assertEq(g.winner(), a);
    }

    /// Any gap between commit and reveal: a reveal in the commit's own block is refused, a later one is judged by its
    /// word (an empty or over-long word is refused too).
    function testFuzz_commitRevealOrdering(uint8 gap, string memory guess, bool right) public {
        string memory word = guess;
        if (right) word = "apple";
        address a = makeAddr("wordhunt.fuzzOrder");
        _openRound();
        bytes32 h = g.commitHashOf(word, a);
        vm.prank(a);
        g.commitGuess(h);
        uint256 step = uint256(gap) % 90;
        vm.roll(block.number + step);
        uint256 n = bytes(word).length;
        vm.prank(a);
        if (step == 0 || n == 0 || n > 32) {
            vm.expectRevert();
            g.revealGuess(word);
            assertEq(g.winner(), address(0), "a refused reveal wins nothing");
            assertTrue(g.roundOpen());
            return;
        }
        g.revealGuess(word);
        if (keccak256(bytes(word)) == keccak256("apple")) {
            assertEq(g.winner(), a);
        } else {
            assertEq(g.winner(), address(0));
        }
    }

    /// B copies A's commitment: B's reveal fails (the hash binds the sender), A's reveal still wins.
    function testFuzz_copiedRevealFails(address a, address b) public {
        vm.assume(a != address(0) && b != address(0) && a != b);
        _openRound();
        bytes32 ha = g.commitHashOf("apple", a);
        vm.prank(a);
        g.commitGuess(ha);
        vm.prank(b);
        g.commitGuess(ha);
        vm.roll(block.number + 1);
        vm.prank(b);
        vm.expectRevert(WordHunt.WrongCommit.selector);
        g.revealGuess("apple");
        assertEq(g.winner(), address(0));
        _revealAs(a, "apple");
        assertEq(g.winner(), a, "the owner's reveal still wins");
        assertEq(g.wins(b), 0);
    }
}

/// Random rounds, commits, reveals and blocks for the invariant run (every call may fail).
contract WordHuntHandler is Test {
    WordHunt internal g;
    address internal safe;
    bytes32 internal constant WORD_HASH = keccak256("apple");

    constructor(WordHunt g_, address safe_) {
        g = g_;
        safe = safe_;
    }

    function beginRound(uint256 len) external {
        if (g.roundOpen()) return;
        if (g.roundId() != 0 && !g.closed()) {
            try g.closeRound() {} catch {}
        }
        uint64 n = uint64(10 + (len % 91));
        vm.prank(safe);
        try g.openRound(WORD_HASH, n) {} catch {}
    }

    function commit(uint256 who, bool right) external {
        string memory guess = "pear";
        if (right) guess = "apple";
        address p = actor(who);
        bytes32 h = g.commitHashOf(guess, p);
        vm.prank(p);
        try g.commitGuess(h) {} catch {}
    }

    function reveal(uint256 who, bool right) external {
        string memory guess = "pear";
        if (right) guess = "apple";
        address p = actor(who);
        vm.prank(p);
        try g.revealGuess(guess) {} catch {}
    }

    function advance(uint32 s) external {
        vm.roll(block.number + 1 + (uint256(s) % 60));
    }

    function endRound() external {
        try g.closeRound() {} catch {}
    }

    function winsSum() external view returns (uint256 sum) {
        sum = g.wins(address(0xA1)) + g.wins(address(0xA2)) + g.wins(address(0xA3)) + g.wins(address(0xA4));
    }

    function actor(uint256 who) internal pure returns (address) {
        uint256 k = who % 4;
        if (k == 0) return address(0xA1);
        if (k == 1) return address(0xA2);
        if (k == 2) return address(0xA3);
        return address(0xA4);
    }
}

/// The invariant run on the game the conformance setUp deployed and funded through the real factory.
contract WordHuntInvariantTest is WordHuntTest {
    WordHuntHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new WordHuntHandler(g, safe);
        targetContract(address(handler));
    }

    function invariant_solvent_noOneOwed_winsMatchWonRounds() public view {
        _assertSolvent();
        assertEq(game.owedTotal(), 0, "nothing is owed: a word hunt pays nothing");
        uint256 won;
        uint256 last = g.roundId();
        for (uint256 r = 1; r <= last; ++r) {
            if (g.winnerOf(r) != address(0)) ++won;
        }
        assertEq(handler.winsSum(), won, "each win is one won round");
    }
}
