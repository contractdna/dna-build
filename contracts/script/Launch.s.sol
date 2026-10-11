// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {CommonBase} from "forge-std/Base.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {DNAToken} from "../src/DNAToken.sol";
import {DNAHook} from "../src/DNAHook.sol";
import {Bootstrap} from "../src/Bootstrap.sol";
import {PlatformRevenue} from "../src/PlatformRevenue.sol";
import {ModuleRegistry} from "../src/ModuleRegistry.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {BuybackBurn} from "../src/BuybackBurn.sol";
import {LiquidityVault} from "../src/LiquidityVault.sol";
import {AdaptiveFee} from "../src/modules/AdaptiveFee.sol";
import {BaselineSplit} from "../src/modules/BaselineSplit.sol";
import {IdeaMarket} from "../src/IdeaMarket.sol";
import {BountyBoard} from "../src/BountyBoard.sol";
import {ConvictionVault} from "../src/ConvictionVault.sol";
import {GamePot} from "../src/GamePot.sol";
import {MutationBoard} from "../src/MutationBoard.sol";
import {IInitializable, IModuleRegistry} from "../src/interfaces/IDNA.sol";
import {IVRFCoordinatorV2Plus, VRFV2PlusClient} from "../src/interfaces/IVRFCoordinatorV2Plus.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {FeeMath} from "../src/libraries/FeeMath.sol";
import {
    IProgrammableCreate2GraphDeployerV1 as IGraph
} from "./programmable/interfaces/IProgrammableCreate2GraphDeployerV1.sol";
import {
    IProgrammableLaunchStampRouterV1 as IRouter
} from "./programmable/interfaces/IProgrammableLaunchStampRouterV1.sol";
import {ProgrammableCreate2GraphDeployerV1} from "./programmable/ProgrammableCreate2GraphDeployerV1.sol";
import {ProgrammableLaunchStampRouterV1} from "./programmable/ProgrammableLaunchStampRouterV1.sol";

/// @notice The launch split: the part of the launch ETH the launch buy spends so that the rest, with the DNA bought,
///         makes a full-range position limited by its ETH (Bootstrap burns the DNA it does not need). The launch is
///         atomic and the pool's first action, so this is exact v4 math on the fresh pool: Bootstrap's main position
///         (the whole supply in [tickLower, tickUpper)), the hook's fee at t = 0 (launch fee + platform fee, on the ETH
///         paid), one swap step (the main position is the only liquidity) and Bootstrap's full-range liquidity math.
library LaunchSplit {
    uint256 internal constant SUPPLY = 1_000_000_000 ether;
    /// @dev DNAHook.LAUNCH_PROJECT_FEE + PLATFORM_FEE: what the launch buy pays at t = 0 (pinned in test/Launch.t.sol)
    uint24 internal constant FEE_AT_LAUNCH = 33_000;

    /// @return buyEth The smallest buy whose DNA covers the full-range position of the remaining ETH, plus 0.01% of
    ///         `value`: the real swap takes one step per 256-tick bitmap word, each rounding a few wei against the buyer
    ///         (the single-step model here does not), so the margin keeps the position ETH-limited. The DNA the margin
    ///         buys and the DNA it frees is burned (~47k DNA for 0.5 ETH at the defaults).
    /// @return dnaOut The DNA that buy returns (single-step model: within a few wei of the real swap, from above).
    function split(uint160 sqrtP0, int24 tickLower, int24 tickUpper, uint256 value)
        internal
        pure
        returns (uint256 buyEth, uint256 dnaOut)
    {
        uint128 l0;
        (sqrtP0, l0) = _start(sqrtP0, tickLower, tickUpper);
        (uint256 lo, uint256 hi) = (1, value - 1); // _covers is monotone in the buy: more DNA, less ETH to pair
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_covers(sqrtP0, l0, mid, value)) hi = mid;
            else lo = mid + 1;
        }
        buyEth = lo + value / 10_000;
        require(buyEth < value, "launch split: no ETH left for the full-range position");
        (, dnaOut) = _buy(sqrtP0, l0, buyEth);
    }

    /// @return dna What a launch buy of `buyEth` returns (same model as `split`).
    function buyOutput(uint160 sqrtP0, int24 tickLower, int24 tickUpper, uint256 buyEth)
        internal
        pure
        returns (uint256 dna)
    {
        (uint160 s0, uint128 l0) = _start(sqrtP0, tickLower, tickUpper);
        (, dna) = _buy(s0, l0, buyEth);
    }

    /// @dev The main position's liquidity, and where the buy starts meeting it: the opening price, or TICK_UPPER's
    ///      price when the opening price sits above it (no liquidity in between: the price moves there for free).
    function _start(uint160 sqrtP0, int24 tickLower, int24 tickUpper) private pure returns (uint160 s0, uint128 l0) {
        uint160 upper = TickMath.getSqrtPriceAtTick(tickUpper);
        s0 = sqrtP0 < upper ? sqrtP0 : upper;
        l0 = LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(tickLower), upper, SUPPLY);
    }

    function _buy(uint160 s0, uint128 l0, uint256 x) private pure returns (uint160 s1, uint256 dna) {
        uint256 fee = FeeMath.fromGross(x, FEE_AT_LAUNCH);
        s1 = SqrtPriceMath.getNextSqrtPriceFromInput(s0, l0, x - fee, true);
        dna = SqrtPriceMath.getAmount1Delta(s1, s0, l0, false);
    }

    function _covers(uint160 s0, uint128 l0, uint256 x, uint256 value) private pure returns (bool) {
        (uint160 s1, uint256 dna) = _buy(s0, l0, x);
        uint128 l = LiquidityAmounts.getLiquidityForAmount0(s1, TickMath.MAX_SQRT_PRICE, value - x);
        return SqrtPriceMath.getAmount1Delta(TickMath.MIN_SQRT_PRICE, s1, l, true) <= dna;
    }
}

interface ISafeOwners {
    function getOwners() external view returns (address[] memory);
}

/// @dev View of the graph factory missing from the vendored launch-facing interface.
interface IGraphView {
    function computeGraphCommitment(IGraph.GraphAuthorization calldata, IGraph.Target[] calldata)
        external
        view
        returns (bytes32 commitment, uint256 targetValueSum);
}

/// @dev Local stand-in for Programmable's permit-authority Safe: has code (the Router requires it) and accepts every
///      signature, so a broadcast launch on anvil (LaunchLocal) needs no `vm.mockCall`. On a mainnet fork the real
///      authority Safe is used: Launch.t.sol / UniversalRouter.t.sol mock its ERC-1271 answer, Rehearsal.t.sol and
///      engine/scripts/rehearsal.sh pre-approve the Safe message hash from its owner (real isValidSignature path).
contract PermitAuthorityStub {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7e; // ERC1271 magic
    }
}

/// @dev Local stand-in for Chainlink's VRF v2.5 coordinator (LaunchLocal / local tests): subscriptions, native funding,
///      consumer-checked requests, and a permissionless `fulfill` so anvil users can deliver draw randomness (anyone
///      then settles). Never on mainnet: mainnetConfig pins the real coordinator.
contract LocalVRFCoordinator {
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => uint96) public nativeBalance;
    mapping(uint256 => mapping(address => bool)) public isConsumer;
    mapping(uint256 => address) public consumerOf; // request id → consumer
    uint256 public nextSub = 1;
    uint256 public nextReq = 1;

    function createSubscription() external returns (uint256 id) {
        id = nextSub++;
        ownerOf[id] = msg.sender;
    }

    function addConsumer(uint256 id, address c) external {
        require(ownerOf[id] == msg.sender, "MustBeSubOwner");
        isConsumer[id][c] = true;
    }

    function fundSubscriptionWithNative(uint256 id) external payable {
        require(ownerOf[id] != address(0), "InvalidSubscription");
        nativeBalance[id] += uint96(msg.value);
    }

    function getSubscription(uint256 id) external view returns (uint96, uint96, uint64, address, address[] memory c) {
        require(ownerOf[id] != address(0), "InvalidSubscription");
        return (0, nativeBalance[id], 0, ownerOf[id], c);
    }

    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata r) external returns (uint256 id) {
        require(isConsumer[r.subId][msg.sender], "InvalidConsumer");
        id = nextReq++;
        consumerOf[id] = msg.sender;
    }

    function fulfill(uint256 id, uint256 word) external {
        address c = consumerOf[id];
        delete consumerOf[id];
        uint256[] memory w = new uint256[](1);
        w[0] = word;
        GamePot(payable(c)).rawFulfillRandomWords(id, w);
    }
}

