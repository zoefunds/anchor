// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../contracts/Escrow.sol";

contract EscrowTest is Test {
    Escrow escrow;
    address decisionRelay = address(0xDEC1);
    address claimant = address(0xC1A1);
    address respondent = address(0xB0B1);
    bytes32 caseId = keccak256("case-1");
    bytes32 escrowId = keccak256("escrow-1");
    uint256 constant TIMEOUT = 30 days;

    function setUp() public {
        escrow = new Escrow(decisionRelay, TIMEOUT);
    }

    function test_deposit_recordsClaimantRespondentAndAmount() public {
        vm.deal(address(this), 1 ether);
        escrow.deposit{value: 1 ether}(caseId, escrowId, claimant, respondent);

        (Escrow.Status status, address c, address r, uint256 amount, bytes32 storedCaseId,) = escrow.deposits(escrowId);
        assertEq(uint8(status), uint8(Escrow.Status.DEPOSITED));
        assertEq(c, claimant);
        assertEq(r, respondent);
        assertEq(amount, 1 ether);
        assertEq(storedCaseId, caseId);
    }

    function test_deposit_revertsOnSecondDepositForSameEscrowId() public {
        vm.deal(address(this), 2 ether);
        escrow.deposit{value: 1 ether}(caseId, escrowId, claimant, respondent);
        vm.expectRevert(abi.encodeWithSelector(Escrow.AlreadyDeposited.selector, escrowId));
        escrow.deposit{value: 1 ether}(caseId, escrowId, claimant, respondent);
    }

    function test_deposit_revertsOnZeroAddress() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert(Escrow.ZeroAddress.selector);
        escrow.deposit{value: 1 ether}(caseId, escrowId, address(0), respondent);
    }

    function test_deposit_revertsOnZeroAmount() public {
        vm.expectRevert(Escrow.ZeroAmount.selector);
        escrow.deposit{value: 0}(caseId, escrowId, claimant, respondent);
    }

    function _deposit(uint256 amount) internal {
        vm.deal(address(this), amount);
        escrow.deposit{value: amount}(caseId, escrowId, claimant, respondent);
    }

    function test_settle_paysOutExactSplitAndMarksSettled() public {
        _deposit(3 ether);
        uint256 claimantBefore = claimant.balance;
        uint256 respondentBefore = respondent.balance;

        vm.prank(decisionRelay);
        escrow.settle(caseId, escrowId, 2 ether, 1 ether, keccak256("proof"));

        assertEq(claimant.balance, claimantBefore + 2 ether);
        assertEq(respondent.balance, respondentBefore + 1 ether);
        (Escrow.Status status,,,,,) = escrow.deposits(escrowId);
        assertEq(uint8(status), uint8(Escrow.Status.SETTLED));
    }

    function test_settle_allowsFullAmountToOneParty() public {
        _deposit(1 ether);
        uint256 claimantBefore = claimant.balance;

        vm.prank(decisionRelay);
        escrow.settle(caseId, escrowId, 1 ether, 0, keccak256("proof"));

        assertEq(claimant.balance, claimantBefore + 1 ether);
        assertEq(respondent.balance, 0);
    }

    function test_settle_revertsIfNotCalledByDecisionRelay() public {
        _deposit(1 ether);
        vm.expectRevert(Escrow.NotDecisionRelay.selector);
        escrow.settle(caseId, escrowId, 1 ether, 0, keccak256("proof"));
    }

    function test_settle_revertsOnUnknownEscrow() public {
        vm.prank(decisionRelay);
        vm.expectRevert(abi.encodeWithSelector(Escrow.UnknownEscrow.selector, escrowId));
        escrow.settle(caseId, escrowId, 1 ether, 0, keccak256("proof"));
    }

    function test_settle_revertsOnAmountMismatch_tooHigh() public {
        _deposit(1 ether);
        vm.prank(decisionRelay);
        vm.expectRevert(abi.encodeWithSelector(Escrow.AmountMismatch.selector, 1 ether, 1.5 ether));
        escrow.settle(caseId, escrowId, 1 ether, 0.5 ether, keccak256("proof"));
    }

    function test_settle_revertsOnAmountMismatch_tooLow() public {
        _deposit(1 ether);
        vm.prank(decisionRelay);
        vm.expectRevert(abi.encodeWithSelector(Escrow.AmountMismatch.selector, 1 ether, 0.5 ether));
        escrow.settle(caseId, escrowId, 0.5 ether, 0, keccak256("proof"));
    }

    function test_settle_cannotBeCalledTwice_evenWithValidAmountsAgain() public {
        _deposit(1 ether);
        vm.startPrank(decisionRelay);
        escrow.settle(caseId, escrowId, 1 ether, 0, keccak256("proof"));
        vm.expectRevert(abi.encodeWithSelector(Escrow.AlreadySettled.selector, escrowId));
        escrow.settle(caseId, escrowId, 1 ether, 0, keccak256("proof-2"));
        vm.stopPrank();
    }

    function test_settle_neverPaysOutMoreThanWasDeposited_evenAcrossDifferentEscrows() public {
        // Two independent escrows for two different cases must not be
        // able to cross-contaminate — settling one must not be able to
        // reach into the other's funds.
        bytes32 escrowIdB = keccak256("escrow-B");
        vm.deal(address(this), 3 ether);
        escrow.deposit{value: 1 ether}(caseId, escrowId, claimant, respondent);
        escrow.deposit{value: 2 ether}(keccak256("case-B"), escrowIdB, claimant, respondent);

        vm.startPrank(decisionRelay);
        // Attempting to settle escrowId (which only holds 1 ether) for
        // 3 ether (as if it could reach escrowIdB's funds too) must
        // revert, not silently drain the contract's total balance.
        vm.expectRevert(abi.encodeWithSelector(Escrow.AmountMismatch.selector, 1 ether, 3 ether));
        escrow.settle(caseId, escrowId, 3 ether, 0, keccak256("proof"));
        vm.stopPrank();

        assertEq(address(escrow).balance, 3 ether, "no funds should have moved");
    }

    function test_deposit_revertsOnReDepositAfterSettlement() public {
        _deposit(1 ether);
        vm.prank(decisionRelay);
        escrow.settle(caseId, escrowId, 1 ether, 0, keccak256("proof"));

        vm.deal(address(this), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(Escrow.AlreadyDeposited.selector, escrowId));
        escrow.deposit{value: 1 ether}(caseId, escrowId, claimant, respondent);
    }

    function test_constructor_revertsOnZeroDecisionRelay() public {
        vm.expectRevert(Escrow.ZeroAddress.selector);
        new Escrow(address(0), TIMEOUT);
    }

    function test_constructor_revertsOnZeroTimeout() public {
        vm.expectRevert(bytes("emergencyRefundTimeoutSeconds must be nonzero"));
        new Escrow(decisionRelay, 0);
    }

    // Real fix (external audit finding): the first version of this
    // contract stored no caseId, so settle() had no on-chain way to
    // prove a settlement's caseId matched the deposit's original
    // caseId — that binding existed only in off-chain records. These
    // tests prove the contract itself now enforces it.
    function test_settle_revertsOnCaseIdMismatch() public {
        _deposit(1 ether);
        bytes32 wrongCaseId = keccak256("case-wrong");
        vm.prank(decisionRelay);
        vm.expectRevert(abi.encodeWithSelector(Escrow.CaseIdMismatch.selector, caseId, wrongCaseId));
        escrow.settle(wrongCaseId, escrowId, 1 ether, 0, keccak256("proof"));
    }

    function test_settle_succeedsWithCorrectCaseId() public {
        _deposit(1 ether);
        uint256 claimantBefore = claimant.balance;
        vm.prank(decisionRelay);
        escrow.settle(caseId, escrowId, 1 ether, 0, keccak256("proof"));
        assertEq(claimant.balance, claimantBefore + 1 ether);
    }

    function test_deposit_storesCaseId() public {
        _deposit(1 ether);
        (,,,, bytes32 storedCaseId,) = escrow.deposits(escrowId);
        assertEq(storedCaseId, caseId);
    }

    // --- Item E: emergencyRefund() ---

    function test_emergencyRefund_revertsBeforeTimeoutElapses() public {
        _deposit(1 ether);
        vm.warp(block.timestamp + TIMEOUT - 1);
        vm.prank(decisionRelay);
        vm.expectRevert(
            abi.encodeWithSelector(Escrow.TimeoutNotElapsed.selector, block.timestamp + 1, block.timestamp)
        );
        escrow.emergencyRefund(caseId, escrowId, keccak256("emergency-proof"));
    }

    function test_emergencyRefund_paysClaimantInFullAfterTimeout() public {
        _deposit(1 ether);
        uint256 claimantBefore = claimant.balance;
        vm.warp(block.timestamp + TIMEOUT);

        vm.prank(decisionRelay);
        escrow.emergencyRefund(caseId, escrowId, keccak256("emergency-proof"));

        assertEq(claimant.balance, claimantBefore + 1 ether);
        assertEq(respondent.balance, 0);
        (Escrow.Status status,,,,,) = escrow.deposits(escrowId);
        assertEq(uint8(status), uint8(Escrow.Status.SETTLED));
    }

    function test_emergencyRefund_revertsIfNotCalledByDecisionRelay() public {
        _deposit(1 ether);
        vm.warp(block.timestamp + TIMEOUT);
        vm.expectRevert(Escrow.NotDecisionRelay.selector);
        escrow.emergencyRefund(caseId, escrowId, keccak256("emergency-proof"));
    }

    function test_emergencyRefund_revertsOnUnknownEscrow() public {
        vm.warp(block.timestamp + TIMEOUT);
        vm.prank(decisionRelay);
        vm.expectRevert(abi.encodeWithSelector(Escrow.UnknownEscrow.selector, escrowId));
        escrow.emergencyRefund(caseId, escrowId, keccak256("emergency-proof"));
    }

    function test_emergencyRefund_revertsOnCaseIdMismatch() public {
        _deposit(1 ether);
        vm.warp(block.timestamp + TIMEOUT);
        bytes32 wrongCaseId = keccak256("case-wrong");
        vm.prank(decisionRelay);
        vm.expectRevert(abi.encodeWithSelector(Escrow.CaseIdMismatch.selector, caseId, wrongCaseId));
        escrow.emergencyRefund(wrongCaseId, escrowId, keccak256("emergency-proof"));
    }

    function test_emergencyRefund_cannotBeCalledTwice() public {
        _deposit(1 ether);
        vm.warp(block.timestamp + TIMEOUT);
        vm.startPrank(decisionRelay);
        escrow.emergencyRefund(caseId, escrowId, keccak256("emergency-proof"));
        vm.expectRevert(abi.encodeWithSelector(Escrow.AlreadySettled.selector, escrowId));
        escrow.emergencyRefund(caseId, escrowId, keccak256("emergency-proof-2"));
        vm.stopPrank();
    }

    function test_emergencyRefund_revertsIfAlreadySettledNormally() public {
        // A deposit that settled normally before the timeout elapsed
        // must never be emergency-refundable afterward, even once the
        // timeout eventually passes — SETTLED is terminal regardless of
        // which path reached it.
        _deposit(1 ether);
        vm.prank(decisionRelay);
        escrow.settle(caseId, escrowId, 1 ether, 0, keccak256("proof"));

        vm.warp(block.timestamp + TIMEOUT);
        vm.prank(decisionRelay);
        vm.expectRevert(abi.encodeWithSelector(Escrow.AlreadySettled.selector, escrowId));
        escrow.emergencyRefund(caseId, escrowId, keccak256("emergency-proof"));
    }

    function test_emergencyRefund_revertsOnFailedTransfer() public {
        RevertingReceiver badClaimant = new RevertingReceiver();
        vm.deal(address(this), 1 ether);
        bytes32 badEscrowId = keccak256("escrow-bad-claimant");
        escrow.deposit{value: 1 ether}(caseId, badEscrowId, address(badClaimant), respondent);
        vm.warp(block.timestamp + TIMEOUT);

        vm.prank(decisionRelay);
        vm.expectRevert(abi.encodeWithSelector(Escrow.TransferFailed.selector, address(badClaimant), 1 ether));
        escrow.emergencyRefund(caseId, badEscrowId, keccak256("emergency-proof"));

        // Reverted transfer means the whole call reverted — status must
        // NOT have been left SETTLED with funds never actually moved.
        (Escrow.Status status,,,,,) = escrow.deposits(badEscrowId);
        assertEq(uint8(status), uint8(Escrow.Status.DEPOSITED));
    }

    function test_emergencyRefund_doesNotAffectOtherEscrows() public {
        bytes32 escrowIdB = keccak256("escrow-B");
        vm.deal(address(this), 3 ether);
        escrow.deposit{value: 1 ether}(caseId, escrowId, claimant, respondent);
        escrow.deposit{value: 2 ether}(keccak256("case-B"), escrowIdB, claimant, respondent);
        vm.warp(block.timestamp + TIMEOUT);

        vm.prank(decisionRelay);
        escrow.emergencyRefund(caseId, escrowId, keccak256("emergency-proof"));

        (Escrow.Status statusB,,,,,) = escrow.deposits(escrowIdB);
        assertEq(uint8(statusB), uint8(Escrow.Status.DEPOSITED), "unrelated escrow must be untouched");
        assertEq(address(escrow).balance, 2 ether);
    }
}

contract RevertingReceiver {
    receive() external payable {
        revert("nope");
    }
}
