# SiteGraph for EmDash

A map of how your EmDash site fits together: pages, internal links, and the forms and services
your CMS can't see. It flags broken internal links and answers "what depends on this?" before
you change something.

SiteGraph comes in two editions:

| | [SiteGraph](native/) | [SiteGraph Lite](lite/) |
|---|---|---|
| Install | npm: `pnpm add emdash-plugin-sitegraph` + one line in `astro.config.mjs` | One click from EmDash's plugin registry |
| Plugin format | Native (runs in your site's process) | Sandboxed (isolated, with a permission prompt) |
| Interactive graph | Yes | No, connections are shown as lists and tables |
| Broken links, impact check, documenting forms/services/owners, live updates | Yes | Yes |

Why two? The interactive graph needs a custom React admin page, which only native plugins can
ship, and EmDash's registry only accepts sandboxed plugins. Both editions share the same graph
rules (`native/src/domain/`), so they always agree on what's broken and what depends on what.

- `native/`: the npm package, published as [`emdash-plugin-sitegraph`](https://www.npmjs.com/package/emdash-plugin-sitegraph)
- `lite/`: the registry plugin
- `SPEC.md`: design decisions and why they were made

MIT licensed.
