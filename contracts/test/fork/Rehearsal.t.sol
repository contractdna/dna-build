// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {DNAToken} from "../../src/DNAToken.sol";
import {DNAHook} from "../../src/DNAHook.sol";
import {ModuleRegistry} from "../../src/ModuleRegistry.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {BuybackBurn} from "../../src/BuybackBurn.sol";
import {LiquidityVault} from "../../src/LiquidityVault.sol";
import {PlatformRevenue} from "../../src/PlatformRevenue.sol";
import {IdeaMarket} from "../../src/IdeaMarket.sol";
import {BountyBoard} from "../../src/BountyBoard.sol";
import {AdaptiveFee} from "../../src/modules/AdaptiveFee.sol";
import {ConvictionVault} from "../../src/ConvictionVault.sol";
import {GamePot} from "../../src/GamePot.sol";
import {MutationBoard} from "../../src/MutationBoard.sol";
import {Route} from "../../src/interfaces/IDNA.sol";
import {FeeContext} from "../../src/interfaces/IPolicies.sol";
import {RevertingFee} from "../../script/DevActions.s.sol";
import {ProgrammableLaunchStampRouterV1} from "../../script/programmable/ProgrammableLaunchStampRouterV1.sol";
import {URSwaps} from "./UniversalRouter.t.sol";

/// @dev Safe v1.4.1 surface used here.
interface ISafe {
    function getOwners() external view returns (address[] memory);

    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);
    function nonce() external view returns (uint256);
    function approveHash(bytes32 hash) external;
    function VERSION() external view returns (string memory);
    function getThreshold() external view returns (uint256);
    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory array, address next);
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address);
}

interface IOwned {
    function owner() external view returns (address);
}

interface ICoordinatorOwner {
    function ownerCancelSubscription(uint256 subId) external;
}

interface ISafeMessageHash {
    function getMessageHashForSafe(address safe, bytes memory message) external view returns (bytes32);
}

