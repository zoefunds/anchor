// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AuditAnchor} from "../contracts/AuditAnchor.sol";

// Usage:
//   forge script deploy/DeployAuditAnchor.s.sol --rpc-url sepolia --broadcast --private-key $PRIVATE_KEY
contract DeployAuditAnchor is Script {
    function run() external returns (address) {
        vm.startBroadcast();
        AuditAnchor anchor = new AuditAnchor();
        vm.stopBroadcast();

        console.log("AuditAnchor deployed at:", address(anchor));
        return address(anchor);
    }
}
