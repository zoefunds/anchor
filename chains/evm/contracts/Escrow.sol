// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// The real ISettlementTarget implementation DecisionRelay.sol has
// called into (settlementTarget[domain].settle(...)) since it was
// written, but which never existed until now — see docs/hyperlane-
// integration.md's open question #4 and the audit findings this fixes
// (case creation used to hardcode escrowId to zero because there was
// nothing real to bind it to).
//
// Native-ETH only for this first version, matching this project's
// other MVP scope decisions (see DecisionRelay.sol/DeliveryProofReceiver.sol
// headers) — ERC20 support is a real, separate extension once this
// path is proven, not added speculatively here.
//
// Scope, stated explicitly:
//   1. A depositor (either party, or a neutral third party — this
//      contract doesn't care who funds it, only that the amount and
//      addresses match at settlement time) locks ETH against a specific
//      (caseId, escrowId) pair, naming the claimant/respondent
//      addresses up front.
//   2. Only the configured DecisionRelay address may call settle() —
//      the same real trust boundary DecisionRelay itself enforces
//      (M-of-N attestor signatures) is what authorizes a payout here;
//      this contract does not re-verify attestations itself, it trusts
//      the single caller identity, exactly as ISettlementTarget's own
//      design intends.
//   3. settle() pays out claimantAmount + respondentAmount, which MUST
//      exactly equal the amount actually deposited — this contract
//      will not pay out more than was really escrowed, and will not
//      silently accept a mismatched settlement instruction.
interface IEscrowSettlementTarget {
    function settle(bytes32 caseId, bytes32 escrowId, uint256 claimantAmount, uint256 respondentAmount, bytes32 proofHash) external;
}

// Item E — a governed, time-bounded escape hatch for a deposit that is
// genuinely stuck: adjudication never happens (an abandoned case), or
// it happens but delivery never completes (the exact class of failure
// this project's own settlement-availability incident was). Both
// settle() and emergencyRefund() are reached ONLY through DecisionRelay,
// so both share the exact same M-of-N attestor-threshold trust boundary
// — there is deliberately no separate, weaker "admin refund" path a
// single key (even the contract owner) could trigger unilaterally.
interface IEmergencyRefundTarget {
    function emergencyRefund(bytes32 caseId, bytes32 escrowId, bytes32 proofHash) external;
}

