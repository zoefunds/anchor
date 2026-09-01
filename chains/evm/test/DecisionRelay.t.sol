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

        relay = new DecisionRelay(address(mailbox), address(0), attestors, 2);
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

    function test_handle_no_settlement_target_configured_does_not_revert() public {
        relay.setSettlementTarget(ORIGIN, address(0));
        vm.prank(address(mailbox));
        relay.handle(ORIGIN, TRUSTED_SENDER, _body(bytes32(uint256(1))));
        // No assertion beyond "didn't revert" — there's nothing to
        // settle against, this just confirms DecisionRelay itself
        // doesn't require one.
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
        new DecisionRelay(address(mailbox), address(0), attestors, 3);
    }

    function test_constructor_rejects_zero_threshold() public {
        address[] memory attestors = new address[](2);
        attestors[0] = attestorAddress1;
        attestors[1] = attestorAddress2;
        vm.expectRevert("invalid threshold");
        new DecisionRelay(address(mailbox), address(0), attestors, 0);
    }

    function test_constructor_rejects_duplicate_attestors() public {
        address[] memory attestors = new address[](2);
        attestors[0] = attestorAddress1;
        attestors[1] = attestorAddress1;
        vm.expectRevert("duplicate attestor");
        new DecisionRelay(address(mailbox), address(0), attestors, 1);
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
