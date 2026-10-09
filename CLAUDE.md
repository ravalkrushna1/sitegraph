# SiteGraph

Native EmDash plugin (npm package `emdash-plugin-sitegraph`, plugin ID `sitegraph`). Decisions
and their reasons live in `SPEC.md`; read it before changing behaviour.

## Build, test, run

```bash
pnpm install
pnpm test        # Vitest, plain node: tests/domain.test.ts (pure) + tests/scan.test.ts (fake ctx)
pnpm typecheck   # tsc --noEmit, covers the admin .tsx too
pnpm build       # tsdown: src/index.ts → dist/index.mjs. The admin is NOT built; it ships as source
```

Manual testing uses the local site `~/Projects/typographer-playground` (Node adapter, SQLite).
It depends on this repo via `link:../sitegraph` and registers `siteGraph()` under
`plugins: [...]` in `astro.config.mjs`. Start it with `pnpm dev --port 4321`; Astro 7 runs dev
detached, so use `pnpm exec astro dev stop` / `astro dev logs`. Test posts are titled
"SiteGraph test: …".

## Architecture

- `src/domain/` is platform-neutral: no EmDash, React or storage imports. Graph types and IDs
  (`graph.ts`), link extraction and URL rules (`links.ts`), bounded impact BFS (`impact.ts`).
- `src/scan.ts` maps EmDash entries onto the graph. `refreshEntry` is the single path for
  both full scans and hooks; it merges over stored nodes so annotations survive.
- `src/routes.ts` holds every API route (all POST, zod input from `astro/zod`).
  `src/store.ts` holds the storage declaration and query helpers.
- `src/admin/` is the React admin, compiled by the host's Vite. All fetching goes through
  `api.ts`.
- Node IDs are deterministic (`content:<collection>:<id>`, `url:<path>`, documented nodes
  `doc:<uuid>`); edge IDs are `source|RELATION|target|field`. That makes rescans idempotent.
- A full scan is a KV-held state machine advanced one batch per `scan/step` call
  (collect → reconcile-nodes → reconcile-edges). Reconciliation retires DISCOVERED records
  whose `scanId` isn't the current scan, and is skipped if any entry failed.

## Traps that already cost time

- **Don't add React Flow, zustand or anything using `use-sync-external-store/shim/with-selector`
  to the admin.** EmDash aliases that module to a shim with no default export. Vite's dep
  optimiser then fails and the *entire* admin stays on "Loading EmDash…". The graph canvas is
  hand-rolled SVG for this reason. After any dependency change, `rm -rf node_modules/.vite` in
  the host.
- `astro` must stay a **peer** dependency. As a devDependency only, tsdown bundles a private
  zod (~190 KB) into `dist/`.
- Server code runs from `dist/`, so after changing `src/` (except the admin) run `pnpm build`
  **and restart** the host dev server. Admin `.tsx` edits hot-reload.
- `ctx.content.list` caps at 100 and storage `query` filters only on declared indexes. Adding a
  queried field means adding it to `STORAGE` in `src/store.ts`.
- The exported `ContentItem` type in `emdash` is the DB repository type, not the plugin one.
  `scan.ts` uses its own small `Entry` type.
- In dev the admin takes a few seconds to hydrate; clicks right after load do nothing.
- Impact direction is semantic: most relations mean "source depends on target", PART_OF is
  reversed, RELATED_TO goes both ways, PUBLISHES_AS is free (an entry and its URL are one
  page). See `follows()` in `impact.ts`.
