# SiteGraph Lite

Finds broken internal links on your EmDash site and shows what depends on a page before you
change it. Install it from EmDash's plugin registry; no code or config changes needed.

- **Broken links, with the page to fix.** Each row is a page that links somewhere nothing is
  published, with a button that opens that page in the editor. Links to your home page,
  listings and files are never counted as broken.
- **Explore.** Pick any page, URL or documented item to see what it links to, what links to
  it, and what it's part of.
- **Impact.** "If this changes, what could be affected?" up to 3 steps out, each with the
  exact reason, marked confirmed or guessed.
- **Document what your CMS can't see.** Forms, services like your CRM, workflows and the
  people who own them, and how they connect to your pages.
- **Stays current.** After one scan, saving, publishing, unpublishing or deleting an entry
  updates just that entry's part of the map.

## Permissions

| Capability | Used for |
|---|---|
| `content:read` | Reading published entries to find their links |
| `schema:read` | Reading collection URL patterns, title fields and `url` fields |

SiteGraph Lite never changes your content and makes no network requests: links are read from
stored content, never fetched. Its pages are for administrators.

## Want the interactive graph?

The registry only accepts sandboxed plugins, which can't draw custom graphics, so Lite shows
connections as lists. The full edition, [SiteGraph](../native/), adds a draggable visual graph
and installs from npm (`pnpm add emdash-plugin-sitegraph`). Both use the same rules.

## Limits

- Links are found in rich text and `url` fields; reference fields aren't mapped yet.
- Entries in a non-default language, and collections whose URL pattern uses date tokens, are
  mapped without a URL.
- Very large sites scan in the background in small batches; reload the page to see progress.

MIT licensed.
