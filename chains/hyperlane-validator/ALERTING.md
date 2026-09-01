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
| Validator checkpoint age above threshold | `checkFreshness` — configurable via `deployment.json`'s `checkpointFreshnessThresholdSeconds` |
| Validator announcement disappearing/mismatching | `checkAnnouncements` — fails if a configured validator has no announced location; `checkIsm` separately fails if the deployed ISM's validator set doesn't match `deployment.json` |
| Relayer indexing lag | Not a separate on-chain check (nothing exposes a relayer's internal cursor position externally) — proxied by `checkRecentDelivery`, since a lagging relayer is the most common real cause of a dispatch sitting undelivered past SLA. For direct confirmation, grep the relayer's own logs: `flyctl logs -a anc-hor-relayer \| grep 'current_indexing_snapshot'` and compare the reported block to current chain tip. |
| Undelivered messages beyond SLA | `checkRecentDelivery` — configurable via `deployment.json`'s `undeliveredMessageSlaSeconds`/`dispatchLookbackBlocks` |
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

This wasn't wired into `anc-hor-worker`'s existing BullMQ sweep pattern
(`audit-anchor.ts`'s model) on purpose: that pattern is for things the
*application* needs to act on (posting an anchor transaction). This is
purely an operator-facing health check with no application-side action
to take — a cron/CI job is the right shape for it, not another
in-process worker job competing for the same queue.
