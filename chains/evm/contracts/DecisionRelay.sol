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

    constructor(address _mailbox, address _customIsm) {
        mailbox = IMailbox(_mailbox);
        owner = msg.sender;
        customIsm = _customIsm;
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
            bytes32 proofHash
        ) = abi.decode(_messageBody, (bytes32, string, uint256, uint256, bytes32, bytes32));

        require(!processedDecisions[proofHash], "decision already settled");
        processedDecisions[proofHash] = true;

        emit DecisionReceived(caseId, outcome, proofHash);

        address target = settlementTarget[_origin];
        if (target != address(0)) {
            ISettlementTarget(target).settle(caseId, escrowId, claimantAmount, respondentAmount, proofHash);
        }
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
