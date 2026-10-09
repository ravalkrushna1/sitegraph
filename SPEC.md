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
| D1a | **Hand-rolled SVG graph canvas, not React Flow** | React Flow depends on zustand, which imports `use-sync-external-store/shim/with-selector` by default export. EmDash aliases that module to a shim without one, and Vite's dep optimiser then breaks the *whole* admin. Our layout is our own anyway; pan/zoom/drag/fit is ~200 lines with no dependency. |
| D2 | Free. No pricing, accounts or SaaS | EmDash has no paid-plugin support; revisit only if it does. |
| D3 | **Read-only discovery** — no `content:write`, no network capability | Must be safe to run on production. Native code isn't isolated, so we hold ourselves to it. Links are parsed from stored content, never fetched (no SSRF). |
| D4 | **Provenance on every edge**: `DISCOVERED` / `DOCUMENTED` / `INFERRED` + evidence | A dependency map that presents guesses as facts is worse than none. |
| D5 | `INFERRED` exists in the data model, but nothing in v1 produces it and there's no UI for it | No inference source yet. Keeping the enum avoids a data migration when one arrives. |
| D6 | Impact = bounded BFS: depth ≤ 3, ≤ 500 nodes / 1,000 edges, cycle-safe, returns the path per result | Reachability is not causation; the UI says "potential impact". Caps keep responses fast on big sites. |
| D7 | Scans are batched and resumable; stale discovered edges retire only after a **successful full scan**; documented edges are never touched by scans | A partial or failed scan must never wipe the graph. |
| D8 | Hooks refresh only the one entry that changed (save, publish, restore → refresh; unpublish, delete → retire). They never scan the site | One entry is a handful of storage calls and `afterSave` runs after the response, so saves stay fast. This made a cron/dirty queue unnecessary. A failed hook is repaired by the next full scan. |
| D9 | Platform-neutral `src/domain/` (no EmDash/React imports); everything else stays flat | The one boundary that pays for a future WordPress adapter. The brief's ~150-file, 3-layer tree is cut: no repository classes, one routes file, files split only when they grow. |
| D10 | The graph view expands outward from a chosen node; it never renders the whole site. A table shows the same data accessibly | Big graphs are unreadable and slow; keyboard and screen-reader users need the table. |
| D6a | Relations carry a dependency direction: "source depends on target", except PART_OF (the whole depends on its part) and RELATED_TO (both ways). PUBLISHES_AS costs no step | "What depends on HubSpot?" must reach the form, the page it's part of, and pages linking there. Raw edge direction got this wrong. |
| D12 | A URL's status is recomputed from its current inbound edges (`settleUrl`), never carried over: a published entry there → page; looks like an entry path (fits a routable collection's pattern, no file extension) → **broken**; otherwise → other page (home, listings, feeds), never counted as broken; nothing points at it → removed. Query strings and fragments aren't part of a URL's identity | Carrying the flag over hid real 404s after a slug change and flagged `/`, `/rss.xml` and `?ref=` links as broken. A full scan settles every URL, so a missed hook is always repaired. |
| D13 | Entries in a non-default locale are mapped without a URL | EmDash adds locale prefixes we don't reproduce; guessing collided translations onto one path. |
| D14 | Scan steps carry the scan ID and write their state compare-and-set; a scan with no step for 2 minutes can be replaced; a collection that fails to list is recorded and skipped | A reload, a second admin or a deleted collection must not corrupt a scan or leave it stuck. |
| D11 | Package `emdash-plugin-sitegraph`, plugin ID `sitegraph`, public repo `ravalkrushna1/sitegraph` | Unscoped ID fits the route URL segment; the npm name is free. |

## v1 scope

| Module | In v1 | Deferred |
|---|---|---|
| Scan | Published entries → `CONTENT` + `URL` nodes, `PUBLISHES_AS`; links in rich text and reference fields → `LINKS_TO`. Batched, resumable, dirty-marking hooks, safe reconciliation | — |
| Documented graph | `FORM`, `SERVICE`, `WORKFLOW`, `TEAM_MEMBER` nodes; `SUBMITS_TO`, `DEPENDS_ON`, `PART_OF`, `OWNED_BY`, `RELATED_TO` (labelled) edges; description, criticality, owner, notes, last-verified | `CUSTOM` nodes, annotation edit history |
| Explorer | SVG canvas (D1a), search (prefix), type + broken-link filters, node detail panel, double-click to expand; accessible table; dashboard widget with the broken-link count | Relation/provenance filters |
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
| Background work | Cron hook, default 5 s timeout (overridable); no `after()` in routes | Scan = one batch per call. "Scan site" in the UI calls the step route until done; progress lives in `ctx.kv`. No cron needed (D8) |
| Testing | `@emdash-cms/plugin-test` is sandbox-only; core's native plugins use plain Vitest with a fake `ctx` | Pure `domain/` tests + an in-memory storage fake; the real check is the playground site |
| Admin | No graph library in the admin; CSP allows inline styles; admin Tailwind is prebuilt (unused classes don't exist); `use-sync-external-store` is aliased to a shim | Own SVG canvas (D1a); Kumo components plus our own `.sg-*` CSS on Kumo tokens |
| Permissions | `plugins:read` = Editor, `plugins:manage` = Admin | Read routes: `plugins:read`. Editing documented nodes/edges and scans: `plugins:manage` |
