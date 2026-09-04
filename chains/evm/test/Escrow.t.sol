// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../contracts/Escrow.sol";

contract EscrowTest is Test {
    Escrow escrow;
    address decisionRelay = address(0xDEC1);
    address depositAuthorizer = address(0xA07E);
    address claimant = address(0xC1A1);
    address respondent = address(0xB0B1);
    bytes32 caseId = keccak256("case-1");
    bytes32 escrowId = keccak256("escrow-1");
    uint256 constant TIMEOUT = 30 days;

    function setUp() public {
        escrow = new Escrow(decisionRelay, depositAuthorizer, TIMEOUT);
    }

    // Real audit fix (finding #2): authorizeDeposit() + deposit(),
    // pranked as claimant (finding #3's msg.sender == claimant check),
    // replaces every bare `escrow.deposit(...)` call this file used to
    // make from the test contract's own address.
    function _authorize(bytes32 forCaseId, bytes32 forEscrowId, uint256 amount) internal {
        vm.prank(depositAuthorizer);
        escrow.authorizeDeposit(forCaseId, forEscrowId, claimant, respondent, amount);
    }

    function _deposit(uint256 amount) internal {
        _authorize(caseId, escrowId, amount);
        vm.deal(claimant, amount);
        vm.prank(claimant);
        escrow.deposit{value: amount}(caseId, escrowId, claimant, respondent);
    }

    // --- authorizeDeposit() ---

    function test_authorizeDeposit_recordsAuthorization() public {
        vm.prank(depositAuthorizer);
        escrow.authorizeDeposit(caseId, escrowId, claimant, respondent, 1 ether);

        (bytes32 storedCaseId, address c, address r, uint256 amount, bool exists) = escrow.depositAuthorizations(escrowId);
        assertTrue(exists);
        assertEq(storedCaseId, caseId);
        assertEq(c, claimant);
        assertEq(r, respondent);
        assertEq(amount, 1 ether);
    }

    function test_authorizeDeposit_revertsIfNotCalledByDepositAuthorizer() public {
        vm.expectRevert(Escrow.NotDepositAuthorizer.selector);
        escrow.authorizeDeposit(caseId, escrowId, claimant, respondent, 1 ether);
    }

    function test_authorizeDeposit_revertsOnSecondAuthorizationForSameEscrowId() public {
        _authorize(caseId, escrowId, 1 ether);
        vm.prank(depositAuthorizer);
        vm.expectRevert(abi.encodeWithSelector(Escrow.AlreadyAuthorized.selector, escrowId));
        escrow.authorizeDeposit(caseId, escrowId, claimant, respondent, 2 ether);
    }

    function test_authorizeDeposit_revertsIfEscrowAlreadyHasARealDeposit() public {
        // Confirms AlreadyAuthorized fires (not a separate check) for
        // an escrowId that's already been deposited into — deposit()
        // can never leave an escrowId in a "deposited but not
        // authorized" state, so this is the only error path reachable.
        _deposit(1 ether);
        vm.prank(depositAuthorizer);
        vm.expectRevert(abi.encodeWithSelector(Escrow.AlreadyAuthorized.selector, escrowId));
        escrow.authorizeDeposit(caseId, escrowId, claimant, respondent, 1 ether);
    }

    function test_authorizeDeposit_revertsOnZeroAddress() public {
        vm.prank(depositAuthorizer);
        vm.expectRevert(Escrow.ZeroAddress.selector);
        escrow.authorizeDeposit(caseId, escrowId, address(0), respondent, 1 ether);
    }

    function test_authorizeDeposit_revertsOnZeroAmount() public {
        vm.prank(depositAuthorizer);
        vm.expectRevert(Escrow.ZeroAmount.selector);
        escrow.authorizeDeposit(caseId, escrowId, claimant, respondent, 0);
    }

    // --- deposit(): the front-running fix (finding #2) ---

    function test_deposit_revertsWithNoPriorAuthorization() public {
        // The core of finding #2: an attacker (or anyone) with no
        // authorizeDeposit() call for this escrowId cannot deposit
        // anything at all, regardless of what addresses/amount they
        // pass — this is what actually stops escrowId-slot squatting,
        // not just requiring msg.sender == claimant (which an attacker
        // could trivially satisfy by naming themselves claimant).
        vm.deal(address(this), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(Escrow.NotAuthorized.selector, escrowId));
        escrow.deposit{value: 1 ether}(caseId, escrowId, claimant, respondent);
    }

    function test_deposit_revertsIfAttackerSelfAuthorizesWithDifferentClaimant() public {
        // Confirms the fix holds even for an attacker who *is* able to
        // get themselves authorized (e.g. impersonating a case they
        // don't own) with themselves as claimant: they still cannot
        // then deposit using the REAL claimant/respondent addresses,
        // because the authorization for this escrowId now permanently
        // pins a different claimant than the real one.
        address attacker = address(0xBAD1);
        vm.prank(depositAuthorizer);
        escrow.authorizeDeposit(caseId, escrowId, attacker, respondent, 1 ether);

        vm.deal(claimant, 1 ether);
        vm.prank(claimant);
        vm.expectRevert(Escrow.AuthorizationMismatch.selector);
        escrow.deposit{value: 1 ether}(caseId, escrowId, claimant, respondent);
    }

    function test_deposit_revertsOnCaseIdMismatchAgainstAuthorization() public {
        _authorize(caseId, escrowId, 1 ether);
        bytes32 wrongCaseId = keccak256("case-wrong");
        vm.deal(claimant, 1 ether);
        vm.prank(claimant);
        vm.expectRevert(Escrow.AuthorizationMismatch.selector);
        escrow.deposit{value: 1 ether}(wrongCaseId, escrowId, claimant, respondent);
    }

    function test_deposit_revertsOnAmountMismatchAgainstAuthorization() public {
        _authorize(caseId, escrowId, 1 ether);
        vm.deal(claimant, 2 ether);
        vm.prank(claimant);
        vm.expectRevert(abi.encodeWithSelector(Escrow.AmountMismatch.selector, 1 ether, 2 ether));
        escrow.deposit{value: 2 ether}(caseId, escrowId, claimant, respondent);
    }

    // --- deposit(): claimant-only depositor (finding #3) ---

    function test_deposit_revertsIfCallerIsNotClaimant() public {
        _authorize(caseId, escrowId, 1 ether);
        vm.deal(respondent, 1 ether);
        vm.prank(respondent); // the respondent trying to fund it themselves
        vm.expectRevert(abi.encodeWithSelector(Escrow.OnlyClaimantMayDeposit.selector, respondent, claimant));
        escrow.deposit{value: 1 ether}(caseId, escrowId, claimant, respondent);
    }

    function test_deposit_revertsIfCallerIsUnrelatedThirdParty() public {
        _authorize(caseId, escrowId, 1 ether);
        address thirdParty = address(0xF00D);
        vm.deal(thirdParty, 1 ether);
        vm.prank(thirdParty);
        vm.expectRevert(abi.encodeWithSelector(Escrow.OnlyClaimantMayDeposit.selector, thirdParty, claimant));
        escrow.deposit{value: 1 ether}(caseId, escrowId, claimant, respondent);
    }

    // --- deposit(): the original, still-real behavior ---

    function test_deposit_recordsClaimantRespondentAndAmount() public {
        _deposit(1 ether);

        (Escrow.Status status, address c, address r, uint256 amount, bytes32 storedCaseId,) = escrow.deposits(escrowId);
        assertEq(uint8(status), uint8(Escrow.Status.DEPOSITED));
        assertEq(c, claimant);
        assertEq(r, respondent);
        assertEq(amount, 1 ether);
        assertEq(storedCaseId, caseId);
    }

    function test_deposit_revertsOnSecondDepositForSameEscrowId() public {
        _deposit(1 ether);
        vm.deal(claimant, 1 ether);
        vm.prank(claimant);
        vm.expectRevert(abi.encodeWithSelector(Escrow.AlreadyDeposited.selector, escrowId));
        escrow.deposit{value: 1 ether}(caseId, escrowId, claimant, respondent);
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
        bytes32 caseIdB = keccak256("case-B");
        _deposit(1 ether);
        _authorize(caseIdB, escrowIdB, 2 ether);
        vm.deal(claimant, 2 ether);
        vm.prank(claimant);
        escrow.deposit{value: 2 ether}(caseIdB, escrowIdB, claimant, respondent);

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

        vm.deal(claimant, 1 ether);
        vm.prank(claimant);
        vm.expectRevert(abi.encodeWithSelector(Escrow.AlreadyDeposited.selector, escrowId));
        escrow.deposit{value: 1 ether}(caseId, escrowId, claimant, respondent);
    }

    function test_constructor_revertsOnZeroDecisionRelay() public {
        vm.expectRevert(Escrow.ZeroAddress.selector);
        new Escrow(address(0), depositAuthorizer, TIMEOUT);
    }

    function test_constructor_revertsOnZeroDepositAuthorizer() public {
        vm.expectRevert(Escrow.ZeroAddress.selector);
        new Escrow(decisionRelay, address(0), TIMEOUT);
    }

    function test_constructor_revertsOnZeroTimeout() public {
        vm.expectRevert(bytes("emergencyRefundTimeoutSeconds must be nonzero"));
        new Escrow(decisionRelay, depositAuthorizer, 0);
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
        bytes32 badEscrowId = keccak256("escrow-bad-claimant");
        vm.prank(depositAuthorizer);
        escrow.authorizeDeposit(caseId, badEscrowId, address(badClaimant), respondent, 1 ether);
        vm.deal(address(badClaimant), 1 ether);
        vm.prank(address(badClaimant));
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
        bytes32 caseIdB = keccak256("case-B");
        _deposit(1 ether);
        _authorize(caseIdB, escrowIdB, 2 ether);
        vm.deal(claimant, 2 ether);
        vm.prank(claimant);
        escrow.deposit{value: 2 ether}(caseIdB, escrowIdB, claimant, respondent);
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
