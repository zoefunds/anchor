# GenLayer contracts

## Setup

This project uses the official GenLayer skills plugin for contract
development (github.com/genlayerlabs/skills) — it's what `contracts/adjudicator.py`
was written against. `genlayer-dev@genlayerlabs` and `genlayer-docs@genlayerlabs`
are installed (via `claude plugin install`, user scope) — **restart the Claude
Code session for the skills to load**, then they're available directly.

That gives you (via slash/skill invocation once the session restarts):

- `write-contract` — the spec this contract follows (runner pinning, storage
  typing, equivalence principles, LLM resilience)
- `genvm-lint` — validates the contract before deploy; **run this before any
  deploy attempt**:
  ```
  genvm-lint check contracts/adjudicator.py
  ```
- `direct-tests` — fast in-memory tests of business logic (does not exercise
  validator consensus)
- `integration-tests` — full consensus tests against a real GenLayer
  environment (Studio/testnet)
- `genlayer-cli` — deploy/interact/debug via the GenLayer CLI

## Contract: `Adjudicator` (`contracts/adjudicator.py`)

Implements policy `agent_data_task_v1` (see `../docs/policy-v1.md`). One
deployed instance adjudicates one case:

- `__init__(case_id, claimant_ref, respondent_ref, atto_amount)` — deploy
  per-case with pseudonymous party refs, never real identities.
- `adjudicate(task_spec, delivery_payload, claimant_statement, respondent_statement)`
  — consensus-critical write. Runs the LLM comparison via
  `gl.vm.run_nondet_unsafe` with a **custom comparative validator** (not
  `strict_eq` — LLM output isn't deterministic, and not a leader-output-only
  schema check — the validator independently reruns the same task and
  compares outcome + share tolerance + reason-code overlap, per the
  write-contract skill's guidance against leader-trusting validators).
- `get_decision()` / `get_status()` — views returning the structured decision
  JSON (matches `../docs/decision-schema.md`) and lifecycle status.

### Why this shape

- Runner is pinned (`py-genlayer:1jb45...`), not `test`/`latest` — required
  for any real network, this is what caused "could not load contract schema"
  in the first draft.
- Storage fields are class-level type annotations (`u256`, `str`, dataclass
  with `@allow_storage`), not plain Python containers — GenVM only persists
  its own typed collections.
- Validator logic independently re-derives the decision and compares fields
  with tolerance, rather than just checking the leader's JSON is well-formed
  — a schema-only validator would let the leader decide alone.

### Known gaps before this is deploy-ready

- Needs to be run through `genvm-lint check` and direct-mode tests once the
  plugin is installed in an interactive session (I can't run slash-command
  plugin installs or the linter from here — see below).
- `run_nondet_unsafe` / `gl.vm.Result` / `gl.vm.Return` call shapes should be
  confirmed against the exact installed `genlayer` package version — the
  write-contract skill doc is the source of truth used here, but SDK
  versions do shift.
- No deploy script yet (`../deploy/`) — added once we're ready to push to
  Studio.

## Status

**Deployed and running a real end-to-end adjudication on GenLayer StudioNet.**

- Plugins installed and loaded: `genlayer-dev@genlayerlabs`, `genlayer-docs@genlayerlabs`.
- GenLayer CLI configured: `genlayer network set studionet`, account
  `anchor-dev` imported from the throwaway key in `apps/web/.env` (gitignored).
- `genvm-lint check contracts/adjudicator.py` passes clean.
- Direct-mode test suite (`tests/direct/test_adjudicator.py`, 7 cases) passes.
- **Live deploy confirmed**: contract deployed to StudioNet, `adjudicate()`
  called with a real task spec/delivery/statements, 5 independent validators
  ran their own LLM evaluation (4 AGREE, 1 DISAGREE — genuine independent
  variance, not template matching), reached `MAJORITY_AGREE`, and
  `get_decision()` returned:
  ```json
  {"case_id": "CASE-DEMO-FINAL", "policy_id": "agent_data_task_v1",
   "policy_version": "1.0.0", "outcome": "RELEASE_FULL",
   "claimant_share_bps": 0, "respondent_share_bps": 10000,
   "reason_codes": ["SPEC_FULLY_MET"], "consensus": "ACCEPTED"}
  ```
  matching `docs/decision-schema.md` exactly.

### Two real findings fixed along the way

1. **Float in the LLM response breaks GenVM's calldata encoding.** The
   contract originally asked the LLM for `claimant_share`/`respondent_share`
   as 0–1 floats; every adjudication silently returned `None` from
   `exec_prompt` and the contract raised `[LLM_ERROR]`. Fixed by switching to
   integer basis points (`claimant_share_bps`/`respondent_share_bps`,
   0–10000) throughout — contract, `docs/decision-schema.md`,
   `docs/policy-v1.md`, `packages/types`, the Hyperlane message schema, and
   the Prisma schema were all updated to match.

2. **A comment directly under the `Depends` header breaks real deploys, but
   not `genvm-lint`.** GenVM's actual network-side loader concatenates all
   contiguous leading `#` lines into one block and tries to parse it as the
   dependency header JSON (this is how it supports the multi-line `Seq`
   form for multi-file contracts). `genvm-lint` only reads the first line
   and is happy either way, so this passed every local check while failing
   every real deploy with `contract_error: invalid_contract` — status still
   comes back `ACCEPTED`/`FINALIZED`, so the lifecycle status alone looks
   fine; only the receipt's execution result (or a subsequent read against
   the "deployed" address, which comes back "not found") reveals it. Root
   cause found via ~20 bisected deploys isolating one variable at a time.
   **Rule going forward: always a true blank line (no `#`) immediately after
   any `# { "Depends": ... }` header, never another comment line.** See the
   comment at the top of `contracts/adjudicator.py`.

