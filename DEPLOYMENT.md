# Deployment

Live at **https://anc-hor.vercel.app** (Vercel) + six Fly.io apps for
everything that can't run as a Vercel serverless function, plus real AWS
S3 for Hyperlane validator checkpoint storage.

## Layout

| Piece | Where | Why there |
|---|---|---|
| Next.js app (pages + `/api/*` routes) | Vercel project `anc-hor` | Serverless-friendly, zero-config Next.js hosting |
| Postgres | Fly app `anc-hor-db` (unmanaged `flyio/postgres-flex`) | Needs to be reachable from Vercel over the public internet — see "Why not Fly Managed Postgres" below |
| Redis (BullMQ job queue + rate limiting) | Upstash (`loving-cougar-198267.upstash.io`) | Already public/TLS by default, no extra networking work needed |
| Adjudication job worker | Fly app `anc-hor-worker` | Long-lived BullMQ Worker process — can't run inside a Vercel serverless function, which has no persistent process between invocations. Also holds `HYPERLANE_RELAY_PRIVATE_KEY`/`ATTESTOR_PRIVATE_KEYS`/`SOLANA_*` and is the only process that ever dispatches a real cross-chain settlement — see the root README's "Security model" |
| Hyperlane relayer | Fly app `anc-hor-relayer` | Long-lived Rust binary watching both chains continuously, delivering Hyperlane messages the public relayer network won't touch |
| Hyperlane validator #1 | Fly app `anc-hor-validator1` | Signs Sepolia checkpoints, publishes to S3, backs the real multisig ISM — see `chains/hyperlane-validator/README.md` |
| Hyperlane validator #2 | Fly app `anc-hor-validator2` | Same, second independent checkpoint signer |
| Validator checkpoint storage | Real AWS S3, bucket `anchor-hyperlane-validator-checkpoints` (`eu-north-1`) | Must be network-fetchable by the relayer, which runs on a different machine than the validators — local disk storage doesn't work for this. Cloudflare R2 was tried first and abandoned after a real, reproduced upstream compatibility bug in Hyperlane's validator binary; see `docs/self-hosted-validator-setup.md` |

## Why not Fly Managed Postgres (MPG)

`flyctl mpg create` looks like the obvious choice but its connection
string only resolves inside Fly's private WireGuard network
(`*.flympg.net` doesn't have public DNS) — fine for Fly-to-Fly, useless
for Vercel. Used an **unmanaged** Fly Postgres app instead
(`flyctl postgres create`), which is a real Fly app you can attach a
public IP and a plain TCP service to:

1. `flyctl ips allocate-v4 -a anc-hor-db --yes` — a **dedicated** IP,
   not `--shared`; shared IPv4s on Fly are HTTP(S)-only (SNI-routed) and
   silently refuse raw TCP protocols like Postgres.
2. Edited the app's `fly.toml` service block for port 5432 to drop the
   `handlers = ['pg_tls']` entry (that handler is for Fly's own internal
   proxying, not a real external TLS endpoint) — now a plain TCP
   passthrough.
3. Postgres itself ships with `ssl = off` by default on this image.
   Generated a self-signed cert on the running machine
   (`openssl req -new -x509 ...` via `flyctl ssh console`) and flipped
   `ssl = on` in `postgresql.conf`, so the connection is still genuinely
   TLS end-to-end, not plaintext.

This is a real security tradeoff (a self-signed cert, no cert pinning on
the client side) worth revisiting if this stops being a prototype —
Neon/Supabase's managed public-Postgres offerings solve this properly out
of the box, at the cost of not being "Fly for backend."

## Redeploying

**Web app (Vercel)** — from the repo root:
```bash
vercel deploy --prod --yes
```
`vercel.json` at the repo root is what makes this work in an npm-workspaces
monorepo: `installCommand` runs at the repo root (so `@anchor/hyperlane-relay`
resolves as a workspace symlink instead of 404ing against the public
registry), and `buildCommand` explicitly runs `npx prisma generate` before
`next build` — Vercel's own `npm install` silently skips Prisma's
postinstall script (some other dependency's `allow-scripts` guard blocks
it), so without this the build ships a Prisma Client with no real types
and every query result silently types as `any`.

**Worker (Fly)** — also from the repo root (build context has to be root
so the Dockerfile can `COPY` sibling workspace packages):
```bash
flyctl deploy -a anc-hor-worker --config fly.worker.toml --dockerfile apps/web/Dockerfile.worker -y
```

**Relayer (Fly)** — from `chains/hyperlane-relayer/` (self-contained,
no workspace deps):
```bash
cd chains/hyperlane-relayer
flyctl deploy -a anc-hor-relayer --config fly.toml -y
```
Remember to update `entrypoint.sh`'s `WHITELIST` to the current live
`DecisionRelay`/`decision-relay` addresses after any contract redeploy —
a stale whitelist means the relayer silently never attempts delivery to
the new address (a real bug hit and fixed during the M-of-N/ISM
hardening work).

**Validators (Fly)** — from `chains/hyperlane-validator/`, one deploy
per validator app:
```bash
cd chains/hyperlane-validator
flyctl deploy -a anc-hor-validator1 --config fly.validator1.toml
flyctl deploy -a anc-hor-validator2 --config fly.validator2.toml
```
**Real Fly quirk**: these apps have no `[http_service]` block, so a
config-only deploy (secrets update without an image change) leaves the
machine `stopped` instead of restarting it — always follow with:
```bash
flyctl machine start <machine-id> -a <app-name>
```
Check `flyctl status -a <app-name>` after any deploy to confirm the
machine is actually `started`, not just that the deploy command
succeeded.

## Secrets

Never in the Dockerfiles or fly.toml files — set via `flyctl secrets set
-a <app> KEY=value` (worker/relayer) or `vercel env add KEY production
--value ... -y` (web). See `apps/web/.env.example` for the full list of
keys each needs; the worker and relayer only need a subset (no
`CLOUDINARY_*`/`BREVO_*` — those are web-only, used by API routes the
worker/relayer never call).

## What's still local-only

The pre-existing local Docker Postgres/Redis/relayer setup documented in
`README.md` and `chains/hyperlane-relayer/README.md` still works
unchanged for local dev — this deployment is additive, not a replacement
for local development.
