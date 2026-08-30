// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {DecisionRelay} from "../contracts/DecisionRelay.sol";
import {TrustedRelayerIsm} from "../contracts/TrustedRelayerIsm.sol";

// Deploys TrustedRelayerIsm, then DecisionRelay pointed at it, to
// whichever chain is targeted via --rpc-url / foundry.toml's
// [rpc_endpoints]. Mailbox addresses below are the real, canonical
// addresses from Hyperlane's own registry
// (github.com/hyperlane-xyz/hyperlane-registry), not guessed:
//   sepolia:      0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766
//   base_sepolia: 0x6966b0E55883d49BFB24539356a2f8A673E02039
//
// Usage:
//   forge script deploy/DeployDecisionRelay.s.sol --rpc-url sepolia --broadcast --private-key $PRIVATE_KEY
contract DeployDecisionRelay is Script {
    function run() external returns (address) {
        address mailbox = vm.envAddress("HYPERLANE_MAILBOX");

        vm.startBroadcast();
        TrustedRelayerIsm ism = new TrustedRelayerIsm();
        DecisionRelay relay = new DecisionRelay(mailbox, address(ism));
        vm.stopBroadcast();

        console.log("TrustedRelayerIsm deployed at:", address(ism));
        console.log("DecisionRelay deployed at:", address(relay));
        console.log("Mailbox used:", mailbox);
        return address(relay);
    }
}
