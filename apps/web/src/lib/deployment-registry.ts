import type { Address } from "viem";

// Single source of truth for the ACTIVE Sepolia settlement topology —
// per the 2026-09-12 incident recovery brief's Phase B: every file that
// previously hardcoded its own copy of these addresses (reliability-
// monitor.ts, canary scripts, deploy/verification scripts, the
// dispatch package) must import from here instead, so a contract
// migration can never again leave one consumer silently pointed at a
// retired deployment while the dashboard reports it healthy.
//
// Real incident, 2026-09-12: the previous DecisionRelay
// (0x1fc130416Dc09dff60e0Ea3C8dE8474e8428b3E2) was immutably bound to
// Hyperlane's canonical shared Sepolia mailbox, whose default hook
// never routes through any real Merkle tree — a permanent, unfixable
// delivery dead end. Replaced with a new DecisionRelay deployed against
// Anchor's own working mailbox, reusing the same ISM (the ISM factory
// is deterministic on (validators, threshold) alone, so it's the exact
// same contract, not a new deployment) and the same validator set.
//
// UPDATE THIS FILE, not a copy of it, whenever any of these addresses
// change. Every value here should be independently verifiable via a
// live `cast call` — see docs/incidents/ for the recovery record this
// topology was captured against.
//
// Incident recovery, Phase 2 (2026-09-13): decisionRelay/escrow updated
// again — DecisionRelay.sol gained attestedSettle(), a same-chain
// settlement path authorized purely by M-of-N attestor signatures, no
// Mailbox/relayer/validator/checkpoint dependency at all (see that
// contract's directSettlementTarget doc comment). Escrow.decisionRelay
// is immutable, so adding this required a full new DecisionRelay+Escrow
// pair, not an upgrade of the Phase 1 pair — see
// RETIRED_SEPOLIA_ADDRESSES below for why the Phase 1 pair is NOT simply
// obsolete history: it still holds a real, currently-unsettled deposit
// this new pair cannot reach.
//
// Updated again same day (Phase 2, second deploy): an external audit
// pass on attestedSettle()'s design found its signed digest missing
// block.chainid and a deadline, and binding the settlement target only
// implicitly (via directSettlementTarget's value AT CALL TIME, not what
// attestors actually saw when they signed). All three are real gaps —
// see DecisionRelay.sol's attestedSettle() doc comment — fixed by
// redeploying once more with the corrected signature scheme before this
// pair was ever exercised with a real case. The first Phase 2 deploy
// (decisionRelay 0x2d5E63ea1F83f6BF5a438c354454b100904896EE, escrow
// 0x891C38cd2E4a92b0ae9b63b55bd2aa6883381A5d) is retired below — it was
// never used for a real case in the time it was active, so unlike the
// Phase 1 pair it carries no stuck funds.
export const ACTIVE_SEPOLIA_TOPOLOGY = {
  sourceDomain: 11155111,
  destinationDomain: 11155111,
  mailbox: "0x345E7246631ceb0300427caB75eacA10c326BB09" as Address,
  merkleTreeHook: "0xA32341dc796DB6C51c0D1695751aC9AA2Dd77aBB" as Address,
  validatorAnnounce: "0x198A6ec048C665d7E4dc2b40Cb2c715Db1cEC6F5" as Address,
  ism: "0xd916b90858B8bF7Cc7E111D3C7923ab4Fe0FCcf0" as Address,
  decisionRelay: "0x56bf62F9F4C2C316D956F9C35DD1B15BE5ae9834" as Address,
  escrow: "0x5a7a2F3553f147a6D2BE4b23CB36D693e12e98bD" as Address,
  trustedSenderAddress: "0x7401c129EDfc26E68FE19309fE461eb3Db1058Eb" as Address,
  attestorThreshold: 2,
} as const;

// Retired addresses — kept here ONLY as a labelled historical record so
// a stray hardcoded reference to one of these anywhere in the codebase
// is easy to grep for and flag as stale. Never read from this list for
// anything but incident documentation.
//
// decisionRelayPhase1OwnMailbox/escrowPhase1 are a PARTIAL exception:
// they are superseded for all NEW cases (ACTIVE_SEPOLIA_TOPOLOGY above
// is what new dispatches use), but Escrow.decisionRelay is immutable, so
// any deposit already sitting in escrowPhase1 can ONLY ever be reached
// through decisionRelayPhase1OwnMailbox's own handle()/emergencyRefund()
// — never through the new pair's attestedSettle(). Do not delete this
// entry or treat it as pure history until that deposit is fully
// resolved (settled or emergency-refunded).
export const RETIRED_SEPOLIA_ADDRESSES = {
  canonicalSharedMailbox: "0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766" as Address,
  canonicalSharedMerkleTreeHook: "0x4917a9746A7B6E0A57159cCb7F5a6744247f2d0d" as Address,
  canonicalSharedValidatorAnnounce: "0xE6105C59480a1B7DD3E4f28153aFdbE12F4CfCD9" as Address,
  decisionRelayOnCanonicalMailbox: "0x1fc130416Dc09dff60e0Ea3C8dE8474e8428b3E2" as Address,
  escrowOnRetiredDecisionRelay: "0x4C7765A6823dc27Eca1DE174FceeAE5048d403e7" as Address,
  decisionRelayPhase1OwnMailbox: "0x100720fe9f0bFc83E6FdEA392Cb3a0905A5acEa9" as Address,
  escrowPhase1: "0xd848A7CA77CcaA3718d430F7D0DB62174e7a3DfC" as Address,
  // First Phase 2 deploy — attestedSettle() existed but signed only
  // (recipientAddress, caseId, outcome, amounts, escrowId, proofHash),
  // no chainid/deadline/explicit-target-binding. Never used for a real
  // case, so retiring it (unlike the Phase 1 pair) leaves nothing
  // stuck.
  decisionRelayPhase2PreAuditFix: "0x2d5E63ea1F83f6BF5a438c354454b100904896EE" as Address,
  escrowPhase2PreAuditFix: "0x891C38cd2E4a92b0ae9b63b55bd2aa6883381A5d" as Address,
} as const;

// Mirrors chains/hyperlane-validator/deployment.json's validators array.
// Reused as-is across the mailbox migration above: the ISM factory is
// deterministic on (validators, threshold), so the validator set and
// threshold did not change, only the mailbox/hook/DecisionRelay/Escrow
// they're wired to.
export const ACTIVE_VALIDATORS = [
  { address: "0x2ffFd80d446835214EF87Eb3753B48935550f73f" as Address, label: "validator1", operator: "anchor-operator", account: "fly:priscilla-george-personal", provider: "fly.io", flyApp: "anc-hor-validator1" as string | undefined },
  { address: "0xf171c23607b892797Eb5eb4e52fc668f924Df0A3" as Address, label: "validator2", operator: "independent-operator-gideon820001", account: "aws:069066994101", provider: "aws-ec2", flyApp: "anc-hor-validator2" as string | undefined },
  { address: "0x4dbc8704ebD282535d64Be6daDF2a477C543114D" as Address, label: "validator3", operator: "independent-operator-bard775", account: "aws:269469928649", provider: "aws-ec2", flyApp: undefined as string | undefined },
] as const;
