// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary, PoolKey} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import {DNAHook} from "../../src/DNAHook.sol";
import {BuybackBurn} from "../../src/BuybackBurn.sol";
import {Bootstrap} from "../../src/Bootstrap.sol";
import {IDNAHook} from "../../src/interfaces/IDNA.sol";
import {URSwaps, IUniversalRouter} from "./UniversalRouter.t.sol";

/// Runs its calls in order, in ONE transaction; bubbles the first revert.
contract Multicall {
    function run(address[] calldata to, uint256[] calldata value, bytes[] calldata data) external payable {
        for (uint256 i; i < to.length; ++i) {
            (bool ok, bytes memory ret) = to[i].call{value: value[i]}(data[i]);
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }

    receive() external payable {}
}

/// Sniper attacks against the launch guard on a mainnet fork: the 9-block tax ladder (90% → 10%) and, until 4
/// minutes after launch, net 2% of supply per block (from block 0) and net 1% per sending wallet (tx.origin, counted
/// from block 0, enforced from block 4). The real launch (Programmable Router + graph deployer, real PoolManager), the real Universal Router, a
/// 0.5 ETH launch value (the LaunchSplit buy + a full-range position of the rest, both dead-owned) and the
/// Launch.s.sol default opening price (M = 1: tick 201107, range [1107, 201107)).
/// MAINNET_RPC_URL=https://ethereum-rpc.publicnode.com [FORK_BLOCK=n] forge test --match-path test/fork/SniperSim.t.sol -vv
abstract contract SniperSim is URSwaps {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IV4Quoter constant QUOTER = IV4Quoter(0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203); // Uniswap v4 Quoter, mainnet
    uint256 constant WALLET_CAP = 10_000_000 ether; // 1%
    uint256 constant BLOCK_CAP = 20_000_000 ether; // 2%
    uint256 constant SUPPLY = 1_000_000_000 ether;
    uint256 constant BLOCK_TIME = 12;

    DNAHook hook;
    uint256 launchBlock;
    uint256 t0;
    int24 openTick;
    address bot = makeAddr("bot");

    struct Fill {
        uint256 eth; // buy: ETH paid · sell: ETH received
        uint256 dna; // buy: DNA received · sell: DNA paid
        uint256 gross;
        uint256 project;
        uint256 platform;
        uint24 pips;
        uint256 toBurn; // claims minted to BuybackBurn
        uint256 toVault; // claims minted to FeeVault
    }

    /// Opening-price multiple (1: the v1 default).
    function _m() internal pure virtual returns (uint256);

    uint256 fullId; // the launch's full-range position

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        vm.skip(bytes(rpc).length == 0);
        uint256 fb = vm.envOr("FORK_BLOCK", uint256(0));
        if (fb == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, fb);
        assertEq(address(UR).codehash, UR_RUNTIME_HASH, "UR runtime != Programmable-pinned router");

        c = mainnetConfig(); // the v1 defaults: open at tick 201107, [1107, 201107), 0.5 ETH, the LaunchSplit buy
        assertEq(c.initialBuy, 0.5 ether);
        openTick = TickMath.getTickAtSqrtPrice(c.params.sqrtPriceX96);
        assertEq(openTick, 201_107);
        Plan memory p = plan(c);
        a = p.a;
        fullId = c.positionManager.nextTokenId() + 1;
        launch(c, p);
        postLaunch(c, p);
        _wire();
        hook = DNAHook(a.hook);
        (launchBlock, t0) = (block.number, block.timestamp);

        assertEq(IERC721(address(c.positionManager)).ownerOf(fullId), address(0xdEaD), "full range: 0xdEaD");
        assertEq(pm.balanceOf(a.buybackBurn, 0), 0, "launch buy: exempt from the tax");
        assertEq(pm.balanceOf(a.feeVault, 0), c.params.buyEth * hook.LAUNCH_PROJECT_FEE() / 1e6, "launch buy: 3%");
    }

    /// 0. The launch itself: the buy, the full-range position (ETH + DNA), the DNA burned, the FDV after.
    function test_0_launch() public view {
        (uint160 sqrtP,,,) = pm.getSlot0(key.toId());
        uint128 l = c.positionManager.getPositionLiquidity(fullId);
        uint256 eth = SqrtPriceMath.getAmount0Delta(sqrtP, TickMath.MAX_SQRT_PRICE, l, true);
        uint256 dna = SqrtPriceMath.getAmount1Delta(TickMath.MIN_SQRT_PRICE, sqrtP, l, true);
        uint256 burned = SUPPLY - IERC20(a.token).totalSupply();
        _log("S0 launch value (ETH)", _eth(c.initialBuy));
        _log("S0 launch buy (ETH)", _eth(c.params.buyEth));
        _log("S0 full-range position: ETH", _eth(eth));
        _log("S0 full-range position: DNA (% supply)", _pct(dna));
        _log("S0 DNA burned (excess, % supply)", _pct(burned));
        _log("S0 DNA burned (wei)", vm.toString(burned));
        _log("S0 opening FDV (ETH)", _fmt(_openFdv() / 1e16, 2));
        _log("S0 FDV after the launch (ETH)", _fmt(_poolFdv() / 1e16, 2));
        assertLt(burned, dna / 1000, "excess burn < 0.1% of the position's DNA");
    }

    // ================================================================== scenarios

    /// 1. A bot's 5 ETH in the launch block (new tx right after the launch): the block's 2% stops it; the largest buy
    ///    under 2% passes and pays 90% to buyback-and-burn. Its wallet net is recorded, so from block 4 (over 1%) it
    ///    cannot buy inside the window.
    function test_1_sameBlockSniper() public {
        assertEq(block.number, launchBlock);
        _expectRevertBuy(bot, 5 ether, DNAHook.LaunchCapExceeded.selector);
        uint256 amt = _blockCapIn();
        Fill memory f = _buyAs(bot, amt);
        assertLe(f.dna, BLOCK_CAP);
        assertGe(f.dna, BLOCK_CAP * 999 / 1000);
        assertEq(f.pips, 900_000, "90%");
        assertEq(f.toBurn, amt * 900_000 / 1e6, "project share -> BuybackBurn");
        assertEq(f.toVault, 0);
        assertEq(hook.walletBought(bot), f.dna, "recorded from block 0");
        _at(4);
        _expectRevertBuy(bot, 0.001 ether, DNAHook.WalletCapExceeded.selector);

        _log("S1 5 ETH all-in at k=0", "reverts LaunchCapExceeded");
        _log("S1 max buy under 2% at k=0: ETH", _eth(f.eth));
        _log("S1   DNA received (% supply)", _pct(f.dna));
        _log("S1   tax paid to BuybackBurn (ETH)", _eth(f.toBurn));
        _log("S1   avg FDV paid / opening FDV (x)", _fmt(_fdv(f.eth, f.dna) * 100 / _openFdv(), 2));
        _log("S1   buys again at k=4", "reverts WalletCapExceeded");
    }

    /// 2. One buy (+ a sell of half) per block for k = 1..9: 80%..10%, then the normal fee; the project share goes to
    ///    BuybackBurn during the ladder and FeeVault gets nothing until k = 9.
    function test_2_ladder() public {
        uint256 vault0 = pm.balanceOf(a.feeVault, 0);
        for (uint256 k = 1; k <= 9; ++k) {
            _at(k);
            uint24 want = uint24(_tax(k));
            if (k == 9) {
                want = hook.baselineFee();
                assertEq(want, 22_000 + 8_000 * (3600 - 9 * BLOCK_TIME) / 3600, "k=9: the decaying launch fee");
            }
            uint256 burn0 = pm.balanceOf(a.buybackBurn, 0);
            Fill memory b = _buyAs(bot, 0.001 ether);
            Fill memory s = _sellAs(bot, b.dna / 2);
            for (uint256 i; i < 2; ++i) {
                Fill memory f = i == 0 ? b : s;
                assertEq(f.pips, want, "pips");
                assertEq(f.project, f.gross * want / 1e6, "project = gross * tax");
                assertGe(f.platform, f.gross * 3_000 / 1e6);
                assertLe(f.platform, f.gross * 3_000 / 1e6 + 1);
                assertEq(k < 9 ? f.toBurn : f.toVault, f.project, "project share recipient");
                assertEq(k < 9 ? f.toVault : f.toBurn, 0, "nothing to the other one");
            }
            assertEq(pm.balanceOf(a.buybackBurn, 0) - burn0, k < 9 ? b.project + s.project : 0, "burn claims grow");
            if (k < 9) assertEq(pm.balanceOf(a.feeVault, 0), vault0, "FeeVault: nothing during the ladder");
            console.log(
                string.concat(
                    _tag(),
                    " S2 k=",
                    vm.toString(k),
                    " charged buy ",
                    _fmt((b.project + b.platform) * 10_000 / b.gross, 2),
                    "% sell ",
                    _fmt((s.project + s.platform) * 10_000 / s.gross, 2),
                    "% | BuybackBurn claims ",
                    _eth(pm.balanceOf(a.buybackBurn, 0)),
                    " ETH | FeeVault +",
                    _eth(pm.balanceOf(a.feeVault, 0) - vault0)
                )
            );
        }
        assertGt(pm.balanceOf(a.feeVault, 0), vault0, "k=9: FeeVault accrues again");
    }

    /// 3. One bot contract, several UR swaps in ONE transaction totaling > 1%: its origin's cap reverts it (2 of them,
    ///    0.8%, pass).
    function test_3_atomicMultiSwap() public {
        _at(9);
        uint256 each = _quoteIn(WALLET_CAP * 4 / 10); // ~0.4% each
        Multicall m = new Multicall();
        vm.deal(address(m), 10 ether);
        (address[] memory to, uint256[] memory val, bytes[] memory data) = _calls(3);
        for (uint256 i; i < 3; ++i) {
            (to[i], val[i], data[i]) = (address(UR), each, _urCall(true, each));
        }
        vm.expectRevert(_err(DNAHook.WalletCapExceeded.selector));
        vm.prank(bot, bot);
        m.run(to, val, data);
        _log("S3 3 x 0.4% in one tx (k=9)", "reverts WalletCapExceeded");

        (to, val, data) = _calls(2);
        for (uint256 i; i < 2; ++i) {
            (to[i], val[i], data[i]) = (address(UR), each, _urCall(true, each));
        }
        vm.prank(bot, bot);
        m.run(to, val, data);
        uint256 got = IERC20(a.token).balanceOf(address(m));
        assertGt(got, WALLET_CAP * 79 / 100);
        assertLe(got, WALLET_CAP);
        _log("S3 2 x 0.4% in one tx: passes, DNA", _pct(got));
    }

    /// 4. A 16-wallet bundle at k = 4 (50% tax), every wallet trying its full 1%: the block's 2% stops it.
    function test_4_bundle16() public {
        _at(4);
        (uint256 n, uint256 got, uint256 spent) = _bundle(16);
        assertEq(n, 2, "two wallets fill the block");
        assertLe(got, BLOCK_CAP);
        assertGe(got, BLOCK_CAP * 97 / 100);
        _log("S4 16-wallet bundle at k=4: wallets filled", vm.toString(n));
        _log("S4   DNA (% supply)", _pct(got));
        _log("S4   ETH spent", _eth(spent));
        _log("S4   avg FDV paid / opening FDV (x)", _fmt(_fdv(spent, got) * 100 / _openFdv(), 2));
    }

    /// 5. Buy 1% and sell it back in one tx: the block's net returns to 0, so two users can still buy 1% each there
    ///    (the griefer's own 1% stays used: the wallet cap counts gross buys).
    function test_5_roundTripGriefer() public {
        _at(9);
        uint256 amt = _capIn();
        (uint256 dna,) = QUOTER.quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(key, true, uint128(amt), ""));
        Multicall g = new Multicall();
        vm.deal(address(g), amt);
        (address[] memory to, uint256[] memory val, bytes[] memory data) = _calls(4);
        (to[0], val[0], data[0]) = (address(UR), amt, _urCall(true, amt));
        (to[1], data[1]) = (a.token, abi.encodeCall(IERC20.approve, (address(PERMIT2), dna)));
        (to[2], data[2]) =
        (
            address(PERMIT2),
            abi.encodeCall(PERMIT2.approve, (a.token, address(UR), uint160(dna), uint48(block.timestamp + 3600)))
        );
        (to[3], data[3]) = (address(UR), _urCall(false, dna));
        address griefer = makeAddr("griefer");
        vm.prank(griefer, griefer);
        g.run(to, val, data);
        assertEq(IERC20(a.token).balanceOf(address(g)), 0, "sold all of it");
        assertGe(hook.walletBought(griefer), WALLET_CAP * 999 / 1000, "gross: the griefer cannot buy again");
        uint256 cost = amt - address(g).balance;

        uint256 late = _quoteIn(WALLET_CAP / 1000); // quoted while there is room (the Quoter runs the hook's caps)
        Fill memory u1 = _buyAs(makeAddr("user1"), _capIn());
        Fill memory u2 = _buyAs(makeAddr("user2"), _capIn());
        assertGe(u1.dna + u2.dna, BLOCK_CAP * 999 / 1000);
        _expectRevertBuy(makeAddr("late"), late, DNAHook.LaunchCapExceeded.selector);
        _log("S5 griefer round trip of 1% (cost, ETH)", _eth(cost));
        _log("S5 two users after it in the same block: pass, DNA", _pct(u1.dna + u2.dna));
    }

    /// 6. A sniper with 20 ETH over the 4-minute window: buying at the caps every block from k = 4 with 1 wallet and
    ///    with 16 wallets; the same 20 ETH all-in at k = 3 (the block's 2% stops it); and 2% in every block k = 0..3
    ///    (the block cap) followed by the caps from k = 4, with 1 and with 16 wallets.
    function test_6_sniperEconomics() public {
        uint256 openFdv = _openFdv();
        _log("S6 opening FDV (ETH)", _fmt(openFdv / 1e16, 2));
        _log("S6 FDV after the launch buy (ETH)", _fmt(_poolFdv() / 1e16, 2));
        uint256 snap = vm.snapshotState();
        uint8[2] memory ws = [1, 16];
        for (uint256 i; i < 2; ++i) {
            vm.revertToState(snap);
            (uint256 spent, uint256 got, uint256 blocks, uint256 lastK) = _snipe(ws[i], 20 ether, 1_000);
            assertLe(got, ws[i] * WALLET_CAP, "never more than 1% a wallet");
            string memory w = string.concat("S6 ", vm.toString(ws[i]), " wallet(s), caps from k=4:");
            _log(string.concat(w, " DNA (% supply)"), _pct(got));
            _log(string.concat(w, " ETH spent"), _eth(spent));
            _log(
                string.concat(w, " blocks used / last k"), string.concat(vm.toString(blocks), " / ", vm.toString(lastK))
            );
            _log(string.concat(w, " avg entry / opening FDV (x)"), _fmt(_fdv(spent, got) * 100 / openFdv, 2));
            _log(string.concat(w, " FDV when it stops (ETH)"), _fmt(_poolFdv() / 1e16, 2));
        }
        vm.revertToState(snap);
        _at(3);
        _expectRevertBuy(makeAddr("allIn"), 20 ether, DNAHook.LaunchCapExceeded.selector);
        Fill memory f = _buyAs(makeAddr("allIn"), _blockCapIn());
        _log("S6 1 wallet, 20 ETH all-in at k=3", "reverts LaunchCapExceeded");
        _log("S6   the most it can buy at k=3 (60%): DNA", _pct(f.dna));
        _log("S6   for ETH", _eth(f.eth));
        _log("S6   tax to BuybackBurn (ETH)", _eth(f.toBurn));

        // 2% every block k = 0..3 (the block cap), then the caps from k = 4: 1 wallet, and 16 wallets
        for (uint256 i; i < 2; ++i) {
            vm.revertToState(snap);
            uint256 burn0 = pm.balanceOf(a.buybackBurn, 0);
            uint256 spent;
            uint256 got;
            for (uint256 k; k < 4; ++k) {
                _at(k);
                Fill memory e = _buyAs(_wallet(0), _blockCapIn());
                (spent, got) = (spent + e.eth, got + e.dna);
            }
            (uint256 s2, uint256 g2, uint256 blocks, uint256 lastK) = _snipe(ws[i], 20 ether - spent, 1_000);
            (spent, got) = (spent + s2, got + g2);
            string memory w = string.concat("S6 ", vm.toString(ws[i]), " wallet(s), 2% at k=0..3 then capped:");
            _log(string.concat(w, " DNA (% supply)"), _pct(got));
            _log(string.concat(w, " ETH spent"), _eth(spent));
            _log(string.concat(w, " ETH to BuybackBurn"), _eth(pm.balanceOf(a.buybackBurn, 0) - burn0));
            _log(
                string.concat(w, " blocks from k=4 / last k"),
                string.concat(vm.toString(blocks), " / ", vm.toString(lastK))
            );
            _log(string.concat(w, " avg entry / opening FDV (x)"), _fmt(_fdv(spent, got) * 100 / openFdv, 2));
            _log(string.concat(w, " FDV when it stops (ETH)"), _fmt(_poolFdv() / 1e16, 2));
        }
    }

    /// 7. Exit check: a sniper buys 1% in block k (0..8) and sells it all back right away (same block, same tax); and
    ///    one who bought 1% in each uncapped block 0..3 and sells all at k = 9 (first untaxed block).
    function test_7_exitCheck() public {
        for (uint256 k; k <= 8; ++k) {
            uint256 snap = vm.snapshotState();
            _at(k);
            Fill memory b = _buyAs(bot, _capIn());
            Fill memory back = _sellAs(bot, b.dna);
            uint256 loss = (b.eth - back.eth) * 10_000 / b.eth;
            uint256 t = _tax(k) + 3_000;
            assertGe(loss * 100 + 100, 1e6 - (1e6 - t) * (1e6 - t) / 1e6, "loss >= both taxes");
            console.log(
                string.concat(
                    _tag(),
                    " S7 k=",
                    vm.toString(k),
                    " buy ",
                    _eth(b.eth),
                    " ETH, sell back same block: loss ",
                    _fmt(loss, 2),
                    "%"
                )
            );
            vm.revertToState(snap);
        }
        uint256 spent;
        uint256 held;
        for (uint256 k; k <= 3; ++k) {
            _at(k);
            Fill memory b = _buyAs(bot, _capIn());
            (spent, held) = (spent + b.eth, held + b.dna);
        }
        _at(9);
        Fill memory s = _sellAs(bot, held);
        _log("S7 1% in each of k=0..3 (% supply)", _pct(held));
        _log("S7   ETH spent", _eth(spent));
        _log("S7   sold all at k=9: ETH back", _eth(s.eth));
        _log("S7   loss %", _fmt((spent - s.eth) * 10_000 / spent, 2));
    }

    /// 8. BuybackBurn.process() after the ladder spends the accumulated claims, ≤ 1 ETH an hour, within 0.5% of price.
    function test_8_buybackBurn() public {
        for (uint256 k; k <= 8; ++k) {
            _at(k);
            _buyAs(makeAddr(string.concat("ladder", vm.toString(k))), _capIn()); // 1% every block, a wallet each
        }
        _at(9);
        BuybackBurn bb = BuybackBurn(a.buybackBurn);
        uint256 claims0 = pm.balanceOf(address(bb), 0);
        _log("S8 BuybackBurn claims after the ladder (ETH)", _eth(claims0));
        uint256 totalSpent;
        for (uint256 i; i < 3; ++i) {
            if (i != 0) {
                vm.roll(block.number + 300);
                vm.warp(block.timestamp + 1 hours);
            }
            uint256 c0 = pm.balanceOf(address(bb), 0);
            uint256 s0 = IERC20(a.token).totalSupply();
            bb.process();
            uint256 spent = c0 - pm.balanceOf(address(bb), 0);
            uint256 burned = s0 - IERC20(a.token).totalSupply();
            assertLe(spent, bb.MAX_SIZE(), "<= 1 ETH a call");
            assertGt(burned, 0);
            totalSpent += spent;
            vm.expectRevert(BuybackBurn.CoolingDown.selector);
            bb.process();
            console.log(
                string.concat(
                    _tag(),
                    " S8 process #",
                    vm.toString(i + 1),
                    ": spent ",
                    _eth(spent),
                    " ETH, burned ",
                    _pct(burned),
                    " (",
                    vm.toString(burned / 1e18),
                    " DNA)"
                )
            );
            if (i == 0) {
                // the buyback did not use up the block's cap: a user can still buy ~1% in the same block
                Fill memory u = _buyAs(makeAddr("user"), _capIn());
                assertGe(u.dna, WALLET_CAP * 999 / 1000);
            }
        }
        _log("S8 claims left after 3 calls (ETH)", _eth(pm.balanceOf(address(bb), 0)));
        _log("S8 hours to drain at this rate", vm.toString(claims0 * 3 / totalSpent));
    }

    /// 9. After 4 minutes the caps are gone: 2% from one wallet in one swap (and again in the same block) passes; 1 s
    ///    earlier it reverts.
    function test_9_after4Minutes() public {
        vm.roll(launchBlock + 20);
        vm.warp(t0 + 4 minutes);
        uint256 amt = _quoteIn(2 * WALLET_CAP);
        vm.warp(t0 + 4 minutes - 1);
        _expectRevertBuy(bot, amt, DNAHook.WalletCapExceeded.selector);
        vm.warp(t0 + 4 minutes);
        Fill memory f = _buyAs(bot, amt);
        assertGe(f.dna, 2 * WALLET_CAP * 999 / 1000);
        Fill memory g = _buyAs(bot, _quoteIn(2 * WALLET_CAP));
        assertGe(g.dna, 2 * WALLET_CAP * 999 / 1000);
        _log("S9 2% at t0+4min: passes, DNA", _pct(f.dna));
        _log("S9 another 2% same block: passes, DNA", _pct(g.dna));
    }

    /// 10. A normal 0.05 ETH buyer at minutes 1, 3 and 5: alone, and right after the 16-wallet sniper (20 ETH) has
    ///     bought at the caps every block up to and including the buyer's block.
    function test_10_normalBuyer() public {
        uint256 snap = vm.snapshotState();
        uint256[3] memory mins = [uint256(1), 3, 5];
        for (uint256 j; j < 2; ++j) {
            for (uint256 i; i < 3; ++i) {
                vm.revertToState(snap);
                uint256 k = mins[i] * 60 / BLOCK_TIME;
                if (j == 1) _snipe(16, 20 ether, k);
                _at(k);
                address u = makeAddr("normal");
                (bool ok, bytes memory ret, Fill memory f) = _tryBuy(u, 0.05 ether);
                string memory tag = string.concat(
                    "S10 0.05 ETH at minute ",
                    vm.toString(mins[i]),
                    " (k=",
                    vm.toString(k),
                    j == 0 ? ", alone)" : ", after sniper)"
                );
                if (!ok) {
                    _log(tag, string.concat("reverts ", _reason(ret)));
                    continue;
                }
                _log(
                    tag,
                    string.concat(
                        _pct(f.dna),
                        " DNA, charged ",
                        _fmt((f.project + f.platform) * 10_000 / f.gross, 2),
                        "%, entry/opening FDV ",
                        _fmt(_fdv(f.eth, f.dna) * 100 / _openFdv(), 2),
                        "x"
                    )
                );
            }
        }
    }

    // ================================================================== helpers

    function _at(uint256 k) internal {
        vm.roll(launchBlock + k);
        vm.warp(t0 + k * BLOCK_TIME);
    }

    function _tax(uint256 k) internal pure returns (uint256) {
        return k < 9 ? 900_000 - k * 100_000 : 0;
    }

    function _wallet(uint256 i) internal returns (address) {
        return makeAddr(string.concat("sniper", vm.toString(i)));
    }

    /// `n` fresh wallets in this block, each sending the ETH that buys 1% at the block's opening price. (Quoted once,
    /// up front: the Quoter runs the hook too, so a quote past a cap reverts.)
    function _bundle(uint256 n) internal returns (uint256 filled, uint256 got, uint256 spent) {
        uint256 amt = _capIn();
        for (uint256 i; i < n; ++i) {
            (bool ok,, Fill memory f) = _tryBuy(_wallet(i), amt);
            if (ok) (filled, got, spent) = (filled + 1, got + f.dna, spent + f.eth);
        }
    }

    /// From k = 4 to the window's end (or `lastK`, or the budget), `wallets` wallets buy at the caps every block.
    function _snipe(uint256 wallets, uint256 budget, uint256 lastK)
        internal
        returns (uint256 spent, uint256 got, uint256 blocks, uint256 k)
    {
        for (k = 4; k <= lastK && k * BLOCK_TIME < hook.LAUNCH_CAP_WINDOW() && spent < budget; ++k) {
            _at(k);
            uint256 blockNet;
            uint256 roomLeft;
            for (uint256 i; i < wallets && spent < budget; ++i) {
                address w = _wallet(i);
                uint256 net = hook.walletBought(w);
                uint256 room = net >= WALLET_CAP ? 0 : WALLET_CAP - net; // an early buyer can be past its 1%
                roomLeft += room;
                if (BLOCK_CAP - blockNet < room) room = BLOCK_CAP - blockNet;
                if (room < WALLET_CAP / 100) continue;
                uint256 amt = _quoteIn(room) * 9999 / 10_000;
                if (amt > budget - spent) amt = budget - spent;
                Fill memory f = _buyAs(w, amt);
                (spent, got, blockNet) = (spent + f.eth, got + f.dna, blockNet + f.dna);
            }
            if (blockNet != 0) ++blocks;
            if (roomLeft < WALLET_CAP / 100) break; // every wallet is full
        }
        k = k - 1;
    }

    /// ETH an exact-input buy needs to receive `dna` now (v4 Quoter, exact output; the fees included).
    function _quoteIn(uint256 dna) internal returns (uint256 ethIn) {
        (ethIn,) = QUOTER.quoteExactOutputSingle(IV4Quoter.QuoteExactSingleParams(key, true, uint128(dna), ""));
    }

    /// The largest round exact-input that stays under 1% (0.01% margin for the exact-in vs exact-out rounding).
    function _capIn() internal returns (uint256) {
        return _quoteIn(WALLET_CAP) * 9999 / 10_000;
    }

    /// The same under the block's 2%.
    function _blockCapIn() internal returns (uint256) {
        return _quoteIn(BLOCK_CAP) * 9999 / 10_000;
    }

    function _urCall(bool buy, uint256 amountIn) internal view returns (bytes memory) {
        (bytes memory cmd, bytes[] memory inp) = _urInputs(key, buy, amountIn, 1);
        return abi.encodeCall(IUniversalRouter.execute, (cmd, inp, block.timestamp + 300));
    }

    function _calls(uint256 n) internal pure returns (address[] memory, uint256[] memory, bytes[] memory) {
        return (new address[](n), new uint256[](n), new bytes[](n));
    }

    function _buyAs(address who, uint256 ethIn) internal returns (Fill memory f) {
        bool ok;
        bytes memory ret;
        (ok, ret, f) = _tryBuy(who, ethIn);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    /// An exact-input buy sent by EOA `who` (msg.sender and tx.origin); a revert is returned, not raised.
    function _tryBuy(address who, uint256 ethIn) internal returns (bool ok, bytes memory ret, Fill memory f) {
        vm.deal(who, who.balance + ethIn);
        uint256 d0 = IERC20(a.token).balanceOf(who);
        uint256 e0 = who.balance;
        (uint256 b0, uint256 v0) = (pm.balanceOf(a.buybackBurn, 0), pm.balanceOf(a.feeVault, 0));
        vm.recordLogs();
        vm.prank(who, who);
        (ok, ret) = address(UR).call{value: ethIn}(_urCall(true, ethIn));
        if (!ok) return (ok, ret, f);
        (f.eth, f.dna) = (e0 - who.balance, IERC20(a.token).balanceOf(who) - d0);
        assertEq(f.eth, ethIn);
        _fees(f, b0, v0);
    }

    function _sellAs(address who, uint256 dnaIn) internal returns (Fill memory f) {
        vm.startPrank(who, who);
        IERC20(a.token).approve(address(PERMIT2), dnaIn);
        PERMIT2.approve(a.token, address(UR), uint160(dnaIn), uint48(block.timestamp + 3600));
        vm.stopPrank();
        (bytes memory cmd, bytes[] memory inp) = _urInputs(key, false, dnaIn, 1);
        uint256 d0 = IERC20(a.token).balanceOf(who);
        uint256 e0 = who.balance;
        (uint256 b0, uint256 v0) = (pm.balanceOf(a.buybackBurn, 0), pm.balanceOf(a.feeVault, 0));
        vm.recordLogs();
        vm.prank(who, who);
        UR.execute(cmd, inp, block.timestamp + 300);
        (f.eth, f.dna) = (who.balance - e0, d0 - IERC20(a.token).balanceOf(who));
        assertEq(f.dna, dnaIn);
        _fees(f, b0, v0);
    }

    /// The swap's one FeeTaken event + where its project share was minted.
    function _fees(Fill memory f, uint256 b0, uint256 v0) internal view {
        (f.toBurn, f.toVault) = (pm.balanceOf(a.buybackBurn, 0) - b0, pm.balanceOf(a.feeVault, 0) - v0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != a.hook || logs[i].topics[0] != IDNAHook.FeeTaken.selector) continue;
            ++n;
            (,, f.gross, f.project, f.platform, f.pips) =
                abi.decode(logs[i].data, (bool, bool, uint256, uint256, uint256, uint24));
        }
        assertEq(n, 1, "one fee per swap");
        assertEq(f.toBurn + f.toVault, f.project, "project share minted once");
    }

    function _err(bytes4 sel) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            a.hook,
            IHooks.afterSwap.selector,
            abi.encodeWithSelector(sel),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function _reason(bytes memory ret) internal view returns (string memory) {
        if (keccak256(ret) == keccak256(_err(DNAHook.WalletCapExceeded.selector))) return "WalletCapExceeded";
        if (keccak256(ret) == keccak256(_err(DNAHook.LaunchCapExceeded.selector))) return "LaunchCapExceeded";
        return vm.toString(ret);
    }

    function _expectRevertBuy(address who, uint256 ethIn, bytes4 sel) internal {
        (bool ok, bytes memory ret,) = _tryBuy(who, ethIn);
        assertFalse(ok, "should revert");
        assertEq(ret, _err(sel), "revert reason");
    }

    // ---------------- prices (FDV = price x 1B DNA, in ETH x 1e18) and formatting

    function _fdvAt(uint160 sqrtP) internal pure returns (uint256) {
        // ETH per DNA = (Q96 / sqrtP)^2; x 1e9 DNA, scaled 1e18
        return FullMath.mulDiv(FullMath.mulDiv(1e27, FixedPoint96.Q96, sqrtP), FixedPoint96.Q96, sqrtP);
    }

    function _openFdv() internal view returns (uint256) {
        return _fdvAt(TickMath.getSqrtPriceAtTick(openTick));
    }

    function _poolFdv() internal view returns (uint256) {
        (uint160 sqrtP,,,) = pm.getSlot0(key.toId());
        return _fdvAt(sqrtP);
    }

    /// FDV implied by paying `eth` for `dna`.
    function _fdv(uint256 eth, uint256 dna) internal pure returns (uint256) {
        return FullMath.mulDiv(eth, SUPPLY, dna);
    }

    function _fmt(uint256 v, uint256 dec) internal pure returns (string memory s) {
        uint256 u = 10 ** dec;
        s = vm.toString(v % u);
        while (bytes(s).length < dec) {
            s = string.concat("0", s);
        }
        s = string.concat(vm.toString(v / u), ".", s);
    }

    function _pct(uint256 dna) internal pure returns (string memory) {
        return string.concat(_fmt(dna * 10_000 / SUPPLY, 2), "%");
    }

    function _eth(uint256 wei_) internal pure returns (string memory) {
        return _fmt(wei_ / 1e14, 4);
    }

    function _tag() internal pure returns (string memory) {
        return string.concat("[M=", vm.toString(_m()), "]");
    }

    function _log(string memory label, string memory value) internal pure {
        console.log(string.concat(_tag(), " ", label, ": ", value));
    }
}

contract SniperSimM1 is SniperSim {
    function _m() internal pure override returns (uint256) {
        return 1;
    }
}
