// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {FundingPlanner} from "../script/FundingSetup.s.sol";
import {GameFactory} from "../src/games/GameFactory.sol";

/// The printed batch is what the signers import: its checksum must be the one the Safe Transaction Builder computes
/// (apps/tx-builder/src/lib/checksum.ts), or the app warns "this file was modified". The expected value comes from a
/// port of that TS serializer run on this exact JSON (keccak of the key-sorted serialization, meta.name = null).
contract FundingSetupTest is Test, FundingPlanner {
    function test_batchJson_matchesTxBuilderChecksum() public pure {
        Plan memory p;
        p.txs = new Tx[](2);
        p.txs[0] = Tx(address(0xA11), 0, hex"deadbeef", "");
        p.txs[1] = Tx(address(0xB22), 1 ether, "", "");
        string memory json = batchJson(p, address(0x5AFE), 1_760_000_000_000);
        assertEq(
            json,
            string.concat(
                '{"version":"1.0","chainId":"1","createdAt":1760000000000,"meta":{"name":"DNA funding path (Roles -> Delay -> Safe)",',
                '"description":"Agent may only call GameFunder.fund through Roles, then waits 1 h in Delay; the Safe can veto",',
                '"txBuilderVersion":"1.18.3","createdFromSafeAddress":"0x0000000000000000000000000000000000005aFE",',
                '"checksum":"0xdbece25e03f8c1a6be4051db80f9932e343446918a9689adfe03e0c87e6bb914"},"transactions":[',
                '{"to":"0x0000000000000000000000000000000000000a11","value":"0","data":"0xdeadbeef"},',
                '{"to":"0x0000000000000000000000000000000000000b22","value":"1000000000000000000","data":"0x"}]}'
            )
        );
    }

    /// The same Roles scope the batch sets: fund(game, amount) with amount < cap + 1.
    function test_fundConditions_boundTheAmountOnly() public pure {
        assertEq(fundConditions(0.1 ether).length, 3);
        assertEq(fundConditions(0.1 ether)[2].compValue, abi.encode(uint256(0.1 ether) + 1));
    }

    function test_plan_rejectsZeroAddresses() public {
        vm.expectRevert("funding: zero address");
        this.plan(Config(address(0), address(1), address(2), address(0), 0.2 ether, 0.1 ether, 0, 0));
    }

    /// No GAME_FACTORY: the batch deploys one first (CREATE2, Safe + registry fixed) and GameFunder takes its address;
    /// either way the factory is pointed at the new GameFunder before Delay is enabled.
    function test_plan_deploysTheGameFactory_whenNoneIsGiven() public pure {
        Plan memory p =
            plan(Config(address(0x5AFE), address(0xA6), address(0), address(0x8E6), 0.2 ether, 0.1 ether, 3, 0));
        bytes memory init =
            abi.encodePacked(type(GameFactory).creationCode, abi.encode(address(0x5AFE), address(0x8E6)));
        assertEq(p.gameFactory, create2Address(bytes32(uint256(3)), init));
        assertEq(p.txs.length, 10);
        assertEq(p.txs[0].to, CREATE2_DEPLOYER);
        assertEq(p.txs[0].data, abi.encodePacked(bytes32(uint256(3)), init));
        assertEq(p.txs[8].to, p.gameFactory);
        assertEq(p.txs[8].data, abi.encodeCall(GameFactory.setFunder, (p.funder)));
        assertEq(p.txs[9].data, abi.encodeWithSignature("enableModule(address)", p.delay), "Delay enabled last");

        Plan memory q =
            plan(Config(address(0x5AFE), address(0xA6), address(0xFAC), address(0), 0.2 ether, 0.1 ether, 3, 1));
        assertEq(q.gameFactory, address(0xFAC));
        assertEq(q.txs.length, 10); // no factory deploy, plus the top-up
        assertEq(q.txs[7].data, abi.encodeCall(GameFactory.setFunder, (q.funder)));
        assertEq(q.txs[9].to, q.funder);
    }

    function test_plan_needsAFactoryOrARegistry() public {
        vm.expectRevert("funding: zero address");
        this.plan(Config(address(1), address(2), address(0), address(0), 0.2 ether, 0.1 ether, 0, 0));
    }

    /// Mirrors GameFunder's constructor: a ladder it would reject can't be printed.
    function test_plan_rejectsBadLadder() public {
        vm.expectRevert("funding: bad ladder");
        this.plan(Config(address(1), address(2), address(3), address(0), 0.2 ether, 0, 0, 0));
        vm.expectRevert("funding: bad ladder");
        this.plan(Config(address(1), address(2), address(3), address(0), 0.1 ether, 0.2 ether, 0, 0));
        vm.expectRevert("funding: bad ladder");
        this.plan(
            Config(address(1), address(2), address(3), address(0), uint256(type(uint192).max) + 1, 0.1 ether, 0, 0)
        );
    }
}
