// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console, Vm} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {DNAToken} from "../src/DNAToken.sol";
import {ConvictionVault} from "../src/ConvictionVault.sol";
import {GamePot} from "../src/GamePot.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {PoolBound} from "../src/PoolBound.sol";
import {IModuleRegistry} from "../src/interfaces/IDNA.sol";
import {IVRFCoordinatorV2Plus, VRFV2PlusClient} from "../src/interfaces/IVRFCoordinatorV2Plus.sol";
import {TestHook, MockRegistry, MockSplit} from "./Vaults.t.sol";
import {RolesRegistry} from "./ConvictionVault.t.sol";

/// @dev VRF v2.5 coordinator stand-in: subscriptions with native balances, consumer checks, request validation
///      (confirmations, gas cap, native-payment extraArgs), and `fulfill` that calls the consumer with exactly the
///      requested callback gas (as `_callWithExactGas`) and charges a flat fee to the subscription.
contract MockCoordinator {
    struct Sub {
        address owner;
        uint96 nativeBalance;
        bool live;
    }

    struct Req {
        address consumer;
        uint256 subId;
        uint32 gasLimit;
        bool native;
        bool pending;
    }

    uint256 public nextSub = 1;
    uint256 public nextReq = 1000;
    uint256 public fee = 0.001 ether;
    mapping(uint256 => Sub) public subs;
    mapping(uint256 => mapping(address => bool)) public isConsumer;
    mapping(uint256 => Req) public reqs;
    uint256 public lastGasUsed;
    bool public lastSuccess;
    uint256 public totalFunded;
    uint256 public totalRefunded;

    function createSubscription() external returns (uint256 id) {
        id = nextSub++;
        subs[id] = Sub(msg.sender, 0, true);
    }

    function addConsumer(uint256 id, address c) external {
        require(subs[id].live && subs[id].owner == msg.sender, "MustBeSubOwner");
        isConsumer[id][c] = true;
    }

    function fundSubscriptionWithNative(uint256 id) external payable {
        require(subs[id].live, "InvalidSubscription");
        subs[id].nativeBalance += uint96(msg.value);
        totalFunded += msg.value;
    }

    function getSubscription(uint256 id)
        external
        view
        returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address owner, address[] memory consumers)
    {
        require(subs[id].live, "InvalidSubscription");
        return (0, subs[id].nativeBalance, 0, subs[id].owner, consumers);
    }

    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata r) external returns (uint256 id) {
        require(subs[r.subId].live && isConsumer[r.subId][msg.sender], "InvalidConsumer");
        require(r.requestConfirmations >= 3 && r.requestConfirmations <= 200, "InvalidRequestConfirmations");
        require(r.callbackGasLimit <= 2_500_000, "GasLimitTooBig");
        require(r.numWords == 1, "words");
        bool native = r.extraArgs.length == 36 && bytes4(r.extraArgs[:4]) == VRFV2PlusClient.EXTRA_ARGS_V1_TAG
            && uint8(r.extraArgs[35]) == 1;
        require(native, "native payment expected");
        id = nextReq++;
        reqs[id] = Req(msg.sender, r.subId, r.callbackGasLimit, native, true);
    }

    function fulfill(uint256 id, uint256 word) external returns (bool ok) {
        Req memory q = reqs[id];
        require(q.pending, "no request");
        reqs[id].pending = false;
        uint256[] memory w = new uint256[](1);
        w[0] = word;
        bytes memory call = abi.encodeWithSignature("rawFulfillRandomWords(uint256,uint256[])", id, w);
        uint256 g = gasleft();
        (ok,) = q.consumer.call{gas: q.gasLimit}(call);
        lastGasUsed = g - gasleft();
        lastSuccess = ok;
        Sub storage s = subs[q.subId];
        if (s.live) s.nativeBalance -= uint96(fee); // the oracle's payment stays here
    }

    /// Raw delivery for stale / foreign request ids (the real coordinator only ever delivers committed requests).
    function deliver(address consumer, uint256 id, uint256 word) external {
        uint256[] memory w = new uint256[](1);
        w[0] = word;
        (bool ok,) = consumer.call(abi.encodeWithSignature("rawFulfillRandomWords(uint256,uint256[])", id, w));
        require(ok, "callback reverted");
    }

    /// ownerCancelSubscription: refund the native balance to the sub owner, delete the sub.
    function ownerCancel(uint256 id) external {
        Sub memory s = subs[id];
        delete subs[id];
        totalRefunded += s.nativeBalance;
        (bool ok,) = s.owner.call{value: s.nativeBalance}("");
        require(ok, "FailedToSendNative");
    }

    receive() external payable {}
}

/// @dev The engine's tree (engine/src/tickets.ts `tree` / `proofOf`): OZ double-hashed leaves, sorted pairs, an odd
///      node promoted unchanged.
library Tree {
    function pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function leaf(GamePot.Leaf memory l) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(l.index, l.account, l.cumStart, l.tickets))));
    }

    /// Root, and the proof of leaf `idx`.
    function build(bytes32[] memory hashes, uint256 idx) internal pure returns (bytes32 root, bytes32[] memory proof) {
        uint256 n = hashes.length;
        bytes32[] memory l = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            l[i] = hashes[i];
        }
        bytes32[] memory p = new bytes32[](64);
        uint256 k;
        while (n > 1) {
            if ((idx ^ 1) < n) p[k++] = l[idx ^ 1];
            for (uint256 i; 2 * i < n; ++i) {
                l[i] = 2 * i + 1 < n ? pair(l[2 * i], l[2 * i + 1]) : l[2 * i];
            }
            (n, idx) = ((n + 1) / 2, idx >> 1);
        }
        proof = new bytes32[](k);
        for (uint256 i; i < k; ++i) {
            proof[i] = p[i];
        }
        root = l[0];
    }
}

// ---------------------------------------------------------------- push receivers

contract Sink {
    receive() external payable {}
}

contract Reverter {
    receive() external payable {
        revert("no ETH");
    }

    function claim(GamePot pot, uint256 id, address to) external returns (uint256) {
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        return pot.claim(ids, to);
    }
}

contract GasBurner {
    receive() external payable {
        while (true) {}
    }
}

/// Returns `size` bytes of returndata from its receive (as much as its gas allows).
contract ReturnBomb {
    uint256 immutable size;

    constructor(uint256 s) {
        size = s;
    }

    receive() external payable {
        uint256 s = size;
        assembly ("memory-safe") {
            return(0, s)
        }
    }
}

/// A receiver whose success depends on the gas it gets, failing cheaply below 45k: what a griefing settler would
/// starve if the pot let a short-gassed push fall through to the claim path.
contract GasPicky {
    receive() external payable {
        if (gasleft() < 45_000) revert();
    }
}

/// During the push: reports the pot's state (CEI: the draw is closed and the prize is owed before the call) and tries
/// every money path; `bubble` makes the push fail after the attempts.
contract Reenter {
    event Seen(uint256 owedTotal, uint256 drawCount, uint256 drawWindow, address prizeWinner, bool prizeClaimed);
    event Blocked(bytes4 err);

    GamePot immutable pot;
    bool immutable bubble;

    constructor(GamePot p, bool b) {
        (pot, bubble) = (p, b);
    }

    receive() external payable {
        uint256 id = pot.drawCount();
        (address w, uint64 amt,) = pot.prizes(id);
        bool c = w != address(0) && amt == 0;
        (uint64 win,,,,,,,,) = pot.draw();
        emit Seen(pot.owedTotal(), id, win, w, c);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        try pot.claim(ids, address(this)) {}
        catch (bytes memory e) {
            emit Blocked(bytes4(e));
        }
        try pot.settle(new GamePot.Leaf[](0), new bytes32[][](0)) {}
        catch (bytes memory e) {
            emit Blocked(bytes4(e));
        }
        try pot.sync() {}
        catch (bytes memory e) {
            emit Blocked(bytes4(e));
        }
        try pot.requestDraw() {}
        catch (bytes memory e) {
            emit Blocked(bytes4(e));
        }
        try pot.expireClaim(id) {}
        catch (bytes memory e) {
            emit Blocked(bytes4(e));
        }
        try pot.payReward(1) {}
        catch (bytes memory e) {
            emit Blocked(bytes4(e));
        }
        if (bubble) revert("bubble");
    }
}

/// @dev Shared fixture: real DNAToken, ConvictionVault, FeeVault and GamePot on a fresh PoolManager; TestHook as
///      the hook (its `fund` mints ETH-backed claims), RolesRegistry for roles, MockCoordinator for VRF.
abstract contract GameBase is Deployers {
    bytes32 constant KEY_HASH = 0x8077df514608a09f83e4e8d300645594e5d7234665448ba83f51a50f842bd3d9;
    uint256 constant L = 10_000 ether;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    DNAToken token;
    RolesRegistry reg;
    ConvictionVault vault;
    GamePot pot;
    FeeVault fv;
    TestHook hook;
    MockRegistry splitReg;
    MockSplit splitModule;
    MockCoordinator coord;
    address safe = makeAddr("safe");
    address agent = makeAddr("agent");
    address anchor = makeAddr("anchor");
    address team = makeAddr("team");
    address bb = makeAddr("buybackBurn");
    address lv = makeAddr("liquidityVault");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    GamePot.Leaf[] leaves; // the list the next `_post` posts

    /// A full `postList` call, so each binding check can be broken alone.
    struct Post {
        address who;
        uint256 w;
        GamePot.Params params;
        bytes32 root;
        uint256 total;
        uint256 holders;
        GamePot.Leaf last;
        bytes32[] proof;
    }

    function setUp() public virtual {
        vm.warp(1_760_000_000);
        vm.fee(1 gwei);
        vm.deal(address(this), 1e30);
        deployFreshManager();
        token = new DNAToken(address(this));
        reg = new RolesRegistry(safe, agent, anchor);
        coord = new MockCoordinator();
        address[] memory ex = new address[](1);
        ex[0] = team;
        vault = new ConvictionVault(IModuleRegistry(address(reg)), safe, ex);
        pot = new GamePot(
            manager, safe, vault, IModuleRegistry(address(reg)), IVRFCoordinatorV2Plus(address(coord)), KEY_HASH
        );
        splitReg = new MockRegistry();
        splitModule = new MockSplit();
        fv = new FeeVault(manager, address(splitReg), bb, lv, address(pot), safe);
        hook = new TestHook(manager, address(token), address(fv), makeAddr("platform"), bb);
        vm.startPrank(safe);
        pot.initialize(address(hook)); // binds DNA from the hook's PoolKey, opens window 1
        vault.initialize(address(pot)); // then the vault takes DNA
        vm.stopPrank();
        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            token.transfer(who[i], 100_000_000 ether);
            vm.prank(who[i]);
            token.approve(address(vault), type(uint256).max);
        }
    }

    function _claims(address a) internal view returns (uint256) {
        return manager.balanceOf(a, 0);
    }

    function _fundPot(uint256 amount) internal {
        hook.fund{value: amount}(address(pot));
    }

    function _lock(address who, uint256 amount, uint8 tier) internal returns (uint256 id) {
        vm.prank(who);
        id = vault.lock(amount, tier);
    }

    /// The public getter's 10 static words are the struct's ABI encoding.
    function _draw() internal view returns (GamePot.Draw memory) {
        (, bytes memory r) = address(pot).staticcall(abi.encodeWithSignature("draw()"));
        return abi.decode(r, (GamePot.Draw));
    }

    struct PrizeView {
        address winner;
        uint256 amount; // 0 once claimed or expired
        uint256 wonAt;
        bool claimed;
    }

    function _prize(uint256 id) internal view returns (PrizeView memory p) {
        (p.winner, p.amount, p.wonAt) = pot.prizes(id);
        p.claimed = p.winner != address(0) && p.amount == 0;
    }

    function _liabilities() internal view returns (uint256) {
        return pot.jackpotPot() + pot.ideaReserve() + _draw().prize + pot.owedTotal() + pot.queuedRewards();
    }

    function _one(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    // ---------- lists ----------

    function _setList(address[] memory accts, uint256[] memory tix) internal {
        delete leaves;
        uint256 cum;
        for (uint256 i; i < accts.length; ++i) {
            leaves.push(GamePot.Leaf(i, accts[i], cum, tix[i]));
            cum += tix[i];
        }
    }

    /// alice [0, 5), bob [5, 8), carol [8, 15).
    function _list3() internal {
        address[] memory a = new address[](3);
        uint256[] memory t = new uint256[](3);
        (a[0], a[1], a[2]) = (alice, bob, carol);
        (t[0], t[1], t[2]) = (5, 3, 7);
        _setList(a, t);
    }

    /// One holder, one ticket: it wins every draw.
    function _list1(address a) internal {
        delete leaves;
        leaves.push(GamePot.Leaf(0, a, 0, 1));
    }

    function _total() internal view returns (uint256) {
        GamePot.Leaf memory l = leaves[leaves.length - 1];
        return l.cumStart + l.tickets;
    }

    function _hashes() internal view returns (bytes32[] memory h) {
        h = new bytes32[](leaves.length);
        for (uint256 i; i < h.length; ++i) {
            h[i] = Tree.leaf(leaves[i]);
        }
    }

    function _proof(uint256 i) internal view returns (bytes32 root, bytes32[] memory p) {
        return Tree.build(_hashes(), i);
    }

    /// Roll until the open window contains now, then warp to its end (it is now the latest closed window).
    function _close() internal {
        while (block.timestamp >= pot.windowEnd()) {
            pot.rollWindow();
        }
        vm.warp(pot.windowEnd());
    }

    /// A valid post of `leaves` for the latest closed window, by the agent.
    function _good() internal view returns (Post memory s) {
        uint256 n = leaves.length;
        (s.w,) = pot.latestClosedWindow();
        (s.root, s.proof) = _proof(n - 1);
        (s.who, s.params, s.total, s.holders) = (agent, GamePot.Params(100, 1_000 ether), _total(), n);
        s.last = leaves[n - 1];
    }

    function _send(Post memory s, bytes4 err) internal {
        if (err != bytes4(0)) vm.expectRevert(err);
        vm.prank(s.who);
        pot.postList(s.w, s.params, s.root, s.total, s.holders, s.last, s.proof, "ipfs://list", keccak256("list"));
    }

    function _post() internal returns (uint256 w) {
        Post memory s = _good();
        _send(s, 0);
        return s.w;
    }

    /// Fund, close the next window, post `leaves` (the 3-holder list if none), wait out the Safe's veto.
    function _ready(uint256 fund) internal {
        if (leaves.length == 0) _list3();
        _fundPot(fund);
        _close();
        _post();
        vm.warp(block.timestamp + pot.LIST_DELAY());
    }

    function _fulfil(uint256 word) internal {
        coord.fulfill(_draw().reqId, word);
    }

    /// The leaf holding ticket `t`.
    function _holderOf(uint256 t) internal view returns (uint256 i) {
        while (!(leaves[i].cumStart <= t && t < leaves[i].cumStart + leaves[i].tickets)) {
            ++i;
        }
    }

    /// The settle input, as the keeper builds it (engine pickWinners): walk ticketAt(rand, j), prove each ticket's leaf,
    /// skip an account already picked or excluded, stop at WINNERS winners or MAX_TICKETS tickets.
    function _walk() internal view returns (GamePot.Leaf[] memory ls, bytes32[][] memory ps, address[] memory winners) {
        GamePot.Draw memory d = _draw();
        GamePot.Leaf[] memory tl = new GamePot.Leaf[](32);
        bytes32[][] memory tp = new bytes32[][](32);
        address[] memory w = new address[](10);
        (uint256 n, uint256 k) = (0, 0);
        for (uint256 j; j < 32 && n < 10; ++j) {
            uint256 i = _holderOf(pot.ticketAt(d.rand, j, d.totalTickets));
            tl[k] = leaves[i];
            (, tp[k]) = _proof(i);
            ++k;
            address a = leaves[i].account;
            bool dup;
            for (uint256 x; x < n; ++x) {
                if (w[x] == a) dup = true;
            }
            if (dup || pot.isExcluded(a)) continue;
            w[n++] = a;
        }
        (ls, ps, winners) = (new GamePot.Leaf[](k), new bytes32[][](k), new address[](n));
        for (uint256 x; x < k; ++x) {
            (ls[x], ps[x]) = (tl[x], tp[x]);
        }
        for (uint256 x; x < n; ++x) {
            winners[x] = w[x];
        }
    }

    function _proofOf(uint256 i) internal view returns (bytes32[] memory p) {
        (, p) = _proof(i);
    }

    /// The first `n` entries of a settle input (n > its length: padded with its first entry).
    function _slice(GamePot.Leaf[] memory ls, bytes32[][] memory ps, uint256 n)
        internal
        pure
        returns (GamePot.Leaf[] memory l2, bytes32[][] memory p2)
    {
        (l2, p2) = (new GamePot.Leaf[](n), new bytes32[][](n));
        for (uint256 i; i < n; ++i) {
            GamePot.Leaf memory src = i < ls.length ? ls[i] : ls[0];
            (l2[i], p2[i]) =
            (GamePot.Leaf(src.index, src.account, src.cumStart, src.tickets), i < ls.length ? ps[i] : ps[0]);
        }
    }

    /// A VRF word whose first derived ticket is `t0`.
    function _wordFor(uint256 t0) internal view returns (uint256 w) {
        while (pot.ticketAt(w, 0, _total()) != t0) {
            ++w;
        }
    }

    /// Settle the fulfilled draw; returns how many accounts won.
    function _settle() internal returns (uint256 n) {
        (GamePot.Leaf[] memory ls, bytes32[][] memory ps, address[] memory w) = _walk();
        pot.settle(ls, ps);
        return w.length;
    }

    /// One whole draw on a one-account list: fund, post, request, fulfil, settle. Returns the claim id (0 = pushed) and
    /// the share (prize / WINNERS; the other nine shares return to the pot).
    function _drawTo(address winner) internal returns (uint256 id, uint256 share) {
        _list1(winner);
        _ready(2 ether);
        pot.requestDraw();
        share = _draw().prize / 10;
        _fulfil(0);
        _settle();
        lastSettleGas = vm.lastFrameGas().gasTotalUsed; // the settle frame (read before any other call)
        id = pot.drawCount();
    }

    uint256 internal lastSettleGas;
}

