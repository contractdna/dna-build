// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {DNAToken} from "../src/DNAToken.sol";
import {ConvictionVault} from "../src/ConvictionVault.sol";
import {IModuleRegistry} from "../src/interfaces/IDNA.sol";

/// @dev Roles stand-in for ModuleRegistry (what the game contracts read live), plus the queue view MutationBoard uses.
contract RolesRegistry {
    address public safe;
    address public agent;
    address public anchorKey;
    bool public agentPaused;
    uint8 public level = 5;
    mapping(uint256 => address) internal _proposer;

    constructor(address safe_, address agent_, address anchor_) {
        (safe, agent, anchorKey) = (safe_, agent_, anchor_);
    }

    function setAgent(address a) external {
        agent = a;
    }

    function setPaused(bool p) external {
        agentPaused = p;
    }

    function setLevel(uint8 l) external {
        level = l;
    }

    function setProposer(uint256 id, address p) external {
        _proposer[id] = p;
    }

    /// Same shape as ModuleRegistry.queued(id): (Op op, address proposer, uint64 queuedAt, bytes data).
    function queued(uint256 id) external view returns (uint8, address, uint64, bytes memory) {
        return (0, _proposer[id], 1, "");
    }
}

/// @dev Stands in for GamePot as the vault sees it at `initialize`: `vault()` points back, `token()` is DNA.
contract MockPot {
    address public vault;
    address public token;

    function setVault(address v, address t) external {
        (vault, token) = (v, t);
    }
}

