// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Frozen copy of the REAL, currently-live V1 Escrow source (see git
// history: commit 0eb5a39, before commit 17442c6 added the `caseId`
// field to the Deposit struct). This exists so the Anvil-based
// integration suite can deploy and test against the actual deployed
// V1 shape — including its real 4-field deposits() ABI, the exact
// class of mismatch that silently broke every real deposit
// confirmation once the app started assuming a 5-field V2 shape (see
// apps/web/src/lib/case-settlement.ts and reconciliation.ts's fix
// history). Never edit this file to "improve" it — it must stay an
// exact match of the real deployed bytecode's source, or the tests
// relying on it as "V1" stop proving anything real. All new
// development happens in contracts/Escrow.sol (V2).
interface IEscrowSettlementTargetV1 {
    function settle(bytes32 caseId, bytes32 escrowId, uint256 claimantAmount, uint256 respondentAmount, bytes32 proofHash) external;
}

contract EscrowV1 is IEscrowSettlementTargetV1 {
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
    }

    address public immutable decisionRelay;

    mapping(bytes32 => Deposit) public deposits;

    event Deposited(bytes32 indexed caseId, bytes32 indexed escrowId, address indexed depositor, address claimant, address respondent, uint256 amount);
    event Settled(bytes32 indexed caseId, bytes32 indexed escrowId, uint256 claimantAmount, uint256 respondentAmount, bytes32 proofHash);

    error AlreadyDeposited(bytes32 escrowId);
    error UnknownEscrow(bytes32 escrowId);
    error AlreadySettled(bytes32 escrowId);
    error AmountMismatch(uint256 expected, uint256 supplied);
    error ZeroAddress();
    error ZeroAmount();
    error NotDecisionRelay();
    error TransferFailed(address to, uint256 amount);

    constructor(address _decisionRelay) {
        if (_decisionRelay == address(0)) revert ZeroAddress();
        decisionRelay = _decisionRelay;
    }

    modifier onlyDecisionRelay() {
        if (msg.sender != decisionRelay) revert NotDecisionRelay();
        _;
    }

    function deposit(bytes32 caseId, bytes32 escrowId, address claimant, address respondent) external payable {
        if (deposits[escrowId].status != Status.NONE) revert AlreadyDeposited(escrowId);
        if (claimant == address(0) || respondent == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();

        deposits[escrowId] = Deposit({ status: Status.DEPOSITED, claimant: claimant, respondent: respondent, amount: msg.value });

        emit Deposited(caseId, escrowId, msg.sender, claimant, respondent, msg.value);
    }

    function settle(bytes32 caseId, bytes32 escrowId, uint256 claimantAmount, uint256 respondentAmount, bytes32 proofHash) external onlyDecisionRelay {
        Deposit storage d = deposits[escrowId];
        if (d.status == Status.NONE) revert UnknownEscrow(escrowId);
        if (d.status == Status.SETTLED) revert AlreadySettled(escrowId);
        uint256 total = claimantAmount + respondentAmount;
        if (total != d.amount) revert AmountMismatch(d.amount, total);

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
}