contract Escrow is IEscrowSettlementTarget, IEmergencyRefundTarget {
    enum Status {
        NONE,
        DEPOSITED,
        SETTLED
    }

    struct Deposit {
        Status status;
        address claimant;
        address respondent;
        uint256 amount;
        // Real fix (external audit finding): the first version of this
        // contract only emitted caseId in the Deposited event — it was
        // never stored, so settle() (keyed solely by escrowId) had no
        // on-chain way to prove a given settlement's caseId actually
        // matched the deposit's original caseId. Off-chain records
        // (CaseSettlement) enforced that binding, but the contract
        // itself couldn't. Now stored and checked in settle() below.
        bytes32 caseId;
        // Real on-chain timeout anchor for emergencyRefund() below — a
        // deliberately different source of truth from anything the app
        // layer tracks in Postgres, since the whole point of this
        // escape hatch is to still work if the app/relay/DB is the
        // thing that's actually stuck or wrong.
        uint256 depositedAt;
    }

    // The only address ever allowed to call settle() — set once at
    // deploy time, immutable so it can't be silently redirected later.
    // This is deliberately the DecisionRelay contract address, not an
    // EOA: DecisionRelay is itself what enforces the real M-of-N
    // attestor threshold before ever calling settle(), so trusting this
    // one address is trusting that entire verified chain, not a single
    // private key.
    address public immutable decisionRelay;
    // Minimum real elapsed time (from deposit, not from case creation
    // or any app-side event) before emergencyRefund() can pay out —
    // immutable, set once at deploy, not something even the
    // DecisionRelay owner can shorten later. Deliberately not close to
    // this system's normal adjudication+appeal timeline (which
    // completes in hours to a couple of days per docs/policy-v1.md) —
    // this exists for the genuinely-abandoned/stuck case, not as a
    // faster alternative path for an impatient party.
    uint256 public immutable emergencyRefundTimeoutSeconds;

    mapping(bytes32 => Deposit) public deposits;

    event Deposited(bytes32 indexed caseId, bytes32 indexed escrowId, address indexed depositor, address claimant, address respondent, uint256 amount);
    event Settled(bytes32 indexed caseId, bytes32 indexed escrowId, uint256 claimantAmount, uint256 respondentAmount, bytes32 proofHash);
    event EmergencyRefunded(bytes32 indexed caseId, bytes32 indexed escrowId, uint256 amount, bytes32 proofHash);

    error AlreadyDeposited(bytes32 escrowId);
    error UnknownEscrow(bytes32 escrowId);
    error AlreadySettled(bytes32 escrowId);
    error AmountMismatch(uint256 expected, uint256 supplied);
    error CaseIdMismatch(bytes32 expected, bytes32 supplied);
    error ZeroAddress();
    error ZeroAmount();
    error NotDecisionRelay();
    error TransferFailed(address to, uint256 amount);
    error TimeoutNotElapsed(uint256 readyAt, uint256 currentTime);

    constructor(address _decisionRelay, uint256 _emergencyRefundTimeoutSeconds) {
        if (_decisionRelay == address(0)) revert ZeroAddress();
        require(_emergencyRefundTimeoutSeconds > 0, "emergencyRefundTimeoutSeconds must be nonzero");
        decisionRelay = _decisionRelay;
        emergencyRefundTimeoutSeconds = _emergencyRefundTimeoutSeconds;
    }

    modifier onlyDecisionRelay() {
        if (msg.sender != decisionRelay) revert NotDecisionRelay();
        _;
    }

    /// Locks msg.value against (caseId, escrowId), naming the two
    /// parties this specific escrow can ever pay out to. escrowId is
    /// caller-chosen (expected to be a fresh id per case, generated by
    /// the depositor/backend) — this contract's own guard is simply
    /// "an escrowId can only ever be deposited into once," which is
    /// sufficient to prevent a deposit being silently overwritten or
    /// mixed with an unrelated case, regardless of how escrowId was
    /// chosen upstream.
    function deposit(bytes32 caseId, bytes32 escrowId, address claimant, address respondent) external payable {
        if (deposits[escrowId].status != Status.NONE) revert AlreadyDeposited(escrowId);
        if (claimant == address(0) || respondent == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();

        deposits[escrowId] = Deposit({ status: Status.DEPOSITED, claimant: claimant, respondent: respondent, amount: msg.value, caseId: caseId, depositedAt: block.timestamp });

        emit Deposited(caseId, escrowId, msg.sender, claimant, respondent, msg.value);
    }

    /// Called only by DecisionRelay after it has independently verified
    /// M-of-N attestor signatures over this exact settlement — see this
    /// contract's own header comment. Reverts (rather than silently
    /// no-op-ing) on any mismatch between what was actually deposited
    /// and what's being asked to pay out, so a bug or attempted forgery
    /// upstream surfaces immediately instead of moving the wrong amount.
    function settle(bytes32 caseId, bytes32 escrowId, uint256 claimantAmount, uint256 respondentAmount, bytes32 proofHash) external onlyDecisionRelay {
        Deposit storage d = deposits[escrowId];
        if (d.status == Status.NONE) revert UnknownEscrow(escrowId);
        if (d.status == Status.SETTLED) revert AlreadySettled(escrowId);
        if (caseId != d.caseId) revert CaseIdMismatch(d.caseId, caseId);
        uint256 total = claimantAmount + respondentAmount;
        if (total != d.amount) revert AmountMismatch(d.amount, total);

        // Effects before interactions: mark settled, and capture the
        // payout addresses/amounts into locals, BEFORE either external
        // transfer — a reentrant call back into settle() or deposit()
        // for this same escrowId sees Status.SETTLED and reverts
        // immediately, regardless of what either transfer below does.
        d.status = Status.SETTLED;
        address claimant = d.claimant;
        address respondent = d.respondent;

        emit Settled(caseId, escrowId, claimantAmount, respondentAmount, proofHash);

        if (claimantAmount > 0) {
            (bool ok, ) = claimant.call{ value: claimantAmount }("");
            if (!ok) revert TransferFailed(claimant, claimantAmount);
        }
        if (respondentAmount > 0) {
            (bool ok, ) = respondent.call{ value: respondentAmount }("");
            if (!ok) revert TransferFailed(respondent, respondentAmount);
        }
    }

    /// Item E: the governed escape hatch for a deposit that is stuck —
    /// no decision ever reached, or one was reached but its delivery
    /// never completed. Same onlyDecisionRelay boundary as settle():
    /// DecisionRelay.emergencyRefund() independently verifies the same
    /// M-of-N attestor threshold before ever reaching this function, so
    /// there is no unilateral-withdrawal path here distinct from the
    /// one settle() already has — this is not a second, weaker trust
    /// boundary, it is the identical one. What IS distinct is the real
    /// on-chain timeout: this can only pay out `emergencyRefundTimeoutSeconds`
    /// after the ORIGINAL deposit (never reset by anything), so it
    /// cannot be used as a faster alternative to normal adjudication —
    /// only as a last resort once normal settlement has had a real,
    /// long chance to happen and evidently hasn't.
    ///
    /// Always pays 100% back to the claimant (the party whose funds
    /// these are, in this domain's existing REFUND_FULL vocabulary —
    /// see settle()'s claimantAmount/respondentAmount split, of which
    /// this is the maximally claimant-favoring case) — this contract
    /// has no concept of "which amount each party originally
    /// contributed" to refund proportionally, and a stuck-case escape
    /// hatch returning funds to whichever party actually deposited them
    /// (in practice, almost always the claimant funding their own
    /// dispute) is the safe default absent an actual adjudicated
    /// outcome.
    function emergencyRefund(bytes32 caseId, bytes32 escrowId, bytes32 proofHash) external onlyDecisionRelay {
        Deposit storage d = deposits[escrowId];
        if (d.status == Status.NONE) revert UnknownEscrow(escrowId);
        if (d.status == Status.SETTLED) revert AlreadySettled(escrowId);
        if (caseId != d.caseId) revert CaseIdMismatch(d.caseId, caseId);

        uint256 readyAt = d.depositedAt + emergencyRefundTimeoutSeconds;
        if (block.timestamp < readyAt) revert TimeoutNotElapsed(readyAt, block.timestamp);

        // Effects before interactions — same reentrancy discipline as
        // settle() above.
        d.status = Status.SETTLED;
        address claimant = d.claimant;
        uint256 amount = d.amount;

        emit EmergencyRefunded(caseId, escrowId, amount, proofHash);

        (bool ok, ) = claimant.call{ value: amount }("");
        if (!ok) revert TransferFailed(claimant, amount);
    }
}
