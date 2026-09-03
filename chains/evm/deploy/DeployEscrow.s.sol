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
// this escrow trusts as its sole settle() caller (immutable at deploy
// time; see Escrow.sol's `decisionRelay` doc comment for why this must
// be that contract's address, not an EOA or attestor key).
contract DeployEscrow is Script {
    function run() external returns (address) {
        address decisionRelay = vm.envAddress("DECISION_RELAY_ADDRESS");

        vm.startBroadcast();
        Escrow escrow = new Escrow(decisionRelay);
        vm.stopBroadcast();

        console.log("Escrow deployed at:", address(escrow));
        console.log("DecisionRelay (sole settle() caller):", decisionRelay);
        return address(escrow);
    }
}
