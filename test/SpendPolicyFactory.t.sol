// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SpendPolicy} from "../src/SpendPolicy.sol";
import {SpendPolicyFactory} from "../src/SpendPolicyFactory.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract SpendPolicyFactoryTest is Test {
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    uint256 internal constant USDC = 1e6;
    uint256 internal constant PER = 20 * USDC;
    uint256 internal constant MONTH = 100 * USDC;
    uint256 internal constant CEIL = 200 * USDC;
    uint256 internal constant TTL = 7 days;

    SpendPolicyFactory internal factory;
    MockUSDC internal usdc;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal aliceAgent = makeAddr("aliceAgent");
    address internal bobAgent = makeAddr("bobAgent");
    address internal payee = makeAddr("payee");

    event PolicyCreated(
        address indexed owner,
        address indexed agent,
        address indexed policy,
        uint256 perPaymentCap,
        uint256 monthlyCap,
        uint256 globalCeiling,
        uint256 pendingTtl
    );

    function setUp() public {
        // Put a 6-decimal mock USDC at Arc's USDC address so the factory constant works in tests.
        vm.etch(ARC_USDC, address(new MockUSDC()).code);
        usdc = MockUSDC(ARC_USDC);
        factory = new SpendPolicyFactory();
    }

    function _create(address who, address agent) internal returns (SpendPolicy) {
        vm.prank(who);
        return SpendPolicy(factory.createPolicy(agent, PER, MONTH, CEIL, TTL));
    }

    function test_createSetsOwnerAgentTokenCaps() public {
        SpendPolicy p = _create(alice, aliceAgent);
        assertEq(p.owner(), alice);
        assertEq(p.agent(), aliceAgent);
        assertEq(address(p.token()), ARC_USDC);
        assertEq(p.perPaymentCap(), PER);
        assertEq(p.monthlyCap(), MONTH);
        assertEq(p.globalCeiling(), CEIL);
        assertEq(p.pendingTtl(), TTL);
        assertEq(p.pendingOwner(), address(0));
    }

    function test_factoryIsNotOwner() public {
        SpendPolicy p = _create(alice, aliceAgent);
        assertTrue(p.owner() != address(factory));
        vm.prank(address(factory));
        vm.expectRevert();
        p.setPerPaymentCap(1);
    }

    function test_registry() public {
        SpendPolicy p = _create(alice, aliceAgent);
        assertTrue(factory.isPolicy(address(p)));
        assertFalse(factory.isPolicy(alice));
        address[] memory list = factory.policiesOf(alice);
        assertEq(list.length, 1);
        assertEq(list[0], address(p));
        assertEq(factory.policiesOf(bob).length, 0);
        assertEq(factory.policyCount(), 1);
        assertEq(factory.allPolicies(0), address(p));
    }

    function test_multiplePoliciesPerOwnerAndTenantsIsolated() public {
        SpendPolicy a1 = _create(alice, aliceAgent);
        SpendPolicy a2 = _create(alice, makeAddr("aliceAgent2"));
        SpendPolicy b1 = _create(bob, bobAgent);
        assertTrue(address(a1) != address(a2));
        assertEq(factory.policiesOf(alice).length, 2);
        assertEq(factory.policiesOf(alice)[1], address(a2));
        assertEq(factory.policiesOf(bob).length, 1);
        assertEq(b1.owner(), bob);
        assertEq(factory.policyCount(), 3);

        // Alice cannot administer Bob's policy and vice versa.
        vm.prank(alice);
        vm.expectRevert();
        b1.setPerPaymentCap(1);
        vm.prank(bob);
        vm.expectRevert();
        a1.withdraw(bob, 1);
    }

    function test_emitsPolicyCreated() public {
        address predicted = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
        vm.expectEmit(true, true, true, true, address(factory));
        emit PolicyCreated(alice, aliceAgent, predicted, PER, MONTH, CEIL, TTL);
        SpendPolicy p = _create(alice, aliceAgent);
        assertEq(address(p), predicted);
    }

    function test_revertZeroAgent() public {
        vm.prank(alice);
        vm.expectRevert(SpendPolicyFactory.ZeroAgent.selector);
        factory.createPolicy(address(0), PER, MONTH, CEIL, TTL);
    }

    function test_revertAgentIsOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicyFactory.AgentIsOwner.selector, alice));
        factory.createPolicy(alice, PER, MONTH, CEIL, TTL);
    }

    function test_revertBadTtlBubblesFromPolicy() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InvalidPendingTtl.selector, 0));
        factory.createPolicy(aliceAgent, PER, MONTH, CEIL, 0);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.InvalidPendingTtl.selector, 365 days));
        factory.createPolicy(aliceAgent, PER, MONTH, CEIL, 365 days);
        vm.stopPrank();
        assertEq(factory.policyCount(), 0);
    }

    function test_revertCeilingTooHigh() public {
        uint256 big = uint256(type(uint128).max) + 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SpendPolicy.CeilingTooHigh.selector, big));
        factory.createPolicy(aliceAgent, PER, MONTH, big, TTL);
    }

    function test_endToEndAgentPaysWithinCaps() public {
        SpendPolicy p = _create(alice, aliceAgent);
        vm.prank(alice);
        p.setCategoryBudget("OPS", MONTH);
        vm.prank(alice);
        p.setPayee(payee, "Landlord", "OPS", 0);
        usdc.mint(address(p), 150 * USDC);
        vm.prank(aliceAgent);
        SpendPolicy.Status st = p.requestPayment(bytes32(uint256(1)), payee, 10 * USDC, "OPS", bytes32(0), bytes32(0));
        assertEq(uint8(st), uint8(SpendPolicy.Status.Executed));
        assertEq(usdc.balanceOf(payee), 10 * USDC);
        // Over the per-payment cap parks as Pending for Alice, not paid.
        vm.prank(aliceAgent);
        st = p.requestPayment(bytes32(uint256(2)), payee, 25 * USDC, "OPS", bytes32(0), bytes32(0));
        assertEq(uint8(st), uint8(SpendPolicy.Status.Pending));
        assertEq(usdc.balanceOf(payee), 10 * USDC);
    }

    function testFuzz_anyoneCanCreate(address who, address agent) public {
        vm.assume(who != address(0) && agent != address(0) && who != agent);
        SpendPolicy p = _create(who, agent);
        assertEq(p.owner(), who);
        assertEq(p.agent(), agent);
        assertTrue(factory.isPolicy(address(p)));
        assertEq(factory.policiesOf(who)[0], address(p));
    }
}
