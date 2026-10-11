// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {MockAgentRegistry} from "./GameKitConformance.sol";
import {KitHarness} from "./GameKit.t.sol";
import {GameFactory} from "../../src/games/GameFactory.sol";
import {GameKit} from "../../src/games/GameKit.sol";

/// Says it is a game of some other factory.
contract Impostor {
    function factory() external pure returns (address) {
        return address(1);
    }
}

/// A 40-byte constant full of 0xF4 (DELEGATECALL's byte).
contract LongConstant {
    function blob() external pure returns (bytes memory) {
        return hex"f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4";
    }
}

/// Answers factory() like a game, then refuses to retire.
contract Stubborn {
    address public factory = msg.sender;

    function retire() external pure {
        revert("never");
    }
}

contract GameFactoryTest is Test {
    address safe = makeAddr("safe");
    address agent = makeAddr("agent");
    MockAgentRegistry registry;
    GameFactory factory;

    function setUp() public {
        registry = new MockAgentRegistry(agent);
        factory = new GameFactory(safe, registry);
    }

    /// Init code that deploys exactly `runtime`.
    /// PUSH2 n, PUSH1 14, PUSH1 0, CODECOPY, PUSH2 n, PUSH1 0, RETURN (14 bytes), then the runtime.
    function _raw(bytes memory runtime) internal pure returns (bytes memory) {
        uint16 n = uint16(runtime.length);
        return abi.encodePacked(hex"61", n, hex"600e600039", hex"61", n, hex"6000f3", runtime);
    }

    function _deploy(bytes memory initCode, bytes32 salt) internal returns (address) {
        vm.prank(agent);
        return factory.deploy(initCode, salt);
    }

    function test_constructor_refusesZeroes() public {
        vm.expectRevert(GameFactory.BadConfig.selector);
        new GameFactory(address(0), registry);
        vm.expectRevert(GameFactory.BadConfig.selector);
        new GameFactory(safe, MockAgentRegistry(address(0)));
    }

    function test_deploy_auth_agentUnpausedLevel5_orTheSafe() public {
        bytes memory code = type(KitHarness).creationCode;
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(GameFactory.Unauthorized.selector);
        factory.deploy(code, 0);
        registry.set(agent, true, 5);
        vm.prank(agent);
        vm.expectRevert(GameFactory.Unauthorized.selector);
        factory.deploy(code, 0);
        registry.set(agent, false, 4);
        vm.prank(agent);
        vm.expectRevert(GameFactory.Unauthorized.selector);
        factory.deploy(code, 0);
        registry.set(agent, false, 5);
        address g = _deploy(code, 0);
        vm.prank(safe);
        address h = factory.deploy(code, bytes32(uint256(1)));
        assertTrue(factory.isGame(g) && factory.isLive(g) && factory.isGame(h));
        assertEq(factory.liveCount(), 2);
    }

    function test_deploy_addressIsPredicted_andEventCarriesTheCodehash() public {
        bytes memory code = type(KitHarness).creationCode;
        address want = factory.predict(bytes32(uint256(7)), keccak256(code));
        vm.recordLogs();
        assertEq(_deploy(code, bytes32(uint256(7))), want);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory last = logs[logs.length - 1];
        assertEq(last.topics[0], GameFactory.GameDeployed.selector);
        assertEq(last.topics[1], bytes32(uint256(uint160(want))));
        assertEq(last.data, abi.encode(bytes32(uint256(7)), want.codehash));
    }

    function test_deploy_atMostThreeLive_retireFreesASlot() public {
        bytes memory code = type(KitHarness).creationCode;
        address g0 = _deploy(code, bytes32(uint256(0)));
        _deploy(code, bytes32(uint256(1)));
        _deploy(code, bytes32(uint256(2)));
        vm.prank(agent);
        vm.expectRevert(GameFactory.TooManyLive.selector);
        factory.deploy(code, bytes32(uint256(3)));
        vm.prank(agent);
        factory.retire(g0);
        assertEq(factory.liveCount(), 2);
        assertTrue(factory.isGame(g0), "a retired game stays a game (GameFunder can still pay it: forwarded)");
        assertFalse(factory.isLive(g0));
        assertTrue(GameKit(payable(g0)).retired());
        _deploy(code, bytes32(uint256(3)));
        assertEq(factory.liveCount(), 3);
    }

    /// Planted: a game whose retire() reverts still loses its slot; the event says its retire failed.
    function test_retire_freesTheSlot_evenWhenTheGameRefuses() public {
        address s = _deploy(type(Stubborn).creationCode, 0);
        assertEq(factory.liveCount(), 1);
        vm.expectEmit(address(factory));
        emit GameFactory.GameRetired(s, false);
        vm.prank(agent);
        factory.retire(s);
        assertEq(factory.liveCount(), 0);
        assertFalse(factory.isLive(s));
        address g = _deploy(type(KitHarness).creationCode, 0);
        vm.expectEmit(address(factory));
        emit GameFactory.GameRetired(g, true);
        vm.prank(agent);
        factory.retire(g);
    }

    function test_retire_auth_andOnlyLiveGames() public {
        address g = _deploy(type(KitHarness).creationCode, 0);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(GameFactory.Unauthorized.selector);
        factory.retire(g);
        vm.prank(safe);
        factory.retire(g);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(GameFactory.NotLive.selector, g));
        factory.retire(g);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(GameFactory.NotLive.selector, address(0xBEEF)));
        factory.retire(address(0xBEEF));
    }

    function test_setFunder_onlySafe() public {
        vm.prank(agent);
        vm.expectRevert(GameFactory.NotSafe.selector);
        factory.setFunder(agent);
        vm.prank(safe);
        factory.setFunder(address(0xF0));
        assertEq(factory.funder(), address(0xF0));
    }

    function test_deploy_refusesAContractThatIsNotOurGame() public {
        bytes memory code = type(Impostor).creationCode;
        address at = factory.predict(0, keccak256(code));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GameFactory.NotOurGame.selector, at));
        factory.deploy(code, 0);
    }

    function test_deploy_refusesEmptyCodeAndFailedInit() public {
        vm.prank(agent);
        vm.expectRevert(GameFactory.DeployFailed.selector);
        factory.deploy(hex"00", 0); // STOP: deploys no code
        vm.prank(agent);
        vm.expectRevert(GameFactory.DeployFailed.selector);
        factory.deploy(hex"fe", 0); // INVALID: init fails
    }

    /// Planted: every banned opcode in otherwise harmless runtime code refuses the deploy.
    function test_deploy_refusesEachBannedOpcode() public {
        bytes1[5] memory ops = [bytes1(0xf0), 0xf2, 0xf4, 0xf5, 0xff];
        for (uint256 i; i < ops.length; ++i) {
            bytes memory init = _raw(abi.encodePacked(hex"6001", ops[i], hex"00"));
            address at = factory.predict(bytes32(i), keccak256(init));
            vm.prank(agent);
            vm.expectRevert(abi.encodeWithSelector(GameFactory.BannedOpcode.selector, at));
            factory.deploy(init, bytes32(i));
        }
    }

    function test_banned_skipsPushData() public {
        vm.etch(address(0xA1), hex"63f4f4f4f400"); // PUSH4 f4f4f4f4, STOP
        assertFalse(factory.banned(address(0xA1)));
        vm.etch(address(0xA2), hex"7ff4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f400"); // PUSH32
        assertFalse(factory.banned(address(0xA2)));
        vm.etch(address(0xA3), hex"63f4f4f4f4f4"); // the byte after PUSH4's data is an opcode
        assertTrue(factory.banned(address(0xA3)));
        vm.etch(address(0xA4), hex"5ff4"); // PUSH0 carries no data
        assertTrue(factory.banned(address(0xA4)));
        vm.etch(address(0xA5), hex"60"); // truncated PUSH1 at the end
        assertFalse(factory.banned(address(0xA5)));
        assertFalse(factory.banned(address(0xA6))); // no code
    }

    /// The data-section caveat, pinned: solc appends a long constant to the runtime code (read with CODECOPY), so a
    /// 0xF4 byte inside it reads as DELEGATECALL. A false positive on the safe side: the deploy is refused (rework).
    function test_banned_longConstantHoldingF4_isAFalsePositive_refused() public {
        assertTrue(factory.banned(address(new LongConstant())));
        bytes memory code = type(LongConstant).creationCode;
        address at = factory.predict(0, keccak256(code));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(GameFactory.BannedOpcode.selector, at));
        factory.deploy(code, 0);
    }

    function test_banned_realGameCodeIsClean() public {
        assertFalse(factory.banned(_deploy(type(KitHarness).creationCode, 0)));
    }

    /// The scan's worst case (24 KB of one-byte opcodes, no PUSH to skip): about 3.2 M gas, once per game.
    function test_banned_gasOnAFullSizeContract() public {
        bytes memory code = new bytes(24_576);
        for (uint256 i; i < code.length; ++i) {
            code[i] = 0x5b;
        }
        vm.etch(address(0xB1), code);
        uint256 g = gasleft();
        factory.banned(address(0xB1));
        assertLt(g - gasleft(), 3_500_000);
    }
}