contract GamePotTest is GameBase {
    // ---------- wiring ----------

    function test_initialize_bindsAndCreatesSubscription() public view {
        assertEq(pot.hook(), address(hook));
        assertEq(pot.feeVault(), address(fv));
        assertEq(pot.buybackBurn(), bb);
        assertEq(pot.liquidityVault(), lv);
        assertEq(pot.token(), address(token));
        (,,, address owner,) = coord.getSubscription(pot.subId());
        assertEq(owner, address(pot));
        assertTrue(coord.isConsumer(pot.subId(), address(pot)));
        assertEq(pot.drawInterval(), 24 hours);
        assertEq(pot.SUB_MIN(), 0.1364 ether, "200 gwei x 550k x 1.24");
        assertEq(pot.windowId(), 1, "window 1 opens at initialize");
        assertEq(pot.windowStart(), block.timestamp);
        assertEq(pot.windowEnd(), block.timestamp + 24 hours);
    }

    function test_initialize_rejects() public {
        GamePot p2 = new GamePot(
            manager, safe, vault, IModuleRegistry(address(reg)), IVRFCoordinatorV2Plus(address(coord)), KEY_HASH
        );
        vm.expectRevert(PoolBound.NotInitialized.selector);
        p2.rollWindow();
        (uint256 w, uint256 end) = p2.latestClosedWindow();
        assertEq(w + end, 0);
        vm.expectRevert(PoolBound.NotInitializer.selector);
        p2.initialize(address(hook));
        vm.prank(safe);
        vm.expectRevert(PoolBound.WrongHook.selector); // the hook's FeeVault pays `pot`, not p2
        p2.initialize(address(hook));
        vm.prank(safe);
        vm.expectRevert(PoolBound.AlreadyInitialized.selector);
        pot.initialize(address(hook));
        vm.expectRevert(GamePot.BadConfig.selector);
        new GamePot(manager, safe, vault, IModuleRegistry(address(reg)), IVRFCoordinatorV2Plus(address(coord)), 0);
    }

    // ---------- sync ----------

    function test_sync_reserveCap() public {
        _fundPot(60 ether); // jackpot 42 → 15, reserve 18 → 15
        pot.sync();
        assertEq(pot.jackpotPot(), 15 ether);
        assertEq(pot.ideaReserve(), 15 ether, "RESERVE_CAP");
        assertEq(_claims(bb), 30 ether);
        assertEq(_claims(address(pot)), _liabilities());
    }

    function test_sync_splitsAndCaps() public {
        _fundPot(1 ether);
        pot.sync();
        assertEq(pot.jackpotPot(), 0.7 ether);
        assertEq(pot.ideaReserve(), 0.3 ether);
        _fundPot(30 ether);
        pot.sync();
        assertEq(pot.jackpotPot(), 15 ether, "POT_CAP");
        assertEq(_claims(bb), 0.7 ether + 21 ether - 15 ether, "overflow to BuybackBurn claims");
        assertEq(pot.ideaReserve(), 0.3 ether + 9 ether);
        assertEq(_claims(address(pot)), _liabilities());
    }

    function test_sync_countsStrayEthAsClaims() public {
        (bool ok,) = address(pot).call{value: 1 ether}("");
        assertTrue(ok);
        pot.sync();
        assertEq(address(pot).balance, 0);
        assertEq(_claims(address(pot)), 1 ether);
        assertEq(pot.jackpotPot() + pot.ideaReserve(), 1 ether);
    }

    /// FeeVault's game share (the launch split) lands as claims and is counted.
    function test_feeVaultGameShareArrives() public {
        splitReg.set(
            address(splitModule),
            [bytes32(uint256(3500)), bytes32(uint256(3000)), bytes32(uint256(2500)), bytes32(uint256(1000))]
        );
        hook.fund{value: 2 ether}(address(fv));
        fv.distribute();
        pot.sync();
        assertEq(pot.jackpotPot() + pot.ideaReserve(), 0.2 ether);
    }

    // ---------- windows ----------

    function test_rollWindow() public {
        uint256 t0 = block.timestamp;
        vm.expectRevert(GamePot.TooEarly.selector);
        pot.rollWindow();
        (uint256 w, uint256 end) = pot.latestClosedWindow();
        assertEq(w, 0, "nothing closed yet");
        vm.warp(t0 + 24 hours - 1);
        vm.expectRevert(GamePot.TooEarly.selector);
        pot.rollWindow();
        vm.warp(t0 + 24 hours);
        (w, end) = pot.latestClosedWindow();
        assertEq(w, 1, "closed at its end, before any roll");
        assertEq(end, t0 + 24 hours);
        vm.warp(t0 + 30 hours); // a late roll still starts at the previous end
        vm.expectEmit(address(pot));
        emit GamePot.WindowRolled(2, t0 + 24 hours, t0 + 48 hours);
        pot.rollWindow();
        assertEq(pot.windowId(), 2);
        assertEq(pot.windowStart(), t0 + 24 hours);
        assertEq(pot.windowEnd(), t0 + 48 hours);
        (w, end) = pot.latestClosedWindow();
        assertEq(w, 1);
        assertEq(end, t0 + 24 hours);
        vm.expectRevert(GamePot.TooEarly.selector);
        pot.rollWindow();
    }

    /// After an outage each roll opens one window from the previous end; a closed window past LIST_GRACE or older than
    /// the latest closed one can't be listed; the pot carries over to the window that is drawn.
    function test_skippedWindows_outage() public {
        _list3();
        _fundPot(2 ether);
        pot.sync();
        uint256 jp = pot.jackpotPot();
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 5 days);
        Post memory s = _good();
        assertEq(s.w, 1);
        _send(s, GamePot.BadWindow.selector); // window 1 ended 4 d ago: past LIST_GRACE
        for (uint256 k = 2; k <= 4; ++k) {
            uint256 prevEnd = pot.windowEnd();
            pot.rollWindow();
            assertEq(pot.windowId(), k);
            assertEq(pot.windowStart(), prevEnd, "starts at the previous end");
            assertEq(pot.windowEnd(), prevEnd + 24 hours);
        }
        // window 4 = [t0 + 3 d, t0 + 4 d): latest closed, its grace ends exactly now
        s = _good();
        assertEq(s.w, 4);
        s.w = 3;
        _send(s, GamePot.BadWindow.selector); // an older closed window: never
        uint256 snap = vm.snapshotState();
        s.w = 4;
        _send(s, 0); // end + LIST_GRACE == now: still in time
        vm.revertToState(snap);
        pot.rollWindow(); // window 5 = [t0 + 4 d, t0 + 5 d): closed now too
        s.w = 4;
        _send(s, GamePot.BadWindow.selector); // no longer the latest closed window
        s.w = 5;
        _send(s, 0);
        vm.warp(block.timestamp + 1 hours);
        pot.requestDraw();
        assertEq(_draw().prize, jp - pot.SUB_MIN(), "the pot carried over through four skipped windows");
        _fulfil(3);
        _settle();
        assertEq(pot.lastDrawnWindow(), 5);
        assertEq(pot.drawCount(), 0, "window 5 paid out (pushed)");
    }

    /// An interval change only affects windows not yet started: never the open window's end, and once that window
    /// has ended it must be rolled first (RollFirst).
    function test_drawInterval_onlyFutureWindows() public {
        uint256 t0 = block.timestamp;
        vm.prank(safe);
        pot.proposeDrawInterval(3 days);
        vm.warp(t0 + 1 hours);
        pot.executeDrawInterval();
        assertEq(pot.drawInterval(), 3 days);
        assertEq(pot.windowEnd(), t0 + 24 hours, "the open window keeps its end");
        vm.warp(t0 + 24 hours);
        pot.rollWindow();
        assertEq(pot.windowEnd(), t0 + 24 hours + 3 days, "the next window takes the new interval");
        vm.prank(safe);
        pot.proposeDrawInterval(1 days);
        vm.warp(pot.windowEnd()); // window 2 ended, window 3 not opened yet
        vm.expectRevert(GamePot.RollFirst.selector);
        pot.executeDrawInterval();
        pot.rollWindow(); // window 3 opens with 3 d
        pot.executeDrawInterval();
        assertEq(pot.windowEnd(), t0 + 24 hours + 6 days, "window 3 keeps 3 d");
        vm.warp(pot.windowEnd());
        pot.rollWindow();
        assertEq(pot.windowEnd() - pot.windowStart(), 1 days, "window 4 takes 1 d");
    }

    // ---------- postList ----------

    function test_postList_ok_event() public {
        _list3();
        _close();
        Post memory s = _good();
        vm.expectEmit(address(pot));
        emit GamePot.ListPosted(
            1, 100, 1_000 ether, s.root, 15, 3, "ipfs://list", keccak256("list"), block.timestamp + 1 hours
        );
        _send(s, 0);
        GamePot.Draw memory d = _draw();
        assertEq(d.window, 1);
        assertEq(d.eta, block.timestamp + 1 hours);
        assertEq(d.root, s.root);
        assertEq(d.totalTickets, 15);
        assertEq(d.reqId + d.prize + d.fulfilledAt, 0);
    }

    /// Every binding check rejects on its own.
    function test_postList_binding() public {
        _list3();
        _close();
        Post memory s = _good();
        s.root = 0;
        _send(s, GamePot.BadList.selector);
        s = _good();
        s.total = 0;
        _send(s, GamePot.BadList.selector);
        s = _good();
        s.holders = 0;
        _send(s, GamePot.BadList.selector);
        s = _good();
        s.holders = 2; // last index 2 != holders - 1
        _send(s, GamePot.BadList.selector);
        s = _good();
        s.holders = 4;
        _send(s, GamePot.BadList.selector);
        s = _good();
        s.total = 16; // cumStart + tickets != total
        _send(s, GamePot.BadList.selector);
        s = _good();
        s.total = 14;
        _send(s, GamePot.BadList.selector);
        s = _good();
        s.proof[0] = keccak256("not a sibling");
        _send(s, GamePot.BadList.selector);
        s = _good();
        s.proof = new bytes32[](0);
        _send(s, GamePot.BadList.selector);
        _send(_good(), 0);
    }

    /// A last leaf with no tickets is refused (it would end the list at its own start).
    function test_postList_lastLeafHasTickets() public {
        address[] memory a = new address[](3);
        uint256[] memory t = new uint256[](3);
        (a[0], a[1], a[2]) = (alice, bob, carol);
        (t[0], t[1], t[2]) = (5, 3, 0);
        _setList(a, t);
        _close();
        _send(_good(), GamePot.BadList.selector);
    }

    /// What the chain can't check: OZ MerkleProof.verify is position-free, so `holders` is not bound to the root's leaf
    /// count. A 4-leaf root posted as a 2-holder list (leaf 1 as the "last", the total where it ends) is accepted here;
    /// the defence is the watchdog's full rebuild (holders, Σ, root) and the Safe's 1 h cancelList (SPEC §13).
    function test_postList_shortenedListIsTheWatchdogsJob() public {
        address[] memory a = new address[](4);
        uint256[] memory t = new uint256[](4);
        (a[0], a[1], a[2], a[3]) = (alice, bob, carol, makeAddr("dave"));
        (t[0], t[1], t[2], t[3]) = (5, 3, 7, 2);
        _setList(a, t);
        _close();
        Post memory s = _good();
        (s.root, s.proof) = _proof(1);
        (s.holders, s.last, s.total) = (2, leaves[1], 8);
        _send(s, 0);
        vm.prank(safe);
        pot.cancelList(s.w); // the veto
        assertEq(_draw().window, 0);
    }

    /// The last-leaf binding: the posted total must be where the root's leaf `holders - 1` really ends. A root whose
    /// last leaf ends at 15 can't carry total 16 or 14, and a forged last leaf that would end there fails its proof.
    function test_postList_rootBindsTotal() public {
        _list3(); // the real last leaf: (2, carol, 8, 7) → 15
        _close();
        Post memory s = _good();
        s.total = 16; // the real last leaf, a total it doesn't end at
        _send(s, GamePot.BadList.selector);
        s.total = 14;
        _send(s, GamePot.BadList.selector);
        s = _good();
        s.total = 16;
        s.last.tickets = 8; // a forged last leaf ending at 16
        _send(s, GamePot.BadList.selector);
        s = _good();
        s.total = 14;
        s.last.cumStart = 7; // ending at 14
        _send(s, GamePot.BadList.selector);
        s = _good();
        s.total = 8;
        s.last = leaves[1]; // a real leaf, but not leaf holders - 1
        _send(s, GamePot.BadList.selector);
        s = _good();
        s.total = 1e30;
        s.last.tickets = 1e30 - 8;
        _send(s, GamePot.BadList.selector);
        _send(_good(), 0);
        assertEq(_draw().totalTickets, 15);
    }

    function test_postList_paramBounds() public {
        _list3();
        _close();
        Post memory s = _good();
        uint256[4] memory badCap = [uint256(0), 49, 201, 10_000];
        for (uint256 i; i < 4; ++i) {
            s.params.capBps = badCap[i];
            _send(s, GamePot.BadParams.selector);
        }
        s = _good();
        uint256[3] memory badMin = [uint256(0), 100 ether - 1, 1_000_000 ether + 1];
        for (uint256 i; i < 3; ++i) {
            s.params.minBalance = badMin[i];
            _send(s, GamePot.BadParams.selector);
        }
        uint256[2] memory cap = [uint256(50), 200];
        uint256[2] memory minB = [uint256(100 ether), 1_000_000 ether];
        for (uint256 i; i < 2; ++i) {
            uint256 snap = vm.snapshotState();
            s.params = GamePot.Params(cap[i], minB[i]);
            _send(s, 0); // both edges are in bounds
            vm.revertToState(snap);
        }
    }

    function test_postList_auth() public {
        _list3();
        _close();
        Post memory s = _good();
        s.who = alice;
        _send(s, GamePot.Unauthorized.selector);
        s.who = anchor;
        _send(s, GamePot.Unauthorized.selector);
        s.who = agent;
        reg.setPaused(true);
        _send(s, GamePot.Unauthorized.selector);
        reg.setPaused(false);
        reg.setLevel(4);
        _send(s, GamePot.Unauthorized.selector);
        uint256 snap = vm.snapshotState();
        s.who = safe; // the Safe needs no level
        _send(s, 0);
        vm.revertToState(snap);
        reg.setLevel(5);
        _send(s, 0);
    }

    function test_postList_windowRules() public {
        _list3();
        Post memory s = _good();
        assertEq(s.w, 0);
        _send(s, GamePot.BadWindow.selector); // window 1 still open: nothing closed
        s.w = 1;
        _send(s, GamePot.BadWindow.selector);
        uint256 end = pot.windowEnd();
        vm.warp(end);
        s.w = 2;
        _send(s, GamePot.BadWindow.selector); // not closed (not even opened)
        vm.warp(end + 24 hours + 1);
        s.w = 1;
        _send(s, GamePot.BadWindow.selector); // past LIST_GRACE
        uint256 snap = vm.snapshotState();
        vm.warp(end + 24 hours);
        _send(s, 0); // the grace's last second
        vm.revertToState(snap);
        vm.warp(end);
        _send(s, 0);
        _send(s, GamePot.ListPending.selector); // same window again: only after the Safe's cancel
        vm.prank(safe);
        pot.cancelList(1);
        _send(s, 0);
        vm.warp(block.timestamp + 1 hours);
        _fundPot(2 ether);
        pot.requestDraw();
        _send(s, GamePot.InFlight.selector); // requested
        _fulfil(0);
        _send(s, GamePot.InFlight.selector); // fulfilled
        _settle();
        _send(s, GamePot.BadWindow.selector); // drawn: w <= lastDrawnWindow
        _close(); // window 2 closes
        _send(_good(), 0);
    }

    /// A newer window's list replaces one that was never requested (that window is skipped); the older one is gone.
    function test_postList_newerWindowReplacesUnrequested() public {
        _list3();
        _close();
        _post();
        bytes32 root1 = _draw().root;
        _list1(alice);
        _close(); // window 2
        uint256 w = _post();
        assertEq(w, 2);
        GamePot.Draw memory d = _draw();
        assertEq(d.window, 2);
        assertTrue(d.root != root1);
        assertEq(d.totalTickets, 1);
        Post memory s = _good();
        s.w = 1;
        _send(s, GamePot.BadWindow.selector);
    }

    // ---------- cancelList (the Safe's veto) ----------

    function test_cancelList() public {
        vm.prank(safe);
        vm.expectRevert(GamePot.NoList.selector);
        pot.cancelList(1);
        _ready(2 ether);
        vm.prank(alice);
        vm.expectRevert(GamePot.Unauthorized.selector);
        pot.cancelList(1);
        vm.prank(agent);
        vm.expectRevert(GamePot.Unauthorized.selector);
        pot.cancelList(1);
        vm.prank(safe);
        vm.expectRevert(GamePot.NoList.selector);
        pot.cancelList(2);
        uint256 snap = vm.snapshotState();
        vm.expectEmit(address(pot));
        emit GamePot.ListCancelled(1);
        vm.prank(safe);
        pot.cancelList(1);
        assertEq(_draw().window, 0);
        vm.expectRevert(GamePot.NoList.selector);
        pot.requestDraw();
        vm.revertToState(snap);
        pot.requestDraw();
        vm.prank(safe);
        vm.expectRevert(GamePot.InFlight.selector); // not after requestDraw
        pot.cancelList(1);
        vm.warp(block.timestamp + 36 hours);
        pot.abortDraw();
        vm.prank(safe);
        pot.cancelList(1); // after an abort the list is vetoable again
        vm.expectRevert(GamePot.NoList.selector);
        pot.requestDraw();
    }

    function test_cancelList_notAfterFulfilment() public {
        _ready(2 ether);
        pot.requestDraw();
        _fulfil(1);
        vm.prank(safe);
        vm.expectRevert(GamePot.InFlight.selector);
        pot.cancelList(1);
    }

    // ---------- requestDraw ----------

    function test_request_guards() public {
        vm.expectRevert(GamePot.NoList.selector);
        pot.requestDraw();
        _list3();
        _close();
        _post();
        vm.expectRevert(GamePot.TooEarly.selector);
        pot.requestDraw();
        vm.warp(block.timestamp + 1 hours - 1);
        vm.expectRevert(GamePot.TooEarly.selector);
        pot.requestDraw();
        vm.warp(block.timestamp + 1);
        vm.expectRevert(GamePot.PrizeTooSmall.selector);
        pot.requestDraw();
        _fundPot(0.15 ether); // jackpot 0.105 < SUB_MIN + MIN_PRIZE: the pot accrues first
        vm.expectRevert(GamePot.PrizeTooSmall.selector);
        pot.requestDraw();
        _fundPot(1 ether);
        vm.fee(2_000 gwei); // cost 1.364 ETH > 20% of the prize
        vm.expectRevert(GamePot.GasTooHigh.selector);
        pot.requestDraw();
        vm.fee(1 gwei);
        pot.requestDraw();
        vm.expectRevert(GamePot.InFlight.selector);
        pot.requestDraw();
        _fulfil(1);
        vm.expectRevert(GamePot.InFlight.selector);
        pot.requestDraw();
    }

    function test_draw_fullCycle() public {
        _ready(2 ether); // jackpot 1.4
        uint256 prize = 1.4 ether - 0.1364 ether; // prize = min(pot - top-up, cap)
        vm.expectEmit(address(pot));
        emit GamePot.DrawRequested(1000, 1, 15, prize, 0.1364 ether);
        uint256 reqId = pot.requestDraw();
        GamePot.Draw memory d = _draw();
        assertEq(d.reqId, reqId);
        assertEq(d.requestedAt, block.timestamp);
        assertEq(d.prize, prize);
        assertEq(pot.jackpotPot(), 0, "all of the pot");
        (, uint96 subBal,,,) = coord.getSubscription(pot.subId());
        assertEq(subBal, pot.SUB_MIN(), "topped up to SUB_MIN");

        uint256 word = 12345;
        vm.expectEmit(address(pot));
        emit GamePot.DrawFulfilled(reqId, 1, word);
        coord.fulfill(reqId, word);
        assertTrue(coord.lastSuccess());
        d = _draw();
        assertEq(d.rand, word);
        assertEq(d.fulfilledAt, block.timestamp);
        assertEq(pot.drawCount(), 0, "the callback never settles");

        (GamePot.Leaf[] memory ls, bytes32[][] memory ps, address[] memory w) = _walk();
        assertEq(w.length, 3, "a 3-account list pays its 3 accounts");
        assertEq(ls.length, 32, "it walked every ticket looking for 10 distinct accounts");
        uint256 share = prize / 10;
        uint256[3] memory b0 = [alice.balance, bob.balance, carol.balance];
        vm.expectEmit(address(pot));
        emit GamePot.Drawn(1, word, prize, share, 3, 32);
        vm.recordLogs();
        vm.prank(makeAddr("keeper"));
        pot.settle(ls, ps);
        _checkDrawnFirst(3);
        assertEq(alice.balance - b0[0], share, "an EOA winner is paid in the settle");
        assertEq(bob.balance - b0[1], share);
        assertEq(carol.balance - b0[2], share);
        assertEq(pot.jackpotPot(), prize - 3 * share, "7 unfilled ranks + the dust back to the pot");
        assertEq(pot.owedTotal(), 0);
        assertEq(pot.drawCount(), 0, "no claim record for a pushed share");
        assertEq(pot.lastDrawnWindow(), 1);
        assertEq(_draw().window, 0, "draw closed");
        assertEq(address(pot).balance, 0);
        assertEq(_claims(address(pot)), _liabilities());
    }

    /// Drawn is logged before any Winner (the draw's record never depends on a receiver), then one Winner per rank.
    function _checkDrawnFirst(uint256 winners) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 drawn = keccak256("Drawn(uint256,uint256,uint256,uint256,uint256,uint256)");
        bytes32 winner = keccak256("Winner(uint256,uint256,address,uint256,uint256)");
        (bool seenDrawn, uint256 nWinner) = (false, 0);
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(pot)) continue;
            if (logs[i].topics[0] == drawn) seenDrawn = true;
            if (logs[i].topics[0] == winner) {
                assertTrue(seenDrawn, "Winner before Drawn");
                ++nWinner;
            }
        }
        assertTrue(seenDrawn);
        assertEq(nWinner, winners);
    }

    function test_draw_secondDrawNeedsNoTopUpAndCapsPrize() public {
        _ready(10 ether); // jackpot 7
        pot.requestDraw();
        assertEq(_draw().prize, 3 ether, "PRIZE_CAP");
        _fulfil(0);
        _settle();
        _ready(0.01 ether);
        pot.sync();
        uint256 jp = pot.jackpotPot();
        pot.requestDraw(); // sub has SUB_MIN - fee: tops up only the fee
        assertEq(jp - pot.jackpotPot(), 3 ether + coord.fee());
        assertEq(_draw().window, 2);
    }

    /// The VRF gas gate is exact at the 20% boundary.
    function testFuzz_gasGate(uint256 basefee) public {
        _ready(2 ether);
        basefee = bound(basefee, 0, 5_000 gwei);
        vm.fee(basefee);
        uint256 prize = 1.4 ether - 0.1364 ether; // after the SUB_MIN top-up
        bool ok = basefee * 550_000 * 124 / 100 * 10_000 <= prize * 2000;
        if (!ok) vm.expectRevert(GamePot.GasTooHigh.selector);
        pot.requestDraw();
    }

    // ---------- callback ----------

    function test_callback_onlyCoordinator_staleIgnored() public {
        _ready(2 ether);
        uint256 r = pot.requestDraw();
        vm.expectRevert(GamePot.OnlyCoordinator.selector);
        pot.rawFulfillRandomWords(r, _one(5));
        coord.deliver(address(pot), r + 1, 5); // unknown id: ignored, no revert
        assertEq(_draw().fulfilledAt, 0);
        _fulfil(5);
        coord.deliver(address(pot), r, 9); // repeated: ignored
        assertEq(_draw().rand, 5);
    }

    // ---------- settle ----------

    function test_settle_guards() public {
        GamePot.Leaf[] memory none = new GamePot.Leaf[](0);
        bytes32[][] memory nop = new bytes32[][](0);
        vm.expectRevert(GamePot.NotFulfilled.selector);
        pot.settle(none, nop);
        _ready(2 ether);
        vm.expectRevert(GamePot.NotFulfilled.selector); // posted
        pot.settle(none, nop);
        pot.requestDraw();
        vm.expectRevert(GamePot.NotFulfilled.selector); // requested
        pot.settle(none, nop);
        _fulfil(5);
        (GamePot.Leaf[] memory ls, bytes32[][] memory ps,) = _walk();
        assertEq(ls.length, 32);
        vm.expectRevert(GamePot.BadList.selector); // empty
        pot.settle(none, nop);
        (GamePot.Leaf[] memory l2, bytes32[][] memory p2) = _slice(ls, ps, 31);
        vm.expectRevert(GamePot.BadList.selector); // lengths differ
        pot.settle(ls, p2);
        vm.expectRevert(GamePot.BadList.selector); // one leaf short: the walk needs ticket 31's leaf
        pot.settle(l2, p2);
        (l2, p2) = _slice(ls, ps, 33);
        vm.expectRevert(GamePot.BadList.selector); // one extra: more than MAX_TICKETS
        pot.settle(l2, p2);
        (l2, p2) = _slice(ls, ps, 32);
        uint256 x = 1;
        while (l2[x].index == l2[0].index) ++x;
        (l2[0], l2[x], p2[0], p2[x]) = (l2[x], l2[0], p2[x], p2[0]);
        vm.expectRevert(GamePot.NotWinningLeaf.selector); // reordered: ticket 0's leaf is not first
        pot.settle(l2, p2);
        (l2, p2) = _slice(ls, ps, 32);
        l2[3].tickets += 1; // a forged range
        vm.expectRevert(GamePot.BadProof.selector);
        pot.settle(l2, p2);
        (l2, p2) = _slice(ls, ps, 32);
        p2[3] = _proofOf((l2[3].index + 1) % 3); // another leaf's proof
        vm.expectRevert(GamePot.BadProof.selector);
        pot.settle(l2, p2);
        pot.settle(ls, ps); // the exact walk settles
        vm.expectRevert(GamePot.NotFulfilled.selector); // settled once: the draw is closed
        pot.settle(ls, ps);
    }

    /// Range edges: a ticket equal to a leaf's cumStart and its last ticket both belong to it; the next ticket doesn't.
    function test_settle_rangeEdges() public {
        _ready(2 ether);
        pot.requestDraw();
        uint256 snap = vm.snapshotState();
        uint256[3] memory t0 = [uint256(5), 7, 8]; // bob's first, bob's last, carol's first
        address[3] memory who = [bob, bob, carol];
        for (uint256 c; c < 3; ++c) {
            _fulfil(_wordFor(t0[c]));
            (GamePot.Leaf[] memory ls, bytes32[][] memory ps, address[] memory w) = _walk();
            assertEq(w[0], who[c]);
            for (uint256 i; i < 3; ++i) {
                if (leaves[i].account == who[c]) continue;
                (GamePot.Leaf[] memory l2, bytes32[][] memory p2) = _slice(ls, ps, ls.length);
                (l2[0], p2[0]) = (leaves[i], _proofOf(i));
                vm.expectRevert(GamePot.NotWinningLeaf.selector);
                pot.settle(l2, p2);
            }
            pot.settle(ls, ps);
            vm.revertToState(snap);
        }
    }

    /// Every member of the on-chain exclusion set wins nothing: its tickets are skipped (WinnerExcluded) and its share
    /// returns to the pot.
    function test_settle_excludedWinners() public {
        address[13] memory ex = [
            safe,
            agent,
            anchor,
            team, // vault.excluded
            address(manager),
            address(hook),
            address(fv),
            bb,
            lv,
            address(vault),
            address(pot),
            address(0),
            DEAD
        ];
        assertFalse(pot.isExcluded(alice));
        for (uint256 i; i < ex.length; ++i) {
            assertTrue(pot.isExcluded(ex[i]));
            uint256 snap = vm.snapshotState();
            _list1(ex[i]);
            _ready(2 ether);
            pot.requestDraw();
            uint256 jp = pot.jackpotPot();
            uint256 prize = _draw().prize;
            uint256 bal = ex[i].balance;
            _fulfil(0);
            (GamePot.Leaf[] memory ls, bytes32[][] memory ps, address[] memory w) = _walk();
            assertEq(w.length, 0);
            vm.expectEmit(address(pot));
            emit GamePot.WinnerExcluded(1, ex[i], 0);
            pot.settle(ls, ps);
            assertEq(pot.jackpotPot(), jp + prize, "escrow back to the pot");
            assertEq(pot.drawCount(), 0);
            assertEq(pot.owedTotal(), 0);
            assertEq(pot.lastDrawnWindow(), 1);
            assertEq(ex[i].balance, bal);
            assertEq(_claims(address(pot)), _liabilities());
            vm.revertToState(snap);
        }
    }

    /// An excluded account among holders: skipped (WinnerExcluded), the others are paid, its share returns to the pot.
    function test_settle_excludedAmongHolders() public {
        address[] memory a = new address[](3);
        uint256[] memory t = new uint256[](3);
        (a[0], a[1], a[2]) = (alice, safe, carol);
        (t[0], t[1], t[2]) = (5, 3, 7);
        _setList(a, t);
        _ready(2 ether);
        pot.requestDraw();
        uint256 prize = _draw().prize;
        _fulfil(_wordFor(5)); // the first ticket is the Safe's
        (GamePot.Leaf[] memory ls, bytes32[][] memory ps, address[] memory w) = _walk();
        assertEq(w.length, 2);
        uint256 s0 = safe.balance;
        vm.expectEmit(address(pot));
        emit GamePot.WinnerExcluded(1, safe, 0);
        pot.settle(ls, ps);
        assertEq(safe.balance, s0, "never paid");
        assertEq(pot.jackpotPot(), prize - 2 * (prize / 10));
    }

    /// Fewer than 10 accounts (not an on-chain rule): each is paid once; the unfilled ranks return to the pot.
    function test_settle_fewerThanTenAccounts() public {
        address[] memory a = new address[](4);
        uint256[] memory t = new uint256[](4);
        for (uint256 i; i < 4; ++i) {
            (a[i], t[i]) = (address(uint160(0xA000 + i)), 10 + i);
        }
        _setList(a, t);
        _ready(2 ether);
        pot.requestDraw();
        uint256 prize = _draw().prize;
        _fulfil(77);
        (GamePot.Leaf[] memory ls,, address[] memory w) = _walk();
        assertEq(w.length, 4);
        assertEq(ls.length, 32, "MAX_TICKETS tickets walked");
        _settle();
        for (uint256 i; i < 4; ++i) {
            assertEq(a[i].balance, prize / 10, "each account once");
        }
        assertEq(pot.jackpotPot(), prize - 4 * (prize / 10));
    }

    /// Ten winners from a list with a dominant account (40% of tickets): every account is paid at most once.
    function test_settle_tenDistinctWinners() public {
        address[] memory a = new address[](14);
        uint256[] memory t = new uint256[](14);
        for (uint256 i; i < 14; ++i) {
            (a[i], t[i]) = (address(uint160(0xB000 + i)), i == 0 ? 40 : 5);
        }
        _setList(a, t); // 40 + 13 × 5 = 105 tickets
        _ready(2 ether);
        pot.requestDraw();
        uint256 share = _draw().prize / 10;
        _fulfil(424242);
        (GamePot.Leaf[] memory ls,, address[] memory w) = _walk();
        assertEq(w.length, 10);
        assertGt(ls.length, 10, "at least one duplicate ticket skipped");
        _settle();
        uint256 paid;
        for (uint256 i; i < 14; ++i) {
            assertTrue(a[i].balance == 0 || a[i].balance == share, "one share at most");
            if (a[i].balance == share) ++paid;
        }
        assertEq(paid, 10);
    }

    // ---------- push payout ----------

    function test_push_revertingReceiver_claimable() public {
        Reverter rev = new Reverter();
        _list1(address(rev));
        _ready(2 ether);
        pot.requestDraw();
        uint256 share = _draw().prize / 10;
        _fulfil(0);
        vm.expectEmit(address(pot));
        emit GamePot.Winner(1, 0, address(rev), share, 1);
        _settle();
        PrizeView memory z = _prize(1);
        assertEq(z.winner, address(rev));
        assertEq(z.amount, share);
        assertFalse(z.claimed);
        assertEq(pot.owedTotal(), share, "stays owed");
        assertEq(address(pot).balance, 0, "the share went back to claims");
        assertEq(_claims(address(pot)), _liabilities(), "exact: no 70/30 double count");
        uint256 held = pot.jackpotPot() + pot.ideaReserve();
        pot.sync();
        assertEq(pot.jackpotPot() + pot.ideaReserve(), held, "sync finds no arrival");
        vm.prank(bob);
        vm.expectRevert(GamePot.NotWinner.selector);
        pot.claim(_one(1), bob);
        address cold = makeAddr("cold");
        rev.claim(pot, 1, cold);
        assertEq(cold.balance, share);
        assertEq(pot.owedTotal(), 0);
        vm.expectRevert(GamePot.AlreadyClaimed.selector);
        rev.claim(pot, 1, cold);
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(GamePot.AlreadyClaimed.selector);
        pot.expireClaim(1);
    }

    function test_push_gasBurner_expires() public {
        GasBurner g = new GasBurner();
        (uint256 id, uint256 prize) = _drawTo(address(g));
        assertLt(lastSettleGas, 700_000, "the burner gets PUSH_GAS, no more (32-ticket walk included)");
        assertFalse(_prize(id).claimed);
        assertEq(pot.owedTotal(), prize);
        assertEq(_claims(address(pot)), _liabilities());
        vm.warp(block.timestamp + 7 days - 1);
        vm.expectRevert(GamePot.TooEarly.selector);
        pot.expireClaim(id);
        vm.warp(block.timestamp + 1);
        uint256 jp = pot.jackpotPot();
        pot.expireClaim(id);
        assertEq(pot.jackpotPot(), jp + prize);
        assertEq(pot.owedTotal(), 0);
        assertEq(_claims(address(pot)), _liabilities());
    }

    /// Returndata is never copied: a receiver returning ~100 KB costs the settler no more than PUSH_GAS over a silent
    /// receiver; one trying 1 MB runs out of its own gas and the share stays claimable.
    function test_push_returndataBomb() public {
        uint256 snap = vm.snapshotState();
        (uint256 id0,) = _drawTo(address(new Sink()));
        uint256 sinkGas = lastSettleGas;
        assertEq(id0, 0, "pushed: no claim record");
        vm.revertToState(snap);
        snap = vm.snapshotState();
        ReturnBomb small = new ReturnBomb(100_000);
        (uint256 id1, uint256 share) = _drawTo(address(small));
        uint256 bombGas = lastSettleGas;
        assertEq(id1, 0, "100 KB fits its gas: pushed");
        assertEq(address(small).balance, share);
        console.log("settle gas: silent receiver / 100 KB returndata", sinkGas, bombGas);
        assertLt(bombGas, sinkGas + pot.PUSH_GAS(), "no returndata copy");
        vm.revertToState(snap);
        ReturnBomb big = new ReturnBomb(1_000_000);
        (uint256 id, uint256 share2) = _drawTo(address(big));
        assertFalse(_prize(id).claimed);
        assertEq(pot.owedTotal(), share2);
        assertEq(_claims(address(pot)), _liabilities());
    }

    /// A reentrant receiver sees the draw closed (Drawn emitted, escrow out) and every money path is locked.
    function test_push_reentrantReceiver_swallowed() public {
        Reenter r = new Reenter(pot, false);
        _list1(address(r));
        _ready(2 ether);
        pot.requestDraw();
        uint256 share = _draw().prize / 10;
        _fulfil(0);
        vm.recordLogs();
        _settle();
        _checkReentry(address(r));
        assertEq(pot.drawCount(), 0, "the receiver swallowed the reverts: pushed");
        assertEq(address(r).balance, share, "paid once");
        assertEq(pot.owedTotal(), 0);
        assertEq(_claims(address(pot)) + address(pot).balance, _liabilities());
    }

    function test_push_reentrantReceiver_bubbles() public {
        Reenter r = new Reenter(pot, true);
        (uint256 id, uint256 prize) = _drawTo(address(r));
        assertFalse(_prize(id).claimed);
        assertEq(address(r).balance, 0);
        assertEq(pot.owedTotal(), prize);
        assertEq(_claims(address(pot)), _liabilities());
        address cold = makeAddr("cold");
        vm.prank(address(r));
        pot.claim(_one(id), cold);
        assertEq(cold.balance, prize);
        assertEq(pot.owedTotal(), 0);
    }

    function _checkReentry(address r) internal {
        bytes32 seen = keccak256("Seen(uint256,uint256,uint256,address,bool)");
        bytes32 blocked = keccak256("Blocked(bytes4)");
        uint256 nSeen;
        uint256 nBlocked;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != r) continue;
            if (logs[i].topics[0] == seen) {
                (uint256 owed,, uint256 win,,) = abi.decode(logs[i].data, (uint256, uint256, uint256, address, bool));
                assertEq(owed, 0, "nothing owed before a push fails");
                assertEq(win, 0, "draw closed before the push");
                ++nSeen;
            } else if (logs[i].topics[0] == blocked) {
                assertEq(
                    bytes4(abi.decode(logs[i].data, (bytes4))),
                    ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector
                );
                ++nBlocked;
            }
        }
        assertEq(nSeen, 1);
        assertEq(nBlocked, 6, "claim, settle, sync, requestDraw, expireClaim, payReward");
    }

    /// A 10-account draw (one ticket each) where the gas-picky receiver has `rank` and reverting receivers hold every
    /// rank before it. The ranks follow from the ranges alone: ticketAt(31337, j, 10) names leaf indices in order.
    function _pickyDraw(uint256 rank) internal returns (bytes memory data, GasPicky g) {
        uint256[] memory order = new uint256[](10); // rank → leaf index
        bool[10] memory seen;
        uint256 n;
        for (uint256 j; n < 10; ++j) {
            uint256 idx = pot.ticketAt(31337, j, 10);
            if (!seen[idx]) (seen[idx], order[n++]) = (true, idx);
        }
        address[] memory a = new address[](10);
        uint256[] memory t = new uint256[](10);
        g = new GasPicky();
        for (uint256 r; r < 10; ++r) {
            a[order[r]] = r == rank ? address(g) : r < rank ? address(new Reverter()) : address(uint160(0xD000 + r));
            t[order[r]] = 1;
        }
        _setList(a, t);
        _ready(2 ether);
        pot.requestDraw();
        _fulfil(31337);
        (GamePot.Leaf[] memory ls, bytes32[][] memory ps, address[] memory w) = _walk();
        assertEq(w[rank], address(g));
        data = abi.encodeCall(GamePot.settle, (ls, ps));
    }

    /// A settler can't starve any push into the claim path: at any gas limit, settle either reverts (LowGas or out of
    /// gas) or pays the gas-picky receiver in full, whatever its rank and with failing receivers before it.
    /// forge-config: default.fuzz.runs = 20
    function testFuzz_push_lowGasCantForceClaimPath(uint256 rankRaw) public {
        uint256 rank = bound(rankRaw, 0, 9);
        (bytes memory data, GasPicky g) = _pickyDraw(rank);
        bool sawOk;
        bool sawLowGas;
        for (uint256 gas = 300_000; gas <= 1_600_000; gas += 5_000) {
            uint256 snap = vm.snapshotState();
            (bool ok, bytes memory ret) = address(pot).call{gas: gas}(data);
            if (ok) {
                sawOk = true;
                _checkPicky(address(g), rank);
            } else if (ret.length >= 4 && bytes4(ret) == GamePot.LowGas.selector) {
                sawLowGas = true;
            }
            vm.revertToState(snap);
        }
        assertTrue(sawOk, "ok");
        assertTrue(sawLowGas, "LowGas");
    }

    function _checkPicky(address g, uint256 rank) internal view {
        assertGt(g.balance, 0, "the gas-picky receiver was paid");
        for (uint256 k = 1; k <= pot.drawCount(); ++k) {
            assertTrue(_prize(k).winner != g, "never pushed into a claim by gas");
        }
        assertEq(pot.drawCount(), rank, "only the reverting receivers before it are owed");
    }

    // ---------- void / abort / stall / rescue ----------

    function test_voidDraw_timing() public {
        vm.expectRevert(GamePot.NotFulfilled.selector);
        pot.voidDraw();
        _ready(2 ether);
        pot.requestDraw();
        vm.expectRevert(GamePot.NotFulfilled.selector);
        pot.voidDraw();
        _fulfil(0);
        uint256 t = block.timestamp;
        uint256 prize = _draw().prize;
        vm.warp(t + 7 days - 1);
        vm.expectRevert(GamePot.TooEarly.selector);
        pot.voidDraw();
        vm.warp(t + 7 days);
        uint256 jp = pot.jackpotPot();
        vm.expectEmit(address(pot));
        emit GamePot.DrawVoided(1, prize);
        pot.voidDraw();
        assertEq(pot.jackpotPot(), jp + prize);
        assertEq(pot.lastDrawnWindow(), 1);
        assertEq(_draw().window, 0);
        assertEq(pot.drawCount(), 0);
        vm.expectRevert(GamePot.NotFulfilled.selector);
        pot.settle(new GamePot.Leaf[](0), new bytes32[][](0));
        vm.expectRevert(GamePot.NotFulfilled.selector);
        pot.voidDraw();
        _close();
        _post(); // a later window lists normally
    }

    /// Abort keeps the list; the next requestDraw re-requests it; a late fulfilment of the aborted request is ignored.
    function test_abort_reRequestsSameList() public {
        _ready(2 ether);
        uint256 r1 = pot.requestDraw();
        GamePot.Draw memory d0 = _draw();
        vm.warp(block.timestamp + 36 hours - 1);
        vm.expectRevert(GamePot.TooEarly.selector);
        pot.abortDraw();
        vm.warp(block.timestamp + 1);
        vm.expectEmit(address(pot));
        emit GamePot.DrawAborted(r1, d0.prize);
        pot.abortDraw();
        assertEq(pot.jackpotPot(), d0.prize, "escrow back");
        GamePot.Draw memory d = _draw();
        assertEq(d.window, 1);
        assertEq(d.root, d0.root);
        assertEq(d.totalTickets, 15);
        assertEq(d.reqId + d.prize + d.requestedAt, 0);
        vm.expectRevert(GamePot.NotInFlight.selector);
        pot.abortDraw();
        _fulfil_raw(r1, 3); // late: ignored
        assertEq(_draw().fulfilledAt, 0);
        uint256 r2 = pot.requestDraw(); // same list
        assertTrue(r2 != r1);
        d = _draw();
        assertEq(d.root, d0.root);
        assertEq(d.window, 1);
        coord.deliver(address(pot), r1, 3); // the aborted id again: ignored
        assertEq(_draw().fulfilledAt, 0);
        coord.fulfill(r2, 12);
        assertEq(_settle(), 3, "the re-requested list pays its 3 accounts");
    }

    function _fulfil_raw(uint256 id, uint256 word) internal {
        coord.fulfill(id, word);
        assertTrue(coord.lastSuccess());
    }

    function test_rescue_onlyWhileStuck_abortsInline() public {
        _ready(2 ether);
        vm.expectRevert(GamePot.NotStalled.selector);
        pot.rescueToBuyback();
        pot.requestDraw();
        uint256 prize = _draw().prize;
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 14 days - 1);
        vm.expectRevert(GamePot.NotStalled.selector);
        pot.rescueToBuyback();
        vm.warp(t0 + 14 days);
        uint256 amount = pot.jackpotPot() + pot.ideaReserve() + prize;
        pot.rescueToBuyback(); // stuck for 14 d: aborts inline, escrow included
        assertEq(_claims(bb), amount);
        assertEq(pot.jackpotPot() + pot.ideaReserve(), 0);
        assertEq(_draw().reqId, 0);
        assertEq(_draw().window, 1, "the list stays (abort semantics)");
    }

    /// One abort, then 14 quiet days with no request in flight: a healthy pot is not rescuable.
    function test_rescue_notAfterAbortAndQuietDays() public {
        _ready(2 ether);
        pot.requestDraw();
        vm.warp(block.timestamp + 36 hours);
        pot.abortDraw();
        vm.warp(block.timestamp + 14 days);
        vm.expectRevert(GamePot.NotStalled.selector);
        pot.rescueToBuyback();
    }

    /// Never on a fulfilled draw, however long it stays unsettled.
    function test_rescue_neverAfterFulfilment() public {
        _ready(2 ether);
        pot.requestDraw();
        vm.warp(block.timestamp + 13 days);
        _fulfil(0); // a (late) real fulfilment: VRF is alive
        assertEq(pot.stalledSince(), 0);
        vm.warp(block.timestamp + 6 days);
        vm.expectRevert(GamePot.NotStalled.selector);
        pot.rescueToBuyback();
        _settle();
    }

    // ---------- subscription lifecycle ----------

    function test_recreateSubscription_afterOwnerCancel() public {
        _ready(2 ether);
        pot.requestDraw();
        vm.expectRevert(GamePot.InFlight.selector);
        pot.recreateSubscription();
        _fulfil(0);
        vm.expectRevert(GamePot.InFlight.selector); // fulfilled, not settled
        pot.recreateSubscription();
        _settle();
        uint256 old = pot.subId();
        vm.expectRevert(GamePot.SubscriptionLive.selector);
        pot.recreateSubscription();
        coord.ownerCancel(old); // refund lands in receive()
        assertEq(address(pot).balance, pot.SUB_MIN() - coord.fee());
        pot.recreateSubscription();
        assertTrue(pot.subId() != old);
        pot.sync();
        assertEq(address(pot).balance, 0);
        assertGe(_claims(address(pot)), _liabilities());
        _ready(1 ether);
        pot.requestDraw(); // works on the new sub
    }

    // ---------- claims ----------

    function test_claim_onlyWinner_expire() public {
        Reverter rev = new Reverter();
        (uint256 id, uint256 amount) = _drawTo(address(rev));
        vm.prank(bob);
        vm.expectRevert(GamePot.NotWinner.selector);
        pot.claim(_one(id), bob);
        vm.expectRevert(GamePot.TooEarly.selector);
        pot.expireClaim(id);
        vm.warp(block.timestamp + 7 days - 1);
        vm.expectRevert(GamePot.TooEarly.selector);
        pot.expireClaim(id);
        vm.warp(block.timestamp + 1);
        uint256 jp = pot.jackpotPot();
        vm.expectEmit(address(pot));
        emit GamePot.PrizeExpired(id, amount);
        pot.expireClaim(id);
        assertEq(pot.jackpotPot(), jp + amount);
        assertEq(pot.owedTotal(), 0);
        vm.expectRevert(GamePot.AlreadyClaimed.selector);
        rev.claim(pot, id, alice);
        vm.expectRevert(GamePot.AlreadyClaimed.selector);
        pot.expireClaim(id);
        vm.expectRevert(GamePot.AlreadyClaimed.selector);
        pot.expireClaim(99); // unknown id
    }

    /// Sync, the POT_CAP overflow burn and idea rewards (queue, cancel, pay) never touch the escrow of a draw in flight.
    function test_escrow_untouchedBySyncAndRewards() public {
        _ready(4 ether);
        pot.requestDraw();
        uint256 prize = _draw().prize;
        _fundPot(30 ether);
        pot.sync();
        assertGe(_claims(address(pot)), _liabilities());
        vm.startPrank(safe);
        pot.queueReward(carol, 1 ether, bytes32("a"));
        pot.queueReward(bob, 1 ether, bytes32("b"));
        pot.cancelReward(2);
        vm.stopPrank();
        vm.warp(block.timestamp + 1 hours);
        pot.payReward(1);
        assertEq(carol.balance, 1 ether);
        vm.expectRevert(GamePot.NotStalled.selector); // a healthy flight is never rescued
        pot.rescueToBuyback();
        assertEq(_draw().prize, prize);
        _fulfil(0);
        _settle();
        assertEq(alice.balance, prize / 10, "one share, the escrow untouched");
    }

    // ---------- draw interval ----------

    function test_drawInterval_agentQueueSafeVeto() public {
        vm.prank(alice);
        vm.expectRevert(GamePot.Unauthorized.selector);
        pot.proposeDrawInterval(2 days);
        reg.setLevel(4);
        vm.prank(agent);
        vm.expectRevert(GamePot.Unauthorized.selector);
        pot.proposeDrawInterval(2 days);
        reg.setLevel(5);
        vm.startPrank(agent);
        vm.expectRevert(GamePot.BadInterval.selector);
        pot.proposeDrawInterval(12 hours - 1);
        vm.expectRevert(GamePot.BadInterval.selector);
        pot.proposeDrawInterval(3 days + 1);
        pot.proposeDrawInterval(12 hours);
        vm.expectRevert(GamePot.Pending.selector);
        pot.proposeDrawInterval(2 days);
        vm.stopPrank();
        vm.expectRevert(GamePot.TooEarly.selector);
        pot.executeDrawInterval();
        vm.prank(alice);
        vm.expectRevert(GamePot.Unauthorized.selector);
        pot.cancelDrawInterval();
        vm.prank(safe);
        pot.cancelDrawInterval(); // veto
        vm.prank(agent);
        pot.proposeDrawInterval(3 days);
        vm.warp(block.timestamp + 1 hours);
        reg.setPaused(true); // re-judged at execute
        vm.expectRevert(GamePot.Unauthorized.selector);
        pot.executeDrawInterval();
        reg.setPaused(false);
        pot.executeDrawInterval();
        assertEq(pot.drawInterval(), 3 days);
        vm.prank(safe);
        pot.proposeDrawInterval(12 hours);
        vm.warp(block.timestamp + 1 hours);
        pot.executeDrawInterval();
        assertEq(pot.drawInterval(), 12 hours);
    }

    // ---------- idea rewards ----------

    function _reserve(uint256 fund) internal {
        _fundPot(fund);
        pot.sync();
    }

    uint256 internal refN;

    function _queue(address by, address to, uint256 amount) internal returns (uint256 id) {
        vm.prank(by);
        id = pot.queueReward(to, amount, keccak256(abi.encode(to, amount, ++refN))); // a fresh record each time
    }

    function _reward(uint256 id) internal view returns (address to, uint256 amount, address proposer, uint256 eta) {
        (to, amount, proposer, eta,) = pot.rewards(id);
    }

    /// One signed reward record backs one reward: a second queue on its ideaRef reverts while the first is open or after
    /// it was paid; a Safe cancel frees it.
    function test_reward_refOncePerRecord() public {
        _reserve(50 ether); // reserve 15 ETH: per reward <= 3.75, day budget 3.75
        bytes32 ref = keccak256("record 12");
        vm.startPrank(agent);
        uint256 a = pot.queueReward(bob, 1 ether, ref);
        assertEq(pot.rewardOfRef(ref), a);
        vm.expectRevert(GamePot.RefUsed.selector);
        pot.queueReward(bob, 1 ether, ref); // the same record again (a crashed engine re-sending)
        vm.expectRevert(GamePot.RefUsed.selector);
        pot.queueReward(carol, 0.5 ether, ref); // even to another payee or amount
        vm.stopPrank();
        (,,,, bytes32 stored) = pot.rewards(a);
        assertEq(stored, ref);
        vm.prank(safe);
        pot.cancelReward(a);
        assertEq(pot.rewardOfRef(ref), 0, "a cancel frees the record");
        vm.prank(agent);
        uint256 b = pot.queueReward(bob, 1 ether, ref);
        vm.warp(block.timestamp + 1 hours);
        pot.payReward(b);
        assertEq(pot.rewardOfRef(ref), b, "paid: used for good");
        vm.prank(agent);
        vm.expectRevert(GamePot.RefUsed.selector);
        pot.queueReward(bob, 1 ether, ref);
    }

    function test_reward_queue_authAndBounds() public {
        _reserve(20 ether); // reserve 6 ETH: per reward ≤ 1.5, day budget 1.5
        vm.prank(alice);
        vm.expectRevert(GamePot.Unauthorized.selector);
        pot.queueReward(bob, 1 ether, bytes32(0));
        reg.setLevel(4);
        vm.prank(agent);
        vm.expectRevert(GamePot.Unauthorized.selector);
        pot.queueReward(bob, 1 ether, bytes32(0));
        reg.setLevel(5);
        reg.setPaused(true);
        vm.prank(agent);
        vm.expectRevert(GamePot.Unauthorized.selector);
        pot.queueReward(bob, 1 ether, bytes32(0));
        reg.setPaused(false);
        address[10] memory excluded =
            [safe, agent, anchor, team, bb, lv, address(pot), address(vault), address(0), DEAD];
        for (uint256 i; i < excluded.length; ++i) {
            vm.prank(agent);
            vm.expectRevert(GamePot.BadReward.selector);
            pot.queueReward(excluded[i], 1 ether, bytes32(0));
        }
        vm.startPrank(agent);
        vm.expectRevert(GamePot.BadReward.selector);
        pot.queueReward(bob, 0.01 ether - 1, bytes32(0));
        vm.expectRevert(GamePot.BadReward.selector);
        pot.queueReward(bob, 1.5 ether + 1, bytes32(0)); // > 25% of the reserve
        vm.expectEmit(address(pot));
        emit GamePot.RewardQueued(1, bob, 1.5 ether, bytes32("idea"), block.timestamp + 1 hours);
        assertEq(pot.queueReward(bob, 1.5 ether, bytes32("idea")), 1);
        vm.stopPrank();
        (address to, uint256 amount, address proposer, uint256 eta) = _reward(1);
        assertEq(to, bob);
        assertEq(amount, 1.5 ether);
        assertEq(proposer, agent);
        assertEq(eta, block.timestamp + 1 hours);
        assertEq(pot.ideaReserve(), 4.5 ether, "escrowed out of the reserve");
        assertEq(pot.queuedRewards(), 1.5 ether);
        assertEq(_claims(address(pot)), _liabilities());
        pot.sync();
        assertEq(pot.ideaReserve(), 4.5 ether, "sync counts the escrow as a liability");
    }

    /// queueReward counts arrivals first: the cap is 25% of the reserve after sync.
    function test_reward_queue_syncsFirst() public {
        _fundPot(20 ether); // not synced
        assertEq(pot.ideaReserve(), 0);
        _queue(safe, bob, 1.5 ether);
        assertEq(pot.ideaReserve(), 4.5 ether);
        assertEq(pot.jackpotPot(), 14 ether);
    }

    function test_reward_dailyBudget() public {
        _reserve(20 ether); // 6 ETH: budget 1.5 for the day starting now
        uint256 t0 = block.timestamp;
        _queue(agent, alice, 1 ether);
        assertEq(pot.budgetStart(), t0);
        assertEq(pot.dayBudget(), 1.5 ether);
        _queue(agent, bob, 0.5 ether);
        vm.prank(agent);
        vm.expectRevert(GamePot.OverBudget.selector);
        pot.queueReward(carol, 0.01 ether, bytes32(0));
        _reserve(50 ether); // the reserve refills to the cap, the day's budget stays
        vm.prank(safe);
        pot.cancelReward(2); // a cancel does not give the budget back
        vm.warp(t0 + 24 hours - 1);
        vm.prank(safe); // the Safe is bounded by the same budget
        vm.expectRevert(GamePot.OverBudget.selector);
        pot.queueReward(carol, 0.01 ether, bytes32(0));
        vm.warp(t0 + 24 hours);
        pot.sync(); // burns what the cancel lifted over the cap
        uint256 r = pot.ideaReserve();
        _queue(agent, carol, 0.01 ether); // a new day: 25% of the reserve at its first queue
        assertEq(pot.budgetStart(), t0 + 24 hours);
        assertEq(pot.dayBudget(), r / 4);
        assertEq(pot.daySpent(), 0.01 ether);
    }

    function test_reward_payPushes() public {
        _reserve(20 ether);
        uint256 id = _queue(agent, alice, 1 ether);
        vm.expectRevert(GamePot.TooEarly.selector);
        pot.payReward(id);
        vm.warp(block.timestamp + 1 hours - 1);
        vm.expectRevert(GamePot.TooEarly.selector);
        pot.payReward(id);
        vm.warp(block.timestamp + 1);
        uint256 b0 = alice.balance;
        vm.expectEmit(address(pot));
        emit GamePot.RewardPaid(id, alice, 1 ether, 0);
        vm.prank(bob); // anyone
        pot.payReward(id);
        assertEq(alice.balance, b0 + 1 ether);
        assertEq(pot.queuedRewards(), 0);
        assertEq(pot.owedTotal(), 0);
        assertEq(pot.drawCount(), 0, "pushed: no claim record");
        assertEq(address(pot).balance, 0);
        assertEq(_claims(address(pot)), _liabilities());
        vm.expectRevert(GamePot.NothingPending.selector);
        pot.payReward(id);
        vm.expectRevert(GamePot.NothingPending.selector);
        pot.payReward(99);
    }

    /// registry.agentPaused() stops every queued reward, the Safe's too; an agent's reward also needs the proposer to
    /// still be the agent at level ≥ 5 when it pays.
    function test_reward_pauseStopsPay() public {
        _reserve(40 ether); // 12 ETH: budget 3
        uint256 a = _queue(agent, alice, 1 ether);
        uint256 b = _queue(safe, bob, 1 ether);
        vm.warp(block.timestamp + 1 hours);
        reg.setPaused(true);
        vm.expectRevert(GamePot.Unauthorized.selector);
        pot.payReward(a);
        vm.expectRevert(GamePot.Unauthorized.selector);
        pot.payReward(b);
        reg.setPaused(false);
        reg.setLevel(4);
        vm.expectRevert(GamePot.Unauthorized.selector);
        pot.payReward(a);
        pot.payReward(b); // the Safe's proposal: level does not matter
        reg.setLevel(5);
        reg.setAgent(makeAddr("newAgent"));
        vm.expectRevert(GamePot.Unauthorized.selector);
        pot.payReward(a); // rotated agent key: the old proposal is dead
        reg.setAgent(agent);
        pot.payReward(a);
        assertEq(alice.balance, 1 ether);
        assertEq(bob.balance, 1 ether);
    }

    function test_reward_recipientExcludedAtPay() public {
        _reserve(20 ether);
        uint256 id = _queue(safe, bob, 1 ether);
        vm.warp(block.timestamp + 1 hours);
        reg.setAgent(bob); // bob became an excluded address after the queue
        vm.expectRevert(GamePot.Unauthorized.selector);
        pot.payReward(id);
        vm.prank(safe);
        pot.cancelReward(id);
        assertEq(pot.ideaReserve(), 6 ether);
    }

    function test_reward_cancel() public {
        _reserve(20 ether);
        uint256 id = _queue(agent, alice, 1 ether);
        vm.prank(agent);
        vm.expectRevert(GamePot.Unauthorized.selector);
        pot.cancelReward(id);
        vm.prank(alice);
        vm.expectRevert(GamePot.Unauthorized.selector);
        pot.cancelReward(id);
        vm.expectEmit(address(pot));
        emit GamePot.RewardCancelled(id);
        vm.prank(safe);
        pot.cancelReward(id);
        assertEq(pot.ideaReserve(), 6 ether);
        assertEq(pot.queuedRewards(), 0);
        vm.prank(safe);
        vm.expectRevert(GamePot.NothingPending.selector);
        pot.cancelReward(id);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(GamePot.NothingPending.selector);
        pot.payReward(id);
        uint256 id2 = _queue(agent, alice, 0.5 ether);
        vm.warp(block.timestamp + 1 hours);
        pot.payReward(id2);
        vm.prank(safe);
        vm.expectRevert(GamePot.NothingPending.selector); // paid: nothing to cancel
        pot.cancelReward(id2);
        assertEq(_claims(address(pot)), _liabilities());
    }

    /// A cancel can lift the reserve above RESERVE_CAP; the next sync burns the excess.
    function test_reward_cancelOverCap_burnsAtNextSync() public {
        _reserve(60 ether); // reserve 15 (cap), 3 ETH burned
        uint256 id = _queue(safe, alice, 3.75 ether);
        _reserve(20 ether); // refills to 15; the rest burns
        uint256 burned = _claims(bb);
        vm.prank(safe);
        pot.cancelReward(id);
        assertEq(pot.ideaReserve(), 18.75 ether, "over the cap until the next sync");
        assertEq(_claims(address(pot)), _liabilities());
        vm.expectEmit(address(pot));
        emit GamePot.Synced(0, pot.jackpotPot(), 15 ether, 3.75 ether);
        pot.sync();
        assertEq(pot.ideaReserve(), 15 ether);
        assertEq(_claims(bb), burned + 3.75 ether);
        assertEq(_claims(address(pot)), _liabilities());
    }

    /// A recipient that can't take ETH gets a claim (same `claim` / CLAIM_WINDOW as a prize); unclaimed, it expires to
    /// the jackpot.
    function test_reward_revertingRecipient_claimThenExpire() public {
        _reserve(40 ether);
        Reverter rev = new Reverter();
        uint256 a = _queue(agent, address(rev), 1 ether);
        GasBurner g = new GasBurner();
        uint256 b = _queue(agent, address(g), 1 ether);
        vm.warp(block.timestamp + 1 hours);
        vm.expectEmit(address(pot));
        emit GamePot.RewardPaid(a, address(rev), 1 ether, 1);
        pot.payReward(a);
        assertEq(pot.drawCount(), 1);
        PrizeView memory z = _prize(1);
        assertEq(z.winner, address(rev));
        assertEq(z.amount, 1 ether);
        assertEq(pot.owedTotal(), 1 ether);
        assertEq(address(pot).balance, 0, "back to claims");
        assertEq(_claims(address(pot)), _liabilities());
        uint256 g0 = gasleft();
        pot.payReward(b);
        assertLt(g0 - gasleft(), 250_000, "the burner gets PUSH_GAS, no more");
        assertEq(pot.drawCount(), 2);
        assertEq(pot.owedTotal(), 2 ether);
        address cold = makeAddr("cold");
        rev.claim(pot, 1, cold);
        assertEq(cold.balance, 1 ether);
        vm.warp(block.timestamp + 7 days);
        uint256 jp = pot.jackpotPot();
        pot.expireClaim(2);
        assertEq(pot.jackpotPot(), jp + 1 ether, "an expired reward claim goes to the jackpot");
        assertEq(pot.owedTotal(), 0);
        assertEq(_claims(address(pot)), _liabilities());
    }

    /// The recipient's receive sees the reward closed and every money path locked.
    function test_reward_reentrantRecipient() public {
        _reserve(20 ether);
        Reenter r = new Reenter(pot, false);
        uint256 id = _queue(agent, address(r), 1 ether);
        vm.warp(block.timestamp + 1 hours);
        vm.recordLogs();
        pot.payReward(id);
        _checkReentry(address(r));
        assertEq(address(r).balance, 1 ether, "paid once");
        Reenter r2 = new Reenter(pot, true);
        uint256 id2 = _queue(agent, address(r2), 0.4 ether);
        vm.warp(block.timestamp + 1 hours);
        pot.payReward(id2);
        assertEq(address(r2).balance, 0);
        assertEq(pot.owedTotal(), 0.4 ether, "a bubbling receiver gets a claim");
        assertEq(_claims(address(pot)), _liabilities());
    }

    /// rescueToBuyback empties the idea reserve; a queued reward stays payable.
    function test_reward_rescue_queuedStaysPayable() public {
        _ready(2 ether);
        _reserve(20 ether);
        uint256 id = _queue(agent, alice, 1 ether);
        pot.requestDraw();
        uint256 prize = _draw().prize;
        vm.warp(block.timestamp + 14 days);
        uint256 amount = pot.jackpotPot() + pot.ideaReserve() + prize;
        uint256 bb0 = _claims(bb);
        pot.rescueToBuyback();
        assertEq(_claims(bb), bb0 + amount);
        assertEq(pot.ideaReserve(), 0);
        assertEq(pot.queuedRewards(), 1 ether);
        pot.payReward(id);
        assertEq(alice.balance, 1 ether);
        assertEq(_claims(address(pot)) + address(pot).balance, _liabilities());
    }

    /// Model check of the per-reward cap, the minimum and the rolling day budget over random amounts and gaps.
    function testFuzz_reward_capsAndBudget(uint256 fund, uint256[6] memory amts, uint256[6] memory gaps) public {
        _reserve(bound(fund, 0.04 ether, 60 ether));
        (uint256 start, uint256 budget, uint256 spent) = (0, 0, 0);
        for (uint256 i; i < 6; ++i) {
            vm.warp(block.timestamp + bound(gaps[i], 0, 30 hours));
            uint256 amount = bound(amts[i], 0, 4 ether);
            uint256 reserve = pot.ideaReserve();
            bool roll = block.timestamp >= start + 24 hours;
            uint256 b = roll ? reserve * 2500 / 10_000 : budget;
            uint256 sp = roll ? 0 : spent;
            bool ok = amount >= 0.01 ether && amount * 10_000 <= reserve * 2500 && sp + amount <= b;
            vm.prank(agent);
            try pot.queueReward(alice, amount, bytes32(i)) {
                assertTrue(ok, "queued outside the model");
                if (roll) (start, budget) = (block.timestamp, b);
                spent = sp + amount;
                assertEq(pot.ideaReserve(), reserve - amount);
            } catch {
                assertFalse(ok, "refused inside the model");
            }
            assertLe(pot.daySpent(), pot.dayBudget());
            assertEq(_claims(address(pot)), _liabilities());
        }
    }

    // ---------- size ----------

    /// EIP-170: the deployed GamePot must stay under 24,576 bytes.
    function test_size_underEip170() public view {
        console.log("GamePot runtime bytes", address(pot).code.length);
        assertLe(address(pot).code.length, 24_576);
    }

    // ---------- golden vector (shared with engine/src/tickets.ts) ----------

    function test_goldenVector() public {
        address[] memory a = new address[](3);
        uint256[] memory t = new uint256[](3);
        (a[0], a[1], a[2]) =
        (
            0x1111111111111111111111111111111111111111,
            0x2222222222222222222222222222222222222222,
            0x3333333333333333333333333333333333333333
        );
        (t[0], t[1], t[2]) = (5, 3, 7);
        _setList(a, t);
        bytes32[3] memory h = [
            bytes32(0x5a329d02646ff492373482f02964df08c6b2faebdc11392292d2b2564f9759cd),
            0x4ba59f79dc6980bf6b4ade0c1fb219c1806af0b9c084c39fa956c84f39f448a1,
            0x596f0ad70f0bce67c7c5682d63726425257a002804eededede3cca7a405e9b85
        ];
        bytes32 root = 0x3b953545397409c5773e5f6520cfd629d63970a82385f05bb115abb9ebf90198;
        bytes32[][3] memory proofs;
        proofs[0] = new bytes32[](2);
        (proofs[0][0], proofs[0][1]) = (h[1], h[2]);
        proofs[1] = new bytes32[](2);
        (proofs[1][0], proofs[1][1]) = (h[0], h[2]);
        proofs[2] = new bytes32[](1);
        proofs[2][0] = 0x7b6271f0e74dca2c0acc6bf899c1462b4850fee661350460d5578607010c9edd;
        for (uint256 i; i < 3; ++i) {
            assertEq(pot.leafHash(leaves[i]), h[i], "GamePot.leafHash");
            (bytes32 r, bytes32[] memory p) = _proof(i);
            assertEq(r, root, "test tree root");
            assertEq(keccak256(abi.encode(p)), keccak256(abi.encode(proofs[i])), "test tree proof");
        }
        _fundPot(2 ether);
        _close();
        vm.prank(agent);
        pot.postList(1, GamePot.Params(100, 1_000 ether), root, 15, 3, leaves[2], proofs[2], "", bytes32(0));
        vm.warp(block.timestamp + 1 hours);
        pot.requestDraw();
        // the ticket derivation, shared with engine/test/tickets.test.ts and web/test/draw.test.mjs
        uint256 rand = uint256(keccak256("dna.ten-winners.golden"));
        uint256[12] memory t15 = [uint256(0), 6, 1, 5, 6, 13, 5, 9, 10, 10, 2, 12];
        uint256[12] memory tBig =
            [uint256(993783), 57593, 632966, 272017, 880431, 158056, 940297, 250201, 589891, 972677, 164111, 197800];
        for (uint256 j; j < 12; ++j) {
            assertEq(pot.ticketAt(rand, j, 15), t15[j], "ticketAt(rand, j, 15)");
            assertEq(pot.ticketAt(rand, j, 1_000_003), tBig[j], "ticketAt(rand, j, 1000003)");
        }
        _fulfil(rand);
        (GamePot.Leaf[] memory ls, bytes32[][] memory ps, address[] memory w) = _walk();
        assertEq(ls.length, 32);
        (address w0, address w1, address w2) = (w[0], w[1], w[2]);
        assertEq(w0, a[0], "ticket 0: leaf 0");
        assertEq(w1, a[1], "ticket 6: leaf 1");
        assertEq(w2, a[2], "ticket 13 (j = 5): leaf 2, after duplicates at j = 2..4");
        pot.settle(ls, ps);
    }

    // ---------- fuzz ----------

    function _randomList(uint256 seed, uint256 n) internal {
        address[] memory a = new address[](n);
        uint256[] memory t = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            a[i] = address(uint160(0x10000 + i));
            t[i] = r % 5 == 0 ? 0 : 1 + (r >> 8) % 1e24; // some empty ranges
        }
        if (t[n - 1] == 0) t[n - 1] = 1; // postList refuses an empty last leaf (the engine never lists one)
        _setList(a, t);
    }

    /// Every rank's ticket settles exactly one leaf of a random multi-leaf tree: the one whose range holds it.
    /// forge-config: default.fuzz.runs = 100
    function testFuzz_settle_exactlyOneLeaf(uint256 seed, uint256 nRaw, uint256 word, uint256 posRaw) public {
        uint256 n = bound(nRaw, 1, 16);
        _randomList(seed, n);
        _ready(2 ether);
        pot.requestDraw();
        _fulfil(word);
        (GamePot.Leaf[] memory ls, bytes32[][] memory ps,) = _walk();
        uint256 pos = bound(posRaw, 0, ls.length - 1);
        uint256 t = pot.ticketAt(word, pos, _total());
        uint256 wins;
        for (uint256 i; i < n; ++i) {
            (GamePot.Leaf[] memory l2, bytes32[][] memory p2) = _slice(ls, ps, ls.length);
            (l2[pos], p2[pos]) = (leaves[i], _proofOf(i));
            uint256 snap = vm.snapshotState();
            try pot.settle(l2, p2) {
                ++wins;
                assertTrue(leaves[i].cumStart <= t && t < leaves[i].cumStart + leaves[i].tickets);
            } catch (bytes memory e) {
                assertEq(bytes4(e), GamePot.NotWinningLeaf.selector);
            }
            vm.revertToState(snap);
        }
        assertEq(wins, 1);
    }

    /// A forged leaf (any field changed) or a forged proof, at any rank, never settles.
    /// forge-config: default.fuzz.runs = 200
    function testFuzz_settle_rejectsForgedLeafOrProof(uint256 seed, uint256 nRaw, uint256 word, uint256 delta) public {
        uint256 n = bound(nRaw, 2, 16);
        _randomList(seed, n);
        _ready(2 ether);
        pot.requestDraw();
        _fulfil(word);
        (GamePot.Leaf[] memory ls, bytes32[][] memory ps,) = _walk();
        uint256 r = seed % ls.length;
        delta = bound(delta, 1, type(uint128).max);
        (GamePot.Leaf[] memory l2, bytes32[][] memory p2) = _slice(ls, ps, ls.length);
        GamePot.Leaf memory f = GamePot.Leaf(ls[r].index, ls[r].account, ls[r].cumStart, ls[r].tickets);
        bytes32[] memory p = new bytes32[](ps[r].length);
        for (uint256 i; i < p.length; ++i) {
            p[i] = ps[r][i];
        }
        uint256 which = (seed >> 8) % 5;
        if (which == 0) f.index += delta;
        else if (which == 1) f.account = address(uint160(f.account) ^ uint160(delta));
        else if (which == 2) f.cumStart = f.cumStart >= delta ? f.cumStart - delta : f.cumStart + delta;
        else if (which == 3) f.tickets += delta;
        else p[delta % p.length] = keccak256(abi.encode(delta));
        (l2[r], p2[r]) = (f, p);
        vm.expectRevert(GamePot.BadProof.selector);
        pot.settle(l2, p2);
        (l2, p2) = _slice(ls, ps, ls.length);
        p2[r] = new bytes32[](0); // n ≥ 2: a leaf is never the root
        vm.expectRevert(GamePot.BadProof.selector);
        pot.settle(l2, p2);
        _settle();
    }

    // ---------- gas ----------

    function test_gas_postRequestCallbackSettle() public {
        // postList with a 17-level proof (131,072 holders): the root is folded from 17 sibling hashes
        uint256 holders = 1 << 17;
        GamePot.Leaf memory last = GamePot.Leaf(holders - 1, alice, 999_000, 1000);
        bytes32[] memory p = new bytes32[](17);
        bytes32 node = Tree.leaf(last);
        for (uint256 i; i < 17; ++i) {
            p[i] = keccak256(abi.encode("sibling", i));
            node = Tree.pair(node, p[i]);
        }
        _fundPot(10 ether);
        _close();
        vm.prank(agent);
        pot.postList(1, GamePot.Params(100, 1_000 ether), node, 1_000_000, holders, last, p, "ipfs://list", bytes32(0));
        uint256 postGas = vm.lastFrameGas().gasTotalUsed;
        vm.warp(block.timestamp + 1 hours);
        pot.requestDraw();
        uint256 reqGas = vm.lastFrameGas().gasTotalUsed;
        _fulfil(999_500);
        uint256 cbGas = coord.lastGasUsed();
        console.log("postList (17-level proof, incl. 21k + calldata)", postGas);
        console.log("requestDraw (first: sub top-up)", reqGas);
        console.log("callback (measured inside the coordinator's exact-gas call)", cbGas);
        assertLt(cbGas, 100_000, "far below CALLBACK_GAS");
        assertLt(cbGas, pot.CALLBACK_GAS());
    }

    bytes32[][] internal deepProofs; // leaf i's proof in the posted tree (_postBurnerList)

    /// `m` gas-burning receivers (equal tickets; the last one is the list's last leaf, index holders − 1), their subtree
    /// folded under `spineLevels` synthetic siblings: a tree of 2^depth holders without building it. Posted for window 1.
    function _postBurnerList(uint256 m, uint256 spineLevels) internal {
        _postBurnerList(m, spineLevels, 0, 1_000);
    }

    /// The same, after `pad` one-ticket holders [0, pad) whose subtrees are the spine; each burner holds `t` tickets.
    function _postBurnerList(uint256 m, uint256 spineLevels, uint256 pad, uint256 t) internal {
        uint256 holders = pad != 0 ? pad + m : spineLevels == 0 ? m : (1 << spineLevels) * 64;
        bytes32 root = _fold(_pushBurners(m, holders, pad, t), spineLevels);
        _fundPot(10 ether);
        _close();
        vm.prank(agent);
        pot.postList(
            1, GamePot.Params(100, 1_000 ether), root, _total(), holders, leaves[m - 1], deepProofs[m - 1], "", 0
        );
    }

    /// The burners' tree folded under `spineLevels` synthetic siblings: the root, and every burner's proof in deepProofs.
    function _fold(bytes32[] memory h, uint256 spineLevels) internal returns (bytes32 root) {
        (root,) = Tree.build(h, 0);
        bytes32[] memory spine = new bytes32[](spineLevels);
        for (uint256 i; i < spineLevels; ++i) {
            spine[i] = keccak256(abi.encode("spine", i));
            root = Tree.pair(root, spine[i]);
        }
        delete deepProofs;
        for (uint256 i; i < h.length; ++i) {
            (, bytes32[] memory p) = Tree.build(h, i);
            bytes32[] memory q = new bytes32[](p.length + spineLevels);
            for (uint256 k; k < p.length; ++k) {
                q[k] = p[k];
            }
            for (uint256 k; k < spineLevels; ++k) {
                q[p.length + k] = spine[k];
            }
            deepProofs.push(q);
        }
    }

    function _pushBurners(uint256 m, uint256 holders, uint256 pad, uint256 t) internal returns (bytes32[] memory h) {
        h = new bytes32[](m);
        delete leaves;
        for (uint256 i; i < m; ++i) {
            leaves.push(GamePot.Leaf(i + 1 == m ? holders - 1 : pad + i, address(new GasBurner()), pad + i * t, t));
            h[i] = Tree.leaf(leaves[i]);
        }
    }

    /// A word whose walk takes all MAX_TICKETS tickets to find the 10 burners, none on a padding holder (< pad).
    function _wordForThirtyTwo(uint256 pad) internal view returns (uint256 word) {
        for (word = 1;; ++word) {
            (uint256 n, uint256 j) = _walkLen(word, pad);
            if (n == 10 && j == 32) return word;
        }
    }

    /// Distinct accounts and tickets walked for `word`; (0, 0) if a ticket lands on a padding holder.
    function _walkLen(uint256 word, uint256 pad) internal view returns (uint256 n, uint256 j) {
        address[] memory seen = new address[](10);
        for (; j < 32 && n < 10; ++j) {
            uint256 tk = pot.ticketAt(word, j, _total());
            if (tk < pad) return (0, 0);
            address acct = leaves[_holderOf(tk)].account;
            bool dup;
            for (uint256 x; x < n; ++x) {
                if (seen[x] == acct) dup = true;
            }
            if (!dup) seen[n++] = acct;
        }
    }

    /// A VRF word whose walk finds 10 distinct accounts within MAX_TICKETS on the current list.
    function _wordForTen() internal view returns (uint256 word) {
        uint256 total = _total();
        for (;; ++word) {
            address[] memory seen = new address[](10);
            uint256 n;
            for (uint256 j; j < 32 && n < 10; ++j) {
                address acct = leaves[_holderOf(pot.ticketAt(word, j, total))].account;
                bool dup;
                for (uint256 x; x < n; ++x) {
                    if (seen[x] == acct) dup = true;
                }
                if (!dup) seen[n++] = acct;
            }
            if (n == 10) return word;
        }
    }

    /// Settle the burner list's draw with `word`; returns the settle gas and the tickets walked.
    function _settleBurners(uint256 word) internal returns (uint256 g, uint256 used) {
        vm.warp(block.timestamp + 1 hours);
        pot.requestDraw();
        _fulfil(word);
        (GamePot.Leaf[] memory ls, bytes32[][] memory ps, address[] memory w) = _walk();
        for (uint256 k; k < ls.length; ++k) {
            ps[k] = deepProofs[_holderOf(ls[k].cumStart)];
        }
        assertEq(w.length, 10);
        vm.prank(makeAddr("keeper"));
        pot.settle(ls, ps);
        g = vm.lastFrameGas().gasTotalUsed;
        used = ls.length;
        assertEq(pot.drawCount(), 10, "10 failed pushes, 10 claims");
    }

    /// The worst settles, pinned at ≤ 1.65M; the keeper's settle gas floor (games.ts SETTLE_GAS_MIN, 1.8M) is the
    /// worst measured (c) + ~10%.
    /// Every winner is a cold contract that burns its whole PUSH_GAS and fails (10 claim records). (a) A deep tree: 50
    /// burners under a 17-level proof (a 131,072-holder list), ~11 tickets. (b) A small list: 10 equal burners, so the
    /// walk needs ~30 tickets (shallow proofs). (c) Both at once: 17-level proofs × all 32 tickets: 10 burners hold
    /// 10M tickets after 2^17 − 10 one-ticket holders (a 131,072-holder list).
    function test_gas_settleWorstCase() public {
        uint256 snap = vm.snapshotState();
        _postBurnerList(50, 11); // 64-slot subtree (6) + 11 = 17 levels
        assertEq(deepProofs[0].length, 17);
        (uint256 g, uint256 used) = _settleBurners(1);
        console.log("settle, worst: deep tree (17 levels), tickets", g, used);
        assertLe(g, 1_650_000, "deep: settle gas pinned");
        vm.revertToState(snap);
        _postBurnerList(10, 0);
        (g, used) = _settleBurners(_wordForTen());
        console.log("settle, worst: 10 equal holders, tickets", g, used);
        assertLe(g, 1_650_000, "wide walk: settle gas pinned");
        vm.revertToState(snap);
        _postBurnerList(10, 13, (1 << 17) - 10, 1_000_000); // 16-slot subtree (4) + 13 = 17 levels
        assertEq(deepProofs[0].length, 17);
        (g, used) = _settleBurners(_wordForThirtyTwo((1 << 17) - 10));
        console.log("settle, worst: 17 levels x 32 tickets, tickets", g, used);
        assertEq(used, 32, "all 32 tickets walked");
        assertLe(g, 1_650_000, "17 levels x 32 tickets: settle gas pinned");
    }
}

