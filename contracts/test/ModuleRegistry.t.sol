// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ModuleRegistry} from "../src/ModuleRegistry.sol";
import {AdaptiveFee} from "../src/modules/AdaptiveFee.sol";
import {BaselineSplit} from "../src/modules/BaselineSplit.sol";
import {Route, SplitRoute} from "../src/interfaces/IDNA.sol";
import {ModuleRegistry as MR} from "../src/ModuleRegistry.sol";

/// @dev Minimal hook: records pushed routes, exposes a settable breaker (reset on setRoute, like DNAHook).
contract MockHook {
    Route internal _r;
    uint256 public pushes;
    uint32 public failCount;
    uint64 public windowStart;

    function setRoute(Route calldata r) external {
        _r = r;
        pushes++;
        (failCount, windowStart) = (0, 0);
    }

    function breaker() external view returns (uint32, uint64) {
        return (failCount, windowStart);
    }

    function trip(uint32 n) external {
        (failCount, windowStart) = (n, uint64(block.number));
    }

    function route() external view returns (Route memory) {
        return _r;
    }
}

contract ModuleRegistryTest is Test {
    ModuleRegistry reg;
    MockHook hook;
    address safe = makeAddr("safe");
    address agent = makeAddr("agent");
    address anchorKey = makeAddr("anchorKey");
    address init = makeAddr("initializer");
    address rando = makeAddr("rando");

    address feeA;
    address feeB;
    address splitA;

    bytes32[4] P; // in-bounds params
    bytes32[4] LO;
    bytes32[4] HI;

    function setUp() public {
        vm.warp(1_700_000_000);
        vm.roll(20_000_000);
        reg = new ModuleRegistry(safe, agent, anchorKey, 5, init);
        hook = new MockHook();
        vm.prank(init);
        reg.initialize(address(hook));
        feeA = address(new AdaptiveFee());
        feeB = address(new AdaptiveFee());
        splitA = address(new BaselineSplit());
        P = [bytes32(uint256(20_000)), bytes32(uint256(100)), bytes32(uint256(50_000)), bytes32(0)];
        LO = [bytes32(uint256(10_000)), bytes32(0), bytes32(uint256(20_000)), bytes32(0)];
        HI = [bytes32(uint256(30_000)), bytes32(uint256(1_000)), bytes32(uint256(50_000)), bytes32(0)];
    }

    // ---------------------------------------------------------------- helpers

    function _q(address who, ModuleRegistry.Op op, bytes memory data) internal returns (uint256 id) {
        vm.prank(who);
        id = reg.queue(op, data);
    }

    function _run(address who, ModuleRegistry.Op op, bytes memory data) internal {
        uint256 id = _q(who, op, data);
        vm.warp(block.timestamp + 1 hours);
        reg.execute(id);
    }

    function _register(address m, ModuleRegistry.Kind k) internal {
        _run(safe, ModuleRegistry.Op.Register, abi.encode(m, k, keccak256("spec"), P, LO, HI));
    }

    function _shadow(address m) internal {
        _run(safe, ModuleRegistry.Op.SetShadow, abi.encode(m));
    }

    function _canary(address m) internal {
        _run(safe, ModuleRegistry.Op.SetCanary, abi.encode(m, uint64(block.number), uint32(300), uint32(50)));
    }

    function _promote(address m) internal {
        _run(safe, ModuleRegistry.Op.PromoteActive, abi.encode(m));
    }

    function _active(address m, ModuleRegistry.Kind k) internal {
        _register(m, k);
        _shadow(m);
        _canary(m);
        _promote(m);
    }

    /// @dev Lowering is immediate; raising goes through the queue (no rollback yet in these tests, so no 5-day wait).
    function _setLevel(uint8 n) internal {
        if (n < reg.level()) {
            vm.prank(safe);
            reg.lowerLevel(n);
        } else if (n > reg.level()) {
            _run(safe, ModuleRegistry.Op.SetLevel, abi.encode(n));
        }
    }

    function _status(address m) internal view returns (ModuleRegistry.Status) {
        return reg.getModule(m).status;
    }

    function _expectExecRevert(address who, ModuleRegistry.Op op, bytes memory data, bytes memory err) internal {
        uint256 id = _q(who, op, data);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(err);
        reg.execute(id);
    }

    // ---------------------------------------------------------------- initialize

    function test_initialize_frontRunProof() public {
        ModuleRegistry r = new ModuleRegistry(safe, agent, anchorKey, 5, init);
        vm.prank(rando);
        vm.expectRevert(ModuleRegistry.Unauthorized.selector);
        r.initialize(address(hook));
        vm.prank(init);
        vm.expectRevert(ModuleRegistry.NoCode.selector);
        r.initialize(rando);
        vm.prank(init);
        r.initialize(address(hook));
        assertEq(r.hook(), address(hook));
        vm.prank(init);
        vm.expectRevert(ModuleRegistry.AlreadyInitialized.selector);
        r.initialize(address(hook));
    }

    function test_routeOpsNeedHook() public {
        ModuleRegistry r = new ModuleRegistry(safe, agent, anchorKey, 5, init);
        vm.prank(safe);
        uint256 id =
            r.queue(ModuleRegistry.Op.Register, abi.encode(feeA, ModuleRegistry.Kind.Fee, bytes32(0), P, LO, HI));
        vm.warp(block.timestamp + 1 hours);
        r.execute(id);
        vm.prank(safe);
        id = r.queue(ModuleRegistry.Op.SetShadow, abi.encode(feeA));
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(ModuleRegistry.NotInitialized.selector);
        r.execute(id);
    }

    // ---------------------------------------------------------------- roles

    function test_roles() public {
        assertEq(reg.safe(), safe);
        vm.startPrank(rando);
        vm.expectRevert(ModuleRegistry.Unauthorized.selector);
        reg.queue(ModuleRegistry.Op.SetShadow, abi.encode(feeA));
        vm.expectRevert(ModuleRegistry.Unauthorized.selector);
        reg.pauseAgent();
        vm.expectRevert(ModuleRegistry.Unauthorized.selector);
        reg.lowerLevel(0);
        vm.expectRevert(ModuleRegistry.Unauthorized.selector);
        reg.cancel(new uint256[](0));
        vm.expectRevert(ModuleRegistry.Unauthorized.selector);
        reg.rollback(ModuleRegistry.Kind.Fee);
        vm.expectRevert(ModuleRegistry.Unauthorized.selector);
        reg.anchor(bytes32(0), "");
        vm.stopPrank();
    }

    function test_anchor() public {
        vm.expectEmit(address(reg));
        emit ModuleRegistry.Anchored(keccak256("root"), "ipfs://x");
        vm.prank(anchorKey);
        reg.anchor(keccak256("root"), "ipfs://x");
    }

    function test_rotateAgentAndAnchorKey() public {
        address a2 = makeAddr("agent2");
        address k2 = makeAddr("key2");
        uint256 old = _q(agent, ModuleRegistry.Op.SetShadow, abi.encode(feeA));
        _run(safe, ModuleRegistry.Op.SetAgent, abi.encode(a2));
        _run(safe, ModuleRegistry.Op.SetAnchorKey, abi.encode(k2));
        assertEq(reg.agent(), a2);
        assertEq(reg.anchorKey(), k2);
        // old agent's pending op is dead
        vm.expectRevert(ModuleRegistry.Unauthorized.selector);
        reg.execute(old);
        vm.prank(agent);
        vm.expectRevert(ModuleRegistry.Unauthorized.selector);
        reg.queue(ModuleRegistry.Op.SetShadow, "");
        vm.prank(anchorKey);
        vm.expectRevert(ModuleRegistry.Unauthorized.selector);
        reg.anchor(0, "");
        vm.prank(k2);
        reg.anchor(0, "");
    }

    // ---------------------------------------------------------------- queue

    function test_queueDelay() public {
        uint256 id =
            _q(safe, ModuleRegistry.Op.Register, abi.encode(feeA, ModuleRegistry.Kind.Fee, bytes32(0), P, LO, HI));
        vm.warp(block.timestamp + 1 hours - 1);
        vm.expectRevert(ModuleRegistry.TooEarly.selector);
        reg.execute(id);
        vm.warp(block.timestamp + 1);
        vm.prank(rando); // anyone executes
        reg.execute(id);
        assertEq(uint8(_status(feeA)), uint8(ModuleRegistry.Status.Proposed));
        vm.expectRevert(ModuleRegistry.UnknownOp.selector);
        reg.execute(id);
        vm.expectRevert(ModuleRegistry.UnknownOp.selector);
        reg.execute(999);
    }

    /// Agent ops get the same 1 h veto window as Safe ops: not executable at queuedAt + 1 h − 1, executable at + 1 h.
    function test_agentOpDelayOneHour() public {
        _register(feeA, ModuleRegistry.Kind.Fee);
        uint256 t = block.timestamp;
        uint256 id = _q(agent, ModuleRegistry.Op.SetShadow, abi.encode(feeA));
        assertEq(reg.MIN_DELAY(), 1 hours);
        vm.warp(t + 1 hours - 1);
        vm.expectRevert(ModuleRegistry.TooEarly.selector);
        reg.execute(id);
        vm.warp(t + 1 hours);
        reg.execute(id);
        assertEq(uint8(_status(feeA)), uint8(ModuleRegistry.Status.Shadow));
    }

    function testFuzz_noExecuteBeforeDelay(uint256 dt) public {
        dt = bound(dt, 0, 1 hours - 1);
        uint256 id = _q(safe, ModuleRegistry.Op.SetLevel, abi.encode(uint8(6)));
        vm.warp(block.timestamp + dt);
        vm.expectRevert(ModuleRegistry.TooEarly.selector);
        reg.execute(id);
    }

    function test_batchCancel() public {
        uint256[] memory ids = new uint256[](3);
        ids[0] = _q(agent, ModuleRegistry.Op.SetShadow, abi.encode(feeA));
        ids[1] = _q(agent, ModuleRegistry.Op.SetShadow, abi.encode(feeB));
        ids[2] = _q(safe, ModuleRegistry.Op.SetLevel, abi.encode(uint8(6)));
        assertEq(reg.pendingOf(agent), 2);
        vm.prank(agent);
        vm.expectRevert(ModuleRegistry.Unauthorized.selector);
        reg.cancel(ids);
        vm.prank(safe);
        reg.cancel(ids);
        assertEq(reg.pendingOf(agent), 0);
        vm.warp(block.timestamp + 1 hours);
        for (uint256 i; i < 3; i++) {
            vm.expectRevert(ModuleRegistry.UnknownOp.selector);
            reg.execute(ids[i]);
        }
        vm.prank(safe);
        vm.expectRevert(ModuleRegistry.UnknownOp.selector);
        reg.cancel(ids);
    }

    // ---------------------------------------------------------------- agent limits

    function test_agentMaxPending() public {
        for (uint256 i; i < 8; i++) {
            _q(agent, ModuleRegistry.Op.SetShadow, abi.encode(feeA));
        }
        vm.prank(agent);
        vm.expectRevert(ModuleRegistry.TooManyPending.selector);
        reg.queue(ModuleRegistry.Op.SetShadow, abi.encode(feeA));
        // executing or cancelling frees a slot
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        vm.prank(safe);
        reg.cancel(ids);
        _q(agent, ModuleRegistry.Op.SetShadow, abi.encode(feeA));
    }

    function test_agentPause() public {
        _register(feeA, ModuleRegistry.Kind.Fee);
        uint256 id = _q(agent, ModuleRegistry.Op.SetShadow, abi.encode(feeA));
        vm.prank(safe);
        reg.pauseAgent();
        assertTrue(reg.agentPaused());
        vm.prank(agent);
        vm.expectRevert(ModuleRegistry.AgentIsPaused.selector);
        reg.queue(ModuleRegistry.Op.SetShadow, abi.encode(feeA));
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(ModuleRegistry.AgentIsPaused.selector);
        reg.execute(id);
        _active(feeB, ModuleRegistry.Kind.Fee);
        vm.prank(agent);
        vm.expectRevert(ModuleRegistry.AgentIsPaused.selector);
        reg.rollback(ModuleRegistry.Kind.Fee);
        // unpause only via the queue
        _run(safe, ModuleRegistry.Op.UnpauseAgent, "");
        assertFalse(reg.agentPaused());
        reg.execute(id);
        assertEq(uint8(_status(feeA)), uint8(ModuleRegistry.Status.Shadow));
    }

    function test_agentLevelBitmaps() public {
        _register(feeA, ModuleRegistry.Kind.Fee);
        vm.prank(safe);
        reg.lowerLevel(4);
        _q(agent, ModuleRegistry.Op.SetShadow, abi.encode(feeA));
        vm.prank(agent);
        vm.expectRevert(ModuleRegistry.NotAllowedAtLevel.selector);
        reg.queue(ModuleRegistry.Op.SetParams, abi.encode(feeA, P));
        vm.prank(safe);
        reg.lowerLevel(3);
        vm.prank(agent);
        vm.expectRevert(ModuleRegistry.NotAllowedAtLevel.selector);
        reg.queue(ModuleRegistry.Op.SetShadow, abi.encode(feeA));
    }

    function test_lowerLevelNeutralisesPendingAgentOps() public {
        _register(feeA, ModuleRegistry.Kind.Fee);
        uint256 id = _q(agent, ModuleRegistry.Op.SetShadow, abi.encode(feeA));
        vm.prank(safe);
        reg.lowerLevel(3);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(ModuleRegistry.NotAllowedAtLevel.selector);
        reg.execute(id);
        vm.prank(safe);
        vm.expectRevert(ModuleRegistry.NotLower.selector);
        reg.lowerLevel(3);
    }

    /// Agent can queue an op on an unregistered (Fee-default) target iff its Op bit is in the level's constant bitmap;
    /// forbidden ops never pass. (Register needs an approved codehash on top: covered by the ladder tests.)
    function testFuzz_agentOpBitmap(uint8 lvl, uint8 rawOp) public {
        lvl = uint8(bound(lvl, 0, 10));
        ModuleRegistry.Op op = ModuleRegistry.Op(bound(rawOp, 0, uint8(type(ModuleRegistry.Op).max)));
        vm.assume(op != ModuleRegistry.Op.Register);
        ModuleRegistry r = new ModuleRegistry(safe, agent, anchorKey, lvl, init);
        bool allowed = (lvl >= 4 && op == ModuleRegistry.Op.SetShadow)
            || (lvl >= 5 && (op == ModuleRegistry.Op.SetCanary || op == ModuleRegistry.Op.SetParams))
            || (lvl >= 8 && op == ModuleRegistry.Op.PromoteActive);
        vm.prank(agent);
        if (!allowed) vm.expectRevert(ModuleRegistry.NotAllowedAtLevel.selector);
        r.queue(op, abi.encode(feeA));
    }

    /// Agent calling any registry selector with any calldata never changes Safe-only state.
    function testFuzz_agentNeverGainsForbiddenPowers(bytes4 sel, bytes calldata tail, uint8 lvl) public {
        lvl = uint8(bound(lvl, 0, 10));
        ModuleRegistry r = new ModuleRegistry(safe, agent, anchorKey, lvl, init);
        vm.prank(agent);
        (bool ok,) = address(r).call(abi.encodePacked(sel, tail));
        ok;
        assertEq(r.level(), lvl);
        assertEq(r.agent(), agent);
        assertEq(r.anchorKey(), anchorKey);
        assertFalse(r.agentPaused());
        assertEq(r.hook(), address(0));
        // anything it queued is a bitmap op (or nothing)
        if (r.nextId() != 0) {
            (ModuleRegistry.Op op, address proposer,,) = r.queued(1);
            assertEq(proposer, agent);
            assertTrue(r.levelOps(lvl) & (1 << uint256(op)) != 0);
        }
    }

    /// Every Safe-only entry point reverts for the agent at every level.
    function testFuzz_agentForbiddenSelectors(uint8 lvl, uint8 which) public {
        lvl = uint8(bound(lvl, 0, 10));
        ModuleRegistry r = new ModuleRegistry(safe, agent, anchorKey, lvl, init);
        uint8 maxOp = uint8(type(ModuleRegistry.Op).max);
        bytes[6] memory calls = [
            abi.encodeCall(r.pauseAgent, ()),
            abi.encodeCall(r.lowerLevel, (0)),
            abi.encodeCall(r.cancel, (new uint256[](0))),
            abi.encodeCall(r.initialize, (address(hook))),
            abi.encodeCall(r.anchor, (bytes32(0), "")),
            abi.encodeCall(r.queue, (ModuleRegistry.Op(bound(which, 0, maxOp)), abi.encode(feeA)))
        ];
        uint256 i = bound(which, 0, 5);
        if (i == 5 && r.levelOps(lvl) & (1 << bound(which, 0, maxOp)) != 0) {
            return; // bitmap ops are covered by testFuzz_agentOpBitmap and the ladder tests
        }
        vm.prank(agent);
        (bool ok,) = address(r).call(calls[i]);
        assertFalse(ok);
    }

    // ---------------------------------------------------------------- status machine

    function test_happyPathFee() public {
        uint256 p0 = hook.pushes();
        _register(feeA, ModuleRegistry.Kind.Fee);
        assertEq(reg.getModule(feeA).codehash, feeA.codehash);
        _shadow(feeA);
        assertEq(hook.route().shadow, feeA);
        assertEq(hook.route().shadowParams[0], P[0]);
        _canary(feeA);
        Route memory r = hook.route();
        assertEq(r.canary, feeA);
        assertEq(r.shadow, address(0));
        assertEq(r.canaryLen, 50);
        assertEq(r.canaryPeriod, 300);
        _promote(feeA);
        r = hook.route();
        assertEq(r.active, feeA);
        assertEq(r.canary, address(0));
        assertEq(r.activeParams[2], P[2]);
        assertEq(uint8(_status(feeA)), uint8(ModuleRegistry.Status.Active));
        assertEq(hook.pushes(), p0 + 3); // every route change pushes
        assertEq(keccak256(abi.encode(reg.route())), keccak256(abi.encode(hook.route())));

        // promoting B sends A back to Proposed (not Retired)
        _active(feeB, ModuleRegistry.Kind.Fee);
        assertEq(uint8(_status(feeA)), uint8(ModuleRegistry.Status.Proposed));
        assertEq(hook.route().active, feeB);
    }

    /// A displaced shadow or canary returns to Proposed (so its plate can be reused), not Retired.
    function test_replacedShadowAndCanaryReturnToProposed() public {
        _register(feeA, ModuleRegistry.Kind.Fee);
        _register(feeB, ModuleRegistry.Kind.Fee);
        _shadow(feeA);
        _shadow(feeB);
        assertEq(uint8(_status(feeA)), uint8(ModuleRegistry.Status.Proposed));
        _canary(feeB);
        address feeC = address(new AdaptiveFee());
        _register(feeC, ModuleRegistry.Kind.Fee);
        _shadow(feeC);
        _canary(feeC);
        assertEq(uint8(_status(feeB)), uint8(ModuleRegistry.Status.Proposed));
        assertEq(hook.route().canary, feeC);
        _shadow(feeA); // both displaced plates are reusable without re-register
        _shadow(feeB);
        assertEq(uint8(_status(feeB)), uint8(ModuleRegistry.Status.Shadow));
    }

    function test_happyPathSplit() public {
        SplitRoute memory s = reg.splitRoute();
        assertEq(s.module, address(0)); // baseline
        uint256 p0 = hook.pushes();
        _active(splitA, ModuleRegistry.Kind.Split);
        s = reg.splitRoute();
        assertEq(s.module, splitA);
        assertEq(s.params[0], P[0]);
        assertEq(hook.pushes(), p0); // split never touches the hook
    }

    function test_illegalTransitions() public {
        bytes memory bad = abi.encodeWithSelector(ModuleRegistry.BadStatus.selector, ModuleRegistry.Status.None);
        _expectExecRevert(safe, ModuleRegistry.Op.SetShadow, abi.encode(feeA), bad);

        _register(feeA, ModuleRegistry.Kind.Fee);
        bad = abi.encodeWithSelector(ModuleRegistry.BadStatus.selector, ModuleRegistry.Status.Proposed);
        _expectExecRevert(safe, ModuleRegistry.Op.SetCanary, abi.encode(feeA, uint64(0), uint32(300), uint32(50)), bad);
        _expectExecRevert(safe, ModuleRegistry.Op.PromoteActive, abi.encode(feeA), bad);
        _expectExecRevert(
            safe, ModuleRegistry.Op.Register, abi.encode(feeA, ModuleRegistry.Kind.Fee, bytes32(0), P, LO, HI), bad
        );

        _shadow(feeA);
        bad = abi.encodeWithSelector(ModuleRegistry.BadStatus.selector, ModuleRegistry.Status.Shadow);
        _expectExecRevert(safe, ModuleRegistry.Op.SetShadow, abi.encode(feeA), bad);
        _expectExecRevert(safe, ModuleRegistry.Op.PromoteActive, abi.encode(feeA), bad);

        _canary(feeA);
        bad = abi.encodeWithSelector(ModuleRegistry.BadStatus.selector, ModuleRegistry.Status.Canary);
        _expectExecRevert(safe, ModuleRegistry.Op.SetShadow, abi.encode(feeA), bad);
        _expectExecRevert(safe, ModuleRegistry.Op.SetCanary, abi.encode(feeA, uint64(0), uint32(300), uint32(50)), bad);

        _promote(feeA);
        bad = abi.encodeWithSelector(ModuleRegistry.BadStatus.selector, ModuleRegistry.Status.Active);
        _expectExecRevert(safe, ModuleRegistry.Op.PromoteActive, abi.encode(feeA), bad);
        _expectExecRevert(safe, ModuleRegistry.Op.SetShadow, abi.encode(feeA), bad);

        // RolledBack is terminal until a fresh register
        vm.prank(safe);
        reg.rollback(ModuleRegistry.Kind.Fee);
        bad = abi.encodeWithSelector(ModuleRegistry.BadStatus.selector, ModuleRegistry.Status.RolledBack);
        _expectExecRevert(safe, ModuleRegistry.Op.SetShadow, abi.encode(feeA), bad);
        _expectExecRevert(safe, ModuleRegistry.Op.SetParams, abi.encode(feeA, P), bad);
        _register(feeA, ModuleRegistry.Kind.Fee);
        _shadow(feeA);
        assertEq(uint8(_status(feeA)), uint8(ModuleRegistry.Status.Shadow));
    }

    /// Retired is unreachable. A promotion sends the replaced active (Fee and Split) back to
    /// Proposed, reusable without re-register; a Proposed module can't be re-registered.
    function test_retiredUnreachable_replacedActiveReusable() public {
        _active(feeA, ModuleRegistry.Kind.Fee);
        _active(feeB, ModuleRegistry.Kind.Fee);
        assertEq(uint8(_status(feeA)), uint8(ModuleRegistry.Status.Proposed));
        bytes memory bad = abi.encodeWithSelector(ModuleRegistry.BadStatus.selector, ModuleRegistry.Status.Proposed);
        _expectExecRevert(
            safe, ModuleRegistry.Op.Register, abi.encode(feeA, ModuleRegistry.Kind.Fee, bytes32(0), P, LO, HI), bad
        );
        _shadow(feeA);
        _canary(feeA);
        _promote(feeA); // A back in charge, B back to Proposed
        assertEq(hook.route().active, feeA);
        assertEq(uint8(_status(feeB)), uint8(ModuleRegistry.Status.Proposed));

        address splitB = address(new BaselineSplit());
        _active(splitA, ModuleRegistry.Kind.Split);
        _active(splitB, ModuleRegistry.Kind.Split);
        assertEq(uint8(_status(splitA)), uint8(ModuleRegistry.Status.Proposed));
        assertEq(reg.splitRoute().module, splitB);
    }

    function test_promoteActiveAndRegisterNotAtLevel5() public {
        vm.prank(agent);
        vm.expectRevert(ModuleRegistry.NotAllowedAtLevel.selector);
        reg.queue(ModuleRegistry.Op.PromoteActive, abi.encode(feeA));
        vm.prank(agent);
        vm.expectRevert(ModuleRegistry.NotAllowedAtLevel.selector);
        reg.queue(ModuleRegistry.Op.Register, "");
    }

    function test_registerNeedsCode() public {
        _expectExecRevert(
            safe,
            ModuleRegistry.Op.Register,
            abi.encode(rando, ModuleRegistry.Kind.Fee, bytes32(0), P, LO, HI),
            abi.encodeWithSelector(ModuleRegistry.NoCode.selector)
        );
    }

    function test_codehashPin() public {
        _register(feeA, ModuleRegistry.Kind.Fee);
        vm.etch(feeA, address(new BaselineSplit()).code);
        _expectExecRevert(
            safe,
            ModuleRegistry.Op.SetShadow,
            abi.encode(feeA),
            abi.encodeWithSelector(ModuleRegistry.CodehashChanged.selector)
        );
    }

    // ---------------------------------------------------------------- params

    function test_paramsBoundsAndEpoch() public {
        // out of bounds at register
        bytes32[4] memory hi = P;
        hi[1] = bytes32(uint256(1_001));
        _expectExecRevert(
            safe,
            ModuleRegistry.Op.Register,
            abi.encode(feeA, ModuleRegistry.Kind.Fee, bytes32(0), hi, LO, HI),
            abi.encodeWithSelector(ModuleRegistry.OutOfBounds.selector, 1)
        );
        _active(feeA, ModuleRegistry.Kind.Fee);
        _setLevel(6); // agent SetParams on the active fee module needs level 6

        bytes32[4] memory lo = P;
        lo[0] = bytes32(uint256(9_999));
        _expectExecRevert(
            agent,
            ModuleRegistry.Op.SetParams,
            abi.encode(feeA, lo),
            abi.encodeWithSelector(ModuleRegistry.OutOfBounds.selector, 0)
        );

        // two in-bounds changes queued together: only one executes per 1 h epoch
        bytes32[4] memory p2 = P;
        p2[1] = bytes32(uint256(500));
        uint256 a = _q(agent, ModuleRegistry.Op.SetParams, abi.encode(feeA, p2));
        uint256 b = _q(agent, ModuleRegistry.Op.SetParams, abi.encode(feeA, P));
        vm.warp(block.timestamp + 1 hours);
        uint256 pushes = hook.pushes();
        reg.execute(a);
        assertEq(hook.route().activeParams[1], p2[1]);
        assertEq(hook.pushes(), pushes + 1);
        vm.expectRevert(ModuleRegistry.ParamsEpoch.selector);
        reg.execute(b);
        vm.warp(block.timestamp + 1 hours - 1); // epoch boundary: paramsAt + 1 h
        vm.expectRevert(ModuleRegistry.ParamsEpoch.selector);
        reg.execute(b);
        vm.warp(block.timestamp + 1);
        reg.execute(b);
        assertEq(hook.route().activeParams[1], P[1]);
        assertEq(reg.getModule(feeA).params[1], P[1]);
    }

    /// Agent ops on split modules need level 9.
    function test_splitParamsUpdateSplitRoute() public {
        _active(splitA, ModuleRegistry.Kind.Split);
        bytes32[4] memory p2 = P;
        p2[0] = bytes32(uint256(11_000));
        _setLevel(8);
        vm.prank(agent);
        vm.expectRevert(ModuleRegistry.NotAllowedAtLevel.selector);
        reg.queue(ModuleRegistry.Op.SetParams, abi.encode(splitA, p2));
        _setLevel(9);
        _run(agent, ModuleRegistry.Op.SetParams, abi.encode(splitA, p2));
        assertEq(reg.splitRoute().params[0], p2[0]);
    }

    // ---------------------------------------------------------------- canary window

    function test_canaryWindowMin() public {
        _register(feeA, ModuleRegistry.Kind.Fee);
        _shadow(feeA);
        bytes memory bw = abi.encodeWithSelector(ModuleRegistry.BadWindow.selector);
        _expectExecRevert(agent, ModuleRegistry.Op.SetCanary, abi.encode(feeA, uint64(0), uint32(300), uint32(49)), bw);
        _expectExecRevert(agent, ModuleRegistry.Op.SetCanary, abi.encode(feeA, uint64(0), uint32(50), uint32(50)), bw);
        _run(agent, ModuleRegistry.Op.SetCanary, abi.encode(feeA, uint64(0), uint32(51), uint32(50)));
        assertEq(hook.route().canaryLen, 50);
    }

    // ---------------------------------------------------------------- level

    function test_levelRaisePredicate() public {
        _run(safe, ModuleRegistry.Op.SetLevel, abi.encode(uint8(6))); // no rollback yet: allowed
        assertEq(reg.level(), 6);
        _active(feeA, ModuleRegistry.Kind.Fee);
        vm.prank(safe);
        reg.rollback(ModuleRegistry.Kind.Fee);
        assertEq(reg.level(), 6); // rollback never lowers the level
        uint256 rb = reg.lastRollbackBlock();
        assertEq(rb, block.number);

        uint256 id = _q(safe, ModuleRegistry.Op.SetLevel, abi.encode(uint8(7)));
        vm.warp(block.timestamp + 1 hours);
        vm.roll(rb + 5 * 7200 - 1);
        vm.expectRevert(ModuleRegistry.RaiseTooSoon.selector);
        reg.execute(id);
        // lowering through the queue is always fine
        _run(safe, ModuleRegistry.Op.SetLevel, abi.encode(uint8(5)));
        assertEq(reg.level(), 5);
        vm.roll(rb + 5 * 7200);
        reg.execute(id);
        assertEq(reg.level(), 7);
    }

    function test_agentCannotQueueSetLevel() public {
        vm.prank(agent);
        vm.expectRevert(ModuleRegistry.NotAllowedAtLevel.selector);
        reg.queue(ModuleRegistry.Op.SetLevel, abi.encode(uint8(9)));
    }

    // ---------------------------------------------------------------- rollback

    function test_rollbackSafe() public {
        _active(feeA, ModuleRegistry.Kind.Fee);
        _register(feeB, ModuleRegistry.Kind.Fee);
        _shadow(feeB);
        _canary(feeB);
        vm.prank(safe);
        reg.pauseAgent(); // Safe rollback works regardless
        uint256 pushes = hook.pushes();
        vm.prank(safe);
        reg.rollback(ModuleRegistry.Kind.Fee);
        Route memory r = hook.route();
        assertEq(r.active, address(0));
        assertEq(r.canary, address(0));
        assertEq(r.activeParams[0], bytes32(0));
        assertEq(r.canaryLen, 0);
        assertEq(hook.pushes(), pushes + 1);
        assertEq(uint8(_status(feeA)), uint8(ModuleRegistry.Status.RolledBack));
        assertEq(uint8(_status(feeB)), uint8(ModuleRegistry.Status.RolledBack));
        assertEq(reg.lastRollbackBlock(), block.number);
        vm.prank(safe);
        vm.expectRevert(ModuleRegistry.NothingToRollback.selector);
        reg.rollback(ModuleRegistry.Kind.Fee);
    }

    function test_rollbackSplit() public {
        _active(splitA, ModuleRegistry.Kind.Split);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(agent);
        reg.rollback(ModuleRegistry.Kind.Split);
        assertEq(reg.splitRoute().module, address(0));
        assertEq(uint8(_status(splitA)), uint8(ModuleRegistry.Status.RolledBack));
    }

    /// @dev Queues `op` for every module at once, then executes them all after one delay.
    function _runAll(ModuleRegistry.Op op, address[] memory ms, bool execute) internal returns (uint256[] memory ids) {
        ids = new uint256[](ms.length);
        for (uint256 i; i < ms.length; i++) {
            bytes memory d = op == ModuleRegistry.Op.Register
                ? abi.encode(ms[i], ModuleRegistry.Kind.Split, bytes32(0), P, LO, HI)
                : op == ModuleRegistry.Op.SetCanary
                    ? abi.encode(ms[i], uint64(0), uint32(300), uint32(50))
                    : abi.encode(ms[i]);
            ids[i] = _q(safe, op, d);
        }
        vm.warp(block.timestamp + 1 hours);
        if (execute) {
            for (uint256 i; i < ms.length; i++) {
                reg.execute(ids[i]);
            }
        }
    }

    function test_rollbackAgentLevelCooldownDailyCap() public {
        // Split modules have no slot contention, so five promotions can be pre-queued and fired on demand.
        address[] memory ms = new address[](5);
        for (uint256 i; i < 5; i++) {
            ms[i] = address(new BaselineSplit());
        }
        _runAll(ModuleRegistry.Op.Register, ms, true);
        _runAll(ModuleRegistry.Op.SetShadow, ms, true);
        _runAll(ModuleRegistry.Op.SetCanary, ms, true);
        uint256[] memory promote = _runAll(ModuleRegistry.Op.PromoteActive, ms, false);

        // level 4: no rollback power
        reg.execute(promote[0]);
        vm.prank(safe);
        reg.lowerLevel(4);
        vm.prank(agent);
        vm.expectRevert(ModuleRegistry.NotAllowedAtLevel.selector);
        reg.rollback(ModuleRegistry.Kind.Split);
        uint256 up = _q(safe, ModuleRegistry.Op.SetLevel, abi.encode(uint8(5)));
        vm.warp(block.timestamp + 1 hours);
        reg.execute(up);

        uint256 t0 = block.timestamp;
        vm.prank(agent);
        reg.rollback(ModuleRegistry.Kind.Split); // #1
        reg.execute(promote[1]);
        vm.warp(t0 + 1 hours - 1);
        vm.prank(agent);
        vm.expectRevert(ModuleRegistry.Cooldown.selector);
        reg.rollback(ModuleRegistry.Kind.Split);
        vm.warp(t0 + 1 hours);
        vm.prank(agent);
        reg.rollback(ModuleRegistry.Kind.Split); // #2
        reg.execute(promote[2]);
        vm.warp(t0 + 2 hours);
        vm.prank(agent);
        reg.rollback(ModuleRegistry.Kind.Split); // #3
        reg.execute(promote[3]);
        vm.warp(t0 + 24 hours - 1);
        vm.prank(agent);
        vm.expectRevert(ModuleRegistry.DailyCap.selector); // #1..#3 inside a rolling 24 h
        reg.rollback(ModuleRegistry.Kind.Split);
        vm.warp(t0 + 24 hours);
        vm.prank(agent);
        reg.rollback(ModuleRegistry.Kind.Split); // #1 aged out
        assertEq(reg.level(), 5); // rollbacks never lower the level
    }

    function test_rollbackBreaker() public {
        _active(feeA, ModuleRegistry.Kind.Fee);
        hook.trip(2);
        vm.prank(rando);
        vm.expectRevert(ModuleRegistry.Unauthorized.selector);
        reg.rollback(ModuleRegistry.Kind.Fee);
        hook.trip(3);
        vm.prank(rando);
        vm.expectRevert(ModuleRegistry.Unauthorized.selector); // breaker never covers Split
        reg.rollback(ModuleRegistry.Kind.Split);
        vm.prank(rando);
        reg.rollback(ModuleRegistry.Kind.Fee);
        assertEq(hook.route().active, address(0));
        assertEq(uint8(_status(feeA)), uint8(ModuleRegistry.Status.RolledBack));
        (uint32 n,) = hook.breaker();
        assertEq(n, 0); // route push reset the breaker: no repeat
        // paused agent / quota untouched: breaker path costs the agent nothing
        assertEq(reg.agentRollbacks(0), 0);
    }

    function test_breakerOpenToPausedAgentToo() public {
        _active(feeA, ModuleRegistry.Kind.Fee);
        vm.prank(safe);
        reg.pauseAgent();
        hook.trip(3);
        vm.prank(agent);
        reg.rollback(ModuleRegistry.Kind.Fee);
        assertEq(hook.route().active, address(0));
    }

    function test_executeBlockedWhileBreakerTripped() public {
        _active(feeA, ModuleRegistry.Kind.Fee);
        vm.prank(safe);
        uint256 id = reg.queue(ModuleRegistry.Op.UnpauseAgent, "");
        vm.warp(block.timestamp + 1 hours);
        hook.trip(3);
        vm.expectRevert(ModuleRegistry.BreakerTripped.selector);
        reg.execute(id);
        vm.prank(rando);
        reg.rollback(ModuleRegistry.Kind.Fee);
        reg.execute(id);
    }

    // ---------------------------------------------------------------- autonomy ladder (L4–L10)

    function test_ladderBitmaps() public view {
        uint256 l4 = 1 << uint256(MR.Op.SetShadow);
        uint256 l5 = l4 | (1 << uint256(MR.Op.SetCanary)) | (1 << uint256(MR.Op.SetParams)) | reg.ROLLBACK_BIT()
            | reg.END_CANARY_BIT();
        uint256 l6 = l5 | reg.ACTIVE_PARAMS_BIT();
        uint256 l8 = l6 | (1 << uint256(MR.Op.PromoteActive));
        uint256 l9 = l8 | reg.SPLIT_BIT();
        uint256 l10 = l9 | (1 << uint256(MR.Op.Register));
        uint256[11] memory want = [uint256(0), 0, 0, 0, l4, l5, l6, l6, l8, l9, l10];
        uint256 never;
        for (uint256 o = uint256(MR.Op.SetAgent); o <= uint256(type(MR.Op).max); o++) {
            never |= 1 << o; // SetAgent, SetAnchorKey, SetLevel, UnpauseAgent, ApproveCodehash, RevokeCodehash
        }
        for (uint8 i; i <= 10; i++) {
            assertEq(reg.levelOps(i), want[i]);
            assertEq(reg.levelOps(i) & never, 0);
        }
        assertEq(reg.L10_OPS(), l10);
    }

    function test_maxLevel10() public {
        vm.expectRevert(MR.BadLevel.selector);
        new ModuleRegistry(safe, agent, anchorKey, 11, init);
        _expectExecRevert(safe, MR.Op.SetLevel, abi.encode(uint8(11)), abi.encodeWithSelector(MR.BadLevel.selector));
        _setLevel(10);
        assertEq(reg.level(), 10);
    }

    /// @dev 0 active fee · 1 canary fee · 2 shadow fee · 3 proposed fee · 4 proposed split · 5 shadow split ·
    ///      6 canary split. AdaptiveFee bytecode approved for agent registration with bounds [LO, HI].
    function _ladderSetup() internal returns (address[7] memory m) {
        m = [
            feeA,
            feeB,
            address(new AdaptiveFee()),
            address(new AdaptiveFee()),
            splitA,
            address(new BaselineSplit()),
            address(new BaselineSplit())
        ];
        _active(m[0], MR.Kind.Fee);
        for (uint256 i = 1; i < 7; i++) {
            _register(m[i], i < 4 ? MR.Kind.Fee : MR.Kind.Split);
        }
        _shadow(m[1]);
        _canary(m[1]);
        _shadow(m[2]);
        _shadow(m[5]);
        _shadow(m[6]);
        _canary(m[6]);
        _run(safe, MR.Op.ApproveCodehash, abi.encode(feeA.codehash, MR.Kind.Fee, LO, HI));
    }

    /// @dev Agent queues `op`. Accepted → the Safe cancels it (keeps the pending cap free), returns true. Refused → the
    ///      revert must be exactly `err`.
    function _probe(MR.Op op, bytes memory data, bytes4 err) internal returns (bool) {
        vm.prank(agent);
        try reg.queue(op, data) returns (uint256 id) {
            uint256[] memory ids = new uint256[](1);
            ids[0] = id;
            vm.prank(safe);
            reg.cancel(ids);
            return true;
        } catch (bytes memory e) {
            assertEq(bytes4(e), err, "refused with the wrong error");
            return false;
        }
    }

    /// @dev Immediate agent call on a state snapshot (rollback / endCanary are destructive).
    function _probeNow(bytes memory call) internal returns (bool ok) {
        uint256 snap = vm.snapshotState();
        vm.prank(agent);
        (ok,) = address(reg).call(call);
        vm.revertToState(snap);
    }

    /// Every capability appears at exactly its level: allowed at L, refused at L − 1 (walking 10 → 0).
    function test_ladderBoundaries() public {
        address[7] memory m = _ladderSetup();
        address fresh = address(new AdaptiveFee()); // approved bytecode, not registered
        address unapproved = address(new BaselineSplit());
        bytes4 na = MR.NotAllowedAtLevel.selector;
        bytes memory win = abi.encode(uint64(block.number), uint32(300), uint32(50));
        _setLevel(10);
        for (uint256 j = 11; j > 0; j--) {
            uint8 lvl = uint8(j - 1);
            _setLevel(lvl);
            assertEq(_probe(MR.Op.SetShadow, abi.encode(m[3]), na), lvl >= 4, "L4 shadow");
            assertEq(_probe(MR.Op.SetCanary, bytes.concat(abi.encode(m[2]), win), na), lvl >= 5, "L5 canary");
            assertEq(_probe(MR.Op.SetParams, abi.encode(m[3], P), na), lvl >= 5, "L5 params proposed");
            assertEq(_probe(MR.Op.SetParams, abi.encode(m[2], P), na), lvl >= 5, "L5 params shadow");
            assertEq(_probe(MR.Op.SetParams, abi.encode(m[1], P), na), lvl >= 5, "L5 params canary");
            assertEq(_probeNow(abi.encodeCall(reg.rollback, (MR.Kind.Fee))), lvl >= 5, "L5 rollback");
            assertEq(_probeNow(abi.encodeCall(reg.endCanary, ())), lvl >= 5, "L5 endCanary");
            assertEq(_probe(MR.Op.SetParams, abi.encode(m[0], P), na), lvl >= 6, "L6 params active");
            assertEq(_probe(MR.Op.PromoteActive, abi.encode(m[1]), na), lvl >= 8, "L8 promote fee");
            assertEq(_probe(MR.Op.SetShadow, abi.encode(m[4]), na), lvl >= 9, "L9 split shadow");
            assertEq(_probe(MR.Op.SetCanary, bytes.concat(abi.encode(m[5]), win), na), lvl >= 9, "L9 split canary");
            assertEq(_probe(MR.Op.PromoteActive, abi.encode(m[6]), na), lvl >= 9, "L9 split promote");
            assertEq(_probe(MR.Op.SetParams, abi.encode(m[4], P), na), lvl >= 9, "L9 split params");
            bytes memory d = abi.encode(fresh, MR.Kind.Fee, bytes32(0), P, LO, HI);
            assertEq(_probe(MR.Op.Register, d, na), lvl >= 10, "L10 register approved");
            d = abi.encode(unapproved, MR.Kind.Split, bytes32(0), P, LO, HI);
            assertFalse(_probe(MR.Op.Register, d, lvl >= 10 ? MR.NotApproved.selector : na), "unapproved");
            for (uint256 o = uint256(MR.Op.SetAgent); o <= uint256(type(MR.Op).max); o++) {
                assertFalse(_probe(MR.Op(o), abi.encode(agent), na), "Safe-only op");
            }
        }
    }

    /// Permission is re-judged at execute on current state: SetParams queued on the canary at L5 dies once the Safe
    /// promotes that module (now the active one: level 6 territory).
    function test_agentParamsRejudgedAtExecute() public {
        _register(feeA, MR.Kind.Fee);
        _shadow(feeA);
        _canary(feeA);
        bytes32[4] memory p2 = P;
        p2[1] = bytes32(uint256(500));
        uint256 id = _q(agent, MR.Op.SetParams, abi.encode(feeA, p2));
        _promote(feeA);
        vm.expectRevert(MR.NotAllowedAtLevel.selector);
        reg.execute(id);
        _setLevel(6);
        reg.execute(id);
        assertEq(hook.route().activeParams[1], p2[1]);
    }

    /// The level-8 agent promotes a fee canary through the queue; the old active returns to Proposed.
    function test_agentPromotesAtL8() public {
        _active(feeA, MR.Kind.Fee);
        _register(feeB, MR.Kind.Fee);
        _setLevel(8);
        _run(agent, MR.Op.SetShadow, abi.encode(feeB));
        _run(agent, MR.Op.SetCanary, abi.encode(feeB, uint64(block.number), uint32(300), uint32(50)));
        _run(agent, MR.Op.PromoteActive, abi.encode(feeB));
        assertEq(hook.route().active, feeB);
        assertEq(uint8(_status(feeA)), uint8(MR.Status.Proposed));
    }

    /// Kind re-judged at execute: an L8 agent's SetShadow queued on a (rolled-back) Fee module dies when the Safe
    /// re-registers that module as Split first (split ops need L9).
    function test_agentKindRejudgedAtExecute() public {
        _active(feeA, MR.Kind.Fee);
        _setLevel(8);
        vm.prank(safe);
        reg.rollback(MR.Kind.Fee);
        uint256 id = _q(agent, MR.Op.SetShadow, abi.encode(feeA));
        uint256 rr = _q(safe, MR.Op.Register, abi.encode(feeA, MR.Kind.Split, bytes32(0), P, LO, HI));
        vm.warp(block.timestamp + 1 hours);
        reg.execute(rr);
        assertEq(uint8(reg.getModule(feeA).kind), uint8(MR.Kind.Split));
        vm.expectRevert(MR.NotAllowedAtLevel.selector);
        reg.execute(id);
        vm.roll(block.number + 5 * 7200); // the rollback restarted the 5-day raise clock
        _setLevel(9); // the same op is fine once split ops are allowed
        reg.execute(id);
        assertEq(uint8(_status(feeA)), uint8(MR.Status.Shadow));
    }

    // ---------------------------------------------------------------- approved codehashes (L10)

    function test_approveCodehash_agentRegistersAtL10() public {
        bytes32 h = feeA.codehash;
        _setLevel(10);
        vm.prank(agent);
        vm.expectRevert(MR.NotAllowedAtLevel.selector); // never the agent's op
        reg.queue(MR.Op.ApproveCodehash, abi.encode(h, MR.Kind.Fee, LO, HI));
        vm.prank(agent);
        vm.expectRevert(MR.NotApproved.selector);
        reg.queue(MR.Op.Register, abi.encode(feeA, MR.Kind.Fee, bytes32(0), P, LO, HI));

        uint256 id = _q(safe, MR.Op.ApproveCodehash, abi.encode(h, MR.Kind.Fee, LO, HI));
        vm.warp(block.timestamp + 1 hours);
        vm.expectEmit(address(reg));
        emit MR.CodehashApproved(h, MR.Kind.Fee, LO, HI);
        reg.execute(id);
        MR.Approval memory a = reg.getApproval(h);
        assertTrue(a.ok);
        assertEq(a.maxParams[0], HI[0]);

        vm.prank(agent);
        vm.expectRevert(MR.NotApproved.selector); // kind is part of the approval
        reg.queue(MR.Op.Register, abi.encode(feeA, MR.Kind.Split, bytes32(0), P, LO, HI));
        bytes32[4] memory wide = HI;
        wide[0] = bytes32(uint256(30_001));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(MR.OutOfBounds.selector, 0)); // bounds inside the approved ones
        reg.queue(MR.Op.Register, abi.encode(feeA, MR.Kind.Fee, bytes32(0), P, LO, wide));

        bytes32[4] memory tight = LO;
        tight[0] = bytes32(uint256(15_000));
        _run(agent, MR.Op.Register, abi.encode(feeA, MR.Kind.Fee, keccak256("spec"), P, tight, HI));
        assertEq(uint8(_status(feeA)), uint8(MR.Status.Proposed)); // like any other registration
        assertEq(reg.getModule(feeA).minParams[0], tight[0]);
        _run(agent, MR.Op.SetShadow, abi.encode(feeA));
        assertEq(hook.route().shadow, feeA);
    }

    function test_revokeCodehash() public {
        bytes32 h = feeA.codehash;
        _setLevel(10);
        _run(safe, MR.Op.ApproveCodehash, abi.encode(h, MR.Kind.Fee, LO, HI));
        bytes memory d = abi.encode(feeA, MR.Kind.Fee, bytes32(0), P, LO, HI);
        uint256 id = _q(agent, MR.Op.Register, d);
        uint256 id2 = _q(agent, MR.Op.Register, abi.encode(feeB, MR.Kind.Fee, bytes32(0), P, LO, HI));
        uint256 rv = _q(safe, MR.Op.RevokeCodehash, abi.encode(h));
        vm.warp(block.timestamp + 1 hours);
        vm.expectEmit(address(reg));
        emit MR.CodehashRevoked(h);
        reg.execute(rv);
        assertFalse(reg.getApproval(h).ok);
        vm.expectRevert(MR.NotApproved.selector); // revoked between queue and execute
        reg.execute(id);
        vm.prank(agent);
        vm.expectRevert(MR.NotApproved.selector);
        reg.queue(MR.Op.Register, d);

        // re-approved, but the module's code changed after the agent queued: judged on the live codehash
        _run(safe, MR.Op.ApproveCodehash, abi.encode(h, MR.Kind.Fee, LO, HI));
        vm.etch(feeB, address(new BaselineSplit()).code);
        vm.expectRevert(MR.NotApproved.selector);
        reg.execute(id2);

        _register(feeA, MR.Kind.Fee); // the Safe registers regardless of approvals
    }

    function test_approveCodehash_boundsOrdered() public {
        _expectExecRevert(
            safe,
            MR.Op.ApproveCodehash,
            abi.encode(feeA.codehash, MR.Kind.Fee, HI, LO),
            abi.encodeWithSelector(MR.OutOfBounds.selector, 0)
        );
    }

    // ---------------------------------------------------------------- endCanary + plate reuse

    function test_endCanary() public {
        _active(feeA, MR.Kind.Fee);
        _register(feeB, MR.Kind.Fee);
        _shadow(feeB);
        _canary(feeB);
        uint256 rb = reg.lastRollbackBlock();
        uint256 pushes = hook.pushes();
        vm.prank(rando);
        vm.expectRevert(MR.Unauthorized.selector);
        reg.endCanary();

        vm.expectEmit(address(reg));
        emit MR.CanaryEnded(feeB, agent);
        vm.prank(agent);
        reg.endCanary(); // immediate: no queue, same block
        Route memory r = hook.route();
        assertEq(r.canary, address(0));
        assertEq(r.canaryStart, 0);
        assertEq(r.canaryPeriod, 0);
        assertEq(r.canaryLen, 0);
        assertEq(r.canaryParams[0], bytes32(0));
        assertEq(r.active, feeA);
        assertEq(hook.pushes(), pushes + 1);
        assertEq(keccak256(abi.encode(reg.route())), keccak256(abi.encode(r)));
        assertEq(uint8(_status(feeB)), uint8(MR.Status.Proposed));
        assertEq(uint8(_status(feeA)), uint8(MR.Status.Active));
        // not a rollback: neither the 5-day clock nor the agent's quota moved
        assertEq(reg.lastRollbackBlock(), rb);
        for (uint256 i; i < 3; i++) {
            assertEq(reg.agentRollbacks(i), 0);
        }
        assertEq(reg.agentRollbackIdx(), 0);
        vm.prank(agent);
        reg.rollback(MR.Kind.Fee); // no cooldown from endCanary
        vm.prank(agent);
        vm.expectRevert(MR.NoCanary.selector);
        reg.endCanary();
    }

    function test_endCanary_reusableSafePausedLevelBreaker() public {
        _register(feeA, MR.Kind.Fee);
        _shadow(feeA);
        _canary(feeA);
        vm.prank(safe);
        reg.endCanary();
        bytes memory bad = abi.encodeWithSelector(MR.BadStatus.selector, MR.Status.Proposed);
        _expectExecRevert(safe, MR.Op.PromoteActive, abi.encode(feeA), bad); // an ended plate can't skip ahead
        _shadow(feeA); // reusable without re-register
        _canary(feeA);
        assertEq(hook.route().canary, feeA);

        vm.prank(safe);
        reg.pauseAgent();
        vm.prank(agent);
        vm.expectRevert(MR.AgentIsPaused.selector);
        reg.endCanary();
        _run(safe, MR.Op.UnpauseAgent, "");
        _setLevel(4);
        vm.prank(agent);
        vm.expectRevert(MR.NotAllowedAtLevel.selector);
        reg.endCanary();

        hook.trip(3); // a route push would reset the breaker: only rollback may change the route now
        vm.prank(safe);
        vm.expectRevert(MR.BreakerTripped.selector);
        reg.endCanary();
        vm.prank(rando);
        reg.rollback(MR.Kind.Fee);
        assertEq(uint8(_status(feeA)), uint8(MR.Status.RolledBack)); // rollback stays terminal
    }

    /// @dev Fee slot invariant: status Shadow/Canary/Active iff the module sits in that route slot.
    function _assertSlots(address[3] memory pl) internal view {
        Route memory r = reg.route();
        for (uint256 i; i < 3; i++) {
            MR.Status st = _status(pl[i]);
            assertEq(st == MR.Status.Shadow, r.shadow == pl[i], "shadow slot");
            assertEq(st == MR.Status.Canary, r.canary == pl[i], "canary slot");
            assertEq(st == MR.Status.Active, r.active == pl[i], "active slot");
            assertTrue(st != MR.Status.Retired && st != MR.Status.RolledBack, "plate lost");
        }
    }

    /// Three plates rotate shadow → canary → displaced / ended → Proposed → shadow again, never re-registered.
    function test_plateRotation() public {
        address[3] memory pl = [feeA, feeB, address(new AdaptiveFee())];
        for (uint256 i; i < 3; i++) {
            _register(pl[i], MR.Kind.Fee);
        }
        for (uint256 round; round < 6; round++) {
            (address x, address y, address z) = (pl[round % 3], pl[(round + 1) % 3], pl[(round + 2) % 3]);
            _shadow(x);
            _shadow(y); // displaces x
            assertEq(uint8(_status(x)), uint8(MR.Status.Proposed));
            _assertSlots(pl);
            _run(agent, MR.Op.SetShadow, abi.encode(x)); // displaces y (the agent drives shadows from L4)
            assertEq(uint8(_status(y)), uint8(MR.Status.Proposed));
            _run(agent, MR.Op.SetCanary, abi.encode(x, uint64(block.number), uint32(300), uint32(50)));
            assertEq(uint8(_status(z)), uint8(MR.Status.Proposed)); // last round's canary (if any) displaced
            assertEq(hook.route().canary, x);
            _assertSlots(pl);
            if (round % 2 == 1) {
                vm.prank(agent);
                reg.endCanary();
                assertEq(uint8(_status(x)), uint8(MR.Status.Proposed));
                _assertSlots(pl);
            }
        }
        assertEq(reg.lastRollbackBlock(), 0);
        // the pin is re-checked on every advance of a reused plate
        vm.etch(pl[0], address(new BaselineSplit()).code);
        _expectExecRevert(safe, MR.Op.SetShadow, abi.encode(pl[0]), abi.encodeWithSelector(MR.CodehashChanged.selector));
    }

    // ---------------------------------------------------------------- agent never gains forbidden powers (live)

    /// Agent at any level 0–10, against a live registry (hook wired, every slot filled, an approved codehash), queues
    /// any op on any target and executes it, then calls any selector. Safe-only state never moves; whatever got queued
    /// was within its level's bitmap; Register only executed for approved bytecode at level 10.
    function testFuzz_agentNeverGainsForbiddenPowersLive(
        uint8 lvl,
        uint8 rawOp,
        uint256 who,
        bytes32 word,
        bytes4 sel,
        bytes calldata tail
    ) public {
        lvl = uint8(bound(lvl, 0, 10));
        address[7] memory m = _ladderSetup();
        _setLevel(lvl);
        MR.Op op = MR.Op(bound(rawOp, 0, uint8(type(MR.Op).max)));
        address t = who % 9 == 7 ? address(new AdaptiveFee()) : who % 9 == 8 ? rando : m[who % 9];
        bytes memory d;
        if (op == MR.Op.Register) d = abi.encode(t, MR.Kind((who >> 8) % 2), word, P, LO, HI);
        else if (op == MR.Op.SetCanary) d = abi.encode(t, uint64(block.number), uint32(300), uint32(50));
        else if (op == MR.Op.SetParams) d = abi.encode(t, P);
        else if (op == MR.Op.SetLevel) d = abi.encode(uint8(10));
        else if (op == MR.Op.ApproveCodehash) d = abi.encode(word, MR.Kind.Fee, LO, HI);
        else if (op == MR.Op.RevokeCodehash) d = abi.encode(feeA.codehash);
        else d = abi.encode(t);
        MR.Status before = _status(t);

        vm.prank(agent);
        try reg.queue(op, d) returns (uint256 id) {
            uint256 ops = reg.levelOps(lvl);
            assertTrue(ops & (1 << uint256(op)) != 0, "queued outside bitmap");
            if (op != MR.Op.Register && op <= MR.Op.SetParams) {
                if (reg.getModule(t).kind == MR.Kind.Split) assertTrue(ops & reg.SPLIT_BIT() != 0, "split");
                if (op == MR.Op.SetParams && before == MR.Status.Active) {
                    assertTrue(ops & reg.ACTIVE_PARAMS_BIT() != 0, "active params");
                }
            }
            vm.warp(block.timestamp + 1 hours);
            try reg.execute(id) {
                if (op == MR.Op.Register) {
                    assertEq(lvl, 10);
                    assertEq(t.codehash, feeA.codehash, "registered unapproved bytecode");
                }
            } catch {}
        } catch {}
        vm.prank(agent);
        (bool ok,) = address(reg).call(abi.encodePacked(sel, tail));
        ok;

        assertEq(reg.level(), lvl);
        assertEq(reg.agent(), agent);
        assertEq(reg.anchorKey(), anchorKey);
        assertFalse(reg.agentPaused());
        assertEq(reg.hook(), address(hook));
        assertTrue(reg.getApproval(feeA.codehash).ok, "agent revoked");
        if (word != feeA.codehash) assertFalse(reg.getApproval(word).ok, "agent approved");
    }
}
