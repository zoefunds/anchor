# Test evidence

## Unit/integration test suite

`apps/web/tests/` contains 40 `*.test.ts` files (vitest), run via
`npm run test:integration` (`vitest run`) from `apps/web/`. This
includes, among others, regression tests for real bugs found during
this project (e.g. `reliability-monitor-checkpoint-currency.test.ts`,
`reliability-monitor-rpc-provider-risk.test.ts`,
`environment-registry.test.ts`), and this track's own
`reliability-window-pass-fail.test.ts`.

**This track's own test** (`reliability-window-pass-fail.test.ts`) was
run directly and its output captured:

```
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

Covers: no-observations state, an unbroken healthy run, a non-quorum
FAIL extending the window without resetting it, a signer-quorum-loss
FAIL resetting the window, a sub-4-hour missed-observation gap
extending (not resetting) the window, an over-4-hour gap resetting it,
and reaching a plain `PASS` after a full unbroken 30-day span — i.e.
every branch of the written rule in
`docs/reliability-observation-window.md`.

`npx tsc --noEmit` across `apps/web` was run and produced zero errors
after all of this track's changes (see this track's final report for
the exact command output).

## What this does and does not establish

- These are unit/integration tests against this repo's own logic and
  (for some suites) a local test Postgres — they establish the pass/fail
  computation and window-state logic is internally consistent with its
  own written specification, not that the specification itself is the
  right one for every possible operational scenario.
- No load testing, fuzzing, or third-party security audit has been
  performed on the settlement/custody contracts or the reliability
  tooling built in this track. That remains an open gap for anyone
  relying on this package for a real risk decision.

## Solidity contracts

No Foundry test run output is captured in this package — see
`chains/evm/test/` (if present) directly and re-run `forge test` for
current results; this package does not restate contract-level test
counts to avoid a stale, hand-copied number drifting from reality.