/// @title LaunchPlanner
/// @notice The whole DNA launch pipeline as pure planning + a rehearsal. Given (Safe, launch wallet, Programmable
///         Router/graph factory, namespace, nonce, launch params) it computes every address, mines the hook salt,
///         dry-runs the graph to learn the runtime hashes, builds the exact `launchAndStampV1` envelope (the digest is
///         what Programmable signs), then executes it with a mocked EIP-1271 answer and measures gas.
/// @dev Launch graph (stamped, in this target order, Bootstrap initializer last):
///        0 DNAToken(bootstrap) · 1 DNAHook(PM, token, registry, feeVault, platformRevenue, buybackBurn)
///        2 PlatformRevenue(PM, platformRecipient) · 3 Bootstrap(safe, positionManager, graphFactory) + initialize(...)
///      Post-launch (not stamped), CREATE2 via 0x4e59…956C with one salt (the init codes differ), initializer = Safe,
///      in dependency order: ModuleRegistry(safe, agent, anchorKey, 5, safe) · BuybackBurn(PM, safe)
///        · LiquidityVault(PM, safe) · ConvictionVault(registry, safe, excluded[])
///        · GamePot(PM, safe, vault, registry, vrfCoordinator, vrfKeyHash)
///        · FeeVault(PM, registry, buybackBurn, liquidityVault, gamePot, safe) · MutationBoard(vault, registry);
///      then the Safe calls initialize(hook) on registry, BuybackBurn, LiquidityVault, GamePot, and
///      ConvictionVault.initialize(gamePot). Nothing in the set holds the hook or the token in init code, so every
///      address is known before the graph (the hook bakes registry, FeeVault and BuybackBurn).
///      Every input that changes any init code (token metadata, Safe, agent keys, recipient, namespace, nonce, launch
///      wallet) changes the addresses and the hook salt: rerun the script, it re-derives everything.
abstract contract LaunchPlanner is CommonBase {
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 internal constant TX_GAS_CAP = 16_777_216; // EIP-7825
    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;

    bytes32 internal constant ID_TOKEN = keccak256("dna.token");
    bytes32 internal constant ID_HOOK = keccak256("dna.hook");
    bytes32 internal constant ID_PLATFORM = keccak256("dna.platformRevenue");
    bytes32 internal constant ID_BOOTSTRAP = keccak256("dna.bootstrap");

    // Copied from ProgrammableCreate2GraphDeployerV1 / ProgrammableLaunchStampRouterV1 (private there).
    bytes32 internal constant TARGET_SALT_TYPEHASH = keccak256(
        "ProgrammableCreate2GraphTargetSaltV1(uint256 chainId,address factory,bytes32 routeNamespace,bytes32 routeNonce,bytes32 targetIdHash,bytes32 applicantSalt,address authorizedLauncher)"
    );
    bytes32 internal constant EXPECTED_GRAPH_OUTPUT_TYPEHASH = keccak256(
        "ProgrammableExpectedGraphOutputV1(uint8 targetIndex,bytes32 targetIdHash,address account,bytes32 runtimeCodeHash)"
    );
    bytes32 internal constant EXPECTED_GRAPH_RESULT_TYPEHASH =
        keccak256("ProgrammableExpectedGraphResultV1(bytes32 expectedOutputsHash,bytes32 graphDeploymentHash)");

    struct Config {
        address safe;
        address launchWallet; // permit.launchWallet = msg.sender of launchAndStampV1
        address agent;
        address anchorKey;
        address platformRecipient;
        IPoolManager poolManager;
        IPositionManager positionManager;
        IGraph factory; // Programmable graph deployer: deploys targets, calls Bootstrap.initialize
        IRouter router;
        bytes32 namespace;
        bytes32 nonce;
        bytes32 postLaunchSalt;
        uint64 validAfter;
        uint256 initialBuy;
        Bootstrap.LaunchParams params;
        IVRFCoordinatorV2Plus vrfCoordinator; // address-shaping (GamePot init code): hard-coded on mainnet, never env
        bytes32 vrfKeyHash;
        address[] excluded; // ConvictionVault: Safe signers' EOAs + team wallets (EXCLUDED_WALLETS on mainnet)
    }

    struct Addrs {
        address token;
        address hook;
        address platformRevenue;
        address bootstrap;
        address registry;
        address feeVault;
        address buybackBurn;
        address liquidityVault;
        address convictionVault;
        address gamePot;
        address mutationBoard;
    }

    /// @dev Mainnet VRF v2.5 (Chainlink): coordinator and the 200 gwei lane (GamePot.LANE_MAX_GAS_PRICE), fork-verified
    ///      in test/fork/GamePotVRF.t.sol.
    address internal constant VRF_COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;
    bytes32 internal constant VRF_KEY_HASH = 0x8077df514608a09f83e4e8d300645594e5d7234665448ba83f51a50f842bd3d9;

    struct Plan {
        Addrs a;
        bytes32 hookSalt;
        bytes[] postInits; // post-launch CREATE2 init codes, in deployment (dependency) order
        address[] postAddrs; // registry, BuybackBurn, LiquidityVault, ConvictionVault, GamePot, FeeVault, MutationBoard
        IRouter.LaunchPermitV1 permit;
        IRouter.StampRequestV1 stamp;
        bytes routePayload;
        bytes32 digest;
    }

    // =============================================================== planning

    function plan(Config memory c) internal returns (Plan memory p) {
        Addrs memory a = p.a;
        bytes memory bootstrapInit =
            abi.encodePacked(type(Bootstrap).creationCode, abi.encode(c.safe, c.positionManager, address(c.factory)));
        a.bootstrap = graphAddress(c, ID_BOOTSTRAP, 0, keccak256(bootstrapInit));
        bytes memory tokenInit = abi.encodePacked(type(DNAToken).creationCode, abi.encode(a.bootstrap));
        a.token = graphAddress(c, ID_TOKEN, 0, keccak256(tokenInit));
        bytes memory platformInit =
            abi.encodePacked(type(PlatformRevenue).creationCode, abi.encode(c.poolManager, c.platformRecipient));
        a.platformRevenue = graphAddress(c, ID_PLATFORM, 0, keccak256(platformInit));

        postLaunchInits(c, p);

        bytes memory hookInit = abi.encodePacked(
            type(DNAHook).creationCode,
            abi.encode(c.poolManager, a.token, a.registry, a.feeVault, a.platformRevenue, a.buybackBurn)
        );
        (p.hookSalt, a.hook) = mineHookSalt(c, keccak256(hookInit));

        IGraph.Target[] memory t = new IGraph.Target[](4);
        t[0] = IGraph.Target(ID_TOKEN, 0, 0, 0, tokenInit, "");
        t[1] = IGraph.Target(ID_HOOK, p.hookSalt, 0, 0, hookInit, "");
        t[2] = IGraph.Target(ID_PLATFORM, 0, 0, 0, platformInit, "");
        t[3] = IGraph.Target(
            ID_BOOTSTRAP,
            0,
            0,
            c.initialBuy,
            bootstrapInit,
            abi.encodeCall(Bootstrap.initialize, (a.token, a.hook, c.params))
        );
        _envelope(c, p, t);
    }

    /// @notice Init codes + CREATE2 (0x4e59) addresses of the post-launch set. Needs no graph, so it also works after
    ///         launch (PostLaunchMainnet), when `plan` can no longer dry-run the graph.
    function postLaunchInits(Config memory c, Plan memory p) internal pure {
        Addrs memory a = p.a;
        p.postInits = new bytes[](7);
        p.postAddrs = new address[](7);
        a.registry = _post(
            c, p, 0, type(ModuleRegistry).creationCode, abi.encode(c.safe, c.agent, c.anchorKey, uint8(5), c.safe)
        );
        a.buybackBurn = _post(c, p, 1, type(BuybackBurn).creationCode, abi.encode(c.poolManager, c.safe));
        a.liquidityVault = _post(c, p, 2, type(LiquidityVault).creationCode, abi.encode(c.poolManager, c.safe));
        a.convictionVault =
            _post(c, p, 3, type(ConvictionVault).creationCode, abi.encode(a.registry, c.safe, c.excluded));
        a.gamePot = _post(
            c,
            p,
            4,
            type(GamePot).creationCode,
            abi.encode(c.poolManager, c.safe, a.convictionVault, a.registry, c.vrfCoordinator, c.vrfKeyHash)
        );
        a.feeVault = _post(
            c,
            p,
            5,
            type(FeeVault).creationCode,
            abi.encode(c.poolManager, a.registry, a.buybackBurn, a.liquidityVault, a.gamePot, c.safe)
        );
        a.mutationBoard = _post(c, p, 6, type(MutationBoard).creationCode, abi.encode(a.convictionVault, a.registry));
    }

    function _post(Config memory c, Plan memory p, uint256 i, bytes memory code, bytes memory args)
        private
        pure
        returns (address)
    {
        p.postInits[i] = abi.encodePacked(code, args);
        return p.postAddrs[i] = create2(CREATE2_FACTORY, c.postLaunchSalt, p.postInits[i]);
    }

    /// @notice The Safe's wiring calls, in order: initialize(hook) on registry, BuybackBurn, LiquidityVault and GamePot
    ///         (which creates its VRF subscription and opens jackpot window 1), then
    ///         ConvictionVault.initialize(gamePot) (binds DNA, read from the pot).
    function wiringCalls(Addrs memory a) internal pure returns (address[] memory to, bytes[] memory data) {
        to = new address[](5);
        data = new bytes[](5);
        (to[0], to[1], to[2], to[3], to[4]) =
        (a.registry, a.buybackBurn, a.liquidityVault, a.gamePot, a.convictionVault);
        for (uint256 i; i < 4; ++i) {
            data[i] = abi.encodeCall(IInitializable.initialize, (a.hook));
        }
        data[4] = abi.encodeCall(ConvictionVault.initialize, (a.gamePot));
    }

    /// @dev Builds route + stamp request + permit. Runtime hashes and the graph deployment hash come from a dry run of
    ///      the exact graph (immutables make them unpredictable otherwise), which is then reverted.
    function _envelope(Config memory c, Plan memory p, IGraph.Target[] memory t) private {
        IGraph.GraphAuthorization memory auth = IGraph.GraphAuthorization(
            c.namespace, c.nonce, topologyHash(t), bytes32(0), address(c.router), c.initialBuy
        );
        (auth.graphCommitment,) = IGraphView(address(c.factory)).computeGraphCommitment(auth, t);

        uint256 snap = vm.snapshotState();
        vm.deal(address(c.router), c.initialBuy);
        vm.prank(address(c.router));
        (address[] memory deployed, bytes32[] memory runtime,, bytes32 deploymentHash) =
            c.factory.deployGraph{value: c.initialBuy}(auth, t);
        vm.revertToState(snap);

        IRouter.ExpectedGraphOutputV1[] memory out = new IRouter.ExpectedGraphOutputV1[](t.length);
        IRouter.ComponentV1[] memory comps = new IRouter.ComponentV1[](t.length);
        for (uint256 i; i < t.length; ++i) {
            out[i] = IRouter.ExpectedGraphOutputV1(uint8(i), t[i].targetIdHash, deployed[i], runtime[i]);
            IRouter.ComponentKindV1 kind = i == 0
                ? IRouter.ComponentKindV1.Token
                : (i == 1 ? IRouter.ComponentKindV1.Hook : IRouter.ComponentKindV1.Other);
            comps[i] = IRouter.ComponentV1(uint8(i), deployed[i], runtime[i], kind, IRouter.ComponentScopeV1.Exclusive);
        }
        _sortByAccount(comps);

        p.routePayload = abi.encode(
            IRouter.CustomGraphRouteV1(
                c.namespace, c.nonce, auth.topologyHash, auth.graphCommitment, t, out, deploymentHash
            )
        );
        p.stamp = IRouter.StampRequestV1(
            keccak256(abi.encode("DNA", c.namespace, c.nonce)), // launchId: builder-chosen, nonzero
            p.a.token,
            runtime[0],
            PoolKey(
                Currency.wrap(address(0)), Currency.wrap(p.a.token), LPFeeLibrary.DYNAMIC_FEE_FLAG, 1, IHooks(p.a.hook)
            ),
            runtime[1],
            comps
        );
        ProgrammableLaunchStampRouterV1 router = ProgrammableLaunchStampRouterV1(address(c.router));
        p.permit = IRouter.LaunchPermitV1(
            block.chainid,
            address(c.router),
            c.launchWallet,
            IRouter.LaunchKindV1.CustomGraph,
            keccak256(p.routePayload),
            expectedResultHash(out, deploymentHash),
            router.computeStampRequestHash(p.stamp),
            c.nonce,
            c.validAfter,
            c.validAfter + 1 hours,
            c.initialBuy
        );
        p.digest = router.permitDigest(p.permit);
    }

    /// @notice Same formula as ProgrammableCreate2GraphDeployerV1.effectiveTargetSalt + CREATE2 from the factory.
    function graphAddress(Config memory c, bytes32 id, bytes32 applicantSalt, bytes32 initCodeHash)
        internal
        view
        returns (address)
    {
        bytes32 salt = keccak256(
            abi.encode(
                TARGET_SALT_TYPEHASH,
                block.chainid,
                address(c.factory),
                c.namespace,
                c.nonce,
                id,
                applicantSalt,
                address(c.router)
            )
        );
        return
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(c.factory), salt, initCodeHash)))));
    }

    function create2(address deployer, bytes32 salt, bytes memory initCode) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, keccak256(initCode))))));
    }

    /// @notice First applicant salt whose hook address has all 14 permission bits set (Hooks.ALL_HOOK_MASK).
    // Linear scan, ~16k tries on average; fine offline. Parallel/off-chain miner only if a vanity prefix is wanted.
    function mineHookSalt(Config memory c, bytes32 initCodeHash) internal view returns (bytes32 salt, address hook) {
        uint256 fmp;
        assembly ("memory-safe") {
            fmp := mload(0x40)
        }
        for (uint256 i;; ++i) {
            hook = graphAddress(c, ID_HOOK, bytes32(i), initCodeHash);
            assembly ("memory-safe") {
                mstore(0x40, fmp) // drop the per-try abi.encode buffers (else memory cost grows quadratically)
            }
            if (uint160(hook) & Hooks.ALL_HOOK_MASK == Hooks.ALL_HOOK_MASK) {
                // deterministic: the first match is THE hook; code there means this graph already launched
                require(hook.code.length == 0, "hook already deployed: launch already mined? run PostLaunchMainnet");
                return (bytes32(i), hook);
            }
        }
    }

    /// @dev Builder-chosen commitment to the graph shape (target ids in order). Programmable's own encoding is unknown.
    function topologyHash(IGraph.Target[] memory t) internal pure returns (bytes32) {
        bytes32[] memory ids = new bytes32[](t.length);
        for (uint256 i; i < t.length; ++i) {
            ids[i] = t[i].targetIdHash;
        }
        return keccak256(abi.encode("DNA launch graph v1", ids));
    }

    function expectedResultHash(IRouter.ExpectedGraphOutputV1[] memory out, bytes32 deploymentHash)
        internal
        pure
        returns (bytes32)
    {
        bytes32[] memory h = new bytes32[](out.length);
        for (uint256 i; i < out.length; ++i) {
            h[i] = keccak256(
                abi.encode(
                    EXPECTED_GRAPH_OUTPUT_TYPEHASH,
                    out[i].targetIndex,
                    out[i].targetIdHash,
                    out[i].account,
                    out[i].runtimeCodeHash
                )
            );
        }
        return keccak256(abi.encode(EXPECTED_GRAPH_RESULT_TYPEHASH, keccak256(abi.encodePacked(h)), deploymentHash));
    }

    function _sortByAccount(IRouter.ComponentV1[] memory a) private pure {
        for (uint256 i = 1; i < a.length; ++i) {
            for (uint256 j = i; j > 0 && a[j - 1].account > a[j].account; --j) {
                (a[j - 1], a[j]) = (a[j], a[j - 1]);
            }
        }
    }

    // =============================================================== execution (rehearsal only)

    /// @notice Calldata of the launch transaction (65-byte Safe owner signature placeholder: all nonzero, worst case).
    function launchCalldata(Plan memory p) internal pure returns (bytes memory) {
        bytes memory sig = new bytes(65);
        for (uint256 i; i < 65; ++i) {
            sig[i] = 0x11;
        }
        return launchCalldata(p, sig);
    }

    /// @notice Calldata of the launch transaction with Programmable's signature over `p.digest`.
    function launchCalldata(Plan memory p, bytes memory sig) internal pure returns (bytes memory) {
        return abi.encodeCall(IRouter.launchAndStampV1, (p.permit, p.stamp, p.routePayload, sig));
    }

    /// @notice Executes the permit as the launch wallet; returns the gas of the whole transaction. Reverts above the
    ///         EIP-7825 cap (the gate).
    /// @dev Needs forge isolation (`isolate = true`, pinned in foundry.toml): each top-level call then runs as its own
    ///      transaction, so it starts cold and `lastFrameGas().gasTotalUsed` already includes intrinsic gas. The `gas:`
    ///      stipend is NOT a tx gas limit under isolation (probed: a too-small stipend still "succeeds" with 0 gas
    ///      reported), so the gate is the explicit require below. Isolation follows evm_version cancun: no EIP-7623
    ///      calldata floor, but for this calldata the floor (21,000 + 10/40 gas per zero/nonzero byte, < 1.2M) is far
    ///      below the measured gas, so it never binds.
    ///      Under-count: `vm.mockCall` answers the permit authority's ERC-1271 check, skipping the real Safe
    ///      `isValidSignature` (tens of thousands of gas on mainnet).
    function launch(Config memory c, Plan memory p) internal returns (uint256 txGas) {
        require(vm.isIsolateMode(), "run with isolate = true");
        vm.mockCall(
            ProgrammableLaunchStampRouterV1(address(c.router)).PERMIT_AUTHORITY(),
            abi.encodeWithSelector(IERC1271.isValidSignature.selector),
            abi.encode(ERC1271_MAGIC)
        );
        vm.deal(c.launchWallet, c.initialBuy);
        vm.prank(c.launchWallet);
        (bool ok, bytes memory ret) = address(c.router).call{value: c.initialBuy, gas: 30_000_000}(launchCalldata(p));
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        txGas = vm.lastFrameGas().gasTotalUsed;
        require(txGas != 0 && txGas <= TX_GAS_CAP, "launch gas gate: > 16,777,216");
    }

    /// @notice Post-launch deployments (0x4e59 CREATE2, `postAddrs` order) and the Safe's five wiring calls; gas per tx
    ///         (7 deploys, then 5 wiring calls).
    function postLaunch(Config memory c, Plan memory p) internal returns (uint256[12] memory gas) {
        for (uint256 i; i < 7; ++i) {
            (bool ok, bytes memory ret) = CREATE2_FACTORY.call(abi.encodePacked(c.postLaunchSalt, p.postInits[i]));
            gas[i] = vm.lastFrameGas().gasTotalUsed;
            require(ok && address(bytes20(ret)) == p.postAddrs[i], "post-launch address mismatch");
        }
        (address[] memory to, bytes[] memory data) = wiringCalls(p.a);
        for (uint256 i; i < 5; ++i) {
            vm.prank(c.safe);
            (bool ok, bytes memory ret) = to[i].call(data[i]);
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            gas[7 + i] = vm.lastFrameGas().gasTotalUsed;
        }
    }

    // =============================================================== T0 module set (SPEC §3.1)

    /// @notice Plates 0-2 = AdaptiveFee (same bytecode, separate deployments), 3 = BaselineSplit; CREATE2 via 0x4e59.
    function plateSalt(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode("dna.plate", i));
    }

    function plateInit(uint256 i) internal pure returns (bytes memory) {
        return i < 3 ? type(AdaptiveFee).creationCode : type(BaselineSplit).creationCode;
    }

    function plateAddress(uint256 i) internal pure returns (address) {
        return create2(CREATE2_FACTORY, plateSalt(i), plateInit(i));
    }

    /// @notice AdaptiveFee bounds that keep every in-bounds project fee in [1%, 3.5%] (SPEC §3.1):
    ///         [base pips, multiplier ×1e4, cap pips, unused]; fee = min(base + mult·volEma/1e4, cap).
    ///         Multiplier 0.1×–1.8×: low multipliers keep a plate off its cap at launch-day volatility, so the
    ///         evolution loop still sees different fees (a plate pinned at cap gives no signal).
    function feeBounds() internal pure returns (bytes32[4] memory lo, bytes32[4] memory hi) {
        lo = [bytes32(uint256(10_000)), bytes32(uint256(1_000)), bytes32(uint256(10_000)), bytes32(0)];
        hi = [bytes32(uint256(35_000)), bytes32(uint256(18_000)), bytes32(uint256(35_000)), bytes32(0)];
    }

    /// @notice Initial plate params (the engine tunes them later with SetParams inside `feeBounds`):
    ///         A 1.5% base · B 2.0% · C 2.5%; multiplier 0.3× / 1.0× / 1.8×; cap 3.5% for all.
    function plateParams(uint256 i) internal pure returns (bytes32[4] memory p) {
        if (i == 3) return p; // BaselineSplit ignores params: p = min = max = 0
        uint256[3] memory base = [uint256(15_000), 20_000, 25_000];
        uint256[3] memory mult = [uint256(3_000), 10_000, 18_000];
        p = [bytes32(base[i]), bytes32(mult[i]), bytes32(uint256(35_000)), bytes32(0)];
    }

    /// @notice specHash = keccak256 of the engine's manifest file bytes (the engine hashes the same file).
    function specHash(uint256 i) internal view returns (bytes32) {
        string memory m = i < 3 ? "adaptive-fee-v1" : "baseline-split-v1";
        return keccak256(bytes(vm.readFile(string.concat("../engine/modules/", m, ".json"))));
    }

    /// @notice The Safe's T0 batch, in order: the five wiring calls (`wiringCalls`), then queue Register for the
    ///         three AdaptiveFee plates and BaselineSplit (executable by anyone 1 h later).
    function t0Batch(Addrs memory a) internal view returns (address[] memory to, bytes[] memory data) {
        to = new address[](9);
        data = new bytes[](9);
        (address[] memory wt, bytes[] memory wd) = wiringCalls(a);
        for (uint256 i; i < 5; ++i) {
            (to[i], data[i]) = (wt[i], wd[i]);
        }
        (bytes32[4] memory lo, bytes32[4] memory hi) = feeBounds();
        for (uint256 i; i < 4; ++i) {
            bytes32[4] memory p = plateParams(i);
            (ModuleRegistry.Kind k, bytes32[4] memory l, bytes32[4] memory h) =
                i < 3 ? (ModuleRegistry.Kind.Fee, lo, hi) : (ModuleRegistry.Kind.Split, p, p);
            to[5 + i] = a.registry;
            data[5 + i] = abi.encodeCall(
                ModuleRegistry.queue, (ModuleRegistry.Op.Register, abi.encode(plateAddress(i), k, specHash(i), p, l, h))
            );
        }
    }

    /// @notice IdeaMarket / BountyBoard init codes (CREATE2 with the post-launch salt: same address on every re-run).
    function ideaMarketInit(Addrs memory a) internal pure returns (bytes memory) {
        return abi.encodePacked(type(IdeaMarket).creationCode, abi.encode(a.token, a.registry));
    }

    function bountyBoardInit(Addrs memory a) internal pure returns (bytes memory) {
        return abi.encodePacked(type(BountyBoard).creationCode, abi.encode(a.registry));
    }

    /// @notice The X handle in the frozen tokenURI must be confirmed explicitly, so the stand-in can
    ///         never ship by accident. A throwaway simulated token reads the compiled literal (never broadcast: every
    ///         caller runs this before startBroadcast). Its supply goes to 0xdEaD: forge refuses a script that hands its
    ///         own ephemeral `address(this)` to a CREATE.
    function requireXHandleConfirmed(string memory confirmed) internal {
        string memory handle = new DNAToken(address(0xdEaD)).X_HANDLE();
        require(
            keccak256(bytes(handle)) != keccak256("TODO_X_HANDLE"),
            "DNAToken.X_HANDLE is still the stand-in: set the real handle first"
        );
        require(
            keccak256(bytes(confirmed)) == keccak256(bytes(handle)),
            "X_HANDLE_CONFIRMED != DNAToken.X_HANDLE: confirm the X handle first"
        );
    }

    /// @notice The jackpot exclusion list (ConvictionVault init code) is non-empty, has no zero address and
    ///         contains every Safe signer. Fails closed: a wrong list would bake into every post-launch address.
    function requireExcluded(address[] memory excluded, address[] memory signers) internal pure {
        require(excluded.length != 0, "EXCLUDED_WALLETS is empty");
        for (uint256 i; i < excluded.length; ++i) {
            require(excluded[i] != address(0), "EXCLUDED_WALLETS has the zero address");
        }
        for (uint256 s; s < signers.length; ++s) {
            bool found;
            for (uint256 i; i < excluded.length; ++i) {
                if (excluded[i] == signers[s]) found = true;
            }
            require(found, "a Safe signer is missing from EXCLUDED_WALLETS");
        }
    }

    /// @notice Programmable requires a nonzero initial buy on Ethereum V3 (default 0.5 ETH).
    function requireInitialBuy(uint256 initialBuy) internal pure {
        require(initialBuy != 0, "INITIAL_BUY_WEI must be nonzero");
    }

    /// @notice What the launch wallet must hold on top of the initial buy for the launch tx's gas (default 0.03 ETH:
    ///         launchAndStampV1 is ~6.5M gas, 0.0065 ETH at 1 gwei, so ~4.6x).
    function launchGasMargin() internal view returns (uint256) {
        return vm.envOr("LAUNCH_GAS_MARGIN_WEI", uint256(0.03 ether));
    }

    // =============================================================== environments

    /// @notice The CLAUS launch curve: open at tick 201107 (~1.85 ETH FDV), the whole supply DNA-only in [1107, 201107),
    ///         and a 0.5 ETH launch value (INITIAL_BUY_WEI): BUY_WEI of it buys DNA (default: LaunchSplit, ~0.24 ETH),
    ///         the rest is locked with that DNA as a full-range position (both positions owned by 0xdEaD), and the DNA
    ///         the full-range position does not need is burned. MIN_DNA_OUT defaults to 90% of the predicted
    ///         output of the actual buy, a sanity bound (the buy is atomic with the pool init, so its output is fixed).
    ///         Parameters, not constants: override via env.
    function defaultParams(uint256 initialBuy) internal view returns (Bootstrap.LaunchParams memory p) {
        p = launchParams(
            vm.envOr("OPEN_SQRT_PRICE_X96", uint256(1843504778864234216533230113107236)).toUint160(),
            vm.envOr("TICK_LOWER", int256(1107)).toInt24(),
            vm.envOr("TICK_UPPER", int256(201107)).toInt24(),
            initialBuy,
            vm.envOr("BUY_WEI", uint256(0))
        );
        p.minDnaOut = vm.envOr("MIN_DNA_OUT", p.minDnaOut);
    }

    /// @notice The launch params from the curve and the launch value. `buyEth` 0 = the split; an explicit one must be at
    ///         least the split (below it the full-range position would be DNA-limited and send ETH to the Safe).
    ///         minDnaOut = 90% of what the actual buy returns.
    function launchParams(uint160 sqrtP, int24 tickLower, int24 tickUpper, uint256 value, uint256 buyEth)
        internal
        pure
        returns (Bootstrap.LaunchParams memory p)
    {
        require(TickMath.getTickAtSqrtPrice(sqrtP) == tickUpper, "the opening tick must equal TICK_UPPER");
        (uint256 split,) = LaunchSplit.split(sqrtP, tickLower, tickUpper, value);
        if (buyEth == 0) buyEth = split;
        require(buyEth >= split, "BUY_WEI below the launch split: the full-range position would be DNA-limited");
        p = Bootstrap.LaunchParams({
            sqrtPriceX96: sqrtP,
            tickLower: tickLower,
            tickUpper: tickUpper,
            minDnaOut: LaunchSplit.buyOutput(sqrtP, tickLower, tickUpper, buyEth) * 9 / 10,
            buyEth: buyEth
        });
    }

    /// @notice Everything except the chain addresses, from env with rehearsal defaults.
    function baseConfig() internal view returns (Config memory c) {
        c.safe = vm.envOr("SAFE", address(0x5AFE));
        c.launchWallet = vm.envOr("LAUNCH_WALLET", address(0x1A0C4));
        c.agent = vm.envOr("AGENT", address(0xA6E7));
        c.anchorKey = vm.envOr("ANCHOR_KEY", address(0xA7C4));
        c.platformRecipient = vm.envOr("PLATFORM_RECIPIENT", address(0xD88539d3c4C460136a733A3Fd60cf6BF269079da));
        c.namespace = vm.envOr("ROUTE_NAMESPACE", keccak256("dna.rehearsal.namespace"));
        c.nonce = vm.envOr("ROUTE_NONCE", keccak256("dna.rehearsal.nonce"));
        c.postLaunchSalt = vm.envOr("POST_LAUNCH_SALT", keccak256("dna.v1"));
        c.validAfter = vm.envOr("VALID_AFTER", block.timestamp).toUint64();
        c.initialBuy = vm.envOr("INITIAL_BUY_WEI", uint256(0.5 ether));
        c.params = defaultParams(c.initialBuy);
        address[] memory test = new address[](3); // rehearsal stand-ins for the 3 signers' EOAs (mainnet: env, checked)
        (test[0], test[1], test[2]) = (address(0x5161), address(0x5162), address(0x5163));
        c.excluded = vm.envOr("EXCLUDED_WALLETS", ",", test);
        c.vrfKeyHash = VRF_KEY_HASH;
    }

    function mainnetConfig() internal view returns (Config memory c) {
        c = baseConfig();
        c.poolManager = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
        c.positionManager = IPositionManager(0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e);
        c.factory = IGraph(0xB012e4A8F2c5FC4E8E4faCA9D5Ad6FfF13FBA887);
        c.router = IRouter(0xBE4bF6Ac8c6F012E1C8f25747A9fBccB2FDAC4C3); // the 24-hour successor fresh 3.6 packs bind
        c.vrfCoordinator = IVRFCoordinatorV2Plus(VRF_COORDINATOR);
    }

    /// @notice Fresh local PoolManager + PositionManager + Programmable graph factory + Router (vendored MIT sources).
    ///         PositionManager gets no Permit2/WETH/descriptor: the launch never touches them.
    function localConfig() internal returns (Config memory c) {
        c = localInfra(baseConfig());
    }

    /// @notice Deploys the local infra into `c` (real transactions when called inside vm.startBroadcast).
    function localInfra(Config memory c) internal returns (Config memory) {
        c.poolManager = new PoolManager(c.safe);
        c.positionManager = new PositionManager(
            c.poolManager, IAllowanceTransfer(address(0)), 100_000, IPositionDescriptor(address(0)), IWETH9(address(0))
        );
        c.factory = IGraph(address(new ProgrammableCreate2GraphDeployerV1()));
        c.router = IRouter(
            address(new ProgrammableLaunchStampRouterV1(address(new PermitAuthorityStub()), c.factory, c.poolManager))
        );
        c.vrfCoordinator = IVRFCoordinatorV2Plus(address(new LocalVRFCoordinator()));
        return c;
    }

    // =============================================================== broadcast (local anvil)

    /// @notice `launch` as a real transaction from the launch wallet (the local stub authority accepts the placeholder
    ///         signature). Same calldata as the rehearsal.
    function launchBroadcast(Config memory c, Plan memory p, uint256 launchKey) internal {
        vm.startBroadcast(launchKey);
        (bool ok, bytes memory ret) = address(c.router).call{value: c.initialBuy}(launchCalldata(p));
        vm.stopBroadcast();
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    /// @notice `postLaunch` as real transactions: CREATE2 deployments via 0x4e59 and the five wiring calls, all sent by
    ///         the Safe key (an EOA locally).
    function postLaunchBroadcast(Config memory c, Plan memory p, uint256 safeKey) internal {
        (address[] memory to, bytes[] memory data) = wiringCalls(p.a);
        vm.startBroadcast(safeKey);
        for (uint256 i; i < 7; ++i) {
            (bool ok, bytes memory ret) = CREATE2_FACTORY.call(abi.encodePacked(c.postLaunchSalt, p.postInits[i]));
            require(ok && address(bytes20(ret)) == p.postAddrs[i], "post-launch address mismatch");
        }
        for (uint256 i; i < 5; ++i) {
            (bool ok,) = to[i].call(data[i]);
            require(ok, "wiring call failed");
        }
        vm.stopBroadcast();
    }
}

