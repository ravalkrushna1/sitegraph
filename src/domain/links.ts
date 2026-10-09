// Link discovery over stored content. Parses only; never fetches anything (SPEC D3).

export interface FoundLink {
	href: string;
	/** Top-level field the link lives in; part of the edge identity. */
	field: string;
	/** Full JSON path, kept as evidence. */
	path: string;
}

const MAX_DEPTH = 32;
const UNSAFE_SCHEME = /^\s*(javascript|data|vbscript|file|mailto|tel):/i;

/**
 * Find links in an entry's data: Portable Text link marks (`{_type: "link", href}`)
 * anywhere in the tree, plus the values of the given `url`-type fields.
 * Plain strings that merely look like URLs are ignored on purpose.
 */
export function extractLinks(
	data: Record<string, unknown>,
	urlFields: readonly string[] = [],
): FoundLink[] {
	const found: FoundLink[] = [];

	for (const field of urlFields) {
		const value = data[field];
		if (typeof value === "string" && value.trim()) found.push({ href: value.trim(), field, path: field });
	}

	const walk = (value: unknown, field: string, path: string, depth: number): void => {
		if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
		if (Array.isArray(value)) {
			value.forEach((item, i) => walk(item, field, `${path}[${i}]`, depth + 1));
			return;
		}
		const obj = value as Record<string, unknown>;
		if (obj._type === "link" && typeof obj.href === "string" && obj.href.trim()) {
			found.push({ href: obj.href.trim(), field, path });
		}
		for (const [key, child] of Object.entries(obj)) walk(child, field, `${path}.${key}`, depth + 1);
	};
	for (const [field, value] of Object.entries(data)) walk(value, field, field, 0);

	return found;
}

/**
 * Turn an href into the site-relative path that identifies a page, or null when the
 * link is external, unsafe or not a page link. Fragments are dropped; the query is
 * kept; trailing slashes are ignored so "/a/" and "/a" are the same page.
 */
export function internalPath(href: string, sourcePath: string, siteUrl: string): string | null {
	if (UNSAFE_SCHEME.test(href) || href.trim().startsWith("#")) return null;
	// Relative links resolve against the source page; a placeholder origin stands in when
	// the site URL isn't configured, and then only relative links can be internal.
	const origin = siteUrl ? new URL(siteUrl).origin : "http://sitegraph.invalid";
	let url: URL;
	try {
		url = new URL(href, new URL(sourcePath || "/", origin));
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (url.origin !== origin) return null;
	let path = url.pathname.replace(/\/{2,}/g, "/");
	if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
	return path + url.search;
}

/**
 * The public path of an entry from its collection's URL pattern, mirroring EmDash's
 * `interpolateUrlPattern` for `{slug}` and `{id}`. Returns null for patterns using
 * tokens we don't resolve (dates, locales), so we never invent a wrong URL.
 */
export function entryPath(
	pattern: string | null,
	collection: string,
	slug: string,
	id: string,
): string | null {
	const base = pattern ?? `/${encodeURIComponent(collection)}/{slug}`;
	let path = base.replaceAll("{slug}", encodeURIComponent(slug)).replaceAll("{id}", encodeURIComponent(id));
	if (path.includes("{")) return null;
	path = path.replace(/\/{2,}/g, "/");
	if (!path.startsWith("/")) path = `/${path}`;
	if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
	return path;
}
