// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// Track 2 — USDC-first settlement. A NEW, separate ISettlementTarget
// implementation, deliberately not a modification of Escrow.sol (the
// native-ETH path): DecisionRelay.setSettlementTarget/setSettlementMode
// already dispatch per-domain to whatever address is configured there,
// so a second contract implementing the same interfaces is the natural
// extension point, not a fork of the ETH contract's own logic.
//
// Every piece of access control, event naming, error naming, and the
// deposit-authorization/emergency-refund flow below is copied
// deliberately verbatim from Escrow.sol — this is NOT a parallel
// security model for USDC, it is the identical one, just with
// SafeERC20 transfers instead of a raw value-call. See Escrow.sol's own
// header for the audit findings (#2 escrowId pre-registration, #3
// claimant-only depositor) this design already incorporates from day
// one, rather than re-discovering them here.
//
// USDC-only, by construction, not by convention: the token address is
// immutable, set once at deploy time to Circle's official Sepolia
// testnet USDC deployment (see deploy/DeployEscrowUSDC.s.sol). This
// contract has no path to accept a different ERC-20 — deposit() always
// transfers from `usdcToken`, never a caller-supplied token address —
// so "arbitrary ERC-20 support" is not something an API caller could
// ever reach through this contract, only a genuinely new deployment +
// app-layer allowlist entry could.
//
// Fee-on-transfer / deflationary / rebasing token defense: deposit()
// measures this contract's OWN balanceOf(this) immediately before and
// after transferFrom, and requires the delta to equal exactly the
// requested amount before marking the deposit confirmed (see deposit()
// below). A real fee-on-transfer token would transfer less than
// requested — that's the exact failure this repo's Escrow.sol never
// had to handle for native ETH (a value-call either moves the full
// amount or reverts, there is no "moved a different amount"
// possibility), and it is why this defense could not simply be a
// checked ERC20 allowlist alone; even an allowlisted token's behavior
// must be re-verified as the trust boundary, on every single deposit.
contract EscrowUSDC {
    using SafeERC20 for IERC20;

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
        bytes32 caseId;
        uint256 depositedAt;
    }

    struct DepositAuthorization {
        bytes32 caseId;
        address claimant;
        address respondent;
        uint256 amount;
        bool exists;
    }

    // The single, immutable USDC token this contract will ever move.
    // See this contract's own header for why an arbitrary token address
    // can never reach deposit() — there is no setter for this.
    IERC20 public immutable usdcToken;
    address public immutable decisionRelay;
    address public immutable depositAuthorizer;
    uint256 public immutable emergencyRefundTimeoutSeconds;

    // Reconciliation ledger (item 2 — "reconcile liabilities against
    // actual escrow token balances"): the sum of every DEPOSITED
    // escrow's amount not yet settled/refunded. reconcile() below
    // compares this against usdcToken.balanceOf(this) directly — the
    // two must never diverge in the direction of the token balance
    // being SHORT of what's owed; a token balance strictly greater than
    // totalOutstanding is tolerated (e.g. a stray direct transfer to
    // this contract) but flagged, since it can never be legitimately
    // owed to any known deposit.
    uint256 public totalOutstanding;

    mapping(bytes32 => Deposit) public deposits;
    mapping(bytes32 => DepositAuthorization) public depositAuthorizations;

    event DepositAuthorized(bytes32 indexed caseId, bytes32 indexed escrowId, address claimant, address respondent, uint256 amount);
    event Deposited(bytes32 indexed caseId, bytes32 indexed escrowId, address indexed depositor, address claimant, address respondent, uint256 amount);
    event Settled(bytes32 indexed caseId, bytes32 indexed escrowId, uint256 claimantAmount, uint256 respondentAmount, bytes32 proofHash);
    event EmergencyRefunded(bytes32 indexed caseId, bytes32 indexed escrowId, uint256 amount, bytes32 proofHash);

    error AlreadyDeposited(bytes32 escrowId);
    error AlreadyAuthorized(bytes32 escrowId);
    error NotAuthorized(bytes32 escrowId);
    error AuthorizationMismatch();
    error OnlyClaimantMayDeposit(address sender, address claimant);
    error UnknownEscrow(bytes32 escrowId);
    error AlreadySettled(bytes32 escrowId);
    error AmountMismatch(uint256 expected, uint256 supplied);
    error CaseIdMismatch(bytes32 expected, bytes32 supplied);
    error ZeroAddress();
    error ZeroAmount();
    error NotDecisionRelay();
    error NotDepositAuthorizer();
    error TimeoutNotElapsed(uint256 readyAt, uint256 currentTime);
    // Fee-on-transfer / deflationary / rebasing token defense — see this
    // contract's own header. Distinct from AmountMismatch (which
    // compares an authorized amount against a caller-supplied one)
    // because this compares the REAL observed balance delta against
    // what transferFrom was asked to move, independent of anything the
    // caller claims.
    error ShortTransfer(uint256 expected, uint256 actualReceived);

    constructor(address _usdcToken, address _decisionRelay, address _depositAuthorizer, uint256 _emergencyRefundTimeoutSeconds) {
        if (_usdcToken == address(0) || _decisionRelay == address(0) || _depositAuthorizer == address(0)) revert ZeroAddress();
        require(_emergencyRefundTimeoutSeconds > 0, "emergencyRefundTimeoutSeconds must be nonzero");
        usdcToken = IERC20(_usdcToken);
        decisionRelay = _decisionRelay;
        depositAuthorizer = _depositAuthorizer;
        emergencyRefundTimeoutSeconds = _emergencyRefundTimeoutSeconds;
    }

    modifier onlyDecisionRelay() {
        if (msg.sender != decisionRelay) revert NotDecisionRelay();
        _;
    }

    modifier onlyDepositAuthorizer() {
        if (msg.sender != depositAuthorizer) revert NotDepositAuthorizer();
        _;
    }

    /// Identical discipline to Escrow.sol's authorizeDeposit — one-shot,
    /// never overwritable, must exist before deposit() accepts anything
    /// for this escrowId.
    function authorizeDeposit(bytes32 caseId, bytes32 escrowId, address claimant, address respondent, uint256 amount) external onlyDepositAuthorizer {
        if (depositAuthorizations[escrowId].exists) revert AlreadyAuthorized(escrowId);
        if (claimant == address(0) || respondent == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        depositAuthorizations[escrowId] = DepositAuthorization({ caseId: caseId, claimant: claimant, respondent: respondent, amount: amount, exists: true });

        emit DepositAuthorized(caseId, escrowId, claimant, respondent, amount);
    }

    /// Pulls `amount` atomic USDC units from the claimant via
    /// transferFrom — the claimant must have already called
    /// usdcToken.approve(address(this), amount) (the standard,
    /// well-understood ERC-20 flow this task's build guidance calls
    /// for; a permit-based flow is real follow-up work, not built here
    /// since transferFrom+approve is already the safe default and this
    /// core flow needs to be solid and tested first).
    ///
    /// Fee-on-transfer defense: balanceOf(this) is read before and
    /// after transferFrom, and the deposit is recorded using the
    /// ACTUAL observed delta, not the requested `amount` — but if that
    /// delta is short of `amount`, this reverts with ShortTransfer
    /// rather than silently recording a smaller deposit than what was
    /// authorized (a short deposit could never be released against the
    /// authorization's own amount without also under- or over-paying
    /// one of the two parties, so there is no safe partial-acceptance
    /// path here — reject outright and let the caller/off-chain flow
    /// react, exactly as Escrow.sol's AmountMismatch does for a wrong
    /// msg.value).
    function deposit(bytes32 caseId, bytes32 escrowId, address claimant, address respondent, uint256 amount) external {
        DepositAuthorization memory auth = depositAuthorizations[escrowId];
        if (!auth.exists) revert NotAuthorized(escrowId);
        if (deposits[escrowId].status != Status.NONE) revert AlreadyDeposited(escrowId);
        if (auth.caseId != caseId || auth.claimant != claimant || auth.respondent != respondent) revert AuthorizationMismatch();
        if (amount != auth.amount) revert AmountMismatch(auth.amount, amount);
        if (msg.sender != claimant) revert OnlyClaimantMayDeposit(msg.sender, claimant);

        uint256 balanceBefore = usdcToken.balanceOf(address(this));
        usdcToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 balanceAfter = usdcToken.balanceOf(address(this));
        uint256 actualReceived = balanceAfter - balanceBefore;
        if (actualReceived != amount) revert ShortTransfer(amount, actualReceived);

        deposits[escrowId] = Deposit({ status: Status.DEPOSITED, claimant: claimant, respondent: respondent, amount: amount, caseId: caseId, depositedAt: block.timestamp });
        totalOutstanding += amount;

        emit Deposited(caseId, escrowId, msg.sender, claimant, respondent, amount);
    }

    /// Same onlyDecisionRelay trust boundary, same exact-amount
    /// invariant, and same effects-before-interactions ordering as
    /// Escrow.sol's settle() — see that contract's header for why this
    /// is the identical trust boundary, not a weaker parallel one.
    /// Moves exact atomic units via SafeERC20.safeTransfer; supports a
    /// partial release/refund split whenever claimantAmount +
    /// respondentAmount == the full deposited amount (the same split
    /// semantics Escrow.sol already supports for native ETH).
    function settle(bytes32 caseId, bytes32 escrowId, uint256 claimantAmount, uint256 respondentAmount, bytes32 proofHash) external onlyDecisionRelay {
        Deposit storage d = deposits[escrowId];
        if (d.status == Status.NONE) revert UnknownEscrow(escrowId);
        if (d.status == Status.SETTLED) revert AlreadySettled(escrowId);
        if (caseId != d.caseId) revert CaseIdMismatch(d.caseId, caseId);
        uint256 total = claimantAmount + respondentAmount;
        if (total != d.amount) revert AmountMismatch(d.amount, total);

        d.status = Status.SETTLED;
        address claimant = d.claimant;
        address respondent = d.respondent;
        totalOutstanding -= d.amount;

        emit Settled(caseId, escrowId, claimantAmount, respondentAmount, proofHash);

        if (claimantAmount > 0) usdcToken.safeTransfer(claimant, claimantAmount);
        if (respondentAmount > 0) usdcToken.safeTransfer(respondent, respondentAmount);
    }

    /// Item E's escape hatch, identical trust boundary and timeout
    /// discipline to Escrow.sol's emergencyRefund() — see that
    /// contract's header. Always pays the full deposited amount back to
    /// the claimant, same reasoning (deposit() enforces msg.sender ==
    /// claimant, so there is no respondent-or-third-party-funded case
    /// this could misdirect).
    function emergencyRefund(bytes32 caseId, bytes32 escrowId, bytes32 proofHash) external onlyDecisionRelay {
        Deposit storage d = deposits[escrowId];
        if (d.status == Status.NONE) revert UnknownEscrow(escrowId);
        if (d.status == Status.SETTLED) revert AlreadySettled(escrowId);
        if (caseId != d.caseId) revert CaseIdMismatch(d.caseId, caseId);

        uint256 readyAt = d.depositedAt + emergencyRefundTimeoutSeconds;
        if (block.timestamp < readyAt) revert TimeoutNotElapsed(readyAt, block.timestamp);

        d.status = Status.SETTLED;
        address claimant = d.claimant;
        uint256 amount = d.amount;
        totalOutstanding -= amount;

        emit EmergencyRefunded(caseId, escrowId, amount, proofHash);

        usdcToken.safeTransfer(claimant, amount);
    }

    /// Item 2 — "reconcile liabilities against actual escrow token
    /// balances." Read-only; callable by anyone (a monitoring job, an
    /// ops console, or a test), same reasoning as Escrow.sol having no
    /// privileged read paths: reconciliation is a fact about public
    /// on-chain state, not a secret. `sufficient` is false only if the
    /// token balance is strictly LESS than what's owed to open
    /// deposits — the one direction that would mean a settle()/
    /// emergencyRefund() for some existing deposit could not actually
    /// be paid out in full, which should never happen through this
    /// contract's own deposit()/settle() paths alone (it would mean
    /// tokens left this contract some other way, e.g. a
    /// non-standard token with an admin-controlled balance override).
    function reconcile() external view returns (uint256 actualBalance, uint256 liabilities, bool sufficient) {
        actualBalance = usdcToken.balanceOf(address(this));
        liabilities = totalOutstanding;
        sufficient = actualBalance >= liabilities;
    }
}
