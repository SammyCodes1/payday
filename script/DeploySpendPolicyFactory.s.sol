// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {SpendPolicyFactory} from "../src/SpendPolicyFactory.sol";

/// @notice Deploys the SpendPolicyFactory. NOT run yet (needs Sammy's go-ahead). Arc TESTNET only.
/// @dev    Signs with whatever `--account` / `--ledger` you pass to forge. No key is read here.
contract DeploySpendPolicyFactory is Script {
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;

    function run() external returns (SpendPolicyFactory factory) {
        require(block.chainid == ARC_TESTNET_CHAIN_ID, "Arc testnet only");
        vm.startBroadcast();
        factory = new SpendPolicyFactory();
        vm.stopBroadcast();
        console.log("SpendPolicyFactory deployed at", address(factory));
    }
}
