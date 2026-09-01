// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Externally anchors the latest hash of each organization's audit-log
// hash chain (see apps/web/src/lib/audit.ts) — the compensating control
// a re-audit asked for: the in-database chain (prevHash/hash) detects an
// in-place edit of a historical row, but someone with direct write
// access to the database can rewrite the WHOLE chain (recompute every
// hash consistently after tampering with an old row) and the database
// alone would show nothing wrong. A periodically-posted external record
// of "this was the latest hash at this time" closes that: rewriting
// history undetectably now also requires rewriting this contract's own
// history, which requires either compromising `owner`'s key or the fact
// that a public chain doesn't let you edit the past at all.
//
// SCOPE NOTE (read before treating this as a stronger guarantee than it
// is): this only helps if the anchoring key is NOT controlled by whoever
// might tamper with the database — under Anchor's current single-
// operator MVP trust model, the SAME operator holds both, so this
// doesn't defend against a fully malicious operator. What it DOES add:
// detection of accidental/bug-caused database corruption, detection of a
// compromised database that doesn't also compromise this contract's
// signing key, and a genuinely independent, publicly-checkable
// timestamped record any external auditor can verify without trusting
// Anchor's own database at all.
contract AuditAnchor {
    address public owner;

    // Keyed by keccak256(organizationId) since organization ids are
    // opaque cuid strings, not addresses — this contract never needs to
    // know what an org actually is, only that the same key always maps
    // to the same organization.
    mapping(bytes32 => bytes32) public latestAnchoredHash;
    mapping(bytes32 => uint256) public latestAnchoredAt;

    event Anchored(bytes32 indexed orgIdHash, bytes32 auditHash, uint256 timestamp);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setOwner(address _owner) external onlyOwner {
        owner = _owner;
    }

    /// Records the given organization's audit chain's current latest
    /// hash. Anyone can independently recompute keccak256(organizationId)
    /// and read this mapping to verify a claimed audit-chain head against
    /// what Anchor's backend actually posted at the time — no need to
    /// trust Anchor's own database for that comparison.
    function anchor(bytes32 orgIdHash, bytes32 auditHash) external onlyOwner {
        latestAnchoredHash[orgIdHash] = auditHash;
        latestAnchoredAt[orgIdHash] = block.timestamp;
        emit Anchored(orgIdHash, auditHash, block.timestamp);
    }
}
