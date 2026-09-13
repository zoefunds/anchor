// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {DeliveryProofReceiver} from "../contracts/DeliveryProofReceiver.sol";

// Deploys a fresh DeliveryProofReceiver bound to the CURRENTLY ACTIVE
// mailbox/ISM — a minimal transport probe per the incident recovery
// brief's Part 3: isolates whether the relayer/validator/ISM/mailbox
// chain can deliver a message AT ALL, independent of DecisionRelay or
// Escrow logic. Requires ISM_ADDRESS and MAILBOX_ADDRESS env vars —
// deliberately not defaulted, so this is never run against a guessed
// or stale pair.
contract DeployDeliveryProofReceiver is Script {
    function run() external returns (address) {
        address ism = vm.envAddress("ISM_ADDRESS");
        address mailbox = vm.envAddress("MAILBOX_ADDRESS");

        vm.startBroadcast();
        DeliveryProofReceiver receiver = new DeliveryProofReceiver(ism, mailbox);
        vm.stopBroadcast();

        console.log("DeliveryProofReceiver deployed at:", address(receiver));
        console.log("ISM:", ism);
        console.log("Mailbox:", mailbox);
        return address(receiver);
    }
}
