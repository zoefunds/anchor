// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/DeliveryProofReceiver.sol";

contract DeliveryProofReceiverTest is Test {
    DeliveryProofReceiver receiver;
    address ism = address(0xABCD);
    address mailbox = address(0x1234);

    function setUp() public {
        receiver = new DeliveryProofReceiver(ism, mailbox);
    }

    function test_reportsConfiguredIsm() public view {
        assertEq(receiver.interchainSecurityModule(), ism);
    }

    function test_handleRejectsNonMailboxCaller() public {
        vm.expectRevert("only mailbox");
        receiver.handle(11155111, bytes32(uint256(uint160(address(this)))), hex"deadbeef");
    }

    function test_handleAcceptsMailboxAndEmitsProof() public {
        bytes memory body = hex"cafebabe";
        vm.prank(mailbox);
        vm.expectEmit(true, true, false, true);
        emit DeliveryProofReceiver.ProofReceived(11155111, bytes32(uint256(1)), keccak256(body), block.timestamp);
        receiver.handle(11155111, bytes32(uint256(1)), body);
    }
}
