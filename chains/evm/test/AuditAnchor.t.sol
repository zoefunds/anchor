// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AuditAnchor} from "../contracts/AuditAnchor.sol";

contract AuditAnchorTest is Test {
    AuditAnchor anchor;

    function setUp() public {
        anchor = new AuditAnchor();
    }

    function test_owner_is_deployer() public view {
        assertEq(anchor.owner(), address(this));
    }

    function test_anchor_records_hash_and_timestamp() public {
        bytes32 orgIdHash = keccak256("org-1");
        bytes32 auditHash = keccak256("chain-head-1");

        vm.warp(1000);
        anchor.anchor(orgIdHash, auditHash);

        assertEq(anchor.latestAnchoredHash(orgIdHash), auditHash);
        assertEq(anchor.latestAnchoredAt(orgIdHash), 1000);
    }

    function test_anchor_overwrites_previous_hash_for_same_org() public {
        bytes32 orgIdHash = keccak256("org-1");
        anchor.anchor(orgIdHash, keccak256("chain-head-1"));
        anchor.anchor(orgIdHash, keccak256("chain-head-2"));
        assertEq(anchor.latestAnchoredHash(orgIdHash), keccak256("chain-head-2"));
    }

    function test_anchor_is_independent_per_org() public {
        bytes32 orgA = keccak256("org-a");
        bytes32 orgB = keccak256("org-b");
        anchor.anchor(orgA, keccak256("hash-a"));
        anchor.anchor(orgB, keccak256("hash-b"));
        assertEq(anchor.latestAnchoredHash(orgA), keccak256("hash-a"));
        assertEq(anchor.latestAnchoredHash(orgB), keccak256("hash-b"));
    }

    function test_anchor_rejects_non_owner() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert("not owner");
        anchor.anchor(keccak256("org-1"), keccak256("hash"));
    }

    function test_setOwner_rotates_and_old_owner_loses_access() public {
        address newOwner = address(0xCAFE);
        anchor.setOwner(newOwner);

        vm.expectRevert("not owner");
        anchor.anchor(keccak256("org-1"), keccak256("hash"));

        vm.prank(newOwner);
        anchor.anchor(keccak256("org-1"), keccak256("hash"));
        assertEq(anchor.latestAnchoredHash(keccak256("org-1")), keccak256("hash"));
    }

    function test_anchor_emits_event() public {
        bytes32 orgIdHash = keccak256("org-1");
        bytes32 auditHash = keccak256("chain-head-1");
        vm.warp(2000);

        vm.expectEmit(true, false, false, true);
        emit AuditAnchor.Anchored(orgIdHash, auditHash, 2000);
        anchor.anchor(orgIdHash, auditHash);
    }
}