contract ConvictionVaultTest is Test {
    DNAToken token;
    RolesRegistry reg;
    ConvictionVault vault;
    MockPot pot;
    address safe = makeAddr("safe");
    address agent = makeAddr("agent");
    address anchor = makeAddr("anchor");
    address team = makeAddr("team");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    uint256 constant L = 10_000 ether; // MIN_LOCK

    function setUp() public {
        vm.warp(1_760_000_000);
        token = new DNAToken(address(this));
        reg = new RolesRegistry(safe, agent, anchor);
        address[] memory ex = new address[](1);
        ex[0] = team;
        vault = new ConvictionVault(IModuleRegistry(address(reg)), safe, ex);
        pot = new MockPot();
        pot.setVault(address(vault), address(token));
        vm.prank(safe);
        vault.initialize(address(pot));
        address[7] memory who = [alice, bob, carol, safe, agent, team, anchor];
        for (uint256 i; i < who.length; ++i) {
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

    // ---------- lock ----------

    function test_lock_positionAndWeight() public {
        vm.expectEmit(address(vault));
        emit ConvictionVault.Locked(1, alice, 20_000 ether, 2, 60_000 ether); // x3 tier, x1 streak
        uint256 id = _lock(alice, 20_000 ether, 2);
        assertEq(id, 1);
        ConvictionVault.Position memory p = vault.positions(1);
        assertEq(p.owner, alice);
        assertEq(p.tier, 2);
        assertEq(p.start, block.timestamp);
        assertEq(p.amount, 20_000 ether);
        assertFalse(p.withdrawn);
        assertEq(vault.totalLocked(), 20_000 ether);
        assertEq(token.balanceOf(address(vault)), 20_000 ether);
    }

    function test_lock_rejects() public {
        vm.expectRevert(ConvictionVault.TooSmall.selector);
        _lock(alice, L - 1, 0);
        vm.expectRevert(ConvictionVault.BadTier.selector);
        _lock(alice, L, 3);
        vm.expectRevert(ConvictionVault.TooLarge.selector);
        _lock(alice, uint256(type(uint96).max) + 1, 0);
        address[4] memory ops = [safe, agent, anchor, team];
        for (uint256 i; i < ops.length; ++i) {
            vm.expectRevert(ConvictionVault.Excluded.selector);
            _lock(ops[i], L, 0);
        }
        // the agent is read live: after a rotation the old key may lock, the new one may not
        address newAgent = makeAddr("newAgent");
        reg.setAgent(newAgent);
        _lock(agent, L, 0);
        vm.prank(newAgent);
        vm.expectRevert(ConvictionVault.Excluded.selector);
        vault.lock(L, 0);
    }

    function test_constructor_rejects() public {
        address[] memory none;
        vm.expectRevert(ConvictionVault.BadConfig.selector);
        new ConvictionVault(IModuleRegistry(makeAddr("codeless")), safe, none);
        vm.expectRevert(ConvictionVault.BadConfig.selector);
        new ConvictionVault(IModuleRegistry(address(reg)), address(0), none);
        address[] memory zero = new address[](2);
        zero[0] = team;
        vm.expectRevert(ConvictionVault.BadConfig.selector);
        new ConvictionVault(IModuleRegistry(address(reg)), safe, zero);
    }

    // ---------- weights (SPEC §12): tier x2/x2.5/x3 in term, x2 after; streak x1.25/1.5/2; ceiling x4 ----------

    function test_weightSchedule() public {
        uint256 id12h = _lock(alice, L, 0);
        uint256 id3d = _lock(bob, L, 1);
        uint256 id7d = _lock(carol, L, 2);
        uint256 t0 = block.timestamp;
        uint256[14] memory at = [
            uint256(0),
            12 hours - 1,
            12 hours,
            2 days - 1,
            2 days,
            3 days - 1,
            3 days,
            5 days - 1,
            5 days,
            7 days - 1,
            7 days,
            10 days - 1,
            10 days,
            400 days
        ];
        // multiplier x1e3: [12 h lock, 3 d lock, 7 d lock]
        uint256[3][14] memory want = [
            [uint256(2000), 2500, 3000], // 0: tier in term
            [uint256(2000), 2500, 3000], // just before 12 h
            [uint256(2000), 2500, 3000], // 12 h: the 12 h term is over -> x2 (same as its tier)
            [uint256(2000), 2500, 3000], // just before 2 d
            [uint256(2500), 3125, 3750], // 2 d: streak x1.25
            [uint256(2500), 3125, 3750],
            [uint256(2500), 2500, 3750], // 3 d: the 3 d term is over -> x2 x1.25
            [uint256(2500), 2500, 3750],
            [uint256(3000), 3000, 4000], // 5 d: streak x1.5; 7 d tier x3 x1.5 = x4.5 -> ceiling x4
            [uint256(3000), 3000, 4000],
            [uint256(3000), 3000, 3000], // 7 d: every term over: x2 x1.5
            [uint256(3000), 3000, 3000],
            [uint256(4000), 4000, 4000], // 10 d: x2 x2
            [uint256(4000), 4000, 4000]
        ];
        for (uint256 i; i < at.length; ++i) {
            assertEq(vault.currentWeight(id12h, t0 + at[i]), L * want[i][0] / 1000, "12h");
            assertEq(vault.currentWeight(id3d, t0 + at[i]), L * want[i][1] / 1000, "3d");
            assertEq(vault.currentWeight(id7d, t0 + at[i]), L * want[i][2] / 1000, "7d");
        }
        assertEq(vault.currentWeight(id7d, t0 - 1), 3 * L, "before start: the weight at lock");
    }

    function test_multipliers() public view {
        assertEq(vault.tierMult(0), 200);
        assertEq(vault.tierMult(1), 250);
        assertEq(vault.tierMult(2), 300);
        assertEq(vault.term(0), 12 hours);
        assertEq(vault.term(1), 3 days);
        assertEq(vault.term(2), 7 days);
        assertEq(vault.streakMult(2 days - 1), 100);
        assertEq(vault.streakMult(2 days), 125);
        assertEq(vault.streakMult(5 days - 1), 125);
        assertEq(vault.streakMult(5 days), 150);
        assertEq(vault.streakMult(10 days - 1), 150);
        assertEq(vault.streakMult(10 days), 200);
    }

    /// The x4 ceiling: a 7 d term recommitted at 7 d runs at 10 d with streak x2: x3 x2 = x6 -> x4.
    function test_ceiling_7dTierAt10dStreak() public {
        uint256 id = _lock(alice, L, 2);
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 7 days);
        vm.prank(alice);
        vault.recommit(_ids(id), 2);
        assertEq(vault.currentWeight(id, t0 + 10 days), 4 * L, "x4, not x6");
        assertEq(vault.currentWeight(id, t0 + 10 days - 1), 4 * L, "x3 x1.5 = x4.5 -> x4");
        assertEq(vault.currentWeight(id, t0 + 14 days), 4 * L, "term over: x2 x2 = x4");
    }

    /// Staked DNA always counts at least double: every position's weight is in [2, 4] x amount, at any T.
    function testFuzz_weightBounds(uint256 amount, uint8 tierRaw, uint256 dt, uint256 rc, uint8 rcTier) public {
        amount = bound(amount, L, 5_000_000 ether);
        uint256 id = _lock(alice, amount, uint8(bound(tierRaw, 0, 2)));
        uint256 t0 = block.timestamp;
        vm.warp(t0 + bound(rc, 7 days, 30 days));
        vm.prank(alice);
        vault.recommit(_ids(id), uint8(bound(rcTier, 0, 2)));
        uint256 w = vault.currentWeight(id, t0 + bound(dt, 0, 800 days));
        assertGe(w, 2 * amount);
        assertLe(w, 4 * amount);
    }

    function test_weightAt_minAgeAndWithdrawn() public {
        uint256 id = _lock(alice, L, 0);
        uint256 t0 = block.timestamp;
        assertEq(vault.weightAt(id, t0 + 12 hours - 1), 0, "too young");
        assertEq(vault.weightAt(id, t0 + 12 hours), 2 * L);
        assertEq(vault.weightAt(id, t0 - 1), 0);
        assertEq(vault.weightAt(99, t0 + 30 days), 0, "unknown id");
        vm.warp(t0 + 7 days);
        vm.prank(alice);
        vault.withdraw(_ids(id));
        assertEq(vault.weightAt(id, t0 + 2 days), 0, "withdrawn: 0 at any T");
    }

    // ---------- withdraw ----------

    function test_withdraw_termAndOwnership() public {
        uint256 id = _lock(alice, 15_000 ether, 1);
        vm.warp(block.timestamp + 3 days - 1);
        vm.prank(alice);
        vm.expectRevert(ConvictionVault.TooEarly.selector);
        vault.withdraw(_ids(id));
        vm.warp(block.timestamp + 1);
        vm.prank(bob);
        vm.expectRevert(ConvictionVault.NotOwner.selector);
        vault.withdraw(_ids(id));
        uint256 b0 = token.balanceOf(alice);
        vm.expectEmit(address(vault));
        emit ConvictionVault.Withdrawn(id, alice, 15_000 ether);
        vm.prank(alice);
        assertEq(vault.withdraw(_ids(id)), 15_000 ether);
        assertEq(token.balanceOf(alice) - b0, 15_000 ether);
        assertEq(vault.totalLocked(), 0);
        assertTrue(vault.positions(id).withdrawn);
        vm.prank(alice);
        vm.expectRevert(ConvictionVault.AlreadyWithdrawn.selector);
        vault.withdraw(_ids(id));
    }

    /// No expiry: a position stays locked (and weighted) after its term until the owner withdraws.
    function test_noExpiry() public {
        uint256 id = _lock(alice, L, 0);
        vm.warp(block.timestamp + 365 days);
        assertEq(vault.weightAt(id, block.timestamp), 4 * L, "x2 after the term x2 streak");
        assertEq(vault.totalLocked(), L);
    }

    // ---------- token binding ----------

    function test_initialize_onceByInitializerToMatchingPot() public {
        address[] memory none;
        ConvictionVault v = new ConvictionVault(IModuleRegistry(address(reg)), safe, none);
        vm.expectRevert(ConvictionVault.NotBound.selector); // no locks before DNA is bound
        v.lock(L, 0);
        MockPot wrong = new MockPot();
        wrong.setVault(address(vault), address(token));
        vm.expectRevert(ConvictionVault.NotInitializer.selector);
        v.initialize(address(wrong));
        vm.startPrank(safe);
        vm.expectRevert(ConvictionVault.WrongPot.selector);
        v.initialize(address(wrong));
        vm.expectRevert(ConvictionVault.WrongPot.selector);
        v.initialize(makeAddr("codeless"));
        MockPot right = new MockPot();
        right.setVault(address(v), address(0));
        vm.expectRevert(ConvictionVault.WrongPot.selector); // pot not initialized: no token yet
        v.initialize(address(right));
        right.setVault(address(v), address(token));
        vm.expectEmit(address(v));
        emit ConvictionVault.TokenBound(address(token));
        v.initialize(address(right));
        assertEq(address(v.token()), address(token));
        vm.expectRevert(ConvictionVault.AlreadyBound.selector);
        v.initialize(address(right));
        MockPot other = new MockPot();
        other.setVault(address(v), makeAddr("otherToken"));
        vm.expectRevert(ConvictionVault.AlreadyBound.selector); // once: never rebound to another token
        v.initialize(address(other));
        vm.stopPrank();
    }

    // ---------- recommit (holding always beats churning) ----------

    function test_recommit_rules() public {
        uint256 id = _lock(alice, L, 1); // 3 d term
        vm.warp(block.timestamp + 3 days - 1);
        vm.prank(alice);
        vm.expectRevert(ConvictionVault.TooEarly.selector);
        vault.recommit(_ids(id), 2);
        vm.warp(block.timestamp + 1);
        vm.prank(bob);
        vm.expectRevert(ConvictionVault.NotOwner.selector);
        vault.recommit(_ids(id), 2);
        vm.prank(alice);
        vm.expectRevert(ConvictionVault.BadTier.selector);
        vault.recommit(_ids(id), 3);
        uint256 t1 = block.timestamp;
        vm.expectEmit(address(vault));
        emit ConvictionVault.Recommitted(id, 2, t1);
        vm.prank(alice);
        vault.recommit(_ids(id), 2); // 7 d from now
        (uint256 ts, uint8 tier) = vault.termAt(id, block.timestamp);
        assertEq(ts, t1);
        assertEq(tier, 2);
        assertEq(vault.recommitCount(id), 1);
        assertEq(vault.positions(id).start, t1 - 3 days, "start untouched");
        vm.warp(t1 + 7 days - 1);
        vm.prank(alice);
        vm.expectRevert(ConvictionVault.TooEarly.selector); // withdraw blocked inside the new term
        vault.withdraw(_ids(id));
        vm.prank(alice);
        vm.expectRevert(ConvictionVault.TooEarly.selector);
        vault.recommit(_ids(id), 0);
        vm.warp(t1 + 7 days);
        vm.prank(alice);
        vault.withdraw(_ids(id));
        vm.prank(alice);
        vm.expectRevert(ConvictionVault.AlreadyWithdrawn.selector);
        vault.recommit(_ids(id), 0);
    }

    function test_recommit_weightSchedule() public {
        uint256 id = _lock(alice, L, 1);
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 3 days);
        assertEq(vault.currentWeight(id, block.timestamp), L * 250 / 100, "term over: x2 x1.25");
        vm.prank(alice);
        vault.recommit(_ids(id), 1);
        assertEq(vault.currentWeight(id, block.timestamp), L * 3125 / 1000, "x2.5 again, streak kept");
        assertEq(vault.currentWeight(id, t0 + 5 days), L * 375 / 100, "x2.5 x1.5: the streak steps inside the new term");
        assertEq(vault.currentWeight(id, t0 + 6 days - 1), L * 375 / 100, "until the new term ends");
        assertEq(vault.currentWeight(id, t0 + 6 days), L * 300 / 100, "new term over: x2 x1.5");
        assertEq(vault.currentWeight(id, t0 + 200 days), L * 400 / 100);
        assertEq(vault.currentWeight(id, t0 + 1 days), L * 250 / 100, "history: the first term at T");
    }

    /// Recommitting never loses to withdrawing and relocking with the same tier, at any later time.
    function testFuzz_recommitBeatsChurn(uint256 wait, uint8 tierRaw, uint256 laterRaw) public {
        uint8 tier = uint8(bound(tierRaw, 0, 2));
        uint256 a = _lock(alice, L, 0);
        uint256 b = _lock(bob, L, 0);
        vm.warp(block.timestamp + bound(wait, 7 days, 400 days));
        vm.prank(alice);
        vault.recommit(_ids(a), tier);
        vm.prank(bob);
        vault.withdraw(_ids(b));
        uint256 b2 = _lock(bob, L, tier);
        uint256 later = block.timestamp + bound(laterRaw, 0, 800 days);
        assertGe(vault.currentWeight(a, later), vault.currentWeight(b2, later), "weight");
        assertGe(vault.weightAt(a, later), vault.weightAt(b2, later), "vote weight");
        assertGt(vault.weightAt(a, block.timestamp + 1 hours), vault.weightAt(b2, block.timestamp + 1 hours));
    }

    /// A recommit after a ballot's start never changes the weight at that start (votes are stable).
    function testFuzz_recommit_voteWeightStable(uint256 wait, uint256 afterB, uint8 tierRaw) public {
        uint256 id = _lock(alice, L, 0);
        vm.warp(block.timestamp + bound(wait, 7 days, 200 days));
        uint256 ballotStart = block.timestamp;
        uint256 before = vault.weightAt(id, ballotStart);
        vm.warp(block.timestamp + bound(afterB, 1, 72 hours));
        vm.prank(alice);
        vault.recommit(_ids(id), uint8(bound(tierRaw, 0, 2)));
        assertEq(vault.weightAt(id, ballotStart), before);
    }

    // ---------- gas ----------

    function test_gas_lockWithdraw() public {
        for (uint256 i; i < 300; ++i) {
            _lock(bob, L, 1);
        }
        vm.prank(alice);
        vault.lock(L, 1);
        uint256 lockGas = vm.lastFrameGas().gasTotalUsed;
        vm.warp(block.timestamp + 30 days);
        vm.prank(alice);
        vault.withdraw(_ids(301));
        uint256 withdrawGas = vm.lastFrameGas().gasTotalUsed;
        console.log("lock (id 301, incl. 21k intrinsic)", lockGas);
        console.log("withdraw 1 id", withdrawGas);
        assertLt(lockGas, 150_000);
    }
}

