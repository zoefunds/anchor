// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DecisionRelay} from "../contracts/DecisionRelay.sol";

/// Fake Mailbox: lets tests call handle() directly as if the real
/// Hyperlane Mailbox had delivered a message, and its address is what
/// DecisionRelay's onlyMailbox modifier checks against.
contract FakeMailbox {
    function dispatch(uint32, bytes32, bytes calldata) external payable returns (bytes32) {
        return bytes32(0);
    }

    function quoteDispatch(uint32, bytes32, bytes calldata) external pure returns (uint256) {
        return 0;
    }
}

contract RecordingSettlementTarget {
    uint256 public settleCallCount;
    bytes32 public lastCaseId;
    bytes32 public lastEscrowId;
    uint256 public lastClaimantAmount;
    uint256 public lastRespondentAmount;
    bytes32 public lastProofHash;

    function settle(
        bytes32 caseId,
        bytes32 escrowId,
        uint256 claimantAmount,
        uint256 respondentAmount,
        bytes32 proofHash
    ) external {
        settleCallCount++;
        lastCaseId = caseId;
        lastEscrowId = escrowId;
        lastClaimantAmount = claimantAmount;
        lastRespondentAmount = respondentAmount;
        lastProofHash = proofHash;
    }
}

/// A settlement target that always reverts — stands in for a real escrow
/// rejecting a settle() call (insufficient funds, already settled by
/// some other path, a business-logic guard, whatever). What matters for
/// DecisionRelay itself is that this failure can't leave the message
/// half-processed.
contract RevertingSettlementTarget {
    function settle(bytes32, bytes32, uint256, uint256, bytes32) external pure {
        revert("settlement target rejected");
    }
}

contract DecisionRelayTest is Test {
    FakeMailbox mailbox;
    DecisionRelay relay;
    RecordingSettlementTarget target;

    uint32 constant ORIGIN = 11155111;
    bytes32 constant TRUSTED_SENDER = bytes32(uint256(0xdead));

    function setUp() public {
        mailbox = new FakeMailbox();
        relay = new DecisionRelay(address(mailbox), address(0));
        target = new RecordingSettlementTarget();

        relay.setTrustedSender(ORIGIN, TRUSTED_SENDER);
        relay.setSettlementTarget(ORIGIN, address(target));
    }

    function _body(bytes32 proofHash) internal pure returns (bytes memory) {
        return abi.encode(
            bytes32(uint256(1)), // caseId
            "RELEASE_FULL", // outcome
            uint256(1000), // claimantAmount
            uint256(0), // respondentAmount
            bytes32(0), // escrowId
            proofHash
        );
    }

    function test_handle_settles_once() public {
        vm.prank(address(mailbox));
        relay.handle(ORIGIN, TRUSTED_SENDER, _body(bytes32(uint256(0xabc))));
        assertEq(target.settleCallCount(), 1);
    }

    /// The core idempotency guarantee this test suite exists to prove: a
    /// second Hyperlane message carrying the same decision's proofHash —
    /// exactly what a naive retry after a lost ack would produce — must
    /// not settle twice, no matter how many times Anchor's backend
    /// resends it.
    function test_handle_rejects_duplicate_proofHash() public {
        bytes32 proofHash = bytes32(uint256(0xabc));

        vm.prank(address(mailbox));
        relay.handle(ORIGIN, TRUSTED_SENDER, _body(proofHash));
        assertEq(target.settleCallCount(), 1);

        vm.prank(address(mailbox));
        vm.expectRevert("decision already settled");
        relay.handle(ORIGIN, TRUSTED_SENDER, _body(proofHash));

        assertEq(target.settleCallCount(), 1);
    }

    function test_handle_allows_distinct_decisions() public {
        vm.prank(address(mailbox));
        relay.handle(ORIGIN, TRUSTED_SENDER, _body(bytes32(uint256(1))));

        vm.prank(address(mailbox));
        relay.handle(ORIGIN, TRUSTED_SENDER, _body(bytes32(uint256(2))));

        assertEq(target.settleCallCount(), 2);
    }

    function test_handle_rejects_untrusted_sender() public {
        vm.prank(address(mailbox));
        vm.expectRevert("untrusted sender");
        relay.handle(ORIGIN, bytes32(uint256(0xbeef)), _body(bytes32(uint256(1))));
    }

    function test_handle_rejects_non_mailbox_caller() public {
        vm.expectRevert("not mailbox");
        relay.handle(ORIGIN, TRUSTED_SENDER, _body(bytes32(uint256(1))));
    }

    function test_handle_forwards_exact_settlement_params() public {
        bytes memory body = abi.encode(
            bytes32(uint256(42)), // caseId
            "PARTIAL",
            uint256(700),
            uint256(300),
            bytes32(uint256(99)), // escrowId
            bytes32(uint256(0xfeed))
        );

        vm.prank(address(mailbox));
        relay.handle(ORIGIN, TRUSTED_SENDER, body);

        assertEq(target.lastCaseId(), bytes32(uint256(42)));
        assertEq(target.lastEscrowId(), bytes32(uint256(99)));
        assertEq(target.lastClaimantAmount(), 700);
        assertEq(target.lastRespondentAmount(), 300);
        assertEq(target.lastProofHash(), bytes32(uint256(0xfeed)));
    }

    function test_handle_no_settlement_target_configured_does_not_revert() public {
        relay.setSettlementTarget(ORIGIN, address(0));
        vm.prank(address(mailbox));
        relay.handle(ORIGIN, TRUSTED_SENDER, _body(bytes32(uint256(1))));
        // No assertion beyond "didn't revert" — there's nothing to
        // settle against, this just confirms DecisionRelay itself
        // doesn't require one.
    }

    /// The atomicity guarantee behind the idempotency claim: if the
    /// settlement target itself rejects the call, the ENTIRE
    /// transaction — including the processedDecisions[proofHash] write —
    /// must roll back with it (ordinary EVM revert semantics, since that
    /// write happens before the external call, not after). Otherwise a
    /// decision could get marked "settled" while the actual settlement
    /// never happened, permanently blocking any future retry.
    function test_handle_settlement_target_revert_rolls_back_processed_flag() public {
        RevertingSettlementTarget badTarget = new RevertingSettlementTarget();
        relay.setSettlementTarget(ORIGIN, address(badTarget));

        bytes32 proofHash = bytes32(uint256(0xabc));
        vm.prank(address(mailbox));
        vm.expectRevert("settlement target rejected");
        relay.handle(ORIGIN, TRUSTED_SENDER, _body(proofHash));

        assertFalse(relay.processedDecisions(proofHash));

        // Fixing the target and retrying the exact same message must now
        // succeed — proving the failed attempt left nothing behind.
        relay.setSettlementTarget(ORIGIN, address(target));
        vm.prank(address(mailbox));
        relay.handle(ORIGIN, TRUSTED_SENDER, _body(proofHash));
        assertTrue(relay.processedDecisions(proofHash));
        assertEq(target.settleCallCount(), 1);
    }
}
