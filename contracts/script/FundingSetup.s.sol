// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {CommonBase} from "forge-std/Base.sol";
import {GameFunder, IGameFactory} from "../src/games/GameFunder.sol";
import {GameFactory} from "../src/games/GameFactory.sol";
import {IAgentRegistry} from "../src/games/IGames.sol";

/// Zodiac Roles v2.1.1 `ConditionFlat` (contracts/Types.sol); the enums are plain uint8 on the wire.
struct ConditionFlat {
    uint8 parent;
    uint8 paramType;
    uint8 operator;
    bytes compValue;
}

interface IModuleProxyFactory {
    function deployModule(address masterCopy, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

/// The Zodiac module surface both modifiers share (zodiac core Modifier).
interface IZodiacModifier {
    function enableModule(address module) external;
    function isModuleEnabled(address module) external view returns (bool);
    function owner() external view returns (address);
    function avatar() external view returns (address);
    function target() external view returns (address);
    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory array, address next);
    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool);
}

interface IRoles is IZodiacModifier {
    function assignRoles(address module, bytes32[] calldata roleKeys, bool[] calldata memberOf) external;
    function scopeTarget(bytes32 roleKey, address targetAddress) external;
    function revokeTarget(bytes32 roleKey, address targetAddress) external;
    function scopeFunction(
        bytes32 roleKey,
        address targetAddress,
        bytes4 selector,
        ConditionFlat[] memory conditions,
        uint8 options
    ) external;
    function execTransactionWithRole(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        bytes32 roleKey,
        bool shouldRevert
    ) external returns (bool);
}

interface IDelay is IZodiacModifier {
    function txCooldown() external view returns (uint256);
    function txExpiration() external view returns (uint256);
    function txNonce() external view returns (uint256);
    function queueNonce() external view returns (uint256);
    function setTxNonce(uint256 nonce) external;
    function executeNextTx(address to, uint256 value, bytes calldata data, uint8 operation) external;
    function skipExpired() external;
}

