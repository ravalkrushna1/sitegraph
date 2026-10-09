# SiteGraph

Two editions of one EmDash plugin. Decisions and their reasons live in `SPEC.md`; read it
before changing behaviour.

| Folder | Edition | Distribution | Plugin ID |
|---|---|---|---|
| `native/` | SiteGraph: React admin with an interactive graph | npm `emdash-plugin-sitegraph`, `plugins: [siteGraph()]` | `sitegraph` |
| `lite/` | SiteGraph Lite: Block Kit lists and tables | EmDash registry `sitegraph-lite`, `sandboxed: [...]` | `sitegraph-lite` |

## Build, test, run

Each folder is its own pnpm package; run commands inside it.

```bash
# native/
pnpm test        # Vitest, plain node: domain, scan (fake ctx), layout
pnpm typecheck   # covers the admin .tsx too
pnpm build       # tsdown: src/index.ts → dist/. The admin ships as source, compiled by the host

# lite/
pnpm test        # emdash-plugin validate + Vitest inside the real workerd sandbox
pnpm typecheck
pnpm run build   # emdash-plugin build → dist/plugin.mjs (bundles the shared code from native/)
pnpm run bundle  # registry tarball; caps: 256 KB decompressed, 128 KB per file
```

Manual testing uses `~/Projects/typographer-playground` (Node adapter, SQLite). It has native
SiteGraph as `link:../sitegraph/native` and Lite as `file:../sitegraph/lite` (a copy). Start it
with `pnpm dev --port 4321`; Astro 7 runs dev detached (`pnpm exec astro dev stop|logs`).
Test posts are titled "SiteGraph test: …".

## Architecture

- **Shared code lives in `native/src/` and is imported by Lite**: `domain/` (graph types, link
  rules, impact BFS, labels), `scan.ts` (discovery, hooks, resumable scan), `store.ts`,
  `graph-service.ts` (every graph operation). These import only *types* from `emdash`.
- Native: `routes.ts` validates with zod and calls the service; `admin/` is the React UI.
- Lite: `src/plugin.ts` parses admin interactions by hand and calls the service; `src/ui.ts`
  renders Block Kit. Pages: `/overview`, `/explore`, `/document`, widget `overview`.
- Node IDs are deterministic (`content:<collection>:<id>`, `url:<path>`, documented `doc:<uuid>`);
  edge IDs are `source|RELATION|target|field`, so rescans are idempotent.
- A URL's status is recomputed from its inbound edges (`settleUrl`), never carried over.

## Traps that already cost time

- **Never import a runtime value from `emdash` (or zod) in shared files.** The Lite bundle
  would pull in the native API. Throw `GraphError` / `ScanConflictError`; each edition maps them.
- **Don't add React Flow, zustand or anything using `use-sync-external-store/shim/with-selector`
  to native's admin.** EmDash aliases that module to a shim with no default export and the
  *entire* admin hangs on "Loading EmDash…". After any dependency change, `rm -rf node_modules/.vite`
  in the host.
- `astro` must stay a **peer** dependency of native, or tsdown bundles a private zod into `dist/`.
- Native server code runs from `dist/`: after changing `native/src/` run `pnpm build` **and
  restart** the host. Native admin `.tsx` hot-reloads.
- Lite is a `file:` dependency, so the playground holds a copy: after `pnpm run build` in
  `lite/`, run `pnpm install --force` in the playground, then restart.
- Registry page paths can't be `/`; Lite's main page is `/overview`.
- Sandboxed tests: EmDash runs after-save hooks *after* the response. Poll storage before
  asserting, or the test disposes the database under the running hook ("no such table").
- `ctx.content.list` caps at 100 and storage `query` filters only on declared indexes. A newly
  queried field must be added to `STORAGE` in `native/src/store.ts` **and** to
  `lite/emdash-plugin.jsonc` (a Lite trust-contract change: version bump).
- npm publishing (native) needs a real terminal for the 2FA browser step: run
  `npm publish --access public` in macOS Terminal, not through the agent.
- In dev the admin takes a few seconds to hydrate; clicks right after load do nothing.

## Release

- **Native:** bump `version` in `native/package.json` and `native/src/index.ts`, then
  `pnpm test && pnpm build`, then `npm publish --access public` from `native/` (in Terminal).
- **Lite:** bump `version` in `lite/package.json`, then `pnpm run validate && pnpm test && pnpm run bundle`,
  then `pnpm run login -- krushnaraval.bsky.social` (once) and `pnpm run publish`. Versions are immutable.
  Listing images live in `lite/images/` (icon source `icon.svg`).
