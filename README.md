# SiteGraph for EmDash

A map of how your EmDash site fits together. SiteGraph reads your published entries and the
internal links between them, lets you add what the CMS can't see (the form that feeds your CRM,
the workflow a page belongs to, who owns it), and answers one question before you change
something: **what else depends on this?**

- **Graph explorer.** Search any entry, URL, form or service and expand outward from it.
  A table view shows the same connections for keyboard and screen-reader users.
- **Broken internal links.** A link to a path where no published entry lives is flagged.
- **Change impact.** Up to 3 steps out, with the exact path for each result, split into
  confirmed connections and ones that rely on a guess.
- **Your own notes.** Purpose, criticality, maintenance notes, a runbook link and a
  "last checked" date on anything in the graph. Rescans never overwrite them.
- **Stays current.** After the first scan, saving, publishing, unpublishing or deleting an
  entry updates just that entry's part of the map.
- **JSON export** of the whole graph.

Every connection says where it came from: **found by scan** (solid line), **added by a person**
(dashed). SiteGraph never presents a guess as a fact, and impact is "potential impact", not proof.

Requires EmDash 1.2.0 or later.

## Install

SiteGraph is a **native** plugin, so it's installed from npm and registered in your Astro
config. It isn't in the EmDash plugin registry.

```bash
pnpm add emdash-plugin-sitegraph
```

```js
// astro.config.mjs
import { siteGraph } from "emdash-plugin-sitegraph";

export default defineConfig({
	integrations: [
		emdash({
			plugins: [siteGraph()],
		}),
	],
});
```

Rebuild and deploy, then open **SiteGraph** in the admin sidebar and choose **Scan site**.

Set your site URL in EmDash's settings. Without it, only relative links (like `/about`) are
recognised as internal.

## Why native, and what it can do

The interactive graph is a custom React admin page, and only native plugins can ship one.
Native plugins run inside your site's process, without the sandbox's isolation, so install
them only from publishers you trust. SiteGraph keeps its footprint small on purpose:

| Capability | Used for |
|---|---|
| `content:read` | Reading published entries to find their links |
| `schema:read` | Reading collection URL patterns, title fields and `url` fields |

It never writes to your content, makes no network requests (links are parsed, never
fetched), and stores its graph in its own plugin storage. Viewing the graph needs the
`plugins:read` permission (Editors and up). Scanning and editing it needs `plugins:manage`
(Admins).

## Limits worth knowing

- Links are found in rich text and `url` fields. **Reference fields aren't mapped yet**,
  because EmDash doesn't expose them to plugins.
- Collections whose URL pattern uses date or locale tokens are mapped as entries, but
  without a URL.
- Search matches from the start of a name or path ("pric" finds "Pricing", "ing" doesn't).
- The graph shows a neighbourhood at a time, not the whole site, so large sites stay usable.

## Develop

```bash
pnpm install
pnpm test        # Vitest: graph logic and scan behaviour
pnpm typecheck
pnpm build       # server entry → dist/; the admin ships as source
```

See `SPEC.md` for the design decisions and why they were made.

## License

MIT
