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
// Leaving CUSTOM_ISM unset deploys a fresh TrustedRelayerIsm instead — an
// always-verify-true placeholder, see that contract's own SECURITY
// TRADEOFF comment for why that's not a real trust boundary and should
// only be used for local/staging iteration, never a real deployment.
contract DeployDecisionRelay is Script {
    function run() external returns (address) {
        address mailbox = vm.envAddress("HYPERLANE_MAILBOX");
        address governanceOwner = vm.envAddress("GOVERNANCE_OWNER");
        address[] memory attestorAddresses = vm.envAddress("ATTESTOR_ADDRESSES", ",");
        uint256 attestorThreshold = vm.envUint("ATTESTOR_THRESHOLD");
        address customIsm = vm.envOr("CUSTOM_ISM", address(0));

        vm.startBroadcast();
        if (customIsm == address(0)) {
            TrustedRelayerIsm ism = new TrustedRelayerIsm();
            customIsm = address(ism);
            console.log("TrustedRelayerIsm deployed at:", customIsm);
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
