// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDNAHook, IModuleRegistry, IInitializable, Route, SplitRoute} from "./interfaces/IDNA.sol";

/// @title ModuleRegistry — queue + roles + autonomy level + anchors (SPEC §3)
/// @notice Every change to DNA's fee/split modules goes through this contract's own 1 h queue. The Safe proposes
///         anything; the agent proposes only the ops its autonomy level allows. Ops are a closed set of internal
///         functions — the registry never makes arbitrary calls. Only `hook.setRoute` and `hook.breaker` are called.
/// @dev Invariant kept by the fee-kind slot logic: a Fee module has status Shadow/Canary/Active iff it sits in the
///      matching route slot. Split modules have no shadow/canary slot (FeeVault reads only `splitRoute()`), so for them
///      Shadow/Canary are status bookkeeping only.
contract ModuleRegistry is IModuleRegistry, IInitializable {
    enum Kind {
        Fee,
        Split
    }

    enum Status {
        None,
        Proposed,
        Shadow,
        Canary,
        Active,
        Retired, // unreachable since plate reuse (displaced modules return to Proposed); kept for ABI stability
        RolledBack
    }

    enum Op {
        Register,
        SetShadow,
        SetCanary,
        PromoteActive,
        SetParams,
        SetAgent,
        SetAnchorKey,
        SetLevel,
        UnpauseAgent,
        ApproveCodehash,
        RevokeCodehash
    }

    struct Module {
        Kind kind;
        Status status;
        uint64 paramsAt; // timestamp of the last executed setParams (one per PARAMS_EPOCH)
        bytes32 codehash; // extcodehash pinned at register
        bytes32 specHash;
        bytes32[4] params;
        bytes32[4] minParams; // inclusive bounds, compared as uint256
        bytes32[4] maxParams;
    }

    /// @dev Safe-approved bytecode the agent may register at level 10 (kind and bounds pinned).
    struct Approval {
        bool ok;
        Kind kind;
        bytes32[4] minParams; // the agent's registered bounds must sit inside these
        bytes32[4] maxParams;
    }

    struct QueuedOp {
        Op op;
        address proposer;
        uint64 queuedAt;
        bytes data;
    }

    // ---- constitution (SPEC §1) ----
    uint256 public constant MIN_DELAY = 1 hours;
    uint32 public constant MIN_CANARY_WINDOW = 50; // blocks
    uint256 public constant MAX_AGENT_PENDING = 8;
    uint8 public constant MAX_LEVEL = 10;
    uint256 public constant AGENT_ROLLBACK_COOLDOWN = 1 hours;
    // "≤ 3 / 24 h" is a rolling window kept as a 3-slot ring of timestamps (see agentRollbacks)
    uint256 public constant PARAMS_EPOCH = 1 hours;
    uint256 public constant LEVEL_RAISE_BLOCKS = 5 * 7200; // 5 days of 12 s blocks, measured from lastRollbackBlock
    uint32 public constant BREAKER_N = 3; // the hook only counts failures inside its 300-block window (M)

    // ---- level bitmaps: bit i = Op(i), plus the high bits below. An agent op needs its Op bit and, for a Split-kind
    //      module, SPLIT_BIT; for SetParams on the active Fee module, ACTIVE_PARAMS_BIT (see _checkAgentOp).
    //      SetAgent, SetAnchorKey, SetLevel, UnpauseAgent, ApproveCodehash, RevokeCodehash are in no bitmap. ----
    uint256 public constant ROLLBACK_BIT = 1 << 255; // immediate rollback
    uint256 public constant END_CANARY_BIT = 1 << 254; // immediate endCanary
    uint256 public constant ACTIVE_PARAMS_BIT = 1 << 253; // SetParams on the active Fee module
    uint256 public constant SPLIT_BIT = 1 << 252; // any module op on a Split-kind module
    uint256 public constant L4_OPS = 1 << uint256(Op.SetShadow);
    uint256 public constant L5_OPS =
        L4_OPS | (1 << uint256(Op.SetCanary)) | (1 << uint256(Op.SetParams)) | ROLLBACK_BIT | END_CANARY_BIT;
    uint256 public constant L6_OPS = L5_OPS | ACTIVE_PARAMS_BIT; // L7 = L6 here + BountyBoard allowance (reads level)
    uint256 public constant L8_OPS = L6_OPS | (1 << uint256(Op.PromoteActive));
    uint256 public constant L9_OPS = L8_OPS | SPLIT_BIT;
    uint256 public constant L10_OPS = L9_OPS | (1 << uint256(Op.Register)); // approved codehashes only

    // ---- roles ----
    address public immutable safe;
    address public immutable initializer;
    address public agent;
    address public anchorKey;
    bool public agentPaused;
    uint8 public level;

    address public hook;
    uint256 public lastRollbackBlock;

    // ---- queue ----
    uint256 public nextId;
    mapping(uint256 => QueuedOp) public queued;
    mapping(address => uint256) public pendingOf; // queued, not yet executed/cancelled ops per non-Safe proposer

    // ---- agent rollback rate limit: last three agent rollback timestamps (ring) ----
    uint64[3] public agentRollbacks;
    uint8 public agentRollbackIdx; // index of the oldest entry

    // ---- modules + routes ----
    mapping(address => Module) internal _modules;
    Route internal _route; // fee route, mirrored into the hook on every change
    SplitRoute internal _split; // read by FeeVault; zero module = baseline 3500/3500/3000/0
    mapping(bytes32 => Approval) internal _approved; // codehash → what the agent may register (level 10)

    event Initialized(address hook);
    event Queued(uint256 indexed id, Op indexed op, address indexed proposer, bytes data, uint256 eta);
    event Executed(uint256 indexed id, Op indexed op);
    event Cancelled(uint256 indexed id);
    event Registered(
        address indexed module,
        Kind kind,
        bytes32 codehash,
        bytes32 specHash,
        bytes32[4] minParams,
        bytes32[4] maxParams
    );
    event StatusChanged(address indexed module, Status from, Status to);
    event ParamsSet(address indexed module, bytes32[4] params);
    event CanaryWindow(address indexed module, uint64 start, uint32 period, uint32 len);
    event RoutePushed(Route route);
    event SplitRouteSet(address indexed module, bytes32[4] params);
    event AgentSet(address agent);
    event AnchorKeySet(address anchorKey);
    event LevelSet(uint8 from, uint8 to);
    event AgentPaused(bool paused);
    event RolledBack(Kind indexed kind, address indexed by, address active, address canary);
    event Anchored(bytes32 indexed root, string uri);
    event CanaryEnded(address indexed module, address indexed by);
    event CodehashApproved(bytes32 indexed codehash, Kind kind, bytes32[4] minParams, bytes32[4] maxParams);
    event CodehashRevoked(bytes32 indexed codehash);

    error Unauthorized();
    error AlreadyInitialized();
    error NotInitialized();
    error NoCode();
    error AgentIsPaused();
    error NotAllowedAtLevel();
    error TooManyPending();
    error UnknownOp();
    error TooEarly();
    error BadStatus(Status status);
    error CodehashChanged();
    error OutOfBounds(uint256 index);
    error ParamsEpoch();
    error BadWindow();
    error RaiseTooSoon();
    error NotLower();
    error Cooldown();
    error DailyCap();
    error NothingToRollback();
    error BreakerTripped();
    error NoCanary();
    error NotApproved();
    error BadLevel();

    modifier onlySafe() {
        if (msg.sender != safe) revert Unauthorized();
        _;
    }

    /// @param safe_ Immutable owner (Gnosis Safe).
    /// @param agent_ Initial agent key (rotatable via the queue).
    /// @param anchorKey_ Initial anchor key (rotatable via the queue).
    /// @param level_ Initial autonomy level (launch: 5; ≤ MAX_LEVEL).
    /// @param initializer_ The only address allowed to call `initialize(hook)` (deployment factory).
    constructor(address safe_, address agent_, address anchorKey_, uint8 level_, address initializer_) {
        if (safe_ == address(0)) revert Unauthorized();
        if (level_ > MAX_LEVEL) revert BadLevel();
        safe = safe_;
        agent = agent_;
        anchorKey = anchorKey_;
        level = level_;
        initializer = initializer_;
    }

    // ------------------------------------------------------------------ wiring

    /// @notice One-shot wiring of the hook address (resolves the hook↔registry constructor cycle).
    /// @dev Only the immutable `initializer`, once, and the hook must already have code (front-run proof).
    function initialize(address hook_) external {
        if (msg.sender != initializer) revert Unauthorized();
        if (hook != address(0)) revert AlreadyInitialized();
        if (hook_.code.length == 0) revert NoCode();
        hook = hook_;
        emit Initialized(hook_);
    }

    // ------------------------------------------------------------------ queue

    /// @notice Queue an op. Safe: any op. Agent: only ops in its level bitmap, ≤ MAX_AGENT_PENDING, not while paused.
    /// @param op The op kind. @param data abi-encoded op arguments (see `_apply`).
    /// @return id Queue id, executable by anyone after `queuedAt + MIN_DELAY`.
    function queue(Op op, bytes calldata data) external returns (uint256 id) {
        if (msg.sender != safe) {
            if (msg.sender != agent) revert Unauthorized();
            _checkAgentOp(op, data);
            if (pendingOf[msg.sender] >= MAX_AGENT_PENDING) revert TooManyPending();
            pendingOf[msg.sender]++;
        }
        id = ++nextId;
        queued[id] = QueuedOp(op, msg.sender, uint64(block.timestamp), data);
        emit Queued(id, op, msg.sender, data, block.timestamp + MIN_DELAY);
    }

    /// @notice Execute a queued op once its delay has passed. Callable by anyone.
    /// @dev Agent ops are re-checked at execution: the proposer must still be the agent, not paused, and the op must
    ///      still be in the current level's bitmap (so pause / lowerLevel / rotation neutralise pending agent ops).
    function execute(uint256 id) external {
        QueuedOp memory q = queued[id];
        if (q.queuedAt == 0) revert UnknownOp();
        if (block.timestamp < q.queuedAt + MIN_DELAY) revert TooEarly();
        // a route push resets the hook's breaker: while tripped, only rollback may change the route
        if (_breakerTripped()) revert BreakerTripped();
        delete queued[id];
        if (q.proposer != safe) {
            pendingOf[q.proposer]--;
            if (q.proposer != agent) revert Unauthorized();
            _checkAgentOp(q.op, q.data);
        }
        emit Executed(id, q.op);
        _apply(q.op, q.data);
    }

    /// @notice Cancel queued ops in one call (Safe only).
    function cancel(uint256[] calldata ids) external onlySafe {
        for (uint256 i; i < ids.length; i++) {
            QueuedOp storage q = queued[ids[i]];
            if (q.queuedAt == 0) revert UnknownOp();
            if (q.proposer != safe) pendingOf[q.proposer]--;
            delete queued[ids[i]];
            emit Cancelled(ids[i]);
        }
    }

    // ------------------------------------------------------------------ immediate (lock-fast)

    /// @notice Instantly pause the agent: it can neither queue, execute its pending ops, nor roll back. Safe only.
    ///         Unpausing is a queued op (`Op.UnpauseAgent`).
    function pauseAgent() external onlySafe {
        agentPaused = true;
        emit AgentPaused(true);
    }

    /// @notice Instantly lower the autonomy level. Safe only.
    function lowerLevel(uint8 newLevel) external onlySafe {
        if (newLevel >= level) revert NotLower();
        emit LevelSet(level, newLevel);
        level = newLevel;
    }

    /// @notice Roll a route back to baseline: clears active + canary (Fee) or the active split (Split), marks those
    ///         modules RolledBack and restarts the 5-day level-raise clock. Never lowers the level.
    /// @dev Callers: the Safe; anyone when the hook's breaker reports ≥ BREAKER_N failures (Fee only); the agent at
    ///      level ≥ 5, not paused, ≥ 1 h after its last rollback and ≤ 3 per rolling 24 h.
    function rollback(Kind kind) external {
        if (msg.sender != safe && !(kind == Kind.Fee && _breakerTripped())) {
            if (msg.sender != agent) revert Unauthorized();
            _checkAgent(ROLLBACK_BIT);
            uint8 i = agentRollbackIdx;
            uint64 newest = agentRollbacks[(i + 2) % 3];
            if (newest != 0 && block.timestamp < newest + AGENT_ROLLBACK_COOLDOWN) revert Cooldown();
            if (agentRollbacks[i] != 0 && block.timestamp < agentRollbacks[i] + 1 days) revert DailyCap();
            agentRollbacks[i] = uint64(block.timestamp);
            agentRollbackIdx = (i + 1) % 3;
        }

        address a;
        address c;
        if (kind == Kind.Fee) {
            a = _route.active;
            c = _route.canary;
            if (a == address(0) && c == address(0)) revert NothingToRollback();
            _setStatus(a, Status.RolledBack);
            _setStatus(c, Status.RolledBack);
            _route.active = address(0);
            delete _route.activeParams;
            _clearCanary();
            _push();
        } else {
            a = _split.module;
            if (a == address(0)) revert NothingToRollback();
            _setStatus(a, Status.RolledBack);
            delete _split;
            emit SplitRouteSet(address(0), _split.params);
        }
        lastRollbackBlock = block.number;
        emit RolledBack(kind, msg.sender, a, c);
    }

    /// @notice End the Fee canary now (not queued): its module returns to Proposed (reusable), the canary slot and window
    ///         are cleared and the route is pushed. Not a rollback: `lastRollbackBlock` and the agent's rollback quota
    ///         are untouched. Safe, or the agent at level ≥ 5 and not paused.
    /// @dev Blocked while the breaker is tripped (a route push resets it; only rollback may change the route then).
    function endCanary() external {
        if (msg.sender != safe) {
            if (msg.sender != agent) revert Unauthorized();
            _checkAgent(END_CANARY_BIT);
        }
        if (_breakerTripped()) revert BreakerTripped();
        address c = _route.canary;
        if (c == address(0)) revert NoCanary();
        _setStatus(c, Status.Proposed);
        _clearCanary();
        emit CanaryEnded(c, msg.sender);
        _push();
    }

    /// @notice Publish an engine-log Merkle root (event only). anchorKey only.
    function anchor(bytes32 root, string calldata uri) external {
        if (msg.sender != anchorKey) revert Unauthorized();
        emit Anchored(root, uri);
    }

    // ------------------------------------------------------------------ views

    /// @notice Split route for FeeVault; zero module = baseline 3500/3500/3000/0.
    function splitRoute() external view returns (SplitRoute memory) {
        return _split;
    }

    /// @notice The fee route last pushed to the hook.
    function route() external view returns (Route memory) {
        return _route;
    }

    /// @notice Full module record.
    function getModule(address module) external view returns (Module memory) {
        return _modules[module];
    }

    /// @notice What the Safe approved for the agent to register under `codehash` (level 10).
    function getApproval(bytes32 codehash) external view returns (Approval memory) {
        return _approved[codehash];
    }

    /// @notice Agent permissions at `lvl` (constant bitmaps, cumulative): L≤3 none · L4 setShadow · L5 + setCanary,
    ///         setParams (non-active), rollback, endCanary · L6 + setParams on the active fee module · L7 same (+ the
    ///         BountyBoard allowance) · L8 + promoteActive (fee) · L9 + split-kind module ops · L10 + register
    ///         (Safe-approved codehash only).
    function levelOps(uint8 lvl) public pure returns (uint256) {
        return lvl <= 3
            ? 0
            : lvl == 4
                ? L4_OPS
                : lvl == 5 ? L5_OPS : lvl <= 7 ? L6_OPS : lvl == 8 ? L8_OPS : lvl == 9 ? L9_OPS : L10_OPS;
    }

    // ------------------------------------------------------------------ ops (internal only)

    /// @dev Encodings:
    ///  Register      (address module, Kind kind, bytes32 specHash, bytes32[4] params, bytes32[4] min, bytes32[4] max)
    ///  SetShadow     (address module)
    ///  SetCanary     (address module, uint64 start, uint32 period, uint32 len)
    ///  PromoteActive (address module)
    ///  SetParams     (address module, bytes32[4] params)
    ///  SetAgent / SetAnchorKey (address)   SetLevel (uint8 ≤ MAX_LEVEL)   UnpauseAgent ()
    ///  ApproveCodehash (bytes32 codehash, Kind kind, bytes32[4] min, bytes32[4] max)   RevokeCodehash (bytes32)
    function _apply(Op op, bytes memory data) internal {
        if (op == Op.Register) {
            (address m, Kind k, bytes32 spec, bytes32[4] memory p, bytes32[4] memory lo, bytes32[4] memory hi) =
                abi.decode(data, (address, Kind, bytes32, bytes32[4], bytes32[4], bytes32[4]));
            _register(m, k, spec, p, lo, hi);
        } else if (op == Op.SetShadow) {
            _setShadow(abi.decode(data, (address)));
        } else if (op == Op.SetCanary) {
            (address m, uint64 start, uint32 period, uint32 len) = abi.decode(data, (address, uint64, uint32, uint32));
            _setCanary(m, start, period, len);
        } else if (op == Op.PromoteActive) {
            _promoteActive(abi.decode(data, (address)));
        } else if (op == Op.SetParams) {
            (address m, bytes32[4] memory p) = abi.decode(data, (address, bytes32[4]));
            _setParams(m, p);
        } else if (op == Op.SetAgent) {
            agent = abi.decode(data, (address));
            emit AgentSet(agent);
        } else if (op == Op.SetAnchorKey) {
            anchorKey = abi.decode(data, (address));
            emit AnchorKeySet(anchorKey);
        } else if (op == Op.SetLevel) {
            uint8 n = abi.decode(data, (uint8));
            if (n > MAX_LEVEL) revert BadLevel();
            if (n > level && lastRollbackBlock != 0 && block.number < lastRollbackBlock + LEVEL_RAISE_BLOCKS) {
                revert RaiseTooSoon();
            }
            emit LevelSet(level, n);
            level = n;
        } else if (op == Op.UnpauseAgent) {
            agentPaused = false;
            emit AgentPaused(false);
        } else if (op == Op.ApproveCodehash) {
            (bytes32 h, Kind k, bytes32[4] memory lo, bytes32[4] memory hi) =
                abi.decode(data, (bytes32, Kind, bytes32[4], bytes32[4]));
            _checkBounds(lo, lo, hi); // lo ≤ hi
            _approved[h] = Approval(true, k, lo, hi);
            emit CodehashApproved(h, k, lo, hi);
        } else if (op == Op.RevokeCodehash) {
            bytes32 h = abi.decode(data, (bytes32));
            delete _approved[h];
            emit CodehashRevoked(h);
        } else {
            revert UnknownOp();
        }
    }

    function _register(
        address m,
        Kind kind,
        bytes32 specHash,
        bytes32[4] memory p,
        bytes32[4] memory lo,
        bytes32[4] memory hi
    ) internal {
        Module storage mod = _modules[m];
        Status s = mod.status;
        if (s != Status.None && s != Status.Retired && s != Status.RolledBack) revert BadStatus(s);
        if (m.code.length == 0) revert NoCode();
        _checkBounds(p, lo, hi);
        mod.kind = kind;
        mod.paramsAt = 0;
        mod.codehash = m.codehash;
        mod.specHash = specHash;
        mod.params = p;
        mod.minParams = lo;
        mod.maxParams = hi;
        emit Registered(m, kind, mod.codehash, specHash, lo, hi);
        emit ParamsSet(m, p);
        _setStatus(m, Status.Proposed);
    }

    function _setShadow(address m) internal {
        Module storage mod = _advance(m, Status.Proposed, Status.Shadow);
        if (mod.kind == Kind.Fee) {
            _setStatus(_route.shadow, Status.Proposed); // displaced plate stays reusable
            _route.shadow = m;
            _route.shadowParams = mod.params;
            _push();
        }
    }

    function _setCanary(address m, uint64 start, uint32 period, uint32 len) internal {
        // period > len only stops an always-on "canary"; the hook's ±1 pt clamp bounds the rest
        if (len < MIN_CANARY_WINDOW || period <= len) revert BadWindow();
        Module storage mod = _advance(m, Status.Shadow, Status.Canary);
        emit CanaryWindow(m, start, period, len);
        if (mod.kind == Kind.Fee) {
            _route.shadow = address(0); // m was the shadow (slot invariant)
            delete _route.shadowParams;
            _setStatus(_route.canary, Status.Proposed); // displaced plate stays reusable
            _route.canary = m;
            _route.canaryParams = mod.params;
            _route.canaryStart = start;
            _route.canaryPeriod = period;
            _route.canaryLen = len;
            _push();
        }
    }

    function _promoteActive(address m) internal {
        Module storage mod = _advance(m, Status.Canary, Status.Active);
        if (mod.kind == Kind.Fee) {
            _setStatus(_route.active, Status.Proposed); // replaced active plate stays reusable
            _route.active = m;
            _route.activeParams = mod.params;
            _clearCanary(); // m was the canary (slot invariant)
            _push();
        } else {
            _setStatus(_split.module, Status.Proposed);
            _split = SplitRoute(m, mod.params);
            emit SplitRouteSet(m, mod.params);
        }
    }

    function _setParams(address m, bytes32[4] memory p) internal {
        Module storage mod = _modules[m];
        Status s = mod.status;
        if (s == Status.None || s == Status.Retired || s == Status.RolledBack) revert BadStatus(s);
        if (block.timestamp < mod.paramsAt + PARAMS_EPOCH) revert ParamsEpoch();
        _checkBounds(p, mod.minParams, mod.maxParams);
        mod.params = p;
        mod.paramsAt = uint64(block.timestamp);
        emit ParamsSet(m, p);
        if (mod.kind == Kind.Fee) {
            if (s == Status.Active) _route.activeParams = p;
            else if (s == Status.Canary) _route.canaryParams = p;
            else if (s == Status.Shadow) _route.shadowParams = p;
            else return; // Proposed: not routed yet
            _push();
        } else if (s == Status.Active) {
            _split.params = p;
            emit SplitRouteSet(m, p);
        }
    }

    // ------------------------------------------------------------------ helpers

    /// @dev The agent's permission for `op`, judged on current state (re-run at execute, so a module's kind/status or a
    ///      revoked approval is re-judged then). Needs the Op bit; Split-kind module ops also SPLIT_BIT; SetParams on the
    ///      active Fee module also ACTIVE_PARAMS_BIT; Register a Safe-approved codehash, kind and bounds.
    function _checkAgentOp(Op op, bytes memory data) internal view {
        _checkAgent(1 << uint256(op));
        if (op == Op.Register) {
            (address m, Kind k,,, bytes32[4] memory lo, bytes32[4] memory hi) =
                abi.decode(data, (address, Kind, bytes32, bytes32[4], bytes32[4], bytes32[4]));
            Approval storage a = _approved[m.codehash];
            if (!a.ok || a.kind != k) revert NotApproved();
            _checkBounds(lo, a.minParams, a.maxParams);
            _checkBounds(hi, a.minParams, a.maxParams);
        } else if (op <= Op.SetParams) {
            Module storage mod = _modules[abi.decode(data, (address))]; // every module op leads with the module
            if (mod.kind == Kind.Split) _checkAgent(SPLIT_BIT);
            else if (op == Op.SetParams && mod.status == Status.Active) _checkAgent(ACTIVE_PARAMS_BIT);
        }
    }

    function _checkAgent(uint256 bit) internal view {
        if (agentPaused) revert AgentIsPaused();
        if (levelOps(level) & bit == 0) revert NotAllowedAtLevel();
    }

    function _breakerTripped() internal view returns (bool) {
        if (hook == address(0)) return false;
        (uint32 failCount,) = IDNAHook(hook).breaker();
        return failCount >= BREAKER_N;
    }

    /// @dev Explicit transition: `from` → `to`, re-checking the extcodehash pin.
    function _advance(address m, Status from, Status to) internal returns (Module storage mod) {
        mod = _modules[m];
        if (mod.status != from) revert BadStatus(mod.status);
        if (m.codehash != mod.codehash) revert CodehashChanged();
        _setStatus(m, to);
    }

    function _setStatus(address m, Status to) internal {
        if (m == address(0)) return;
        emit StatusChanged(m, _modules[m].status, to);
        _modules[m].status = to;
    }

    function _clearCanary() internal {
        _route.canary = address(0);
        delete _route.canaryParams;
        _route.canaryStart = 0;
        _route.canaryPeriod = 0;
        _route.canaryLen = 0;
    }

    function _push() internal {
        if (hook == address(0)) revert NotInitialized();
        IDNAHook(hook).setRoute(_route);
        emit RoutePushed(_route);
    }

    function _checkBounds(bytes32[4] memory p, bytes32[4] memory lo, bytes32[4] memory hi) internal pure {
        for (uint256 i; i < 4; i++) {
            if (uint256(p[i]) < uint256(lo[i]) || uint256(p[i]) > uint256(hi[i])) revert OutOfBounds(i);
        }
    }
}
