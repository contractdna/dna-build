// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {DNAToken} from "../../src/DNAToken.sol";
import {ConvictionVault} from "../../src/ConvictionVault.sol";
import {GamePot} from "../../src/GamePot.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {IModuleRegistry} from "../../src/interfaces/IDNA.sol";
import {IVRFCoordinatorV2Plus} from "../../src/interfaces/IVRFCoordinatorV2Plus.sol";
import {TestHook, MockRegistry} from "../Vaults.t.sol";
import {RolesRegistry} from "../ConvictionVault.t.sol";
import {Tree} from "../GamePot.t.sol";

/// Views of the live VRFCoordinatorV2_5 (SubscriptionAPI.s_config, VRFCoordinatorV2_5.s_provingKeys).
interface ICoordinatorViews {
    function s_config()
        external
        view
        returns (
            uint16 minimumRequestConfirmations,
            uint32 maxGasLimit,
            bool reentrancyLock,
            uint32 stalenessSeconds,
            uint32 gasAfterPaymentCalculation,
            uint32 fulfillmentFlatFeeNativePPM,
            uint32 fulfillmentFlatFeeLinkDiscountPPM,
            uint8 nativePremiumPercentage,
            uint8 linkPremiumPercentage
        );
    function s_provingKeys(bytes32 keyHash) external view returns (bool exists, uint64 maxGas);
    function pendingRequestExists(uint256 subId) external view returns (bool);
}

