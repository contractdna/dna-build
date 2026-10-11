// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IAgentRegistry, IGameFactory, IGameHost, IGameKit} from "./IGames.sol";

/// Deploys Sequencer games (CREATE2) and keeps the list GameFunder trusts (`isGame`). At most MAX_LIVE games are live at
/// once. The agent (the registry's, unpaused, level >= MIN_LEVEL) or the Safe deploys and retires; only the Safe
/// points games at a new GameFunder. A game's runtime code may not contain CREATE, CALLCODE, DELEGATECALL, CREATE2 or
/// SELFDESTRUCT: the scan walks the code skipping PUSH data, so a byte that only looks like one of them inside data the
/// compiler appended (a long string literal, for instance) also refuses the deploy. That is the safe side: never a game
/// that can run one. No owner, no upgrade (contracts/docs/games.md).
contract GameFactory is IGameFactory, IGameHost {
    uint8 public constant MAX_LIVE = 3;
    uint8 public constant MIN_LEVEL = 5;

    address public immutable safe;
    IAgentRegistry public immutable registry;

    address public funder;
    uint8 public liveCount;
    mapping(address game => bool) public isGame;
    mapping(address game => bool) public isLive;

    event GameDeployed(address indexed game, bytes32 salt, bytes32 codehash);
    /// `gameRetired`: whether the game's own retire() went through (its slot is freed either way)
    event GameRetired(address indexed game, bool gameRetired);
    event FunderSet(address funder);

    error BadConfig();
    error NotSafe();
    error Unauthorized();
    error TooManyLive();
    error DeployFailed();
    error BannedOpcode(address game);
    error NotOurGame(address game);
    error NotLive(address game);

    constructor(address safe_, IAgentRegistry registry_) {
        if (safe_ == address(0) || address(registry_) == address(0)) revert BadConfig();
        safe = safe_;
        registry = registry_;
    }

    function deploy(bytes calldata initCode, bytes32 salt) external returns (address game) {
        _auth();
        if (liveCount >= MAX_LIVE) revert TooManyLive();
        bytes memory code = initCode;
        assembly ("memory-safe") {
            game := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (game == address(0) || game.code.length == 0) revert DeployFailed();
        if (banned(game)) revert BannedOpcode(game);
        if (address(IGameKit(game).factory()) != address(this)) revert NotOurGame(game);
        isGame[game] = true;
        isLive[game] = true;
        ++liveCount;
        emit GameDeployed(game, salt, game.codehash);
    }

    function retire(address game) external {
        _auth();
        if (!isLive[game]) revert NotLive(game);
        isLive[game] = false;
        --liveCount;
        // the slot is freed whatever the game does: a game whose retire() reverts can't keep it
        bool ok;
        try IGameKit(game).retire() {
            ok = true;
        } catch {}
        emit GameRetired(game, ok);
    }

    /// A new ladder level: games read the funder live, so existing games can be funded by the new GameFunder.
    function setFunder(address f) external {
        if (msg.sender != safe) revert NotSafe();
        funder = f;
        emit FunderSet(f);
    }

    function predict(bytes32 salt, bytes32 initCodeHash) external view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }

    /// Does `a`'s runtime code contain CREATE (f0), CALLCODE (f2), DELEGATECALL (f4), CREATE2 (f5) or SELFDESTRUCT (ff)
    /// outside PUSH data?
    function banned(address a) public view returns (bool bad) {
        bytes memory code = a.code;
        assembly ("memory-safe") {
            let p := add(code, 0x20)
            let end := add(p, mload(code))
            // bit i set = opcode i banned: f0, f2, f4, f5, ff
            let mask := 0x8035000000000000000000000000000000000000000000000000000000000000
            for {} lt(p, end) {} {
                let op := byte(0, mload(p))
                if and(shr(op, mask), 1) {
                    bad := 1
                    break
                }
                // PUSH1 (0x60) .. PUSH32 (0x7f) carry op - 0x5f data bytes (sub wraps below 0x60: no skip)
                p := add(p, add(1, mul(lt(sub(op, 0x60), 0x20), sub(op, 0x5f))))
            }
        }
    }

    function _auth() internal view {
        if (msg.sender == safe) return;
        if (msg.sender != registry.agent() || registry.agentPaused() || registry.level() < MIN_LEVEL) {
            revert Unauthorized();
        }
    }
}
