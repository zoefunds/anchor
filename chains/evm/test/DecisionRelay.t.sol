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

    uint256 attestorKey;
    address attestorAddress;
    uint256 wrongKey;

    function setUp() public {
        mailbox = new FakeMailbox();
        attestorKey = 0xA11CE;
        attestorAddress = vm.addr(attestorKey);
        wrongKey = 0xBAD;

        relay = new DecisionRelay(address(mailbox), address(0), attestorAddress);
        target = new RecordingSettlementTarget();

        relay.setTrustedSender(ORIGIN, TRUSTED_SENDER);
        relay.setSettlementTarget(ORIGIN, address(target));
    }

    /// Reproduces DecisionRelay.sol's own attestationHash computation
    /// exactly — must stay in lockstep with handle()'s.
    function _attestationHash(
        bytes32 caseId,
        string memory outcome,
        uint256 claimantAmount,
        uint256 respondentAmount,
        bytes32 escrowId,
        bytes32 proofHash
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encode("ANCHOR_DECISION_ATTESTATION_V1", ORIGIN, address(relay), caseId, outcome, claimantAmount, respondentAmount, escrowId, proofHash)
        );
    }

    function _sign(uint256 key, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        return abi.encodePacked(r, s, v);
    }

    function _body(bytes32 caseId, string memory outcome, uint256 claimantAmount, uint256 respondentAmount, bytes32 escrowId, bytes32 proofHash, uint256 signerKey)
        internal
        view
        returns (bytes memory)
    {
        bytes32 hash = _attestationHash(caseId, outcome, claimantAmount, respondentAmount, escrowId, proofHash);
        return abi.encode(caseId, outcome, claimantAmount, respondentAmount, escrowId, proofHash, _sign(signerKey, hash));
    }

    function _body(bytes32 proofHash) internal view returns (bytes memory) {
        return _body(bytes32(uint256(1)), "RELEASE_FULL", uint256(1000), uint256(0), bytes32(0), proofHash, attestorKey);
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
        bytes memory body = _body(bytes32(uint256(42)), "PARTIAL", uint256(700), uint256(300), bytes32(uint256(99)), bytes32(uint256(0xfeed)), attestorKey);

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

    /// The core new guarantee this session added: a message that passes
    /// trustedSender (i.e. dispatched by the relay wallet the Mailbox
    /// itself trusts) but carries a signature from a DIFFERENT key than
    /// the configured attestor must still be rejected. This is what
    /// actually decouples "who dispatched the Hyperlane message" from
    /// "who vouches this decision is real" — compromising the dispatch
    /// wallet/relay pipeline alone is not enough to forge a settlement.
    function test_handle_rejects_wrong_attestor_signature() public {
        bytes memory body = _body(bytes32(uint256(1)), "RELEASE_FULL", uint256(1000), uint256(0), bytes32(0), bytes32(uint256(0xabc)), wrongKey);

        vm.prank(address(mailbox));
        vm.expectRevert("invalid attestation");
        relay.handle(ORIGIN, TRUSTED_SENDER, body);

        assertEq(target.settleCallCount(), 0);
    }

    /// A signature that's valid for a DIFFERENT decision's content
    /// (correct attestor key, wrong signed fields) must not be
    /// reusable — proves the signature is actually bound to this
    /// specific decision's data, not just "signed by the right key."
    function test_handle_rejects_signature_over_different_content() public {
        // Sign attestation for caseId=1/RELEASE_FULL/1000/0, but submit a
        // body claiming caseId=1/RELEASE_FULL/9999/0 (tampered amount).
        bytes32 hash = _attestationHash(bytes32(uint256(1)), "RELEASE_FULL", uint256(1000), uint256(0), bytes32(0), bytes32(uint256(0xabc)));
        bytes memory sig = _sign(attestorKey, hash);
        bytes memory tamperedBody = abi.encode(bytes32(uint256(1)), "RELEASE_FULL", uint256(9999), uint256(0), bytes32(0), bytes32(uint256(0xabc)), sig);

        vm.prank(address(mailbox));
        vm.expectRevert("invalid attestation");
        relay.handle(ORIGIN, TRUSTED_SENDER, tamperedBody);
    }

    function test_handle_rejects_malformed_signature_length() public {
        bytes memory body = abi.encode(bytes32(uint256(1)), "RELEASE_FULL", uint256(1000), uint256(0), bytes32(0), bytes32(uint256(0xabc)), bytes("short"));

        vm.prank(address(mailbox));
        vm.expectRevert("invalid signature length");
        relay.handle(ORIGIN, TRUSTED_SENDER, body);
    }

    function test_setAttestor_rotates_and_old_signatures_stop_working() public {
        bytes memory body = _body(bytes32(uint256(1)), "RELEASE_FULL", uint256(1000), uint256(0), bytes32(0), bytes32(uint256(0xabc)), attestorKey);

        uint256 newAttestorKey = 0xC0FFEE;
        relay.setAttestor(vm.addr(newAttestorKey));

        vm.prank(address(mailbox));
        vm.expectRevert("invalid attestation");
        relay.handle(ORIGIN, TRUSTED_SENDER, body);

        // A fresh signature from the NEW attestor key succeeds.
        bytes memory newBody = _body(bytes32(uint256(1)), "RELEASE_FULL", uint256(1000), uint256(0), bytes32(0), bytes32(uint256(0xabc)), newAttestorKey);
        vm.prank(address(mailbox));
        relay.handle(ORIGIN, TRUSTED_SENDER, newBody);
        assertEq(target.settleCallCount(), 1);
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
