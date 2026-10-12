// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";
import {DNAToken} from "../src/DNAToken.sol";
import {GenomeVaults} from "../src/GenomeVaults.sol";
import {GenomeVaultsPlanner} from "../script/GenomeVaultsDeploy.s.sol";

/// Re-enters claim / burn while being paid: the inner call must revert (nonReentrant) so the push fails and the
/// amount is credited for a pull instead.
contract Reenterer {
    GenomeVaults internal v;
    uint256 internal id;
    bool internal viaBurn;
    bool internal armed;
    uint256 public hits;

    constructor(GenomeVaults v_) {
        v = v_;
    }

    function arm(uint256 id_, bool burn_) external {
        id = id_;
        viaBurn = burn_;
        armed = true;
    }

    function disarm() external {
        armed = false;
    }

    function approveAndMint(DNAToken t) external returns (uint256) {
        t.approve(address(v), v.DEPOSIT());
        return v.mint();
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function claim(uint256 i) external {
        v.claim(i);
    }

    function burn(uint256 i) external {
        v.burn(i);
    }

    function withdraw(address payable to) external {
        v.withdraw(to);
    }

    receive() external payable {
        ++hits;
        if (!armed) return;
        if (viaBurn) v.burn(id);
        else v.claim(id);
    }
}

contract Refuser {
    GenomeVaults internal v;

    constructor(GenomeVaults v_) {
        v = v_;
    }

    function approveAndMint(DNAToken t) external returns (uint256) {
        t.approve(address(v), v.DEPOSIT());
        return v.mint();
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function claim(uint256 i) external {
        v.claim(i);
    }

    function burn(uint256 i) external {
        v.burn(i);
    }

    function withdraw(address payable to) external {
        v.withdraw(to);
    }
}

contract NoReceiver {
    GenomeVaults internal v;

    constructor(GenomeVaults v_) {
        v = v_;
    }

    function approveAndMint(DNAToken t) external returns (uint256) {
        t.approve(address(v), v.DEPOSIT());
        return v.mint();
    }
}

contract GenomeVaultsTest is Test {
    DNAToken internal token;
    GenomeVaults internal v;
    address internal safe = makeAddr("safe");
    uint256 internal constant D = 200_000 ether;

    function setUp() public virtual {
        token = new DNAToken(address(this));
        vm.roll(100);
        v = new GenomeVaults(safe, token, "");
        vm.deal(safe, 1000 ether);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /// A contract that can't take an ERC-721 can't mint (its DNA is never pulled: the whole mint reverts).
    function test_mint_refusesAContractThatCannotReceive() public {
        NoReceiver n = new NoReceiver(v);
        token.transfer(address(n), D);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(n)));
        n.approveAndMint(token);
        assertEq(token.balanceOf(address(n)), D);
        assertEq(v.liveCount(), 0);
    }

    function _mintFor(address who) internal returns (uint256 id) {
        token.transfer(who, D);
        vm.startPrank(who);
        token.approve(address(v), D);
        id = v.mint();
        vm.stopPrank();
    }

    /// The Safe funds the window from the last covered block to the current one (one block later each time).
    function _fund(uint256 amount) internal {
        uint64 from = v.fundedThrough();
        vm.roll(block.number + 1);
        vm.prank(safe);
        v.fund{value: amount}(from, uint64(block.number));
    }

    /// The fund that makes every vault minted so far eligible: 1 wei, carried to the next fund.
    function _prime() internal {
        _fund(1);
    }

    // ------------------------------------------------------------------ mint

    function test_mint_locksExactDeposit_lowestSlot_idsIncrease() public {
        address a = makeAddr("a");
        uint256 id = _mintFor(a);
        assertEq(id, 1);
        assertEq(v.ownerOf(1), a);
        assertEq(v.slotOf(1), 1);
        assertEq(v.liveCount(), 1);
        assertEq(token.balanceOf(address(v)), D);
        assertEq(token.balanceOf(a), 0);
        assertEq(_mintFor(makeAddr("b")), 2);
        assertEq(v.slotOf(2), 2);
        assertEq(v.nextId(), 3);
        assertTrue(v.slotTaken(1) && v.slotTaken(2) && !v.slotTaken(3));
        assertEq(v.tokenOfSlot(1), 1);
        assertEq(v.tokenOfSlot(2), 2);
        assertEq(v.tokenOfSlot(3), 0);
    }

    function test_mint_needsTheExactApproval() public {
        address a = makeAddr("a");
        token.transfer(a, D);
        vm.startPrank(a);
        token.approve(address(v), D - 1);
        vm.expectRevert();
        v.mint();
        token.approve(address(v), D);
        v.mint();
        vm.stopPrank();
    }

    function test_full_burnFreesSlot_newTokenTakesIt_idsKeepIncreasing() public {
        for (uint256 i = 1; i <= 50; ++i) {
            _mintFor(makeAddr(string.concat("h", vm.toString(i))));
        }
        assertEq(v.liveCount(), 50);
        address late = makeAddr("late");
        token.transfer(late, D);
        vm.startPrank(late);
        token.approve(address(v), D);
        vm.expectRevert(GenomeVaults.Full.selector);
        v.mint();
        vm.stopPrank();
        // burn slot 17, the next mint takes it with a new id
        address h17 = makeAddr("h17");
        vm.prank(h17);
        v.burn(17);
        assertFalse(v.slotTaken(17));
        assertEq(v.tokenOfSlot(17), 0);
        assertEq(v.liveCount(), 49);
        vm.prank(late);
        uint256 id = v.mint();
        assertEq(id, 51);
        assertEq(v.slotOf(51), 17);
        assertEq(v.tokenOfSlot(17), 51);
        assertEq(v.liveCount(), 50);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 17));
        v.slotOf(17);
    }

    // ------------------------------------------------------------------ fund / accounting

    function test_fund_revertsWithNoLiveVault_orZero_orNotTheSafe() public {
        vm.roll(101);
        vm.prank(safe);
        vm.expectRevert(GenomeVaults.NoLiveVaults.selector);
        v.fund{value: 1 ether}(100, 101);
        _mintFor(makeAddr("a"));
        vm.prank(safe);
        vm.expectRevert(GenomeVaults.ZeroValue.selector);
        v.fund{value: 0}(100, 101);
        address other = makeAddr("other");
        vm.deal(other, 1 ether);
        vm.prank(other);
        vm.expectRevert(GenomeVaults.NotSafe.selector);
        v.fund{value: 1}(100, 101);
        assertEq(v.pendingCount(), 1, "nobody else can promote a pending vault with a tiny fund");
    }

    function test_fund_windowsContinueExactly_staleOrOverlappingBatchReverts() public {
        _mintFor(makeAddr("a"));
        assertEq(v.fundedThrough(), 100, "the deploy block");
        vm.roll(120);
        vm.startPrank(safe);
        vm.expectRevert(abi.encodeWithSelector(GenomeVaults.StaleWindow.selector, uint64(100)));
        v.fund{value: 1}(99, 120);
        vm.expectRevert(GenomeVaults.BadWindow.selector);
        v.fund{value: 1}(100, 100);
        vm.expectRevert(GenomeVaults.BadWindow.selector);
        v.fund{value: 1}(100, 121); // not mined yet
        vm.expectEmit(address(v));
        emit GenomeVaults.Funded(100, 120, 1, 0, 0);
        v.fund{value: 1}(100, 120);
        assertEq(v.fundedThrough(), 120);
        // a second batch prepared from the same state (100 → 120) reverts instead of paying the window twice
        vm.expectRevert(abi.encodeWithSelector(GenomeVaults.StaleWindow.selector, uint64(120)));
        v.fund{value: 1}(100, 120);
        // the next one starts where the last ended, so blocks 101..120 and 121..130 are each covered once
        vm.roll(130);
        v.fund{value: 1}(120, 130);
        assertEq(v.fundedThrough(), 130);
        vm.stopPrank();
    }

    function test_fund_splitsEqually_andCarriesTheRemainder() public {
        _mintFor(makeAddr("a"));
        _mintFor(makeAddr("b"));
        _mintFor(makeAddr("c"));
        _fund(4); // nobody eligible yet: all carried, the three become eligible
        assertEq(v.eligible(), 3);
        assertEq(v.pendingCount(), 0);
        assertEq(v.accPerToken(), 0);
        assertEq(v.carry(), 4);
        assertEq(v.pending(1), 0);
        _fund(6); // 6 + 4 carried = 10 → 3 each, 1 left
        assertEq(v.accPerToken(), 3);
        assertEq(v.carry(), 1);
        assertEq(v.pending(1), 3);
        _fund(2); // 2 + 1 carried = 3 → 1 each, nothing left
        assertEq(v.accPerToken(), 4);
        assertEq(v.carry(), 0);
        assertEq(v.pending(2), 4);
        assertEq(address(v).balance, 12);
        assertEq(v.fundSeq(), 3);
        assertEq(v.accAfter(1), 0);
        assertEq(v.accAfter(2), 3);
        assertEq(v.accAfter(3), 4);
    }

    function test_fund_withNoEligibleVault_carriesEverything_untilOneIs() public {
        _mintFor(makeAddr("a"));
        _fund(1 ether);
        assertEq(v.carry(), 1 ether);
        assertEq(v.accPerToken(), 0);
        assertEq(v.pending(1), 0);
        assertTrue(v.isEligible(1));
        _fund(1 ether);
        assertEq(v.carry(), 0);
        assertEq(v.pending(1), 2 ether);
    }

    function test_mintAfterFund_earnsNothingFromBefore() public {
        _mintFor(makeAddr("a"));
        _prime();
        _fund(1 ether);
        uint256 id = _mintFor(makeAddr("b"));
        assertEq(v.pending(id), 0);
        assertEq(v.earned(id), 0);
        assertEq(v.pending(1), 1 ether + 1);
        _fund(1 ether); // b is only made eligible here: a takes it all
        assertEq(v.pending(id), 0);
        assertEq(v.pending(1), 2 ether + 1);
        _fund(1 ether);
        assertEq(v.pending(id), 0.5 ether);
        assertEq(v.pending(1), 2.5 ether + 1);
    }

    function test_mintJustBeforeFund_earnsNothingFromIt_thenEarns() public {
        _mintFor(makeAddr("a"));
        _prime();
        uint256 id = _mintFor(makeAddr("b")); // in the same block as the fund below
        assertFalse(v.isEligible(id));
        assertEq(v.pendingCount(), 1);
        _fund(1 ether);
        assertEq(v.pending(id), 0, "nothing from the fund right after its mint");
        assertEq(v.pending(1), 1 ether + 1);
        assertTrue(v.isEligible(id));
        assertEq(v.eligible(), 2);
        assertEq(v.pendingCount(), 0);
        _fund(1 ether);
        assertEq(v.pending(id), 0.5 ether);
        assertEq(v.pending(1), 1.5 ether + 1);
        // a claim then another fund: the start is the later of the first eligible fund and the last claim
        vm.prank(makeAddr("b"));
        assertEq(v.claim(id), 0.5 ether);
        _fund(1 ether);
        assertEq(v.pending(id), 0.5 ether);
        assertEq(v.earned(id), 1 ether);
    }

    function test_burnWhilePending_returnsOnlyDNA() public {
        _mintFor(makeAddr("a"));
        _prime();
        _fund(1 ether);
        address b = makeAddr("b");
        uint256 id = _mintFor(b);
        assertEq(v.pendingCount(), 1);
        vm.prank(b);
        v.burn(id);
        assertEq(token.balanceOf(b), D);
        assertEq(b.balance, 0);
        assertEq(v.pendingCount(), 0);
        assertEq(v.eligible(), 1);
        assertEq(v.liveCount(), 1);
        _fund(1 ether);
        assertEq(v.pending(1), 2 ether + 1, "the burned pending vault never took a share");
    }

    function test_slotReuse_withAPendingVault() public {
        _mintFor(makeAddr("a"));
        _prime();
        address b = makeAddr("b");
        uint256 idB = _mintFor(b); // slot 2, pending
        vm.prank(b);
        v.burn(idB);
        uint256 idC = _mintFor(makeAddr("c")); // takes slot 2, pending
        assertEq(v.slotOf(idC), 2);
        assertEq(v.tokenOfSlot(2), idC);
        assertEq(v.pendingCount(), 1);
        _fund(1 ether);
        assertEq(v.pending(idC), 0);
        assertEq(v.pending(1), 1 ether + 1);
        _fund(1 ether);
        assertEq(v.pending(idC), 0.5 ether);
    }

    function test_fund_emitsMetadataUpdate_onlyWhenSomethingWasHandedOut() public {
        _mintFor(makeAddr("a"));
        _mintFor(makeAddr("b"));
        vm.recordLogs();
        _fund(1 ether); // nobody eligible: carried, no art changed
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], GenomeVaults.Funded.selector);
        vm.expectEmit(address(v));
        emit GenomeVaults.Funded(101, 102, 1 ether, 1 ether, 2);
        vm.expectEmit(address(v));
        emit IERC4906.BatchMetadataUpdate(1, 2);
        _fund(1 ether);
    }

    function testFuzz_fund_isExact(uint8 live, uint96 amount, uint96 amount2) public {
        live = uint8(bound(live, 1, 50));
        for (uint256 i; i < live; ++i) {
            _mintFor(makeAddr(string.concat("f", vm.toString(i))));
        }
        vm.assume(amount > 0 && amount2 > 0);
        vm.deal(safe, uint256(amount) + amount2);
        _fund(amount);
        _fund(amount2);
        uint256 sum;
        for (uint256 i = 1; i <= live; ++i) {
            sum += v.pending(i);
        }
        assertEq(sum + v.carry(), uint256(amount) + amount2);
        assertLt(v.carry(), live);
    }

    // ------------------------------------------------------------------ claim / transfer / burn

    function test_claim_paysTheOwner_onlyTheOwner_thenNothing() public {
        address a = makeAddr("a");
        _mintFor(a);
        _prime();
        _fund(1 ether);
        vm.prank(makeAddr("x"));
        vm.expectRevert(GenomeVaults.NotOwner.selector);
        v.claim(1);
        vm.prank(a);
        assertEq(v.claim(1), 1 ether + 1);
        assertEq(a.balance, 1 ether + 1);
        assertEq(v.pending(1), 0);
        assertEq(v.earned(1), 1 ether + 1);
        vm.prank(a);
        assertEq(v.claim(1), 0);
    }

    function test_transfer_keepsThePendingWithTheToken() public {
        address a = makeAddr("a");
        address b = makeAddr("b");
        _mintFor(a);
        _prime();
        _fund(1 ether);
        vm.prank(a);
        v.transferFrom(a, b, 1);
        assertEq(v.pending(1), 1 ether + 1);
        vm.prank(a);
        vm.expectRevert(GenomeVaults.NotOwner.selector);
        v.claim(1);
        vm.prank(b);
        v.claim(1);
        assertEq(b.balance, 1 ether + 1);
        assertEq(a.balance, 0);
    }

    function test_burn_returnsDepositAndPendingEth_onlyTheOwner() public {
        address a = makeAddr("a");
        address op = makeAddr("op");
        _mintFor(a);
        _prime();
        _fund(0.3 ether - 1);
        vm.prank(a);
        v.setApprovalForAll(op, true);
        vm.prank(op);
        vm.expectRevert(GenomeVaults.NotOwner.selector);
        v.burn(1);
        vm.prank(a);
        v.burn(1);
        assertEq(token.balanceOf(a), D);
        assertEq(a.balance, 0.3 ether);
        assertEq(token.balanceOf(address(v)), 0);
        assertEq(address(v).balance, 0);
        assertEq(v.liveCount(), 0);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 1));
        v.ownerOf(1);
    }

    // ------------------------------------------------------------------ reentrancy / refusing receivers

    function test_reentrantClaim_getsNothingExtra_isOwedInstead() public {
        Reenterer r = new Reenterer(v);
        token.transfer(address(r), D);
        uint256 id = r.approveAndMint(token);
        _mintFor(makeAddr("b"));
        _prime();
        _fund(2 ether - 1);
        r.arm(id, false);
        r.claim(id);
        assertEq(address(r).balance, 0, "the push failed because the inner claim reverted");
        assertEq(v.owed(address(r)), 1 ether);
        assertEq(v.pending(id), 0);
        vm.expectRevert(GenomeVaults.TransferFailed.selector);
        r.withdraw(payable(address(r))); // still re-entering on receive: the inner claim reverts, so the push does
        // a receiver that stops re-entering takes what it is owed
        r.disarm();
        r.withdraw(payable(address(r)));
        assertEq(r.hits(), 1);
        assertEq(address(r).balance, 1 ether);
        assertEq(v.owed(address(r)), 0);
        assertEq(v.owedTotal(), 0);
    }

    function test_reentrantBurn_getsNothingExtra() public {
        Reenterer r = new Reenterer(v);
        token.transfer(address(r), D);
        uint256 id = r.approveAndMint(token);
        _mintFor(makeAddr("b"));
        _prime();
        _fund(2 ether - 1);
        r.arm(id, true);
        r.burn(id);
        assertEq(token.balanceOf(address(r)), D, "the DNA came back");
        assertEq(v.owed(address(r)), 1 ether, "the ETH is owed (the inner burn reverted)");
        assertEq(v.liveCount(), 1);
        assertEq(v.eligible(), 1);
        assertEq(address(v).balance, 2 ether);
    }

    function test_refusingReceiver_burnStillGoesThrough_ethOwed() public {
        Refuser r = new Refuser(v);
        token.transfer(address(r), D);
        uint256 id = r.approveAndMint(token);
        _prime();
        _fund(1 ether - 1);
        r.burn(id);
        assertEq(token.balanceOf(address(r)), D);
        assertEq(v.owed(address(r)), 1 ether);
        assertEq(v.owedTotal(), 1 ether);
        vm.expectRevert(GenomeVaults.TransferFailed.selector);
        r.withdraw(payable(address(r))); // it still can't take ETH itself
        address payable eoa = payable(makeAddr("eoa"));
        vm.expectEmit(address(v));
        emit GenomeVaults.Withdrawn(eoa, 1 ether);
        r.withdraw(eoa); // so it names a recipient that can
        assertEq(eoa.balance, 1 ether);
        assertEq(v.owed(address(r)), 0);
        assertEq(v.owedTotal(), 0);
        vm.expectRevert(GenomeVaults.NothingOwed.selector);
        v.withdraw(eoa);
    }

    // ------------------------------------------------------------------ pause

    function test_pause_blocksNewMintsOnly_safeOnly() public {
        address a = makeAddr("a");
        _mintFor(a);
        _prime();
        _fund(1 ether - 1);
        vm.expectRevert(GenomeVaults.NotSafe.selector);
        v.setMintPaused(true);
        vm.prank(safe);
        v.setMintPaused(true);
        token.transfer(makeAddr("b"), D);
        vm.startPrank(makeAddr("b"));
        token.approve(address(v), D);
        vm.expectRevert(GenomeVaults.MintsPaused.selector);
        v.mint();
        vm.stopPrank();
        _fund(1 ether);
        vm.prank(a);
        assertEq(v.claim(1), 2 ether);
        vm.prank(a);
        v.burn(1);
        assertEq(token.balanceOf(a), D);
        vm.prank(safe);
        v.setMintPaused(false);
        _mintFor(makeAddr("b"));
    }

    // ------------------------------------------------------------------ metadata

    function test_tokenURI_svgOnly_withoutArtBase() public {
        _mintFor(makeAddr("a"));
        _prime();
        _fund(0.0123 ether);
        skip(3 days);
        string memory json = string(_b64(_strip(v.tokenURI(1), "data:application/json;base64,")));
        assertTrue(_has(json, '"name":"DNA Genome Vault #1"'));
        assertTrue(_has(json, '"image":"data:image/svg+xml;base64,'));
        assertFalse(_has(json, "animation_url"));
        assertTrue(_has(json, '{"trait_type":"Total ETH earned","value":0.0123}'));
        assertTrue(_has(json, '{"trait_type":"Days held","value":3}'));
        assertTrue(_has(json, '{"trait_type":"Slot","value":1}'));
        bytes memory svg = _b64(_strip(_between(json, '"image":"', '"'), "data:image/svg+xml;base64,"));
        assertTrue(_has(string(svg), "<svg xmlns"));
        assertTrue(_has(string(svg), "SLOT 1</text></svg>"));
    }

    function test_tokenURI_artBase_imageIsTheSlotArt_svgIsTheAnimation() public {
        GenomeVaults w = new GenomeVaults(safe, token, "ipfs://cid/");
        token.approve(address(w), D);
        uint256 id = w.mint();
        string memory json = string(_b64(_strip(w.tokenURI(id), "data:application/json;base64,")));
        assertTrue(_has(json, '"image":"ipfs://cid/1.jpg"'));
        assertTrue(_has(json, '"animation_url":"data:image/svg+xml;base64,'));
        string memory c = string(_b64(_strip(w.contractURI(), "data:application/json;base64,")));
        assertTrue(_has(c, '"name":"DNA Genome Vaults"'));
        assertTrue(_has(c, '"image":"ipfs://cid/collection.jpg"'));
        assertTrue(_has(c, '"banner_image":"ipfs://cid/banner.jpg"'));
        assertTrue(_has(c, "split equally across eligible vaults. Nothing is promised."));
        assertFalse(_has(c, "treasury"));
        assertTrue(_has(c, '"external_link":"https://genomedna.xyz/vaults"'));
        assertEq(w.artBase(), "ipfs://cid/");
    }

    function test_contractURI_withoutArt_hasAnOnChainImage() public view {
        string memory c = string(_b64(_strip(v.contractURI(), "data:application/json;base64,")));
        assertTrue(_has(c, '"image":"data:image/svg+xml;base64,'));
        assertFalse(_has(c, "banner_image"));
    }

    function test_tokenURI_gasStaysSane_atFullStrand() public {
        _mintFor(makeAddr("a"));
        _prime();
        _fund(10 ether); // 48 rungs (the cap)
        skip(400 days);
        uint256 g = gasleft();
        v.tokenURI(1);
        assertLt(g - gasleft(), 1_500_000);
    }

    function test_royalty_andInterfaces() public view {
        (address to, uint256 amount) = v.royaltyInfo(1, 1 ether);
        assertEq(to, safe);
        assertEq(amount, 0.025 ether);
        assertTrue(v.supportsInterface(0x80ac58cd), "ERC721");
        assertTrue(v.supportsInterface(0x5b5e139f), "ERC721Metadata");
        assertTrue(v.supportsInterface(0x2a55205a), "ERC2981");
        assertTrue(v.supportsInterface(0x49064906), "ERC4906");
        assertTrue(v.supportsInterface(0x01ffc9a7), "ERC165");
        assertFalse(v.supportsInterface(0xffffffff));
    }

    function test_noAdminSurface() public {
        bytes4[6] memory forbidden = [
            bytes4(keccak256("owner()")),
            bytes4(keccak256("mint(address,uint256)")),
            bytes4(keccak256("mintTo(address)")),
            bytes4(keccak256("upgradeTo(address)")),
            bytes4(keccak256("sweep()")),
            bytes4(keccak256("setArtBase(string)"))
        ];
        for (uint256 i; i < forbidden.length; ++i) {
            (bool ok,) = address(v).call(abi.encodeWithSelector(forbidden[i], address(this), 1));
            assertFalse(ok);
        }
        (bool sent,) = address(v).call{value: 1}("");
        assertFalse(sent, "no receive / fallback");
    }

    function test_constructor_refusesBadConfig() public {
        vm.expectRevert(GenomeVaults.BadConfig.selector);
        new GenomeVaults(address(0), token, "");
        vm.expectRevert(GenomeVaults.BadConfig.selector);
        new GenomeVaults(safe, DNAToken(makeAddr("nocode")), "");
    }

    // ------------------------------------------------------------------ the deploy plan

    /// Arachnid's deterministic deployer (mainnet 0x4e59…956c), its runtime code as read from the chain.
    bytes internal constant DEPLOYER_CODE =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    function test_plan_predictsTheCreate2Address_andTheCodehash() public {
        GenomeVaultsPlanner p = new GenomeVaultsPlanner();
        bytes32 salt = keccak256("genome");
        bytes memory init = p.initCode(safe, address(token), "ipfs://cid/");
        address predicted = p.predict(salt, init);
        vm.etch(p.CREATE2_DEPLOYER(), DEPLOYER_CODE);
        vm.prank(safe);
        (bool ok, bytes memory ret) = p.CREATE2_DEPLOYER().call(bytes.concat(salt, init));
        assertTrue(ok);
        assertEq(address(uint160(bytes20(ret))), predicted);
        assertGt(predicted.code.length, 0);
        GenomeVaults g = GenomeVaults(predicted);
        assertEq(g.safe(), safe);
        assertEq(address(g.dna()), address(token));
        assertEq(g.artBase(), "ipfs://cid/");
        assertEq(g.fundedThrough(), uint64(block.number), "the first window starts at the deploy block");
        assertEq(predicted.codehash, p.codehash(safe, address(token), "ipfs://cid/"));
        GenomeVaultsPlanner.Plan memory plan = p.plan(safe, address(token), "ipfs://cid/", salt);
        assertEq(plan.vaults, predicted);
        assertEq(plan.txs.length, 1);
        assertEq(plan.txs[0].to, p.CREATE2_DEPLOYER());
        assertEq(plan.txs[0].data, bytes.concat(salt, init));
        string memory json = p.batchJson(plan, safe, 1_700_000_000_000);
        assertTrue(_has(json, '"createdFromSafeAddress":"'));
        assertTrue(_has(json, '"checksum":"0x'));
    }

    /// The same vector engine/test/vault-fund.test.ts pins: both batch writers must agree on the checksum.
    function test_plan_batchJson_checksumVector() public {
        GenomeVaultsPlanner p = new GenomeVaultsPlanner();
        GenomeVaultsPlanner.Plan memory plan;
        plan.vaults = 0x1111111111111111111111111111111111111111;
        plan.txs = new GenomeVaultsPlanner.Tx[](1);
        plan.txs[0] = GenomeVaultsPlanner.Tx(plan.vaults, 1 ether, hex"b60d4288", "fund");
        string memory json = p.batchJson(plan, 0xDA1Af681CF1F924eE24447DB0352dbD59b6C0F73, 1_700_000_000_000);
        assertTrue(_has(json, '"checksum":"0x449db9f6690581b050e003f0d8b5757654ed9cfa2b9a9158f2cca486afce3117"'));
        assertTrue(_has(json, '"transactions":[{"to":"0x1111111111111111111111111111111111111111","value":"1000000000000000000","data":"0xb60d4288"}]'));
    }

    // ------------------------------------------------------------------ helpers

    function _has(string memory s, string memory needle) internal pure returns (bool) {
        return vm.indexOf(s, needle) != type(uint256).max;
    }

    function _strip(string memory s, string memory prefix) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 n = bytes(prefix).length;
        require(vm.indexOf(s, prefix) == 0, "prefix");
        bytes memory out = new bytes(b.length - n);
        for (uint256 i; i < out.length; ++i) {
            out[i] = b[i + n];
        }
        return string(out);
    }

    function _between(string memory s, string memory from, string memory to) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 a = vm.indexOf(s, from) + bytes(from).length;
        uint256 e = a;
        while (e < b.length && b[e] != bytes(to)[0]) ++e;
        bytes memory out = new bytes(e - a);
        for (uint256 i; i < out.length; ++i) {
            out[i] = b[a + i];
        }
        return string(out);
    }

    function _b64(string memory s) internal pure returns (bytes memory out) {
        bytes memory b = bytes(s);
        uint256 len = b.length;
        while (len > 0 && b[len - 1] == "=") --len;
        out = new bytes((len * 6) / 8);
        uint256 bits;
        uint256 n;
        uint256 j;
        for (uint256 i; i < len; ++i) {
            bits = (bits << 6) | _val(b[i]);
            n += 6;
            if (n >= 8) {
                n -= 8;
                out[j++] = bytes1(uint8(bits >> n));
                bits &= (1 << n) - 1;
            }
        }
    }

    function _val(bytes1 c) internal pure returns (uint256) {
        if (c >= "A" && c <= "Z") return uint8(c) - 65;
        if (c >= "a" && c <= "z") return uint8(c) - 97 + 26;
        if (c >= "0" && c <= "9") return uint8(c) - 48 + 52;
        if (c == "+") return 62;
        if (c == "/") return 63;
        revert("b64");
    }
}

