# Moving off the shared public Sepolia RPC

Status: **plumbing only — no secret has been set, nothing deployed with
this pass.** The shared public endpoint (`ethereum-sepolia.publicnode.com`)
remains in use everywhere until you set real secrets per the steps
below. See `docs/production-readiness-hardening-pass.md` for why this
matters: the shared endpoint's rate-limiting has already caused real
validator checkpoint-indexing degradation once.

## What changed in code (safe, no live effect until secrets are set)

- `chains/hyperlane-validator/entrypoint.sh`,
  `chains/hyperlane-relayer/entrypoint.sh` — both now require
  `HYPERLANE_SEPOLIA_RPC_URL` and **fail closed** (exit 1, clear error)
  if it's unset, unless `ALLOW_PUBLIC_RPC_FALLBACK=true` is also set
  (local development only). Neither var is set anywhere yet, so nothing
  currently deployed has changed behavior — this only takes effect on
  the *next* deploy of each app, and that deploy will itself fail to
  start until you provide the secret (see below before redeploying).
- `chains/hyperlane-validator/config.json`,
  `chains/hyperlane-relayer/config.json` — the hardcoded/placeholder
  RPC URL is now `__SEPOLIA_RPC_URL__`, substituted at container start
  from the resolved value above. Never baked into the image.
- `chains/hyperlane-validator/scripts/verify-deployment.ts` — reads the
  same `HYPERLANE_SEPOLIA_RPC_URL`/`ALLOW_PUBLIC_RPC_FALLBACK` policy via
  `resolve-rpc-url.ts`, same fail-closed behavior, same "only log the
  host" rule. `deployment.json` no longer has an `rpcUrl` field.

## Getting an endpoint (free tier is fine)

You do not need a paid plan to get real improvement over the shared
public endpoint — a free-tier dedicated endpoint from Alchemy, Infura,
or QuickNode is still yours alone, not shared with every other Hyperlane
validator/relayer operator on the internet hitting the same public
node. Sign up, create a Sepolia app/endpoint, copy the HTTPS URL it
gives you (it will look like `https://eth-sepolia.g.alchemy.com/v2/<key>`
or similar — the `<key>` portion makes this a real secret, treat it
exactly like a private key).

**For real separation** (recommended, not required): create three
separate accounts/API keys — one each for validator1, validator2, and
the relayer — so a rate limit or outage on one doesn't silently degrade
all three. Whether your provider's free tier allows multiple accounts
depends on the provider; if it doesn't, one endpoint shared across all
three is still a real improvement over the current fully-public one,
just not as isolated.

## Setting the secret (do this yourself — never paste the URL in chat)

For each app that needs it, run this **in your own terminal**, not
through Claude:

```bash
flyctl secrets set HYPERLANE_SEPOLIA_RPC_URL=<your-endpoint-url> -a anc-hor-validator1
flyctl secrets set HYPERLANE_SEPOLIA_RPC_URL=<your-endpoint-url> -a anc-hor-validator2
flyctl secrets set HYPERLANE_SEPOLIA_RPC_URL=<your-endpoint-url> -a anc-hor-relayer
```

If you have separate endpoints per app, use the matching URL for each
line instead of the same one three times. `flyctl secrets set`
restarts the affected machine automatically — no separate redeploy
needed.

For anywhere `verify-deployment.ts` runs (your own machine, a cron job,
CI), set the same variable in that environment — e.g. locally:
```bash
export HYPERLANE_SEPOLIA_RPC_URL=<your-endpoint-url>
npx tsx chains/hyperlane-validator/scripts/verify-deployment.ts
```

To confirm a secret is set (name/status only, never the value):
```bash
flyctl secrets list -a anc-hor-validator1
```

## Rollback to the shared public endpoint

If a dedicated endpoint turns out to be misconfigured or you need to
revert quickly:

```bash
flyctl secrets unset HYPERLANE_SEPOLIA_RPC_URL -a anc-hor-validator1
flyctl secrets set ALLOW_PUBLIC_RPC_FALLBACK=true -a anc-hor-validator1
```
(repeat for `anc-hor-validator2` and `anc-hor-relayer` as needed). This
restarts the machine on the shared public endpoint, same as before this
change — a real, tested-working fallback, not a guess.

To go back to a dedicated endpoint later, `flyctl secrets set
HYPERLANE_SEPOLIA_RPC_URL=...` again (no need to unset the fallback
flag first — a set `HYPERLANE_SEPOLIA_RPC_URL` always takes priority
over `ALLOW_PUBLIC_RPC_FALLBACK`).

## Verifying it worked

```bash
flyctl logs -a anc-hor-validator1 --no-tail | grep '\[rpc\]'
```
Should show `using dedicated endpoint: <your-provider's-host>`, never
`PUBLIC FALLBACK`, and never the full URL/key.
