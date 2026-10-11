// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// What GameFunder asks of the games registry: only games it deployed can be funded.
interface IGameFactory {
    function isGame(address game) external view returns (bool);
}

/// What a game asks of the factory that deployed it: who the Safe is and who may fund it (read live, so a new ladder
/// level's GameFunder can fund games that already exist).
interface IGameHost {
    function safe() external view returns (address);
    function funder() external view returns (address);
}

/// A Sequencer game (GameKit): takes GameFunder's funding; the factory retires it.
interface IGameKit {
    function fund() external payable;
    function factory() external view returns (IGameHost);
    function retire() external;
}

/// The registry's view of the agent (ModuleRegistry implements it).
interface IAgentRegistry {
    function agent() external view returns (address);
    function agentPaused() external view returns (bool);
    function level() external view returns (uint8);
}
