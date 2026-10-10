// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SpendPolicy} from "../../src/SpendPolicy.sol";

/// @notice Returns false from transfer instead of reverting (non-standard ERC-20).
contract FalseReturnToken is ERC20 {
    constructor() ERC20("False", "FALSE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }
}

/// @notice Malicious token: during transfer() it re-enters the policy. The test makes this token
///         the policy's agent so the re-entrant call would pass the role check and is stopped only
///         by the reentrancy guard.
contract ReentrantToken is ERC20 {
    SpendPolicy public policy;
    uint8 public mode; // 0 = off, 1 = requestPayment, 2 = approvePending, 3 = withdraw
    bool public bubble; // true: bubble the guard's revert; false: swallow it and record
    bytes32 public reentryId;
    address public reentryPayee;
    bytes32 public reentryCategory;
    bool public attempted;
    bytes public lastError;

    constructor() ERC20("Evil", "EVIL") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(SpendPolicy p, uint8 m, bool b, bytes32 id, address payee, bytes32 category) external {
        policy = p;
        mode = m;
        bubble = b;
        reentryId = id;
        reentryPayee = payee;
        reentryCategory = category;
    }

    /// @dev Lets the test drive the policy as this contract (when it holds the agent or owner role).
    function exec(bytes calldata data) external {
        (bool ok, bytes memory ret) = address(policy).call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (mode != 0 && msg.sender == address(policy) && !attempted) {
            attempted = true;
            bytes memory data;
            if (mode == 1) {
                data = abi.encodeCall(
                    SpendPolicy.requestPayment, (reentryId, reentryPayee, 1, reentryCategory, bytes32("x"), bytes32(0))
                );
            } else if (mode == 2) {
                data = abi.encodeCall(SpendPolicy.approvePending, (reentryId));
            } else {
                data = abi.encodeCall(SpendPolicy.withdraw, (address(this), 1));
            }
            (bool ok, bytes memory ret) = address(policy).call(data);
            if (!ok) {
                lastError = ret;
                if (bubble) {
                    assembly {
                        revert(add(ret, 32), mload(ret))
                    }
                }
            }
        }
        return super.transfer(to, amount);
    }
}
