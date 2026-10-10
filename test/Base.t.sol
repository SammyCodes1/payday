// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SpendPolicy} from "../src/SpendPolicy.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Shared fixture. All accounts come from Foundry/Anvil's PUBLIC default test mnemonic,
///      derived at runtime; no key material is stored in this repo.
abstract contract Base is Test {
    string internal constant TEST_MNEMONIC = "test test test test test test test test test test test junk";

    uint256 internal constant USDC = 1e6; // 6 decimals, as on Arc's USDC ERC-20 interface
    uint256 internal constant PER_PAYMENT = 1_000 * USDC;
    uint256 internal constant MONTHLY = 5_000 * USDC;
    uint256 internal constant CEILING = 20_000 * USDC;
    uint256 internal constant OPS_BUDGET = 3_000 * USDC;
    uint256 internal constant SUP_BUDGET = 3_000 * USDC; // OPS + SUP (6k) > MONTHLY (5k) on purpose
    uint256 internal constant PAYEE_C_CAP = 1_500 * USDC;
    uint256 internal constant TTL = 7 days;
    uint256 internal constant FUNDING = 100_000 * USDC;
    uint256 internal constant START = 20_000 days; // midnight UTC, day 20000

    bytes32 internal constant OPS = "OPS";
    bytes32 internal constant SUP = "SUPPLIES";
    bytes32 internal constant REASON = keccak256("agent reasoning blob");

    uint256 internal ownerKey;
    address internal owner;
    address internal blocked; // index 1: the address Arc Testnet seeds as blocklisted
    address internal agent;
    address internal payeeA; // OPS, no payee cap
    address internal payeeB; // SUPPLIES, no payee cap
    address internal payeeC; // OPS, payee cap 1,500
    address internal stranger;

    MockUSDC internal usdc;
    SpendPolicy internal policy;

    function setUp() public virtual {
        vm.warp(START);
        ownerKey = vm.deriveKey(TEST_MNEMONIC, 0);
        owner = vm.addr(ownerKey);
        blocked = vm.addr(vm.deriveKey(TEST_MNEMONIC, 1));
        agent = vm.addr(vm.deriveKey(TEST_MNEMONIC, 2));
        payeeA = vm.addr(vm.deriveKey(TEST_MNEMONIC, 3));
        payeeB = vm.addr(vm.deriveKey(TEST_MNEMONIC, 4));
        payeeC = vm.addr(vm.deriveKey(TEST_MNEMONIC, 5));
        stranger = vm.addr(vm.deriveKey(TEST_MNEMONIC, 6));

        usdc = new MockUSDC();
        policy = new SpendPolicy(usdc, owner, agent, PER_PAYMENT, MONTHLY, CEILING, TTL);

        vm.startPrank(owner);
        policy.setCategoryBudget(OPS, OPS_BUDGET);
        policy.setCategoryBudget(SUP, SUP_BUDGET);
        policy.setPayee(payeeA, "Landlord", OPS, 0);
        policy.setPayee(payeeB, "Paper supplier", SUP, 0);
        policy.setPayee(payeeC, "Generator repair", OPS, PAYEE_C_CAP);
        vm.stopPrank();

        usdc.mint(address(policy), FUNDING);
    }

    function _id(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encode("invoice", n));
    }

    function _pay(uint256 n, address payee, uint256 amount, bytes32 cat) internal returns (SpendPolicy.Status) {
        vm.prank(agent);
        return policy.requestPayment(_id(n), payee, amount, cat, REASON, bytes32(0));
    }

    /// @dev Written out independently of the contract's constant, so a typehash change is caught.
    bytes32 internal constant APPROVE_TYPEHASH_EXPECTED = keccak256(
        "ApprovePending(bytes32 paymentId,address payee,uint256 amount,bytes32 category,bytes32 reasonHash,uint64 expiresAt,uint256 ownerEpoch,uint256 nonce,uint256 deadline)"
    );

    /// @dev Approval struct hash; category/reasonHash/expiresAt from the stored payment, ownerEpoch current.
    ///      payee/amount are explicit so tests can tamper with them.
    function _approvalStruct(bytes32 id, address payee, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        SpendPolicy.Payment memory pm = policy.getPayment(id);
        return keccak256(
            abi.encode(
                APPROVE_TYPEHASH_EXPECTED,
                id,
                payee,
                amount,
                pm.category,
                pm.reasonHash,
                pm.expiresAt,
                uint256(policy.ownerEpoch()),
                nonce,
                deadline
            )
        );
    }

    function _approvalDigest(bytes32 id, address payee, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked("\x19\x01", policy.domainSeparator(), _approvalStruct(id, payee, amount, nonce, deadline))
        );
    }

    function _signApproval(uint256 key, bytes32 id, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        SpendPolicy.Payment memory pm = policy.getPayment(id);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _approvalDigest(id, pm.payee, pm.amount, nonce, deadline));
        return abi.encodePacked(r, s, v);
    }

    function _status(uint256 n) internal view returns (SpendPolicy.Status) {
        return policy.getPayment(_id(n)).status;
    }
}
