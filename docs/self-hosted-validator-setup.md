# Replacing the permissive ISM with a real Hyperlane validator set (free, self-hosted)

`TrustedRelayerIsm.sol`'s `verify()` always returns `true` — it performs
no cryptographic check that a delivered message genuinely originated
from the claimed chain. That's an accepted MVP tradeoff (see that
contract's own doc comment) compensated for on the EVM side by
`DecisionRelay.sol`'s attestation requirement, but it is not a
substitute for real origin verification, and nothing compensates for it
on the *inbound* CaseOriginate path (Solana -> Sepolia) the same way.
Fixing this for real means running actual Hyperlane validators — code
Anchor can scaffold, but the validators themselves must be run by real,
independent operators, which is the part only you can do. This is that
setup, using the same free Fly.io infrastructure already hosting the
relayer, not a paid vendor.

## What a Hyperlane validator actually is

A validator is a long-running process that watches a Mailbox on one
chain, and for every dispatched message, signs a checkpoint (a Merkle
root + index) attesting "I observed this state." It publishes these
signed checkpoints to public storage (S3, GCS, or even a local HTTP
server). A **multisig ISM** on the destination chain then requires
`threshold`-many of a configured validator set to have signed a
checkpoint covering a message before `process()` will accept it — this
is what actually replaces `TrustedRelayerIsm`'s always-true `verify()`.

Hyperlane ships the validator binary; you don't write consensus logic
yourself. What you're deciding and doing is: how many validators, who
runs each one, and where each publishes checkpoints.

## Step 1 — decide your validator set

Same principle as the attestor multisig
(`docs/multisig-attestor-setup.md`): independent operators. For a small
real deployment, 3 validators with a 2-of-3 threshold is a reasonable
starting point:

1. **You, on the existing `anc-hor` Fly.io org** (a new Fly app,
   separate from the relayer and worker).
2. **A second person on your team**, on their own Fly.io account (free
   tier is enough for a validator — it's lightweight).
3. **A third independent host** — a free-tier VM at a different
   provider (Oracle Cloud, a home Raspberry Pi with a static
   IP/tunnel, etc.), so a single provider outage or account
   compromise can't take out 2-of-3.

Each validator needs its own Ed25519 signing key (Hyperlane's own key,
distinct from anything in `docs/multisig-attestor-setup.md`) and its
own checkpoint storage location.

## Step 2 — checkpoint storage (free tier is enough)

Pick one per validator:
- **S3-compatible, free tier**: AWS S3 free tier, or Cloudflare R2
  (10GB free, S3-compatible, no egress fees) — checkpoints are tiny
  JSON files, this comfortably fits free tier limits.
- **Local storage served over HTTP** — the validator can write
  checkpoints to a local directory and you put a tiny static file
  server (nginx, or even `python3 -m http.server`) in front of it on
  the same Fly.io machine. Zero additional cost, since it's the same
  app as the validator process.

## Step 3 — generate each validator's key

```bash
# On each validator's own machine/account:
cast wallet new   # or any Ed25519/secp256k1 keygen — check current
                   # Hyperlane docs (docs.hyperlane.xyz/docs/operate/validators)
                   # for the exact curve their validator binary expects,
                   # since this can change between Hyperlane releases
```

Keep each validator's private key ONLY on its own host — never collect
all validator keys in one place, same reasoning as the attestor keys.

## Step 4 — run the validator (per operator)

Hyperlane publishes an official validator Docker image. A minimal
`docker-compose.yml` per validator (adapt the relayer's own
`chains/hyperlane-relayer/` setup as a template — same Fly.io
deploy-a-Docker-image pattern already proven working there):

```yaml
services:
  hyperlane-validator:
    image: gcr.io/abacus-labs-dev/hyperlane-agent:main
    command:
      - ./validator
      - --db=/data/validator.db
      - --originChainName=sepolia
      - --checkpointSyncer.type=s3      # or localStorage
      - --checkpointSyncer.bucket=<your-bucket>
      - --checkpointSyncer.region=<region>
      - --validator.key=<PRIVATE_KEY>   # inject via Fly secret, not here
      - --chains.sepolia.rpcUrl=<your rpc>
    volumes:
      - validator_data:/data
volumes:
  validator_data:
```

Deploy each one the same way the relayer is deployed today
(`flyctl deploy -a <new-validator-app> --config <its fly.toml>`) — one
Fly app per validator operator, on that operator's own Fly account so
custody stays genuinely separate.

## Step 5 — announce each validator on-chain

Every validator must call `ValidatorAnnounce.announce()` once, on the
origin chain, so relayers/light clients can discover where to fetch its
checkpoints:

```bash
cast send <ValidatorAnnounce address for sepolia> \
  "announce(address,string,bytes)" \
  <validator_address> "<checkpoint storage location URI>" <signature> \
  --rpc-url $SEPOLIA_RPC_URL --private-key <validator's own key>
```

The exact calldata format is generated by the validator binary itself
(`--announce` mode) — don't hand-construct it; check current Hyperlane
docs for the exact flag, since this is exactly the kind of interface
that can drift between releases (the same caution this project applied
throughout — verify against the real docs before deploying, don't
build from memory).

## Step 6 — deploy a real multisig ISM and point DecisionRelay at it

Hyperlane provides a canonical `MerkleRootMultisigIsm` (or
`MessageIdMultisigIsm`) implementation — deploy one (via
`@hyperlane-xyz/cli` or directly) configured with your 3 validator
addresses and threshold 2, on Sepolia. Then:

```solidity
// DecisionRelay.sol's customIsm is immutable, so this requires a
// redeploy (same pattern as every prior DecisionRelay redeploy in
// chains/hyperlane-relayer/README.md) — deploy the new multisig ISM
// first, then re-run DeployDecisionRelay.s.sol pointed at it instead
// of a fresh TrustedRelayerIsm.
```

Update `chains/evm/deploy/DeployDecisionRelay.s.sol` to accept the
already-deployed ISM address as an env var instead of always deploying
a fresh `TrustedRelayerIsm`, when you're ready to do this — that's a
small, mechanical code change Anchor can make once the validator set
actually exists; it wasn't done in this pass because there's no real
ISM address to point at yet.

## What stays true either way

Even after this, `DecisionRelay.sol`'s attestation requirement (see
`docs/multisig-attestor-setup.md`) remains valuable and should NOT be
removed — it verifies the decision *content* is genuine, which a
message-origin ISM alone doesn't do (a compromised dispatch pipeline
could still relay a real, correctly-signed-by-validators message
carrying a fabricated decision, absent the attestor check). The two
defenses are complementary, not redundant: ISM = "this message really
came from the claimed origin chain," attestation = "this decision's
content is really what Anchor decided."

## Honest cost/effort note

This is real infrastructure work — at minimum 3 people each running a
Fly app and holding a key, or you accepting a smaller/less-independent
validator set as an interim step (e.g. 2 validators both run by you on
different providers, weaker than true multi-party but still strictly
better than an always-true ISM). Unlike the attestor multisig (which
this session could deploy the contract side of), there is no
"finish it for you" here — announcing validators and standing up
infrastructure requires real accounts, real keys, and real operators
that only you can set up.