/// @notice `forge script script/Launch.s.sol` (local) or `... --fork-url $MAINNET_RPC_URL` (real PoolManager,
///         PositionManager, graph factory and Router). Simulation only: never pass --broadcast (it pranks and mocks).
contract Launch is Script, LaunchPlanner {
    function run() external {
        Config memory c = block.chainid == 1 ? mainnetConfig() : localConfig();
        Plan memory p = plan(c);
        Addrs memory a = p.a;
        console.log("token          ", a.token);
        console.log("hook           ", a.hook);
        console.logBytes32(p.hookSalt);
        console.log("platformRevenue", a.platformRevenue);
        console.log("bootstrap      ", a.bootstrap);
        console.log("registry       ", a.registry);
        console.log("feeVault       ", a.feeVault);
        console.log("buybackBurn    ", a.buybackBurn);
        console.log("liquidityVault ", a.liquidityVault);
        console.log("convictionVault", a.convictionVault);
        console.log("gamePot        ", a.gamePot);
        console.log("mutationBoard  ", a.mutationBoard);
        console.log("permit digest (Programmable signs this):");
        console.logBytes32(p.digest);
        console.log("calldata bytes ", launchCalldata(p).length);

        console.log("launch tx gas  ", launch(c, p)); // reverts above 16,777,216
        console.log("GATE PASS (<= 16,777,216)");

        uint256[12] memory g = postLaunch(c, p);
        console.log("post deploy gas: registry, buyback, lp", g[0], g[1], g[2]);
        console.log("                 vault, gamePot, feeVault", g[3], g[4], g[5]);
        console.log("                 mutationBoard", g[6]);
        console.log("wiring gas: registry, buyback, lp", g[7], g[8], g[9]);
        console.log("            gamePot, vault", g[10], g[11]);
    }
}

