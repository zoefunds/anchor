# Deployment

Live at **https://anc-hor.vercel.app** (Vercel) + three Fly.io apps for
everything that can't run as a Vercel serverless function.

## Layout

| Piece | Where | Why there |
|---|---|---|
| Next.js app (pages + `/api/*` routes) | Vercel project `anc-hor` | Serverless-friendly, zero-config Next.js hosting |
| Postgres | Fly app `anc-hor-db` (unmanaged `flyio/postgres-flex`) | Needs to be reachable from Vercel over the public internet — see "Why not Fly Managed Postgres" below |
| Redis (BullMQ job queue + rate limiting) | Upstash (`loving-cougar-198267.upstash.io`) | Already public/TLS by default, no extra networking work needed |
| Adjudication job worker | Fly app `anc-hor-worker` | Long-lived BullMQ Worker process — can't run inside a Vercel serverless function, which has no persistent process between invocations |
| Hyperlane relayer | Fly app `anc-hor-relayer` | Same reason — a long-lived Rust binary watching both chains continuously |

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