/// Random mints, burns, funds, claims and transfers: the books always balance.
contract VaultsHandler is Test {
    GenomeVaults public v;
    DNAToken public token;
    address[] public actors;
    uint256[] public live;
    uint256 public fundedTotal;
    uint256 public paidOut;

    constructor(GenomeVaults v_, DNAToken t_) {
        v = v_;
        token = t_;
        for (uint256 i; i < 8; ++i) {
            actors.push(makeAddr(string.concat("actor", vm.toString(i))));
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function mint(uint256 who) external {
        address a = actors[who % actors.length];
        if (v.liveCount() >= v.MAX_LIVE() || token.balanceOf(a) < v.DEPOSIT()) return;
        vm.startPrank(a);
        token.approve(address(v), v.DEPOSIT());
        uint256 id = v.mint();
        vm.stopPrank();
        live.push(id);
    }

    function burn(uint256 k) external {
        if (live.length == 0) return;
        uint256 i = k % live.length;
        uint256 id = live[i];
        address o = v.ownerOf(id);
        uint256 before = o.balance;
        vm.prank(o);
        v.burn(id);
        paidOut += o.balance - before;
        live[i] = live[live.length - 1];
        live.pop();
    }

    function fund(uint96 amount) external {
        if (v.liveCount() == 0 || amount == 0) return;
        uint64 from = v.fundedThrough();
        vm.roll(block.number + 1);
        vm.deal(v.safe(), amount);
        vm.prank(v.safe());
        v.fund{value: amount}(from, uint64(block.number));
        fundedTotal += amount;
    }

    function claim(uint256 k) external {
        if (live.length == 0) return;
        uint256 id = live[k % live.length];
        address o = v.ownerOf(id);
        uint256 before = o.balance;
        vm.prank(o);
        v.claim(id);
        paidOut += o.balance - before;
    }

    function transfer(uint256 k, uint256 who) external {
        if (live.length == 0) return;
        uint256 id = live[k % live.length];
        address o = v.ownerOf(id);
        vm.prank(o);
        v.transferFrom(o, actors[who % actors.length], id);
    }

    function liveIds() external view returns (uint256[] memory) {
        return live;
    }
}

contract GenomeVaultsInvariantTest is Test {
    DNAToken internal token;
    GenomeVaults internal v;
    VaultsHandler internal h;

    function setUp() public {
        token = new DNAToken(address(this));
        v = new GenomeVaults(makeAddr("safe"), token, "");
        h = new VaultsHandler(v, token);
        for (uint256 i; i < h.actorCount(); ++i) {
            token.transfer(h.actors(i), 10 * v.DEPOSIT());
        }
        targetContract(address(h));
    }

    function invariant_booksBalance() public view {
        uint256[] memory ids = h.liveIds();
        uint256 sum;
        uint256 bits;
        for (uint256 i; i < ids.length; ++i) {
            sum += v.pending(ids[i]);
            uint256 bit = uint256(1) << (v.slotOf(ids[i]) - 1);
            assertEq(bits & bit, 0, "slots are distinct");
            assertEq(v.tokenOfSlot(v.slotOf(ids[i])), ids[i], "slot points back at its token");
            bits |= bit;
        }
        assertEq(ids.length, v.liveCount());
        assertEq(v.eligible() + v.pendingCount(), v.liveCount(), "every live vault is eligible or pending");
        assertLe(v.liveCount(), 50);
        assertEq(token.balanceOf(address(v)), v.liveCount() * v.DEPOSIT(), "DNA held = 200k x live");
        assertGe(address(v).balance, sum + v.carry() + v.owedTotal(), "balance covers every pending wei");
        assertEq(address(v).balance + h.paidOut(), h.fundedTotal(), "every funded wei is held or paid");
    }
}
