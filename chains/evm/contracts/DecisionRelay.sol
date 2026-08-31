// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Receives finalized Anchor adjudication decisions relayed via Hyperlane and
// dispatches settlement on this chain; can also originate CaseOriginator
// messages back toward GenLayer. See ../../docs/hyperlane-integration.md
// for the message schemas and open questions this skeleton depends on.
//
// Interface verified against Hyperlane docs (docs.hyperlane.xyz) at time of
// writing:
//   - IMessageRecipient.handle(uint32 origin, bytes32 sender, bytes calldata body)
//   - IMailbox.dispatch(uint32 destinationDomain, bytes32 recipient, bytes calldata body)
//     payable, requires msg.value >= quoteDispatch(...) for the same params.
// Re-verify against current Hyperlane release before deploying — this has
// not been compiled or tested against a live Mailbox yet.

interface IMailbox {
    function dispatch(
        uint32 destinationDomain,
        bytes32 recipientAddress,
        bytes calldata messageBody
    ) external payable returns (bytes32 messageId);

    function quoteDispatch(
        uint32 destinationDomain,
        bytes32 recipientAddress,
        bytes calldata messageBody
    ) external view returns (uint256 fee);
}

interface IMessageRecipient {
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _messageBody
    ) external;
}

interface ISettlementTarget {
    // Whatever escrow/settlement contract this relay points at on this
    // chain must implement this — left generic until a real escrow contract
    // is specified (see open question #4 in hyperlane-integration.md).
    function settle(
        bytes32 caseId,
        bytes32 escrowId,
        uint256 claimantAmount,
        uint256 respondentAmount,
        bytes32 proofHash
    ) external;
}