/// @notice Real local deployment on anvil (chain 31337), for the engine e2e and local development:
///         `anvil --slots-in-an-epoch 1`, then
///         `forge script script/Launch.s.sol:LaunchLocal --rpc-url http://127.0.0.1:8545 --broadcast`.
///         Infra (PoolManager, PositionManager, graph factory, Router), the launch and the post-launch steps are all
///         broadcast. Roles are anvil default accounts (override with SAFE_KEY / LAUNCH_KEY / AGENT_KEY / ANCHOR_KEY):
///         0 Safe (an EOA here), 1 launch wallet, 2 agent, 3 anchor key. Writes engine/deployments/31337.json
///         (override with DEPLOYMENT_OUT).
contract LaunchLocal is Script, LaunchPlanner {
    using PoolIdLibrary for PoolKey;

    // anvil's default mnemonic, accounts 0-3 (public test keys, never use elsewhere)
    uint256 internal constant ANVIL_0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant ANVIL_1 = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant ANVIL_2 = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 internal constant ANVIL_3 = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;

    function run() external {
        require(block.chainid == 31337, "LaunchLocal: anvil only");
        require(CREATE2_FACTORY.code.length != 0, "no CREATE2 deployer at 0x4e59 (anvil ships one by default)");
        uint256 startBlock = block.number;
        uint256 safeKey = vm.envOr("SAFE_KEY", ANVIL_0);
        uint256 launchKey = vm.envOr("LAUNCH_KEY", ANVIL_1);
        Config memory c = baseConfig();
        c.safe = vm.addr(safeKey);
        c.launchWallet = vm.addr(launchKey);
        c.agent = vm.addr(vm.envOr("AGENT_KEY", ANVIL_2));
        c.anchorKey = vm.addr(vm.envOr("ANCHOR_KEY", ANVIL_3));

        vm.startBroadcast(safeKey);
        c = localInfra(c);
        vm.stopBroadcast();

        Plan memory p = plan(c); // the graph dry run is pranked + reverted: nothing broadcast
        launchBroadcast(c, p, launchKey);
        postLaunchBroadcast(c, p, safeKey);

        Addrs memory a = p.a;
        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "startBlock", startBlock);
        vm.serializeBytes32(o, "poolId", PoolId.unwrap(DNAHook(a.hook).poolKey().toId()));
        vm.serializeAddress(o, "safe", c.safe);
        vm.serializeAddress(o, "agent", c.agent);
        vm.serializeAddress(o, "anchorKey", c.anchorKey);
        vm.serializeAddress(o, "poolManager", address(c.poolManager));
        vm.serializeAddress(o, "positionManager", address(c.positionManager));
        vm.serializeAddress(o, "token", a.token);
        vm.serializeAddress(o, "hook", a.hook);
        vm.serializeAddress(o, "platformRevenue", a.platformRevenue);
        vm.serializeAddress(o, "bootstrap", a.bootstrap);
        vm.serializeAddress(o, "registry", a.registry);
        vm.serializeAddress(o, "feeVault", a.feeVault);
        vm.serializeAddress(o, "buybackBurn", a.buybackBurn);
        vm.serializeAddress(o, "liquidityVault", a.liquidityVault);
        vm.serializeAddress(o, "convictionVault", a.convictionVault);
        vm.serializeAddress(o, "mutationBoard", a.mutationBoard);
        vm.serializeAddress(o, "vrfCoordinator", address(c.vrfCoordinator));
        string memory json = vm.serializeAddress(o, "gamePot", a.gamePot);
        string memory out = vm.envOr("DEPLOYMENT_OUT", string("../engine/deployments/31337.json"));
        vm.writeJson(json, out);
        console.log("hook    ", a.hook);
        console.log("registry", a.registry);
        console.log("wrote   ", out);
    }
}

