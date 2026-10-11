// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The subset of Chainlink VRF v2.5 (VRFCoordinatorV2_5 + SubscriptionAPI, smartcontractkit/chainlink-evm
///         contracts/src/v0.8/vrf) that GamePot calls. Mainnet coordinator 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a.
library VRFV2PlusClient {
    bytes4 internal constant EXTRA_ARGS_V1_TAG = bytes4(keccak256("VRF ExtraArgsV1"));

    struct ExtraArgsV1 {
        bool nativePayment;
    }

    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }
}

interface IVRFCoordinatorV2Plus {
    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req) external returns (uint256 requestId);
    function createSubscription() external returns (uint256 subId);
    function addConsumer(uint256 subId, address consumer) external;
    function fundSubscriptionWithNative(uint256 subId) external payable;
    function getSubscription(uint256 subId)
        external
        view
        returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address owner, address[] memory consumers);
}
