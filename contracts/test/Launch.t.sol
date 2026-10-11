// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {DNAToken} from "../src/DNAToken.sol";
import {DNAHook} from "../src/DNAHook.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {PoolBound} from "../src/PoolBound.sol";
import {ModuleRegistry} from "../src/ModuleRegistry.sol";
import {GamePot} from "../src/GamePot.sol";
import {ConvictionVault} from "../src/ConvictionVault.sol";
import {MutationBoard} from "../src/MutationBoard.sol";
import {LaunchPlanner, LaunchSplit} from "../script/Launch.s.sol";
import {Bootstrap} from "../src/Bootstrap.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// Full launch pipeline: address derivation, hook salt mining, graph dry run, `launchAndStampV1` with a mocked
/// EIP-1271 permit, gas gate (whole isolated tx ≤ 16,777,216), then post-launch deployments.
contract LaunchTest is Test, LaunchPlanner {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for *;

    /// Local: fresh PoolManager/PositionManager and the vendored Programmable Router + graph factory. Runs in CI.
    function test_launch_local() public {
        _rehearse(localConfig(), "local");
    }

    /// Mainnet fork against the real PoolManager, PositionManager, graph factory and Router. Skipped without
    /// MAINNET_RPC_URL (e.g. MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com forge test --mt fork).
    function test_launch_fork() public {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        vm.skip(bytes(rpc).length == 0);
        vm.createSelectFork(rpc);
        Config memory c = mainnetConfig();
        // the 24-hour successor Router fresh 3.6 packs bind (unverified on explorers): pinned by runtime hash
        assertEq(address(c.router), 0xBE4bF6Ac8c6F012E1C8f25747A9fBccB2FDAC4C3, "Router");
        assertEq(
            address(c.router).codehash,
            0xf2d611fb92718c63cf5767300e79d7c9b49480b2e9001448b96c1385f4edb6f3,
            "Router runtime"
        );
        _rehearse(c, "fork");
    }

    function _rehearse(Config memory c, string memory label) internal {
        Plan memory p = plan(c);
        Addrs memory a = p.a;
        assertEq(uint160(a.hook) & 0x3fff, 0x3fff, "hook flags");

        uint256 nextId = c.positionManager.nextTokenId();
        uint256 txGas = launch(c, p); // isolated tx; reverts above the EIP-7825 cap
        console.log(label, "launch tx gas (incl. intrinsic):", txGas);
        assertLe(txGas, TX_GAS_CAP, "gate: > 16,777,216");

        // stamped, components as predicted
        assertEq(c.router.launchIdByToken(a.token), p.stamp.launchId, "stamp");
        assertEq(DNAHook(a.hook).feeVault(), a.feeVault);
        assertEq(DNAHook(a.hook).registry(), a.registry);
        assertEq(DNAHook(a.hook).buybackBurn(), a.buybackBurn);
        assertEq(DNAHook(a.hook).platformRevenue(), a.platformRevenue);

        // pool live, both positions (main + full range) dead-owned, the excess DNA burned, the pool holds every DNA
        // left, Bootstrap empty, fees on the launch buy accrued as claims to undeployed vaults
        (uint160 sqrtP,,,) = c.poolManager.getSlot0(DNAHook(a.hook).poolKey().toId());
        assertGt(sqrtP, 0);
        assertEq(IERC721(address(c.positionManager)).ownerOf(nextId), address(0xdEaD));
        assertEq(IERC721(address(c.positionManager)).ownerOf(nextId + 1), address(0xdEaD), "full range");
        uint256 supply = DNAToken(a.token).totalSupply();
        assertLt(supply, 1_000_000_000 ether, "excess burned");
        assertGt(supply, 999_900_000 ether, "only the excess: < 0.01% of supply");
        assertEq(DNAToken(a.token).balanceOf(address(c.poolManager)), supply);
        assertEq(DNAToken(a.token).balanceOf(a.bootstrap), 0);
        assertEq(a.bootstrap.balance, 0);
        assertEq(c.poolManager.balanceOf(a.feeVault, 0), c.params.buyEth * DNAHook(a.hook).LAUNCH_PROJECT_FEE() / 1e6); // at t = 0
        uint256 nominal = c.params.buyEth * DNAHook(a.hook).PLATFORM_FEE() / 1e6;
        assertEq(
            c.poolManager.balanceOf(a.platformRevenue, 0), nominal + 1, "platform: nominal + the rounding remainder"
        );
        assertEq(a.feeVault.code.length, 0);

        // post-launch: registry + vaults land exactly at the addresses baked into the hook, Safe wires them
        uint256[12] memory g = postLaunch(c, p);
        console.log(label, "post-launch deploy gas (7 CREATE2):", g[0] + g[1] + g[2] + g[3] + g[4] + g[5] + g[6]);
        console.log(label, "  ConvictionVault / GamePot / MutationBoard:", g[3], g[4]);
        console.log(label, "  ", g[6]);
        console.log(label, "post-launch wiring gas (5 Safe calls):", g[7] + g[8] + g[9] + g[10] + g[11]);
        assertEq(ModuleRegistry(a.registry).hook(), a.hook);
        assertEq(PoolBound(a.buybackBurn).hook(), a.hook);
        assertEq(PoolBound(a.liquidityVault).token(), a.token);
        assertEq(FeeVault(a.feeVault).registry(), a.registry);
        assertEq(FeeVault(a.feeVault).liquidityVault(), a.liquidityVault);
        assertEq(FeeVault(a.feeVault).gamePot(), a.gamePot);
        // games wired: GamePot bound to the hook (VRF subscription created, window 1 open), vault bound to DNA
        GamePot pot = GamePot(payable(a.gamePot));
        assertEq(pot.hook(), a.hook);
        assertEq(pot.feeVault(), a.feeVault);
        assertEq(address(pot.vault()), a.convictionVault);
        assertTrue(pot.subId() != 0);
        assertEq(pot.windowId(), 1);
        assertEq(address(ConvictionVault(a.convictionVault).token()), a.token);
        assertTrue(ConvictionVault(a.convictionVault).excluded(c.excluded[0]));
        assertEq(address(MutationBoard(a.mutationBoard).vault()), a.convictionVault);
    }
}