/// ETH conservation: everything that entered the pot is either still held (claims + ETH, ≥ every liability) or
/// left to an allowed destination: winners, BuybackBurn, LiquidityVault, the VRF subscription. Never the Safe/agent.
contract PotHandler is Test {
    GamePot public pot;
    MockCoordinator public coord;
    TestHook public hook;
    ConvictionVault public vault;
    address public safe;
    address public agent;
    Reverter public rev;
    address public claimTo = makeAddr("claimTo");
    address[5] public pool; // alice, bob, carol (EOAs), a reverting receiver, the Safe (excluded)
    GasBurner public burner;
    GamePot.Leaf[] internal leaves; // the list on chain
    uint256 public inflow; // funded claims + stray ETH
    uint256 public toWinners;
    mapping(bytes32 => uint256) public calls;

    constructor(GamePotInvariantTest b, address[3] memory a) {
        (pot, coord, hook, vault) = (b.potRef(), b.coordRef(), b.hookRef(), b.vaultRef());
        (safe, agent) = (pot.safe(), b.agentRef());
        rev = new Reverter();
        burner = new GasBurner();
        pool = [a[0], a[1], a[2], address(rev), safe];
    }

    function _reqId() internal view returns (uint256 id) {
        (,,,,, id,,,) = pot.draw();
    }

    function fund(uint256 amount) external {
        amount = bound(amount, 0.01 ether, 8 ether);
        hook.fund{value: amount}(address(pot));
        inflow += amount;
        calls["fund"]++;
    }

    function stray(uint256 amount) external {
        amount = bound(amount, 1, 1 ether);
        (bool ok,) = address(pot).call{value: amount}("");
        require(ok);
        inflow += amount;
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1 hours, 3 days));
    }

    function sync() external {
        pot.sync();
    }

    /// Post a random 1–4 holder list for the latest closed window (rolls first; may legitimately revert).
    function post(uint256 seed) public {
        while (block.timestamp >= pot.windowEnd()) {
            pot.rollWindow();
        }
        (uint256 w,) = pot.latestClosedWindow();
        uint256 n = 1 + seed % 4;
        GamePot.Leaf[] memory ls = new GamePot.Leaf[](n);
        bytes32[] memory h = new bytes32[](n);
        uint256 cum;
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            ls[i] = GamePot.Leaf(i, pool[r % 5], cum, 1 + (r >> 8) % 100);
            cum += ls[i].tickets;
            h[i] = Tree.leaf(ls[i]);
        }
        (bytes32 root, bytes32[] memory p) = Tree.build(h, n - 1);
        vm.prank(agent);
        try pot.postList(w, GamePot.Params(100, 1_000 ether), root, cum, n, ls[n - 1], p, "", bytes32(0)) {
            delete leaves;
            for (uint256 i; i < n; ++i) {
                leaves.push(ls[i]);
            }
            calls["post"]++;
        } catch {
            calls["post.revert"]++;
        }
    }

    function request() public {
        try pot.requestDraw() {
            calls["request"]++;
        } catch {
            calls["request.revert"]++;
        }
    }

    function fulfil(uint256 word) public {
        uint256 id = _reqId();
        if (id == 0) return;
        (,,,, bool pending) = coord.reqs(id);
        if (!pending) return;
        coord.fulfill(id, word);
        calls["fulfil"]++;
    }

    /// Settle with the walk (the keeper's input): never reverts on a fulfilled draw. Records every Winner event to check
    /// that no account is paid twice in one draw.
    function settle() public {
        (,,, uint40 fulfilledAt,,,, uint256 total, uint256 rand) = pot.draw();
        if (fulfilledAt == 0) return;
        uint256 n = leaves.length;
        bytes32[] memory h = new bytes32[](n);
        for (uint256 k; k < n; ++k) {
            h[k] = Tree.leaf(leaves[k]);
        }
        GamePot.Leaf[] memory wl = new GamePot.Leaf[](32);
        bytes32[][] memory wp = new bytes32[][](32);
        address[] memory w = new address[](10);
        (uint256 m, uint256 used) = (0, 0);
        for (uint256 j; j < 32 && m < 10; ++j) {
            uint256 t = pot.ticketAt(rand, j, total);
            uint256 i;
            while (!(leaves[i].cumStart <= t && t < leaves[i].cumStart + leaves[i].tickets)) {
                ++i;
            }
            wl[used] = leaves[i];
            (, wp[used]) = Tree.build(h, i);
            ++used;
            bool dup;
            for (uint256 x; x < m; ++x) {
                if (w[x] == leaves[i].account) dup = true;
            }
            if (dup || pot.isExcluded(leaves[i].account)) continue;
            w[m++] = leaves[i].account;
        }
        GamePot.Leaf[] memory sl = new GamePot.Leaf[](used);
        bytes32[][] memory sp = new bytes32[][](used);
        for (uint256 x; x < used; ++x) {
            (sl[x], sp[x]) = (wl[x], wp[x]);
        }
        uint256[] memory b0 = new uint256[](m);
        for (uint256 x; x < m; ++x) {
            b0[x] = w[x].balance;
        }
        vm.recordLogs();
        pot.settle(sl, sp);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 winnerSig = keccak256("Winner(uint256,uint256,address,uint256,uint256)");
        address[] memory paid = new address[](logs.length);
        uint256 np;
        for (uint256 x; x < logs.length; ++x) {
            if (logs[x].emitter != address(pot) || logs[x].topics[0] != winnerSig) continue;
            address a = address(uint160(uint256(logs[x].topics[2])));
            for (uint256 y; y < np; ++y) {
                if (paid[y] == a) twice++;
            }
            paid[np++] = a;
        }
        for (uint256 x; x < m; ++x) {
            toWinners += w[x].balance - b0[x]; // pushed (0 for the reverting receiver)
        }
        calls[m == 0 ? bytes32("settle.none") : bytes32("settle")]++;
    }

    uint256 public twice; // accounts paid twice in one draw: must stay 0

    /// One whole round: fund, close the window, post, wait the veto, request, fulfil, settle.
    function cycle(uint256 seed, uint256 word) external {
        if (_reqId() != 0) return;
        hook.fund{value: 1 ether}(address(pot));
        inflow += 1 ether;
        if (block.timestamp < pot.windowEnd()) vm.warp(pot.windowEnd());
        post(seed);
        vm.warp(block.timestamp + 1 hours);
        try pot.requestDraw() returns (uint256 r) {
            coord.fulfill(r, word);
            settle();
            calls["cycle"]++;
        } catch {
            calls["cycle.revert"]++;
        }
    }

    function abort() external {
        try pot.abortDraw() {
            calls["abort"]++;
        } catch {}
    }

    /// Fulfil, then nobody settles for DRAW_SETTLE_WINDOW.
    function voidDraw(uint256 word) external {
        fulfil(word);
        vm.warp(block.timestamp + 7 days);
        try pot.voidDraw() {
            calls["void"]++;
        } catch {}
    }

    function cancelList() external {
        (uint64 w,,,,,,,,) = pot.draw();
        vm.prank(safe);
        try pot.cancelList(w) {
            calls["cancelList"]++;
        } catch {}
    }

    function claimAll() external {
        uint256 n = pot.drawCount();
        for (uint256 i = 1; i <= n; ++i) {
            (address w, uint64 amt,) = pot.prizes(i);
            bool claimed = amt == 0;
            if (claimed) continue;
            uint256 b0 = claimTo.balance;
            uint256[] memory ids = new uint256[](1);
            ids[0] = i;
            vm.prank(w);
            pot.claim(ids, claimTo);
            toWinners += claimTo.balance - b0;
            calls["claim"]++;
        }
    }

    /// Let the oldest owed prize (or a random one) run out its CLAIM_WINDOW.
    function expire(uint256 i) external {
        uint256 n = pot.drawCount();
        if (n == 0) return;
        uint256 id = 1 + i % n;
        for (uint256 k = 1; k <= n; ++k) {
            (, uint64 amt,) = pot.prizes(k);
            bool claimed = amt == 0;
            if (!claimed) (id, k) = (k, n);
        }
        vm.warp(block.timestamp + 7 days);
        try pot.expireClaim(id) {
            calls["expire"]++;
        } catch {}
    }

    uint256 public rewardViolations; // queued over a cap, to an excluded address, or paid while paused: must stay 0

    /// Queue a reward (agent or Safe) to a pool address or the gas burner; excluded recipients must be refused.
    function queueReward(uint256 seed, uint256 amount) external {
        address to = seed % 6 == 5 ? address(burner) : pool[seed % 5];
        address by = (seed >> 8) % 2 == 0 ? agent : safe;
        pot.sync(); // the cap is checked against the synced reserve
        uint256 reserve = pot.ideaReserve();
        amount = bound(amount, 0, reserve / 4 + 0.02 ether); // mostly inside the cap, sometimes just over
        vm.prank(by);
        try pot.queueReward(to, amount, bytes32(seed)) {
            if (pot.isExcluded(to) || amount < pot.MIN_REWARD() || amount * 10_000 > reserve * pot.MAX_REWARD_BPS()) {
                rewardViolations++;
            }
            calls["reward.queue"]++;
        } catch {
            calls["reward.queue.revert"]++;
        }
    }

    /// Pay a random queued reward (it may not be due, or the agent may be paused).
    function payReward(uint256 i) external {
        uint256 n = pot.rewardCount();
        if (n == 0) return;
        uint256 id = 1 + i % n;
        (address to,,,,) = pot.rewards(id);
        bool paused = RolesRegistry(address(pot.registry())).agentPaused();
        uint256 b0 = to.balance;
        try pot.payReward(id) {
            if (paused || pot.isExcluded(to)) rewardViolations++;
            toWinners += to.balance - b0; // pushed (0 when it became a claim)
            calls["reward.pay"]++;
        } catch {
            calls["reward.pay.revert"]++;
        }
    }

    /// Safe cancel, then a sync burns anything the cancel lifted above RESERVE_CAP.
    function cancelReward(uint256 i) external {
        uint256 n = pot.rewardCount();
        if (n == 0) return;
        vm.prank(safe);
        try pot.cancelReward(1 + i % n) {
            calls["reward.cancel"]++;
        } catch {}
        pot.sync();
    }

    function pause(bool p) external {
        RolesRegistry(address(pot.registry())).setPaused(p);
        calls["pause"]++;
    }

    function cancelSub() external {
        if (_reqId() != 0) return;
        coord.ownerCancel(pot.subId());
        pot.recreateSubscription();
        calls["resub"]++;
    }

    receive() external payable {}
}

