# Onboarding an independent Hyperlane validator operator

This is for a **third party** — a different person, on their own cloud
account, who will run a validator whose key Anchor's own operator never
sees. If you're Anchor's own operator adding another validator you
personally control, this still applies (use a genuinely separate
account/provider from the existing ones), but you already have full
context the runbook below spells out for someone who doesn't.

**Read `README.md` and `../../docs/self-hosted-validator-setup.md`
first** for what a Hyperlane validator actually is and why this
project runs its own instead of using a paid vendor.

## What you will and won't be asked for

**You will generate and hold, entirely on your own infrastructure:**
- A validator signing key (secp256k1 — Hyperlane checkpoint signatures
  use the same curve as Ethereum, even on an EVM-origin chain like
  Sepolia).
- AWS (or S3-compatible) credentials for your own checkpoint storage.
- The cloud account/Fly.io account (or equivalent) the validator process
  runs on.

**Anchor's operator will never ask you for:** the validator private key,
your AWS credentials, or access to your cloud account. If anyone asks
for these, stop and verify independently before proceeding — the entire
point of this runbook is that Anchor's operator can verify your
validator is real and correctly configured (`scripts/verify-deployment.ts`)
without ever holding your key.

**Anchor's operator will provide you:** the Sepolia RPC URL to index
(any reliable public one works — you aren't required to use the same
provider Anchor uses), the Mailbox and ValidatorAnnounce addresses, and
— once you've announced — will add your validator address to a new
multisig ISM deployment and coordinate the cutover.

## Step-by-step

### 1. Generate your validator key

```bash
cast wallet new
```
Run this **offline if possible**, or at minimum on a machine that isn't
the one hosting the validator process itself, and never paste the
private key anywhere online (chat, a ticket, a repo). Send Anchor's
operator only the **address**.

### 2. Set up checkpoint storage

Any AWS account you control. Free tier is enough (checkpoints are tiny
JSON files).

```bash
# Create a bucket dedicated to this validator (don't share Anchor's bucket —
# that would reintroduce exactly the shared-storage-credential problem
# this runbook exists to avoid):
aws s3api create-bucket --bucket <your-unique-bucket-name> --region <your-region> \
  --create-bucket-configuration LocationConstraint=<your-region>

# Create a dedicated IAM user, scoped to only this bucket:
aws iam create-user --user-name hyperlane-validator
aws iam put-user-policy --user-name hyperlane-validator --policy-name checkpoint-write --policy-document '{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject", "s3:ListBucket"],
    "Resource": ["arn:aws:s3:::<your-unique-bucket-name>", "arn:aws:s3:::<your-unique-bucket-name>/*"]
  }]
}'
aws iam create-access-key --user-name hyperlane-validator
```

**Make the checkpoint objects publicly readable** (anonymous
`s3:GetObject`) — this is not optional. A real relayer (ours, or anyone
else's) has no AWS credentials of yours and fetches checkpoints via
plain HTTPS. A live bug found and fixed during this project's own
setup: a private bucket makes the validator's checkpoints
unfetchable by any relayer, silently breaking delivery with no error on
the validator's own side. Verify this yourself before announcing:

```bash
curl -I https://<your-unique-bucket-name>.s3.<your-region>.amazonaws.com/<your-prefix>/metadata_latest.json
# must be 200 (once the validator has written at least one checkpoint), not 403
```

Bucket policy for public read on just your checkpoint prefix:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PublicReadCheckpoints",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::<your-unique-bucket-name>/<your-prefix>/*"
  }]
}
```
(You'll also need to turn off the two policy-related "Block Public
Access" settings for this bucket — not the ACL-related ones — same as
`docs/self-hosted-validator-setup.md` describes for Anchor's own
bucket.)

### 3. Run the validator

Copy `Dockerfile`, `entrypoint.sh`, and `config.json` from this
directory as a starting point (they're generic — nothing Anchor-specific
except the Sepolia RPC override, which you can point at your own
provider). Deploy on your own infrastructure — Fly.io, a VPS, your own
Kubernetes, whatever you already operate. Set (as secrets, never
committed):
- `VALIDATOR_KEY` — from step 1
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — from step 2
- `S3_BUCKET`, `S3_REGION`, `S3_FOLDER` — from step 2

### 4. Confirm it announced and is publishing real checkpoints

The validator agent announces itself automatically on first successful
startup (it self-funds the announce transaction from `VALIDATOR_KEY`,
so that key needs a small amount of Sepolia ETH — request some from a
public faucet). Confirm:

```bash
cast call 0xE6105C59480a1B7DD3E4f28153aFdbE12F4CfCD9 \
  "getAnnouncedStorageLocations(address[])(string[][])" "[<your_validator_address>]" \
  --rpc-url https://ethereum-sepolia.publicnode.com
```
Should return your bucket/prefix, not an empty array.

### 5. Send Anchor's operator

- Your validator's **address** (not the key).
- The **announced storage location** (from step 4, so it can be
  cross-checked against what's actually reachable).
- Confirmation you've verified the public-read check from step 2
  yourself.

Anchor's operator runs `scripts/verify-deployment.ts` against a
`deployment.json` that includes your validator to confirm everything
independently before including you in a new ISM deployment. See that
script's own output for exactly what it checks.

### 6. Cutover

Once your validator passes verification, Anchor's operator deploys a
new multisig ISM including your address (via Hyperlane's own
`staticMerkleRootMultisigIsmFactory`), redeploys `DecisionRelay`
pointed at it (a 2-of-2 Safe governance action — see
`docs/multisig-attestor-setup.md`), and updates the self-hosted
relayer's whitelist. None of this requires your key or your
infrastructure to change — only your validator's checkpoints need to
keep being published, which they already are.

## Machine-readable template

Send back a filled-in copy of this instead of prose, if you prefer —
`deployment.json` in this directory is exactly this shape (see its
`validators` array):

```json
{
  "address": "0x...",
  "label": "validator3-<your-name-or-org>",
  "operator": "<your name/org — must differ from any existing entry>",
  "account": "<your cloud account identifier — must differ from any existing entry>",
  "provider": "<e.g. fly.io, aws, your own VPS host — must differ from any existing entry>",
  "iamPrincipal": "<your IAM user ARN — must differ from any existing entry>",
  "s3Bucket": "<your bucket name — must differ from any existing entry>",
  "s3Prefix": "<your chosen prefix>"
}
```
Every field marked "must differ" is checked by
`scripts/verify-deployment.ts`'s independence check — if any of them
match an existing validator's entry, the new validator does NOT count
toward real multi-party security, and the tooling will say so plainly
rather than silently accept it.
