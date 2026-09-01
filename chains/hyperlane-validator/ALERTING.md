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
| Validator checkpoint age above threshold | `checkFreshness`/`agent-liveness` — configurable via `deployment.json`'s `checkpointFreshnessThresholdSeconds`. **Caveat found live this pass**: this only proves the validator process is alive and touching S3 (it reads `metadata_latest.json`, a per-boot heartbeat file) — it does NOT prove the validator's real signed checkpoint index is current. A validator can restart-loop and look "fresh" here while its checkpoint index sits frozen far behind the chain tip. See `checkpoint-currency` below. |
| Checkpoint index actually current (not just the agent alive) | `checkCheckpointCurrency` — currently a WARN-only check: the real per-index checkpoint files weren't reachable at any filename this project's tooling tried, so it can't independently verify index currency over HTTPS yet. Cross-check manually: `flyctl logs -a anc-hor-validatorN --no-tail \| grep "Latest checkpoint"` and compare the reported index to `cast call <mailbox> "nonce()(uint32)" --rpc-url <rpc>`. |
| Validator announcement disappearing/mismatching | `checkAnnouncements` — fails if a configured validator has no announced location; `checkIsm` separately fails if the deployed ISM's validator set doesn't match `deployment.json` |
| Relayer or validator indexing lag | Not a separate on-chain check (nothing exposes either component's internal cursor position externally) — proxied by `checkRecentDelivery`, since lagging indexing on either side is the most common real cause of a dispatch sitting undelivered past SLA. For direct confirmation: relayer side, `flyctl logs -a anc-hor-relayer \| grep 'current_indexing_snapshot'`; validator side, `flyctl logs -a anc-hor-validatorN \| grep 'Latest checkpoint'` — both compared against current chain tip (`cast call <mailbox> "nonce()(uint32)"`). **Confirmed live this pass**: message `0x61b6e9e3...15df71` is undelivered specifically because of *validator* checkpoint-indexing lag (root cause: an OOM crash-loop, fixed, compounded by public-RPC rate-limiting, not fixed — see `docs/production-readiness-hardening-pass.md`), not a relayer-side issue as originally suspected. |
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
