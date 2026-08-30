// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {SolanaCaseReceiver} from "../contracts/SolanaCaseReceiver.sol";

contract DeploySolanaCaseReceiver is Script {
    function run() external returns (address) {
        address mailbox = vm.envAddress("HYPERLANE_MAILBOX");

        vm.startBroadcast();
        SolanaCaseReceiver receiver = new SolanaCaseReceiver(mailbox);
        vm.stopBroadcast();

        console.log("SolanaCaseReceiver deployed at:", address(receiver));
        return address(receiver);
    }
}
