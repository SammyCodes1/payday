// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SpendPolicy} from "../src/SpendPolicy.sol";

/// @notice Deploys one SpendPolicy. NOT run yet; see README "Deploy (later)".
/// @dev    Signs with whatever `--account` / `--ledger` you pass to forge. No key is read here.
///         All parameters come from environment variables.
contract DeploySpendPolicy is Script {
    /// USDC ERC-20 interface on Arc Testnet AND Arc Mainnet (same address per
    /// https://docs.arc.io/arc/references/contract-addresses). 6 decimals.
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002; // https://docs.arc.io/arc/references/connect-to-arc
    uint256 internal constant ARC_MAINNET_CHAIN_ID = 5042; // https://docs.arc.io/arc/references/connect-to-arc

    function run() external returns (SpendPolicy policy) {
        require(block.chainid == ARC_TESTNET_CHAIN_ID || block.chainid == ARC_MAINNET_CHAIN_ID, "not an Arc chain");
        if (block.chainid == ARC_MAINNET_CHAIN_ID) {
            require(vm.envOr("I_UNDERSTAND_THIS_IS_MAINNET", false), "set I_UNDERSTAND_THIS_IS_MAINNET=true");
        }

        address owner = vm.envAddress("PAYDAY_OWNER");
        address agent = vm.envAddress("PAYDAY_AGENT");
        uint256 perPayment = vm.envUint("PAYDAY_PER_PAYMENT_CAP"); // raw units, 6 decimals
        uint256 monthly = vm.envUint("PAYDAY_MONTHLY_CAP");
        uint256 ceiling = vm.envUint("PAYDAY_GLOBAL_CEILING");
        uint256 ttl = vm.envOr("PAYDAY_PENDING_TTL", uint256(7 days));

        vm.startBroadcast();
        policy = new SpendPolicy(IERC20(ARC_USDC), owner, agent, perPayment, monthly, ceiling, ttl);
        vm.stopBroadcast();

        console.log("SpendPolicy deployed at", address(policy));
    }
}