/// @dev Random lock / withdraw / recommit / warp across three holders.
contract VaultHandler is Test {
    ConvictionVault public vault;
    DNAToken public token;
    address[3] public actors;
    mapping(bytes32 => uint256) public calls;

    constructor(ConvictionVault v, DNAToken t, address[3] memory a) {
        (vault, token, actors) = (v, t, a);
    }

    function lock(uint256 who, uint256 amount, uint8 tier) external {
        amount = bound(amount, 10_000 ether, 1_000_000 ether);
        address a = actors[who % 3];
        if (token.balanceOf(a) < amount) return; // deep runs: never fail for harness reasons
        vm.prank(a);
        vault.lock(amount, tier % 3);
        calls["lock"]++;
    }

    function _due(uint256 idSeed) internal view returns (uint256 id, address owner) {
        uint256 n = vault.count();
        if (n == 0) return (0, address(0));
        id = 1 + idSeed % n;
        ConvictionVault.Position memory p = vault.positions(id);
        (uint256 ts, uint8 cur) = vault.termAt(id, block.timestamp);
        if (p.withdrawn || block.timestamp < ts + vault.term(cur)) return (0, address(0));
        owner = p.owner;
    }

    function withdraw(uint256 idSeed) external {
        (uint256 id, address owner) = _due(idSeed);
        if (id == 0) return;
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(owner);
        vault.withdraw(ids);
        calls["withdraw"]++;
    }

    function recommit(uint256 idSeed, uint8 tier) external {
        (uint256 id, address owner) = _due(idSeed);
        if (id == 0) return;
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(owner);
        vault.recommit(ids, tier % 3);
        calls["recommit"]++;
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1 hours, 4 days));
    }
}