/// Whole-launch dress rehearsal on a mainnet fork, with a REAL 2-of-3 Safe v1.4.1 as
/// the DNA Safe and the REAL Programmable Router + graph deployer. Programmable's EIP-1271 permit is not mocked: its
/// authority Safe's signer pre-approves the Safe message hash (approved-hash signature, v = 1), so the Router runs the
/// real `isValidSignature` path. Timeline (each step Hn = +1 h MIN_DELAY / +300 blocks, so H8 is T0 + 8 h):
///   T0  Safe deploy · launchAndStampV1 · CREATE2 registry/vaults/plates/IdeaMarket/BountyBoard · Safe T0 batch
///   H1  keeper executes the registers · Safe queues SetLevel(7) (allowance drill) · agent (L5) queues SetShadow(A)
///   H2  A shadow · price discovery (10 × 1 ETH) then realistic flow (±0.05 ETH): A stays below its cap
///       · agent queues SetCanary(A)
///   H3  A canary: UR swaps inside (A prices the trade) and outside (2%) the window · Safe queues PromoteActive(A)
///       · agent queues SetShadow(B) · cancel drill (agent queues SetShadow(C), Safe cancels)
///   H4  A active (fees = A) · B shadow · agent queues SetParams(B) + SetCanary(B)
///   H5  B params + canary (clamped to A ± 1 pt) · endCanary drill on B · agent queues SetShadow(bad module)
///   H6  bad shadow · agent queues SetCanary(bad)
///   H7  breaker drill: 3 failing canary swaps, anyone rolls back (active A rolls back too) · allowance claw-back
///       (fund → agent funds a bounty → Safe batch pauseAgent + cancel refunds the allowance → withdrawAllowance(all))
///       · pause drill
///   H8  stale paused op reverts, Safe cancels it, UnpauseAgent executes · keepers · anchor · level drill
/// Prints a gas table of every Safe / agent / anchor / keeper / deployer transaction (to size wallet funding).
/// Skipped without MAINNET_RPC_URL: MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com forge test --mc Rehearsal -vv
/// `test_rehearsal_realSafe` runs the same timeline against the live Safe (env REHEARSAL_SAFE, never a
/// default): its owners are impersonated (approved-hash signatures, v = 1), batches go through the MultiSendCallOnly of
/// the Safe's own version, and its ERC-1271 answer (CompatibilityFallbackHandler) is checked; skipped without it.
contract RehearsalForkTest is URSwaps {
    // Safe v1.4.1 canonical mainnet deployments (safe-global/safe-deployments)
    address constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    ISafeProxyFactory constant SAFE_FACTORY = ISafeProxyFactory(0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67);
    address constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99; // CompatibilityFallbackHandler
    address constant MULTISEND_CALL_ONLY_141 = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2;
    // Safe v1.5.0 canonical mainnet deployments (safe-global/safe-deployments src/assets/v1.5.0)
    address constant SAFE_SINGLETON_150 = 0xFf51A5898e281Db6DfC7855790607438dF2ca44b;
    address constant SAFE_FALLBACK_HANDLER_150 = 0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4;
    address constant MULTISEND_CALL_ONLY_150 = 0xA83c336B20401Af773B6219BA5027174338D1836;
    address MULTISEND_CALL_ONLY = MULTISEND_CALL_ONLY_141;
    bool realSafe; // owners impersonated: approved-hash signatures instead of keys
    // owner of Programmable's permit-authority Safe (1-of-2) that signed CLAUS / SHARD
    address constant PROGRAMMABLE_SIGNER = 0x032b1c7b96793717F0BD2f11eb86cd10CdefC4a3;

    uint32 constant PERIOD = 600; // canary schedule: live 100 of every 600 blocks
    uint32 constant LEN = 100;
    uint24 constant CAP = 35_000; // plate cap (3.5%)

    ISafe safe;
    address[3] owners; // signers S1, S2, S3
    uint256[3] ownerKeys;
    address agent = makeAddr("agent");
    address anchorKey = makeAddr("anchor");
    address keeper = makeAddr("keeper");
    // the real controller wallet when given (contracts/launch.env.example LAUNCH_WALLET): every CREATE2 address depends on it
    address launchWallet = vm.envOr("LAUNCH_WALLET", makeAddr("launchWallet"));
    ModuleRegistry reg;
    address[4] plate; // AdaptiveFee A, B, C + BaselineSplit
    address bad;
    IdeaMarket ideaMarket;
    BountyBoard bountyBoard;
    uint256[8] pending; // queue ids carried to the next step

    string[] gasLabel;
    uint256[] gasUsed;

    function test_rehearsal() public {
        _fork();
        _deploySafe();
        _timeline();
    }

    /// The same timeline with the live Safe on the fork (REHEARSAL_SAFE=<address>; v1.5.0 expected).
    function test_rehearsal_realSafe() public {
        address s = vm.envOr("REHEARSAL_SAFE", address(0));
        vm.skip(s == address(0));
        _fork();
        _useRealSafe(s);
        _timeline();
    }

    function _timeline() internal {
        _launch();
        _postLaunch();
        _h1_registered();
        _h2_shadow_market();
        _h3_canary();
        _h4_active();
        _h5_paramsCanaryB();
        _h6_badShadow();
        _h7_breaker_clawback_pause();
        _h8_unpause_keepers();
        _h9_games();
        _printGas();
    }

    // ================================================================== T0

    /// The live Safe: 2 of its owners sign by approved hash (v = 1); its version picks MultiSendCallOnly; its fallback
    /// handler must be the canonical CompatibilityFallbackHandler and must answer ERC-1271 for a message 2 owners
    /// approved (and refuse one they didn't).
    function _useRealSafe(address s) internal {
        safe = ISafe(s);
        require(s.code.length != 0, "REHEARSAL_SAFE has no code on this fork");
        string memory v = safe.VERSION();
        address[] memory o = safe.getOwners();
        assertEq(o.length, 3, "3 owners");
        assertEq(safe.getThreshold(), 2, "2-of-3");
        (owners[0], owners[1], owners[2]) = (o[0], o[1], o[2]);
        realSafe = true;
        // the launch params' exclusion list (contracts/launch.env.example), if given, must hold every live owner
        if (vm.envExists("EXCLUDED_WALLETS")) requireExcluded(vm.envAddress("EXCLUDED_WALLETS", ","), o);
        bytes32 h = keccak256(bytes(v));
        if (h == keccak256("1.5.0")) {
            MULTISEND_CALL_ONLY = MULTISEND_CALL_ONLY_150;
            assertEq(address(uint160(uint256(vm.load(s, 0)))), SAFE_SINGLETON_150, "the canonical Safe 1.5.0 singleton");
            bytes32 fbSlot = 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;
            assertEq(
                address(uint160(uint256(vm.load(s, fbSlot)))),
                SAFE_FALLBACK_HANDLER_150,
                "the canonical 1.5.0 fallback handler"
            );
            assertEq(
                uint256(vm.load(s, 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8)),
                0,
                "no transaction guard"
            );
            (address[] memory modules,) = safe.getModulesPaginated(address(1), 10);
            assertEq(modules.length, 0, "no modules (a module could move funds without the owners)");
        } else {
            assertEq(h, keccak256("1.4.1"), "Safe 1.4.1 or 1.5.0");
        }
        assertGt(MULTISEND_CALL_ONLY.code.length, 0, "MultiSendCallOnly deployed");
        // ERC-1271 on the live Safe: a message hash both signers approved is valid, an unapproved one is not
        bytes32 message = keccak256("DNA launch rehearsal: ERC-1271 check");
        address handler =
            address(uint160(uint256(vm.load(s, 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5))));
        bytes32 safeMsg = ISafeMessageHash(handler).getMessageHashForSafe(s, abi.encode(message));
        vm.prank(owners[0]);
        safe.approveHash(safeMsg);
        vm.prank(owners[1]);
        safe.approveHash(safeMsg);
        bytes memory sig = _approvedSigs(owners[0], owners[1]);
        assertEq(safe.isValidSignature(message, sig), bytes4(0x1626ba7e), "ERC-1271 magic for an approved message");
        vm.expectRevert();
        safe.isValidSignature(keccak256("not approved"), sig);
        for (uint256 i; i < 3; ++i) {
            vm.deal(owners[i], 10 ether);
        }
    }

    /// v = 1 signatures for two owners, sorted by address (Safe checkNSignatures order).
    function _approvedSigs(address x, address y) internal pure returns (bytes memory) {
        (address lo, address hi) = x < y ? (x, y) : (y, x);
        return abi.encodePacked(
            bytes32(uint256(uint160(lo))), bytes32(0), uint8(1), bytes32(uint256(uint160(hi))), bytes32(0), uint8(1)
        );
    }

    function _deploySafe() internal {
        for (uint256 i; i < 3; ++i) {
            (owners[i], ownerKeys[i]) = makeAddrAndKey(string.concat("signer", vm.toString(i)));
        }
        address[] memory o = new address[](3);
        (o[0], o[1], o[2]) = (owners[0], owners[1], owners[2]);
        bytes memory init = abi.encodeCall(
            ISafe.setup, (o, 2, address(0), "", SAFE_FALLBACK_HANDLER, address(0), 0, payable(address(0)))
        );
        vm.prank(owners[0]);
        safe = ISafe(SAFE_FACTORY.createProxyWithNonce(SAFE_SINGLETON, init, 0));
        _rec("deployer: Safe 2-of-3 deploy (SafeProxyFactory 1.4.1)");
        vm.deal(owners[0], 10 ether);
    }

    function _launch() internal {
        c = mainnetConfig();
        (c.safe, c.launchWallet, c.agent, c.anchorKey) = (address(safe), launchWallet, agent, anchorKey);
        c.excluded = new address[](3); // the signers' own EOAs (mainnet: EXCLUDED_WALLETS, checked against getOwners)
        (c.excluded[0], c.excluded[1], c.excluded[2]) = (owners[0], owners[1], owners[2]);
        requireExcluded(c.excluded, safe.getOwners());
        Plan memory p = plan(c);
        a = p.a;

        // Programmable's side: its authority Safe approves the Safe message hash of our digest (what their signer's
        // signature proves on mainnet). The Router then calls the real isValidSignature.
        address authority = ProgrammableLaunchStampRouterV1(address(c.router)).PERMIT_AUTHORITY();
        bytes32 msgHash = ISafeMessageHash(SAFE_FALLBACK_HANDLER).getMessageHashForSafe(authority, abi.encode(p.digest));
        vm.prank(PROGRAMMABLE_SIGNER);
        ISafe(authority).approveHash(msgHash);
        bytes memory sig = abi.encodePacked(bytes32(uint256(uint160(PROGRAMMABLE_SIGNER))), bytes32(0), uint8(1));

        uint256 lpId = c.positionManager.nextTokenId();
        vm.deal(launchWallet, 5 ether);
        vm.recordLogs();
        vm.prank(launchWallet);
        (bool ok,) = address(c.router).call{value: c.initialBuy}(launchCalldata(p, sig));
        assertTrue(ok, "launchAndStampV1");
        uint256 g = _rec("launch wallet: launchAndStampV1 (real 1271 path)");
        assertLe(g, TX_GAS_CAP, "launch gas gate");

        // pool initialized at the opening tick, then the launch buy moved it down
        assertEq(_initTick(vm.getRecordedLogs()), 201_107, "opening tick");
        _wire();
        (int24 tick,,,) = DNAHook(a.hook).observables();
        assertLt(tick, 201_107, "launch buy moved the price");
        uint256 burned = 1_000_000_000 ether - DNAToken(a.token).totalSupply();
        console.log("launch value (wei)", c.initialBuy);
        console.log("launch buy (wei)", c.params.buyEth);
        console.log("tick after the launch buy (opening 201107)", vm.toString(tick));
        console.log("excess DNA burned (wei)", burned);

        assertEq(c.router.launchIdByToken(a.token), p.stamp.launchId, "stamped");
        assertEq(IERC721(address(c.positionManager)).ownerOf(lpId), address(0xdEaD), "LP NFT burnt (0xdEaD)");
        assertEq(IERC721(address(c.positionManager)).ownerOf(lpId + 1), address(0xdEaD), "full range LP: 0xdEaD");
        assertGt(burned, 0, "the excess DNA burned");
        assertLt(burned, 100_000 ether, "only the excess (< 0.01% of supply)");
        assertEq(DNAToken(a.token).balanceOf(address(pm)), DNAToken(a.token).totalSupply(), "the pool holds all DNA");
        assertEq(DNAToken(a.token).balanceOf(a.bootstrap), 0);
        assertEq(a.bootstrap.balance, 0);
        assertEq(
            pm.balanceOf(a.platformRevenue, 0),
            c.params.buyEth * DNAHook(a.hook).PLATFORM_FEE() / 1e6 + 1,
            "PlatformRevenue accrues (nominal + the rounding remainder)"
        );
        assertEq(
            pm.balanceOf(a.feeVault, 0),
            c.params.buyEth * DNAHook(a.hook).LAUNCH_PROJECT_FEE() / 1e6,
            "FeeVault accrues before it exists (3% launch fee)"
        );
        assertEq(a.feeVault.code.length, 0);
    }

    function _postLaunch() internal {
        Plan memory p;
        p.a = a;
        postLaunchInits(c, p); // same addresses the hook was built with
        bytes[9] memory inits = [
            p.postInits[0],
            p.postInits[1],
            p.postInits[2],
            p.postInits[3],
            p.postInits[4],
            p.postInits[5],
            p.postInits[6],
            ideaMarketInit(a),
            bountyBoardInit(a)
        ];
        string[9] memory names = [
            "registry",
            "BuybackBurn",
            "LiquidityVault",
            "ConvictionVault",
            "GamePot",
            "FeeVault",
            "MutationBoard",
            "IdeaMarket",
            "BountyBoard"
        ];
        for (uint256 i; i < 9; ++i) {
            vm.prank(launchWallet);
            (bool ok, bytes memory ret) = CREATE2_FACTORY.call(abi.encodePacked(c.postLaunchSalt, inits[i]));
            assertTrue(ok && address(bytes20(ret)) == create2(CREATE2_FACTORY, c.postLaunchSalt, inits[i]));
            _rec(string.concat("deployer: CREATE2 ", names[i]));
        }
        ideaMarket = IdeaMarket(create2(CREATE2_FACTORY, c.postLaunchSalt, inits[7]));
        bountyBoard = BountyBoard(create2(CREATE2_FACTORY, c.postLaunchSalt, inits[8]));
        for (uint256 i; i < 4; ++i) {
            vm.prank(launchWallet);
            plate[i] = plateAddress(i);
            // the plates are hook-independent (same salt and init code for every launch): on a fork after an earlier
            // launch they are already deployed at the same CREATE2 address, and the factory's CREATE collides
            bool existed = plate[i].code.length != 0;
            (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(plateSalt(i), plateInit(i)));
            assertTrue((ok || existed) && plate[i].code.length != 0, "plate");
            _rec(i < 3 ? "deployer: CREATE2 AdaptiveFee plate" : "deployer: CREATE2 BaselineSplit");
        }
        (bool okBad,) = CREATE2_FACTORY.call(abi.encodePacked(bytes32(0), type(RevertingFee).creationCode));
        assertTrue(okBad);
        bad = create2(CREATE2_FACTORY, bytes32(0), type(RevertingFee).creationCode); // drill-only module

        reg = ModuleRegistry(a.registry);
        assertEq(ideaMarket.safe(), address(safe));
        assertEq(address(ideaMarket.token()), a.token);
        assertEq(bountyBoard.safe(), address(safe));

        // Safe T0 batch (the exact batch PostLaunchMainnet writes for the Transaction Builder)
        (address[] memory to, bytes[] memory data) = t0Batch(a);
        _safeBatch(to, data, "Safe: T0 batch (initialize x4 + vault.initialize + Register x4)");
        assertEq(reg.hook(), a.hook);
        assertEq(GamePot(payable(a.gamePot)).hook(), a.hook);
        assertTrue(GamePot(payable(a.gamePot)).subId() != 0, "real VRF subscription created");
        assertEq(GamePot(payable(a.gamePot)).windowId(), 1, "window 1 opened");
        assertEq(address(ConvictionVault(a.convictionVault).token()), a.token);
        assertEq(BuybackBurn(a.buybackBurn).hook(), a.hook);
        assertEq(LiquidityVault(a.liquidityVault).hook(), a.hook);
        assertEq(reg.nextId(), 4);
        assertEq(reg.level(), 5);
        assertEq(reg.agent(), agent);

        // drill-only: the Safe also registers a module that always reverts (never on mainnet)
        (bytes32[4] memory lo, bytes32[4] memory hi) = feeBounds();
        _safeQueue(
            ModuleRegistry.Op.Register,
            abi.encode(bad, ModuleRegistry.Kind.Fee, bytes32(0), lo, lo, hi),
            "Safe: queue Register (one module)"
        );
    }

    // ================================================================== steps (+1 h each)

    function _h1_registered() internal {
        _step();
        for (uint256 id = 1; id <= 5; ++id) {
            _exec(
                id,
                id == 1 ? "keeper: execute Register (Fee plate)" : (id == 4 ? "keeper: execute Register (Split)" : "")
            );
        }
        (bytes32[4] memory lo, bytes32[4] memory hi) = feeBounds();
        for (uint256 i; i < 4; ++i) {
            ModuleRegistry.Module memory m = reg.getModule(plate[i]);
            assertEq(uint8(m.status), uint8(ModuleRegistry.Status.Proposed), "plate Proposed");
            assertEq(m.codehash, plate[i].codehash);
            if (i < 3) {
                assertEq(uint256(m.minParams[0]), 10_000, "fee floor 1%");
                assertEq(uint256(m.minParams[1]), 1_000, "multiplier floor 0.1x");
                assertEq(uint256(m.maxParams[2]), CAP, "fee ceiling 3.5%");
                assertEq(keccak256(abi.encode(m.minParams, m.maxParams)), keccak256(abi.encode(lo, hi)));
                assertEq(keccak256(abi.encode(m.params)), keccak256(abi.encode(plateParams(i))));
            }
        }
        assertEq(uint8(reg.getModule(plate[3]).kind), uint8(ModuleRegistry.Kind.Split));

        // drill-only: L7 so the agent can spend a BountyBoard allowance (H7 claw-back); no rollback yet, so it may rise
        pending[0] = _safeQueue(ModuleRegistry.Op.SetLevel, abi.encode(uint8(7)), "Safe: queue SetLevel");
        pending[1] = _agentQueue(ModuleRegistry.Op.SetShadow, abi.encode(plate[0]), "agent: queue SetShadow");
    }

    function _h2_shadow_market() internal {
        _step();
        _exec(pending[0], "");
        assertEq(reg.level(), 7);
        _exec(pending[1], "keeper: execute SetShadow (route push)");
        _status(plate[0], ModuleRegistry.Status.Shadow);
        Route memory r = DNAHook(a.hook).route();
        assertEq(r.shadow, plate[0]);
        assertEq(r.active, address(0));
        assertEq(r.canary, address(0));

        // price discovery: 10 × 1 ETH buys (fees stay baseline: a shadow never prices a trade)
        for (uint256 i; i < 10; ++i) {
            _swapChecked(true, 1 ether);
        }
        _alignShadowTurn();
        Swap memory s = _swapChecked(true, 0.05 ether);
        assertTrue(s.shadowed, "shadow plate quoted");
        assertEq(s.pips, DNAHook(a.hook).BASELINE_PROJECT_FEE());

        // realistic post-launch flow: 16 alternating ±0.05 ETH swaps. Plate A (0.3×) must stay below its cap here,
        // or the loop gets no signal (plates at 1.0×+ saturate at this volatility; see SPEC §3.1).
        _market(16, 0.05 ether);
        (, uint32 volEma,,) = DNAHook(a.hook).observables();
        uint24[3] memory q = [_plateQuote(0, volEma), _plateQuote(1, volEma), _plateQuote(2, volEma)];
        console.log("H2 volEma after +-0.05 ETH flow:", volEma);
        console.log("   plate quotes A/B/C (pips):", q[0], q[1], q[2]);
        assertLt(q[0], CAP, "plate A below its cap at realistic volatility");
        assertLt(q[0], 30_000, "plate A inside the canary clamp (baseline + 1 pt)");

        pending[2] = _agentQueue(
            ModuleRegistry.Op.SetCanary,
            abi.encode(plate[0], uint64(block.number), PERIOD, LEN),
            "agent: queue SetCanary"
        );
    }

    function _h3_canary() internal {
        _step();
        _exec(pending[2], "keeper: execute SetCanary (route push)");
        _status(plate[0], ModuleRegistry.Status.Canary);
        Route memory r = DNAHook(a.hook).route();
        assertEq(r.canary, plate[0]);
        assertEq(r.shadow, address(0));
        assertEq(r.canaryLen, LEN);

        // inside the window plate A prices the trade (unclamped at this volatility); outside it, baseline 2%
        _rollCanary(true);
        _market(2, 0.05 ether); // keep the realistic flow going so volEma stays where H2 measured it
        (, uint32 volEma,,) = DNAHook(a.hook).observables();
        uint24 aQuote = _plateQuote(0, volEma);
        Swap memory b = _swapChecked(true, 0.05 ether);
        assertEq(b.pips, aQuote, "canary = plate A's own quote");
        assertTrue(b.pips != DNAHook(a.hook).BASELINE_PROJECT_FEE(), "canary differs from baseline");
        console.log("H3 in-window canary pips (A):", b.pips, "volEma", volEma);
        _rollCanary(false);
        assertEq(
            _swapChecked(true, 0.05 ether).pips, DNAHook(a.hook).BASELINE_PROJECT_FEE(), "outside the window: baseline"
        );

        // A is good: the Safe promotes it (L5 agent cannot; promotion is L8 or the Safe)
        pending[3] = _safeQueue(ModuleRegistry.Op.PromoteActive, abi.encode(plate[0]), "Safe: queue PromoteActive");
        pending[4] = _agentQueue(ModuleRegistry.Op.SetShadow, abi.encode(plate[1]), "");

        // Safe cancel drill: the agent queues, the Safe cancels before the eta
        uint256 id = _agentQueue(ModuleRegistry.Op.SetShadow, abi.encode(plate[2]), "");
        assertEq(reg.pendingOf(agent), 2);
        _safeCall(a.registry, abi.encodeCall(ModuleRegistry.cancel, (_ids(id))), "Safe: cancel (1 op)");
        assertEq(reg.pendingOf(agent), 1);
        vm.expectRevert(ModuleRegistry.UnknownOp.selector);
        reg.execute(id);
    }

    function _h4_active() internal {
        _step();
        _exec(pending[3], "keeper: execute PromoteActive (route push)");
        _status(plate[0], ModuleRegistry.Status.Active);
        Route memory r = DNAHook(a.hook).route();
        assertEq(r.active, plate[0]);
        assertEq(r.canary, address(0), "promotion clears the canary slot");
        _exec(pending[4], "");
        _status(plate[1], ModuleRegistry.Status.Shadow);

        // every trade now priced by A
        (, uint32 volEma,,) = DNAHook(a.hook).observables();
        assertEq(_swapChecked(true, 0.05 ether).pips, _plateQuote(0, volEma), "active A prices every trade");

        // agent tunes B (non-active plate: L5) then canaries it
        bytes32[4] memory pb = [bytes32(uint256(20_000)), bytes32(uint256(5_000)), bytes32(uint256(CAP)), bytes32(0)];
        pending[5] = _agentQueue(ModuleRegistry.Op.SetParams, abi.encode(plate[1], pb), "agent: queue SetParams");
        pending[6] =
            _agentQueue(ModuleRegistry.Op.SetCanary, abi.encode(plate[1], uint64(block.number), PERIOD, LEN), "");
    }

    function _h5_paramsCanaryB() internal {
        _step();
        _exec(pending[5], "keeper: execute SetParams (route push)");
        assertEq(uint256(reg.getModule(plate[1]).params[1]), 5_000, "B multiplier 0.5x");
        _exec(pending[6], "");
        _status(plate[1], ModuleRegistry.Status.Canary);

        _rollCanary(true);
        Swap memory s = _swapChecked(true, 0.05 ether); // B's quote clamped to A's ± 1 pt (checked inside)
        console.log("H5 in-window canary pips (B vs active A):", s.pips);

        // endCanary drill on B (A's promotion stays clean): B back to Proposed, not a rollback
        vm.prank(agent);
        reg.endCanary();
        _rec("agent: endCanary");
        _status(plate[1], ModuleRegistry.Status.Proposed);
        assertEq(DNAHook(a.hook).route().canary, address(0));
        assertEq(DNAHook(a.hook).route().active, plate[0]);
        assertEq(reg.lastRollbackBlock(), 0, "endCanary is not a rollback");

        pending[7] = _agentQueue(ModuleRegistry.Op.SetShadow, abi.encode(bad), "");
    }

    function _h6_badShadow() internal {
        _step();
        _exec(pending[7], "");
        _status(bad, ModuleRegistry.Status.Shadow);
        pending[0] = _agentQueue(ModuleRegistry.Op.SetCanary, abi.encode(bad, uint64(block.number), PERIOD, LEN), "");
    }

    function _h7_breaker_clawback_pause() internal {
        _step();
        _exec(pending[0], "");
        _status(bad, ModuleRegistry.Status.Canary);

        // breaker drill: every in-window swap fails the canary (A still answers) → swap succeeds, canary counted failed
        _rollCanary(true);
        for (uint256 i; i < 3; ++i) {
            assertEq(_swapChecked(true, 0.05 ether).moduleFailures, 1, "canary failed");
        }
        (uint32 fails,) = DNAHook(a.hook).breaker();
        assertEq(fails, 3, "breaker tripped");
        vm.prank(agent);
        vm.expectRevert(ModuleRegistry.BreakerTripped.selector);
        reg.endCanary(); // only rollback may change the route now
        vm.prank(makeAddr("anyone"));
        reg.rollback(ModuleRegistry.Kind.Fee);
        _rec("anyone/keeper: rollback(Fee) on tripped breaker");
        _status(bad, ModuleRegistry.Status.RolledBack);
        _status(plate[0], ModuleRegistry.Status.RolledBack); // rollback clears the active plate too
        Route memory r = DNAHook(a.hook).route();
        assertEq(r.canary, address(0));
        assertEq(r.active, address(0));
        assertEq(reg.lastRollbackBlock(), block.number, "5-day clock restarts");
        (fails,) = DNAHook(a.hook).breaker();
        assertEq(fails, 0, "route push resets the breaker");
        Swap memory after_ = _swapChecked(true, 0.05 ether);
        assertEq(after_.moduleFailures, 0);
        assertEq(after_.pips, DNAHook(a.hook).BASELINE_PROJECT_FEE(), "baseline after rollback");

        // allowance: Safe funds 0.5, the L7 agent proposes and funds a 0.2 bounty from it
        vm.deal(address(safe), address(safe).balance + 1 ether);
        _safeExec(
            address(bountyBoard), 0.5 ether, abi.encodeCall(BountyBoard.fundAllowance, ()), 0, "Safe: fundAllowance"
        );
        vm.prank(agent);
        uint256 bounty = bountyBoard.propose(0.2 ether, uint64(block.timestamp + 7 days), "drill", "", new string[](0));
        vm.prank(agent);
        bountyBoard.fund(bounty);
        assertEq(bountyBoard.allowance(), 0.3 ether);

        // the agent queues one more op, then the Safe pulls the brake
        pending[1] = _agentQueue(ModuleRegistry.Op.SetShadow, abi.encode(plate[2]), "");

        // claw-back step 1 (one Safe tx): pauseAgent + cancel the allowance bounty → its 0.2 refunds INTO the allowance
        address[] memory to = new address[](2);
        bytes[] memory data = new bytes[](2);
        (to[0], data[0]) = (a.registry, abi.encodeCall(ModuleRegistry.pauseAgent, ()));
        (to[1], data[1]) = (address(bountyBoard), abi.encodeCall(BountyBoard.cancel, (bounty)));
        _safeBatch(to, data, "Safe: batch pauseAgent + BountyBoard.cancel");
        assertTrue(reg.agentPaused());
        assertEq(bountyBoard.allowance(), 0.5 ether, "cancel refunds the allowance, not the Safe");
        // step 2: read allowance() and withdraw exactly that (withdrawAllowance reverts above it)
        uint256 all = bountyBoard.allowance();
        uint256 safe0 = address(safe).balance;
        _safeCall(address(bountyBoard), abi.encodeCall(BountyBoard.withdrawAllowance, (all)), "Safe: withdrawAllowance");
        assertEq(bountyBoard.allowance(), 0);
        assertEq(address(safe).balance - safe0, 0.5 ether);

        // paused: the agent can do nothing
        vm.prank(agent);
        vm.expectRevert(ModuleRegistry.AgentIsPaused.selector);
        reg.queue(ModuleRegistry.Op.SetShadow, abi.encode(plate[1]));
        vm.prank(agent);
        vm.expectRevert(ModuleRegistry.AgentIsPaused.selector);
        reg.rollback(ModuleRegistry.Kind.Fee);
        vm.prank(agent);
        vm.expectRevert(BountyBoard.Unauthorized.selector);
        bountyBoard.propose(0.1 ether, uint64(block.timestamp + 7 days), "x", "", new string[](0));
        pending[2] = _safeQueue(ModuleRegistry.Op.UnpauseAgent, "", "Safe: queue UnpauseAgent");
    }

    function _h8_unpause_keepers() internal {
        _step();
        vm.expectRevert(ModuleRegistry.AgentIsPaused.selector);
        reg.execute(pending[1]); // paused: the agent's pending op cannot execute
        // operating rule: cancel the agent's pending ops BEFORE UnpauseAgent executes, or they become executable again
        _safeCall(a.registry, abi.encodeCall(ModuleRegistry.cancel, (_ids(pending[1]))), "Safe: cancel (1 op)");
        _exec(pending[2], "keeper: execute UnpauseAgent");
        assertFalse(reg.agentPaused());

        _keepers();

        // anchor key posts the engine-log root
        vm.prank(anchorKey);
        reg.anchor(keccak256("day"), "https://genomedna.xyz/api/log/2026-10-06");
        _rec("anchor key: anchor");

        // level drill: lowering is instant; raising back is blocked for 5 days after the last rollback
        _safeCall(a.registry, abi.encodeCall(ModuleRegistry.lowerLevel, (4)), "Safe: lowerLevel");
        assertEq(reg.level(), 4);
        uint256 raise = _safeQueue(ModuleRegistry.Op.SetLevel, abi.encode(uint8(5)), "");
        _step();
        vm.expectRevert(ModuleRegistry.RaiseTooSoon.selector);
        reg.execute(raise);
    }

    /// H9+: the launch Split goes live (Safe: SetShadow → SetCanary → PromoteActive, 1 h each), the next distribute
    /// pays exactly 10% to GamePot, a holder wins a jackpot on the real coordinator (window closed, list posted,
    /// randomness delivered as the coordinator: a fork can't make the oracle's proof) and the keeper's settle pushes the
    /// prize. Drills: VRF stall (abort → same list re-requested), cancelled subscription (coordinator
    /// owner) → recreate, split rollback (Safe) → games off.
    function _h9_games() internal {
        _h9_promoteSplit();
        _h9_distributeFourWay();
        _h9_jackpot();
        _h9_subAndRollbackDrills();
    }

    function _h9_promoteSplit() internal {
        address split = plate[3];
        _step();
        uint256 id = _safeQueue(ModuleRegistry.Op.SetShadow, abi.encode(split), "Safe: queue SetShadow (Split)");
        _step();
        _exec(id, "keeper: execute SetShadow (Split)");
        id = _safeQueue(
            ModuleRegistry.Op.SetCanary,
            abi.encode(split, uint64(block.number), PERIOD, LEN),
            "Safe: queue SetCanary (Split)"
        );
        _step();
        _exec(id, "keeper: execute SetCanary (Split)");
        id = _safeQueue(ModuleRegistry.Op.PromoteActive, abi.encode(split), "Safe: queue PromoteActive (Split)");
        _step();
        _exec(id, "keeper: execute PromoteActive (Split)");
        (uint256 b, uint256 l, uint256 t, uint256 g, bool baseline) = FeeVault(a.feeVault).currentSplit();
        assertFalse(baseline);
        assertEq(b + l + t + g, 10_000);
        assertEq(g, 1000, "games 10%");
    }

    function _h9_distributeFourWay() internal {
        _market(40, 0.5 ether); // fresh fees
        FeeVault fv = FeeVault(a.feeVault);
        uint256 amount = pm.balanceOf(a.feeVault, 0);
        uint256 total0 = fv.totalDistributed();
        vm.prank(keeper);
        fv.distribute();
        _rec("keeper: FeeVault.distribute (4-way)");
        assertEq(pm.balanceOf(a.gamePot, 0), amount * 1000 / 10_000, "GamePot = 10% of the distributed amount");
        assertEq(fv.totalDistributed() - total0, amount);
    }

    function _h9_jackpot() internal {
        GamePot pot = GamePot(payable(a.gamePot));
        ConvictionVault vault = ConvictionVault(a.convictionVault);
        address holder = makeAddr("dna.holder");
        _buy(2 ether);
        uint256 dna = IERC20(a.token).balanceOf(trader);
        vm.prank(trader);
        IERC20(a.token).transfer(holder, dna);
        vm.startPrank(holder);
        IERC20(a.token).approve(a.convictionVault, dna);
        vault.lock(dna, 0);
        vm.stopPrank();
        _rec("holder: ConvictionVault.lock");
        vm.prank(owners[0]);
        vm.expectRevert(ConvictionVault.Excluded.selector); // a Safe signer's EOA can never lock
        vault.lock(10_000 ether, 0);
        vm.deal(address(this), 1 ether);
        (bool sent,) = a.gamePot.call{value: 1 ether}(""); // a donor: the 10% share alone is below SUB_MIN + MIN_PRIZE
        assertTrue(sent);

        // the holder jackpot window closes; the engine's list (here one holder) is posted. The agent is at L4 after
        // the level drill, so the Safe posts it (either may).
        while (block.timestamp >= pot.windowEnd()) {
            pot.rollWindow();
        }
        vm.warp(pot.windowEnd());
        vm.prank(keeper);
        pot.rollWindow();
        _rec("keeper: GamePot.rollWindow");
        (uint256 w,) = pot.latestClosedWindow();
        GamePot.Leaf memory leaf = GamePot.Leaf(0, holder, 0, 1000);
        _safeCall(
            a.gamePot,
            abi.encodeCall(
                GamePot.postList,
                (
                    w,
                    GamePot.Params(100, 1_000 ether),
                    pot.leafHash(leaf),
                    1000,
                    1,
                    leaf,
                    new bytes32[](0),
                    "ipfs://rehearsal",
                    keccak256("rehearsal list")
                )
            ),
            "Safe: GamePot.postList"
        );
        vm.warp(block.timestamp + pot.LIST_DELAY());
        vm.prank(keeper);
        pot.requestDraw();
        _rec("keeper: GamePot.requestDraw (real coordinator, sub top-up)");

        // drill: VRF stall → abort after 36 h → the same list is re-requested
        vm.warp(block.timestamp + 36 hours);
        vm.prank(keeper);
        pot.abortDraw();
        _rec("keeper: GamePot.abortDraw");
        vm.prank(keeper);
        uint256 reqId = pot.requestDraw();
        (,,,, uint96 prize,,,,) = pot.draw();
        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256("rehearsal word"));
        vm.prank(address(c.vrfCoordinator));
        pot.rawFulfillRandomWords(reqId, words);
        _rec("coordinator: GamePot.rawFulfillRandomWords");
        uint256 b0 = holder.balance;
        vm.prank(keeper);
        {
            // one holder: every derived ticket is its leaf (MAX_TICKETS of them), it wins one share
            GamePot.Leaf[] memory sl = new GamePot.Leaf[](32);
            bytes32[][] memory sp = new bytes32[][](32);
            for (uint256 j; j < 32; ++j) {
                (sl[j], sp[j]) = (leaf, new bytes32[](0));
            }
            pot.settle(sl, sp);
        }
        _rec("keeper: GamePot.settle (10-winner walk, push)");
        assertEq(pot.drawCount(), 0, "pushed");
        assertEq(holder.balance - b0, uint256(prize) / 10, "one share of ten");
    }

    function _h9_subAndRollbackDrills() internal {
        GamePot pot = GamePot(payable(a.gamePot));
        // the coordinator owner cancels our subscription (refund lands in the pot) → anyone recreates it
        address coordOwner = IOwned(address(c.vrfCoordinator)).owner();
        uint256 old = pot.subId();
        vm.prank(coordOwner);
        ICoordinatorOwner(address(c.vrfCoordinator)).ownerCancelSubscription(old);
        assertGt(a.gamePot.balance, 0, "native refund received");
        pot.recreateSubscription();
        _rec("anyone: GamePot.recreateSubscription");
        assertTrue(pot.subId() != old);

        // split rollback by the Safe → FeeVault's immutable baseline, games off
        _safeCall(
            a.registry, abi.encodeCall(ModuleRegistry.rollback, (ModuleRegistry.Kind.Split)), "Safe: rollback(Split)"
        );
        (,,, uint256 g, bool baseline) = FeeVault(a.feeVault).currentSplit();
        assertTrue(baseline);
        assertEq(g, 0, "games off after rollback");
        assertEq(address(MutationBoard(a.mutationBoard).vault()), a.convictionVault);
    }

    function _keepers() internal {
        IPoolManager m = pm;
        uint256 fv = m.balanceOf(a.feeVault, 0);
        assertGe(fv, FeeVault(a.feeVault).MIN_DISTRIBUTE(), "enough fees to split");
        uint256 safe0 = address(safe).balance;
        vm.prank(keeper);
        FeeVault(a.feeVault).distribute();
        _rec("keeper: FeeVault.distribute");
        uint256 bb = fv * 3500 / 10_000;
        uint256 lp = fv * 3500 / 10_000;
        assertEq(m.balanceOf(a.buybackBurn, 0), bb, "35% buyback");
        assertEq(m.balanceOf(a.liquidityVault, 0), lp, "35% LP");
        assertEq(address(safe).balance - safe0, fv - bb - lp, "30% to the Safe as plain ETH");

        uint256 supply0 = DNAToken(a.token).totalSupply();
        (uint256 fv0, uint256 pr0) = (m.balanceOf(a.feeVault, 0), m.balanceOf(a.platformRevenue, 0));
        vm.prank(keeper);
        BuybackBurn(a.buybackBurn).process();
        _rec("keeper: BuybackBurn.process");
        assertLt(DNAToken(a.token).totalSupply(), supply0, "bought back and burned");
        assertGt(m.balanceOf(a.platformRevenue, 0), pr0, "the buyback paid the platform fee");
        assertEq(m.balanceOf(a.feeVault, 0), fv0, "and no project fee");
        assertEq(IERC20(a.token).balanceOf(a.buybackBurn), 0);

        vm.prank(keeper);
        LiquidityVault(a.liquidityVault).add();
        _rec("keeper: LiquidityVault.add");
        assertEq(LiquidityVault(a.liquidityVault).positions(), 1, "auto-LP position");

        address recipient = PlatformRevenue(a.platformRevenue).recipient();
        // Programmable's current fee recipient (/v3/capabilities currentTradeFeePolicy, routed-native-fee v2)
        assertEq(
            recipient, 0xD88539d3c4C460136a733A3Fd60cf6BF269079da, "PlatformRevenue pays Programmable's v2 recipient"
        );
        uint256 pr = m.balanceOf(a.platformRevenue, 0);
        assertGt(pr, 0, "platform fee accrued");
        uint256 r0 = recipient.balance;
        vm.prank(keeper);
        PlatformRevenue(a.platformRevenue).claim();
        _rec("keeper: PlatformRevenue.claim");
        assertEq(recipient.balance - r0, pr, "Programmable recipient takes plain ETH");
    }

    // ================================================================== helpers

    function _step() internal {
        vm.warp(block.timestamp + 1 hours);
        vm.roll(block.number + 300);
    }

    /// Rolls to the next block inside (or outside) the current canary window.
    function _rollCanary(bool inside) internal {
        Route memory r = DNAHook(a.hook).route();
        uint256 off = (block.number - r.canaryStart) % r.canaryPeriod;
        if (inside && off >= r.canaryLen) vm.roll(block.number + r.canaryPeriod - off);
        if (!inside && off < r.canaryLen) vm.roll(block.number + r.canaryLen - off);
    }

    /// `n` alternating swaps of ~`eth`: buy `eth`, then sell 95% of the DNA that buy returned.
    function _market(uint256 n, uint256 eth) internal {
        uint256 bought;
        for (uint256 i; i < n; ++i) {
            if (i % 2 == 0) bought = _swapChecked(true, eth).tokenDelta;
            else _swapChecked(false, bought * 95 / 100);
        }
    }

    /// One UR swap whose fee must equal the hook's rule computed independently from the route + pre-swap volEma.
    function _swapChecked(bool buy, uint256 amountIn) internal returns (Swap memory s) {
        uint24 want = _expectedPips();
        s = buy ? _buy(amountIn) : _sell(amountIn);
        _checkFees(s, buy, want);
    }

    /// Hook rule: active module (or baseline 2%); in the canary window the canary's answer (baseline if it fails)
    /// clamped to active ± 1 point.
    function _expectedPips() internal view returns (uint24 pips) {
        Route memory r = DNAHook(a.hook).route();
        (, uint32 volEma,,) = DNAHook(a.hook).observables();
        pips =
            r.active == address(0) ? DNAHook(a.hook).BASELINE_PROJECT_FEE() : _quote(r.active, volEma, r.activeParams);
        bool inCanary = r.canary != address(0) && block.number >= r.canaryStart && r.canaryPeriod != 0
            && (block.number - r.canaryStart) % r.canaryPeriod < r.canaryLen;
        if (inCanary) {
            uint24 y =
                r.canary == bad ? DNAHook(a.hook).BASELINE_PROJECT_FEE() : _quote(r.canary, volEma, r.canaryParams);
            uint24 lo = pips > 10_000 ? pips - 10_000 : 0;
            uint24 hi = pips + 10_000;
            pips = y < lo ? lo : (y > hi ? hi : y);
        }
    }

    function _quote(address m, uint32 volEma, bytes32[4] memory p) internal pure returns (uint24) {
        FeeContext memory ctx;
        ctx.volEma = volEma;
        return AdaptiveFee(m).projectFee(ctx, p);
    }

    function _plateQuote(uint256 i, uint32 volEma) internal view returns (uint24) {
        return _quote(plate[i], volEma, reg.getModule(plate[i]).params);
    }

    function _exec(uint256 id, string memory label) internal {
        vm.prank(keeper);
        reg.execute(id);
        if (bytes(label).length != 0) _rec(label);
    }

    function _agentQueue(ModuleRegistry.Op op, bytes memory data, string memory label) internal returns (uint256 id) {
        vm.prank(agent);
        id = reg.queue(op, data);
        if (bytes(label).length != 0) _rec(label);
    }

    function _safeQueue(ModuleRegistry.Op op, bytes memory data, string memory label) internal returns (uint256 id) {
        id = reg.nextId() + 1;
        _safeExec(a.registry, 0, abi.encodeCall(ModuleRegistry.queue, (op, data)), 0, label);
    }

    function _status(address m, ModuleRegistry.Status s) internal view {
        assertEq(uint8(reg.getModule(m).status), uint8(s), "module status");
    }

    function _ids(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function _safeCall(address to, bytes memory data, string memory label) internal {
        _safeExec(to, 0, data, 0, label);
    }

    /// Safe{Wallet}-style batch: delegatecall MultiSendCallOnly with packed (op 0, to, 0, len, data) entries.
    function _safeBatch(address[] memory to, bytes[] memory data, string memory label) internal {
        bytes memory packed;
        for (uint256 i; i < to.length; ++i) {
            packed = abi.encodePacked(packed, uint8(0), to[i], uint256(0), data[i].length, data[i]);
        }
        _safeExec(MULTISEND_CALL_ONLY, 0, abi.encodeWithSignature("multiSend(bytes)", packed), 1, label);
    }

    /// Two of three owners sign (sorted by address); S1 submits execTransaction.
    function _safeExec(address to, uint256 value, bytes memory data, uint8 op, string memory label) internal {
        bytes32 txHash = safe.getTransactionHash(to, value, data, op, 0, 0, 0, address(0), address(0), safe.nonce());
        bytes memory sigs;
        if (realSafe) {
            vm.prank(owners[1]); // the co-signer approves on chain; the submitter's own v = 1 entry needs no approval
            safe.approveHash(txHash);
            sigs = _approvedSigs(owners[0], owners[1]);
        } else {
            sigs = _sigs(txHash);
        }
        vm.prank(owners[0]);
        assertTrue(safe.execTransaction(to, value, data, op, 0, 0, 0, address(0), payable(address(0)), sigs));
        if (bytes(label).length != 0) _rec(label);
    }

    function _sigs(bytes32 h) internal view returns (bytes memory) {
        (uint256 k0, uint256 k1) = owners[0] < owners[1] ? (ownerKeys[0], ownerKeys[1]) : (ownerKeys[1], ownerKeys[0]);
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(k0, h);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(k1, h);
        return abi.encodePacked(r0, s0, v0, r1, s1, v1);
    }

    function _initTick(Vm.Log[] memory logs) internal view returns (int24 tick) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(c.poolManager) && logs[i].topics[0] == IPoolManager.Initialize.selector) {
                (,,,, tick) = abi.decode(logs[i].data, (uint24, int24, address, uint160, int24));
                return tick;
            }
        }
        revert("no Initialize event");
    }

    function _rec(string memory label) internal returns (uint256 g) {
        g = vm.lastFrameGas().gasTotalUsed;
        assertGt(g, 0, label);
        gasLabel.push(label);
        gasUsed.push(g);
    }

    function _printGas() internal view {
        console.log("== gas per transaction (whole tx incl. 21k intrinsic) ==");
        for (uint256 i; i < gasLabel.length; ++i) {
            console.log(gasUsed[i], gasLabel[i]);
        }
    }
}
