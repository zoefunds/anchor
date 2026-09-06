# Replacing validator2 to achieve real A/B/C independence

Status: **prepared in advance — not executed.** Written in direct
response to an external re-audit's finding that the post-validator3 set
is A/A/B (validator1 and validator2 share one operator; validator3 is
the only independent one), not the A/B/C every-pair-independent set the
ISM's "2-of-3" threshold implies to anyone reading it. A compromise of
the shared A operator can still produce two signatures and satisfy
quorum; an outage of that operator can remove two validators and halt
delivery. Validator3 improved resilience but did not fix quorum
independence — this document does.

## Why validator2, not validator1

Arbitrary between the two — both are equally "operator A." validator2
is chosen only so this doc has a single subject; nothing about
validator2 specifically is worse than validator1.

## Why a fourth AWS/Fly account, not validator3's

Reusing validator3's account (`bard-775` / AWS account `269469928649`)
for this replacement would produce A/B/B, not A/B/C — validator2(new)
and validator3 would share everything with each other, just moving
which two validators are non-independent rather than fixing it. The
target state requires **three** distinct accounts total, one per
validator, so every 2-of-3 quorum combination is genuinely
cross-operator.

## Preconditions (learned the hard way building validator3 — check these before starting, not after)

- `config.json` must sit at the Docker build context root, not a
  `config/` subdirectory — the Dockerfile's `COPY config.json
  /config/config.json` is a flat copy; nesting it produces a build
  failure that looks unrelated ("`/config.json`: not found").
- `index.chunk` must be **9**, not 10. Alchemy's free tier accepts
  "up to a 10 block range," but Hyperlane's indexer computes the
  request as `[from, from+chunk]` inclusive — chunk=10 requests an
  11-block range and gets rejected every time.
- `/data` must be `chown 1000:1000`'d before the container's first run
  — the image drops to uid 1000, and a bind-mounted `/data` created by
  root (e.g. via `mkdir -p /data` as root) isn't writable by it.
- The IAM policy needs **five** actions, not three:
  `s3:PutObject`, `s3:GetObject`, `s3:ListBucket` are the obvious ones;
  `s3:GetObjectAttributes` and `s3:GetBucketLocation` are separate IAM
  actions the AWS SDK calls internally that plain `GetObject`/`ListBucket`
  testing won't reveal are missing — they surfaced as a persistent,
  confusing `AccessDenied` loop that looked like a permissions problem
  even after the "obvious" three were granted.
- **The bucket needs a public-read policy regardless of the IAM
  policy above.** This is not optional and not fixable via IAM: read
  the actual `hyperlane-base/src/types/s3_storage.rs` source —
  `latest_index()`, `reorg_status()`, and `fetch_checkpoint()` all use
  a deliberately **anonymous, unauthenticated** S3 client (so relayers
  can read checkpoints without needing AWS credentials at all). Only
  `write_to_bucket` (used by the write path) uses the authenticated
  client. No IAM policy on the validator's own credentials can ever
  satisfy an anonymous read — the bucket's own policy must allow
  `s3:GetObject` and `s3:ListBucket` for `Principal: "*"`, or the
  validator will loop on `AccessDenied` on its own checkpoint-reading
  calls forever, indistinguishable from a real permissions bug.
  Turning off "Block Public Access" is also required first (policy-level
  block only — ACL-level blocking can stay on, since this uses a bucket
  policy, not ACLs).

Prepared artifacts (this session, ready to use):
`validator-new-setup.sh`, `validator-new-iam-policy.json`,
`validator-new-bucket-policy.json` — incorporate all of the above
already so none of it needs rediscovering.

## Steps

1. Confirm the new AWS/Fly account is genuinely separate (check billing
   contact name, account ID, org slug — don't assume from a login
   screen alone).
2. Provision: IAM user with the prepared policy (bucket name
   substituted in), dedicated S3 bucket with the prepared public-read
   policy, EC2 instance (t3.micro, no SSH key, SSM-only access, IAM
   instance role with the S3 policy + `AmazonSSMManagedInstanceCore`).
3. Generate a fresh validator key **on the operator's own machine** —
   never through this session. Share only the public address.
4. Run `validator-new-setup.sh` on the instance, then `docker run` with
   the real secrets (RPC URL, AWS keys, validator key) typed in
   directly by the operator.
5. Fund the new validator address with Sepolia ETH; confirm it
   announces on-chain (`ValidatorAnnounce.getAnnouncedStorageLocations`)
   and starts producing real `checkpoint_<index>_with_id.json` objects
   in S3 (not just the boot-time `announcement.json`/`metadata_latest.json`).
6. Deploy a new `StaticMerkleRootMultisigIsm` via Hyperlane's canonical
   factory (`0x0a71AcC99967829eE305a285750017C4916Ca269`) with
   `[validator1, validator2-new, validator3]` at threshold 2.
7. `DecisionRelay.customIsm` is immutable — this requires a full
   `DecisionRelay` + `Escrow` redeploy (same pattern as
   `VALIDATOR3_CUTOVER.md`), then the same 2-of-2 Safe governance flow
   (`setTrustedSender`, `setSettlementTarget`, `setSettlementMode`) to
   re-point everything at the new relay, then a relayer whitelist
   update.
8. Run `verify-deployment.ts` against the updated `deployment.json`
   (three validators, all pairwise distinct on every tracked
   dimension) and confirm the `independence` check now reports **pass**,
   not the current "shared" warning.
9. Decommission the old validator2 — do not delete its S3 bucket or Fly
   app immediately; leave it stopped for a rollback window first.

## What this does not do

Does not touch the Safe's own 2-of-2 ownership (both owners still share
an operator) or the attestor set (same). Those are the audit's Phase 2,
a separate follow-on with the same "needs a real second independent
holder" constraint as this document, not something this cutover
resolves as a side effect.