/// @notice Route A (Programmable's self-serve Custom Launch API V3): prints the deterministic literals the pack config
///         needs as one JSON line (engine/scripts/route-a.ts reads it). No RPC, no broadcast:
///         `forge script script/Launch.s.sol:RouteAParams`. The graph addresses (token, hook, PlatformRevenue,
///         Bootstrap) are NOT here: Programmable's packer derives them (namespace = f(source bundle, launch wallet)).
///         The post-launch CREATE2 set (registry, vaults) is, because the hook bakes those addresses in.
contract RouteAParams is Script, LaunchPlanner {
    function run() external {
        Config memory c = mainnetConfig();
        // route A fixes the hook, and so every post-launch address, at pack time: check the exclusion list against the
        // Safe's owners on chain now, not after the launch tx (only CI's explicit draft builds skip it)
        if (keccak256(bytes(vm.envOr("ROUTE_A_DRAFT", string("")))) != keccak256("1")) {
            require(block.chainid == 1, "route A: run with --rpc-url <mainnet> (EXCLUDED_WALLETS is checked on chain)");
            require(
                vm.envExists("EXCLUDED_WALLETS"),
                "missing env EXCLUDED_WALLETS (the Safe signers' EOAs, comma-separated)"
            );
            require(c.safe.code.length != 0, "SAFE has no code: deploy the Safe first");
            requireExcluded(c.excluded, ISafeOwners(c.safe).getOwners());
            requireInitialBuy(c.initialBuy);
        }
        Plan memory p;
        postLaunchInits(c, p);
        string memory o = "routeA";
        vm.serializeAddress(o, "poolManager", address(c.poolManager));
        vm.serializeAddress(o, "positionManager", address(c.positionManager));
        vm.serializeAddress(o, "graphFactory", address(c.factory));
        vm.serializeAddress(o, "router", address(c.router));
        vm.serializeAddress(o, "safe", c.safe);
        vm.serializeAddress(o, "agent", c.agent);
        vm.serializeAddress(o, "anchorKey", c.anchorKey);
        vm.serializeAddress(o, "platformRecipient", c.platformRecipient);
        vm.serializeBytes32(o, "postLaunchSalt", c.postLaunchSalt);
        vm.serializeAddress(o, "registry", p.a.registry);
        vm.serializeAddress(o, "feeVault", p.a.feeVault);
        vm.serializeAddress(o, "buybackBurn", p.a.buybackBurn);
        vm.serializeAddress(o, "liquidityVault", p.a.liquidityVault);
        vm.serializeAddress(o, "convictionVault", p.a.convictionVault);
        vm.serializeAddress(o, "gamePot", p.a.gamePot);
        vm.serializeAddress(o, "mutationBoard", p.a.mutationBoard);
        // big numbers as decimal strings: JSON numbers above 2^53 lose precision in JS
        vm.serializeString(o, "initialBuyWei", vm.toString(c.initialBuy));
        vm.serializeString(o, "sqrtPriceX96", vm.toString(uint256(c.params.sqrtPriceX96)));
        vm.serializeInt(o, "tickLower", c.params.tickLower);
        vm.serializeInt(o, "tickUpper", c.params.tickUpper);
        vm.serializeString(o, "buyWei", vm.toString(c.params.buyEth));
        console.log(vm.serializeString(o, "minDnaOut", vm.toString(c.params.minDnaOut)));
    }
}

