# Incident history

Every recorded incident, linked rather than re-summarized (avoiding a
second copy that can drift from the source):

- `incidents/2026-09-03-settlement-availability.md` — real settlement
  availability incident.
- `incidents/failed-settlement.md`, `incidents/key-exposure-response.md`,
  `incidents/relayer-failure.md`, `incidents/rpc-outage.md`,
  `incidents/safe-governance-config-change.md`,
  `incidents/signer-failure.md`, `incidents/stuck-escrow.md`,
  `incidents/testnet-redeploy.md`, `incidents/validator-lag.md`,
  `incidents/worker-crash.md` — runbook-style incident playbooks; see
  `docs/runbooks/` for the corresponding operational runbooks these
  playbooks pair with.

Live incident state (the public-facing `Incident` table, distinct from
the markdown playbooks above) is served at `GET /api/status` and shown
on `/status` — see that route for current investigating/monitoring/
resolved incidents, not this static document.

## Reliability-window fail history

Every FAIL tick recorded by the reliability observation window (see
`docs/reliability-observation-window.md`) is durable, queryable history
in the `ReliabilityWindowObservation` table — `GET /api/reliability-window`
returns the current window state plus the list of FAIL ticks and their
reasons. This is the mechanism by which "do not rewrite history or
exclude incidents" is enforced for the window specifically: FAIL ticks
are never deleted, and a reset only changes which ticks count toward the
*current* 30-day span, never removes them from the table.