contract DecisionRelay is IMessageRecipient {
    IMailbox public immutable mailbox;
    address public immutable owner;
    // Overrides the origin chain's default recipient ISM — see
    // TrustedRelayerIsm.sol for why (Sepolia's default is an unreachable
    // 2-of-2 aggregation ISM for this MVP's self-hosted relayer setup)
    // and the security tradeoff that comes with it.
    address public immutable customIsm;

    // The real trust boundary, distinct from customIsm/trustedSender.
    // trustedSender only says "this address is allowed to call handle()
    // via the Mailbox" — it says nothing about whether the DECISION
    // CONTENT being delivered is genuine, since a compromised relay
    // pipeline (the dispatch wallet, the self-hosted relayer, or the
    // backend that computed proofHash) could otherwise dispatch any
    // settlement it wants and this contract would settle it. `attestor`
    // is a separate, ideally more isolated/offline key whose only job is
    // signing real decisions; handle() below requires a valid ECDSA
    // signature from this address over the exact decision content
    // (recovered via ecrecover), independent of who actually submitted
    // the Hyperlane message. Forging a settlement now requires this
    // specific private key, not just control of the relay/dispatch path.
    address public attestor;

    // Trusted sender per origin domain — only Anchor's known GenLayer-side
    // relay/originator contract's address (as bytes32) should be accepted.
    mapping(uint32 => bytes32) public trustedSender;
    mapping(uint32 => address) public settlementTarget;

    // Destination-side idempotency: proofHash now carries the decision's
    // own content hash (case/policy/outcome/shares/reasonCodes — see
    // adjudication-service.ts's computeDecisionHash), not just an
    // evidence-binding hash, so it uniquely identifies "this exact
    // decision, settled." Anchor's backend can retry a dispatch after a
    // process/DB failure without knowing whether the prior attempt's
    // transaction actually landed; this guard makes that safe — a second
    // Hyperlane message carrying the same proofHash reverts here instead
    // of calling settle() twice, regardless of how many times Anchor
    // (mistakenly or not) sends it.
    mapping(bytes32 => bool) public processedDecisions;

    event DecisionReceived(bytes32 indexed caseId, string outcome, bytes32 proofHash);
    event CaseOriginated(bytes32 indexed caseId, uint32 destinationDomain, bytes32 messageId);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyMailbox() {
        require(msg.sender == address(mailbox), "not mailbox");
        _;
    }

    constructor(address _mailbox, address _customIsm, address _attestor) {
        mailbox = IMailbox(_mailbox);
        owner = msg.sender;
        customIsm = _customIsm;
        attestor = _attestor;
    }

    /// Rotating the attestor key doesn't affect any already-processed
    /// decision (proofHash-keyed idempotency is untouched), only future
    /// ones — lets Anchor move to a new/offline-generated key without
    /// redeploying.
    function setAttestor(address _attestor) external onlyOwner {
        attestor = _attestor;
    }

    /// Hyperlane's Mailbox calls this on the recipient (if implemented)
    /// instead of falling back to its own default ISM.
    function interchainSecurityModule() external view returns (address) {
        return customIsm;
    }

    function setTrustedSender(uint32 domain, bytes32 sender) external onlyOwner {
        trustedSender[domain] = sender;
    }

    function setSettlementTarget(uint32 domain, address target) external onlyOwner {
        settlementTarget[domain] = target;
    }

    /// Called by the local Mailbox when a DecisionRelay message arrives from
    /// GenLayer's side. Body encoding TBD — placeholder uses abi.encode of
    /// the fields in the DECISION_RELAY schema; swap for the agreed wire
    /// format once question #1 in the doc (dispatch origin) is resolved.
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _messageBody
    ) external override onlyMailbox {
        require(trustedSender[_origin] == _sender, "untrusted sender");

        (
            bytes32 caseId,
            string memory outcome,
            uint256 claimantAmount,
            uint256 respondentAmount,
            bytes32 escrowId,
            bytes32 proofHash,
            bytes memory attestationSignature
        ) = abi.decode(_messageBody, (bytes32, string, uint256, uint256, bytes32, bytes32, bytes));

        // Binds the signature to exactly this decision's content, this
        // origin domain, and this specific deployed contract (address(this)
        // stands in for "destination domain + recipient" — a signature
        // valid here can't be replayed against a different DecisionRelay
        // deployment or a different origin domain's decision, since both
        // are part of what's actually signed). Uses the raw hash directly
        // (no EIP-191 prefix) — this signature is never meant to be shown
        // in a wallet's "sign this message" UI, it's machine-generated by
        // Anchor's own attestor key, so there's no phishing-signature
        // surface EIP-191 prefixing would otherwise be defending against.
        bytes32 attestationHash = keccak256(
            abi.encode("ANCHOR_DECISION_ATTESTATION_V1", _origin, address(this), caseId, outcome, claimantAmount, respondentAmount, escrowId, proofHash)
        );
        require(_recoverSigner(attestationHash, attestationSignature) == attestor, "invalid attestation");

        require(!processedDecisions[proofHash], "decision already settled");
        processedDecisions[proofHash] = true;

        emit DecisionReceived(caseId, outcome, proofHash);

        address target = settlementTarget[_origin];
        if (target != address(0)) {
            ISettlementTarget(target).settle(caseId, escrowId, claimantAmount, respondentAmount, proofHash);
        }
    }

    /// Standard 65-byte (r, s, v) ECDSA signature recovery — no external
    /// library dependency (OpenZeppelin's ECDSA.recover does the same
    /// thing with more input-shape validation; kept minimal and
    /// dependency-free here since this repo has no existing OZ import).
    function _recoverSigner(bytes32 hash, bytes memory signature) private pure returns (address) {
        require(signature.length == 65, "invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "invalid signature v");
        return ecrecover(hash, v, r, s);
    }

    /// Originates a CASE_ORIGINATE message toward GenLayer's side (or
    /// whichever domain hosts the case-intake relay) — the reverse
    /// direction requested for bidirectional flow.
    function originateCase(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes calldata caseMessageBody
    ) external payable returns (bytes32 messageId) {
        uint256 fee = mailbox.quoteDispatch(destinationDomain, recipient, caseMessageBody);
        require(msg.value >= fee, "insufficient fee");

        messageId = mailbox.dispatch{value: msg.value}(destinationDomain, recipient, caseMessageBody);
        emit CaseOriginated(bytes32(caseMessageBody[0:32]), destinationDomain, messageId);
    }
}