/// @notice Shared env handling for the mainnet (and mainnet-fork) launch scripts.
abstract contract MainnetEnv is Script, LaunchPlanner {
    /// @dev Every input that shapes an address must be explicit: a default would silently change every address.
    ///      `routeB` adds the route-B graph inputs (launch wallet, namespace, nonce, window). Route A's graph is packed by
    ///      Programmable's CLI; post-launch only needs what shapes the CREATE2 set: Safe, agent, anchor key.
    function requiredConfig(bool routeB) internal returns (Config memory c) {
        require(block.chainid == 1, "mainnet / mainnet fork only");
        string[7] memory req =
            ["SAFE", "AGENT", "ANCHOR_KEY", "LAUNCH_WALLET", "ROUTE_NAMESPACE", "ROUTE_NONCE", "VALID_AFTER"];
        for (uint256 i; i < (routeB ? 7 : 3); ++i) {
            require(vm.envExists(req[i]), string.concat("missing env ", req[i]));
        }
        requireXHandleConfirmed(vm.envOr("X_HANDLE_CONFIRMED", string("")));
        require(
            vm.envExists("EXCLUDED_WALLETS"), "missing env EXCLUDED_WALLETS (the Safe signers' EOAs, comma-separated)"
        );
        c = mainnetConfig();
        require(c.safe.code.length != 0, "SAFE has no code: deploy the Safe first");
        require(c.agent != address(0) && c.anchorKey != address(0) && c.agent != c.anchorKey, "bad AGENT / ANCHOR_KEY");
        requireExcluded(c.excluded, ISafeOwners(c.safe).getOwners());
        requireInitialBuy(c.initialBuy);
    }

    function envelopePath() internal view returns (string memory) {
        return vm.envOr("ENVELOPE", string("../engine/deployments/1.envelope.json"));
    }
}