/// Builds the Safe transaction batch that wires the agent's funding path:
/// agent → Roles v2 (only GameFunder.fund, amount ≤ perGameCap, no ETH, no delegatecall) → Delay (1 h cooldown,
/// 24 h expiry, Safe veto) → Safe. Shared by the printing script and the fork test, which applies the same batch.
contract FundingPlanner is CommonBase {
    // Zodiac (gnosisguild/zodiac src/contracts.ts @ 89352c4f; codehashes read on mainnet, contracts/docs/funding.md)
    address internal constant MODULE_FACTORY = 0x000000000000aDdB49795b0f9bA5BC298cDda236; // 1.2.0
    address internal constant DELAY_MASTERCOPY = 0x824175b945838d127C1ca83CbcE11D8e44F6dF01; // 1.1.1
    address internal constant ROLES_MASTERCOPY = 0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5; // 2.1.1
    bytes32 internal constant MODULE_FACTORY_CODEHASH =
        0x01623cbcf010a1c326230f1b2d5f48a66b440232ee49096102bc84967dc5f21e;
    bytes32 internal constant DELAY_CODEHASH = 0xdd928eddfff7b68bd8fff28178c29e3388c1d098051d9262f151c4b534c577b8;
    bytes32 internal constant ROLES_CODEHASH = 0x471d8b3b419f1eb955230c0326c8812176df49bf3c7b414a563fda5a3c6c10b6;
    // Arachnid's deterministic deployment proxy: calldata = salt ‖ initcode, CREATE2 from this address
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant CREATE2_DEPLOYER_CODEHASH =
        0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989;

    uint256 internal constant COOLDOWN = 1 hours;
    uint256 internal constant EXPIRATION = 24 hours;
    bytes32 internal constant ROLE_KEY = "dna-game-funder";

    // Roles v2 enums (Types.sol)
    uint8 internal constant PARAM_STATIC = 1;
    uint8 internal constant PARAM_CALLDATA = 5;
    uint8 internal constant OP_PASS = 0;
    uint8 internal constant OP_MATCHES = 5;
    uint8 internal constant OP_LESS_THAN = 18;
    uint8 internal constant EXEC_NONE = 0; // no ETH, no delegatecall

    struct Config {
        address safe;
        address agent;
        address gameFactory; // 0: the batch deploys a GameFactory (CREATE2) for `registry`
        address registry; // the ModuleRegistry whose agent may deploy games (only used when gameFactory is 0)
        uint256 weeklyBudget;
        uint256 perGameCap;
        uint256 saltNonce;
        uint256 topUp; // optional ETH from the Safe to GameFunder in the same batch (0 = none)
    }

    struct Tx {
        address to;
        uint256 value;
        bytes data;
        string label;
    }

    struct Plan {
        address delay;
        address roles;
        address funder;
        address gameFactory;
        Tx[] txs;
    }

    /// The batch, in order. Enabling Delay on the Safe comes last: until then nothing can reach the Safe.
    function plan(Config memory c) public pure returns (Plan memory p) {
        require(
            c.safe != address(0) && c.agent != address(0) && (c.gameFactory != address(0) || c.registry != address(0)),
            "funding: zero address"
        );
        // GameFunder's constructor checks: a bad ladder must fail here, not after the signatures
        require(
            c.perGameCap != 0 && c.perGameCap <= c.weeklyBudget && c.weeklyBudget <= type(uint192).max,
            "funding: bad ladder"
        );
        bytes memory factoryInit;
        if (c.gameFactory == address(0)) {
            factoryInit =
                abi.encodePacked(type(GameFactory).creationCode, abi.encode(c.safe, IAgentRegistry(c.registry)));
            c.gameFactory = create2Address(bytes32(c.saltNonce), factoryInit);
        }
        p.gameFactory = c.gameFactory;
        // GameFactory first when the batch deploys it (GameFunder takes its address), then the funding path, then the
        // factory pointed at this GameFunder (games read it live), Delay enabled last
        Tx[] memory core = _core(c, p);
        uint256 k = factoryInit.length == 0 ? 0 : 1;
        p.txs = new Tx[](k + core.length + (c.topUp == 0 ? 0 : 1));
        if (k == 1) {
            p.txs[0] = Tx(
                CREATE2_DEPLOYER,
                0,
                abi.encodePacked(bytes32(c.saltNonce), factoryInit),
                "deploy GameFactory (CREATE2; Safe + registry fixed)"
            );
        }
        for (uint256 i; i < core.length; ++i) {
            p.txs[k + i] = core[i];
        }
        if (c.topUp != 0) p.txs[k + core.length] = Tx(p.funder, c.topUp, "", "Safe: top up GameFunder");
    }

    /// Delay, Roles and GameFunder (filling in their addresses on `p`), the role, the factory's funder, Delay on.
    function _core(Config memory c, Plan memory p) internal pure returns (Tx[] memory t) {
        bytes memory delayInit =
            abi.encodeWithSignature("setUp(bytes)", abi.encode(c.safe, c.safe, c.safe, COOLDOWN, EXPIRATION));
        p.delay = moduleAddress(DELAY_MASTERCOPY, delayInit, c.saltNonce);
        bytes memory rolesInit = abi.encodeWithSignature("setUp(bytes)", abi.encode(c.safe, c.safe, p.delay));
        p.roles = moduleAddress(ROLES_MASTERCOPY, rolesInit, c.saltNonce);
        bytes memory funderInit = abi.encodePacked(
            type(GameFunder).creationCode, abi.encode(c.safe, IGameFactory(c.gameFactory), c.weeklyBudget, c.perGameCap)
        );
        p.funder = create2Address(bytes32(c.saltNonce), funderInit);

        t = new Tx[](9);
        t[0] = Tx(
            MODULE_FACTORY,
            0,
            abi.encodeCall(IModuleProxyFactory.deployModule, (DELAY_MASTERCOPY, delayInit, c.saltNonce)),
            "deploy Delay 1.1.1 (owner/avatar/target = Safe, cooldown 1 h, expiration 24 h)"
        );
        t[1] = Tx(
            MODULE_FACTORY,
            0,
            abi.encodeCall(IModuleProxyFactory.deployModule, (ROLES_MASTERCOPY, rolesInit, c.saltNonce)),
            "deploy Roles 2.1.1 (owner/avatar = Safe, target = Delay)"
        );
        t[2] =
            Tx(CREATE2_DEPLOYER, 0, abi.encodePacked(bytes32(c.saltNonce), funderInit), "deploy GameFunder (CREATE2)");
        t[3] = Tx(p.delay, 0, abi.encodeCall(IZodiacModifier.enableModule, (p.roles)), "Delay: enable Roles");
        t[4] = _assign(p.roles, c.agent);
        t[5] = Tx(p.roles, 0, abi.encodeCall(IRoles.scopeTarget, (ROLE_KEY, p.funder)), "Roles: scope GameFunder");
        t[6] = Tx(
            p.roles,
            0,
            abi.encodeCall(
                IRoles.scopeFunction,
                (ROLE_KEY, p.funder, GameFunder.fund.selector, fundConditions(c.perGameCap), EXEC_NONE)
            ),
            "Roles: allow only fund(game, amount <= perGameCap), no ETH, no delegatecall"
        );
        t[7] = Tx(
            c.gameFactory,
            0,
            abi.encodeCall(GameFactory.setFunder, (p.funder)),
            "GameFactory: games are funded by this GameFunder"
        );
        t[8] = Tx(c.safe, 0, abi.encodeWithSignature("enableModule(address)", p.delay), "Safe: enable Delay");
    }

    function _assign(address roles, address agent) internal pure returns (Tx memory) {
        bytes32[] memory roleKeys = new bytes32[](1);
        roleKeys[0] = ROLE_KEY;
        bool[] memory member = new bool[](1);
        member[0] = true;
        return
            Tx(
                roles,
                0,
                abi.encodeCall(IRoles.assignRoles, (agent, roleKeys, member)),
                "Roles: give the agent the role"
            );
    }

    /// Arachnid's deployer: CREATE2 from its address with the given salt.
    function create2Address(bytes32 salt, bytes memory initCode) public pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, keccak256(initCode)))))
        );
    }

    /// fund(address game, uint256 amount): any game (GameFunder checks isGame), amount < perGameCap + 1.
    function fundConditions(uint256 perGameCap) public pure returns (ConditionFlat[] memory conds) {
        conds = new ConditionFlat[](3);
        conds[0] = ConditionFlat(0, PARAM_CALLDATA, OP_MATCHES, "");
        conds[1] = ConditionFlat(0, PARAM_STATIC, OP_PASS, "");
        conds[2] = ConditionFlat(0, PARAM_STATIC, OP_LESS_THAN, abi.encode(perGameCap + 1));
    }

    /// ModuleProxyFactory 1.2.0: CREATE2 of an EIP-1167 proxy, salt = keccak(keccak(initializer) ‖ saltNonce).
    function moduleAddress(address mastercopy, bytes memory initializer, uint256 saltNonce)
        public
        pure
        returns (address)
    {
        bytes32 salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce));
        bytes32 codeHash = keccak256(
            abi.encodePacked(
                hex"602d8060093d393df3363d3d373d3d3d363d73", mastercopy, hex"5af43d82803e903d91602b57fd5bf3"
            )
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), MODULE_FACTORY, salt, codeHash)))));
    }

    /// Mainnet only: the pinned contracts are the ones on chain.
    function checkPins() public view {
        require(MODULE_FACTORY.codehash == MODULE_FACTORY_CODEHASH, "funding: module factory codehash");
        require(DELAY_MASTERCOPY.codehash == DELAY_CODEHASH, "funding: Delay codehash");
        require(ROLES_MASTERCOPY.codehash == ROLES_CODEHASH, "funding: Roles codehash");
        require(CREATE2_DEPLOYER.codehash == CREATE2_DEPLOYER_CODEHASH, "funding: CREATE2 deployer codehash");
    }

    /// Safe Transaction Builder batch file (tx-builder 1.18.x), with the checksum the app verifies on import
    /// (apps/tx-builder/src/lib/checksum.ts: keccak of a key-sorted serialization with meta.name = null).
    function batchJson(Plan memory p, address safe, uint256 createdAtMs) public pure returns (string memory) {
        string memory name = "DNA funding path (Roles -> Delay -> Safe)";
        string memory desc =
            "Agent may only call GameFunder.fund through Roles, then waits 1 h in Delay; the Safe can veto";
        string memory txJson;
        string memory txSer;
        for (uint256 i; i < p.txs.length; ++i) {
            string memory to = q(vm.toString(p.txs[i].to));
            string memory value = q(vm.toString(p.txs[i].value));
            string memory data = q(vm.toString(p.txs[i].data));
            string memory sep = i == 0 ? "" : ",";
            txJson = string.concat(txJson, sep, '{"to":', to, ',"value":', value, ',"data":', data, "}");
            txSer = string.concat(txSer, sep, '{["data","to","value"]', data, ",", to, ",", value, ",}");
        }
        string memory safeStr = q(vm.toString(safe));
        string memory created = vm.toString(createdAtMs);
        string memory ser = string.concat(
            '{["chainId","createdAt","meta","transactions","version"]"1",',
            created,
            ',{["createdFromSafeAddress","description","name","txBuilderVersion"]',
            safeStr,
            ",",
            q(desc),
            ',null,"1.18.3",},[',
            txSer,
            '],"1.0",}'
        );
        return string.concat(
            '{"version":"1.0","chainId":"1","createdAt":',
            created,
            ',"meta":{"name":',
            q(name),
            ',"description":',
            q(desc),
            ',"txBuilderVersion":"1.18.3","createdFromSafeAddress":',
            safeStr,
            ',"checksum":',
            q(vm.toString(keccak256(bytes(ser)))),
            '},"transactions":[',
            txJson,
            "]}"
        );
    }

    function q(string memory s) internal pure returns (string memory) {
        return string.concat('"', s, '"');
    }
}