/// GamePot against the REAL mainnet VRF v2.5 coordinator on a fork: the pinned lane and billing config, subscription
/// creation and consumer registration by `initialize`, the SUB_MIN native top-up and a real `requestRandomWords`
/// (consumer, confirmations, gas cap and native extraArgs all checked by Chainlink's code) for a posted holder list.
/// The fulfilment itself needs the oracle's VRF proof, which a fork can't produce: it is delivered as the coordinator
/// (msg.sender) would, then a keeper settles the winner's leaf and the prize is pushed. Skipped without MAINNET_RPC_URL.
contract GamePotVRFForkTest is Deployers {
    address constant COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;
    bytes32 constant KEY_HASH = 0x8077df514608a09f83e4e8d300645594e5d7234665448ba83f51a50f842bd3d9; // 200 gwei lane
    ICoordinatorViews constant VIEWS = ICoordinatorViews(COORDINATOR);

    DNAToken token;
    ConvictionVault vault;
    GamePot pot;
    TestHook hook;
    address agent = makeAddr("agent");
    // "alice" has code on mainnet (it forwards ETH): fresh labels for the holders
    address[3] holders = [makeAddr("dna.fork.h0"), makeAddr("dna.fork.h1"), makeAddr("dna.fork.h2")];

    function test_fork_liveCoordinator_postRequestFulfilSettle() public {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        vm.skip(bytes(rpc).length == 0);
        vm.createSelectFork(rpc);
        uint256 worst = _checkConfig();
        _deploy();
        (,,, address subOwner, address[] memory consumers) =
            IVRFCoordinatorV2Plus(COORDINATOR).getSubscription(pot.subId());
        assertEq(subOwner, address(pot));
        assertEq(consumers[0], address(pot));

        hook.fund{value: 2 ether}(address(pot));
        console.log("fork basefee (wei)", block.basefee, "vrfCostEstimate", pot.vrfCostEstimate());

        // window 1 closes; the agent posts a 3-holder list (tickets 5 / 3 / 7)
        GamePot.Leaf[] memory leaves = new GamePot.Leaf[](3);
        bytes32[] memory h = new bytes32[](3);
        uint256[3] memory tix = [uint256(5), 3, 7];
        uint256 cum;
        for (uint256 i; i < 3; ++i) {
            leaves[i] = GamePot.Leaf(i, holders[i], cum, tix[i]);
            cum += tix[i];
            h[i] = Tree.leaf(leaves[i]);
        }
        (bytes32 root, bytes32[] memory lastProof) = Tree.build(h, 2);
        vm.warp(pot.windowEnd());
        vm.prank(agent);
        pot.postList(1, GamePot.Params(100, 1_000 ether), root, cum, 3, leaves[2], lastProof, "", bytes32(0));
        vm.warp(block.timestamp + pot.LIST_DELAY());

        uint256 reqId = pot.requestDraw(); // real requestRandomWords
        (, uint96 nativeBal,,,) = IVRFCoordinatorV2Plus(COORDINATOR).getSubscription(pot.subId());
        assertEq(nativeBal, pot.SUB_MIN(), "topped up to SUB_MIN");
        assertTrue(VIEWS.pendingRequestExists(pot.subId()));
        console.log("SUB_MIN", pot.SUB_MIN(), "worst-case charge at the lane max", worst);
        assertGe(pot.SUB_MIN(), worst, "the float pays a fulfilment even at the lane max");

        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256("fork word"));
        vm.prank(COORDINATOR);
        pot.rawFulfillRandomWords(reqId, words);
        (,,,,,,,, uint256 rand) = pot.draw();
        assertEq(rand, words[0]);
        // the keeper's walk: ticketAt(rand, j) → its leaf, every account paid once (3 holders → 3 winners, 32 tickets)
        GamePot.Leaf[] memory sl = new GamePot.Leaf[](32);
        bytes32[][] memory sp = new bytes32[][](32);
        for (uint256 j; j < 32; ++j) {
            uint256 t = pot.ticketAt(rand, j, cum);
            uint256 w = t < 5 ? 0 : (t < 8 ? 1 : 2);
            sl[j] = leaves[w];
            (, sp[j]) = Tree.build(h, w);
        }
        uint256[3] memory b0 = [holders[0].balance, holders[1].balance, holders[2].balance];
        vm.prank(makeAddr("keeper"));
        pot.settle(sl, sp);
        uint256 share = (1.4 ether - pot.SUB_MIN()) / 10;
        for (uint256 i; i < 3; ++i) {
            assertEq(holders[i].balance - b0[i], share, "each holder pushed one share");
        }
        assertEq(pot.drawCount(), 0, "all pushed");
    }

    /// The pinned lane and billing: returns the coordinator's worst-case native charge for our callback at the lane max.
    function _checkConfig() internal view returns (uint256 worst) {
        (bool exists, uint64 maxGas) = VIEWS.s_provingKeys(KEY_HASH);
        assertTrue(exists, "keyHash registered");
        assertEq(maxGas, 200 gwei, "lane max = LANE_MAX_GAS_PRICE");
        (uint16 minConf, uint32 maxGasLimit,,, uint32 gasAfter, uint32 flatPPM,, uint8 nativePct,) = VIEWS.s_config();
        console.log("minConf", minConf, "maxGasLimit", maxGasLimit);
        console.log("gasAfterPayment", gasAfter, "flatFeeNativePPM", flatPPM);
        console.log("nativePremiumPercentage", nativePct);
        assertLe(minConf, 3, "CONFIRMATIONS accepted");
        assertGe(maxGasLimit, 300_000, "CALLBACK_GAS accepted");
        assertEq(uint256(nativePct) + 100, 124, "PREMIUM_PCT");
        worst = uint256(maxGas) * (200_000 + 300_000 + gasAfter) * (100 + nativePct) / 100 + 1e12 * uint256(flatPPM);
        assertLe(gasAfter, 50_000, "BILLING_GAS covers gasAfterPaymentCalculation");
    }

    function _deploy() internal {
        vm.deal(address(this), 100 ether);
        deployFreshManager();
        token = new DNAToken(address(this));
        address safe = makeAddr("safe");
        RolesRegistry reg = new RolesRegistry(safe, agent, makeAddr("anchor"));
        address[] memory none;
        vault = new ConvictionVault(IModuleRegistry(address(reg)), safe, none);
        pot = new GamePot(
            manager, safe, vault, IModuleRegistry(address(reg)), IVRFCoordinatorV2Plus(COORDINATOR), KEY_HASH
        );
        FeeVault fv =
            new FeeVault(manager, address(new MockRegistry()), makeAddr("bb"), makeAddr("lv"), address(pot), safe);
        hook = new TestHook(manager, address(token), address(fv), makeAddr("platform"), makeAddr("bb"));
        vm.startPrank(safe);
        pot.initialize(address(hook)); // real createSubscription + addConsumer, window 1 opens
        vault.initialize(address(pot));
        vm.stopPrank();
    }
}