/// @notice Mainnet launch, run twice with the SAME env:
///   1. no PERMIT_SIGNATURE: plan, mine the hook salt, print the addresses, write the envelope JSON (ENVELOPE,
///      default engine/deployments/1.envelope.json). Send `digest` + the envelope to Programmable.
///   2. PERMIT_SIGNATURE=0x…: re-plans (deterministic), checks the signature with the Router's permit authority
///      (ERC-1271) and that now is inside [VALID_AFTER, VALID_AFTER + 1 h], then broadcasts launchAndStampV1 from
///      LAUNCH_WALLET: `forge script script/Launch.s.sol:LaunchMainnet --rpc-url $RPC --broadcast --account launch
///      --priority-gas-price 1gwei --with-gas-price <2 × base fee + tip, in wei> --timeout 600`. The fees are explicit:
///      forge's own estimate tips the cheapest 20% of recent blocks (down to 1 wei).
contract LaunchMainnet is MainnetEnv {
    function run() external {
        Config memory c = requiredConfig(true);
        Plan memory p = plan(c);
        _writeEnvelope(c, p);
        console.log("hook    ", p.a.hook);
        console.log("token   ", p.a.token);
        console.log("registry", p.a.registry);
        console.log("permit digest (Programmable signs this):");
        console.logBytes32(p.digest);

        bytes memory sig = vm.envOr("PERMIT_SIGNATURE", bytes(""));
        if (sig.length == 0) {
            console.log("no PERMIT_SIGNATURE: envelope written to", envelopePath());
            return;
        }
        address authority = ProgrammableLaunchStampRouterV1(address(c.router)).PERMIT_AUTHORITY();
        require(SignatureChecker.isValidERC1271SignatureNow(authority, p.digest, sig), "signature invalid for this env");
        require(block.timestamp >= c.validAfter && block.timestamp <= c.validAfter + 1 hours, "outside permit window");
        require(
            c.launchWallet.balance >= c.initialBuy + launchGasMargin(),
            "launch wallet needs INITIAL_BUY_WEI + LAUNCH_GAS_MARGIN_WEI"
        );

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        require(sender == c.launchWallet, "broadcaster != LAUNCH_WALLET");
        (bool ok, bytes memory ret) = address(c.router).call{value: c.initialBuy}(launchCalldata(p, sig));
        vm.stopBroadcast();
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        console.log("LAUNCH SENT. Next: PostLaunchMainnet");
    }

    function _writeEnvelope(Config memory c, Plan memory p) internal {
        string memory o = "envelope";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "startBlock", block.number); // lower bound of the launch block (indexer backfill start)
        vm.serializeAddress(o, "router", address(c.router));
        vm.serializeAddress(o, "graphFactory", address(c.factory));
        vm.serializeAddress(o, "launchWallet", c.launchWallet);
        vm.serializeAddress(o, "safe", c.safe);
        vm.serializeAddress(o, "agent", c.agent);
        vm.serializeAddress(o, "anchorKey", c.anchorKey);
        vm.serializeBytes32(o, "namespace", c.namespace);
        vm.serializeBytes32(o, "nonce", c.nonce);
        vm.serializeUint(o, "validAfter", c.validAfter);
        vm.serializeUint(o, "deadline", c.validAfter + 1 hours);
        vm.serializeUint(o, "value", c.initialBuy);
        vm.serializeBytes32(o, "hookSalt", p.hookSalt);
        vm.serializeBytes32(o, "postLaunchSalt", c.postLaunchSalt);
        vm.serializeBytes32(o, "digest", p.digest);
        vm.serializeBytes(o, "permitAbi", abi.encode(p.permit)); // LaunchPermitV1 tuple
        vm.serializeBytes(o, "stampAbi", abi.encode(p.stamp)); // StampRequestV1 tuple
        vm.serializeBytes(o, "routePayload", p.routePayload); // abi.encode(CustomGraphRouteV1)
        vm.serializeAddress(o, "token", p.a.token);
        vm.serializeAddress(o, "hook", p.a.hook);
        vm.serializeAddress(o, "platformRevenue", p.a.platformRevenue);
        vm.serializeAddress(o, "bootstrap", p.a.bootstrap);
        vm.serializeAddress(o, "registry", p.a.registry);
        vm.serializeAddress(o, "feeVault", p.a.feeVault);
        vm.serializeAddress(o, "buybackBurn", p.a.buybackBurn);
        string memory json = vm.serializeAddress(o, "liquidityVault", p.a.liquidityVault);
        vm.writeJson(json, envelopePath());
    }
}

