// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Mailbox} from "@hyperlane-xyz/core/contracts/Mailbox.sol";
import {MerkleTreeHook} from "@hyperlane-xyz/core/contracts/hooks/MerkleTreeHook.sol";
import {ValidatorAnnounce} from "@hyperlane-xyz/core/contracts/isms/multisig/ValidatorAnnounce.sol";
import {NoopIsm} from "@hyperlane-xyz/core/contracts/isms/NoopIsm.sol";

// Deploys OUR OWN Sepolia Mailbox + MerkleTreeHook + ValidatorAnnounce,
// because Hyperlane's own canonical shared Sepolia Mailbox
// (0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766) was found live, on 2026-09-07,
// to have its defaultHook/requiredHook NOT wired to any merkle tree hook at
// all (defaultHook is a DomainRoutingHook resolving to a non-merkle hook for
// every domain checked; requiredHook is likewise not a merkle tree hook) --
// see chains/solana/ISM_MIGRATION.md and this session's investigation.
// Real multisig-ISM-based delivery is structurally impossible over a Mailbox
// with no merkle tree hook in its chain, regardless of validator health.
//
// Both defaultHook and requiredHook are set to the SAME MerkleTreeHook here
// -- the simplest correct wiring for a proof deployment (no separate gas
// hook/IGP needed since dispatch fees aren't being metered here).
//
// defaultIsm is a NoopIsm -- irrelevant for this Mailbox's actual use
// (Sepolia is always the ORIGIN in the sepolia->solanatestnet decision
// relay flow, never the destination receiving inbound messages), but
// Mailbox.initialize() requires a non-zero value.
//
// IMPORTANT: real quorum on this new Mailbox requires ALL THREE validators
// (not just anc-hor-validator1, which this deploy's operator controls) to
// reconfigure against this new Mailbox's address and re-announce via the
// new ValidatorAnnounce below -- the two independently-operated validators
// (deployment.json's "independent-operator-gideon820001" and
// "independent-operator-bard775") must do this themselves. This script
// only deploys the contracts; it does not and cannot complete that
// coordination.
//
// Usage:
//   forge script deploy/DeployOwnMailbox.s.sol --rpc-url sepolia --broadcast --private-key $PRIVATE_KEY
contract DeployOwnMailbox is Script {
    uint32 constant SEPOLIA_DOMAIN = 11155111;

    function run() external {
        address deployer = vm.addr(vm.envUint("PRIVATE_KEY"));

        vm.startBroadcast();

        Mailbox mailbox = new Mailbox(SEPOLIA_DOMAIN);
        NoopIsm noopIsm = new NoopIsm();
        MerkleTreeHook merkleTreeHook = new MerkleTreeHook(address(mailbox));

        mailbox.initialize(deployer, address(noopIsm), address(merkleTreeHook), address(merkleTreeHook));

        ValidatorAnnounce validatorAnnounce = new ValidatorAnnounce(address(mailbox));

        vm.stopBroadcast();

        console.log("Mailbox:           ", address(mailbox));
        console.log("MerkleTreeHook:    ", address(merkleTreeHook));
        console.log("ValidatorAnnounce: ", address(validatorAnnounce));
        console.log("NoopIsm (defaultIsm, unused for outbound-only flow):", address(noopIsm));
        console.log("Owner:             ", deployer);
    }
}
