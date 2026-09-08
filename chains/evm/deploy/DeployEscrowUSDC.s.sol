// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {EscrowUSDC} from "../contracts/EscrowUSDC.sol";

// Deploys EscrowUSDC — Track 2's USDC-first ISettlementTarget, a
// separate deployment from Escrow.sol (native ETH). See
// EscrowUSDC.sol's own header for why this is not a modification of
// the existing contract.
//
// Usage:
//   forge script deploy/DeployEscrowUSDC.s.sol --rpc-url sepolia --broadcast --private-key $PRIVATE_KEY
//
// NOT RUN as part of this change — see this repo's Track 2 handoff
// notes. Broadcasting requires real Sepolia deploy credentials this
// sandbox does not have safely scoped for that purpose.
//
// Requires USDC_TOKEN_ADDRESS — defaults to Circle's official Sepolia
// testnet USDC deployment, 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238.
// This default has NOT been independently re-verified against a live
// RPC call in this environment (no Sepolia RPC access available here)
// — re-confirm symbol()=="USDC" and decimals()==6 against this address
// before ever broadcasting a real deployment against it.
//
// Requires DECISION_RELAY_ADDRESS and DEPOSIT_AUTHORIZER_ADDRESS — same
// meaning as DeployEscrow.s.sol's own (this is the same already-deployed
// DecisionRelay and the same backend dispatch wallet; a USDC escrow is a
// new settlement target for the SAME relay, not a new relay).
//
// Optional EMERGENCY_REFUND_TIMEOUT_SECONDS — defaults to 30 days,
// identical reasoning to DeployEscrow.s.sol.
contract DeployEscrowUSDC is Script {
    address constant DEFAULT_SEPOLIA_USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    uint256 constant DEFAULT_EMERGENCY_REFUND_TIMEOUT_SECONDS = 30 days;

    function run() external returns (address) {
        address usdcToken = vm.envOr("USDC_TOKEN_ADDRESS", DEFAULT_SEPOLIA_USDC);
        address decisionRelay = vm.envAddress("DECISION_RELAY_ADDRESS");
        address depositAuthorizer = vm.envAddress("DEPOSIT_AUTHORIZER_ADDRESS");
        uint256 emergencyRefundTimeoutSeconds = vm.envOr("EMERGENCY_REFUND_TIMEOUT_SECONDS", DEFAULT_EMERGENCY_REFUND_TIMEOUT_SECONDS);

        vm.startBroadcast();
        EscrowUSDC escrow = new EscrowUSDC(usdcToken, decisionRelay, depositAuthorizer, emergencyRefundTimeoutSeconds);
        vm.stopBroadcast();

        console.log("EscrowUSDC deployed at:", address(escrow));
        console.log("usdcToken:", usdcToken);
        console.log("DecisionRelay (sole settle()/emergencyRefund() caller):", decisionRelay);
        console.log("depositAuthorizer (sole authorizeDeposit() caller):", depositAuthorizer);
        console.log("emergencyRefundTimeoutSeconds:", emergencyRefundTimeoutSeconds);
        return address(escrow);
    }
}
