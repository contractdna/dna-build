// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title DNA Genome Vaults
/// @notice At most MAX_LIVE vaults live at once. Minting locks exactly DEPOSIT DNA in this contract; burning returns
///         it to the vault's owner with the vault's unclaimed ETH. ETH sent through `fund()` is shared equally per
///         eligible vault (a Synthetix-style accumulator). A vault becomes eligible at the first fund after its mint
///         and earns from the next one on, so minting just before a fund earns nothing from it. Rewards belong to the
///         vault, so a buyer gets what is unclaimed. Only the Safe funds, over a block window that continues exactly
///         where the last one ended (`fundedThrough`), so a stale or duplicate batch reverts and no window is skipped.
///         Each vault holds a slot number (1..MAX_LIVE) for its lifetime; a burned slot goes to the next mint.
///         No owner mint, no upgrade, no way for anyone to take deposited DNA except the vault's owner by burning.
///         The Safe can pause new mints only; it can never block burns or claims.
/// @dev DNA is OZ ERC20 (reverts on failure, no fee-on-transfer, no hooks): exact amounts in and out.
///      ETH is pushed to the owner; a receiver that refuses it is credited for a pull (`owed`, `withdraw`), so a burn
///      never reverts on the ETH leg.
contract GenomeVaults is ERC721, ERC2981, ReentrancyGuard, IERC4906 {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_LIVE = 50;
    uint256 public constant DEPOSIT = 200_000 ether;
    uint96 public constant ROYALTY_BPS = 250;

    IERC20 public immutable dna;
    address public immutable safe;
    /// @dev Art base: `<base><slot>.png` per slot, `<base>collection.png`, `<base>banner.png`. Empty: SVG only.
    string internal _artBase;

    uint256 public nextId = 1;
    uint256 public liveCount;
    bool public mintPaused;
    /// @notice ETH per eligible vault accumulated over every fund so far (wei).
    uint256 public accPerToken;
    /// @notice What the last fund could not hand out (its rounding remainder, or all of it while no vault was
    ///         eligible), added to the next one.
    uint256 public carry;
    /// @notice Funds so far; `accAfter[n]` is accPerToken right after fund n.
    uint256 public fundSeq;
    mapping(uint256 seq => uint256) public accAfter;
    /// @notice Live vaults that earn: those minted before the last fund.
    uint256 public eligible;
    /// @notice Live vaults minted since the last fund: they join `eligible` at the next one, earning nothing from it.
    uint256 public pendingCount;
    /// @notice The last block a fund covered (the deploy block at first): the next fund starts right after it.
    uint64 public fundedThrough;
    /// @dev Bit s−1 set: slot s is taken.
    uint256 internal _slotBits;
    /// @notice The live token in slot s (1..MAX_LIVE), 0 when the slot is free.
    mapping(uint8 slot => uint256) public tokenOfSlot;
    /// @notice ETH a receiver refused at push, claimable with `withdraw`.
    mapping(address => uint256) public owed;
    uint256 public owedTotal;

    struct Vault {
        uint8 slot;
        uint64 mintedAt;
        uint128 claimed; // ETH paid out so far (fits: all the ETH there is is under 2^128 wei)
        uint256 mintSeq; // fundSeq at mint: eligible once fund mintSeq + 1 happened, earning from the one after
        uint256 debt; // accPerToken at the last claim (0 before: the start is accAfter[mintSeq + 1])
    }

    mapping(uint256 id => Vault) internal _vaults;

    event Minted(uint256 indexed id, address indexed owner, uint8 slot);
    event Burned(uint256 indexed id, address indexed owner, uint256 eth);
    event Funded(uint64 fromBlock, uint64 toBlock, uint256 amount, uint256 perToken, uint256 eligible);
    event Claimed(uint256 indexed id, address indexed to, uint256 amount);
    event Owed(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event MintPausedSet(bool on);

    error BadConfig();
    error NotSafe();
    error NotOwner();
    error MintsPaused();
    error Full();
    error NoLiveVaults();
    error ZeroValue();
    error NothingOwed();
    error TransferFailed();
    error StaleWindow(uint64 fundedThrough);
    error BadWindow();

    constructor(address safe_, IERC20 dna_, string memory artBase_) ERC721("DNA Genome Vaults", "GENOME") {
        if (safe_ == address(0) || address(dna_).code.length == 0) revert BadConfig();
        safe = safe_;
        dna = dna_;
        _artBase = artBase_;
        fundedThrough = uint64(block.number);
        _setDefaultRoyalty(safe_, ROYALTY_BPS);
    }

    // ------------------------------------------------------------------ holders

    /// @notice Lock DEPOSIT DNA (approve it first) and take the lowest free slot. First come, first served.
    function mint() external nonReentrant returns (uint256 id) {
        if (mintPaused) revert MintsPaused();
        if (liveCount >= MAX_LIVE) revert Full();
        uint8 slot = _takeSlot();
        id = nextId++;
        ++liveCount;
        ++pendingCount;
        _vaults[id] = Vault({slot: slot, mintedAt: uint64(block.timestamp), claimed: 0, mintSeq: fundSeq, debt: 0});
        tokenOfSlot[slot] = id;
        emit Minted(id, msg.sender, slot);
        dna.safeTransferFrom(msg.sender, address(this), DEPOSIT);
        // last: a contract minter's onERC721Received runs with every effect in place, and mint is nonReentrant
        _safeMint(msg.sender, id);
    }

    /// @notice The owner burns the vault: DEPOSIT DNA and the vault's unclaimed ETH come back in the same transaction.
    function burn(uint256 id) external nonReentrant {
        if (ownerOf(id) != msg.sender) revert NotOwner();
        Vault memory v = _vaults[id];
        uint256 eth = _pending(v);
        if (fundSeq > v.mintSeq) --eligible;
        else --pendingCount;
        delete _vaults[id];
        delete tokenOfSlot[v.slot];
        _slotBits &= ~(uint256(1) << (v.slot - 1));
        --liveCount;
        _burn(id);
        emit Burned(id, msg.sender, eth);
        dna.safeTransfer(msg.sender, DEPOSIT);
        _pay(msg.sender, eth);
    }

    /// @notice The owner takes the vault's pending ETH.
    function claim(uint256 id) external nonReentrant returns (uint256 amount) {
        if (ownerOf(id) != msg.sender) revert NotOwner();
        Vault storage v = _vaults[id];
        amount = _pending(v);
        v.debt = accPerToken;
        v.claimed += uint128(amount);
        emit Claimed(id, msg.sender, amount);
        _pay(msg.sender, amount);
    }

    /// @notice ETH a receiver refused at push, sent to `to` (so an owner that can't take ETH itself names one that can).
    function withdraw(address payable to) external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        owedTotal -= amount;
        emit Withdrawn(to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ------------------------------------------------------------------ funding

    /// @notice The Safe shares `msg.value` (plus what the last fund carried) equally among the eligible vaults, then
    ///         makes the vaults minted since the last fund eligible for the next one. `[fromBlock, toBlock]` is the
    ///         window of fee inflows this fund covers: it must start exactly where the last one ended, so a batch
    ///         prepared before another ran reverts instead of paying twice, and nothing between two funds is skipped.
    ///         With no eligible vault yet everything is carried to the next fund; with no live vault at all it reverts,
    ///         so no ETH is ever stranded.
    function fund(uint64 fromBlock, uint64 toBlock) external payable {
        if (msg.sender != safe) revert NotSafe();
        if (msg.value == 0) revert ZeroValue();
        if (fromBlock != fundedThrough) revert StaleWindow(fundedThrough);
        if (toBlock <= fromBlock || toBlock > block.number) revert BadWindow();
        if (liveCount == 0) revert NoLiveVaults();
        fundedThrough = toBlock;
        uint256 n = eligible;
        uint256 total = msg.value + carry;
        uint256 per = n == 0 ? 0 : total / n;
        carry = total - per * n;
        accPerToken += per;
        accAfter[++fundSeq] = accPerToken;
        eligible = n + pendingCount;
        pendingCount = 0;
        emit Funded(fromBlock, toBlock, msg.value, per, n);
        // the art of every vault grows with what it earned (ERC-4906): burned ids in the range are ignored by indexers
        if (per > 0) emit BatchMetadataUpdate(1, nextId - 1);
    }

    // ------------------------------------------------------------------ safe

    /// @notice New mints only. Burns, claims and funding are never pausable.
    function setMintPaused(bool on) external {
        if (msg.sender != safe) revert NotSafe();
        mintPaused = on;
        emit MintPausedSet(on);
    }

    // ------------------------------------------------------------------ views

    function pending(uint256 id) public view returns (uint256) {
        _requireOwned(id);
        return _pending(_vaults[id]);
    }

    /// @notice ETH this vault earned in total: paid out plus pending.
    function earned(uint256 id) public view returns (uint256) {
        _requireOwned(id);
        Vault storage v = _vaults[id];
        return uint256(v.claimed) + _pending(v);
    }

    /// @notice Does this vault earn from the next fund (minted before the last one)?
    function isEligible(uint256 id) public view returns (bool) {
        _requireOwned(id);
        return fundSeq > _vaults[id].mintSeq;
    }

    function slotOf(uint256 id) public view returns (uint8) {
        _requireOwned(id);
        return _vaults[id].slot;
    }

    function mintedAt(uint256 id) public view returns (uint64) {
        _requireOwned(id);
        return _vaults[id].mintedAt;
    }

    /// @notice Is slot `s` (1..MAX_LIVE) taken?
    function slotTaken(uint8 s) public view returns (bool) {
        return s >= 1 && s <= MAX_LIVE && _slotBits & (uint256(1) << (s - 1)) != 0;
    }

    function artBase() external view returns (string memory) {
        return _artBase;
    }

    /// @notice Collection metadata (OpenSea reads it on its own).
    function contractURI() external view returns (string memory) {
        bool art = bytes(_artBase).length != 0;
        string memory json = string.concat(
            '{"name":"DNA Genome Vaults","description":"Fifty vaults. Each one locks 200,000 DNA and can be burned by its owner at any time to get the DNA back. Vaults share whatever ETH the Safe sends to fund(), split equally across eligible vaults. Nothing is promised.",',
            '"external_link":"https://genomedna.xyz/vaults",',
            '"image":"',
            art ? string.concat(_artBase, "collection.jpg") : _svgUri(_logo()),
            '"',
            art ? string.concat(',"banner_image":"', _artBase, 'banner.jpg"') : "",
            "}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @notice On-chain metadata: the slot's art as `image` (the living SVG as `animation_url`), or the SVG alone as
    ///         `image` when no art base is set.
    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        Vault storage v = _vaults[id];
        uint256 total = uint256(v.claimed) + _pending(v);
        uint256 days_ = (block.timestamp - v.mintedAt) / 1 days;
        string memory svg = _svgUri(_strand(total, days_, v.slot));
        bool art = bytes(_artBase).length != 0;
        string memory json = string.concat(
            '{"name":"DNA Genome Vault #',
            Strings.toString(id),
            '","description":"Slot ',
            Strings.toString(v.slot),
            " of 50. Holds 200,000 DNA; its owner can burn it at any time for the DNA and the ETH it has not claimed.",
            '","image":"',
            art ? string.concat(_artBase, Strings.toString(v.slot), ".jpg") : svg,
            '"',
            art ? string.concat(',"animation_url":"', svg, '"') : "",
            ',"attributes":[{"trait_type":"Total ETH earned","value":',
            _eth(total),
            '},{"trait_type":"Days held","value":',
            Strings.toString(days_),
            '},{"trait_type":"Slot","value":',
            Strings.toString(v.slot),
            "}]}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function supportsInterface(bytes4 i) public view override(ERC721, ERC2981, IERC165) returns (bool) {
        return i == bytes4(0x49064906) || ERC721.supportsInterface(i) || ERC2981.supportsInterface(i);
    }

    // ------------------------------------------------------------------ internal

    function _takeSlot() internal returns (uint8 slot) {
        uint256 bits = _slotBits;
        for (uint256 i; i < MAX_LIVE; ++i) {
            if (bits & (uint256(1) << i) == 0) {
                _slotBits = bits | (uint256(1) << i);
                return uint8(i + 1);
            }
        }
        revert Full(); // unreachable: liveCount < MAX_LIVE means a bit is free
    }

    /// @dev Unclaimed ETH: from the first fund after the vault's mint (`accAfter[mintSeq + 1]`) or its last claim,
    ///      whichever is later; nothing until that fund happened.
    function _pending(Vault memory v) internal view returns (uint256) {
        if (fundSeq <= v.mintSeq) return 0;
        uint256 start = accAfter[v.mintSeq + 1];
        return accPerToken - (v.debt > start ? v.debt : start);
    }

    /// @dev Push; a receiver that refuses is credited for a pull instead. Called last (CEI).
    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) {
            owed[to] += amount;
            owedTotal += amount;
            emit Owed(to, amount);
        }
    }

    /// @dev Wei → "1.2345" (4 decimals, truncated), a JSON number.
    function _eth(uint256 wei_) internal pure returns (string memory) {
        uint256 frac = (wei_ % 1 ether) / 1e14;
        bytes memory f = bytes(Strings.toString(frac + 10_000)); // "1xxxx": fixed width, drop the lead
        return string.concat(Strings.toString(wei_ / 1 ether), ".", string(abi.encodePacked(f[1], f[2], f[3], f[4])));
    }

    function _svgUri(string memory svg) internal pure returns (string memory) {
        return string.concat("data:image/svg+xml;base64,", Base64.encode(bytes(svg)));
    }

    /// @dev The living strand: one rung per 0.002 ETH earned (6 to start, 48 at most), its hue turning with age.
    function _strand(uint256 total, uint256 days_, uint8 slot) internal pure returns (string memory) {
        uint256 rungs = 6 + total / 0.002 ether;
        if (rungs > 48) rungs = 48;
        uint256 hue = (150 + days_ * 4) % 360;
        // a sine table in hundredths over 12 steps: the strands cross every 6 rungs
        int16[12] memory sine = [int16(0), 50, 87, 100, 87, 50, 0, -50, -87, -100, -87, -50];
        string memory body;
        for (uint256 i; i < rungs; ++i) {
            int256 s = sine[i % 12];
            uint256 y = 48 + (i * 304) / 48;
            uint256 x1 = uint256(int256(200) - s);
            uint256 x2 = uint256(int256(200) + s);
            body = string.concat(
                body,
                '<line x1="', Strings.toString(x1), '" y1="', Strings.toString(y), '" x2="', Strings.toString(x2),
                '" y2="', Strings.toString(y), '"/><circle cx="', Strings.toString(x1), '" cy="', Strings.toString(y),
                '" r="4"/><circle cx="', Strings.toString(x2), '" cy="', Strings.toString(y), '" r="4"/>'
            );
        }
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#0b0d12"/>',
            '<g stroke="hsl(', Strings.toString(hue), ',70%,60%)" stroke-width="2" fill="hsl(', Strings.toString(hue), ',70%,60%)">',
            body,
            '</g><text x="20" y="384" font-family="monospace" font-size="14" fill="#9aa3b2">DNA GENOME VAULT - SLOT ',
            Strings.toString(slot),
            "</text></svg>"
        );
    }

    function _logo() internal pure returns (string memory) {
        return
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#0b0d12"/><text x="200" y="215" text-anchor="middle" font-family="monospace" font-size="36" fill="#9aa3b2">DNA GENOME VAULTS</text></svg>';
    }
}
