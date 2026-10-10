// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "../Base.t.sol";
import {SpendPolicy} from "../../src/SpendPolicy.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev Smart-contract owner (Safe / Circle SCA style) that approves exactly one digest via ERC-1271.
contract ContractOwner {
    bytes32 public approvedDigest;

    function exec(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, "exec failed");
        return ret;
    }

    function setApproved(bytes32 d) external {
        approvedDigest = d;
    }

    function isValidSignature(bytes32 h, bytes calldata) external view returns (bytes4) {
        return h == approvedDigest ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

/// @notice The auditor's PoCs (/workspace/payday-audit/src-copy/test/audit/AuditPoC.t.sol), ported as
///         regression tests: each now asserts the FIXED behaviour.
contract AuditRegression is Base {
    function _sig(uint256 key, bytes32 id, uint256 nonce, uint256 deadline) internal view returns (bytes memory) {
        return _signApproval(key, id, nonce, deadline);
    }

    function _req(bytes32 id, address payee, uint256 amount, bytes32 cat, bytes32 key)
        internal
        returns (SpendPolicy.Status)
    {
        vm.prank(agent);
        return policy.requestPayment(id, payee, amount, cat, REASON, key);
    }

    // ============================================================ L-01
    function test_L01_invoiceKeyBlocksSecondPayment() public {
        bytes32 key = keccak256("payee A / INV-0042");
        _req(keccak256("INV-0042"), payeeA, 900 * USDC, OPS, key);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InvoiceAlreadyUsed.selector, key, keccak256("INV-0042")));
        policy.requestPayment(keccak256("INV-0042 "), payeeA, 900 * USDC, OPS, REASON, key);
        assertEq(usdc.balanceOf(payeeA), 900 * USDC);
        assertEq(policy.invoicePayment(key), keccak256("INV-0042"));
    }

    function test_L01_invoiceKeyHeldWhilePending_releasedOnRejectAndExpire() public {
        bytes32 key = keccak256("k");
        _req(_id(1), payeeA, 2_000 * USDC, OPS, key); // pending
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InvoiceAlreadyUsed.selector, key, _id(1)));
        policy.requestPayment(_id(2), payeeA, 900 * USDC, OPS, REASON, key);
        vm.prank(owner);
        policy.rejectPending(_id(1));
        assertEq(policy.invoicePayment(key), bytes32(0));
        _req(_id(3), payeeA, 2_000 * USDC, OPS, key); // pending again
        vm.warp(block.timestamp + TTL + 1);
        policy.expirePending(_id(3));
        assertEq(policy.invoicePayment(key), bytes32(0));
        assertEq(uint8(_req(_id(4), payeeA, 900 * USDC, OPS, key)), uint8(SpendPolicy.Status.Executed));
    }

    /// Without a key there is no on-chain dedup (documented in the README).
    function test_L01_zeroKeyMeansNoDedup() public {
        _req(_id(1), payeeA, 100 * USDC, OPS, bytes32(0));
        _req(_id(2), payeeA, 100 * USDC, OPS, bytes32(0));
        assertEq(usdc.balanceOf(payeeA), 200 * USDC);
    }

    // ============================================================ L-02
    function test_L02_pendingFromRevokedAgentNotApprovable() public {
        _req(_id(1), payeeA, 4_000 * USDC, OPS, 0);
        uint256 dl = block.timestamp + 1 days;
        bytes memory sig = _sig(ownerKey, _id(1), 1, dl); // signed BEFORE rotation
        assertEq(policy.getPayment(_id(1)).agentEpoch, 0);
        vm.prank(owner);
        policy.setAgent(makeAddr("newAgent"));
        assertEq(policy.agentEpoch(), 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.StaleAgentEpoch.selector, _id(1), 0, 1));
        policy.approvePendingWithSig(_id(1), 1, dl, sig);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.StaleAgentEpoch.selector, _id(1), 0, 1));
        policy.approvePending(_id(1));
        vm.prank(owner);
        policy.rejectPending(_id(1)); // the owner can still clean it up
        assertEq(policy.openPending(), 0);
    }

    // ============================================================ L-03
    function test_L03_removeReaddDoesNotRevivePending() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        assertEq(policy.getPayment(_id(1)).payeeEpoch, 1);
        vm.startPrank(owner);
        policy.removePayee(payeeA);
        assertEq(policy.payeeEpoch(payeeA), 2);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.PayeeNotAllowed.selector, payeeA));
        policy.approvePending(_id(1));
        policy.setPayee(payeeA, "Landlord (re-added)", OPS, 0); // same category, still dead
        assertEq(policy.payeeEpoch(payeeA), 3);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.StalePayeeEpoch.selector, _id(1), 1, 3));
        policy.approvePending(_id(1));
        vm.stopPrank();
        assertEq(policy.categorySpentInWindow(OPS), 0);
    }

    function test_L03_categoryChangeBlocksApproval() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        vm.startPrank(owner);
        policy.setPayee(payeeA, "Landlord (now supplies)", SUP, 0); // update in place: epoch unchanged
        assertEq(policy.payeeEpoch(payeeA), 1);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.CategoryMismatch.selector, SUP, OPS));
        policy.approvePending(_id(1));
        policy.setPayee(payeeA, "Landlord", OPS, 0); // back to the original category
        policy.approvePending(_id(1));
        vm.stopPrank();
        assertEq(policy.categorySpentInWindow(OPS), 2_000 * USDC);
    }

    // ============================================================ L-04
    function test_L04_oldOwnerSignatureDeadAfterRoundTrip() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        uint256 dl = block.timestamp + 5 days;
        bytes memory sig = _sig(ownerKey, _id(1), 99, dl);
        assertEq(policy.ownerEpoch(), 1);
        vm.prank(owner);
        policy.transferOwnership(stranger);
        vm.prank(stranger);
        policy.acceptOwnership();
        vm.prank(stranger);
        policy.transferOwnership(owner);
        vm.prank(owner);
        policy.acceptOwnership();
        assertEq(policy.ownerEpoch(), 3);
        vm.expectRevert(SpendPolicy.InvalidSignature.selector);
        policy.approvePendingWithSig(_id(1), 99, dl, sig);
        // a fresh signature under the new epoch works
        policy.approvePendingWithSig(_id(1), 99, dl, _sig(ownerKey, _id(1), 99, dl));
        assertEq(usdc.balanceOf(payeeA), 2_000 * USDC);
    }

    // ============================================================ L-05
    function test_L05_pendingOwnerCannotBecomePayee() public {
        address newOwner = makeAddr("newOwner");
        vm.startPrank(owner);
        policy.transferOwnership(newOwner);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InvalidPayee.selector, newOwner));
        policy.setPayee(newOwner, "new owner", OPS, 0);
        vm.stopPrank();
    }

    function test_L05_payeeCannotBecomeOwner() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InvalidOwner.selector, payeeA));
        policy.transferOwnership(payeeA);
    }

    /// acceptOwnership choice: REVERT if the pending owner is an allowed payee (defence in depth;
    /// reachable only if the payee was allow-listed before the transfer was started... which
    /// transferOwnership also refuses, so we force the state with a stored pending owner).
    function test_L05_acceptOwnershipRefusesAllowedPayee() public {
        address newOwner = makeAddr("newOwner2");
        vm.startPrank(owner);
        policy.setPayee(newOwner, "vendor", OPS, 0);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InvalidOwner.selector, newOwner));
        policy.transferOwnership(newOwner);
        policy.removePayee(newOwner);
        policy.transferOwnership(newOwner);
        vm.stopPrank();
        // force the allow-list entry back (storage) to reach the acceptOwnership guard
        bytes32 slot = keccak256(abi.encode(newOwner, uint256(_payeesSlot())));
        vm.store(address(policy), slot, bytes32(uint256(1)));
        assertTrue(policy.getPayee(newOwner).allowed);
        vm.prank(newOwner);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InvalidOwner.selector, newOwner));
        policy.acceptOwnership();
    }

    function _payeesSlot() internal view returns (uint256 s) {
        // locate `_payees` by probing: payeeA is allowed, so its Payee.allowed word is 1
        for (s = 0; s < 40; ++s) {
            if (vm.load(address(policy), keccak256(abi.encode(payeeA, s))) == bytes32(uint256(1))) return s;
        }
        revert("slot not found");
    }

    function test_L05b_oldAgentCannotBeAllowListed() public {
        vm.startPrank(owner);
        policy.setAgent(makeAddr("agent2"));
        assertTrue(policy.wasAgent(agent));
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InvalidPayee.selector, agent));
        policy.setPayee(agent, "old agent", OPS, 0);
        vm.stopPrank();
    }

    function test_L05_setAgentRefusesPayee() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InvalidAgent.selector, payeeA));
        policy.setAgent(payeeA);
    }

    // ============================================================ L-06
    function test_L06_agentCannotCancel() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        uint256 dl = block.timestamp + 1 days;
        bytes memory sig = _sig(ownerKey, _id(1), 1, dl);
        vm.prank(agent);
        (bool ok,) = address(policy).call(abi.encodeWithSignature("cancelPending(bytes32)", _id(1)));
        assertFalse(ok);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent));
        policy.rejectPending(_id(1));
        policy.approvePendingWithSig(_id(1), 1, dl, sig);
        assertEq(usdc.balanceOf(payeeA), 2_000 * USDC);
    }

    function test_L06b_pendingFloodCapped() public {
        assertEq(policy.maxOpenPending(), 20);
        vm.startPrank(agent);
        for (uint256 i; i < 20; ++i) {
            policy.requestPayment(keccak256(abi.encode("flood", i)), payeeB, 19_999 * USDC, SUP, REASON, 0);
        }
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.TooManyOpenPending.selector, 20));
        policy.requestPayment(keccak256(abi.encode("flood", 20)), payeeB, 19_999 * USDC, SUP, REASON, 0);
        // auto-pay still works while the queue is full
        assertEq(
            uint8(policy.requestPayment(keccak256("small"), payeeB, 1, SUP, REASON, 0)),
            uint8(SpendPolicy.Status.Executed)
        );
        vm.stopPrank();
        assertEq(policy.openPending(), 20);
        vm.prank(owner);
        policy.rejectPending(keccak256(abi.encode("flood", 0)));
        assertEq(policy.openPending(), 19);
        vm.prank(agent);
        policy.requestPayment(keccak256(abi.encode("flood", 20)), payeeB, 19_999 * USDC, SUP, REASON, 0);
    }

    function test_L06_openPendingCounter_allTransitions() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        _pay(2, payeeA, 2_000 * USDC, OPS);
        _pay(3, payeeA, 2_000 * USDC, OPS);
        assertEq(policy.openPending(), 3);
        vm.prank(owner);
        policy.approvePending(_id(1));
        assertEq(policy.openPending(), 2);
        vm.prank(owner);
        policy.rejectPending(_id(2));
        assertEq(policy.openPending(), 1);
        vm.warp(block.timestamp + TTL + 1);
        policy.expirePending(_id(3));
        assertEq(policy.openPending(), 0);
    }

    function test_L06_setMaxOpenPending_onlyOwner_andZeroBlocksPending() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, agent));
        policy.setMaxOpenPending(100);
        vm.expectEmit(address(policy));
        emit SpendPolicy.MaxOpenPendingSet(20, 0);
        vm.prank(owner);
        policy.setMaxOpenPending(0);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.TooManyOpenPending.selector, 0));
        policy.requestPayment(_id(1), payeeA, 2_000 * USDC, OPS, REASON, 0);
    }

    // ============================================================ I-01
    function test_I01_contractOwnerCanUseERC1271() public {
        ContractOwner co = new ContractOwner();
        vm.prank(owner);
        policy.transferOwnership(address(co));
        co.exec(address(policy), abi.encodeWithSignature("acceptOwnership()"));
        _pay(1, payeeA, 2_000 * USDC, OPS);
        uint256 dl = block.timestamp + 1 days;
        // an EOA signature (old owner key) is not the contract owner's
        bytes memory eoaSig = _sig(ownerKey, _id(1), 1, dl);
        vm.expectRevert(SpendPolicy.InvalidSignature.selector);
        policy.approvePendingWithSig(_id(1), 1, dl, eoaSig);
        // the wallet approves the digest, independently computed
        SpendPolicy.Payment memory pm = policy.getPayment(_id(1));
        bytes32 d = _approvalDigest(_id(1), pm.payee, pm.amount, 1, dl);
        assertEq(d, policy.approvalDigest(_id(1), 1, dl));
        co.setApproved(d);
        vm.prank(stranger);
        policy.approvePendingWithSig(_id(1), 1, dl, hex"00");
        assertEq(usdc.balanceOf(payeeA), 2_000 * USDC);
    }

    // ============================================================ I-05
    function test_I05_signatureBindsAllFields() public {
        assertEq(policy.APPROVE_TYPEHASH(), APPROVE_TYPEHASH_EXPECTED);
        _pay(1, payeeA, 2_000 * USDC, OPS);
        SpendPolicy.Payment memory pm = policy.getPayment(_id(1));
        uint256 dl = block.timestamp + 1 days;
        // a signature over the old 5-field struct is refused
        bytes32 oldType =
            keccak256("ApprovePending(bytes32 paymentId,address payee,uint256 amount,uint256 nonce,uint256 deadline)");
        bytes32 oldDigest = keccak256(
            abi.encodePacked(
                "\x19\x01", policy.domainSeparator(), keccak256(abi.encode(oldType, _id(1), payeeA, pm.amount, 1, dl))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, oldDigest);
        vm.expectRevert(SpendPolicy.InvalidSignature.selector);
        policy.approvePendingWithSig(_id(1), 1, dl, abi.encodePacked(r, s, v));
        // wrong category / reasonHash / expiresAt / ownerEpoch each break it
        for (uint256 f; f < 4; ++f) {
            bytes memory bad = _mutatedSig(f, pm, dl);
            vm.expectRevert(SpendPolicy.InvalidSignature.selector);
            policy.approvePendingWithSig(_id(1), 1, dl, bad);
        }
        policy.approvePendingWithSig(_id(1), 1, dl, _sig(ownerKey, _id(1), 1, dl));
    }

    function _mutatedSig(uint256 f, SpendPolicy.Payment memory pm, uint256 dl) internal view returns (bytes memory) {
        bytes32 sh = keccak256(
            abi.encode(
                APPROVE_TYPEHASH_EXPECTED,
                _id(1),
                pm.payee,
                pm.amount,
                f == 0 ? SUP : pm.category,
                f == 1 ? bytes32(0) : pm.reasonHash,
                f == 2 ? pm.expiresAt + 1 : pm.expiresAt,
                f == 3 ? uint256(policy.ownerEpoch()) + 1 : uint256(policy.ownerEpoch()),
                uint256(1),
                dl
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerKey, keccak256(abi.encodePacked("\x19\x01", policy.domainSeparator(), sh)));
        return abi.encodePacked(r, s, v);
    }

    // ============================================================ T-02 stale bucket
    /// Kills M10: after exactly 31 days the ring slot for day D is reused; its old amount must be
    /// discarded, not added, in all three windows.
    function test_T02_reusedSlotDiscardsStaleAmount() public {
        _pay(1, payeeA, PER_PAYMENT, OPS);
        vm.warp(START + 31 days);
        _pay(2, payeeA, 1, OPS);
        assertEq(policy.spentInWindow(), 1);
        assertEq(policy.categorySpentInWindow(OPS), 1);
        assertEq(policy.payeeSpentInWindow(payeeA), 1);
    }

    function test_T02_hugeTimeJumpAndStaleBuckets() public {
        _pay(1, payeeA, PER_PAYMENT, OPS);
        vm.warp(START + 31 days * 1000 + 5 hours);
        assertEq(policy.spentInWindow(), 0);
        assertEq(uint8(_pay(2, payeeA, PER_PAYMENT, OPS)), uint8(SpendPolicy.Status.Executed));
        assertEq(policy.spentInWindow(), PER_PAYMENT);
        vm.warp(type(uint64).max - 100 days);
        assertEq(uint8(_pay(3, payeeA, 2 * PER_PAYMENT, OPS)), uint8(SpendPolicy.Status.Pending));
    }

    /// Liveness: a fully in-cap request must execute (kills M03-style mutants).
    function test_T01_inCapRequestAlwaysExecutes(uint256 amount) public {
        amount = bound(amount, 1, PER_PAYMENT);
        assertEq(uint8(_pay(1, payeeA, amount, OPS)), uint8(SpendPolicy.Status.Executed));
        assertEq(usdc.balanceOf(payeeA), amount);
    }

    // ============================================================ unchanged-behaviour PoCs
    function test_I02_approvalIgnoresLoweredCaps_byDesign() public {
        _pay(1, payeeC, 1_200 * USDC, OPS);
        vm.startPrank(owner);
        policy.setPerPaymentCap(0);
        policy.setMonthlyCap(0);
        policy.setCategoryBudget(OPS, 0);
        policy.setPayee(payeeC, "Generator repair", OPS, 1);
        policy.approvePending(_id(1));
        vm.stopPrank();
        assertEq(usdc.balanceOf(payeeC), 1_200 * USDC);
    }

    function test_I03_windowIs31Days() public {
        vm.startPrank(owner);
        policy.setPerPaymentCap(MONTHLY);
        policy.setCategoryBudget(SUP, MONTHLY);
        vm.stopPrank();
        _pay(1, payeeB, MONTHLY, SUP);
        vm.warp(START + 30 days + 12 hours);
        assertEq(uint8(_pay(2, payeeB, 1, SUP)), uint8(SpendPolicy.Status.Pending));
        vm.warp(START + 31 days);
        assertEq(uint8(_pay(3, payeeB, 1, SUP)), uint8(SpendPolicy.Status.Executed));
    }

    function test_ok_malleableSignatureRejected() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        uint256 dl = block.timestamp + 1 days;
        SpendPolicy.Payment memory pm = policy.getPayment(_id(1));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, _approvalDigest(_id(1), pm.payee, pm.amount, 1, dl));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        vm.expectRevert(SpendPolicy.InvalidSignature.selector);
        policy.approvePendingWithSig(_id(1), 1, dl, abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? 28 : 27));
        policy.approvePendingWithSig(_id(1), 1, dl, abi.encodePacked(r, s, v));
    }

    function test_ok_noDoubleApprove() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        uint256 dl = block.timestamp + 1 days;
        bytes memory sig = _sig(ownerKey, _id(1), 1, dl);
        vm.prank(owner);
        policy.approvePending(_id(1));
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.NotPending.selector, _id(1)));
        policy.approvePendingWithSig(_id(1), 1, dl, sig);
    }

    function test_ok_withdrawThenApproveRevertsCleanly() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        vm.startPrank(owner);
        policy.withdraw(owner, FUNDING);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InsufficientBalance.selector, 0, 2_000 * USDC));
        policy.approvePending(_id(1));
        vm.stopPrank();
        assertEq(uint8(_status(1)), uint8(SpendPolicy.Status.Pending));
        assertEq(policy.openPending(), 1);
    }
}