/// Mainnet fail-closed guards (no env, no fork: the helpers are called directly).
contract LaunchGuardTest is Test, LaunchPlanner {
    function xHandle(string memory confirmed) external {
        requireXHandleConfirmed(confirmed);
    }

    /// The handle is x.com/contractdna, and still every mainnet path needs the operator to confirm
    /// it at pack time: no value or a wrong one reverts, only the exact literal passes.
    function test_xHandleMustBeConfirmed() public {
        assertEq(new DNAToken(address(1)).X_HANDLE(), "contractdna");
        string memory wrong = "X_HANDLE_CONFIRMED != DNAToken.X_HANDLE: confirm the X handle first";
        vm.expectRevert(bytes(wrong));
        this.xHandle("");
        vm.expectRevert(bytes(wrong));
        this.xHandle("contractdnax");
        vm.expectRevert(bytes(wrong));
        this.xHandle("@contractdna");
        this.xHandle("contractdna");
    }

    /// The placeholder of the PR-A commit can never reach a launch: FeeVault's init code holds GamePot's own CREATE2
    /// address, derived from GamePot's init code (vault, registry, VRF coordinator, keyHash).
    function test_gamePotIsTheRealCreate2Address() public view {
        Config memory c = mainnetConfig();
        Plan memory p;
        postLaunchInits(c, p);
        assertEq(p.a.gamePot, create2(CREATE2_FACTORY, c.postLaunchSalt, p.postInits[4]));
        assertTrue(p.a.gamePot != address(uint160(uint256(keccak256("dna.gamePot.placeholder")))));
        assertTrue(vm.contains(vm.toString(p.postInits[5]), _hex(p.a.gamePot)), "FeeVault init code embeds GamePot");
        assertEq(address(c.vrfCoordinator), 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a, "VRF pinned in mainnetConfig");
    }

    function _hex(address a) internal pure returns (string memory) {
        bytes memory s = bytes(vm.toString(a)); // 0x + checksummed; init code hex is lowercase
        bytes memory out = new bytes(40);
        for (uint256 i; i < 40; ++i) {
            bytes1 ch = s[i + 2];
            out[i] = ch >= 0x41 && ch <= 0x5a ? bytes1(uint8(ch) + 32) : ch;
        }
        return string(out);
    }

    function excluded(address[] memory ex, address[] memory signers) external pure {
        requireExcluded(ex, signers);
    }

    function initialBuy(uint256 v) external pure {
        requireInitialBuy(v);
    }

    /// The launch value: 0.5 ETH by default, never zero (Programmable V3); the buy part and MIN_DNA_OUT come from
    /// LaunchSplit, whose fee is the hook's at t = 0.
    function test_initialBuy() public {
        Config memory c = baseConfig();
        assertEq(c.initialBuy, 0.5 ether);
        (uint256 buyEth, uint256 dnaOut) =
            LaunchSplit.split(c.params.sqrtPriceX96, c.params.tickLower, c.params.tickUpper, c.initialBuy);
        assertEq(c.params.buyEth, buyEth);
        assertEq(c.params.minDnaOut, dnaOut * 9 / 10);
        assertGt(buyEth, 0.2 ether);
        assertLt(buyEth, 0.3 ether);
        address h = address(uint160(0x4444 << 144) | uint160(0x3fff));
        deployCodeTo(
            "DNAHook.sol:DNAHook", abi.encode(address(1), address(2), address(3), address(4), address(5), address(6)), h
        );
        assertEq(
            LaunchSplit.FEE_AT_LAUNCH,
            DNAHook(h).LAUNCH_PROJECT_FEE() + DNAHook(h).PLATFORM_FEE(),
            "split fee == the hook's at t = 0"
        );
        vm.expectRevert(bytes("INITIAL_BUY_WEI must be nonzero"));
        this.initialBuy(0);
        this.initialBuy(1);
    }

    function launchParams_(uint160 sqrtP, int24 lower, int24 upper, uint256 value, uint256 buyEth)
        external
        pure
        returns (Bootstrap.LaunchParams memory)
    {
        return launchParams(sqrtP, lower, upper, value, buyEth);
    }

    /// The launch params' rules: the opening tick is tickUpper, an explicit buy is at least the split, and MIN_DNA_OUT
    /// is 90% of what the actual buy returns.
    function test_launchParams() public {
        Config memory c = baseConfig();
        (uint160 sq, int24 lo, int24 up) = (c.params.sqrtPriceX96, c.params.tickLower, c.params.tickUpper);
        (uint256 split,) = LaunchSplit.split(sq, lo, up, 0.5 ether);
        Bootstrap.LaunchParams memory p = this.launchParams_(sq, lo, up, 0.5 ether, 0);
        assertEq(p.buyEth, split, "default: the split");
        p = this.launchParams_(sq, lo, up, 0.5 ether, split + 0.01 ether);
        assertEq(p.buyEth, split + 0.01 ether);
        assertEq(p.minDnaOut, LaunchSplit.buyOutput(sq, lo, up, split + 0.01 ether) * 9 / 10, "from the actual buy");
        assertGt(p.minDnaOut, this.launchParams_(sq, lo, up, 0.5 ether, 0).minDnaOut);
        vm.expectRevert(bytes("BUY_WEI below the launch split: the full-range position would be DNA-limited"));
        this.launchParams_(sq, lo, up, 0.5 ether, split - 1);
        vm.expectRevert(bytes("the opening tick must equal TICK_UPPER"));
        this.launchParams_(sq, lo, up - 1, 0.5 ether, 0);
    }

    /// The model starts where the liquidity does: at TICK_UPPER's price when the opening price sits above it.
    function test_splitStartsAtTickUpper() public pure {
        uint160 at = TickMath.getSqrtPriceAtTick(201_107);
        uint160 above = TickMath.getSqrtPriceAtTick(201_108) - 1; // same opening tick, higher price
        assertEq(
            LaunchSplit.buyOutput(above, 1107, 201_107, 0.2 ether), LaunchSplit.buyOutput(at, 1107, 201_107, 0.2 ether)
        );
    }

    /// The launch tx's gas margin: 0.03 ETH unless LAUNCH_GAS_MARGIN_WEI says otherwise.
    function test_launchGasMargin() public {
        assertEq(launchGasMargin(), 0.03 ether);
        vm.setEnv("LAUNCH_GAS_MARGIN_WEI", "50000000000000000");
        assertEq(launchGasMargin(), 0.05 ether);
    }

    /// EXCLUDED_WALLETS fails closed: empty, a zero address, or a Safe signer missing.
    function test_excludedWalletsGuard() public {
        address[] memory signers = new address[](2);
        (signers[0], signers[1]) = (address(0xA1), address(0xA2));
        address[] memory ex = new address[](0);
        vm.expectRevert(bytes("EXCLUDED_WALLETS is empty"));
        this.excluded(ex, signers);
        ex = new address[](2);
        (ex[0], ex[1]) = (address(0xA1), address(0));
        vm.expectRevert(bytes("EXCLUDED_WALLETS has the zero address"));
        this.excluded(ex, signers);
        ex[1] = address(0xB0);
        vm.expectRevert(bytes("a Safe signer is missing from EXCLUDED_WALLETS"));
        this.excluded(ex, signers);
        ex[1] = address(0xA2);
        this.excluded(ex, signers);
    }
}
