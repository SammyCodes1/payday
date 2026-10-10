// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {SpendPolicy} from "../src/SpendPolicy.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {FalseReturnToken, ReentrantToken} from "./mocks/BadTokens.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Malicious tokens, USDC blocklist, and EIP-712 signed approvals.
contract AdversarialTest is Base {
    // ============================================================ blocklisted payee (USDC blocklist)

    function test_blocklist_paymentRevertsCleanly() public {
        vm.prank(owner);
        policy.setPayee(blocked, "Blocked vendor", OPS, 0);
        usdc.setBlacklisted(blocked, true);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blacklisted.selector, blocked));
        policy.requestPayment(_id(1), blocked, 100 * USDC, OPS, REASON, bytes32(0));

        // No stuck state: id unused, totals and windows untouched, funds still here.
        assertEq(uint8(_status(1)), uint8(SpendPolicy.Status.None));
        assertEq(policy.totalPaid(), 0);
        assertEq(policy.spentInWindow(), 0);
        assertEq(policy.categorySpentInWindow(OPS), 0);
        assertEq(policy.payeeSpentInWindow(blocked), 0);
        assertEq(usdc.balanceOf(address(policy)), FUNDING);

        // If Circle later un-blocks the address, the same invoice can be paid normally.
        usdc.setBlacklisted(blocked, false);
        assertEq(uint8(_pay(1, blocked, 100 * USDC, OPS)), uint8(SpendPolicy.Status.Executed));
    }

    function test_blocklist_pendingApproveReverts_thenRejectable() public {
        vm.prank(owner);
        policy.setPayee(blocked, "Blocked vendor", OPS, 0);
        _pay(1, blocked, 2_000 * USDC, OPS); // pending (over per-payment cap)
        usdc.setBlacklisted(blocked, true);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blacklisted.selector, blocked));
        policy.approvePending(_id(1));
        assertEq(uint8(_status(1)), uint8(SpendPolicy.Status.Pending));
        assertEq(policy.totalPaid(), 0);

        vm.prank(owner);
        policy.rejectPending(_id(1));
        assertEq(uint8(_status(1)), uint8(SpendPolicy.Status.Rejected));
    }

    function test_blocklist_policyItselfBlocked_revertsCleanly() public {
        usdc.setBlacklisted(address(policy), true);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blacklisted.selector, address(policy)));
        policy.requestPayment(_id(1), payeeA, 1, OPS, REASON, bytes32(0));
        assertEq(policy.totalPaid(), 0);
    }

    // ============================================================ token that returns false

    function test_falseReturningToken_revertsCleanly() public {
        FalseReturnToken t = new FalseReturnToken();
        SpendPolicy p = new SpendPolicy(IERC20(address(t)), owner, agent, PER_PAYMENT, MONTHLY, CEILING, TTL);
        vm.startPrank(owner);
        p.setCategoryBudget(OPS, OPS_BUDGET);
        p.setPayee(payeeA, "A", OPS, 0);
        vm.stopPrank();
        t.mint(address(p), FUNDING);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(t)));
        p.requestPayment(_id(1), payeeA, 1, OPS, REASON, bytes32(0));
        assertEq(p.totalPaid(), 0);
        assertEq(uint8(p.getPayment(_id(1)).status), uint8(SpendPolicy.Status.None));
    }

    // ============================================================ reentrancy via malicious token

    /// Policy whose AGENT is the malicious token, so a re-entrant requestPayment passes the role
    /// check and is stopped only by the reentrancy guard.
    function _evilAgentPolicy() internal returns (ReentrantToken evil, SpendPolicy p) {
        evil = new ReentrantToken();
        p = new SpendPolicy(IERC20(address(evil)), owner, address(evil), PER_PAYMENT, MONTHLY, CEILING, TTL);
        vm.startPrank(owner);
        p.setCategoryBudget(OPS, OPS_BUDGET);
        p.setPayee(payeeA, "A", OPS, 0);
        vm.stopPrank();
        evil.mint(address(p), FUNDING);
    }

    function test_reentrancy_requestPayment_bubbles() public {
        (ReentrantToken evil, SpendPolicy p) = _evilAgentPolicy();
        evil.arm(p, 1, true, _id(2), payeeA, OPS);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        evil.exec(abi.encodeCall(SpendPolicy.requestPayment, (_id(1), payeeA, 10, OPS, REASON, bytes32(0))));
        assertEq(p.totalPaid(), 0);
    }

    function test_reentrancy_requestPayment_swallowed_onlyOnePays() public {
        (ReentrantToken evil, SpendPolicy p) = _evilAgentPolicy();
        evil.arm(p, 1, false, _id(2), payeeA, OPS);
        evil.exec(abi.encodeCall(SpendPolicy.requestPayment, (_id(1), payeeA, 10, OPS, REASON, bytes32(0))));
        assertTrue(evil.attempted());
        assertEq(bytes4(evil.lastError()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(p.totalPaid(), 10);
        assertEq(evil.balanceOf(payeeA), 10);
        assertEq(uint8(p.getPayment(_id(2)).status), uint8(SpendPolicy.Status.None));
    }

    /// Policy whose OWNER is the malicious token: re-entering approvePending / withdraw is blocked.
    function test_reentrancy_approveAndWithdraw_blocked() public {
        ReentrantToken evil = new ReentrantToken();
        SpendPolicy p = new SpendPolicy(IERC20(address(evil)), address(evil), agent, PER_PAYMENT, MONTHLY, CEILING, TTL);
        evil.arm(p, 0, false, bytes32(0), address(0), bytes32(0));
        evil.exec(abi.encodeCall(SpendPolicy.setCategoryBudget, (OPS, OPS_BUDGET)));
        evil.exec(abi.encodeCall(SpendPolicy.setPayee, (payeeA, "A", OPS, 0)));
        evil.mint(address(p), FUNDING);

        vm.startPrank(agent);
        p.requestPayment(_id(1), payeeA, 2_000 * USDC, OPS, REASON, bytes32(0)); // pending
        p.requestPayment(_id(2), payeeA, 2_000 * USDC, OPS, REASON, bytes32(0)); // pending
        vm.stopPrank();

        evil.arm(p, 2, false, _id(2), address(0), bytes32(0)); // re-enter approvePending(id2)
        evil.exec(abi.encodeCall(SpendPolicy.approvePending, (_id(1))));
        assertEq(bytes4(evil.lastError()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(uint8(p.getPayment(_id(2)).status), uint8(SpendPolicy.Status.Pending));
        assertEq(p.totalPaid(), 2_000 * USDC);
    }

    function test_reentrancy_withdraw_blocked() public {
        ReentrantToken evil = new ReentrantToken();
        SpendPolicy p = new SpendPolicy(IERC20(address(evil)), address(evil), agent, PER_PAYMENT, MONTHLY, CEILING, TTL);
        evil.mint(address(p), FUNDING);
        evil.arm(p, 3, true, bytes32(0), address(0), bytes32(0));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        evil.exec(abi.encodeCall(SpendPolicy.withdraw, (address(evil), 5)));
    }

    // ============================================================ EIP-712 signed owner approval

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function _digest(
        address verifying,
        uint256 chainId,
        bytes32 id,
        address payee,
        uint256 amount,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("Payday SpendPolicy"), keccak256("1"), chainId, verifying)
        );
        bytes32 structHash = _approvalStruct(id, payee, amount, nonce, deadline);
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _ownerSig(bytes32 id, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _sign(ownerKey, _digest(address(policy), block.chainid, id, payeeA, amount, nonce, deadline));
    }

    function test_sig_domainSeparatorMatchesSpec() public view {
        bytes32 expected = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("Payday SpendPolicy"), keccak256("1"), block.chainid, address(policy))
        );
        assertEq(policy.domainSeparator(), expected);
    }

    function test_sig_relayerSubmitsOwnerApproval() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _ownerSig(_id(1), 2_000 * USDC, 1, deadline);
        vm.expectEmit(address(policy));
        emit SpendPolicy.PaymentApproved(_id(1), owner, REASON);
        vm.prank(stranger); // relayer / sponsored tx sender
        policy.approvePendingWithSig(_id(1), 1, deadline, sig);
        assertEq(usdc.balanceOf(payeeA), 2_000 * USDC);
        assertTrue(policy.nonceUsed(1));
    }

    function test_sig_replayRejected() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        _pay(2, payeeA, 2_000 * USDC, OPS);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _ownerSig(_id(1), 2_000 * USDC, 1, deadline);
        policy.approvePendingWithSig(_id(1), 1, deadline, sig);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.NonceAlreadyUsed.selector, 1));
        policy.approvePendingWithSig(_id(1), 1, deadline, sig);
        // same nonce, different payment: still refused
        bytes memory sig2 = _ownerSig(_id(2), 2_000 * USDC, 1, deadline);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.NonceAlreadyUsed.selector, 1));
        policy.approvePendingWithSig(_id(2), 1, deadline, sig2);
    }

    function test_sig_deadlineBoundary() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        _pay(2, payeeA, 2_000 * USDC, OPS);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig1 = _ownerSig(_id(1), 2_000 * USDC, 1, deadline);
        bytes memory sig2 = _ownerSig(_id(2), 2_000 * USDC, 2, deadline);
        vm.warp(deadline); // at the deadline: ok
        policy.approvePendingWithSig(_id(1), 1, deadline, sig1);
        vm.warp(deadline + 1); // past it: refused
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.SignatureExpired.selector, deadline));
        policy.approvePendingWithSig(_id(2), 2, deadline, sig2);
    }

    function test_sig_wrongSigner_rejected() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 agentKey = vm.deriveKey(TEST_MNEMONIC, 2);
        bytes memory sig =
            _sign(agentKey, _digest(address(policy), block.chainid, _id(1), payeeA, 2_000 * USDC, 1, deadline));
        vm.expectRevert(SpendPolicy.InvalidSignature.selector);
        policy.approvePendingWithSig(_id(1), 1, deadline, sig);
    }

    function test_sig_tamperedAmountOrPayee_rejected() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sigAmt = _ownerSig(_id(1), 1_999 * USDC, 1, deadline);
        vm.expectRevert(SpendPolicy.InvalidSignature.selector);
        policy.approvePendingWithSig(_id(1), 1, deadline, sigAmt);
        bytes memory sigPayee =
            _sign(ownerKey, _digest(address(policy), block.chainid, _id(1), payeeB, 2_000 * USDC, 1, deadline));
        vm.expectRevert(SpendPolicy.InvalidSignature.selector);
        policy.approvePendingWithSig(_id(1), 1, deadline, sigPayee);
    }

    function test_sig_otherContract_rejected() public {
        SpendPolicy other = new SpendPolicy(usdc, owner, agent, PER_PAYMENT, MONTHLY, CEILING, TTL);
        _pay(1, payeeA, 2_000 * USDC, OPS);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig =
            _sign(ownerKey, _digest(address(other), block.chainid, _id(1), payeeA, 2_000 * USDC, 1, deadline));
        vm.expectRevert(SpendPolicy.InvalidSignature.selector);
        policy.approvePendingWithSig(_id(1), 1, deadline, sig);
    }

    function test_sig_otherChain_rejected() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sigMainnet =
            _sign(ownerKey, _digest(address(policy), 1, _id(1), payeeA, 2_000 * USDC, 1, deadline));
        vm.expectRevert(SpendPolicy.InvalidSignature.selector);
        policy.approvePendingWithSig(_id(1), 1, deadline, sigMainnet);

        // A signature made for this chain is useless after a chain-id change (fork replay).
        bytes memory sigHere = _ownerSig(_id(1), 2_000 * USDC, 1, deadline);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(SpendPolicy.InvalidSignature.selector);
        policy.approvePendingWithSig(_id(1), 1, deadline, sigHere);
    }

    function test_sig_invalidatedNonce_rejected() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _ownerSig(_id(1), 2_000 * USDC, 7, deadline);
        vm.prank(owner);
        policy.invalidateNonce(7);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.NonceAlreadyUsed.selector, 7));
        policy.approvePendingWithSig(_id(1), 7, deadline, sig);
    }

    function test_sig_oldOwnerSignatureDeadAfterTransfer() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _ownerSig(_id(1), 2_000 * USDC, 1, deadline);
        vm.prank(owner);
        policy.transferOwnership(stranger);
        vm.prank(stranger);
        policy.acceptOwnership();
        vm.expectRevert(SpendPolicy.InvalidSignature.selector);
        policy.approvePendingWithSig(_id(1), 1, deadline, sig);
    }

    function test_sig_pausedOrNotPendingOrMalformed_rejected() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _ownerSig(_id(1), 2_000 * USDC, 1, deadline);
        vm.prank(owner);
        policy.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        policy.approvePendingWithSig(_id(1), 1, deadline, sig);
        vm.prank(owner);
        policy.unpause();

        vm.expectRevert(SpendPolicy.InvalidSignature.selector); // SignatureChecker semantics: bad length = invalid
        policy.approvePendingWithSig(_id(1), 1, deadline, hex"010203");

        // A valid owner signature over an unknown id (payee 0, amount 0) still cannot pay anything.
        bytes memory ghost =
            _sign(ownerKey, _digest(address(policy), block.chainid, _id(9), address(0), 0, 2, deadline));
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.NotPending.selector, _id(9)));
        policy.approvePendingWithSig(_id(9), 2, deadline, ghost);
    }

    function test_sig_stillRespectsCeilingAndExpiry() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        uint256 deadline = block.timestamp + 30 days;
        bytes memory sig = _ownerSig(_id(1), 2_000 * USDC, 1, deadline);
        vm.prank(owner);
        policy.lowerGlobalCeiling(1_999 * USDC);
        vm.expectRevert(
            abi.encodeWithSelector(SpendPolicy.GlobalCeilingExceeded.selector, 0, 2_000 * USDC, 1_999 * USDC)
        );
        policy.approvePendingWithSig(_id(1), 1, deadline, sig);

        _pay(2, payeeA, 1_500 * USDC, OPS);
        bytes memory sig2 = _ownerSig(_id(2), 1_500 * USDC, 2, deadline);
        vm.warp(block.timestamp + TTL + 1);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.ApprovalWindowClosed.selector, _id(2), uint64(START + TTL)));
        policy.approvePendingWithSig(_id(2), 2, deadline, sig2);
    }
}
