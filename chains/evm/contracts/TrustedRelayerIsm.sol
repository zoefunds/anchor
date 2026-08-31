// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// A minimal custom ISM for DecisionRelay.sol, replacing dependence on the
// origin chain's default ISM.
//
// Why this exists: Sepolia's own default recipient ISM (used by any
// contract that doesn't override `interchainSecurityModule()`) is an
// aggregation ISM requiring 2 independent multisig checkpoints
// (confirmed live via `modulesAndThreshold()` — threshold 2, two
// sub-modules). Our self-hosted relayer (chains/hyperlane-relayer/)
// could only assemble metadata for 1 of the 2, leaving a real dispatched
// message permanently undeliverable through no fault of the dispatch
// itself. Per Hyperlane's own convention, a recipient contract is meant
// to choose its own ISM rather than depend on the chain default forever
// — this is that choice, made explicit instead of inherited.
//
// SECURITY TRADEOFF (read before reusing this for anything holding real
// value): verify() always returns true. This ISM performs NO
// cryptographic check that a message genuinely originated from the
// claimed origin chain — it trusts that only a legitimate message ever
// reaches Mailbox.process() in the first place. That's an acceptable
// posture for Anchor's current MVP trust model (a single operator runs
// both the dispatching wallet and the only relayer that will ever submit
// process() for these messages — see chains/hyperlane-relayer/README.md),
// but it is NOT a substitute for real multisig/aggregation security.
// Replace this before routing anything where an attacker forging a fake
// DecisionRelay message would cause real financial loss.
//
// A compensating control now sits at the RECIPIENT, not this ISM:
// DecisionRelay.sol's handle() independently verifies a real ECDSA
// signature (via ecrecover) from a dedicated `attestor` key over the
// decision's own content, and rejects anything that doesn't recover to
// that address — see that contract's own doc comment. That closes the
// specific gap of "the relay/dispatch pipeline is compromised, so any
// settlement it wants gets accepted," since forging a settlement now
// needs the attestor's private key specifically, not just control of
// this ISM's trust path or the dispatch wallet. It does NOT make this
// ISM itself real origin verification — a message can still only reach
// Mailbox.process() at all via whatever this ISM's own (currently
// none) checks allow, so a genuinely adversarial relayer/ISM operator
// is still a real threat model this hasn't closed. Real multisig/
// validator ISM verification remains the honest fix for that layer.
interface IInterchainSecurityModule {
    function moduleType() external view returns (uint8);
    function verify(bytes calldata _metadata, bytes calldata _message) external returns (bool);
}

contract TrustedRelayerIsm is IInterchainSecurityModule {
    // moduleType 6 = NULL in Hyperlane's ModuleType enum — the "no
    // metadata required" type, which is what this always-valid check
    // actually is. Returning 0 (UNUSED) here was a real bug: UNUSED is
    // explicitly documented in hyperlane-core as "INVALID ISM" and has no
    // metadata-builder mapping in the relayer at all, so every relayer
    // attempting to build metadata for a message routed through this ISM
    // fails deterministically with "Unknown or invalid module type
    // (Unused)" and the message is stuck retrying forever, never
    // producing a process() transaction. Confirmed live: this exact
    // error was observed in the self-hosted relayer's logs for message
    // 0x18e255fbfe907d167f49c3211bd41ec4a8c831760888e8fa72b012c75a3a1256,
    // and confirmed against the vendored relayer source
    // (agents/relayer/src/msg/metadata/message_builder.rs) that
    // ModuleType::Null (6) is the variant mapped to NullMetadataBuilder,
    // the correct handler for an always-true, no-metadata ISM like this
    // one.
    function moduleType() external pure returns (uint8) {
        return 6;
    }

    function verify(bytes calldata, bytes calldata) external pure returns (bool) {
        return true;
    }
}