3. **Non-ASCII characters in contract source break `gltest`'s local
   schema-fetch path, even though real on-chain deploy handles UTF-8 fine.**
   `genlayer-py`'s `get_contract_schema_for_code` (used by `gltest`'s
   `factory.deploy()` to build the local `Contract` wrapper) calls
   `eth_utils.hexadecimal.encode_hex`, which does a strict
   `.encode("ascii")` on the contract source — any em dash or other
   non-ASCII character raises `UnicodeEncodeError`, silently swallowed by
   `gltest` into the unhelpful `"Failed to get schema from all clients"`.
   The contract itself deploys and runs correctly on-chain regardless
   (proven by the CLI deploy above); only `gltest`'s tooling path breaks.
   **Rule: keep contract source pure ASCII** — verify with
   `python3 -c "open('contracts/adjudicator.py').read().encode('ascii')"`.
   Found by monkeypatching `gltest`'s swallowed warning to print the full
   traceback rather than trusting the top-level error message.

## Integration tests: passing

`tests/integration/test_adjudicator_integration.py` (2 cases, marked
`@pytest.mark.slow`, real consensus against StudioNet — ~2 min):

```
tests/integration/test_adjudicator_integration.py::test_release_full_on_studionet PASSED
tests/integration/test_adjudicator_integration.py::test_refund_full_on_studionet PASSED
2 passed in 125.17s
```

Run with:
```bash
cd genlayer
gltest tests/integration/ -v -s -m slow --network studionet
```

## `packages/genlayer-sdk`: wired and proven end-to-end

`apps/web`'s `POST /api/cases/:id/adjudicate` now does for real what was
previously only proven via the CLI: deploys a per-case `Adjudicator`
instance, calls `adjudicate()` with the assembled evidence, waits for real
5-validator consensus, and persists the structured decision — all through
Anchor's own HTTP API against live StudioNet. Verified with a real run:
case created → evidence submitted → `POST .../adjudicate` → `200` with a
persisted decision (`REQUIRED_MORE_EVIDENCE`/`INSUFFICIENT_EVIDENCE` that
run — LLM judgment genuinely varies run to run, as expected for adjudication
rather than a scripted response).

### A fourth real finding: `genlayer-js`'s documented receipt shape doesn't match runtime

The docs (`api-references/genlayer-js`, "Checking execution results") say
to check `receipt.txExecutionResultName === ExecutionResult.FINISHED_WITH_RETURN`
after `waitForTransactionReceipt`. Verified against the installed package's
own `.d.ts` first (same discipline as the contract and Hyperlane work) — the
field exists in the type declarations. But empirically, against real
StudioNet with `genlayer-js@1.1.8`, `waitForTransactionReceipt` returns the
**raw snake_case receipt** (`status_name`, `consensus_data`, no top-level
`txExecutionResultName` at all) regardless of the documented
`fullTransaction: false` default — confirmed by dumping the actual receipt
JSON from a standalone script rather than trusting the docs or the types.
Every check against the documented field silently evaluated `undefined !==
FINISHED_WITH_RETURN` and failed instantly (~11s, far too fast for real
5-validator consensus) even though the underlying deploy had genuinely
succeeded. **Fix: check `consensus_data.leader_receipt[]` for the entry with
`mode === "leader"` and `execution_result === "SUCCESS"`** — the same shape
the `genlayer` CLI's own receipt output uses, confirmed consistent across
both clients. See `packages/genlayer-sdk/index.ts` for the implementation
and full rationale in its header comment.

### Still needed

- Deploy script (`deploy/`) for repeatable CI-style deploys — currently
  deployed per-case at request time via `packages/genlayer-sdk`, which is
  the actual production path; a standalone script is for local/CI tooling.
- The adjudicate route runs synchronously in the request (~1-2 min for real
  consensus) — fine for now, but a production version should move this to
  a background job so the case sits in `ADJUDICATING` and a webhook/poll
  picks up the result, per the architecture notes in the root README.
- Hyperlane relay dispatch (`docs/hyperlane-integration.md`) — not wired
  yet; the decision is persisted but not relayed cross-chain.
