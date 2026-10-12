// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GameKit} from "../GameKit.sol";

/// Window raffle (free entry, points only; no ETH is ever credited). Windows of 6 hours. An address enters once per
/// window, at most 256 entrants a window; its weight is 1 + the consecutive windows it entered before, capped at 5.
/// After a window ends, anyone calls draw (records the next block); after that block, anyone calls finalize, which
/// picks up to 5 distinct winners by weight and gives each one point. The seed is the window's entry mix, not a
/// blockhash: the last entrant can predict the outcome. A window finalized more than 256 blocks after its draw is
/// voided (no winners).
contract WindowRaffle is GameKit {
    uint256 public constant WINDOW = 6 hours;
    uint256 public constant MAX_ENTRANTS = 256;
    uint256 public constant MAX_WEIGHT = 5;
    uint256 public constant WINNERS = 5;
    uint256 public constant VOID_BLOCKS = 256;

    struct Player {
        uint64 lastWindow; // last window entered, plus one (0 = never entered)
        uint64 streak; // consecutive windows entered, ending at lastWindow - 1
        uint64 points;
    }

    struct Round {
        uint64 count; // entrants so far
        uint64 drawBlock; // block.number + 1 at draw (0 = not drawn)
        bool finalized;
        uint8 winnerCount;
        uint40 winnerBits; // winners' entrant indices, 8 bits each, first winner lowest
        uint256 mix; // running hash of the entries
    }

    mapping(address player => Player) internal _players;
    mapping(uint256 window => Round) internal _rounds;
    mapping(uint256 window => mapping(uint256 index => address)) internal _entrants;
    mapping(uint256 window => mapping(address player => bool)) internal _entered;
    mapping(uint256 window => mapping(uint256 word => uint256)) internal _weightWords;

    uint256 private _openDraws;

    event Entered(uint256 indexed window, address indexed player, uint256 index, uint256 weight);
    event Drawn(uint256 indexed window, uint256 drawBlock);
    event Finalized(uint256 indexed window, uint256 winners, uint256 winnerBits);
    event Voided(uint256 indexed window);

    error AlreadyEntered();
    error WindowFull();
    error NotEnded();
    error NoEntrants();
    error AlreadyDrawn();
    error NotDrawn();
    error AlreadyFinalized();
    error TooEarly();

    /// The window now (window 0 starts at the epoch).
    function currentWindow() public view returns (uint256) {
        return block.timestamp / WINDOW;
    }

    function windowOf(uint256 timestamp) public pure returns (uint256) {
        return timestamp / WINDOW;
    }

    function pointsOf(address player) external view returns (uint256) {
        return _players[player].points;
    }

    /// The weight a new entry by `player` would get in the window now open to it (the current window, or the next one
    /// once the player entered this window).
    function nextWeight(address player) public view returns (uint256) {
        uint256 w = currentWindow();
        Player storage p = _players[player];
        uint256 target = p.lastWindow == w + 1 ? w + 1 : w;
        uint256 s = p.lastWindow == target ? uint256(p.streak) + 1 : 1;
        return s > MAX_WEIGHT ? MAX_WEIGHT : s;
    }

    /// One free entry per address per window. Weight = min(streak, MAX_WEIGHT), where streak counts the consecutive
    /// windows entered up to this one. The entry is mixed into the window's seed.
    function enter() external whenLive {
        uint256 w = currentWindow();
        if (_entered[w][msg.sender]) revert AlreadyEntered();
        Round storage r = _rounds[w];
        uint256 idx = r.count;
        if (idx >= MAX_ENTRANTS) revert WindowFull();
        Player storage p = _players[msg.sender];
        uint256 s = p.lastWindow == w ? uint256(p.streak) + 1 : 1;
        uint256 weight = s > MAX_WEIGHT ? MAX_WEIGHT : s;
        p.lastWindow = uint64(w + 1);
        p.streak = uint64(s);
        _entered[w][msg.sender] = true;
        _entrants[w][idx] = msg.sender;
        _weightWords[w][idx / 32] |= weight << ((idx % 32) * 8);
        r.count = uint64(idx + 1);
        r.mix = uint256(keccak256(abi.encode(r.mix, msg.sender, block.timestamp)));
        emit Entered(w, msg.sender, idx, weight);
        _played(0);
    }

    /// Anyone, once window w has ended and has entrants; once per window. Records the block finalize waits for.
    function draw(uint256 w) external {
        if (currentWindow() <= w) revert NotEnded();
        Round storage r = _rounds[w];
        if (r.count == 0) revert NoEntrants();
        if (r.drawBlock != 0) revert AlreadyDrawn();
        r.drawBlock = uint64(block.number + 1);
        _openDraws += 1;
        emit Drawn(w, r.drawBlock);
    }

    /// Anyone, once the block after the draw has passed. A window finalized more than VOID_BLOCKS blocks after its draw
    /// is voided: no winners. Otherwise the seed is the entry mix and the draw block, and each winner gets one point.
    function finalize(uint256 w) external {
        Round storage r = _rounds[w];
        if (r.drawBlock == 0) revert NotDrawn();
        if (r.finalized) revert AlreadyFinalized();
        if (block.number <= r.drawBlock) revert TooEarly();
        r.finalized = true;
        _openDraws -= 1;
        if (block.number > uint256(r.drawBlock) + VOID_BLOCKS) {
            emit Voided(w);
            return;
        }
        uint256[8] memory ws;
        for (uint256 j = 0; j < 8; j++) {
            ws[j] = _weightWords[w][j];
        }
        uint256 seed = uint256(keccak256(abi.encode(r.mix, w, uint256(r.drawBlock))));
        (uint256 bits, uint256 n) = pickWinners(ws, seed, r.count);
        r.winnerBits = uint40(bits);
        r.winnerCount = uint8(n);
        for (uint256 k = 0; k < n; k++) {
            _players[_entrants[w][(bits >> (8 * k)) & 0xff]].points += 1;
        }
        emit Finalized(w, n, bits);
    }

    function entrantCount(uint256 w) external view returns (uint256) {
        return _rounds[w].count;
    }

    function entrantAt(uint256 w, uint256 i) external view returns (address) {
        return _entrants[w][i];
    }

    /// Up to n entrants of window w, from index start (fewer at the end of the window).
    function entrantsOf(uint256 w, uint256 start, uint256 n) external view returns (address[] memory list) {
        uint256 total = _rounds[w].count;
        if (start >= total) return list;
        uint256 end = total - start > n ? start + n : total;
        list = new address[](end - start);
        for (uint256 i = start; i < end; i++) {
            list[i - start] = _entrants[w][i];
        }
    }

    function hasEntered(uint256 w, address player) external view returns (bool) {
        return _entered[w][player];
    }

    function weightOf(uint256 w, uint256 i) external view returns (uint256) {
        return (_weightWords[w][i / 32] >> ((i % 32) * 8)) & 0xff;
    }

    function winnersOf(uint256 w) external view returns (address[] memory list) {
        Round storage r = _rounds[w];
        list = new address[](r.winnerCount);
        for (uint256 k = 0; k < r.winnerCount; k++) {
            list[k] = _entrants[w][(uint256(r.winnerBits) >> (8 * k)) & 0xff];
        }
    }

    function drawBlockOf(uint256 w) external view returns (uint256) {
        return _rounds[w].drawBlock;
    }

    function finalizedOf(uint256 w) external view returns (bool) {
        return _rounds[w].finalized;
    }

    /// Weighted draw without replacement over the first n entries: entry i has the weight in byte (i % 32) of word
    /// (i / 32), and every entry below n has a weight of 1 to 5. Makes min(WINNERS, n) picks, each entry picked with
    /// probability proportional to its weight among those not yet picked. Returns the picks packed 8 bits each (the
    /// first pick lowest) and how many were made (fewer only if the weights run out).
    function pickWinners(uint256[8] memory ws, uint256 seed, uint256 n)
        public
        pure
        returns (uint256 bits, uint256 count)
    {
        uint256[8] memory cur;
        uint256[8] memory sums;
        for (uint256 j = 0; j < 8; j++) {
            uint256 lo = j * 32;
            uint256 word = ws[j];
            if (n <= lo) {
                word = 0;
            } else if (n < lo + 32) {
                word &= (uint256(1) << (8 * (n - lo))) - 1;
            }
            cur[j] = word;
            sums[j] = _wordSum(word);
        }
        uint256 want = n < WINNERS ? n : WINNERS;
        for (uint256 k = 0; k < want; k++) {
            uint256 total;
            for (uint256 j = 0; j < 8; j++) {
                total += sums[j];
            }
            if (total == 0) break;
            uint256 rnd = uint256(keccak256(abi.encode(seed, k))) % total;
            uint256 jw;
            while (rnd >= sums[jw]) {
                rnd -= sums[jw];
                jw++;
            }
            uint256 b;
            uint256 wt;
            for (b = 0; b < 32; b++) {
                wt = (cur[jw] >> (8 * b)) & 0xff;
                if (rnd < wt) break;
                rnd -= wt;
            }
            cur[jw] &= ~(uint256(0xff) << (8 * b));
            sums[jw] -= wt;
            bits |= (jw * 32 + b) << (8 * k);
            count = k + 1;
        }
    }

    /// Byte sum of a word of weights 1..5: 256 = 1 mod 255 and the sum is at most 160, so word % 255 equals it.
    function _wordSum(uint256 word) private pure returns (uint256) {
        return word % 255;
    }

    function _roundOpen() internal view override returns (bool) {
        return _openDraws > 0;
    }
}
