// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// A deliberately minimal Hyperlane recipient used ONLY to prove real
// end-to-end message delivery through the real validator multisig ISM
// this project already deploys — no settlement logic, no escrow, no
// funds movement, no attestation requirement, no connection to any real
// case/decision. Its interchainSecurityModule() is fixed at construction
// to the same StaticMerkleRootMultisigIsm DecisionRelay uses, so a
// message delivered here has gone through the identical validator
// checkpoint/ISM verification path as a real decision would, without any
// of the risk a real DecisionRelay message carries (settlement, replay
// concerns, attestor signature requirements). See
// docs/production-readiness-hardening-pass.md for why this exists: a
// delivery-only proof that the S3 bucket policy fix actually restored
// end-to-end delivery, without needing real attestor keys or touching
// any customer case.
interface IMessageRecipient {
    function handle(uint32 _origin, bytes32 _sender, bytes calldata _messageBody) external;
}

contract DeliveryProofReceiver is IMessageRecipient {
    address public immutable ism;
    address public immutable mailbox;

    event ProofReceived(uint32 indexed origin, bytes32 indexed sender, bytes32 messageHash, uint256 timestamp);

    constructor(address _ism, address _mailbox) {
        ism = _ism;
        mailbox = _mailbox;
    }

    modifier onlyMailbox() {
        require(msg.sender == mailbox, "only mailbox");
        _;
    }

    function interchainSecurityModule() external view returns (address) {
        return ism;
    }

    // Unconditionally accepts any correctly-ISM-verified message and
    // emits proof of delivery. Nothing else happens — no state beyond the
    // event, no external calls, no funds.
    function handle(uint32 _origin, bytes32 _sender, bytes calldata _messageBody) external override onlyMailbox {
        emit ProofReceived(_origin, _sender, keccak256(_messageBody), block.timestamp);
    }
}