/// Prints the batch; never broadcasts. Inputs from env: SAFE, AGENT, GAME_FACTORY (required); WEEKLY_BUDGET_WEI
/// (0.2 ETH), PER_GAME_CAP_WEI (0.1 ETH), SALT_NONCE (0), TOPUP_WEI (0). With --fork-url on mainnet it also checks the
/// pinned codehashes. `forge script script/FundingSetup.s.sol` → import the JSON line in the Safe Transaction Builder.
contract FundingSetup is Script, FundingPlanner {
    function run() external view {
        Config memory c = Config({
            safe: vm.envAddress("SAFE"),
            agent: vm.envAddress("AGENT"),
            gameFactory: vm.envOr("GAME_FACTORY", address(0)),
            registry: vm.envOr("REGISTRY", address(0)),
            weeklyBudget: vm.envOr("WEEKLY_BUDGET_WEI", uint256(0.2 ether)),
            perGameCap: vm.envOr("PER_GAME_CAP_WEI", uint256(0.1 ether)),
            saltNonce: vm.envOr("SALT_NONCE", uint256(0)),
            topUp: vm.envOr("TOPUP_WEI", uint256(0))
        });
        if (c.gameFactory != address(0) && c.registry != address(0)) {
            console.log("note: GAME_FACTORY is set, so REGISTRY is ignored (the existing factory keeps its registry)");
        }
        if (block.chainid == 1) checkPins();
        Plan memory p = plan(c);
        console.log("Delay     ", p.delay);
        console.log("Roles     ", p.roles);
        console.log("GameFunder", p.funder);
        console.log("GameFactory", p.gameFactory);
        for (uint256 i; i < p.txs.length; ++i) {
            console.log(string.concat(vm.toString(i + 1), ". ", p.txs[i].label));
        }
        console.log("--- Safe Transaction Builder JSON (one line) ---");
        console.log(batchJson(p, c.safe, vm.unixTime()));
    }
}