/// @notice After the launch tx is mined (same env + the envelope), from any funded EOA (`--account deployer`): CREATE2
///         (0x4e59) registry + vaults + game contracts, the T0 module plates, IdeaMarket + BountyBoard. First checks the hook's
///         immutables point at exactly these addresses. Writes DEPLOYMENT_OUT (engine/deployments/1.json, incl. the
///         plates) and the Safe's T0 batch for the Safe Transaction Builder (SAFE_BATCH_OUT,
///         engine/deployments/1.safe-t0.json). Idempotent: every target is CREATE2 and skipped if it already has code.
contract PostLaunchMainnet is MainnetEnv {
    using PoolIdLibrary for PoolKey;

    function run() external {
        Config memory c = requiredConfig(false); // route A or B: the envelope carries the graph addresses
        string memory env = vm.readFile(envelopePath());
        Plan memory p;
        Addrs memory a = p.a;
        a.token = vm.parseJsonAddress(env, ".token");
        a.hook = vm.parseJsonAddress(env, ".hook");
        a.platformRevenue = vm.parseJsonAddress(env, ".platformRevenue");
        a.bootstrap = vm.parseJsonAddress(env, ".bootstrap");
        postLaunchInits(c, p);
        require(a.hook.code.length != 0, "hook has no code: launch not mined yet");
        DNAHook h = DNAHook(a.hook);
        require(
            h.registry() == a.registry && h.feeVault() == a.feeVault && h.buybackBurn() == a.buybackBurn
                && h.token() == a.token && h.platformRevenue() == a.platformRevenue,
            "env differs from launch: post-launch addresses would not match the hook"
        );

        vm.startBroadcast();
        for (uint256 i; i < 7; ++i) {
            _create2(c.postLaunchSalt, p.postInits[i]);
        }
        for (uint256 i; i < 4; ++i) {
            _create2(plateSalt(i), plateInit(i));
        }
        address im = _create2(c.postLaunchSalt, ideaMarketInit(a));
        address bb = _create2(c.postLaunchSalt, bountyBoardInit(a));
        vm.stopBroadcast();

        _writeDeployment(c, a, vm.parseJsonUint(env, ".startBlock"), im, bb);
        _writeSafeBatch(a);
    }

    function _create2(bytes32 salt, bytes memory init) internal returns (address want) {
        want = create2(CREATE2_FACTORY, salt, init);
        if (want.code.length != 0) return want;
        (bool ok, bytes memory ret) = CREATE2_FACTORY.call(abi.encodePacked(salt, init));
        require(ok && address(bytes20(ret)) == want, "CREATE2 address mismatch");
    }

    function _writeDeployment(Config memory c, Addrs memory a, uint256 startBlock, address im, address bb) internal {
        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "startBlock", startBlock);
        vm.serializeBytes32(o, "poolId", PoolId.unwrap(DNAHook(a.hook).poolKey().toId()));
        vm.serializeAddress(o, "safe", c.safe);
        vm.serializeAddress(o, "agent", c.agent);
        vm.serializeAddress(o, "anchorKey", c.anchorKey);
        vm.serializeAddress(o, "poolManager", address(c.poolManager));
        vm.serializeAddress(o, "positionManager", address(c.positionManager));
        vm.serializeAddress(o, "token", a.token);
        vm.serializeAddress(o, "hook", a.hook);
        vm.serializeAddress(o, "platformRevenue", a.platformRevenue);
        vm.serializeAddress(o, "bootstrap", a.bootstrap);
        vm.serializeAddress(o, "registry", a.registry);
        vm.serializeAddress(o, "feeVault", a.feeVault);
        vm.serializeAddress(o, "buybackBurn", a.buybackBurn);
        vm.serializeAddress(o, "liquidityVault", a.liquidityVault);
        vm.serializeAddress(o, "gamePot", a.gamePot);
        vm.serializeAddress(o, "convictionVault", a.convictionVault);
        vm.serializeAddress(o, "mutationBoard", a.mutationBoard);
        vm.serializeAddress(o, "vrfCoordinator", address(c.vrfCoordinator));
        vm.serializeAddress(o, "ideaMarket", im);
        address[] memory plates = new address[](4);
        for (uint256 i; i < 4; ++i) {
            plates[i] = plateAddress(i);
        }
        vm.serializeAddress(o, "plates", plates); // AdaptiveFee A, B, C, BaselineSplit
        string memory json = vm.serializeAddress(o, "bountyBoard", bb);
        string memory out = vm.envOr("DEPLOYMENT_OUT", string("../engine/deployments/1.json"));
        vm.writeJson(json, out);
        console.log("wrote", out);
    }

    /// @dev Safe Transaction Builder import format (raw `data`, no ABI needed). Signers check every call decoded in the
    ///      Safe UI (or `cast calldata-decode`) against the expected T0 batch before signing.
    function _writeSafeBatch(Addrs memory a) internal {
        (address[] memory to, bytes[] memory data) = t0Batch(a);
        string memory txs;
        for (uint256 i; i < to.length; ++i) {
            txs = string.concat(
                txs,
                i == 0 ? "" : ",",
                '{"to":"',
                vm.toString(to[i]),
                '","value":"0","data":"',
                vm.toString(data[i]),
                '","contractMethod":null,"contractInputsValues":null}'
            );
        }
        string memory json = string.concat(
            '{"version":"1.0","chainId":"1","createdAt":0,"meta":{"name":"DNA T0: initialize x4 + vault.initialize(gamePot) + register 3 plates + split"},"transactions":[',
            txs,
            "]}"
        );
        string memory out = vm.envOr("SAFE_BATCH_OUT", string("../engine/deployments/1.safe-t0.json"));
        vm.writeFile(out, json);
        console.log("wrote", out);
    }
}
