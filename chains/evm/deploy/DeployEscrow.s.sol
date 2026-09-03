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
// Optional EMERGENCY_REFUND_TIMEOUT_SECONDS (see Escrow.sol's Item E
// emergencyRefund()) — defaults to 30 days if unset. Deliberately far
// longer than this system's normal adjudication+appeal timeline (hours
// to a couple of days per docs/policy-v1.md), since this exists for a
// genuinely stuck/abandoned case, not as a faster alternative path.
contract DeployEscrow is Script {
    uint256 constant DEFAULT_EMERGENCY_REFUND_TIMEOUT_SECONDS = 30 days;

    function run() external returns (address) {
        address decisionRelay = vm.envAddress("DECISION_RELAY_ADDRESS");
        uint256 emergencyRefundTimeoutSeconds = vm.envOr("EMERGENCY_REFUND_TIMEOUT_SECONDS", DEFAULT_EMERGENCY_REFUND_TIMEOUT_SECONDS);

        vm.startBroadcast();
        Escrow escrow = new Escrow(decisionRelay, emergencyRefundTimeoutSeconds);
        vm.stopBroadcast();

        console.log("Escrow deployed at:", address(escrow));
        console.log("DecisionRelay (sole settle()/emergencyRefund() caller):", decisionRelay);
        console.log("emergencyRefundTimeoutSeconds:", emergencyRefundTimeoutSeconds);
        return address(escrow);
    }
}
