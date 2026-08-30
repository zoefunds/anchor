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
interface IInterchainSecurityModule {
    function moduleType() external view returns (uint8);
    function verify(bytes calldata _metadata, bytes calldata _message) external returns (bool);
}

contract TrustedRelayerIsm is IInterchainSecurityModule {
    // moduleType 0 = UNUSED in Hyperlane's ModuleType enum — this ISM
    // implements none of the standard schemes (multisig/aggregation/
    // routing/etc), it's a custom always-valid check.
    function moduleType() external pure returns (uint8) {
        return 0;
    }

    function verify(bytes calldata, bytes calldata) external pure returns (bool) {
        return true;
    }
}
