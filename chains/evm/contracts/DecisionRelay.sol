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
    // Deliberately NOT hardcoded to msg.sender anymore — an owner that
    // can add/remove attestors and lower attestorThreshold is an
    // equivalent funds authority to the attestor set itself (it can
    // rewrite the policy the attestors are supposed to enforce), so for
    // anything holding real value this must be a separate governance
    // multisig/timelock (e.g. a Safe with its own independent owners —
    // see docs/multisig-attestor-setup.md), never the same wallet as the
    // backend's own dispatch/attestor keys. Passed explicitly at deploy
    // time instead of defaulting to msg.sender so that governance
    // authority is a conscious deploy-time decision, not an accident of
    // "whichever wallet happened to run the deploy script."
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
    // settlement it wants and this contract would settle it. handle()
    // below requires `attestorThreshold` DISTINCT valid ECDSA signatures
    // (recovered via ecrecover) from this set, over the exact decision
    // content, independent of who actually submitted the Hyperlane
    // message. M-of-N rather than a single key so no one holder of an
    // attestor key can unilaterally forge a settlement, and losing one
    // key doesn't halt settlement (as long as threshold-many of the
    // remaining keys are still available) — real operational separation
    // instead of one key that's merely stored in a "different" secret.
    mapping(address => bool) public isAttestor;
    uint256 public attestorCount;
    uint256 public attestorThreshold;

    // Trusted sender per origin domain — only Anchor's known GenLayer-side
    // relay/originator contract's address (as bytes32) should be accepted.
    mapping(uint32 => bytes32) public trustedSender;
    mapping(uint32 => address) public settlementTarget;

    // Real fix (external audit finding, the incident's own root cause):
    // handle() used to treat an unset settlementTarget as silent
    // notification-only, unconditionally, for every origin — including
    // one an operator genuinely intended to move funds on. That's how a
    // real decision got permanently marked processedDecisions=true with
    // no settlement ever having been attempted, and no way to retry.
    // Every origin domain now has an EXPLICIT mode, defaulting to
    // UNCONFIGURED (the zero value) — handle() reverts outright for an
    // UNCONFIGURED origin, before writing processedDecisions, so a
    // misconfigured/not-yet-wired origin fails loudly and stays
    // retryable rather than silently succeeding as a no-op. An operator
    // must explicitly choose SETTLEMENT (requires a real, nonzero
    // settlementTarget) or NOTIFICATION_ONLY (deliberately never calls
    // settle(), even if a target happens to be set) — there is no more
    // "whatever settlementTarget happens to be" implicit behavior.
    enum SettlementMode {
        UNCONFIGURED,
        SETTLEMENT,
        NOTIFICATION_ONLY
    }
    mapping(uint32 => SettlementMode) public settlementMode;
    event SettlementModeChanged(uint32 indexed domain, SettlementMode oldMode, SettlementMode newMode);

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

    // Governance-change events — every one of these narrows or widens who
    // can authorize a settlement, so each is its own event rather than a
    // generic "config changed" log, specifically so an off-chain monitor
    // (see docs/multisig-attestor-setup.md's alerting note) can alert on
    // exactly "threshold lowered" or "attestor added" without having to
    // decode a payload to know which kind of change happened.
    event AttestorAdded(address indexed attestor);
    event AttestorRemoved(address indexed attestor);
    event AttestorThresholdChanged(uint256 oldThreshold, uint256 newThreshold);
    event TrustedSenderChanged(uint32 indexed domain, bytes32 oldSender, bytes32 newSender);
    event SettlementTargetChanged(uint32 indexed domain, address oldTarget, address newTarget);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyMailbox() {
        require(msg.sender == address(mailbox), "not mailbox");
        _;
    }

    constructor(address _mailbox, address _owner, address _customIsm, address[] memory _attestors, uint256 _attestorThreshold) {
        require(_owner != address(0), "zero address owner");
        mailbox = IMailbox(_mailbox);
        owner = _owner;
        customIsm = _customIsm;
        require(_attestorThreshold > 0 && _attestorThreshold <= _attestors.length, "invalid threshold");
        for (uint256 i = 0; i < _attestors.length; i++) {
            require(_attestors[i] != address(0), "zero address attestor");
            require(!isAttestor[_attestors[i]], "duplicate attestor");
            isAttestor[_attestors[i]] = true;
        }
        attestorCount = _attestors.length;
        attestorThreshold = _attestorThreshold;
    }

    /// Adding/removing a single attestor, or changing the threshold,
    /// doesn't affect any already-processed decision (proofHash-keyed
    /// idempotency is untouched), only future ones — lets Anchor rotate
    /// one compromised/lost key without a full redeploy or without ever
    /// dropping below a safe threshold, since removeAttestor refuses to
    /// go below it.
    function addAttestor(address _attestor) external onlyOwner {
        require(_attestor != address(0), "zero address attestor");
        require(!isAttestor[_attestor], "already an attestor");
        isAttestor[_attestor] = true;
        attestorCount += 1;
        emit AttestorAdded(_attestor);
    }

    function removeAttestor(address _attestor) external onlyOwner {
        require(isAttestor[_attestor], "not an attestor");
        require(attestorCount - 1 >= attestorThreshold, "would drop below threshold");
        isAttestor[_attestor] = false;
        attestorCount -= 1;
        emit AttestorRemoved(_attestor);
    }

    function setAttestorThreshold(uint256 _threshold) external onlyOwner {
        require(_threshold > 0 && _threshold <= attestorCount, "invalid threshold");
        emit AttestorThresholdChanged(attestorThreshold, _threshold);
        attestorThreshold = _threshold;
    }

    /// Hyperlane's Mailbox calls this on the recipient (if implemented)
    /// instead of falling back to its own default ISM.
    function interchainSecurityModule() external view returns (address) {
        return customIsm;
    }

    function setTrustedSender(uint32 domain, bytes32 sender) external onlyOwner {
        emit TrustedSenderChanged(domain, trustedSender[domain], sender);
        trustedSender[domain] = sender;
    }

    function setSettlementTarget(uint32 domain, address target) external onlyOwner {
        emit SettlementTargetChanged(domain, settlementTarget[domain], target);
        settlementTarget[domain] = target;
    }

    /// Explicit, separate from setSettlementTarget on purpose: an
    /// operator can stage a settlementTarget address ahead of time
    /// without it taking effect, then flip mode to SETTLEMENT only once
    /// ready — and setting SETTLEMENT mode with no target configured
    /// reverts here, at configuration time, rather than surfacing later
    /// as a per-decision handle() revert.
    function setSettlementMode(uint32 domain, SettlementMode mode) external onlyOwner {
        if (mode == SettlementMode.SETTLEMENT) {
            require(settlementTarget[domain] != address(0), "settlementTarget not set for SETTLEMENT mode");
        }
        emit SettlementModeChanged(domain, settlementMode[domain], mode);
        settlementMode[domain] = mode;
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

        // Real fix here (the incident's own root cause): checked before
        // any attestation-signature verification, both because it's the
        // cheaper, more fundamental precondition (no point recovering
        // and validating signatures for an origin nobody has decided
        // the mode of yet) and because settlementMode is already a
        // public mapping — checking it first leaks no information an
        // attacker couldn't already read directly. An UNCONFIGURED
        // origin reverts here, before processedDecisions is ever
        // written, so this exact message stays retryable once the
        // origin is properly configured.
        require(settlementMode[_origin] != SettlementMode.UNCONFIGURED, "settlement mode not configured for this origin");

        (
            bytes32 caseId,
            string memory outcome,
            uint256 claimantAmount,
            uint256 respondentAmount,
            bytes32 escrowId,
            bytes32 proofHash,
            bytes[] memory attestationSignatures
        ) = abi.decode(_messageBody, (bytes32, string, uint256, uint256, bytes32, bytes32, bytes[]));

        // Binds the signatures to exactly this decision's content, this
        // origin domain, and this specific deployed contract (address(this)
        // stands in for "destination domain + recipient" — a signature
        // valid here can't be replayed against a different DecisionRelay
        // deployment or a different origin domain's decision, since both
        // are part of what's actually signed). Uses the raw hash directly
        // (no EIP-191 prefix) — these signatures are never meant to be
        // shown in a wallet's "sign this message" UI, they're machine-
        // generated by Anchor's own attestor keys, so there's no
        // phishing-signature surface EIP-191 prefixing would otherwise be
        // defending against.
        // The dedup check below is O(n^2) in the number of supplied
        // signatures — fine for the small, registered-attestor-sized
        // arrays this is meant for, but an unbounded array from a
        // malicious/buggy dispatcher could otherwise burn arbitrary gas
        // (an availability concern, not a settlement-forgery one, since
        // extra/garbage entries are simply ignored by the counting logic
        // itself). Capping at attestorCount means "at most one signature
        // per currently-registered attestor" is the largest input that
        // could ever legitimately matter.
        require(attestationSignatures.length <= attestorCount, "too many signatures supplied");

        require(
            _countValidDistinctAttestations(
                keccak256(
                    abi.encode("ANCHOR_DECISION_ATTESTATION_V2", _origin, address(this), caseId, outcome, claimantAmount, respondentAmount, escrowId, proofHash)
                ),
                attestationSignatures
            ) >= attestorThreshold,
            "insufficient valid attestations"
        );

        SettlementMode mode = settlementMode[_origin];

        require(!processedDecisions[proofHash], "decision already settled");
        processedDecisions[proofHash] = true;

        emit DecisionReceived(caseId, outcome, proofHash);

        if (mode == SettlementMode.SETTLEMENT) {
            address target = settlementTarget[_origin];
            // Belt-and-suspenders: setSettlementMode already requires a
            // nonzero target to enter SETTLEMENT mode, but re-checking
            // here means even a future code path that could otherwise
            // clear settlementTarget without also resetting mode still
            // fails loudly instead of silently no-op-ing like the
            // original bug.
            require(target != address(0), "SETTLEMENT mode with no settlementTarget configured");
            ISettlementTarget(target).settle(caseId, escrowId, claimantAmount, respondentAmount, proofHash);
        }
        // NOTIFICATION_ONLY: deliberately does nothing further —
        // decision recorded and processedDecisions set above, no
        // settle() call, even if settlementTarget happens to be set for
        // this origin (mode is the explicit, authoritative signal now,
        // not target-address presence).
    }

    /// M-of-N: counts DISTINCT valid attestor signatures over the same
    /// hash — not just "at least N signatures" (which a single attestor
    /// could satisfy by signing the same hash into the array multiple
    /// times). Tracking seen signers in-loop (rather than a mapping,
    /// which would need clearing between calls) keeps this a pure,
    /// stateless check per call — cheap for the small N this is
    /// realistically sized for. Split out of handle() itself purely to
    /// keep that function's local-variable count under the EVM's
    /// stack-depth limit (a real "stack too deep" compiler error hit
    /// while building this, not a style preference).
    function _countValidDistinctAttestations(bytes32 hash, bytes[] memory signatures) private view returns (uint256) {
        address[] memory seenSigners = new address[](signatures.length);
        uint256 validCount = 0;
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = _recoverSigner(hash, signatures[i]);
            if (!isAttestor[signer]) continue;
            bool alreadySeen = false;
            for (uint256 j = 0; j < validCount; j++) {
                if (seenSigners[j] == signer) {
                    alreadySeen = true;
                    break;
                }
            }
            if (alreadySeen) continue;
            seenSigners[validCount] = signer;
            validCount++;
        }
        return validCount;
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
