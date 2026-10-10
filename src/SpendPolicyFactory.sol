// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SpendPolicy} from "./SpendPolicy.sol";

/// @title  SpendPolicyFactory
/// @notice Lets ANY business deploy its own SpendPolicy with ITSELF (msg.sender) as owner.
///         One policy per business (or several, e.g. one per department). The factory never
///         holds funds, has no admin, no pause, and no upgrade path: it only deploys and records.
/// @dev    The token is fixed to Arc's USDC ERC-20 interface (same address on Arc Testnet and
///         Mainnet). SpendPolicy itself still enforces: agent != 0, agent != owner (separate keys
///         are mandatory, by SpendPolicy's own constructor), 6 decimals, TTL bounds, ceiling bound.
contract SpendPolicyFactory {
    /// @notice USDC ERC-20 interface on Arc (matches script/DeploySpendPolicy.s.sol).
    address public constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    /// @notice Every policy this factory deployed.
    mapping(address => bool) public isPolicy;
    mapping(address => address[]) internal _policiesOf;
    address[] internal _allPolicies;

    event PolicyCreated(
        address indexed owner,
        address indexed agent,
        address indexed policy,
        uint256 perPaymentCap,
        uint256 monthlyCap,
        uint256 globalCeiling,
        uint256 pendingTtl
    );

    error ZeroAgent();
    error AgentIsOwner(address account);

    /// @notice Deploy a new SpendPolicy owned by msg.sender.
    /// @param agent         The AI agent key that may only call requestPayment. Must differ from msg.sender.
    /// @param perPaymentCap Max a single payment may auto-execute (6-decimal USDC units).
    /// @param monthlyCap    Rolling 30-day auto-pay budget.
    /// @param globalCeiling Lifetime outflow cap (can only be lowered later).
    /// @param pendingTtl    How long an over-limit request waits for the owner.
    /// @return policy       Address of the new SpendPolicy. Fund it with USDC to start.
    function createPolicy(
        address agent,
        uint256 perPaymentCap,
        uint256 monthlyCap,
        uint256 globalCeiling,
        uint256 pendingTtl
    ) external returns (address policy) {
        // Fail early with factory-level errors; SpendPolicy re-checks both.
        if (agent == address(0)) revert ZeroAgent();
        if (agent == msg.sender) revert AgentIsOwner(agent);

        policy = address(
            new SpendPolicy(IERC20(ARC_USDC), msg.sender, agent, perPaymentCap, monthlyCap, globalCeiling, pendingTtl)
        );

        isPolicy[policy] = true;
        _policiesOf[msg.sender].push(policy);
        _allPolicies.push(policy);

        emit PolicyCreated(msg.sender, agent, policy, perPaymentCap, monthlyCap, globalCeiling, pendingTtl);
    }

    /// @notice Policies created BY `owner` (the original creator; ownership can later be transferred
    ///         on the policy itself, so always confirm with `SpendPolicy(policy).owner()`).
    function policiesOf(address owner) external view returns (address[] memory) {
        return _policiesOf[owner];
    }

    function policyCount() external view returns (uint256) {
        return _allPolicies.length;
    }

    function allPolicies(uint256 index) external view returns (address) {
        return _allPolicies[index];
    }
}