contract GamePotInvariantTest is GameBase {
    PotHandler h;
    uint256 safeEth0;
    uint256 agentEth0;

    function potRef() external view returns (GamePot) {
        return pot;
    }

    function vaultRef() external view returns (ConvictionVault) {
        return vault;
    }

    function coordRef() external view returns (MockCoordinator) {
        return coord;
    }

    function hookRef() external view returns (TestHook) {
        return hook;
    }

    function agentRef() external view returns (address) {
        return agent;
    }

    function setUp() public override {
        super.setUp();
        h = new PotHandler(this, [alice, bob, carol]);
        vm.deal(address(h), 1e27);
        (safeEth0, agentEth0) = (safe.balance, agent.balance);
        targetContract(address(h));
    }

    /// Solvency: claims + ETH held ≥ jackpot + reserve + escrow + owed.
    function invariant_solvent() public view {
        assertGe(_claims(address(pot)) + address(pot).balance, _liabilities());
    }

    /// Conservation: inflow == held + winners + BuybackBurn + LiquidityVault + VRF subscription funding; the Safe
    /// and the agent never receive anything.
    function invariant_conservation() public view {
        uint256 held = _claims(address(pot)) + address(pot).balance;
        uint256 out = h.toWinners() + _claims(bb) + _claims(lv) + coord.totalFunded() - coord.totalRefunded();
        assertEq(h.inflow(), held + out);
        assertEq(safe.balance, safeEth0);
        assertEq(agent.balance, agentEth0);
        assertEq(_claims(safe) + _claims(agent), 0);
    }

    /// owedTotal is exactly the sum of prizes neither pushed, claimed nor expired; an escrow exists only with a request.
    function invariant_owedAndEscrow() public view {
        uint256 owed;
        for (uint256 i = 1; i <= pot.drawCount(); ++i) {
            PrizeView memory p = _prize(i);
            if (!p.claimed) owed += p.amount;
        }
        assertEq(pot.owedTotal(), owed);
        GamePot.Draw memory d = _draw();
        if (d.prize != 0) assertTrue(d.reqId != 0 && d.window != 0);
        if (d.fulfilledAt != 0) assertTrue(d.reqId != 0);
    }

    /// No account is paid twice in one draw (Winner events per settle).
    function invariant_noAccountPaidTwice() public view {
        assertEq(h.twice(), 0);
    }

    /// The idea reserve grows inside _sync, which clamps it to RESERVE_CAP (the overflow goes to BuybackBurn), and on a
    /// cancel (the handler syncs right after, which burns anything above the cap).
    function invariant_reserveCapped() public view {
        assertLe(pot.ideaReserve(), pot.RESERVE_CAP());
    }

    /// queuedRewards is exactly the sum of open escrows; the day's queued sum never passes its budget; every queued
    /// reward was within MIN_REWARD and 25% of the reserve; nothing was queued to or paid to an excluded address, and
    /// nothing paid while the agent was paused.
    function invariant_rewards() public view {
        uint256 open;
        for (uint256 i = 1; i <= pot.rewardCount(); ++i) {
            (, uint96 amount,,, bytes32 ref) = pot.rewards(i);
            open += amount;
            if (amount != 0) assertEq(pot.rewardOfRef(ref), i, "an open reward's record maps back to it");
        }
        assertEq(pot.queuedRewards(), open);
        assertLe(pot.daySpent(), pot.dayBudget());
        assertEq(h.rewardViolations(), 0);
    }

    function afterInvariant() external view {
        string[22] memory k = [
            "cycle",
            "cycle.revert",
            "fund",
            "post",
            "post.revert",
            "request",
            "request.revert",
            "fulfil",
            "settle",
            "settle.none",
            "abort",
            "void",
            "cancelList",
            "claim",
            "expire",
            "reward.queue",
            "reward.queue.revert",
            "reward.pay",
            "reward.pay.revert",
            "reward.cancel",
            "pause",
            "resub"
        ];
        for (uint256 i; i < k.length; ++i) {
            console.log(k[i], h.calls(bytes32(bytes(k[i]))));
        }
    }
}