contract ConvictionVaultInvariantTest is Test {
    DNAToken token;
    ConvictionVault vault;
    VaultHandler h;

    function setUp() public {
        vm.warp(1_760_000_000);
        token = new DNAToken(address(this));
        RolesRegistry reg = new RolesRegistry(makeAddr("safe"), makeAddr("agent"), makeAddr("anchor"));
        address[] memory none;
        vault = new ConvictionVault(IModuleRegistry(address(reg)), address(this), none);
        MockPot pot = new MockPot();
        pot.setVault(address(vault), address(token));
        vault.initialize(address(pot));
        address[3] memory a = [makeAddr("a"), makeAddr("b"), makeAddr("c")];
        h = new VaultHandler(vault, token, a);
        for (uint256 i; i < 3; ++i) {
            token.transfer(a[i], 100_000_000 ether);
            vm.prank(a[i]);
            token.approve(address(vault), type(uint256).max);
        }
        targetContract(address(h));
    }

    /// DNA held == totalLocked == Σ amount of positions not withdrawn; every live weight is in [x2, x4].
    function invariant_accountingAndWeightBounds() public view {
        uint256 n = vault.count();
        uint256 locked;
        for (uint256 i = 1; i <= n; ++i) {
            ConvictionVault.Position memory p = vault.positions(i);
            if (p.withdrawn) continue;
            locked += p.amount;
            uint256 w = vault.currentWeight(i, block.timestamp);
            assertGe(w, 2 * uint256(p.amount));
            assertLe(w, 4 * uint256(p.amount));
        }
        assertEq(vault.totalLocked(), locked);
        assertEq(token.balanceOf(address(vault)), locked);
    }

    function afterInvariant() external view {
        string[3] memory k = ["lock", "withdraw", "recommit"];
        for (uint256 i; i < k.length; ++i) {
            console.log(k[i], h.calls(bytes32(bytes(k[i]))));
        }
    }
}
