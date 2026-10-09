# SiteGraph — Spec

A living dependency map for an EmDash site. It discovers content entries, their public
URLs and the internal links between them, lets people document what the CMS can't see
(forms, external services, workflows, owners), and answers "if I change this, what might
be affected?" with the evidence for every step.

Source brief: *SiteGraph — Full Product & Implementation Guide* v1.0 (2026-10-09). This
file records what was decided from it and why. Where they disagree, this file wins.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Native plugin**, distributed on npm, registered in `astro.config.mjs` | The interactive graph is the product. Sandboxed Block Kit's chart block only registers ECharts Bar/Line/Pie (`packages/blocks/src/blocks/chart.tsx:2`), so no node-graph canvas is possible sandboxed. Cost: not registry-installable, users must `pnpm add` + edit config. Target users are agency developers, who can. |
| D2 | Free. No pricing, accounts or SaaS | EmDash has no paid-plugin support; revisit only if it does. |
| D3 | **Read-only discovery** — no `content:write`, no network capability | Must be safe to run on production. Native code isn't isolated, so we hold ourselves to it. Links are parsed from stored content, never fetched (no SSRF). |
| D4 | **Provenance on every edge**: `DISCOVERED` / `DOCUMENTED` / `INFERRED` + evidence | A dependency map that presents guesses as facts is worse than none. |
| D5 | `INFERRED` exists in the data model, but nothing in v1 produces it and there's no UI for it | No inference source yet. Keeping the enum avoids a data migration when one arrives. |
| D6 | Impact = bounded BFS: depth ≤ 3, ≤ 500 nodes / 1,000 edges, cycle-safe, returns the path per result | Reachability is not causation; the UI says "potential impact". Caps keep responses fast on big sites. |
| D7 | Scans are batched and resumable; stale discovered edges retire only after a **successful full scan**; documented edges are never touched by scans | A partial or failed scan must never wipe the graph. |
| D8 | Save hooks only mark entries dirty; they never scan | Content saves must stay fast. |
| D9 | Platform-neutral `src/domain/` (no EmDash/React imports); everything else stays flat | The one boundary that pays for a future WordPress adapter. The brief's ~150-file, 3-layer tree is cut: no repository classes, one routes file, files split only when they grow. |
| D10 | The graph view expands outward from a chosen node; it never renders the whole site. A table shows the same data accessibly | Big graphs are unreadable and slow; keyboard and screen-reader users need the table. |
| D11 | Package `emdash-plugin-sitegraph`, plugin ID `sitegraph`, public repo `ravalkrushna1/sitegraph` | Unscoped ID fits the route URL segment; the npm name is free. |

## v1 scope

| Module | In v1 | Deferred |
|---|---|---|
| Scan | Published entries → `CONTENT` + `URL` nodes, `PUBLISHES_AS`; links in rich text and reference fields → `LINKS_TO`. Batched, resumable, dirty-marking hooks, safe reconciliation | — |
| Documented graph | `FORM`, `SERVICE`, `WORKFLOW`, `TEAM_MEMBER` nodes; `SUBMITS_TO`, `DEPENDS_ON`, `PART_OF`, `OWNED_BY`, `RELATED_TO` (labelled) edges; description, criticality, owner, notes, last-verified | `CUSTOM` nodes, annotation edit history |
| Explorer | React Flow canvas, search, filters (type / relation / provenance), node detail panel, progressive expansion; accessible table | — |
| Impact | Inbound / outbound / both, depth 1–3, paths with evidence, grouped by provenance | Business-language summary |
| Export | JSON (schema-versioned) | CSV, import, snapshots + compare |

## Platform facts (EmDash core 1.2.0, checked against source 2026-10-09)

These shaped the design. Re-check them when bumping the EmDash peer version.

| Area | Fact | Consequence for SiteGraph |
|---|---|---|
| Rich-text links | Portable Text `markDefs` of `{_type: "link", href}`. **No mark links to an entry by ID**, only by URL | Internal = relative `href`, or absolute with origin `ctx.site.url`. Resolve the path to an entry by matching each collection's `urlPattern`. An internal link that resolves to nothing is a **broken link** — shown as a `URL` node with no `CONTENT` behind it |
| Other link carriers | `url` fields, and links nested in `blocks` / `repeater` JSON | Walk entry `data` recursively; record the JSON path as evidence |
| Reference fields | Bound references live in `_emdash_content_references`; **`ctx.content` doesn't return them** and `ctx` has no relations API | v1 covers links only. Reference edges via exported `getEmDashReferences()` is a spike after v1 works |
| Public URLs | `getPublicUrl()` costs 2 queries per entry, returns null if `site.url` is empty | Build URLs ourselves from `urlPattern` + slug during scans |
| Content listing | `ctx.content.list` max 100 per page, cursor-based; `schema:read` gives collections, `urlPattern`, `routable`, fields | Capabilities: `content:read`, `schema:read`. Nothing else |
| Storage | `put` is an upsert; `query` only on indexed fields, max 100; `in`, ranges, `startsWith`; `deleteMany` | One document per node and per edge (deterministic IDs ⇒ idempotent rescans) |
| Background work | Cron hook, default 5 s timeout (overridable); no `after()` in routes | Scan = one batch per call. "Scan now" in the UI calls the batch route until done; cron drains dirty entries. Progress in `ctx.kv` |
| Testing | `@emdash-cms/plugin-test` is sandbox-only; core's native plugins use plain Vitest with a fake `ctx` | Pure `domain/` tests + an in-memory storage fake; the real check is the playground site |
| Admin | No graph library in the admin; CSP allows inline styles; admin Tailwind is prebuilt (unused classes don't exist) | Bundle `@xyflow/react`; style with Kumo components and our own scoped CSS |
| Permissions | `plugins:read` = Editor, `plugins:manage` = Admin | Read routes: `plugins:read`. Editing documented nodes/edges and scans: `plugins:manage` |
