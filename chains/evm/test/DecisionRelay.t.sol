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

contract RecordingEmergencyRefundTarget {
    uint256 public refundCallCount;
    bytes32 public lastCaseId;
    bytes32 public lastEscrowId;
    bytes32 public lastProofHash;

    function emergencyRefund(bytes32 caseId, bytes32 escrowId, bytes32 proofHash) external {
        refundCallCount++;
        lastCaseId = caseId;
        lastEscrowId = escrowId;
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

    // 3 attestors, 2-of-3 threshold — the default shape this suite
    // exercises; individual tests can deploy their own relay with a
    // different N/threshold where that matters (e.g. the constructor
    // validation tests).
    uint256 attestorKey1;
    uint256 attestorKey2;
    uint256 attestorKey3;
    address attestorAddress1;
    address attestorAddress2;
    address attestorAddress3;
    uint256 wrongKey;

    function setUp() public {
        mailbox = new FakeMailbox();
        attestorKey1 = 0xA11CE1;
        attestorKey2 = 0xA11CE2;
        attestorKey3 = 0xA11CE3;
        attestorAddress1 = vm.addr(attestorKey1);
        attestorAddress2 = vm.addr(attestorKey2);
        attestorAddress3 = vm.addr(attestorKey3);
        wrongKey = 0xBAD;

        address[] memory attestors = new address[](3);
        attestors[0] = attestorAddress1;
        attestors[1] = attestorAddress2;
        attestors[2] = attestorAddress3;

        relay = new DecisionRelay(address(mailbox), address(this), address(0), attestors, 2);
        target = new RecordingSettlementTarget();

        relay.setTrustedSender(ORIGIN, TRUSTED_SENDER);
        relay.setSettlementTarget(ORIGIN, address(target));
        relay.setSettlementMode(ORIGIN, DecisionRelay.SettlementMode.SETTLEMENT);
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
            abi.encode("ANCHOR_DECISION_ATTESTATION_V2", ORIGIN, address(relay), caseId, outcome, claimantAmount, respondentAmount, escrowId, proofHash)
        );
    }

    function _sign(uint256 key, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        return abi.encodePacked(r, s, v);
    }

    function _bodyWithKeys(
        bytes32 caseId,
        string memory outcome,
        uint256 claimantAmount,
        uint256 respondentAmount,
        bytes32 escrowId,
        bytes32 proofHash,
        uint256[] memory signerKeys
    ) internal view returns (bytes memory) {
        bytes32 hash = _attestationHash(caseId, outcome, claimantAmount, respondentAmount, escrowId, proofHash);
        bytes[] memory sigs = new bytes[](signerKeys.length);
        for (uint256 i = 0; i < signerKeys.length; i++) {
            sigs[i] = _sign(signerKeys[i], hash);
        }
        return abi.encode(caseId, outcome, claimantAmount, respondentAmount, escrowId, proofHash, sigs);
    }

    function _keys2() internal view returns (uint256[] memory) {
        uint256[] memory keys = new uint256[](2);
        keys[0] = attestorKey1;
        keys[1] = attestorKey2;
        return keys;
    }

    function _body(bytes32 proofHash) internal view returns (bytes memory) {
        return _bodyWithKeys(bytes32(uint256(1)), "RELEASE_FULL", uint256(1000), uint256(0), bytes32(0), proofHash, _keys2());
    }

    /// Reproduces DecisionRelay.sol's emergencyRefund() attestation hash
    /// exactly — must stay in lockstep with that function's own.
    function _emergencyRefundHash(address settlementTargetAddr, bytes32 caseId, bytes32 escrowId, bytes32 proofHash)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encode("ANCHOR_EMERGENCY_REFUND_V1", address(relay), settlementTargetAddr, caseId, escrowId, proofHash));
    }

    function _emergencyRefundSigs(address settlementTargetAddr, bytes32 caseId, bytes32 escrowId, bytes32 proofHash, uint256[] memory signerKeys)
        internal
        view
        returns (bytes[] memory)
    {
        bytes32 hash = _emergencyRefundHash(settlementTargetAddr, caseId, escrowId, proofHash);
        bytes[] memory sigs = new bytes[](signerKeys.length);
        for (uint256 i = 0; i < signerKeys.length; i++) {
            sigs[i] = _sign(signerKeys[i], hash);
        }
        return sigs;
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
        bytes memory body = _bodyWithKeys(bytes32(uint256(42)), "PARTIAL", uint256(700), uint256(300), bytes32(uint256(99)), bytes32(uint256(0xfeed)), _keys2());

        vm.prank(address(mailbox));
        relay.handle(ORIGIN, TRUSTED_SENDER, body);

        assertEq(target.lastCaseId(), bytes32(uint256(42)));
        assertEq(target.lastEscrowId(), bytes32(uint256(99)));
        assertEq(target.lastClaimantAmount(), 700);
        assertEq(target.lastRespondentAmount(), 300);
        assertEq(target.lastProofHash(), bytes32(uint256(0xfeed)));
    }

    // Real fix (external audit finding, the incident's own root cause):
    // an origin whose mode was never explicitly configured must revert,
    // not silently succeed as notification-only. This directly replaces
    // the old test_handle_no_settlement_target_configured_does_not_revert
    // (deleted — it asserted exactly the behavior that caused the real
    // production incident this session: a decision permanently marked
    // processed with no settlement ever attempted, no error, no retry
    // path).
    function test_handle_revertsForUnconfiguredOrigin() public {
        uint32 freshOrigin = 999999;
        relay.setTrustedSender(freshOrigin, TRUSTED_SENDER);
        // Deliberately NOT calling setSettlementMode for freshOrigin —
        // it stays at the zero value, UNCONFIGURED.
        vm.prank(address(mailbox));
        vm.expectRevert("settlement mode not configured for this origin");
        relay.handle(freshOrigin, TRUSTED_SENDER, _body(bytes32(uint256(1))));
    }

    /// The actual guarantee the incident needed and didn't have: a
    /// message delivered to an UNCONFIGURED origin must revert WITHOUT
    /// writing processedDecisions, so the exact same message can be
    /// retried successfully once the origin is properly configured —
    /// nothing about it is permanently consumed by the failed attempt.
    function test_handle_unconfiguredOriginLeavesProcessedFalseAndAllowsRetryAfterConfiguration() public {
        uint32 freshOrigin = 999999;
        relay.setTrustedSender(freshOrigin, TRUSTED_SENDER);
        bytes32 proofHash = bytes32(uint256(0xfeed));

        // _attestationHash hardcodes the ORIGIN constant, so a body
        // built through it is never valid for a different origin —
        // build one signed against freshOrigin directly, matching
        // handle()'s own attestationHash computation exactly.
        bytes32 hash = keccak256(
            abi.encode("ANCHOR_DECISION_ATTESTATION_V2", freshOrigin, address(relay), bytes32(uint256(1)), "RELEASE_FULL", uint256(1000), uint256(0), bytes32(0), proofHash)
        );
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(attestorKey1, hash);
        sigs[1] = _sign(attestorKey2, hash);
        bytes memory body = abi.encode(bytes32(uint256(1)), "RELEASE_FULL", uint256(1000), uint256(0), bytes32(0), proofHash, sigs);

        vm.prank(address(mailbox));
        vm.expectRevert("settlement mode not configured for this origin");
        relay.handle(freshOrigin, TRUSTED_SENDER, body);
        assertFalse(relay.processedDecisions(proofHash));

        // Now configure it for real and retry the SAME message.
        relay.setSettlementTarget(freshOrigin, address(target));
        relay.setSettlementMode(freshOrigin, DecisionRelay.SettlementMode.SETTLEMENT);
        vm.prank(address(mailbox));
        relay.handle(freshOrigin, TRUSTED_SENDER, body);
        assertTrue(relay.processedDecisions(proofHash));
        assertEq(target.settleCallCount(), 1);
    }

    /// setSettlementMode itself refuses to enter SETTLEMENT mode with no
    /// target configured — fails at configuration time, not later as a
    /// per-decision handle() revert.
    function test_setSettlementMode_revertsEnteringSettlementModeWithNoTarget() public {
        uint32 freshOrigin = 999998;
        vm.expectRevert("settlementTarget not set for SETTLEMENT mode");
        relay.setSettlementMode(freshOrigin, DecisionRelay.SettlementMode.SETTLEMENT);
    }

    /// NOTIFICATION_ONLY is a real, distinct, explicit mode — the
    /// decision is recorded (processedDecisions set, DecisionReceived
    /// emitted) but settle() is deliberately never called, even if a
    /// settlementTarget happens to be configured for that origin. This
    /// is what a genuinely notification-only route (e.g. Solana's
    /// ReplayGuard-style handle()) should look like, explicitly — not
    /// an accidental side effect of an unset target.
    function test_handle_notificationOnlyModeNeverCallsSettleEvenWithTargetConfigured() public {
        relay.setSettlementMode(ORIGIN, DecisionRelay.SettlementMode.NOTIFICATION_ONLY);
        // _body(proofHash) — the argument is the proofHash, not caseId
        // (caseId is hardcoded to bytes32(uint256(1)) inside it).
        bytes32 proofHash = bytes32(uint256(0xfeed));

        vm.prank(address(mailbox));
        relay.handle(ORIGIN, TRUSTED_SENDER, _body(proofHash));

        assertTrue(relay.processedDecisions(proofHash));
        assertEq(target.settleCallCount(), 0, "NOTIFICATION_ONLY must never call settle()");
    }

    function test_setSettlementMode_emitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit DecisionRelay.SettlementModeChanged(ORIGIN, DecisionRelay.SettlementMode.SETTLEMENT, DecisionRelay.SettlementMode.NOTIFICATION_ONLY);
        relay.setSettlementMode(ORIGIN, DecisionRelay.SettlementMode.NOTIFICATION_ONLY);
    }

    /// Exactly threshold-many (2-of-3) DISTINCT valid attestor signatures
    /// must succeed — the ordinary happy path for an M-of-N deployment.
    function test_handle_accepts_exactly_threshold_signatures() public {
        vm.prank(address(mailbox));
        relay.handle(ORIGIN, TRUSTED_SENDER, _body(bytes32(uint256(1))));
        assertEq(target.settleCallCount(), 1);
    }

    /// More than threshold (3-of-3) must also succeed — extra valid
    /// signatures are never a reason to reject.
    function test_handle_accepts_above_threshold_signatures() public {
        uint256[] memory keys = new uint256[](3);
        keys[0] = attestorKey1;
        keys[1] = attestorKey2;
        keys[2] = attestorKey3;
        bytes memory body = _bodyWithKeys(bytes32(uint256(1)), "RELEASE_FULL", uint256(1000), uint256(0), bytes32(0), bytes32(uint256(0xabc)), keys);

        vm.prank(address(mailbox));
        relay.handle(ORIGIN, TRUSTED_SENDER, body);
        assertEq(target.settleCallCount(), 1);
    }

    /// Only 1-of-3 signatures (below the 2-of-3 threshold) must be
    /// rejected — the entire point of M-of-N: a single attestor alone
    /// (even a genuine one) cannot authorize a settlement.
    function test_handle_rejects_below_threshold_signatures() public {
        uint256[] memory keys = new uint256[](1);
        keys[0] = attestorKey1;
        bytes memory body = _bodyWithKeys(bytes32(uint256(1)), "RELEASE_FULL", uint256(1000), uint256(0), bytes32(0), bytes32(uint256(0xabc)), keys);

        vm.prank(address(mailbox));
        vm.expectRevert("insufficient valid attestations");
        relay.handle(ORIGIN, TRUSTED_SENDER, body);
        assertEq(target.settleCallCount(), 0);
    }

    /// The same attestor's signature repeated twice in the array must
    /// count as ONE signer, not two — otherwise a single compromised key
    /// could satisfy a 2-of-3 threshold alone by duplicating its own
    /// signature, defeating the entire M-of-N guarantee.
    function test_handle_rejects_duplicate_signer_counted_twice() public {
        uint256[] memory keys = new uint256[](2);
        keys[0] = attestorKey1;
        keys[1] = attestorKey1;
        bytes memory body = _bodyWithKeys(bytes32(uint256(1)), "RELEASE_FULL", uint256(1000), uint256(0), bytes32(0), bytes32(uint256(0xabc)), keys);

        vm.prank(address(mailbox));
        vm.expectRevert("insufficient valid attestations");
        relay.handle(ORIGIN, TRUSTED_SENDER, body);
        assertEq(target.settleCallCount(), 0);
    }

    /// One genuine attestor signature plus one from a non-attestor key
    /// must still fail — the non-attestor signature simply doesn't
    /// count, so this is really "1 valid signature," below threshold.
    function test_handle_rejects_mix_of_valid_and_invalid_signers() public {
        uint256[] memory keys = new uint256[](2);
        keys[0] = attestorKey1;
        keys[1] = wrongKey;
        bytes memory body = _bodyWithKeys(bytes32(uint256(1)), "RELEASE_FULL", uint256(1000), uint256(0), bytes32(0), bytes32(uint256(0xabc)), keys);

        vm.prank(address(mailbox));
        vm.expectRevert("insufficient valid attestations");
        relay.handle(ORIGIN, TRUSTED_SENDER, body);
        assertEq(target.settleCallCount(), 0);
    }

    /// A signature that's valid for a DIFFERENT decision's content
    /// (correct attestor keys, wrong signed fields) must not be
    /// reusable — proves the signatures are actually bound to this
    /// specific decision's data, not just "signed by the right keys."
    function test_handle_rejects_signature_over_different_content() public {
        // Sign attestation for caseId=1/RELEASE_FULL/1000/0, but submit a
        // body claiming caseId=1/RELEASE_FULL/9999/0 (tampered amount).
        bytes32 hash = _attestationHash(bytes32(uint256(1)), "RELEASE_FULL", uint256(1000), uint256(0), bytes32(0), bytes32(uint256(0xabc)));
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(attestorKey1, hash);
        sigs[1] = _sign(attestorKey2, hash);
        bytes memory tamperedBody = abi.encode(bytes32(uint256(1)), "RELEASE_FULL", uint256(9999), uint256(0), bytes32(0), bytes32(uint256(0xabc)), sigs);

        vm.prank(address(mailbox));
        vm.expectRevert("insufficient valid attestations");
        relay.handle(ORIGIN, TRUSTED_SENDER, tamperedBody);
    }

    /// A malformed (wrong-length) signature inside the array must not
    /// revert the whole call — ecrecover-style recovery from a bad
    /// signature simply shouldn't count as valid, so the array can
    /// safely mix a corrupt entry with genuine ones without one bad
    /// entry causing a hard revert distinct from "not enough valid
    /// signatures."
    function test_handle_rejects_malformed_signature_length() public {
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = bytes("short");
        bytes memory body = abi.encode(bytes32(uint256(1)), "RELEASE_FULL", uint256(1000), uint256(0), bytes32(0), bytes32(uint256(0xabc)), sigs);

        vm.prank(address(mailbox));
        vm.expectRevert("invalid signature length");
        relay.handle(ORIGIN, TRUSTED_SENDER, body);
    }

    function test_removeAttestor_rotates_and_old_signer_no_longer_counts() public {
        relay.removeAttestor(attestorAddress3); // count 3 -> 2, still >= threshold 2

        // 2-of-3 body signed by attestor1 + the now-removed attestor3
        // must fall to only 1 valid signer, below threshold.
        uint256[] memory keys = new uint256[](2);
        keys[0] = attestorKey1;
        keys[1] = attestorKey3;
        bytes memory body = _bodyWithKeys(bytes32(uint256(1)), "RELEASE_FULL", uint256(1000), uint256(0), bytes32(0), bytes32(uint256(0xabc)), keys);

        vm.prank(address(mailbox));
        vm.expectRevert("insufficient valid attestations");
        relay.handle(ORIGIN, TRUSTED_SENDER, body);
        assertEq(target.settleCallCount(), 0);
    }

    function test_removeAttestor_reverts_below_threshold() public {
        relay.removeAttestor(attestorAddress3); // count 3 -> 2 == threshold
        vm.expectRevert("would drop below threshold");
        relay.removeAttestor(attestorAddress2); // would bring count to 1 < threshold 2
    }

    function test_addAttestor_new_signer_counts_toward_threshold() public {
        uint256 newAttestorKey = 0xC0FFEE;
        relay.addAttestor(vm.addr(newAttestorKey));

        uint256[] memory keys = new uint256[](2);
        keys[0] = newAttestorKey;
        keys[1] = attestorKey1;
        bytes memory body = _bodyWithKeys(bytes32(uint256(1)), "RELEASE_FULL", uint256(1000), uint256(0), bytes32(0), bytes32(uint256(0xabc)), keys);

        vm.prank(address(mailbox));
        relay.handle(ORIGIN, TRUSTED_SENDER, body);
        assertEq(target.settleCallCount(), 1);
    }

    function test_addAttestor_rejects_duplicate() public {
        vm.expectRevert("already an attestor");
        relay.addAttestor(attestorAddress1);
    }

    function test_addAttestor_rejects_zero_address() public {
        vm.expectRevert("zero address attestor");
        relay.addAttestor(address(0));
    }

    function test_setAttestorThreshold_raises_bar() public {
        relay.setAttestorThreshold(3);

        // Previously-sufficient 2-of-3 now falls short of the new 3-of-3 bar.
        vm.prank(address(mailbox));
        vm.expectRevert("insufficient valid attestations");
        relay.handle(ORIGIN, TRUSTED_SENDER, _body(bytes32(uint256(1))));
    }

    function test_setAttestorThreshold_rejects_above_count() public {
        vm.expectRevert("invalid threshold");
        relay.setAttestorThreshold(4);
    }

    function test_setAttestorThreshold_rejects_zero() public {
        vm.expectRevert("invalid threshold");
        relay.setAttestorThreshold(0);
    }

    function test_constructor_rejects_threshold_above_attestor_count() public {
        address[] memory attestors = new address[](2);
        attestors[0] = attestorAddress1;
        attestors[1] = attestorAddress2;
        vm.expectRevert("invalid threshold");
        new DecisionRelay(address(mailbox), address(this), address(0), attestors, 3);
    }

    function test_constructor_rejects_zero_threshold() public {
        address[] memory attestors = new address[](2);
        attestors[0] = attestorAddress1;
        attestors[1] = attestorAddress2;
        vm.expectRevert("invalid threshold");
        new DecisionRelay(address(mailbox), address(this), address(0), attestors, 0);
    }

    function test_constructor_rejects_duplicate_attestors() public {
        address[] memory attestors = new address[](2);
        attestors[0] = attestorAddress1;
        attestors[1] = attestorAddress1;
        vm.expectRevert("duplicate attestor");
        new DecisionRelay(address(mailbox), address(this), address(0), attestors, 1);
    }

    function test_constructor_rejects_zero_address_owner() public {
        address[] memory attestors = new address[](2);
        attestors[0] = attestorAddress1;
        attestors[1] = attestorAddress2;
        vm.expectRevert("zero address owner");
        new DecisionRelay(address(mailbox), address(0), address(0), attestors, 1);
    }

    /// Governance change events — an off-chain monitor watching for these
    /// is the actual enforcement mechanism behind "owner should be a
    /// real multisig, not a single key" (see DecisionRelay.sol's `owner`
    /// doc comment): the contract itself can't stop a compromised owner
    /// from lowering the threshold, but it can guarantee the change is
    /// impossible to make silently.
    function test_addAttestor_emits_event() public {
        uint256 newAttestorKey = 0xC0FFEE;
        address newAttestor = vm.addr(newAttestorKey);
        vm.expectEmit(true, false, false, false);
        emit DecisionRelay.AttestorAdded(newAttestor);
        relay.addAttestor(newAttestor);
    }

    function test_removeAttestor_emits_event() public {
        vm.expectEmit(true, false, false, false);
        emit DecisionRelay.AttestorRemoved(attestorAddress3);
        relay.removeAttestor(attestorAddress3);
    }

    function test_setAttestorThreshold_emits_event() public {
        vm.expectEmit(false, false, false, true);
        emit DecisionRelay.AttestorThresholdChanged(2, 3);
        relay.setAttestorThreshold(3);
    }

    function test_setTrustedSender_emits_event() public {
        bytes32 newSender = bytes32(uint256(0xf00d));
        vm.expectEmit(true, false, false, true);
        emit DecisionRelay.TrustedSenderChanged(ORIGIN, TRUSTED_SENDER, newSender);
        relay.setTrustedSender(ORIGIN, newSender);
    }

    function test_setSettlementTarget_emits_event() public {
        address newTarget = address(0xBEEF);
        vm.expectEmit(true, false, false, true);
        emit DecisionRelay.SettlementTargetChanged(ORIGIN, address(target), newTarget);
        relay.setSettlementTarget(ORIGIN, newTarget);
    }

    /// The availability-hardening guard: an oversized signature array
    /// (more entries than there are registered attestors) is rejected
    /// outright rather than burning gas on the O(n^2) dedup loop — see
    /// handle()'s own comment on why this cap exists.
    function test_handle_rejects_oversized_signature_array() public {
        uint256[] memory keys = new uint256[](4);
        keys[0] = attestorKey1;
        keys[1] = attestorKey2;
        keys[2] = attestorKey1;
        keys[3] = attestorKey2;
        bytes memory body = _bodyWithKeys(bytes32(uint256(1)), "RELEASE_FULL", uint256(1000), uint256(0), bytes32(0), bytes32(uint256(0xabc)), keys);

        vm.prank(address(mailbox));
        vm.expectRevert("too many signatures supplied");
        relay.handle(ORIGIN, TRUSTED_SENDER, body);
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

    // --- Item E: emergencyRefund() ---

    function test_emergencyRefund_succeedsWithThresholdSignatures() public {
        RecordingEmergencyRefundTarget refundTarget = new RecordingEmergencyRefundTarget();
        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        bytes[] memory sigs = _emergencyRefundSigs(address(refundTarget), caseId, escrowId, proofHash, _keys2());

        relay.emergencyRefund(address(refundTarget), caseId, escrowId, proofHash, sigs);

        assertEq(refundTarget.refundCallCount(), 1);
        assertEq(refundTarget.lastCaseId(), caseId);
        assertEq(refundTarget.lastEscrowId(), escrowId);
        assertEq(refundTarget.lastProofHash(), proofHash);
        assertTrue(relay.processedDecisions(proofHash));
    }

    function test_emergencyRefund_worksEvenWhenSettlementModeIsUnconfigured() public {
        // The whole point: this must still work for an origin/target
        // whose settlementMode/settlementTarget wiring is exactly what's
        // broken — the real incident scenario. It never even reads
        // settlementMode/settlementTarget, and isn't routed through
        // handle()/the Mailbox at all.
        uint32 freshOrigin = 999;
        RecordingEmergencyRefundTarget refundTarget = new RecordingEmergencyRefundTarget();
        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        bytes[] memory sigs = _emergencyRefundSigs(address(refundTarget), caseId, escrowId, proofHash, _keys2());

        assertEq(uint8(relay.settlementMode(freshOrigin)), uint8(DecisionRelay.SettlementMode.UNCONFIGURED));
        relay.emergencyRefund(address(refundTarget), caseId, escrowId, proofHash, sigs);
        assertEq(refundTarget.refundCallCount(), 1);
    }

    function test_emergencyRefund_revertsBelowThreshold() public {
        RecordingEmergencyRefundTarget refundTarget = new RecordingEmergencyRefundTarget();
        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        uint256[] memory oneKey = new uint256[](1);
        oneKey[0] = attestorKey1;
        bytes[] memory sigs = _emergencyRefundSigs(address(refundTarget), caseId, escrowId, proofHash, oneKey);

        vm.expectRevert("insufficient valid attestations");
        relay.emergencyRefund(address(refundTarget), caseId, escrowId, proofHash, sigs);
        assertEq(refundTarget.refundCallCount(), 0);
    }

    function test_emergencyRefund_revertsOnUnregisteredSigner() public {
        // Proves this is not "any 2 signatures" — they must be from
        // real, registered attestors. A single genuinely-registered
        // attestor signing twice, or non-attestor keys, must not
        // substitute for real threshold consensus (no unilateral path).
        RecordingEmergencyRefundTarget refundTarget = new RecordingEmergencyRefundTarget();
        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        uint256[] memory keys = new uint256[](2);
        keys[0] = attestorKey1;
        keys[1] = wrongKey;
        bytes[] memory sigs = _emergencyRefundSigs(address(refundTarget), caseId, escrowId, proofHash, keys);

        vm.expectRevert("insufficient valid attestations");
        relay.emergencyRefund(address(refundTarget), caseId, escrowId, proofHash, sigs);
    }

    function test_emergencyRefund_revertsOnDuplicateSignerCountedTwice() public {
        RecordingEmergencyRefundTarget refundTarget = new RecordingEmergencyRefundTarget();
        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        uint256[] memory keys = new uint256[](2);
        keys[0] = attestorKey1;
        keys[1] = attestorKey1;
        bytes[] memory sigs = _emergencyRefundSigs(address(refundTarget), caseId, escrowId, proofHash, keys);

        vm.expectRevert("insufficient valid attestations");
        relay.emergencyRefund(address(refundTarget), caseId, escrowId, proofHash, sigs);
    }

    function test_emergencyRefund_revertsOnAlreadyProcessedProofHash() public {
        RecordingEmergencyRefundTarget refundTarget = new RecordingEmergencyRefundTarget();
        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        bytes[] memory sigs = _emergencyRefundSigs(address(refundTarget), caseId, escrowId, proofHash, _keys2());

        relay.emergencyRefund(address(refundTarget), caseId, escrowId, proofHash, sigs);

        // Duplicate recovery must be rejected — same proofHash, even
        // against a fresh target instance, must not process twice.
        vm.expectRevert("already processed");
        relay.emergencyRefund(address(refundTarget), caseId, escrowId, proofHash, sigs);
        assertEq(refundTarget.refundCallCount(), 1);
    }

    function test_emergencyRefund_sameProofHashSharedWithHandleIsAlsoRejected() public {
        // processedDecisions is one shared namespace between handle()
        // and emergencyRefund() — proves a proofHash already consumed
        // by a normal settlement can't be replayed as an "emergency"
        // refund either, and vice versa (tested the other direction is
        // implied by symmetry of the same mapping/require).
        bytes32 proofHash = bytes32(uint256(0xabc));
        vm.prank(address(mailbox));
        relay.handle(ORIGIN, TRUSTED_SENDER, _body(proofHash));
        assertTrue(relay.processedDecisions(proofHash));

        RecordingEmergencyRefundTarget refundTarget = new RecordingEmergencyRefundTarget();
        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes[] memory sigs = _emergencyRefundSigs(address(refundTarget), caseId, escrowId, proofHash, _keys2());

        vm.expectRevert("already processed");
        relay.emergencyRefund(address(refundTarget), caseId, escrowId, proofHash, sigs);
    }

    function test_emergencyRefund_revertsOnZeroTargetAddress() public {
        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        bytes[] memory sigs = _emergencyRefundSigs(address(0), caseId, escrowId, proofHash, _keys2());

        vm.expectRevert("zero settlement target");
        relay.emergencyRefund(address(0), caseId, escrowId, proofHash, sigs);
    }

    function test_emergencyRefund_revertsWhenTargetCallReverts_andProcessedFlagRollsBack() public {
        // Same reentrancy/rollback discipline as handle()'s own
        // settlement-target-revert test: a reverting target must not
        // leave the proofHash permanently marked processed with no
        // refund having actually happened — that combination would be
        // exactly this project's original incident (processedDecisions
        // set true, but nothing ever paid out, permanently).
        RevertingEmergencyRefundTarget badTarget = new RevertingEmergencyRefundTarget();
        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        bytes[] memory sigs = _emergencyRefundSigs(address(badTarget), caseId, escrowId, proofHash, _keys2());

        vm.expectRevert("target rejected refund");
        relay.emergencyRefund(address(badTarget), caseId, escrowId, proofHash, sigs);
        assertFalse(relay.processedDecisions(proofHash));

        // Retrying against a working target with the exact same
        // proofHash must now succeed.
        RecordingEmergencyRefundTarget goodTarget = new RecordingEmergencyRefundTarget();
        bytes[] memory sigsForGoodTarget = _emergencyRefundSigs(address(goodTarget), caseId, escrowId, proofHash, _keys2());
        relay.emergencyRefund(address(goodTarget), caseId, escrowId, proofHash, sigsForGoodTarget);
        assertTrue(relay.processedDecisions(proofHash));
        assertEq(goodTarget.refundCallCount(), 1);
    }

    function test_emergencyRefund_signatureCannotBeReplayedAgainstDifferentTarget() public {
        // settlementTargetAddr is part of the signed content — a
        // signature authorizing a refund THROUGH one target contract
        // must not be replayable to redirect the call through a
        // different one.
        RecordingEmergencyRefundTarget targetA = new RecordingEmergencyRefundTarget();
        RecordingEmergencyRefundTarget targetB = new RecordingEmergencyRefundTarget();
        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        bytes[] memory sigsForA = _emergencyRefundSigs(address(targetA), caseId, escrowId, proofHash, _keys2());

        vm.expectRevert("insufficient valid attestations");
        relay.emergencyRefund(address(targetB), caseId, escrowId, proofHash, sigsForA);
    }

    // --- Item Phase 2: attestedSettle() ---
    //
    // Same-chain settlement authorized purely by M-of-N attestor
    // signatures, with no Mailbox/relayer/validator/checkpoint
    // involvement at all — the direct answer to the Sepolia self-loop
    // incident. Mirrors emergencyRefund()'s own test coverage shape
    // since it's the same trust pattern (attestations are the entire
    // authority), applied to the normal settlement path instead of the
    // refund escape hatch.

    function _directSettleHash(
        bytes32 caseId,
        string memory outcome,
        uint256 claimantAmount,
        uint256 respondentAmount,
        bytes32 escrowId,
        bytes32 proofHash,
        address settlementTargetAddr,
        uint256 deadline
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                "ANCHOR_DIRECT_SETTLE_V1",
                block.chainid,
                address(relay),
                settlementTargetAddr,
                caseId,
                outcome,
                claimantAmount,
                respondentAmount,
                escrowId,
                proofHash,
                deadline
            )
        );
    }

    function _directSettleSigs(
        bytes32 caseId,
        string memory outcome,
        uint256 claimantAmount,
        uint256 respondentAmount,
        bytes32 escrowId,
        bytes32 proofHash,
        address settlementTargetAddr,
        uint256 deadline,
        uint256[] memory signerKeys
    ) internal view returns (bytes[] memory) {
        bytes32 hash = _directSettleHash(caseId, outcome, claimantAmount, respondentAmount, escrowId, proofHash, settlementTargetAddr, deadline);
        bytes[] memory sigs = new bytes[](signerKeys.length);
        for (uint256 i = 0; i < signerKeys.length; i++) {
            sigs[i] = _sign(signerKeys[i], hash);
        }
        return sigs;
    }

    function _futureDeadline() internal view returns (uint256) {
        return block.timestamp + 1 hours;
    }

    function test_attestedSettle_succeedsWithThresholdSignaturesAndForwardsExactParams() public {
        RecordingSettlementTarget directTarget = new RecordingSettlementTarget();
        relay.setDirectSettlementTarget(address(directTarget));

        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        uint256 deadline = _futureDeadline();
        bytes[] memory sigs =
            _directSettleSigs(caseId, "RELEASE_FULL", 1000, 500, escrowId, proofHash, address(directTarget), deadline, _keys2());

        relay.attestedSettle(caseId, "RELEASE_FULL", 1000, 500, escrowId, proofHash, address(directTarget), deadline, sigs);

        assertEq(directTarget.settleCallCount(), 1);
        assertEq(directTarget.lastCaseId(), caseId);
        assertEq(directTarget.lastEscrowId(), escrowId);
        assertEq(directTarget.lastClaimantAmount(), 1000);
        assertEq(directTarget.lastRespondentAmount(), 500);
        assertEq(directTarget.lastProofHash(), proofHash);
        assertTrue(relay.processedDecisions(proofHash));
    }

    function test_attestedSettle_revertsBelowThreshold() public {
        RecordingSettlementTarget directTarget = new RecordingSettlementTarget();
        relay.setDirectSettlementTarget(address(directTarget));

        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        uint256 deadline = _futureDeadline();
        uint256[] memory oneKey = new uint256[](1);
        oneKey[0] = attestorKey1;
        bytes[] memory sigs = _directSettleSigs(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(directTarget), deadline, oneKey);

        vm.expectRevert("insufficient valid attestations");
        relay.attestedSettle(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(directTarget), deadline, sigs);
        assertEq(directTarget.settleCallCount(), 0);
    }

    function test_attestedSettle_revertsOnUnregisteredSigner() public {
        RecordingSettlementTarget directTarget = new RecordingSettlementTarget();
        relay.setDirectSettlementTarget(address(directTarget));

        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        uint256 deadline = _futureDeadline();
        uint256[] memory keys = new uint256[](2);
        keys[0] = attestorKey1;
        keys[1] = wrongKey;
        bytes[] memory sigs = _directSettleSigs(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(directTarget), deadline, keys);

        vm.expectRevert("insufficient valid attestations");
        relay.attestedSettle(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(directTarget), deadline, sigs);
    }

    function test_attestedSettle_revertsOnDuplicateSignerCountedTwice() public {
        RecordingSettlementTarget directTarget = new RecordingSettlementTarget();
        relay.setDirectSettlementTarget(address(directTarget));

        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        uint256 deadline = _futureDeadline();
        uint256[] memory keys = new uint256[](2);
        keys[0] = attestorKey1;
        keys[1] = attestorKey1;
        bytes[] memory sigs = _directSettleSigs(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(directTarget), deadline, keys);

        vm.expectRevert("insufficient valid attestations");
        relay.attestedSettle(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(directTarget), deadline, sigs);
    }

    function test_attestedSettle_revertsOnAlreadyProcessedProofHash() public {
        RecordingSettlementTarget directTarget = new RecordingSettlementTarget();
        relay.setDirectSettlementTarget(address(directTarget));

        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        uint256 deadline = _futureDeadline();
        bytes[] memory sigs = _directSettleSigs(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(directTarget), deadline, _keys2());

        relay.attestedSettle(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(directTarget), deadline, sigs);

        vm.expectRevert("decision already settled");
        relay.attestedSettle(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(directTarget), deadline, sigs);
        assertEq(directTarget.settleCallCount(), 1);
    }

    function test_attestedSettle_sameProofHashSharedWithHandleIsAlsoRejected() public {
        // processedDecisions is one shared namespace across handle(),
        // emergencyRefund(), and attestedSettle() — a proofHash already
        // consumed by a Hyperlane-delivered decision must not be
        // replayable through the direct-settlement path either.
        bytes32 proofHash = bytes32(uint256(0xabc));
        vm.prank(address(mailbox));
        relay.handle(ORIGIN, TRUSTED_SENDER, _body(proofHash));
        assertTrue(relay.processedDecisions(proofHash));

        RecordingSettlementTarget directTarget = new RecordingSettlementTarget();
        relay.setDirectSettlementTarget(address(directTarget));
        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        uint256 deadline = _futureDeadline();
        bytes[] memory sigs = _directSettleSigs(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(directTarget), deadline, _keys2());

        vm.expectRevert("decision already settled");
        relay.attestedSettle(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(directTarget), deadline, sigs);
    }

    function test_attestedSettle_revertsOnZeroDirectSettlementTarget() public {
        // directSettlementTarget defaults to address(0). settlementTargetAddr
        // must match the CONFIGURED target (checked before the zero-address
        // guard), so signing over address(0) itself is what's needed to
        // reach the "no direct settlement target configured" revert — an
        // address mismatch would revert on the config-match check first.
        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        uint256 deadline = _futureDeadline();
        bytes[] memory sigs = _directSettleSigs(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(0), deadline, _keys2());

        assertEq(relay.directSettlementTarget(), address(0));
        vm.expectRevert("no direct settlement target configured");
        relay.attestedSettle(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(0), deadline, sigs);
    }

    function test_attestedSettle_revertsWhenTargetCallReverts_andProcessedFlagRollsBack() public {
        RevertingSettlementTarget badTarget = new RevertingSettlementTarget();
        relay.setDirectSettlementTarget(address(badTarget));

        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        uint256 deadline = _futureDeadline();
        bytes[] memory sigs = _directSettleSigs(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(badTarget), deadline, _keys2());

        vm.expectRevert("settlement target rejected");
        relay.attestedSettle(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(badTarget), deadline, sigs);
        assertFalse(relay.processedDecisions(proofHash));

        // Retrying against a working target with the exact same
        // proofHash must now succeed — the revert must not have
        // permanently burned the proofHash. A fresh signature is
        // required since settlementTargetAddr is signed content and the
        // target address is changing.
        RecordingSettlementTarget goodTarget = new RecordingSettlementTarget();
        relay.setDirectSettlementTarget(address(goodTarget));
        bytes[] memory sigsForGoodTarget =
            _directSettleSigs(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(goodTarget), deadline, _keys2());
        relay.attestedSettle(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(goodTarget), deadline, sigsForGoodTarget);
        assertTrue(relay.processedDecisions(proofHash));
        assertEq(goodTarget.settleCallCount(), 1);
    }

    function test_attestedSettle_signatureCannotBeReplayedAgainstDifferentOutcomeOrAmounts() public {
        // outcome/claimantAmount/respondentAmount are all part of the
        // signed content — a signature authorizing one payout split must
        // not be replayable to force a different one through.
        RecordingSettlementTarget directTarget = new RecordingSettlementTarget();
        relay.setDirectSettlementTarget(address(directTarget));

        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        uint256 deadline = _futureDeadline();
        bytes[] memory sigsForSplitA =
            _directSettleSigs(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(directTarget), deadline, _keys2());

        vm.expectRevert("insufficient valid attestations");
        relay.attestedSettle(caseId, "RELEASE_FULL", 500, 500, escrowId, proofHash, address(directTarget), deadline, sigsForSplitA);
    }

    function test_attestedSettle_signatureCannotBeReplayedAgainstHandlesAttestationScheme() public {
        // A signature computed for handle()'s "ANCHOR_DECISION_ATTESTATION_V2"
        // scheme must not satisfy attestedSettle()'s
        // "ANCHOR_DIRECT_SETTLE_V1" scheme, even over the same logical
        // case/outcome/amounts/escrow/proofHash — proves the two paths'
        // domain separation actually holds.
        RecordingSettlementTarget directTarget = new RecordingSettlementTarget();
        relay.setDirectSettlementTarget(address(directTarget));

        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        uint256 deadline = _futureDeadline();

        bytes32 handleHash = _attestationHash(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(attestorKey1, handleHash);
        sigs[1] = _sign(attestorKey2, handleHash);

        vm.expectRevert("insufficient valid attestations");
        relay.attestedSettle(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(directTarget), deadline, sigs);
    }

    function test_attestedSettle_revertsOnExpiredDeadline() public {
        // Real audit fix: a signature valid forever is a real replay
        // risk (a stale, no-longer-intended settlement submitted years
        // later). deadline is signed content AND independently checked
        // against block.timestamp, so it can't just be omitted/altered
        // after the fact either.
        RecordingSettlementTarget directTarget = new RecordingSettlementTarget();
        relay.setDirectSettlementTarget(address(directTarget));

        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        uint256 expiredDeadline = block.timestamp == 0 ? 0 : block.timestamp - 1;
        bytes[] memory sigs =
            _directSettleSigs(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(directTarget), expiredDeadline, _keys2());

        vm.expectRevert("attestation expired");
        relay.attestedSettle(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(directTarget), expiredDeadline, sigs);
        assertEq(directTarget.settleCallCount(), 0);
    }

    function test_attestedSettle_revertsWhenDeadlineTampered() public {
        // deadline is part of the signed digest — submitting with a
        // DIFFERENT (even later, still-valid) deadline than what was
        // actually signed must not pass signature verification.
        RecordingSettlementTarget directTarget = new RecordingSettlementTarget();
        relay.setDirectSettlementTarget(address(directTarget));

        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        uint256 signedDeadline = _futureDeadline();
        bytes[] memory sigs =
            _directSettleSigs(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(directTarget), signedDeadline, _keys2());

        uint256 tamperedDeadline = signedDeadline + 1 hours;
        vm.expectRevert("insufficient valid attestations");
        relay.attestedSettle(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(directTarget), tamperedDeadline, sigs);
    }

    function test_attestedSettle_revertsWhenSettlementTargetAddrDoesNotMatchConfigured() public {
        // Real audit fix: settlementTargetAddr is checked against the
        // LIVE configured directSettlementTarget, not just used blindly
        // — closes the window where an owner changes
        // directSettlementTarget between signing and submission and an
        // already-collected signature could otherwise redirect funds to
        // a target no attestor actually agreed to.
        RecordingSettlementTarget signedTarget = new RecordingSettlementTarget();
        RecordingSettlementTarget actualConfiguredTarget = new RecordingSettlementTarget();
        relay.setDirectSettlementTarget(address(actualConfiguredTarget));

        bytes32 caseId = bytes32(uint256(1));
        bytes32 escrowId = bytes32(uint256(2));
        bytes32 proofHash = bytes32(uint256(0xdead));
        uint256 deadline = _futureDeadline();
        // Attestors sign over signedTarget, but the LIVE configured
        // target is actualConfiguredTarget (e.g. changed after signing).
        bytes[] memory sigs =
            _directSettleSigs(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(signedTarget), deadline, _keys2());

        vm.expectRevert("settlementTargetAddr does not match configured directSettlementTarget");
        relay.attestedSettle(caseId, "RELEASE_FULL", 1000, 0, escrowId, proofHash, address(signedTarget), deadline, sigs);
        assertEq(signedTarget.settleCallCount(), 0);
        assertEq(actualConfiguredTarget.settleCallCount(), 0);
    }

    function test_setDirectSettlementTarget_emitsEvent() public {
        RecordingSettlementTarget directTarget = new RecordingSettlementTarget();
        vm.expectEmit(true, true, true, true);
        emit DecisionRelay.DirectSettlementTargetChanged(address(0), address(directTarget));
        relay.setDirectSettlementTarget(address(directTarget));
        assertEq(relay.directSettlementTarget(), address(directTarget));
    }

    function test_setDirectSettlementTarget_revertsForNonOwner() public {
        RecordingSettlementTarget directTarget = new RecordingSettlementTarget();
        vm.prank(address(0xB0B));
        vm.expectRevert("not owner");
        relay.setDirectSettlementTarget(address(directTarget));
    }
}

contract RevertingEmergencyRefundTarget {
    function emergencyRefund(bytes32, bytes32, bytes32) external pure {
        revert("target rejected refund");
    }
}
