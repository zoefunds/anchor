// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TrustedRelayerIsm} from "../contracts/TrustedRelayerIsm.sol";

/// Regression test for a real production incident: moduleType() returned 0
/// (UNUSED, "INVALID ISM" per hyperlane-core), which has no metadata-builder
/// mapping in the relayer at all. Every relay attempt for a message routed
/// through this ISM failed deterministically during metadata building
/// ("Unknown or invalid module type (Unused)") and never even reached the
/// point of submitting a process() transaction — confirmed live against a
/// real deployed message on Sepolia. The correct value for an always-valid,
/// no-metadata ISM like this one is 6 (Hyperlane's ModuleType::Null).
contract TrustedRelayerIsmTest is Test {
    TrustedRelayerIsm ism;

    function setUp() public {
        ism = new TrustedRelayerIsm();
    }

    function test_moduleType_is_null_not_unused() public view {
        assertEq(ism.moduleType(), 6, "moduleType must be Null (6), not Unused (0) - see incident note above");
    }

    function test_verify_always_returns_true() public view {
        assertTrue(ism.verify("", ""));
    }
}
