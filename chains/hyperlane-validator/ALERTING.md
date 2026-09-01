# Alerting

`scripts/verify-deployment.ts` is the alerting mechanism — it's a
single script that checks all four dimensions a production-readiness
audit asked for, and exits non-zero if anything needs attention. No
separate alerting system was built because none of the four checks
below need one; they need this script run periodically and its exit
code/output wired to whatever notification channel you already use
(email, Slack webhook, PagerDuty — all trivially bolt onto "a command
exited non-zero").

| Requirement | How it's covered |
|---|---|
| Validator checkpoint age above threshold | **Not `boot-metadata`** (formerly `checkFreshness`/`agent-liveness`) — confirmed live this pass that `metadata_latest.json` is written once at process startup, not periodically, so its age only ever tells you "how long since last restart," never "is this validator healthy right now." It's a WARN-only informational line now, never a real health signal — do not alert on it. Use `checkpoint-currency` and `message-checkpoint-coverage` below instead. |
| Checkpoint index actually current (not just the agent alive) | `checkCheckpointCurrency` — now reads the real per-index checkpoint files directly (fixed once the S3 bucket policy started returning `404` instead of `403` for missing keys — see `docs/production-readiness-hardening-pass.md`). Reports the validator's real signed checkpoint index, root, mailbox nonce, and contiguous lag; `fail`s if lag exceeds `deployment.json`'s `maxCheckpointLagLeaves`. **Important**: this measures CONTIGUOUS/sequential backfill lag, not whether any specific recent message is deliverable — a message can already be deliverable (its own checkpoint published) while this pointer still lags, since backfill writes checkpoints out of strict order. See `message-checkpoint-coverage` for the per-message answer. |
| A specific recent message's own checkpoint published (not just the sequential pointer) | `checkMessageCheckpointCoverage` (new) — checks whether each validator has published `checkpoint_{nonce}_with_id.json` for the most recently dispatched message's own leaf index, independent of where the contiguous backfill pointer sits. This is the check that actually answers "can this specific message be delivered right now." |
| Validator announcement disappearing/mismatching | `checkAnnouncements` — fails if a configured validator has no announced location; `checkIsm` separately fails if the deployed ISM's validator set doesn't match `deployment.json` |
| Relayer or validator indexing lag | Not a separate on-chain check (nothing exposes either component's internal cursor position externally) — proxied by `checkRecentDelivery`, since lagging indexing on either side is the most common real cause of a dispatch sitting undelivered past SLA. For direct confirmation: relayer side, `flyctl logs -a anc-hor-relayer \| grep 'current_indexing_snapshot'`; validator side, `flyctl logs -a anc-hor-validatorN \| grep 'Latest checkpoint'` — both compared against current chain tip (`cast call <mailbox> "nonce()(uint32)"`). Also see `message-checkpoint-coverage` in `verify-deployment.ts`'s own output, which checks whether the SPECIFIC most-recent dispatch's own checkpoint has been published, independent of contiguous backfill lag. **Historical note**: message `0x61b6e9e3...15df71` was undelivered earlier in this project's history due to validator checkpoint-indexing lag (root cause: an OOM crash-loop, since fixed, plus an S3 bucket-policy gap that made anonymous checkpoint reads on missing keys return `403` instead of `404`, also since fixed) — **this message is now confirmed delivered** (`Mailbox.delivered() == true`, `DecisionRelay.processedDecisions() == true`; see `docs/production-readiness-hardening-pass.md`'s fifth addendum for full evidence). Left here only as a worked example of what this alert category looks like when it's real, not as a current open issue. |
| Undelivered messages beyond SLA | `checkRecentDelivery` — now derives the real Hyperlane message ID from the Dispatch event and calls `Mailbox.delivered(messageId)` directly (fixed post-audit; previously only printed a manual command), `fail`-ing when a dispatch is both past SLA and confirmed undelivered. Configurable via `deployment.json`'s `undeliveredMessageSlaSeconds`/`dispatchLookbackBlocks`. |
| Mismatch between configured relay recipient and on-chain relay address | `checkRelayerWhitelist` (relayer config vs. current `DecisionRelay`) + `checkDecisionRelayIsm` (deployed contract's own `interchainSecurityModule()` vs. the ISM this script verified) |

## Running it periodically

Simplest: a cron entry anywhere with network access to Sepolia and this
repo checked out —

```bash
*/15 * * * * cd /path/to/anchor- && npx tsx chains/hyperlane-validator/scripts/verify-deployment.ts --json > /tmp/hyperlane-check.json; \
  if [ $? -ne 0 ]; then <your notification command> "Hyperlane deployment check failed — see /tmp/hyperlane-check.json"; fi
```

Or as a GitHub Actions scheduled workflow (no infrastructure to
maintain, free for a public/private repo within GitHub's included
minutes):

```yaml
# .github/workflows/verify-hyperlane.yml
on:
  schedule:
    - cron: '*/15 * * * *'
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install
      - run: npx tsx chains/hyperlane-validator/scripts/verify-deployment.ts
        # a non-zero exit here fails the workflow run, which GitHub
        # itself can notify on (Settings -> Notifications, or a
        # third-party GitHub Actions failure webhook) — no extra
        # alerting code needed
```

## Not yet wired to a real destination

Neither the cron nor GitHub Actions example above is actually deployed
against a real notification channel (Slack webhook URL, PagerDuty
integration key, etc.) — both remain copy-paste templates. Wiring one up
for real needs a live webhook URL/API key, which is credential material
this pass cannot fabricate or guess; it's an **operator action**: pick a
destination, provide (as a real secret, never committed) the webhook
URL/key, and either the cron or GitHub Actions template above is a
5-minute change once that exists.

This wasn't wired into `anc-hor-worker`'s existing BullMQ sweep pattern
(`audit-anchor.ts`'s model) on purpose: that pattern is for things the
*application* needs to act on (posting an anchor transaction). This is
purely an operator-facing health check with no application-side action
to take — a cron/CI job is the right shape for it, not another
in-process worker job competing for the same queue.
