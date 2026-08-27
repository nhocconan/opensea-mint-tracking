// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MintExecutor} from "../src/MintExecutor.sol";

/// @dev A minimal stand-in for an NFT mint contract, ABI-compatible with
///      the shape MintExecutor is designed to allowlist: a single address
///      recipient argument at a known offset. Also used to prove the
///      recipient-pin control against a genuinely malicious variant below.
contract FakeMintTarget {
    mapping(address => uint256) public mintedTo;
    bool public shouldRevert;

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    /// selector at offset 0, recipient address argument at offset 4
    /// (immediately after the selector — recipientOffset = 4 in tests).
    function mint(address to, uint256 quantity) external payable {
        require(!shouldRevert, "FakeMintTarget: forced revert");
        mintedTo[to] += quantity;
    }
}

/// @dev A second target with the recipient argument NOT at the trivial
///      offset 4, proving recipientOffset is read at the configured
///      position rather than a hardcoded assumption.
contract FakeMintTargetWithLeadingArg {
    mapping(address => uint256) public mintedTo;

    /// selector at offset 0, quantity at offset 4, recipient at offset 36.
    function mintTo(uint256 quantity, address to) external payable {
        mintedTo[to] += quantity;
    }
}

contract MintExecutorTest is Test {
    MintExecutor executor;
    FakeMintTarget target;
    FakeMintTargetWithLeadingArg target2;

    address owner = makeAddr("owner"); // stands in for the Ledger EOA
    address operator = makeAddr("operator"); // the hot session key
    address attacker = makeAddr("attacker");

    uint256 constant CAP = 1 ether;

    function setUp() public {
        vm.prank(owner);
        executor = new MintExecutor(owner);
        target = new FakeMintTarget();
        target2 = new FakeMintTargetWithLeadingArg();

        vm.prank(owner);
        executor.setOperator(operator);

        vm.deal(address(this), 100 ether);
        (bool ok,) = address(executor).call{value: 10 ether}("");
        require(ok, "fund executor");
    }

    // ── Constructor / ownership ─────────────────────────────────────────

    function test_constructorRejectsZeroOwner() public {
        vm.expectRevert(MintExecutor.ZeroAddress.selector);
        new MintExecutor(address(0));
    }

    function test_ownerIsImmutableAndSetCorrectly() public view {
        assertEq(executor.owner(), owner);
    }

    // ── Access control on owner-only functions ──────────────────────────

    function test_onlyOwnerCanSetOperator() public {
        vm.prank(attacker);
        vm.expectRevert(MintExecutor.NotOwner.selector);
        executor.setOperator(attacker);
    }

    function test_onlyOwnerCanSetAllowlist() public {
        vm.prank(attacker);
        vm.expectRevert(MintExecutor.NotOwner.selector);
        executor.setAllowlist(address(target), FakeMintTarget.mint.selector, true, 4, CAP);
    }

    function test_onlyOwnerCanWithdraw() public {
        vm.prank(attacker);
        vm.expectRevert(MintExecutor.NotOwner.selector);
        executor.withdraw(payable(attacker), 1 ether);
    }

    function test_ownerCanWithdraw() public {
        uint256 before = owner.balance;
        vm.prank(owner);
        executor.withdraw(payable(owner), 1 ether);
        assertEq(owner.balance, before + 1 ether);
    }

    function test_revokeOperatorBlocksFurtherMints() public {
        vm.prank(owner);
        executor.setAllowlist(address(target), FakeMintTarget.mint.selector, true, 4, CAP);
        vm.prank(owner);
        executor.revokeOperator();

        bytes memory data = abi.encodeCall(FakeMintTarget.mint, (owner, 1));
        vm.prank(operator);
        vm.expectRevert(MintExecutor.NotOperator.selector);
        executor.executeMint(address(target), data, 0);
    }

    // ── Core happy path ──────────────────────────────────────────────────

    function test_executeMintSucceedsForAllowlistedCallWithCorrectRecipient() public {
        vm.prank(owner);
        executor.setAllowlist(address(target), FakeMintTarget.mint.selector, true, 4, CAP);

        bytes memory data = abi.encodeCall(FakeMintTarget.mint, (owner, 3));
        vm.prank(operator);
        executor.executeMint(address(target), data, 0.1 ether);

        assertEq(target.mintedTo(owner), 3);
    }

    function test_executeMintForwardsValueFromContractBalanceNotOperator() public {
        vm.prank(owner);
        executor.setAllowlist(address(target), FakeMintTarget.mint.selector, true, 4, CAP);

        uint256 executorBalBefore = address(executor).balance;
        uint256 operatorBalBefore = operator.balance;

        bytes memory data = abi.encodeCall(FakeMintTarget.mint, (owner, 1));
        vm.prank(operator);
        executor.executeMint(address(target), data, 0.5 ether);

        assertEq(address(executor).balance, executorBalBefore - 0.5 ether);
        assertEq(operator.balance, operatorBalBefore); // operator's own ETH untouched
    }

    /// @dev The offset is read at the CONFIGURED position, not assumed to
    ///      always be the first argument — proves recipientOffset genuinely
    ///      parameterizes the check rather than hardcoding "arg 0".
    function test_executeMintHandlesRecipientAtNonTrivialOffset() public {
        // selector(4) + uint256 quantity(32) = recipient starts at byte 36.
        vm.prank(owner);
        executor.setAllowlist(address(target2), FakeMintTargetWithLeadingArg.mintTo.selector, true, 36, CAP);

        bytes memory data = abi.encodeCall(FakeMintTargetWithLeadingArg.mintTo, (5, owner));
        vm.prank(operator);
        executor.executeMint(address(target2), data, 0);

        assertEq(target2.mintedTo(owner), 5);
    }

    // ── THE merge-gate test (ADR 0004): redirect recipient MUST revert ──

    function test_REQUIRED_recipientRedirectToAttackerReverts() public {
        vm.prank(owner);
        executor.setAllowlist(address(target), FakeMintTarget.mint.selector, true, 4, CAP);

        // Every dollar-figure guardrail (allowlist, value cap) is
        // satisfied here — only the recipient argument is wrong. This is
        // exactly the false-safety scenario ADR 0004's red-team pass
        // flagged: a compromised operator key calling an allowlisted
        // selector, within cap, but pointed at an attacker's address.
        bytes memory maliciousData = abi.encodeCall(FakeMintTarget.mint, (attacker, 1));

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(MintExecutor.RecipientMismatch.selector, owner, attacker));
        executor.executeMint(address(target), maliciousData, 0);

        assertEq(target.mintedTo(attacker), 0, "attacker must never receive the mint");
    }

    function test_REQUIRED_recipientRedirectAtNonTrivialOffsetAlsoReverts() public {
        vm.prank(owner);
        executor.setAllowlist(address(target2), FakeMintTargetWithLeadingArg.mintTo.selector, true, 36, CAP);

        bytes memory maliciousData = abi.encodeCall(FakeMintTargetWithLeadingArg.mintTo, (5, attacker));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(MintExecutor.RecipientMismatch.selector, owner, attacker));
        executor.executeMint(address(target2), maliciousData, 0);

        assertEq(target2.mintedTo(attacker), 0);
    }

    // ── Allowlist gating ──────────────────────────────────────────────────

    function test_executeMintRevertsForNonAllowlistedTarget() public {
        bytes memory data = abi.encodeCall(FakeMintTarget.mint, (owner, 1));
        vm.prank(operator);
        vm.expectRevert(MintExecutor.TargetNotAllowlisted.selector);
        executor.executeMint(address(target), data, 0);
    }

    function test_executeMintRevertsForAllowlistedTargetWrongSelector() public {
        vm.prank(owner);
        executor.setAllowlist(address(target), FakeMintTarget.mint.selector, true, 4, CAP);

        // setShouldRevert has a different selector — never allowlisted.
        bytes memory data = abi.encodeCall(FakeMintTarget.setShouldRevert, (true));
        vm.prank(operator);
        vm.expectRevert(MintExecutor.TargetNotAllowlisted.selector);
        executor.executeMint(address(target), data, 0);
    }

    function test_settingAllowedFalseRevokesAnExistingEntry() public {
        vm.startPrank(owner);
        executor.setAllowlist(address(target), FakeMintTarget.mint.selector, true, 4, CAP);
        executor.setAllowlist(address(target), FakeMintTarget.mint.selector, false, 4, CAP);
        vm.stopPrank();

        bytes memory data = abi.encodeCall(FakeMintTarget.mint, (owner, 1));
        vm.prank(operator);
        vm.expectRevert(MintExecutor.TargetNotAllowlisted.selector);
        executor.executeMint(address(target), data, 0);
    }

    function test_onlyOperatorCanCallExecuteMint() public {
        vm.prank(owner);
        executor.setAllowlist(address(target), FakeMintTarget.mint.selector, true, 4, CAP);

        bytes memory data = abi.encodeCall(FakeMintTarget.mint, (owner, 1));
        vm.prank(attacker);
        vm.expectRevert(MintExecutor.NotOperator.selector);
        executor.executeMint(address(target), data, 0);
    }

    // ── Rolling 24h value cap ─────────────────────────────────────────────

    function test_executeMintRevertsWhenValueExceedsCap() public {
        vm.prank(owner);
        executor.setAllowlist(address(target), FakeMintTarget.mint.selector, true, 4, CAP);

        bytes memory data = abi.encodeCall(FakeMintTarget.mint, (owner, 1));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(MintExecutor.ValueCapExceeded.selector, CAP + 1, CAP));
        executor.executeMint(address(target), data, CAP + 1);
    }

    function test_capAccumulatesAcrossMultipleMintsWithinWindow() public {
        vm.prank(owner);
        executor.setAllowlist(address(target), FakeMintTarget.mint.selector, true, 4, CAP);

        bytes memory data = abi.encodeCall(FakeMintTarget.mint, (owner, 1));
        vm.prank(operator);
        executor.executeMint(address(target), data, 0.6 ether);

        // 0.6 + 0.6 = 1.2 > 1.0 cap — must revert even though each
        // individual call is within the per-call amount.
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(MintExecutor.ValueCapExceeded.selector, 0.6 ether, 0.4 ether));
        executor.executeMint(address(target), data, 0.6 ether);
    }

    function test_capResetsAfter24Hours() public {
        vm.prank(owner);
        executor.setAllowlist(address(target), FakeMintTarget.mint.selector, true, 4, CAP);

        bytes memory data = abi.encodeCall(FakeMintTarget.mint, (owner, 1));
        vm.prank(operator);
        executor.executeMint(address(target), data, 0.9 ether);

        vm.warp(block.timestamp + 24 hours + 1);

        // Window has genuinely elapsed — full cap available again.
        vm.prank(operator);
        executor.executeMint(address(target), data, 0.9 ether);
        assertEq(target.mintedTo(owner), 2);
    }

    function test_capDoesNotResetBeforeWindowElapses() public {
        vm.prank(owner);
        executor.setAllowlist(address(target), FakeMintTarget.mint.selector, true, 4, CAP);

        bytes memory data = abi.encodeCall(FakeMintTarget.mint, (owner, 1));
        vm.prank(operator);
        executor.executeMint(address(target), data, 0.9 ether);

        vm.warp(block.timestamp + 23 hours);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(MintExecutor.ValueCapExceeded.selector, 0.9 ether, 0.1 ether));
        executor.executeMint(address(target), data, 0.9 ether);
    }

    function test_capsAreIndependentPerTarget() public {
        vm.startPrank(owner);
        executor.setAllowlist(address(target), FakeMintTarget.mint.selector, true, 4, CAP);
        executor.setAllowlist(address(target2), FakeMintTargetWithLeadingArg.mintTo.selector, true, 36, CAP);
        vm.stopPrank();

        bytes memory data1 = abi.encodeCall(FakeMintTarget.mint, (owner, 1));
        bytes memory data2 = abi.encodeCall(FakeMintTargetWithLeadingArg.mintTo, (1, owner));

        vm.prank(operator);
        executor.executeMint(address(target), data1, 0.9 ether);
        // Different target, own independent window — must NOT be blocked
        // by target 1's near-exhausted cap.
        vm.prank(operator);
        executor.executeMint(address(target2), data2, 0.9 ether);

        assertEq(target.mintedTo(owner), 1);
        assertEq(target2.mintedTo(owner), 1);
    }

    // ── Failure propagation from the target contract ─────────────────────

    function test_executeMintRevertsIfTargetCallReverts() public {
        vm.prank(owner);
        executor.setAllowlist(address(target), FakeMintTarget.mint.selector, true, 4, CAP);
        target.setShouldRevert(true);

        bytes memory data = abi.encodeCall(FakeMintTarget.mint, (owner, 1));
        vm.prank(operator);
        vm.expectRevert();
        executor.executeMint(address(target), data, 0);
    }

    function test_executeMintRevertsIfCalldataTooShortForRecipient() public {
        vm.prank(owner);
        // recipientOffset far beyond any real calldata length.
        executor.setAllowlist(address(target), FakeMintTarget.mint.selector, true, 1000, CAP);

        bytes memory data = abi.encodeCall(FakeMintTarget.mint, (owner, 1));
        vm.prank(operator);
        vm.expectRevert(MintExecutor.CalldataTooShortForRecipient.selector);
        executor.executeMint(address(target), data, 0);
    }

    // ── Deposits ──────────────────────────────────────────────────────────

    function test_receiveAcceptsDeposits() public {
        uint256 before = address(executor).balance;
        (bool ok,) = address(executor).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(executor).balance, before + 1 ether);
    }

    // ── Fuzz: recipient check holds for arbitrary attacker addresses ─────

    function testFuzz_recipientMismatchAlwaysRevertsForAnyNonOwnerAddress(address someRecipient) public {
        vm.assume(someRecipient != owner);
        vm.prank(owner);
        executor.setAllowlist(address(target), FakeMintTarget.mint.selector, true, 4, CAP);

        bytes memory data = abi.encodeCall(FakeMintTarget.mint, (someRecipient, 1));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(MintExecutor.RecipientMismatch.selector, owner, someRecipient));
        executor.executeMint(address(target), data, 0);
    }
}
