// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {SpendPolicy} from "../src/SpendPolicy.sol";
import {MockUSDC, Mock18} from "./mocks/MockUSDC.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice One unit test per rule, with an "at the boundary" and a "past it" case for every limit.
contract SpendPolicyTest is Base {
    // ------------------------------------------------------------- helpers

    function _assertStatus(uint256 n, SpendPolicy.Status s) internal view {
        assertEq(uint8(_status(n)), uint8(s));
    }

    /// Spends exactly MONTHLY in the current window: OPS 3x1000 (= OPS budget) + SUPPLIES 2x1000.
    function _fillMonthly(uint256 base) internal {
        for (uint256 i; i < 3; ++i) {
            assertEq(uint8(_pay(base + i, payeeA, PER_PAYMENT, OPS)), uint8(SpendPolicy.Status.Executed));
        }
        for (uint256 i = 3; i < 5; ++i) {
            assertEq(uint8(_pay(base + i, payeeB, PER_PAYMENT, SUP)), uint8(SpendPolicy.Status.Executed));
        }
        assertEq(policy.spentInWindow(), MONTHLY);
    }

    // ------------------------------------------------------------- constructor

    function test_constructor_setsState() public view {
        assertEq(address(policy.token()), address(usdc));
        assertEq(policy.owner(), owner);
        assertEq(policy.agent(), agent);
        assertEq(policy.perPaymentCap(), PER_PAYMENT);
        assertEq(policy.monthlyCap(), MONTHLY);
        assertEq(policy.globalCeiling(), CEILING);
        assertEq(policy.pendingTtl(), TTL);
        assertEq(policy.TOKEN_DECIMALS(), 6);
    }

    function test_constructor_rejectsBadArgs() public {
        vm.expectRevert(SpendPolicy.ZeroAddress.selector);
        new SpendPolicy(IERC20(address(0)), owner, agent, 1, 1, 1, TTL);
        vm.expectRevert(SpendPolicy.ZeroAddress.selector);
        new SpendPolicy(usdc, owner, address(0), 1, 1, 1, TTL);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new SpendPolicy(usdc, address(0), agent, 1, 1, 1, TTL);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InvalidAgent.selector, owner));
        new SpendPolicy(usdc, owner, owner, 1, 1, 1, TTL);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InvalidPendingTtl.selector, 1 days - 1));
        new SpendPolicy(usdc, owner, agent, 1, 1, 1, 1 days - 1);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InvalidPendingTtl.selector, 90 days + 1));
        new SpendPolicy(usdc, owner, agent, 1, 1, 1, 90 days + 1);
        uint256 tooHigh = uint256(type(uint128).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.CeilingTooHigh.selector, tooHigh));
        new SpendPolicy(usdc, owner, agent, 1, 1, tooHigh, TTL);
    }

    function test_constructor_acceptsTtlBoundaries() public {
        new SpendPolicy(usdc, owner, agent, 1, 1, 1, 1 days);
        new SpendPolicy(usdc, owner, agent, 1, 1, type(uint128).max, 90 days);
    }

    // ------------------------------------------------------------- decimals (Arc USDC ERC-20 = 6)

    function test_decimals_rejects18DecimalToken() public {
        Mock18 t18 = new Mock18();
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.WrongTokenDecimals.selector, uint8(18)));
        new SpendPolicy(IERC20(address(t18)), owner, agent, 1, 1, 1, TTL);
    }

    function test_decimals_smallestUnitPays() public {
        _pay(1, payeeA, 1, OPS); // 0.000001 USDC
        assertEq(usdc.balanceOf(payeeA), 1);
        _assertStatus(1, SpendPolicy.Status.Executed);
    }

    function test_decimals_capsAreInMicroUsdc() public {
        // 1,000.000000 USDC is exactly the cap; 1,000.000001 is one micro-unit over.
        assertEq(uint8(_pay(1, payeeA, 1_000_000_000, OPS)), uint8(SpendPolicy.Status.Executed));
        assertEq(uint8(_pay(2, payeeA, 1_000_000_001, OPS)), uint8(SpendPolicy.Status.Pending));
        assertEq(usdc.balanceOf(payeeA), 1_000 * 10 ** 6);
    }

    // ------------------------------------------------------------- happy path + events

    function test_pay_withinCaps_executesAndEmits() public {
        vm.expectEmit(address(policy));
        emit SpendPolicy.PaymentExecuted(_id(1), payeeA, 250 * USDC, OPS, REASON, false);
        SpendPolicy.Status s = _pay(1, payeeA, 250 * USDC, OPS);
        assertEq(uint8(s), uint8(SpendPolicy.Status.Executed));
        assertEq(usdc.balanceOf(payeeA), 250 * USDC);
        assertEq(policy.totalPaid(), 250 * USDC);
        assertEq(policy.spentInWindow(), 250 * USDC);
        assertEq(policy.categorySpentInWindow(OPS), 250 * USDC);
        assertEq(policy.payeeSpentInWindow(payeeA), 250 * USDC);
        SpendPolicy.Payment memory p = policy.getPayment(_id(1));
        assertEq(p.payee, payeeA);
        assertEq(p.amount, 250 * USDC);
        assertEq(p.reasonHash, REASON);
    }

    // ------------------------------------------------------------- per-payment cap

    function test_perPaymentCap_atBoundary_executes() public {
        assertEq(uint8(_pay(1, payeeA, PER_PAYMENT, OPS)), uint8(SpendPolicy.Status.Executed));
    }

    function test_perPaymentCap_past_goesPending() public {
        vm.expectEmit(address(policy));
        emit SpendPolicy.PaymentPending(
            _id(1),
            payeeA,
            PER_PAYMENT + 1,
            OPS,
            REASON,
            policy.OVER_PER_PAYMENT_CAP(),
            uint64(block.timestamp + TTL),
            bytes32(0),
            uint32(0),
            uint32(1)
        );
        assertEq(uint8(_pay(1, payeeA, PER_PAYMENT + 1, OPS)), uint8(SpendPolicy.Status.Pending));
        assertEq(usdc.balanceOf(payeeA), 0);
        assertEq(policy.totalPaid(), 0);
    }

    // ------------------------------------------------------------- monthly cap

    function test_monthlyCap_atBoundary_executes() public {
        _fillMonthly(1); // last payment lands exactly on MONTHLY
    }

    function test_monthlyCap_past_goesPending() public {
        _fillMonthly(1);
        vm.expectEmit(address(policy));
        emit SpendPolicy.PaymentPending(
            _id(10),
            payeeB,
            1,
            SUP,
            REASON,
            policy.OVER_MONTHLY_CAP(),
            uint64(block.timestamp + TTL),
            bytes32(0),
            uint32(0),
            uint32(1)
        );
        assertEq(uint8(_pay(10, payeeB, 1, SUP)), uint8(SpendPolicy.Status.Pending));
    }

    // ------------------------------------------------------------- monthly window edge (rolling 30 days)

    function test_window_edge_noDoubleSpendAcrossDayBoundary() public {
        vm.warp(START + 1 days - 1); // last second of day D
        _fillMonthly(1);
        vm.warp(START + 1 days); // first second of day D+1: a fixed-epoch design would reset here
        assertEq(uint8(_pay(10, payeeB, 1, SUP)), uint8(SpendPolicy.Status.Pending));
    }

    function test_window_edge_stillBlockedOnLastDayOfWindow() public {
        _fillMonthly(1); // day D, 00:00:00
        vm.warp(START + 31 days - 1); // last second of day D+30 (30d 23:59:59 later)
        assertEq(uint8(_pay(10, payeeB, 1, SUP)), uint8(SpendPolicy.Status.Pending));
        assertEq(policy.spentInWindow(), MONTHLY);
    }

    function test_window_edge_freesOnDay31() public {
        vm.warp(START + 1 days - 1); // pay at the very end of day D
        _fillMonthly(1);
        vm.warp(START + 31 days); // first second of day D+31 (> 30 days after every payment)
        assertEq(policy.spentInWindow(), 0);
        assertEq(uint8(_pay(10, payeeB, PER_PAYMENT, SUP)), uint8(SpendPolicy.Status.Executed));
    }

    function test_window_partialRollOff() public {
        _pay(1, payeeA, PER_PAYMENT, OPS); // day D
        vm.warp(START + 10 days);
        _pay(2, payeeA, PER_PAYMENT, OPS); // day D+10
        vm.warp(START + 31 days); // D drops out, D+10 still in
        assertEq(policy.spentInWindow(), PER_PAYMENT);
        assertEq(policy.categorySpentInWindow(OPS), PER_PAYMENT);
    }

    // ------------------------------------------------------------- category budgets vs total

    function test_categoryBudget_atBoundary_executes() public {
        for (uint256 i; i < 3; ++i) {
            _pay(i, payeeA, PER_PAYMENT, OPS);
        }
        assertEq(policy.categorySpentInWindow(OPS), OPS_BUDGET);
        _assertStatus(2, SpendPolicy.Status.Executed);
    }

    function test_categoryBudget_past_goesPending_otherCategoryStillPays() public {
        for (uint256 i; i < 3; ++i) {
            _pay(i, payeeA, PER_PAYMENT, OPS);
        }
        vm.expectEmit(address(policy));
        emit SpendPolicy.PaymentPending(
            _id(10),
            payeeA,
            1,
            OPS,
            REASON,
            policy.OVER_CATEGORY_BUDGET(),
            uint64(block.timestamp + TTL),
            bytes32(0),
            uint32(0),
            uint32(1)
        );
        assertEq(uint8(_pay(10, payeeA, 1, OPS)), uint8(SpendPolicy.Status.Pending)); // monthly still has 2k room
        assertEq(uint8(_pay(11, payeeB, PER_PAYMENT, SUP)), uint8(SpendPolicy.Status.Executed));
    }

    function test_totalBinds_whenCategoriesStillHaveRoom() public {
        // OPS 2,500 + SUP 2,500 = 5,000 = MONTHLY, while each category still has 500 left.
        _pay(1, payeeA, PER_PAYMENT, OPS);
        _pay(2, payeeA, PER_PAYMENT, OPS);
        _pay(3, payeeA, 500 * USDC, OPS);
        _pay(4, payeeB, PER_PAYMENT, SUP);
        _pay(5, payeeB, PER_PAYMENT, SUP);
        _pay(6, payeeB, 500 * USDC, SUP);
        vm.expectEmit(address(policy));
        emit SpendPolicy.PaymentPending(
            _id(7),
            payeeB,
            1,
            SUP,
            REASON,
            policy.OVER_MONTHLY_CAP(),
            uint64(block.timestamp + TTL),
            bytes32(0),
            uint32(0),
            uint32(1)
        );
        _pay(7, payeeB, 1, SUP);
    }

    function test_categoryWithoutBudget_neverAutoPays() public {
        bytes32 legal = "LEGAL";
        vm.prank(owner);
        policy.setPayee(stranger, "Lawyer", legal, 0);
        assertEq(uint8(_pay(1, stranger, 1, legal)), uint8(SpendPolicy.Status.Pending));
    }

    function test_categoryMismatch_reverts() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.CategoryMismatch.selector, OPS, SUP));
        policy.requestPayment(_id(1), payeeA, 1, SUP, REASON, bytes32(0));
    }

    // ------------------------------------------------------------- per-payee cap

    function test_payeeCap_atBoundary_executes() public {
        _pay(1, payeeC, PER_PAYMENT, OPS);
        assertEq(uint8(_pay(2, payeeC, PAYEE_C_CAP - PER_PAYMENT, OPS)), uint8(SpendPolicy.Status.Executed));
        assertEq(policy.payeeSpentInWindow(payeeC), PAYEE_C_CAP);
    }

    function test_payeeCap_past_goesPending() public {
        _pay(1, payeeC, PER_PAYMENT, OPS);
        _pay(2, payeeC, PAYEE_C_CAP - PER_PAYMENT, OPS);
        vm.expectEmit(address(policy));
        emit SpendPolicy.PaymentPending(
            _id(3),
            payeeC,
            1,
            OPS,
            REASON,
            policy.OVER_PAYEE_CAP(),
            uint64(block.timestamp + TTL),
            bytes32(0),
            uint32(0),
            uint32(1)
        );
        assertEq(uint8(_pay(3, payeeC, 1, OPS)), uint8(SpendPolicy.Status.Pending));
    }

    function test_payeeCap_zeroMeansNoPayeeCap() public {
        _pay(1, payeeA, PER_PAYMENT, OPS);
        _pay(2, payeeA, PER_PAYMENT, OPS);
        assertEq(uint8(_pay(3, payeeA, PER_PAYMENT, OPS)), uint8(SpendPolicy.Status.Executed));
    }

    function test_multipleLimits_reportedAsBitmask() public {
        _fillMonthly(1); // OPS and monthly both full
        uint8 expected = policy.OVER_PER_PAYMENT_CAP() | policy.OVER_MONTHLY_CAP() | policy.OVER_CATEGORY_BUDGET();
        vm.expectEmit(address(policy));
        emit SpendPolicy.PaymentPending(
            _id(10),
            payeeA,
            PER_PAYMENT + 1,
            OPS,
            REASON,
            expected,
            uint64(block.timestamp + TTL),
            bytes32(0),
            uint32(0),
            uint32(1)
        );
        _pay(10, payeeA, PER_PAYMENT + 1, OPS);
    }

    // ------------------------------------------------------------- global ceiling

    function test_ceiling_atBoundary_executes() public {
        vm.prank(owner);
        policy.lowerGlobalCeiling(2 * PER_PAYMENT);
        _pay(1, payeeA, PER_PAYMENT, OPS);
        assertEq(uint8(_pay(2, payeeB, PER_PAYMENT, SUP)), uint8(SpendPolicy.Status.Executed));
        assertEq(policy.totalPaid(), policy.globalCeiling());
    }

    function test_ceiling_past_reverts() public {
        vm.prank(owner);
        policy.lowerGlobalCeiling(2 * PER_PAYMENT);
        _pay(1, payeeA, PER_PAYMENT, OPS);
        _pay(2, payeeB, PER_PAYMENT, SUP);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(SpendPolicy.GlobalCeilingExceeded.selector, 2 * PER_PAYMENT, 1, 2 * PER_PAYMENT)
        );
        policy.requestPayment(_id(3), payeeB, 1, SUP, REASON, bytes32(0));
    }

    function test_ceiling_cannotBeRaised_orKeptEqual() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.CeilingCanOnlyDecrease.selector, CEILING, CEILING + 1));
        policy.lowerGlobalCeiling(CEILING + 1);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.CeilingCanOnlyDecrease.selector, CEILING, CEILING));
        policy.lowerGlobalCeiling(CEILING);
        vm.expectEmit(address(policy));
        emit SpendPolicy.GlobalCeilingLowered(CEILING, CEILING - 1);
        policy.lowerGlobalCeiling(CEILING - 1);
        vm.stopPrank();
    }

    function test_ceiling_loweredBelowTotalPaid_freezesOutflow() public {
        _pay(1, payeeA, PER_PAYMENT, OPS);
        vm.prank(owner);
        policy.lowerGlobalCeiling(0);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.GlobalCeilingExceeded.selector, PER_PAYMENT, 1, 0));
        policy.requestPayment(_id(2), payeeA, 1, OPS, REASON, bytes32(0));
    }

    // ------------------------------------------------------------- pending -> approve -> ceiling

    function test_pending_doesNotReserveBudget() public {
        _pay(1, payeeA, 2_000 * USDC, OPS); // pending (per-payment)
        assertEq(policy.spentInWindow(), 0);
        assertEq(uint8(_pay(2, payeeB, PER_PAYMENT, SUP)), uint8(SpendPolicy.Status.Executed));
        assertEq(policy.spentInWindow(), PER_PAYMENT);
    }

    function test_approve_executesAndConsumesBudget() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        vm.expectEmit(address(policy));
        emit SpendPolicy.PaymentApproved(_id(1), owner, REASON);
        vm.expectEmit(address(policy));
        emit SpendPolicy.PaymentExecuted(_id(1), payeeA, 2_000 * USDC, OPS, REASON, true);
        vm.prank(owner);
        policy.approvePending(_id(1));
        _assertStatus(1, SpendPolicy.Status.Executed);
        assertEq(usdc.balanceOf(payeeA), 2_000 * USDC);
        assertEq(policy.categorySpentInWindow(OPS), 2_000 * USDC);
        // approved spend counts: OPS has 1,000 left, so 1,000 + 1 unit goes pending.
        assertEq(uint8(_pay(2, payeeA, PER_PAYMENT, OPS)), uint8(SpendPolicy.Status.Executed));
        assertEq(uint8(_pay(3, payeeA, 1, OPS)), uint8(SpendPolicy.Status.Pending));
    }

    function test_approve_canOverrideMonthlyCap() public {
        _fillMonthly(1);
        _pay(10, payeeB, 1, SUP);
        vm.prank(owner);
        policy.approvePending(_id(10));
        assertEq(policy.spentInWindow(), MONTHLY + 1);
    }

    function test_approve_ceilingAtBoundary_executes() public {
        vm.prank(owner);
        policy.lowerGlobalCeiling(2_500 * USDC);
        _pay(1, payeeA, 1_500 * USDC, OPS); // pending
        _pay(2, payeeB, PER_PAYMENT, SUP); // executed -> totalPaid 1,000
        vm.prank(owner);
        policy.approvePending(_id(1)); // 2,500 == ceiling
        assertEq(policy.totalPaid(), 2_500 * USDC);
    }

    function test_approve_pastCeiling_reverts_thenRejectable() public {
        _pay(1, payeeA, 1_500 * USDC, OPS); // pending, fine at request time
        _pay(2, payeeB, PER_PAYMENT, SUP); // totalPaid 1,000
        vm.startPrank(owner);
        policy.lowerGlobalCeiling(2_500 * USDC - 1); // now 1,000 + 1,500 > ceiling
        vm.expectRevert(
            abi.encodeWithSelector(
                SpendPolicy.GlobalCeilingExceeded.selector, PER_PAYMENT, 1_500 * USDC, 2_500 * USDC - 1
            )
        );
        policy.approvePending(_id(1));
        _assertStatus(1, SpendPolicy.Status.Pending); // no stuck state
        policy.rejectPending(_id(1));
        vm.stopPrank();
        _assertStatus(1, SpendPolicy.Status.Rejected);
    }

    function test_request_overCeiling_revertsEvenIfItWouldBePending() public {
        vm.prank(owner);
        policy.lowerGlobalCeiling(1_500 * USDC);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(SpendPolicy.GlobalCeilingExceeded.selector, 0, 1_500 * USDC + 1, 1_500 * USDC)
        );
        policy.requestPayment(_id(1), payeeA, 1_500 * USDC + 1, OPS, REASON, bytes32(0));
    }

    function test_approve_rechecksPause() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        vm.startPrank(owner);
        policy.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        policy.approvePending(_id(1));
        policy.unpause();
        policy.approvePending(_id(1));
        vm.stopPrank();
    }

    function test_approve_rechecksAllowList() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        vm.startPrank(owner);
        policy.removePayee(payeeA);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.PayeeNotAllowed.selector, payeeA));
        policy.approvePending(_id(1));
        vm.stopPrank();
    }

    function test_approve_rechecksBalance() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        vm.startPrank(owner);
        policy.withdraw(owner, FUNDING - 1_999 * USDC);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InsufficientBalance.selector, 1_999 * USDC, 2_000 * USDC));
        policy.approvePending(_id(1));
        vm.stopPrank();
        _assertStatus(1, SpendPolicy.Status.Pending);
    }

    function test_approve_onlyPending() public {
        _pay(1, payeeA, 1, OPS); // executed
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.NotPending.selector, _id(1)));
        policy.approvePending(_id(1));
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.NotPending.selector, _id(99)));
        policy.approvePending(_id(99));
        vm.stopPrank();
    }

    function test_reject_emitsAndBurnsId() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        vm.expectEmit(address(policy));
        emit SpendPolicy.PaymentRejected(_id(1), REASON);
        vm.prank(owner);
        policy.rejectPending(_id(1));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.NotPending.selector, _id(1)));
        policy.approvePending(_id(1));
    }

    // ------------------------------------------------------------- cancel

    /// L-06: cancelPending no longer exists; nobody (agent, owner, stranger) can call it.
    function test_cancel_removed() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        address[3] memory callers = [agent, owner, stranger];
        for (uint256 i; i < 3; ++i) {
            vm.prank(callers[i]);
            (bool ok,) = address(policy).call(abi.encodeWithSignature("cancelPending(bytes32)", _id(1)));
            assertFalse(ok);
        }
        _assertStatus(1, SpendPolicy.Status.Pending);
    }

    function test_reject_onlyOwner() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        address[2] memory callers = [agent, stranger];
        for (uint256 i; i < 2; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, callers[i]));
            policy.rejectPending(_id(1));
        }
        assertEq(policy.openPending(), 1);
        vm.prank(owner);
        policy.rejectPending(_id(1));
        assertEq(policy.openPending(), 0);
    }

    // ------------------------------------------------------------- expiry

    function test_expiry_approveAtExactExpiry_ok() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        vm.warp(block.timestamp + TTL);
        vm.prank(owner);
        policy.approvePending(_id(1));
        _assertStatus(1, SpendPolicy.Status.Executed);
    }

    function test_expiry_approveAfterExpiry_reverts() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        uint64 exp = uint64(block.timestamp + TTL);
        vm.warp(block.timestamp + TTL + 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.ApprovalWindowClosed.selector, _id(1), exp));
        policy.approvePending(_id(1));
    }

    function test_expiry_markExpired() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        uint64 exp = uint64(block.timestamp + TTL);
        vm.warp(exp);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.NotYetExpired.selector, _id(1), exp));
        policy.expirePending(_id(1));
        vm.warp(exp + 1);
        vm.expectEmit(address(policy));
        emit SpendPolicy.PaymentExpired(_id(1), REASON);
        vm.prank(stranger); // anyone may do the bookkeeping
        policy.expirePending(_id(1));
        _assertStatus(1, SpendPolicy.Status.Expired);
    }

    function test_expiry_ttlChangeDoesNotAffectExisting() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        vm.prank(owner);
        policy.setPendingTtl(30 days);
        assertEq(policy.getPayment(_id(1)).expiresAt, uint64(START + TTL));
    }

    // ------------------------------------------------------------- duplicate paymentId

    function test_duplicate_afterExecuted_reverts() public {
        _pay(1, payeeA, 1, OPS);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.PaymentIdUsed.selector, _id(1)));
        policy.requestPayment(_id(1), payeeB, 2, SUP, REASON, bytes32(0)); // different payee/amount: still refused
    }

    function test_duplicate_whilePending_reverts() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.PaymentIdUsed.selector, _id(1)));
        policy.requestPayment(_id(1), payeeA, 1, OPS, REASON, bytes32(0));
    }

    function test_duplicate_afterReject_reverts() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        vm.prank(owner);
        policy.rejectPending(_id(1));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.PaymentIdUsed.selector, _id(1)));
        policy.requestPayment(_id(1), payeeA, 1, OPS, REASON, bytes32(0));
    }

    function test_duplicate_afterExpire_reverts() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        vm.warp(block.timestamp + TTL + 1);
        policy.expirePending(_id(1));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.PaymentIdUsed.selector, _id(1)));
        policy.requestPayment(_id(1), payeeA, 1, OPS, REASON, bytes32(0));
    }

    function test_duplicate_afterApprove_reverts() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        vm.prank(owner);
        policy.approvePending(_id(1));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.PaymentIdUsed.selector, _id(1)));
        policy.requestPayment(_id(1), payeeA, 1, OPS, REASON, bytes32(0));
    }

    function test_zeroIdAndZeroAmount_revert() public {
        vm.startPrank(agent);
        vm.expectRevert(SpendPolicy.InvalidPaymentId.selector);
        policy.requestPayment(bytes32(0), payeeA, 1, OPS, REASON, bytes32(0));
        vm.expectRevert(SpendPolicy.ZeroAmount.selector);
        policy.requestPayment(_id(1), payeeA, 0, OPS, REASON, bytes32(0));
        vm.stopPrank();
    }

    function test_insufficientBalance_atRequest_reverts() public {
        vm.prank(owner);
        policy.withdraw(owner, FUNDING);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InsufficientBalance.selector, 0, 1));
        policy.requestPayment(_id(1), payeeA, 1, OPS, REASON, bytes32(0));
        _assertStatus(1, SpendPolicy.Status.None);
    }

    // ------------------------------------------------------------- pause

    function test_paused_blocksRequests_thenUnpause() public {
        vm.prank(owner);
        policy.pause();
        vm.prank(agent);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        policy.requestPayment(_id(1), payeeA, 1, OPS, REASON, bytes32(0));
        vm.prank(owner);
        policy.unpause();
        assertEq(uint8(_pay(1, payeeA, 1, OPS)), uint8(SpendPolicy.Status.Executed));
    }

    function test_paused_ownerCanStillConfigureWithdrawAndReject() public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        _pay(2, payeeA, 2_000 * USDC, OPS);
        vm.startPrank(owner);
        policy.pause();
        policy.setMonthlyCap(1);
        policy.rejectPending(_id(1));
        policy.rejectPending(_id(2));
        policy.withdraw(owner, 1);
        vm.stopPrank();
        assertEq(usdc.balanceOf(owner), 1);
    }

    // ------------------------------------------------------------- agent cannot change any setting

    function _expectUnauthorized(address caller, bytes memory data) internal {
        vm.prank(caller);
        (bool ok, bytes memory ret) = address(policy).call(data);
        assertFalse(ok, "call should revert");
        assertEq(ret, abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
    }

    function _ownerOnlyCalls() internal view returns (bytes[] memory c) {
        c = new bytes[](17);
        c[0] = abi.encodeCall(SpendPolicy.setAgent, (stranger));
        c[1] = abi.encodeCall(SpendPolicy.setPayee, (stranger, "x", OPS, 0));
        c[2] = abi.encodeCall(SpendPolicy.removePayee, (payeeA));
        c[3] = abi.encodeCall(SpendPolicy.setPerPaymentCap, (type(uint256).max));
        c[4] = abi.encodeCall(SpendPolicy.setMonthlyCap, (type(uint256).max));
        c[5] = abi.encodeCall(SpendPolicy.setCategoryBudget, (OPS, type(uint256).max));
        c[6] = abi.encodeCall(SpendPolicy.lowerGlobalCeiling, (1));
        c[7] = abi.encodeCall(SpendPolicy.setPendingTtl, (2 days));
        c[8] = abi.encodeCall(SpendPolicy.invalidateNonce, (1));
        c[9] = abi.encodeCall(SpendPolicy.pause, ());
        c[10] = abi.encodeCall(SpendPolicy.unpause, ());
        c[11] = abi.encodeCall(SpendPolicy.transferOwnership, (stranger));
        c[12] = abi.encodeCall(SpendPolicy.renounceOwnership, ());
        c[13] = abi.encodeCall(SpendPolicy.approvePending, (_id(1)));
        c[14] = abi.encodeCall(SpendPolicy.rejectPending, (_id(1)));
        c[15] = abi.encodeCall(SpendPolicy.withdraw, (agent, 1));
        c[16] = abi.encodeWithSignature("acceptOwnership()");
    }

    function test_agent_cannotChangeAnySetting() public {
        _pay(1, payeeA, 2_000 * USDC, OPS); // a pending payment the agent might try to self-approve
        bytes[] memory calls = _ownerOnlyCalls();
        for (uint256 i; i < calls.length; ++i) {
            _expectUnauthorized(agent, calls[i]);
        }
        // nothing changed
        assertEq(policy.perPaymentCap(), PER_PAYMENT);
        assertEq(policy.monthlyCap(), MONTHLY);
        assertEq(policy.agent(), agent);
        _assertStatus(1, SpendPolicy.Status.Pending);
    }

    function test_stranger_cannotChangeAnySetting() public {
        bytes[] memory calls = _ownerOnlyCalls();
        for (uint256 i; i < calls.length; ++i) {
            _expectUnauthorized(stranger, calls[i]);
        }
    }

    function test_onlyAgent_canRequest() public {
        vm.prank(owner);
        vm.expectRevert(SpendPolicy.NotAgent.selector);
        policy.requestPayment(_id(1), payeeA, 1, OPS, REASON, bytes32(0));
        vm.prank(stranger);
        vm.expectRevert(SpendPolicy.NotAgent.selector);
        policy.requestPayment(_id(1), payeeA, 1, OPS, REASON, bytes32(0));
    }

    // ------------------------------------------------------------- allow-list

    function test_agent_payNonAllowListed_reverts() public {
        address[5] memory targets = [stranger, agent, owner, address(0), address(policy)];
        for (uint256 i; i < targets.length; ++i) {
            vm.prank(agent);
            vm.expectRevert(abi.encodeWithSelector(SpendPolicy.PayeeNotAllowed.selector, targets[i]));
            policy.requestPayment(_id(i + 1), targets[i], 1, OPS, REASON, bytes32(0));
        }
        assertEq(usdc.balanceOf(address(policy)), FUNDING);
    }

    function test_agent_payRemovedPayee_reverts() public {
        vm.prank(owner);
        vm.expectEmit(address(policy));
        emit SpendPolicy.PayeeRemoved(payeeA);
        policy.removePayee(payeeA);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.PayeeNotAllowed.selector, payeeA));
        policy.requestPayment(_id(1), payeeA, 1, OPS, REASON, bytes32(0));
    }

    function test_setPayee_validation() public {
        address[5] memory bad = [address(0), address(policy), address(usdc), agent, owner];
        vm.startPrank(owner);
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InvalidPayee.selector, bad[i]));
            policy.setPayee(bad[i], "bad", OPS, 0);
        }
        vm.expectRevert(SpendPolicy.InvalidCategory.selector);
        policy.setPayee(stranger, "x", bytes32(0), 0);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.PayeeNotAllowed.selector, stranger));
        policy.removePayee(stranger);
        vm.expectRevert(SpendPolicy.InvalidCategory.selector);
        policy.setCategoryBudget(bytes32(0), 1);
        vm.stopPrank();
    }

    function test_setPayee_storesAndEmits() public {
        vm.expectEmit(address(policy));
        emit SpendPolicy.PayeeSet(stranger, "Cleaner", SUP, 42);
        vm.prank(owner);
        policy.setPayee(stranger, "Cleaner", SUP, 42);
        SpendPolicy.Payee memory p = policy.getPayee(stranger);
        assertTrue(p.allowed);
        assertEq(p.category, SUP);
        assertEq(p.cap, 42);
        assertEq(p.label, "Cleaner");
    }

    // ------------------------------------------------------------- settings emit events

    function test_settings_emitEvents() public {
        vm.startPrank(owner);
        vm.expectEmit(address(policy));
        emit SpendPolicy.PerPaymentCapSet(PER_PAYMENT, 7);
        policy.setPerPaymentCap(7);
        vm.expectEmit(address(policy));
        emit SpendPolicy.MonthlyCapSet(MONTHLY, 8);
        policy.setMonthlyCap(8);
        vm.expectEmit(address(policy));
        emit SpendPolicy.CategoryBudgetSet(OPS, OPS_BUDGET, 9);
        policy.setCategoryBudget(OPS, 9);
        vm.expectEmit(address(policy));
        emit SpendPolicy.PendingTtlSet(TTL, 2 days);
        policy.setPendingTtl(2 days);
        vm.expectEmit(address(policy));
        emit Pausable.Paused(owner);
        policy.pause();
        vm.expectEmit(address(policy));
        emit Pausable.Unpaused(owner);
        policy.unpause();
        vm.expectEmit(address(policy));
        emit SpendPolicy.NonceInvalidated(5);
        policy.invalidateNonce(5);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.NonceAlreadyUsed.selector, 5));
        policy.invalidateNonce(5);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InvalidPendingTtl.selector, 1 days - 1));
        policy.setPendingTtl(1 days - 1);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InvalidPendingTtl.selector, 90 days + 1));
        policy.setPendingTtl(90 days + 1);
        vm.stopPrank();
    }

    // ------------------------------------------------------------- agent rotation

    function test_setAgent_rotates() public {
        address newAgent = vm.addr(vm.deriveKey(TEST_MNEMONIC, 7));
        vm.expectEmit(address(policy));
        emit SpendPolicy.AgentChanged(agent, newAgent);
        vm.prank(owner);
        policy.setAgent(newAgent);
        vm.prank(agent);
        vm.expectRevert(SpendPolicy.NotAgent.selector);
        policy.requestPayment(_id(1), payeeA, 1, OPS, REASON, bytes32(0));
        vm.prank(newAgent);
        policy.requestPayment(_id(1), payeeA, 1, OPS, REASON, bytes32(0));
    }

    function test_setAgent_validation() public {
        vm.startPrank(owner);
        vm.expectRevert(SpendPolicy.ZeroAddress.selector);
        policy.setAgent(address(0));
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InvalidAgent.selector, owner));
        policy.setAgent(owner);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InvalidAgent.selector, payeeA));
        policy.setAgent(payeeA); // an agent that is also a payee could pay itself
        policy.transferOwnership(stranger);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InvalidAgent.selector, stranger));
        policy.setAgent(stranger);
        vm.stopPrank();
    }

    // ------------------------------------------------------------- withdraw

    function test_withdraw_ownerOnly() public {
        vm.expectEmit(address(policy));
        emit SpendPolicy.Withdrawn(owner, 5 * USDC);
        vm.prank(owner);
        policy.withdraw(owner, 5 * USDC);
        assertEq(usdc.balanceOf(owner), 5 * USDC);
        assertEq(policy.totalPaid(), 0); // owner withdrawals are not agent outflow
        vm.startPrank(owner);
        vm.expectRevert(SpendPolicy.ZeroAddress.selector);
        policy.withdraw(address(0), 1);
        vm.expectRevert(SpendPolicy.ZeroAmount.selector);
        policy.withdraw(owner, 0);
        vm.stopPrank();
    }

    function test_noNativeValueAccepted() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(policy).call{value: 1}("");
        assertFalse(ok);
    }

    // ------------------------------------------------------------- two-step ownership

    function test_ownership_twoStep() public {
        vm.prank(owner);
        policy.transferOwnership(stranger);
        assertEq(policy.owner(), owner); // step 1 changes nothing yet
        assertEq(policy.pendingOwner(), stranger);

        vm.prank(blocked);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, blocked));
        policy.acceptOwnership();

        vm.prank(stranger);
        policy.acceptOwnership();
        assertEq(policy.owner(), stranger);
        assertEq(policy.pendingOwner(), address(0));

        vm.prank(owner); // old owner is out
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        policy.setMonthlyCap(1);
        vm.prank(stranger);
        policy.setMonthlyCap(1);
    }

    function test_ownership_cannotGoToAgent_orBeRenounced() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InvalidAgent.selector, agent));
        policy.transferOwnership(agent);
        vm.expectRevert(SpendPolicy.RenounceDisabled.selector);
        policy.renounceOwnership();
        vm.stopPrank();
        assertEq(policy.owner(), owner);
    }

    function test_ownership_pendingTransferCanBeOverwritten() public {
        vm.startPrank(owner);
        policy.transferOwnership(stranger);
        policy.transferOwnership(blocked);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        policy.acceptOwnership();
    }
}
