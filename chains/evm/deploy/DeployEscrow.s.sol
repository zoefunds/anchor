// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Escrow} from "../contracts/Escrow.sol";

// Minimal interface for the two DecisionRelay owner-only setters this
// script can optionally call right after deploying a new Escrow — see
// this file's WIRE_DECISION_RELAY_TARGET doc comment below for why.
// Deliberately not importing DecisionRelay.sol's full contract: this
// script only ever needs to call these two functions, and pulling in
// the real interface would coincidentally also compile-couple this
// escrow-only deploy script to DecisionRelay's full source.
interface IDecisionRelayOwnerSetters {
    function setSettlementTarget(uint32 domain, address target) external;
    function setDirectSettlementTarget(address target) external;
}

// Deploys Escrow, the real ISettlementTarget implementation
// DecisionRelay.sol calls into — see Escrow.sol's own header for scope
// (native ETH only, this first version).
//
// Usage:
//   forge script deploy/DeployEscrow.s.sol --rpc-url sepolia --broadcast --private-key $PRIVATE_KEY
//
// Requires DECISION_RELAY_ADDRESS — the already-deployed DecisionRelay
// this escrow trusts as its sole settle()/emergencyRefund() caller
// (immutable at deploy time; see Escrow.sol's `decisionRelay` doc
// comment for why this must be that contract's address, not an EOA or
// attestor key).
//
// Requires DEPOSIT_AUTHORIZER_ADDRESS (security-audit fix, finding #2)
// — the address trusted to call authorizeDeposit() before deposit()
// will accept anything for a given escrowId. This is Anchor's own
// backend dispatch wallet (the same address already trusted as
// DecisionRelay's trustedSender), NOT the DecisionRelay contract or the
// Safe — see Escrow.sol's `depositAuthorizer` doc comment for why this
// is deliberately a separate, lower-ceremony trust boundary than
// settle()/emergencyRefund()'s M-of-N attestor threshold.
//
// Optional EMERGENCY_REFUND_TIMEOUT_SECONDS (see Escrow.sol's Item E
// emergencyRefund()) — defaults to 30 days if unset. Deliberately far
// longer than this system's normal adjudication+appeal timeline (hours
// to a couple of days per docs/policy-v1.md), since this exists for a
// genuinely stuck/abandoned case, not as a faster alternative path.
contract DeployEscrow is Script {
    uint256 constant DEFAULT_EMERGENCY_REFUND_TIMEOUT_SECONDS = 30 days;

    // Real incident this closes (2026-09-18 -> 2026-09-19): a redeploy of
    // Escrow (to shorten emergencyRefundTimeoutSeconds) correctly named
    // its DecisionRelay at construction, and the app correctly registered
    // a new SettlementIntegration pointing at it - but nothing in that
    // deploy actually called DecisionRelay.setSettlementTarget /
    // setDirectSettlementTarget to repoint the relay AT this new escrow.
    // Those are separately-governed, owner-only values on the OTHER
    // contract; a case bound to the new integration accepted a real
    // deposit before the gap was caught, entirely because "deploy the
    // new escrow" and "wire the relay to it" were two disconnected
    // manual steps days apart instead of one atomic operation.
    //
    // Set WIRE_DECISION_RELAY_TARGET=true (and DECISION_RELAY_DOMAIN,
    // default 11155111/Sepolia) to have this script also call both
    // setters in the SAME broadcast run, right after deploying - only
    // works if the broadcasting key is also DecisionRelay's owner (true
    // for this deployment's current owner EOA; see
    // deployment-manifest.json's own flag on that). If it isn't, the
    // broadcast reverts with DecisionRelay's own onlyOwner revert
    // message - loud and immediate, at deploy time, not a silent gap
    // discovered later at settlement dispatch. Defaults to false so a
    // caller who genuinely doesn't hold the owner key (or is
    // intentionally staging an escrow before wiring it, e.g. testing)
    // isn't forced into a reverting broadcast.
    function run() external returns (address) {
        address decisionRelay = vm.envAddress("DECISION_RELAY_ADDRESS");
        address depositAuthorizer = vm.envAddress("DEPOSIT_AUTHORIZER_ADDRESS");
        uint256 emergencyRefundTimeoutSeconds = vm.envOr("EMERGENCY_REFUND_TIMEOUT_SECONDS", DEFAULT_EMERGENCY_REFUND_TIMEOUT_SECONDS);
        bool wireDecisionRelayTarget = vm.envOr("WIRE_DECISION_RELAY_TARGET", false);
        uint32 decisionRelayDomain = uint32(vm.envOr("DECISION_RELAY_DOMAIN", uint256(11155111)));

        vm.startBroadcast();
        Escrow escrow = new Escrow(decisionRelay, depositAuthorizer, emergencyRefundTimeoutSeconds);
        if (wireDecisionRelayTarget) {
            IDecisionRelayOwnerSetters(decisionRelay).setSettlementTarget(decisionRelayDomain, address(escrow));
            IDecisionRelayOwnerSetters(decisionRelay).setDirectSettlementTarget(address(escrow));
        }
        vm.stopBroadcast();

        console.log("Escrow deployed at:", address(escrow));
        console.log("DecisionRelay (sole settle()/emergencyRefund() caller):", decisionRelay);
        console.log("depositAuthorizer (sole authorizeDeposit() caller):", depositAuthorizer);
        console.log("emergencyRefundTimeoutSeconds:", emergencyRefundTimeoutSeconds);
        if (wireDecisionRelayTarget) {
            console.log("DecisionRelay.settlementTarget/directSettlementTarget wired to this escrow for domain:", decisionRelayDomain);
        } else {
            console.log("WIRE_DECISION_RELAY_TARGET not set - DecisionRelay NOT repointed at this escrow. Run setSettlementTarget/setDirectSettlementTarget separately before any case is bound to it.");
        }
        return address(escrow);
    }
}
