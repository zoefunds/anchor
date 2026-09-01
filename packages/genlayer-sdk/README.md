# @anchor/genlayer-sdk

A thin wrapper around GenLayer's own JS SDK (`genlayer-js`), scoped to
exactly what Anchor's backend needs: deploying/calling the
`adjudicator.py` Intelligent Contract, nothing more. Used by
`apps/web/src/lib/genlayer.ts`.

## Exports (`index.ts`)

- `GenLayerNetwork` — `"localnet" | "studionet" | "testnetAsimov" | "testnetBradbury"`,
  the same network names used throughout this repo (GenLayer CLI, gltest
  config, etc.).
- `GenLayerConfig` — connection config (network, RPC URL, private key)
  passed to `createGenLayerClient`.
- `DeployCaseParams`, `AdjudicateParams` — typed params for the two
  contract calls this SDK wraps.
- `AnchorGenLayerClient` — the interface `createGenLayerClient` returns:
  deploy a fresh `adjudicator.py` instance for a case, and call its
  `adjudicate()`/`appeal()` methods.
- `createGenLayerClient(config)` — the actual factory function. Wraps
  `genlayer-js`'s own client setup so callers never touch GenLayer's raw
  SDK directly, keeping every GenLayer-specific detail (network
  endpoints, transaction polling, ABI encoding of `evidence_json`) in
  one place.

See `../../genlayer/README.md` for the Intelligent Contract this talks
to, and `apps/web/src/lib/genlayer.ts` for how it's actually used inside
the adjudication pipeline (`apps/web/src/lib/adjudication-service.ts`).
