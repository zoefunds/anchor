# EVM attestor custody + governance — DONE, and how to keep operating it

This used to be a plan for setting up real M-of-N attestor key custody.
As of this pass, the EVM side is actually done and verified live, not
just designed. This doc now records what's real, and how to operate it
day-to-day. The Solana side is still a placeholder — see the bottom.

## Current live state

- **DecisionRelay**: `0xC7e496870cdd4A694fffBFa466056aE427E71Dee` (Sepolia)
- **Attestors**: 2-of-2 —
  - `0x3261CEF8Ca14FCc9EF1Cd584209D7c3b7f578b70`, backend-held (`ATTESTOR_PRIVATE_KEYS` on `anc-hor-worker`)
  - `0x229d46B4C22B5AA42fE7cDAae37cf611e726f732`, held **offline**, generated on a machine never connected to Fly/Vercel — the backend never had this private key
- **Governance owner**: Gnosis Safe `0xc200534F7DEbF2816C085C5A156aBd686fA19f4C`, 2-of-2, owned by the deployer wallet + a separate governance key also held offline (`0xEDc300fb7Bd8437C90aF68393381514722FE128c`) — distinct from the attestor key above, on purpose (see "Why governance is a separate key" below)

Real 2-of-2 settlement was proven end-to-end: `dispatchDecisionForCase`
genuinely throws `InsufficientAttestorSignaturesError` when only the
backend's 1 key is available, and only completes once the offline
attestor's real signature is added — verified via a live dispatch
(`0x804ed5882a1ec114274e23fd7f5b64dadb3996be637056dfdf596da24693f580`)
that settled only after both signatures were present.

## Why "the backend holds threshold-many keys" isn't real security

If `attestorThreshold = 2` and the backend process holds both keys,
compromising that one process is enough to forge a settlement — a
single point of failure, just spread across more key files. That's
exactly the gap this closes: the backend now holds strictly fewer than
`attestorThreshold` keys (1 of 2), so it structurally cannot dispatch
alone anymore.

## Why governance is a separate key from the attestor key

`DecisionRelay.sol`'s `owner` can `addAttestor`/`removeAttestor` and
`setAttestorThreshold` — i.e., rewrite the very policy the attestors
enforce. An owner that's the same key as an attestor (or the backend)
could lower the threshold to 1 and settle unilaterally, defeating the
M-of-N guarantee entirely without ever forging a signature. That's why
`owner` is now a separate 2-of-2 Safe, not a wallet, and why the
governance key is distinct from the attestor key even though the same
person holds both offline — a compromise of one doesn't hand over the
other's authority.

## Day-to-day: co-signing a real decision

When a real decision can't settle because the backend's key alone
doesn't reach threshold, `Decision.pendingAttestationHash` gets set and
`relayError` shows `"awaiting external attestor signature(s): 1/2
collected"`.

1. **Find pending decisions:**
   ```bash
   curl -H "Authorization: Bearer $ATTESTOR_COSIGN_SECRET" \
     https://anc-hor.vercel.app/api/internal/pending-attestations
   ```
2. **Sign the hash offline**, using the attestor private key (never
   paste this key anywhere online):
   ```bash
   cast wallet sign --private-key <attestor_key> --no-hash <attestationHash>
   ```
3. **Submit only the signature:**
   ```bash
   curl -X POST -H "Authorization: Bearer $ATTESTOR_COSIGN_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"signature":"0x..."}' \
     https://anc-hor.vercel.app/api/internal/pending-attestations/<decisionId>/sign
   ```
   The route verifies the signature actually recovers to a registered
   attestor address before accepting it (`isRegisteredAttestor` on-chain
   read) — a bad or unregistered signature is rejected outright, not
   silently stored.
4. Settlement completes within ~10 minutes via `anc-hor-worker`'s
   `retryFailedSettlements` sweep (that process is the only one holding
   `HYPERLANE_RELAY_PRIVATE_KEY`/`ATTESTOR_PRIVATE_KEYS`; the Vercel-side
   API route deliberately doesn't attempt dispatch itself).

`ATTESTOR_COSIGN_SECRET` gates *who can attempt to submit* a signature,
not whether it's valid — treat it like any other backend secret
(rotatable, not attestor-key-equivalent), since a submitted signature
that doesn't recover to a registered attestor is rejected regardless of
who submitted it.

## Day-to-day: a governance change (adding/removing an attestor, changing threshold)

Any `addAttestor`/`removeAttestor`/`setAttestorThreshold`/
`setTrustedSender`/`setSettlementTarget` call now needs 2 Safe
signatures, not 1 EOA transaction:

1. Compute the call's inner calldata (e.g.
   `cast calldata "addAttestor(address)" <addr>`).
2. Read the Safe's current `nonce()` and call `getTransactionHash(...)`
   on the Safe (`0xc200534F7DEbF2816C085C5A156aBd686fA19f4C`) with that
   calldata, `operation=0`, all gas/refund params zeroed, to get the
   hash to sign.
3. Both owners run `cast wallet sign --private-key <key> --no-hash
   <hash>` independently.
4. Concatenate the two signatures **sorted by signer address
   ascending** and call `execTransaction(...)` on the Safe with them —
   see this session's transcript for the exact `cast send` invocation
   used for the two governance changes made during setup, as a working
   template.

Every one of these emits a distinct event now (`AttestorAdded`,
`AttestorRemoved`, `AttestorThresholdChanged`, `TrustedSenderChanged`,
`SettlementTargetChanged` — see `DecisionRelay.sol`) — worth watching
via a block explorer alert or a small script if this becomes routine,
since a re-audit specifically flagged that a compromised owner
rewriting the policy should be loud, not silent.

## Never do

- Never let the backend hold `attestorThreshold`-or-more attestor keys
  at once — that silently undoes all of the above.
- Never let a Safe owner key double as an attestor key, or vice versa.
- Never treat a key whose private material has appeared anywhere
  online (a chat log, a committed file, a screen-shared terminal) as
  real custody again — remove it as an attestor/owner and generate a
  fresh one, the way the interim "spare" attestor key was removed once
  its key had appeared in this conversation's transcript.

## Solana side (decision-relay) — still not M-of-N

Unlike the EVM side, Solana's `decision-relay` program still uses a
single hardcoded `ATTESTOR_PUBKEY`, backed by a single
`SOLANA_ATTESTOR_PRIVATE_KEY` held entirely by the backend. Real M-of-N
there needs the on-chain program to require multiple separate
Ed25519-verify instructions (one per signer) preceding
`AttestedSettle`, checked against an `attestor_pubkeys: Vec<Pubkey>` +
`attestor_threshold: u8` pair mirroring the EVM contract — genuinely
more Rust/on-chain work than the EVM side, not just a config change.
Flagged as a real, scoped follow-up rather than attempted in this pass.
Until then, `SOLANA_ATTESTOR_PRIVATE_KEY` should get the same
never-shared, offline-generated handling described above even though
it's a single key today — losing or leaking it is a full Solana-side
forgery risk.
