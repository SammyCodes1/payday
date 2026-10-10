// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base} from "./Base.t.sol";
import {SpendPolicy} from "../src/SpendPolicy.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Property fuzz tests (runs set in foundry.toml: 10,000 per test).
contract SpendPolicyFuzzTest is Base {
    function _loosenAllButMonthly() internal {
        vm.startPrank(owner);
        policy.setPerPaymentCap(MONTHLY);
        policy.setCategoryBudget(OPS, MONTHLY);
        policy.setCategoryBudget(SUP, MONTHLY);
        vm.stopPrank();
    }

    /// Per-payment cap: executes iff amount <= cap (all other limits loosened).
    function testFuzz_perPaymentCap(uint256 amount) public {
        amount = bound(amount, 1, 10 * PER_PAYMENT);
        vm.startPrank(owner);
        policy.setMonthlyCap(CEILING);
        policy.setCategoryBudget(OPS, CEILING);
        vm.stopPrank();
        SpendPolicy.Status s = _pay(1, payeeA, amount, OPS);
        SpendPolicy.Status want = amount <= PER_PAYMENT ? SpendPolicy.Status.Executed : SpendPolicy.Status.Pending;
        assertEq(uint8(s), uint8(want));
    }

    /// 6-decimal precision: any cap in micro-USDC is honoured to the last unit.
    function testFuzz_microUnitBoundary(uint256 cap) public {
        cap = bound(cap, 1, PER_PAYMENT);
        vm.prank(owner);
        policy.setPerPaymentCap(cap);
        assertEq(uint8(_pay(1, payeeA, cap, OPS)), uint8(SpendPolicy.Status.Executed));
        assertEq(uint8(_pay(2, payeeA, cap + 1, OPS)), uint8(SpendPolicy.Status.Pending));
    }

    /// Agent-only payments: within ANY 30 x 24h span, auto-executed total <= monthlyCap.
    function testFuzz_rollingWindowNeverExceedsMonthlyCap(uint256 seed) public {
        _loosenAllButMonthly();
        vm.prank(owner);
        policy.setMaxOpenPending(type(uint256).max); // this test parks many pendings on purpose
        uint256 steps = 40;
        uint256[] memory ts = new uint256[](steps);
        uint256[] memory amt = new uint256[](steps);
        uint256 n;
        for (uint256 i; i < steps; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            vm.warp(block.timestamp + (r % 3 days));
            uint256 a = bound(r >> 64, 1, MONTHLY);
            (address payee, bytes32 cat) = (r >> 200) % 2 == 0 ? (payeeA, OPS) : (payeeB, SUP);
            if (_pay(i + 1, payee, a, cat) == SpendPolicy.Status.Executed) {
                ts[n] = block.timestamp;
                amt[n] = a;
                ++n;
            }
        }
        for (uint256 i; i < n; ++i) {
            uint256 sum;
            for (uint256 j = i; j < n && ts[j] < ts[i] + 30 days; ++j) {
                sum += amt[j];
            }
            assertLe(sum, MONTHLY, "30-day span exceeded monthly cap");
        }
    }

    /// A paymentId is refused forever after ANY outcome.
    function testFuzz_duplicateIdAlwaysRefused(uint256 n, uint8 path, uint256 amount2, bool otherPayee) public {
        path = uint8(bound(path, 0, 5));
        amount2 = bound(amount2, 1, CEILING);
        if (path == 0) {
            _pay(n, payeeA, 1, OPS); // executed
        } else {
            _pay(n, payeeA, 2_000 * USDC, OPS); // pending
            if (path == 2) {
                vm.prank(owner);
                policy.rejectPending(_id(n));
            } else if (path == 3) {
                // L-06: the agent can no longer cancel; the payment stays Pending
                vm.prank(agent);
                (bool ok,) = address(policy).call(abi.encodeWithSignature("cancelPending(bytes32)", _id(n)));
                assertFalse(ok);
            } else if (path == 4) {
                vm.warp(block.timestamp + TTL + 1);
                policy.expirePending(_id(n));
            } else if (path == 5) {
                vm.prank(owner);
                policy.approvePending(_id(n));
            }
        }
        (address p, bytes32 c) = otherPayee ? (payeeB, SUP) : (payeeA, OPS);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.PaymentIdUsed.selector, _id(n)));
        policy.requestPayment(_id(n), p, amount2, c, REASON, bytes32(0));
    }

    function testFuzz_nonAllowListedAlwaysReverts(address target, uint256 amount, bytes32 cat) public {
        vm.assume(target != payeeA && target != payeeB && target != payeeC);
        amount = bound(amount, 1, CEILING);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.PayeeNotAllowed.selector, target));
        policy.requestPayment(_id(1), target, amount, cat, REASON, bytes32(0));
    }

    function testFuzz_onlyAgentCanRequest(address caller) public {
        vm.assume(caller != agent);
        vm.prank(caller);
        vm.expectRevert(SpendPolicy.NotAgent.selector);
        policy.requestPayment(_id(1), payeeA, 1, OPS, REASON, bytes32(0));
    }

    function testFuzz_nonOwnerCannotConfigure(address caller, uint256 v) public {
        vm.assume(caller != owner);
        vm.startPrank(caller);
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller);
        vm.expectRevert(err);
        policy.setMonthlyCap(v);
        vm.expectRevert(err);
        policy.setPerPaymentCap(v);
        vm.expectRevert(err);
        policy.setCategoryBudget(OPS, v);
        vm.expectRevert(err);
        policy.setPayee(caller, "me", OPS, v);
        vm.expectRevert(err);
        policy.withdraw(caller, bound(v, 1, FUNDING));
        vm.stopPrank();
    }

    /// Global ceiling holds across auto payments AND owner approvals.
    function testFuzz_ceilingNeverExceeded(uint256 seed, uint256 ceiling) public {
        ceiling = bound(ceiling, 1, CEILING - 1);
        vm.prank(owner);
        policy.lowerGlobalCeiling(ceiling);
        for (uint256 i; i < 30; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            vm.warp(block.timestamp + (r % 5 days));
            uint256 a = bound(r >> 8, 1, 3 * PER_PAYMENT);
            vm.prank(agent);
            try policy.requestPayment(_id(i + 1), payeeB, a, SUP, REASON, bytes32(0)) returns (SpendPolicy.Status s) {
                if (s == SpendPolicy.Status.Pending) {
                    vm.prank(owner);
                    try policy.approvePending(_id(i + 1)) {} catch {}
                }
            } catch {}
            assertLe(policy.totalPaid(), ceiling);
        }
    }

    /// Only the current owner's key can produce an accepted approval signature.
    function testFuzz_signatureFromNonOwnerRejected(uint32 idx) public {
        idx = uint32(bound(idx, 1, 20)); // other keys from the public test mnemonic
        _pay(1, payeeA, 2_000 * USDC, OPS);
        uint256 key = vm.deriveKey(TEST_MNEMONIC, idx);
        uint256 deadline = block.timestamp + 1;
        bytes32 domain = policy.domainSeparator();
        bytes32 structHash = _approvalStruct(_id(1), payeeA, 2_000 * USDC, 1, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        vm.expectRevert(SpendPolicy.InvalidSignature.selector);
        policy.approvePendingWithSig(_id(1), 1, deadline, abi.encodePacked(r, s, v));
    }

    function testFuzz_randomSignatureBytesRejected(bytes32 r, bytes32 s, uint8 v) public {
        _pay(1, payeeA, 2_000 * USDC, OPS);
        vm.expectRevert();
        policy.approvePendingWithSig(_id(1), 1, block.timestamp, abi.encodePacked(r, s, v));
        assertEq(uint8(_status(1)), uint8(SpendPolicy.Status.Pending));
    }
}
