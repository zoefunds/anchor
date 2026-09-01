# @anchor/hyperlane-relay

Shared EVM-side Hyperlane message encoding/dispatch logic — the pieces
that need to stay byte-for-byte identical to what `DecisionRelay.sol`
and `decision-relay` (Solana) decode on the receiving end. Used by
`apps/web/src/lib/hyperlane.ts` (which wraps this with the actual
attestor-signing, M-of-N threshold, and settlement-target logic — see
the root `README.md`'s "Architecture" section for the full pipeline).

## Exports (`index.ts`)

- `HYPERLANE_MAILBOX`, `HYPERLANE_DOMAIN` — canonical Hyperlane
  infrastructure addresses/domain IDs per chain (sepolia,
  solanatestnet), confirmed from Hyperlane's own registry, not guessed.
- `DecisionRelayPayload` — the EVM `DecisionRelay.sol` message shape:
  case id, outcome, claimant/respondent amounts, escrow id, proof hash,
  and `attestationSignatures: Hex[]` — an array (M-of-N; see the type's
  own doc comment for why length alone doesn't guarantee validity, the
  contract does the real ecrecover/dedup/threshold check).
- `computeDecisionAttestationHash(params)` — reproduces
  `DecisionRelay.sol`'s own `keccak256(abi.encode("ANCHOR_DECISION_ATTESTATION_V2", ...))`
  exactly (domain tag, origin, `address(this)`, decision content). Must
  stay in lockstep with the Solidity source or every real signature
  fails verification on-chain — this is why the tag was bumped to V2
  when the M-of-N multisig redesign happened, forcing a hard break with
  any V1-signed attestation.
- `caseIdToBytes32(caseId)` — left-pads a case id string into the
  bytes32 the contract expects.
- `encodeDecisionRelayBody(payload)` — the actual ABI encoding matching
  `handle()`'s `abi.decode(_messageBody, (bytes32, string, uint256,
  uint256, bytes32, bytes32, bytes[]))` exactly.
- `DispatchConfig`, `dispatchRawMessage`, `dispatchDecisionRelay` — the
  actual dispatch-a-transaction logic (via `viem`), signing with
  whichever EVM key the caller supplies and calling the Mailbox's
  `dispatch()`.
- `SealevelDecisionRelayPayload`, `encodeSealevelDecisionRelayBody`,
  `dispatchDecisionRelayToSealevel` — the equivalent for dispatching a
  Hyperlane message *toward* Solana (the notification-only path — real
  Solana settlement goes through `apps/web/src/lib/solana-settle.ts`'s
  direct `AttestedSettle` transaction instead, not through this
  dispatch path; see the root README's architecture section for why).

See `chains/evm/contracts/DecisionRelay.sol` and
`chains/solana/programs/decision-relay/src/lib.rs` for the receiving
ends this package's encoding must match, and
`docs/multisig-attestor-setup.md` for the full M-of-N attestation story
this package's `attestationSignatures`/hash-computation logic serves.
