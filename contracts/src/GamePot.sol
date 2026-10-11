// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {PoolBound} from "./PoolBound.sol";
import {ConvictionVault} from "./ConvictionVault.sol";
import {FeeVault} from "./FeeVault.sol";
import {IModuleRegistry} from "./interfaces/IDNA.sol";
import {IVRFCoordinatorV2Plus, VRFV2PlusClient} from "./interfaces/IVRFCoordinatorV2Plus.sol";

interface IHookAddrs {
    function feeVault() external view returns (address);
    function buybackBurn() external view returns (address);
}

/// @title GamePot (SPEC §13)
/// @notice Receives FeeVault's game share as ERC-6909 ETH claims and runs two games:
///         - Holder jackpot: every DNA holder, by time-weighted average balance over a window (stakers ×2–×4 via
///           ConvictionVault weights, a water-filled per-wallet cap, a minimum balance; built off-chain in the enclave).
///           Windows tick by `drawInterval` (`rollWindow`). After a window closes the agent posts the ticket list's
///           Merkle root (`postList`, bound to its total by the last leaf), the Safe can veto it for LIST_DELAY, then
///           anyone requests one Chainlink VRF v2.5 word (native payment); the prize is escrowed at request. The
///           callback only stores the word; `settle` walks tickets ticketAt(word, j) to 10 distinct winners, proves
///           every walked leaf and PUSHES each an equal share (a failed push leaves that share claimable). The list is
///           fixed before randomness (disclosed: a withholding VRF operator would know the winners before fulfilling;
///           bounded by PRIZE_CAP).
///         - Idea rewards: the agent (L ≥ 5) or the Safe queues a reward from the idea reserve to the author of an idea
///           that shipped (or a fee idea that was kept); public for 1 h with a Safe veto, then anyone pays it out.
///           Capped per reward (25% of the reserve) and per rolling day (25% of the reserve at the day's first queue).
///         Value leaves only to winners, reward recipients, BuybackBurn or the VRF subscription: never to the Safe or
///         the agent (both are excluded recipients). No owner, no pause, no proxy; the coordinator is immutable (no migration code: a retired
///         coordinator ends the jackpot via `rescueToBuyback` and a split rollback).
/// @dev PoolBound-style: init code `(poolManager, initializer, vault, registry, coordinator, keyHash)` holds no
///      FeeVault address; `initialize(hook)` (once, by the Safe) reads FeeVault / BuybackBurn from the hook, checks
///      that FeeVault pays this pot, creates + owns the VRF subscription and opens window 1. The Safe then binds the
///      vault to this pot (`ConvictionVault.initialize`, which takes DNA = `token()` from here).
///      Accounting: every asset is an ETH claim (id 0) or native ETH (refunds, stray sends; `sync` turns it into claims).
///      claims + ETH ≥ jackpotPot + ideaReserve + escrow + owedTotal + queuedRewards at all times; arrivals above
///      that are split 70/30. `settle` and `payReward` turn exactly the payout into native ETH right before the push;
///      a failed push turns it back.
contract GamePot is PoolBound, ReentrancyGuardTransient {
    /// @dev The one unresolved draw: a posted list (window != 0) → requested (reqId != 0, prize escrowed) →
    ///      fulfilled (fulfilledAt != 0) → settled or voided (deleted). An abort clears the request and keeps the list.
    struct Draw {
        uint64 window; // != 0 ⇔ a list is posted
        uint40 eta; // postList + LIST_DELAY: requestDraw from here
        uint40 requestedAt;
        uint40 fulfilledAt;
        uint96 prize; // escrowed (out of jackpotPot) from request until settle, void or abort
        uint256 reqId; // != 0 ⇔ randomness requested and not aborted
        bytes32 root;
        uint256 totalTickets;
        uint256 rand;
    }

    /// @notice A window's list parameters, announced in an anchored record before the window starts.
    struct Params {
        uint256 capBps; // per-wallet ticket cap, water-filled: [50, 200]
        uint256 minBalance; // DNA wei, average unweighted balance to be eligible: [100, 1_000_000] DNA
    }

    /// @notice One ticket-list entry; leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, cumStart,
    ///         tickets)))) (OZ double hash), sorted-pair Merkle tree. Tickets [cumStart, cumStart + tickets).
    struct Leaf {
        uint256 index;
        address account;
        uint256 cumStart;
        uint256 tickets;
    }

    /// @dev A share or reward whose push failed (one slot: 10 of them fit the settle's gas budget). amount 0 = claimed
    ///      or expired. A share is ≤ PRIZE_CAP / WINNERS (0.3 ETH), a reward ≤ 25% of RESERVE_CAP (3.75 ETH), both far
    ///      below uint64's 18.4 ETH.
    struct Prize {
        address winner;
        uint64 amount;
        uint32 wonAt;
    }

    /// @notice A queued idea reward, escrowed out of ideaReserve until paid or cancelled (deleted then).
    struct QueuedReward {
        address to;
        uint96 amount;
        address proposer;
        uint40 eta; // queue + QUEUE_DELAY: payable from here
        bytes32 ideaRef; // freed for a new queue only by cancelReward
    }

    struct PendingInterval {
        uint32 value;
        uint40 eta;
        address proposer;
    }

    // ---- jackpot (tunable before salt mining) ----
    uint256 public constant JACKPOT_BPS = 7000; // arrivals: 70% jackpot / 30% idea reserve
    uint256 public constant PRIZE_CAP = 3 ether; // per draw, split across the winners
    uint256 public constant POT_CAP = 15 ether; // overflow → BuybackBurn claims
    uint256 public constant RESERVE_CAP = 15 ether; // idea reserve cap, overflow → BuybackBurn
    uint256 public constant MIN_PRIZE = 0.25 ether; // draws wait (the pot accrues) until reached
    uint32 internal constant MIN_INTERVAL = 12 hours; // agent-set drawInterval bounds
    uint32 internal constant MAX_INTERVAL = 3 days;
    uint32 internal constant DEFAULT_INTERVAL = 24 hours;
    uint256 internal constant QUEUE_DELAY = 1 hours; // the Safe's veto window, as ModuleRegistry.MIN_DELAY
    uint256 internal constant VRF_TIMEOUT = 36 hours; // abortDraw after this
    uint256 internal constant STALL = 14 days; // no fulfilment this long → rescueToBuyback
    uint256 public constant CLAIM_WINDOW = 7 days; // then expireClaim returns the prize to the jackpot
    uint256 internal constant MAX_COST_BPS = 2000; // no draw while est. VRF cost > 20% of the prize
    // ---- holder jackpot lists ----
    uint256 public constant LIST_DELAY = 1 hours; // the Safe's veto window on a posted list
    uint256 public constant LIST_GRACE = 24 hours; // a window's list must be posted within this of its end
    uint256 public constant DRAW_SETTLE_WINDOW = 7 days; // fulfilled but unsettled this long → voidDraw
    uint256 internal constant MIN_CAP_BPS = 50;
    uint256 internal constant MAX_CAP_BPS = 200;
    uint256 internal constant MIN_BALANCE_FLOOR = 100 ether; // minBalance bounds, DNA wei
    uint256 internal constant MIN_BALANCE_CEIL = 1_000_000 ether;
    uint256 public constant WINNERS = 10;
    uint256 public constant MAX_TICKETS = 32;
    uint256 public constant PUSH_GAS = 50_000; // the winner's receive gets exactly this (returndata never copied)
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    // ---- VRF v2.5, native payment ----
    uint32 public constant CALLBACK_GAS = 300_000; // the callback only stores the word (≪ this; test)
    uint256 internal constant VERIFY_GAS = 200_000; // Chainlink's proof-verification allowance in its balance formula
    uint256 internal constant BILLING_GAS = 50_000; // coordinator gasAfterPaymentCalculation (38,900, fork) + margin
    uint256 internal constant PREMIUM_PCT = 124; // 100 + nativePremiumPercentage (24%, verified on the fork)
    uint256 internal constant LANE_MAX_GAS_PRICE = 200 gwei; // the pinned keyHash's lane (verified on the fork)
    /// @notice Native balance the subscription is topped up to before each request: Chainlink's minimum-balance
    ///         formula at the lane max, so the node's pre-check passes at any gas price the lane accepts.
    uint256 public constant SUB_MIN = LANE_MAX_GAS_PRICE * (VERIFY_GAS + CALLBACK_GAS + BILLING_GAS) * PREMIUM_PCT
        / 100;
    uint16 internal constant CONFIRMATIONS = 3;
    // ---- idea rewards ----
    uint256 public constant MAX_REWARD_BPS = 2500; // a reward ≤ 25% of ideaReserve; a rolling day's sum ≤ 25% too
    uint256 public constant MIN_REWARD = 0.01 ether;
    uint256 internal constant BUDGET_PERIOD = 24 hours; // from the period's first queue
    uint8 internal constant MIN_LEVEL = 5;

    ConvictionVault public immutable vault;
    IModuleRegistry public immutable registry;
    address public immutable safe;
    IVRFCoordinatorV2Plus public immutable coordinator;
    bytes32 public immutable keyHash;

    address public feeVault;
    address public buybackBurn;
    address public liquidityVault;
    uint256 public subId;

    uint256 public jackpotPot;
    uint256 public ideaReserve;
    uint256 public owedTotal; // Σ unclaimed, unexpired prizes and rewards
    uint256 public queuedRewards; // Σ escrow of queued, unpaid, uncancelled rewards
    Draw public draw;
    uint256 public drawCount; // prizes[1..drawCount] (draw shares and rewards whose push failed)
    mapping(uint256 => Prize) public prizes;
    uint256 public stalledSince; // first request since the last fulfilment (0 = none outstanding)
    uint256 public windowId; // the latest window opened (1 at initialize); its bounds below
    uint40 public windowStart;
    uint40 public windowEnd;
    uint256 public lastDrawnWindow; // the last window whose draw settled or was voided: lists only for later ones
    uint32 public drawInterval = DEFAULT_INTERVAL;
    PendingInterval public pendingInterval;
    uint256 public rewardCount; // rewards[1..rewardCount]
    mapping(uint256 => QueuedReward) public rewards;
    /// @notice The reward id an ideaRef backs: one queue per signed reward record (0 = free; a cancel frees it, a pay or an
    ///         expiry keeps it used), so a record can never back a second reward on-chain.
    mapping(bytes32 => uint256) public rewardOfRef;
    uint40 public budgetStart; // the rolling day's first queue
    uint96 public dayBudget; // 25% of ideaReserve then
    uint96 public daySpent; // Σ queued since (a cancel does not give it back)

    enum Act {
        SETTLE, // native ETH → claims
        PAY, // claims → ETH to `to`
        TOPUP, // claims → ETH → VRF subscription
        TAKE // claims → ETH here (the push)
    }

    event Synced(uint256 arrived, uint256 jackpotPot, uint256 ideaReserve, uint256 overflowBurned);
    event WindowRolled(uint256 indexed window, uint256 start, uint256 end);
    event ListPosted(
        uint256 indexed window,
        uint256 capBps,
        uint256 minBalance,
        bytes32 root,
        uint256 totalTickets,
        uint256 holders,
        string uri,
        bytes32 dataHash,
        uint256 eta
    );
    event ListCancelled(uint256 indexed window);
    event DrawRequested(
        uint256 indexed reqId, uint256 indexed window, uint256 totalTickets, uint256 prize, uint256 topUp
    );
    event DrawFulfilled(uint256 indexed reqId, uint256 indexed window, uint256 rand);
    event Drawn(
        uint256 indexed window, uint256 rand, uint256 prize, uint256 share, uint256 winners, uint256 ticketsUsed
    );
    event Winner(uint256 indexed window, uint256 rank, address indexed account, uint256 share, uint256 prizeId);
    event WinnerExcluded(uint256 indexed window, address winner, uint256 prize);
    event DrawVoided(uint256 indexed window, uint256 prize);
    event DrawAborted(uint256 indexed reqId, uint256 prize);
    event PrizeClaimed(uint256 indexed drawId, address indexed winner, address to, uint256 amount);
    event PrizeExpired(uint256 indexed drawId, uint256 amount);
    event Rescued(uint256 amount);
    event SubscriptionCreated(uint256 subId);
    event DrawIntervalProposed(uint32 value, uint256 eta, address indexed by);
    event DrawIntervalSet(uint32 value);
    event DrawIntervalCancelled();
    event RewardQueued(uint256 indexed id, address indexed to, uint256 amount, bytes32 ideaRef, uint256 eta);
    event RewardPaid(uint256 indexed id, address indexed to, uint256 amount, uint256 claimId); // claimId 0 = pushed
    event RewardCancelled(uint256 indexed id);

    error BadConfig();
    error Unauthorized();
    error InFlight();
    error NotInFlight();
    error TooEarly();
    error PrizeTooSmall();
    error GasTooHigh();
    error OnlyCoordinator();
    error SubscriptionLive();
    error NotStalled();
    error NotWinner();
    error AlreadyClaimed();
    error BadInterval();
    error Pending();
    error NothingPending();
    error BadReward();
    error OverBudget();
    error RefUsed();
    error BadWindow();
    error BadParams();
    error BadList();
    error ListPending();
    error NoList();
    error NotFulfilled();
    error BadProof();
    error NotWinningLeaf();
    error LowGas();
    error RollFirst();

    constructor(
        IPoolManager poolManager_,
        address initializer_,
        ConvictionVault vault_,
        IModuleRegistry registry_,
        IVRFCoordinatorV2Plus coordinator_,
        bytes32 keyHash_
    ) PoolBound(poolManager_, initializer_) {
        if (
            address(vault_).code.length == 0 || address(registry_).code.length == 0
                || address(coordinator_).code.length == 0 || keyHash_ == bytes32(0)
        ) revert BadConfig();
        vault = vault_;
        registry = registry_;
        safe = registry_.safe();
        coordinator = coordinator_;
        keyHash = keyHash_;
    }

    /// @notice Once, by the initializer (Safe): bind the hook (PoolBound checks), read FeeVault / BuybackBurn /
    ///         LiquidityVault from it, require that FeeVault's game share comes here, create the VRF subscription.
    function initialize(address hook_) public override {
        super.initialize(hook_);
        address fv = IHookAddrs(hook_).feeVault();
        if (fv.code.length == 0 || FeeVault(fv).gamePot() != address(this)) revert WrongHook();
        (feeVault, buybackBurn, liquidityVault) = (fv, IHookAddrs(hook_).buybackBurn(), FeeVault(fv).liquidityVault());
        _newSubscription();
        (windowId, windowStart, windowEnd) = (1, uint40(block.timestamp), uint40(block.timestamp + drawInterval));
        emit WindowRolled(1, block.timestamp, block.timestamp + drawInterval);
    }

    receive() external payable {} // coordinator refunds (ownerCancelSubscription) and stray ETH; `sync` counts them

    // ------------------------------------------------------------------ accounting

    /// @notice Anyone: count new arrivals (claims + ETH above every liability), split 70/30, burn above POT_CAP and
    ///         RESERVE_CAP (also a reserve a cancelled reward pushed over the cap).
    function sync() external nonReentrant {
        _sync();
    }

    function _sync() internal {
        uint256 eth = address(this).balance;
        if (eth != 0) poolManager.unlock(abi.encode(Act.SETTLE, address(0), eth));
        uint256 assets = poolManager.balanceOf(address(this), 0);
        uint256 liab = jackpotPot + ideaReserve + draw.prize + owedTotal + queuedRewards;
        uint256 arrived = assets > liab ? assets - liab : 0;
        uint256 jp = jackpotPot + arrived * JACKPOT_BPS / 10_000;
        uint256 ir = ideaReserve + arrived - (jp - jackpotPot);
        uint256 over = (jp > POT_CAP ? jp - POT_CAP : 0) + (ir > RESERVE_CAP ? ir - RESERVE_CAP : 0);
        jackpotPot = jp > POT_CAP ? POT_CAP : jp;
        ideaReserve = ir > RESERVE_CAP ? RESERVE_CAP : ir;
        if (over != 0) poolManager.transfer(buybackBurn, 0, over);
        if (arrived != 0 || over != 0) emit Synced(arrived, jackpotPot, ideaReserve, over);
    }

    // ------------------------------------------------------------------ jackpot: windows and lists

    /// @notice Anyone, once the open window ended: open the next one, from the previous end (a late roll never moves
    ///         it) for the current `drawInterval`. After an outage each call opens one window; the closed ones in
    ///         between are skipped (the pot carries over).
    function rollWindow() external {
        if (windowId == 0) revert NotInitialized();
        if (block.timestamp < windowEnd) revert TooEarly();
        uint256 start = windowEnd;
        uint256 end = start + drawInterval;
        (windowId, windowStart, windowEnd) = (windowId + 1, uint40(start), uint40(end));
        emit WindowRolled(windowId, start, end);
    }

    /// @notice The latest window that has ended, and its end (window 0 = none yet).
    function latestClosedWindow() public view returns (uint256 w, uint256 end) {
        if (windowId != 0 && block.timestamp >= windowEnd) return (windowId, windowEnd);
        return (windowId == 0 ? 0 : windowId - 1, windowStart);
    }

    /// @notice Agent (L ≥ 5, unpaused) or Safe, anchor-before-send: post window `w`'s ticket list. Only the latest
    ///         closed window, within LIST_GRACE of its end, never one already drawn, and never while randomness is
    ///         requested or delivered. A newer window's list replaces a posted one that was never requested (that
    ///         window is skipped). Binding: the last leaf (index holders − 1) is proved and ends exactly at
    ///         `totalTickets`, so the root commits to the total the draw uses. `holders` is NOT bound to the root's
    ///         leaf count (proofs are position-free): a shortened list is caught by the watchdog's full rebuild and
    ///         vetoed by the Safe's `cancelList` until `requestDraw`; `requestDraw` opens LIST_DELAY later.
    function postList(
        uint256 w,
        Params calldata params,
        bytes32 root,
        uint256 totalTickets,
        uint256 holders,
        Leaf calldata lastLeaf,
        bytes32[] calldata lastProof,
        string calldata uri,
        bytes32 dataHash
    ) external nonReentrant {
        if (!_canPropose(msg.sender)) revert Unauthorized();
        _checkWindow(w);
        if (
            params.capBps < MIN_CAP_BPS || params.capBps > MAX_CAP_BPS || params.minBalance < MIN_BALANCE_FLOOR
                || params.minBalance > MIN_BALANCE_CEIL
        ) revert BadParams();
        if (
            root == bytes32(0) || totalTickets == 0 || holders == 0 || lastLeaf.index != holders - 1
                || lastLeaf.tickets == 0 || lastLeaf.tickets > totalTickets
                || lastLeaf.cumStart != totalTickets - lastLeaf.tickets
                || !MerkleProof.verifyCalldata(lastProof, root, leafHash(lastLeaf))
        ) revert BadList();
        uint256 eta = block.timestamp + LIST_DELAY;
        draw = Draw(uint64(w), uint40(eta), 0, 0, 0, 0, root, totalTickets, 0);
        emit ListPosted(w, params.capBps, params.minBalance, root, totalTickets, holders, uri, dataHash, eta);
    }

    function _checkWindow(uint256 w) internal view {
        (uint256 latest, uint256 end) = latestClosedWindow();
        if (w == 0 || w != latest || block.timestamp > end + LIST_GRACE || w <= lastDrawnWindow) revert BadWindow();
        Draw storage d = draw;
        if (d.reqId != 0 || d.fulfilledAt != 0) revert InFlight();
        if (d.window >= w) revert ListPending(); // this window's list is posted: only the Safe's cancel frees it
    }

    /// @notice Safe veto: drop window `w`'s list until randomness is requested (also after an abort).
    function cancelList(uint256 w) external {
        if (msg.sender != safe) revert Unauthorized();
        Draw storage d = draw;
        if (d.window == 0 || d.window != w) revert NoList();
        if (d.reqId != 0 || d.fulfilledAt != 0) revert InFlight();
        delete draw;
        emit ListCancelled(w);
    }

    /// @notice keccak256(bytes.concat(keccak256(abi.encode(index, account, cumStart, tickets)))): OZ's double hash.
    function leafHash(Leaf calldata l) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(l.index, l.account, l.cumStart, l.tickets))));
    }

    // ------------------------------------------------------------------ jackpot: draw

    /// @notice Anyone, from the posted list's eta: top the subscription up to SUB_MIN from the pot, escrow
    ///         prize = min(pot − top-up, PRIZE_CAP) (≥ MIN_PRIZE, else wait), request one VRF word. Paused while the
    ///         estimated VRF cost exceeds 20% of the prize. After an abort it re-requests the same list.
    function requestDraw() external nonReentrant returns (uint256 reqId) {
        Draw memory d = draw;
        if (d.window == 0) revert NoList();
        if (d.reqId != 0 || d.fulfilledAt != 0) revert InFlight();
        if (block.timestamp < d.eta) revert TooEarly();
        _sync();
        (, uint96 subBal,,,) = coordinator.getSubscription(subId); // reverts on a cancelled sub: recreateSubscription
        uint256 topUp = subBal < SUB_MIN ? SUB_MIN - subBal : 0;
        uint256 jp = jackpotPot;
        if (jp < topUp + MIN_PRIZE) revert PrizeTooSmall(); // the pot covers SUB_MIN + prize, else it accrues
        uint256 prize = jp - topUp < PRIZE_CAP ? jp - topUp : PRIZE_CAP;
        if (vrfCostEstimate() * 10_000 > prize * MAX_COST_BPS) revert GasTooHigh();
        jackpotPot = jp - prize - topUp;
        if (topUp != 0) poolManager.unlock(abi.encode(Act.TOPUP, address(0), topUp));
        reqId = coordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subId,
                requestConfirmations: CONFIRMATIONS,
                callbackGasLimit: CALLBACK_GAS,
                numWords: 1,
                extraArgs: abi.encodeWithSelector(
                    VRFV2PlusClient.EXTRA_ARGS_V1_TAG, VRFV2PlusClient.ExtraArgsV1({nativePayment: true})
                )
            })
        );
        (draw.reqId, draw.requestedAt, draw.prize) = (reqId, uint40(block.timestamp), uint96(prize));
        if (stalledSince == 0) stalledSince = block.timestamp;
        emit DrawRequested(reqId, d.window, d.totalTickets, prize, topUp);
    }

    /// @notice VRF callback: store the word, nothing else (no settle here; the tickets are ticketAt(word, j)). A stale, unknown or
    ///         repeated requestId is ignored (never reverts), so a late fulfilment of an aborted request changes nothing.
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        if (msg.sender != address(coordinator)) revert OnlyCoordinator();
        Draw storage d = draw;
        if (d.reqId == 0 || requestId != d.reqId || d.fulfilledAt != 0 || randomWords.length == 0) return;
        uint256 rand = randomWords[0];
        (d.rand, d.fulfilledAt) = (rand, uint40(block.timestamp));
        stalledSince = 0;
        emit DrawFulfilled(requestId, d.window, rand);
    }

    function ticketAt(uint256 rand, uint256 j, uint256 total) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(rand, j))) % total;
    }

    function settle(Leaf[] calldata leaves, bytes32[][] calldata proofs) external nonReentrant {
        Draw memory d = draw;
        if (d.fulfilledAt == 0) revert NotFulfilled();
        if (leaves.length != proofs.length) revert BadList(); // an empty list fails the walk's first ticket (BadList)
        delete draw;
        lastDrawnWindow = d.window;
        address[] memory winners = new address[](WINNERS);
        uint256 n;
        uint256 k;
        for (uint256 j; j < MAX_TICKETS && n < WINNERS; ++j) {
            if (k == leaves.length) revert BadList();
            Leaf calldata l = leaves[k];
            uint256 t = ticketAt(d.rand, j, d.totalTickets);
            if (!MerkleProof.verifyCalldata(proofs[k], d.root, leafHash(l))) revert BadProof();
            if (t < l.cumStart || t - l.cumStart >= l.tickets) revert NotWinningLeaf();
            ++k;
            address a = l.account;
            bool dup;
            for (uint256 i; i < n; ++i) {
                if (winners[i] == a) {
                    dup = true;
                    break;
                }
            }
            if (dup) continue;
            if (isExcluded(a)) {
                emit WinnerExcluded(d.window, a, 0);
                continue;
            }
            winners[n++] = a;
        }
        if (k != leaves.length) revert BadList();
        uint256 share = uint256(d.prize) / WINNERS;
        uint256 paid = share * n;
        jackpotPot += d.prize - paid; // dust, unfilled ranks; POT_CAP at the next sync
        emit Drawn(d.window, d.rand, d.prize, share, n, k);
        if (n == 0) return;
        poolManager.unlock(abi.encode(Act.TAKE, address(0), paid));
        uint256 failed;
        for (uint256 i; i < n; ++i) {
            address w = winners[i];
            uint256 id = _push(w, share);
            if (id != 0) failed += share;
            emit Winner(d.window, i, w, share, id);
        }
        _owe(failed);
    }

    /// @dev Sends `amount` (already taken as native ETH) with exactly PUSH_GAS, returndata never copied. A failed push
    ///      becomes a claim record (its id; 0 = pushed); the caller settles the failed sum back with `_owe`.
    function _push(address to, uint256 amount) internal returns (uint256 id) {
        if (gasleft() < PUSH_GAS * 64 / 63 + 40_000) revert LowGas();
        bool pushed;
        assembly ("memory-safe") {
            pushed := call(PUSH_GAS, to, amount, 0, 0, 0, 0)
        }
        if (!pushed) {
            id = ++drawCount;
            prizes[id] = Prize(to, uint64(amount), uint32(block.timestamp));
        }
    }

    function _owe(uint256 failed) internal {
        if (failed == 0) return;
        owedTotal += failed;
        poolManager.unlock(abi.encode(Act.SETTLE, address(0), failed)); // back to claims, still owed
    }

    /// @notice Anyone, DRAW_SETTLE_WINDOW after a fulfilment nobody settled: the escrow returns to the pot.
    function voidDraw() external nonReentrant {
        Draw memory d = draw;
        if (d.fulfilledAt == 0) revert NotFulfilled();
        if (block.timestamp < uint256(d.fulfilledAt) + DRAW_SETTLE_WINDOW) revert TooEarly();
        delete draw;
        lastDrawnWindow = d.window;
        jackpotPot += d.prize;
        emit DrawVoided(d.window, d.prize);
    }

    /// @notice Never a winner (on-chain set; the list builder also drops PlatformRevenue, Bootstrap and the announced
    ///         exchange wallets): the Safe, agent and anchor keys, the vault's team list, the pool manager, the hook,
    ///         FeeVault, BuybackBurn, LiquidityVault, the vault, this pot, 0x0 and 0x…dEaD.
    function isExcluded(address a) public view returns (bool) {
        return a == address(0) || a == DEAD || a == address(this) || a == safe || a == address(vault)
            || a == address(poolManager) || a == hook || a == feeVault || a == buybackBurn || a == liquidityVault
            || a == registry.agent() || a == registry.anchorKey() || vault.excluded(a);
    }

    /// @notice Anyone, VRF_TIMEOUT after a request that never came back: return the escrow to the pot; the list stays
    ///         and the next `requestDraw` re-requests it (a disclosed deviation from "never re-request", exploitable
    ///         only by the VRF operator and bounded by PRIZE_CAP). A late fulfilment of an aborted request is ignored
    ///         here but still charges the subscription (one fulfilment's cost, from the float; VRF-operator-only).
    function abortDraw() external nonReentrant {
        Draw memory d = draw;
        if (d.reqId == 0 || d.fulfilledAt != 0) revert NotInFlight();
        if (block.timestamp < uint256(d.requestedAt) + VRF_TIMEOUT) revert TooEarly();
        _abort(d);
    }

    function _abort(Draw memory d) internal {
        jackpotPot += d.prize;
        (draw.reqId, draw.requestedAt, draw.prize) = (0, 0, 0);
        emit DrawAborted(d.reqId, d.prize);
    }

    /// @notice Winner pulls prizes (and rewards whose push failed) as ETH to `to` (any address, so a contract winner
    ///         that can't receive ETH still gets paid).
    function claim(uint256[] calldata drawIds, address to) external nonReentrant returns (uint256 total) {
        for (uint256 k; k < drawIds.length; ++k) {
            Prize storage p = prizes[drawIds[k]];
            if (p.winner != msg.sender) revert NotWinner();
            uint256 amount = p.amount;
            if (amount == 0) revert AlreadyClaimed();
            p.amount = 0;
            total += amount;
            emit PrizeClaimed(drawIds[k], msg.sender, to, amount);
        }
        owedTotal -= total;
        if (total != 0) poolManager.unlock(abi.encode(Act.PAY, to, total));
    }

    /// @notice Anyone, CLAIM_WINDOW after the win: an unclaimed prize or reward returns to the jackpot.
    function expireClaim(uint256 drawId) external nonReentrant {
        Prize storage p = prizes[drawId];
        uint256 amount = p.amount;
        if (amount == 0) revert AlreadyClaimed(); // unknown, claimed or expired
        if (block.timestamp < p.wonAt + CLAIM_WINDOW) revert TooEarly();
        p.amount = 0;
        owedTotal -= amount;
        jackpotPot += amount; // POT_CAP applies at the next sync
        emit PrizeExpired(drawId, amount);
    }

    /// @notice Anyone, only while a request is stuck right now: in flight past VRF_TIMEOUT and STALL (14 d) since the
    ///         first unfulfilled request. Aborts it inline, then sends the jackpot (escrow included) and the idea
    ///         reserve to BuybackBurn. Owed prizes stay claimable; queued rewards stay payable. A healthy pot (no stuck request) is never
    ///         rescuable. The subscription float can't be rescued (disclosed); a split rollback then turns games off.
    function rescueToBuyback() external nonReentrant {
        Draw memory d = draw;
        if (
            d.reqId == 0 || d.fulfilledAt != 0 || block.timestamp < uint256(d.requestedAt) + VRF_TIMEOUT
                || stalledSince == 0 || block.timestamp < stalledSince + STALL
        ) revert NotStalled();
        _abort(d);
        _sync();
        uint256 amount = jackpotPot + ideaReserve;
        (jackpotPot, ideaReserve) = (0, 0);
        if (amount != 0) poolManager.transfer(buybackBurn, 0, amount);
        emit Rescued(amount);
    }

    /// @notice Anyone, between draws, once the subscription no longer exists (e.g. cancelled by the coordinator
    ///         owner, whose native refund lands in `receive`): create a new one owned by this pot.
    function recreateSubscription() external nonReentrant {
        if (draw.reqId != 0) revert InFlight();
        try coordinator.getSubscription(subId) {
            revert SubscriptionLive();
        } catch {}
        _newSubscription();
    }

    /// @notice What a request would cost at the lane's billing now: basefee × (proof + callback + billing gas) × 1.24.
    function vrfCostEstimate() public view returns (uint256) {
        return block.basefee * (VERIFY_GAS + CALLBACK_GAS + BILLING_GAS) * PREMIUM_PCT / 100;
    }

    // ------------------------------------------------------------------ draw interval (the AI decides)

    /// @notice Agent (L ≥ 5, unpaused) or Safe: queue a new draw interval within [12 h, 3 d]; executable by anyone
    ///         1 h later, cancellable by the Safe until then. One pending at a time.
    function proposeDrawInterval(uint32 value) external {
        if (!_canPropose(msg.sender)) revert Unauthorized();
        if (value < MIN_INTERVAL || value > MAX_INTERVAL) revert BadInterval();
        if (pendingInterval.eta != 0) revert Pending();
        pendingInterval = PendingInterval(value, uint40(block.timestamp + QUEUE_DELAY), msg.sender);
        emit DrawIntervalProposed(value, block.timestamp + QUEUE_DELAY, msg.sender);
    }

    /// @notice Anyone, after the delay; an agent proposal is re-judged (still the agent, unpaused, level ≥ 5). Only
    ///         while the open window runs (else `rollWindow` first), so a change applies to windows not yet started.
    function executeDrawInterval() external {
        PendingInterval memory p = pendingInterval;
        if (p.eta == 0) revert NothingPending();
        if (block.timestamp < p.eta) revert TooEarly();
        if (block.timestamp >= windowEnd) revert RollFirst();
        if (!_canPropose(p.proposer)) revert Unauthorized();
        delete pendingInterval;
        drawInterval = p.value;
        emit DrawIntervalSet(p.value);
    }

    function cancelDrawInterval() external {
        if (msg.sender != safe) revert Unauthorized();
        if (pendingInterval.eta == 0) revert NothingPending();
        delete pendingInterval;
        emit DrawIntervalCancelled();
    }

    // ------------------------------------------------------------------ idea rewards

    /// @notice Agent (L ≥ 5, unpaused) or Safe: queue `amount` from the idea reserve to `to` (never an excluded
    ///         address), MIN_REWARD ≤ amount ≤ 25% of the reserve, and the rolling day's sum ≤ 25% of the reserve at
    ///         that day's first queue. Escrowed now; anyone pays it from QUEUE_DELAY on; the Safe can cancel it before.
    ///         `ideaRef` names the signed reward record (its hash) the watchdog checks; it backs one reward at a time
    ///         and, once paid, never another (RefUsed).
    function queueReward(address to, uint256 amount, bytes32 ideaRef) external nonReentrant returns (uint256 id) {
        if (!_canPropose(msg.sender)) revert Unauthorized();
        if (isExcluded(to)) revert BadReward();
        if (rewardOfRef[ideaRef] != 0) revert RefUsed();
        _sync();
        uint256 reserve = ideaReserve;
        if (amount < MIN_REWARD || amount * 10_000 > reserve * MAX_REWARD_BPS) revert BadReward();
        if (block.timestamp >= uint256(budgetStart) + BUDGET_PERIOD) {
            (budgetStart, dayBudget, daySpent) = (uint40(block.timestamp), uint96(reserve * MAX_REWARD_BPS / 10_000), 0);
        }
        if (daySpent + amount > dayBudget) revert OverBudget();
        daySpent += uint96(amount);
        ideaReserve = reserve - amount;
        queuedRewards += amount;
        id = ++rewardCount;
        uint256 eta = block.timestamp + QUEUE_DELAY;
        rewards[id] = QueuedReward(to, uint96(amount), msg.sender, uint40(eta), ideaRef);
        rewardOfRef[ideaRef] = id;
        emit RewardQueued(id, to, amount, ideaRef, eta);
    }

    /// @notice Safe veto, until paid: the escrow returns to the idea reserve (above RESERVE_CAP burns at the next sync).
    function cancelReward(uint256 id) external {
        if (msg.sender != safe) revert Unauthorized();
        uint256 amount = rewards[id].amount;
        if (amount == 0) revert NothingPending();
        delete rewardOfRef[rewards[id].ideaRef];
        delete rewards[id];
        queuedRewards -= amount;
        ideaReserve += amount;
        emit RewardCancelled(id);
    }

    /// @notice Anyone, from the eta: push the reward to its recipient (PUSH_GAS); a failed push leaves it claimable for
    ///         CLAIM_WINDOW like a prize. Re-judged: nothing pays while the agent is paused, an agent proposal needs
    ///         the proposer still the agent at level ≥ 5, and a recipient that became excluded is never paid (the
    ///         Safe cancels it).
    function payReward(uint256 id) external nonReentrant {
        QueuedReward memory r = rewards[id];
        if (r.amount == 0) revert NothingPending();
        if (block.timestamp < r.eta) revert TooEarly();
        if (registry.agentPaused() || !_canPropose(r.proposer) || isExcluded(r.to)) revert Unauthorized();
        delete rewards[id];
        queuedRewards -= r.amount;
        poolManager.unlock(abi.encode(Act.TAKE, address(0), r.amount));
        uint256 claimId = _push(r.to, r.amount);
        if (claimId != 0) _owe(r.amount);
        emit RewardPaid(id, r.to, r.amount, claimId);
    }

    // ------------------------------------------------------------------ internal

    function _canPropose(address who) internal view returns (bool) {
        return who == safe || (who == registry.agent() && !registry.agentPaused() && registry.level() >= MIN_LEVEL);
    }

    function _newSubscription() internal {
        uint256 id = coordinator.createSubscription();
        coordinator.addConsumer(id, address(this));
        subId = id;
        emit SubscriptionCreated(id);
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (Act act, address to, uint256 amount) = abi.decode(data, (Act, address, uint256));
        Currency eth = Currency.wrap(address(0));
        if (act == Act.SETTLE) {
            poolManager.settle{value: amount}();
            poolManager.mint(address(this), 0, amount);
        } else {
            poolManager.burn(address(this), 0, amount);
            if (act == Act.PAY) {
                poolManager.take(eth, to, amount);
            } else if (act == Act.TAKE) {
                poolManager.take(eth, address(this), amount);
            } else {
                poolManager.take(eth, address(this), amount);
                coordinator.fundSubscriptionWithNative{value: amount}(subId);
            }
        }
        return "";
    }
}
