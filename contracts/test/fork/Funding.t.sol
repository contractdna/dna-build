// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {GameFunder, IGameFactory} from "../../src/games/GameFunder.sol";
import {FundingPlanner, IDelay, IRoles} from "../../script/FundingSetup.s.sol";
import {MockGameFactory, MockGame} from "../GameFunder.t.sol";
import {MockAgentRegistry} from "../games/GameKitConformance.sol";
import {GameFactory} from "../../src/games/GameFactory.sol";
import {Example} from "../../src/games/example/Example.sol";

interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address paymentReceiver
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
        address refundReceiver,
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
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function isModuleEnabled(address module) external view returns (bool);
    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory array, address next);
    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool);
    function VERSION() external view returns (string memory);
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

/// The W5 funding path on a mainnet fork against the real Safe v1.5.0, Zodiac Delay 1.1.1 and Roles 2.1.1 contracts:
/// a fresh 2-of-3 Safe applies the exact batch script/FundingSetup.s.sol prints (through MultiSendCallOnly, like the
/// Transaction Builder), then the agent's powers are probed end to end. Skipped without MAINNET_RPC_URL.
contract FundingForkTest is Test, FundingPlanner {
    // safe-global/safe-deployments src/assets/v1.5.0 (canonical)
    address constant SAFE_SINGLETON = 0xFf51A5898e281Db6DfC7855790607438dF2ca44b;
    address constant SAFE_PROXY_FACTORY = 0x14F2982D601c9458F93bd70B218933A6f8165e7b;
    address constant MULTISEND_CALL_ONLY = 0xA83c336B20401Af773B6219BA5027174338D1836;
    address constant FALLBACK_HANDLER = 0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4;

    uint256 constant BUDGET = 0.2 ether;
    uint256 constant CAP = 0.1 ether;
    uint8 constant CALL = 0;
    uint8 constant DELEGATECALL = 1;
    // Roles PermissionChecker.Status
    uint8 constant DELEGATECALL_NOT_ALLOWED = 1;
    uint8 constant TARGET_NOT_ALLOWED = 2;
    uint8 constant FUNCTION_NOT_ALLOWED = 3;
    uint8 constant SEND_NOT_ALLOWED = 4;
    uint8 constant PARAM_GREATER_THAN_ALLOWED = 9;
    bytes4 constant CONDITION_VIOLATION = bytes4(keccak256("ConditionViolation(uint8,bytes32)"));

    bool forked;
    uint256[3] keys;
    address[3] owners; // ascending, the order Safe signatures need
    ISafe safe;
    IDelay delay;
    IRoles roles;
    GameFunder funder;
    MockGameFactory factory;
    MockGame[3] games;
    address agent = makeAddr("funding.agent");
    address keeper = makeAddr("funding.keeper");

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        checkPins();
        assertEq(SAFE_SINGLETON.codehash, 0xdda019cbd7c867a533a2a86e5c53434fdc50b13122b5a5ddb4a8df61b31c20f2);
        assertEq(SAFE_PROXY_FACTORY.codehash, 0x967dae4cda22b0c9ef7f31b010bdc1ceb0af9904b0c3dc060b5302e4c18a4529);
        assertEq(MULTISEND_CALL_ONLY.codehash, 0xcdbdcec38d2f1c7d961b0029ff8416b7e86e9974d6f0e9c9580c7d17fcfb6663);
        assertEq(FALLBACK_HANDLER.codehash, 0x3c6a85bcf7b563daa624b884b4e9a1b9fa5371edde7be945d998071a48f28bbc);

        factory = new MockGameFactory();
        for (uint256 i; i < 3; ++i) {
            games[i] = new MockGame();
            factory.add(address(games[i]));
        }
        _deploySafe();
        Plan memory p = plan(_config(address(safe)));
        vm.deal(address(safe), 1 ether);
        _safeExec(MULTISEND_CALL_ONLY, 0, _multiSend(p.txs), DELEGATECALL);
        delay = IDelay(p.delay);
        roles = IRoles(p.roles);
        funder = GameFunder(payable(p.funder));
    }

    function _config(address s) internal view returns (Config memory) {
        return Config(s, agent, address(factory), address(0), BUDGET, CAP, 0, 0.5 ether);
    }

    // ---------------------------------------------------------------- wiring

    function test_fork_batchWiresTheChain() public {
        vm.skip(!forked);
        assertEq(safe.VERSION(), "1.5.0");
        assertEq(safe.getThreshold(), 2);
        assertEq(safe.getOwners().length, 3);
        (address[] memory mods,) = safe.getModulesPaginated(address(1), 10);
        assertEq(mods.length, 1);
        assertEq(mods[0], address(delay)); // the Safe's only module is Delay
        (mods,) = delay.getModulesPaginated(address(1), 10);
        assertEq(mods.length, 1);
        assertEq(mods[0], address(roles)); // Delay's only module is Roles
        assertTrue(roles.isModuleEnabled(agent));
        assertFalse(safe.isModuleEnabled(agent));
        assertFalse(delay.isModuleEnabled(agent));

        assertEq(delay.owner(), address(safe));
        assertEq(delay.avatar(), address(safe));
        assertEq(delay.target(), address(safe));
        assertEq(delay.txCooldown(), 1 hours);
        assertEq(delay.txExpiration(), 24 hours);
        assertEq(roles.owner(), address(safe));
        assertEq(roles.avatar(), address(safe));
        assertEq(roles.target(), address(delay));

        assertEq(funder.safe(), address(safe));
        assertEq(address(funder.factory()), address(factory));
        assertEq(funder.weeklyBudget(), BUDGET);
        assertEq(funder.perGameCap(), CAP);
        assertEq(address(funder).balance, 0.5 ether);
    }

    // ---------------------------------------------------------------- the happy path and the Safe's controls

    function test_fork_fundWaitsAnHour_thenAnyoneExecutes() public {
        vm.skip(!forked);
        _queue(address(games[0]), 0.05 ether);
        assertEq(delay.queueNonce(), 1);
        assertEq(games[0].received(), 0); // queued, nothing moved

        skip(1 hours - 1);
        vm.prank(keeper);
        vm.expectRevert("Transaction is still in cooldown");
        delay.executeNextTx(address(funder), 0, _fundData(address(games[0]), 0.05 ether), CALL);

        skip(1);
        uint256 safeBalance = address(safe).balance;
        vm.prank(keeper); // permissionless
        delay.executeNextTx(address(funder), 0, _fundData(address(games[0]), 0.05 ether), CALL);
        assertEq(games[0].received(), 0.05 ether);
        assertEq(address(funder).balance, 0.45 ether);
        assertEq(address(safe).balance, safeBalance); // the Safe's own ETH never moves
        assertEq(funder.fundedTotal(address(games[0])), 0.05 ether);
    }

    function test_fork_safeVetoesWithSetTxNonce() public {
        vm.skip(!forked);
        _queue(address(games[0]), 0.05 ether);
        _safeExec(address(delay), 0, abi.encodeCall(IDelay.setTxNonce, (1)), CALL);
        skip(1 hours);
        vm.prank(keeper);
        vm.expectRevert("Transaction queue is empty");
        delay.executeNextTx(address(funder), 0, _fundData(address(games[0]), 0.05 ether), CALL);
        assertEq(games[0].received(), 0);
    }

    /// Delay is strict FIFO: a queued fund that reverts (here: not a game) blocks the next one until the Safe vetoes it.
    function test_fork_badTxBlocksQueueUntilVetoed() public {
        vm.skip(!forked);
        address notAGame = address(new MockGame());
        _queue(notAGame, 0.01 ether);
        _queue(address(games[0]), 0.05 ether);
        skip(1 hours);
        vm.startPrank(keeper);
        vm.expectRevert("Module transaction failed");
        delay.executeNextTx(address(funder), 0, _fundData(notAGame, 0.01 ether), CALL);
        vm.expectRevert("Transaction hashes do not match");
        delay.executeNextTx(address(funder), 0, _fundData(address(games[0]), 0.05 ether), CALL);
        vm.stopPrank();

        _safeExec(address(delay), 0, abi.encodeCall(IDelay.setTxNonce, (1)), CALL); // veto only the bad one
        vm.prank(keeper);
        delay.executeNextTx(address(funder), 0, _fundData(address(games[0]), 0.05 ether), CALL);
        assertEq(games[0].received(), 0.05 ether);
        assertEq(MockGame(notAGame).received(), 0);
    }

    function test_fork_expiredTxIsSkipped() public {
        vm.skip(!forked);
        _queue(address(games[0]), 0.05 ether);
        skip(1 hours + 24 hours + 1);
        vm.prank(keeper);
        vm.expectRevert("Transaction expired");
        delay.executeNextTx(address(funder), 0, _fundData(address(games[0]), 0.05 ether), CALL);
        vm.prank(keeper);
        delay.skipExpired();
        assertEq(delay.txNonce(), 1);
        assertEq(games[0].received(), 0);
    }

    /// GameFunder's ladder holds through the chain: per-game cap, then the weekly budget (each failure is vetoed so
    /// the queue moves on).
    function test_fork_funderEnforcesLadderThroughTheChain() public {
        vm.skip(!forked);
        _queue(address(games[0]), CAP);
        _queue(address(games[1]), CAP);
        _queue(address(games[0]), 1); // over game 0's cap
        _queue(address(games[2]), 1); // over the weekly budget
        skip(1 hours);
        vm.startPrank(keeper);
        delay.executeNextTx(address(funder), 0, _fundData(address(games[0]), CAP), CALL);
        delay.executeNextTx(address(funder), 0, _fundData(address(games[1]), CAP), CALL);
        vm.expectRevert("Module transaction failed");
        delay.executeNextTx(address(funder), 0, _fundData(address(games[0]), 1), CALL);
        vm.stopPrank();
        _safeExec(address(delay), 0, abi.encodeCall(IDelay.setTxNonce, (3)), CALL);
        vm.prank(keeper);
        vm.expectRevert("Module transaction failed");
        delay.executeNextTx(address(funder), 0, _fundData(address(games[2]), 1), CALL);
        assertEq(funder.spentInWindow(), BUDGET);
    }

    // ---------------------------------------------------------------- what the agent can't do

    function test_fork_agentCannotExceedTheAmountBound() public {
        vm.skip(!forked);
        _expectViolation(address(funder), 0, _fundData(address(games[0]), CAP + 1), CALL, PARAM_GREATER_THAN_ALLOWED);
    }

    function test_fork_agentCannotCallAnythingElse() public {
        vm.skip(!forked);
        // other GameFunder functions
        _expectViolation(address(funder), 0, abi.encodeCall(GameFunder.sweep, ()), CALL, FUNCTION_NOT_ALLOWED);
        // ETH out of the Safe: to itself, to GameFunder, or with the fund call
        _expectViolation(agent, 1 ether, "", CALL, TARGET_NOT_ALLOWED);
        _expectViolation(address(funder), 1 ether, "", CALL, FUNCTION_NOT_ALLOWED); // receive() is not fund()
        _expectViolation(address(funder), 1, _fundData(address(games[0]), 1), CALL, SEND_NOT_ALLOWED);
        // delegatecall from the Safe
        _expectViolation(address(funder), 0, _fundData(address(games[0]), 1), DELEGATECALL, DELEGATECALL_NOT_ALLOWED);
        // Safe administration: modules, owners, threshold, guards
        _expectViolation(
            address(safe), 0, abi.encodeWithSignature("enableModule(address)", agent), CALL, TARGET_NOT_ALLOWED
        );
        _expectViolation(
            address(safe),
            0,
            abi.encodeWithSignature("addOwnerWithThreshold(address,uint256)", agent, 1),
            CALL,
            TARGET_NOT_ALLOWED
        );
        _expectViolation(
            address(safe), 0, abi.encodeWithSignature("changeThreshold(uint256)", 1), CALL, TARGET_NOT_ALLOWED
        );
        _expectViolation(
            address(safe), 0, abi.encodeWithSignature("setModuleGuard(address)", agent), CALL, TARGET_NOT_ALLOWED
        );
        // the modules themselves (their owner is the Safe)
        _expectViolation(address(delay), 0, abi.encodeCall(IDelay.setTxNonce, (0)), CALL, TARGET_NOT_ALLOWED);
        _expectViolation(
            address(roles), 0, abi.encodeCall(IRoles.scopeTarget, (ROLE_KEY, agent)), CALL, TARGET_NOT_ALLOWED
        );
        // a game directly (bypassing GameFunder's ladder)
        _expectViolation(address(games[0]), 0, abi.encodeCall(MockGame.fund, ()), CALL, TARGET_NOT_ALLOWED);
        // another role key
        vm.prank(agent);
        vm.expectRevert(bytes4(keccak256("NoMembership()")));
        roles.execTransactionWithRole(
            address(funder), 0, _fundData(address(games[0]), 1), CALL, bytes32("someone-else"), true
        );
    }

    function test_fork_agentHasNoDirectPower() public {
        vm.skip(!forked);
        vm.startPrank(agent);
        vm.expectRevert(bytes("GS104")); // not a Safe module
        safe.execTransactionFromModule(agent, 1 ether, "", CALL);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("NotAuthorized(address)")), agent));
        delay.execTransactionFromModule(agent, 1 ether, "", CALL); // can't queue past Roles
        vm.expectRevert();
        delay.setTxNonce(0);
        vm.expectRevert();
        roles.scopeTarget(ROLE_KEY, agent);
        vm.expectRevert(GameFunder.NotSafe.selector);
        funder.fund(address(games[0]), 1);
        vm.expectRevert(GameFunder.NotSafe.selector);
        funder.sweep();
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- raising the ladder

    /// New level = new GameFunder; the Safe re-points Roles to it and sweeps the old one (contracts/docs/funding.md).
    function test_fork_ladderChangeRepointsRoles() public {
        vm.skip(!forked);
        _queue(address(games[0]), CAP); // still queued for the old GameFunder when the change is signed
        GameFunder next = new GameFunder(address(safe), factory, 2 * BUDGET, 2 * CAP);
        Tx[] memory txs = new Tx[](6);
        txs[0] = Tx(address(delay), 0, abi.encodeCall(IDelay.setTxNonce, (delay.queueNonce())), "");
        txs[1] = Tx(address(roles), 0, abi.encodeCall(IRoles.revokeTarget, (ROLE_KEY, address(funder))), "");
        txs[2] = Tx(address(roles), 0, abi.encodeCall(IRoles.scopeTarget, (ROLE_KEY, address(next))), "");
        txs[3] = Tx(
            address(roles),
            0,
            abi.encodeCall(
                IRoles.scopeFunction,
                (ROLE_KEY, address(next), GameFunder.fund.selector, fundConditions(2 * CAP), EXEC_NONE)
            ),
            ""
        );
        txs[4] = Tx(address(funder), 0, abi.encodeCall(GameFunder.sweep, ()), "");
        txs[5] = Tx(address(next), 0.5 ether, "", "");
        _safeExec(MULTISEND_CALL_ONLY, 0, _multiSend(txs), DELEGATECALL);

        // the old queued fund can neither run nor jam: the next fund goes straight through after its hour
        skip(1 hours);
        vm.expectRevert("Transaction queue is empty");
        delay.executeNextTx(address(funder), 0, _fundData(address(games[0]), CAP), CALL);

        assertEq(address(funder).balance, 0);
        assertEq(address(next).balance, 0.5 ether);
        _expectViolation(address(funder), 0, _fundData(address(games[0]), 1), CALL, TARGET_NOT_ALLOWED);
        vm.prank(agent);
        roles.execTransactionWithRole(
            address(next), 0, abi.encodeCall(GameFunder.fund, (address(games[0]), 2 * CAP)), CALL, ROLE_KEY, true
        );
        skip(1 hours);
        delay.executeNextTx(address(next), 0, abi.encodeCall(GameFunder.fund, (address(games[0]), 2 * CAP)), CALL);
        assertEq(games[0].received(), 2 * CAP);
    }

    /// The one-transaction stop: disabling Delay on the Safe makes every queued fund fail at execution.
    function test_fork_disableDelayStopsEverythingQueued() public {
        vm.skip(!forked);
        _queue(address(games[0]), 0.05 ether);
        _safeExec(address(safe), 0, abi.encodeWithSignature("disableModule(address,address)", address(1), delay), CALL);
        assertFalse(safe.isModuleEnabled(address(delay)));
        _queue(address(games[1]), 0.05 ether); // the agent can still queue, but nothing reaches the Safe
        skip(1 hours);
        vm.prank(keeper);
        vm.expectRevert(bytes("GS104"));
        delay.executeNextTx(address(funder), 0, _fundData(address(games[0]), 0.05 ether), CALL);
        assertEq(games[0].received(), 0);
    }

    // ---------------------------------------------------------------- with the real GameFactory and a real game

    /// The batch that also deploys the GameFactory (GAME_FACTORY unset), applied by the 2-of-3 Safe; then a real game
    /// is funded through Roles → Delay → Safe → GameFunder, and a fund still queued when the game is retired is
    /// forwarded to the Safe at execution instead of reverting: the queue behind it never jams.
    function test_fork_realGameFactory_fundsAGame_aRetiredGameNeverJamsTheQueue() public {
        vm.skip(!forked);
        MockAgentRegistry reg = new MockAgentRegistry(agent);
        Plan memory p = plan(Config(address(safe), agent, address(0), address(reg), BUDGET, CAP, 7, 0.5 ether));
        _safeExec(MULTISEND_CALL_ONLY, 0, _multiSend(p.txs), DELEGATECALL);
        GameFactory gf = GameFactory(p.gameFactory);
        assertEq(gf.safe(), address(safe));
        assertEq(gf.funder(), p.funder);
        assertEq(address(GameFunder(payable(p.funder)).factory()), address(gf));

        vm.prank(agent);
        address g = gf.deploy(type(Example).creationCode, 0);
        bytes memory data = abi.encodeCall(GameFunder.fund, (g, 0.03 ether));
        vm.startPrank(agent);
        IRoles(p.roles).execTransactionWithRole(p.funder, 0, data, CALL, ROLE_KEY, true);
        IRoles(p.roles).execTransactionWithRole(p.funder, 0, data, CALL, ROLE_KEY, true);
        vm.stopPrank();
        skip(1 hours);
        vm.prank(keeper);
        IDelay(p.delay).executeNextTx(p.funder, 0, data, CALL);
        assertEq(g.balance, 0.03 ether);

        vm.prank(agent);
        gf.retire(g);
        uint256 safeBefore = address(safe).balance;
        vm.prank(keeper);
        IDelay(p.delay).executeNextTx(p.funder, 0, data, CALL); // the late fund: forwarded, not reverted
        assertEq(address(safe).balance, safeBefore + 0.03 ether);
        assertEq(g.balance, 0.03 ether);
        assertEq(IDelay(p.delay).txNonce(), 2, "the queue moved on");
    }

    // ---------------------------------------------------------------- the real Safe (optional)

    /// FUNDING_SAFE=<the Safe> also replays the batch on the real Safe's fork state (as the Safe, no signatures) and
    /// runs one fund through it, so the batch is known to apply to that Safe before anyone signs it.
    function test_fork_batchAppliesToRealSafe() public {
        address real = vm.envOr("FUNDING_SAFE", address(0));
        vm.skip(!forked || real == address(0));
        assertEq(ISafe(real).VERSION(), "1.5.0");
        Plan memory p = plan(Config(real, agent, address(factory), address(0), BUDGET, CAP, 1, 0.5 ether));
        vm.deal(real, real.balance + 0.5 ether);
        for (uint256 i; i < p.txs.length; ++i) {
            vm.prank(real);
            (bool ok,) = p.txs[i].to.call{value: p.txs[i].value}(p.txs[i].data);
            assertTrue(ok, p.txs[i].label);
        }
        vm.prank(agent);
        IRoles(p.roles).execTransactionWithRole(p.funder, 0, _fundData(address(games[0]), CAP), CALL, ROLE_KEY, true);
        skip(1 hours);
        IDelay(p.delay).executeNextTx(p.funder, 0, _fundData(address(games[0]), CAP), CALL);
        assertEq(games[0].received(), CAP);
    }

    // ---------------------------------------------------------------- helpers

    function _deploySafe() internal {
        for (uint256 i; i < 3; ++i) {
            (owners[i], keys[i]) = makeAddrAndKey(string.concat("funding.owner", vm.toString(i)));
        }
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (owners[j] < owners[i]) {
                    (owners[i], owners[j]) = (owners[j], owners[i]);
                    (keys[i], keys[j]) = (keys[j], keys[i]);
                }
            }
        }
        address[] memory o = new address[](3);
        for (uint256 i; i < 3; ++i) {
            o[i] = owners[i];
        }
        bytes memory init =
            abi.encodeCall(ISafe.setup, (o, 2, address(0), "", FALLBACK_HANDLER, address(0), 0, address(0)));
        safe = ISafe(
            ISafeProxyFactory(SAFE_PROXY_FACTORY)
                .createProxyWithNonce(SAFE_SINGLETON, init, uint256(keccak256("dna.w5")))
        );
    }

    /// A Safe transaction signed by 2 of the 3 owners.
    function _safeExec(address to, uint256 value, bytes memory data, uint8 op) internal {
        bytes32 h = safe.getTransactionHash(to, value, data, op, 0, 0, 0, address(0), address(0), safe.nonce());
        bytes memory sigs;
        for (uint256 i; i < 2; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[i], h);
            sigs = abi.encodePacked(sigs, r, s, v);
        }
        assertTrue(safe.execTransaction(to, value, data, op, 0, 0, 0, address(0), address(0), sigs));
    }

    /// MultiSendCallOnly 1.5.0 payload: operation ‖ to ‖ value ‖ data length ‖ data, per tx.
    function _multiSend(Tx[] memory txs) internal pure returns (bytes memory) {
        bytes memory packed;
        for (uint256 i; i < txs.length; ++i) {
            packed = abi.encodePacked(packed, uint8(0), txs[i].to, txs[i].value, txs[i].data.length, txs[i].data);
        }
        return abi.encodeWithSignature("multiSend(bytes)", packed);
    }

    function _fundData(address game, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(GameFunder.fund, (game, amount));
    }

    function _queue(address game, uint256 amount) internal {
        vm.prank(agent);
        assertTrue(roles.execTransactionWithRole(address(funder), 0, _fundData(game, amount), CALL, ROLE_KEY, true));
    }

    /// The agent's call through Roles reverts with ConditionViolation(status, ·) and queues nothing.
    function _expectViolation(address to, uint256 value, bytes memory data, uint8 op, uint8 status) internal {
        uint256 queued = delay.queueNonce();
        vm.prank(agent);
        (bool ok, bytes memory err) =
            address(roles).call(abi.encodeCall(IRoles.execTransactionWithRole, (to, value, data, op, ROLE_KEY, true)));
        assertFalse(ok);
        assertEq(bytes4(err), CONDITION_VIOLATION);
        bytes memory args = new bytes(err.length - 4);
        for (uint256 i; i < args.length; ++i) {
            args[i] = err[i + 4];
        }
        (uint8 got,) = abi.decode(args, (uint8, bytes32));
        assertEq(got, status);
        assertEq(delay.queueNonce(), queued);
    }
}
