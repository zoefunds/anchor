// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {DecisionRelay} from "../contracts/DecisionRelay.sol";
import {TrustedRelayerIsm} from "../contracts/TrustedRelayerIsm.sol";

// Deploys DecisionRelay to whichever chain is targeted via --rpc-url /
// foundry.toml's [rpc_endpoints]. Mailbox addresses below are the real,
// canonical addresses from Hyperlane's own registry
// (github.com/hyperlane-xyz/hyperlane-registry), not guessed:
//   sepolia:      0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766
//   base_sepolia: 0x6966b0E55883d49BFB24539356a2f8A673E02039
//
// Usage:
//   forge script deploy/DeployDecisionRelay.s.sol --rpc-url sepolia --broadcast --private-key $PRIVATE_KEY
// Requires ATTESTOR_ADDRESSES (comma-separated public addresses matching
// apps/web's ATTESTOR_PRIVATE_KEYS — see DecisionRelay.sol's
// `isAttestor`/`attestorThreshold` doc comment), ATTESTOR_THRESHOLD (how
// many of those must sign for handle() to accept a decision), and
// GOVERNANCE_OWNER (the address that can add/remove attestors and
// change the threshold — see DecisionRelay.sol's `owner` doc comment on
// why this must be a real governance multisig/timelock for anything
// holding real value, never the deployer key or an attestor/backend
// key). Deliberately not derived from any key this script itself
// holds — deployer, attestors, and governance owner are three different
// trust roles.
//
// ISM: pass an already-deployed ISM via CUSTOM_ISM (e.g. a real
// StaticMerkleRootMultisigIsm from Hyperlane's own factory, requiring
// actual validator checkpoints — see docs/self-hosted-validator-setup.md).
//
// CUSTOM_ISM is now REQUIRED unless ALLOW_INSECURE_DEV_ISM=true is also
// set, in which case a fresh TrustedRelayerIsm (always-verify-true — see
// that contract's own SECURITY TRADEOFF comment) is deployed instead.
// This is deliberately a hard opt-in, not a silent default: a re-audit
// flagged that the old default-to-permissive-ISM behavior meant a
// redeploy with a missing/misspelled CUSTOM_ISM env var would silently
// regress a production deployment to an insecure trust model with no
// error at all. ALLOW_INSECURE_DEV_ISM is additionally hard-blocked on
// sepolia/mainnet-shaped chain IDs below — it only works for a local
// anvil chain (id 31337), so even setting it by mistake against a real
// network fails loudly instead of deploying something insecure.
contract DeployDecisionRelay is Script {
    uint256 constant LOCAL_ANVIL_CHAIN_ID = 31337;

    function run() external returns (address) {
        address mailbox = vm.envAddress("HYPERLANE_MAILBOX");
        address governanceOwner = vm.envAddress("GOVERNANCE_OWNER");
        address[] memory attestorAddresses = vm.envAddress("ATTESTOR_ADDRESSES", ",");
        uint256 attestorThreshold = vm.envUint("ATTESTOR_THRESHOLD");
        address customIsm = vm.envOr("CUSTOM_ISM", address(0));
        bool allowInsecureDevIsm = vm.envOr("ALLOW_INSECURE_DEV_ISM", false);

        if (customIsm == address(0)) {
            require(allowInsecureDevIsm, "CUSTOM_ISM is required (or explicitly set ALLOW_INSECURE_DEV_ISM=true for local dev only)");
            require(block.chainid == LOCAL_ANVIL_CHAIN_ID, "ALLOW_INSECURE_DEV_ISM only works on local anvil (chainid 31337) - refusing on a real network");
        }

        vm.startBroadcast();
        if (customIsm == address(0)) {
            TrustedRelayerIsm ism = new TrustedRelayerIsm();
            customIsm = address(ism);
            console.log("TrustedRelayerIsm (INSECURE, local-dev-only) deployed at:", customIsm);
        } else {
            console.log("Using pre-deployed ISM at:", customIsm);
        }
        DecisionRelay relay = new DecisionRelay(mailbox, governanceOwner, customIsm, attestorAddresses, attestorThreshold);
        vm.stopBroadcast();

        console.log("DecisionRelay deployed at:", address(relay));
        console.log("Mailbox used:", mailbox);
        console.log("Governance owner:", governanceOwner);
        console.log("Attestor count:", attestorAddresses.length);
        console.log("Attestor threshold:", attestorThreshold);
        return address(relay);
    }
}
