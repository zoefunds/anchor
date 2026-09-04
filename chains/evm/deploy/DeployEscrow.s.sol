// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Escrow} from "../contracts/Escrow.sol";

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

    function run() external returns (address) {
        address decisionRelay = vm.envAddress("DECISION_RELAY_ADDRESS");
        address depositAuthorizer = vm.envAddress("DEPOSIT_AUTHORIZER_ADDRESS");
        uint256 emergencyRefundTimeoutSeconds = vm.envOr("EMERGENCY_REFUND_TIMEOUT_SECONDS", DEFAULT_EMERGENCY_REFUND_TIMEOUT_SECONDS);

        vm.startBroadcast();
        Escrow escrow = new Escrow(decisionRelay, depositAuthorizer, emergencyRefundTimeoutSeconds);
        vm.stopBroadcast();

        console.log("Escrow deployed at:", address(escrow));
        console.log("DecisionRelay (sole settle()/emergencyRefund() caller):", decisionRelay);
        console.log("depositAuthorizer (sole authorizeDeposit() caller):", depositAuthorizer);
        console.log("emergencyRefundTimeoutSeconds:", emergencyRefundTimeoutSeconds);
        return address(escrow);
    }
}
