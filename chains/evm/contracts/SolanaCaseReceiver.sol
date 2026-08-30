// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Receives a CASE_ORIGINATE message dispatched from Solana's
// decision-relay program (chains/solana/programs/decision-relay). That
// program borsh-encodes its CaseOriginateBody — NOT Solidity ABI encoding
// — so this contract hand-parses the fixed borsh layout directly rather
// than using abi.decode, which would silently produce garbage against
// bytes that were never ABI-encoded in the first place. This mismatch
// (Solana Borsh vs. EVM ABI encoding) is exactly the kind of cross-VM gap
// that's easy to miss when each side is built and tested in isolation —
// caught here before attempting a live delivery, not after a failed one.
//
// CaseOriginateBody borsh layout (see decision-relay/src/lib.rs):
//   [4 bytes case_id_len, little-endian u32]
//   [case_id_len bytes, utf8]
//   [32 bytes claimant pubkey]
//   [32 bytes respondent pubkey]
//   [8 bytes amount_lamports, little-endian u64]

interface IMessageRecipient {
    function handle(uint32 _origin, bytes32 _sender, bytes calldata _messageBody) external;
}

contract SolanaCaseReceiver is IMessageRecipient {
    address public immutable mailbox;

    event CaseReceived(
        uint32 origin,
        bytes32 sender,
        string caseId,
        bytes32 claimant,
        bytes32 respondent,
        uint64 amountLamports
    );

    modifier onlyMailbox() {
        require(msg.sender == mailbox, "not mailbox");
        _;
    }

    constructor(address _mailbox) {
        mailbox = _mailbox;
    }

    function handle(uint32 _origin, bytes32 _sender, bytes calldata _messageBody) external override onlyMailbox {
        (string memory caseId, bytes32 claimant, bytes32 respondent, uint64 amountLamports) =
            _decodeCaseOriginateBody(_messageBody);

        emit CaseReceived(_origin, _sender, caseId, claimant, respondent, amountLamports);
    }

    function _decodeCaseOriginateBody(bytes calldata body)
        internal
        pure
        returns (string memory caseId, bytes32 claimant, bytes32 respondent, uint64 amountLamports)
    {
        uint32 caseIdLen = _readU32LE(body, 0);
        uint256 offset = 4;

        caseId = string(body[offset:offset + caseIdLen]);
        offset += caseIdLen;

        claimant = bytes32(body[offset:offset + 32]);
        offset += 32;

        respondent = bytes32(body[offset:offset + 32]);
        offset += 32;

        amountLamports = _readU64LE(body, offset);
    }

    function _readU32LE(bytes calldata data, uint256 offset) internal pure returns (uint32 value) {
        value = uint32(uint8(data[offset]))
            | (uint32(uint8(data[offset + 1])) << 8)
            | (uint32(uint8(data[offset + 2])) << 16)
            | (uint32(uint8(data[offset + 3])) << 24);
    }

    function _readU64LE(bytes calldata data, uint256 offset) internal pure returns (uint64 value) {
        for (uint256 i = 0; i < 8; i++) {
            value |= uint64(uint8(data[offset + i])) << uint64(8 * i);
        }
    }
}
