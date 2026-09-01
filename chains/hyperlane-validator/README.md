# Anchor's self-hosted Hyperlane validators

Two Fly.io apps (`anc-hor-validator1`, `anc-hor-validator2`), each
running the official `hyperlane-agent` image's `./validator` binary
against Sepolia, publishing signed checkpoints to a real AWS S3 bucket,
and announced on-chain via `ValidatorAnnounce`. See
`docs/self-hosted-validator-setup.md` at the repo root for the full
story: what's live, why AWS S3 instead of Cloudflare R2 (a real,
reproduced compatibility bug in this agent version against R2 — not a
config mistake), and how to add another validator.

## Deploying a new validator (e.g. a third, on a different operator's account)

```bash
# 1. Generate a key on the NEW operator's own machine — never share the private key:
cast wallet new

# 2. Copy this directory's Dockerfile/entrypoint.sh/config.json as-is.
#    Write a new fly.validatorN.toml with a unique app name + volume name.

# 3. Create the app + volume + secrets on the new operator's Fly account:
flyctl apps create <app-name>
flyctl volumes create <volume-name> -a <app-name> --region ord --size 1
flyctl secrets set -a <app-name> \
  VALIDATOR_KEY="<the new key>" \
  AWS_ACCESS_KEY_ID="..." \
  AWS_SECRET_ACCESS_KEY="..." \
  S3_BUCKET="..." \
  S3_REGION="..." \
  S3_FOLDER="validatorN"

# 4. Deploy, then start it (these apps have no [http_service] and don't
#    auto-start after a config-only deploy — a real Fly quirk hit
#    during setup, not something to "fix" here):
flyctl deploy -a <app-name> --config fly.validatorN.toml
flyctl machine start <machine-id> -a <app-name>

# 5. Confirm it announced:
cast call 0xE6105C59480a1B7DD3E4f28153aFdbE12F4CfCD9 \
  "getAnnouncedStorageLocations(address[])(string[][])" "[<new_validator_address>]" \
  --rpc-url $SEPOLIA_RPC_URL
```

Then deploy a new multisig ISM including the new validator (via
Hyperlane's `staticMerkleRootMultisigIsmFactory`,
`0x0a71AcC99967829eE305a285750017C4916Ca269` on Sepolia — confirmed
from `hyperlane-registry`, not guessed) and redeploy `DecisionRelay`
pointed at it — see `docs/self-hosted-validator-setup.md` for the
exact steps and the Safe governance dance that goes with it.
