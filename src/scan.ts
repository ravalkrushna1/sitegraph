// Discovery: turns published EmDash entries into CONTENT/URL nodes and PUBLISHES_AS/LINKS_TO edges.
// Read-only towards content (SPEC D3). Rescans are idempotent thanks to deterministic IDs.

import type { CollectionSchemaInfo, PluginContext } from "emdash";
import { PluginRouteError } from "emdash";

import {
	contentNodeId,
	edgeId,
	type GraphEdge,
	type GraphNode,
	SCHEMA_VERSION,
	urlNodeId,
} from "./domain/graph.js";
import { entryPath, entryPathMatcher, extractLinks, internalPath } from "./domain/links.js";
import { activeEdges, edgesOf, nodesOf, queryAll } from "./store.js";

/** The slice of a plugin-visible content item that discovery reads. */
interface Entry {
	id: string;
	slug: string | null;
	status: string;
	locale?: string | null;
	data: Record<string, unknown>;
}

export interface CollectionPlan {
	slug: string;
	label: string;
	pattern: string | null;
	routable: boolean;
	titleField: string | null;
	urlFields: string[];
}

export interface ScanState {
	id: string;
	startedAt: string;
	/** Heartbeat: a scan nobody has advanced for a while can be replaced. */
	updatedAt: string;
	phase: "collect" | "reconcile-edges" | "reconcile-nodes";
	collections: CollectionPlan[];
	index: number;
	cursor?: string;
	processed: number;
	retired: number;
	errors: string[];
}

export interface LastScan {
	id: string;
	startedAt: string;
	finishedAt: string;
	status: "SUCCEEDED" | "PARTIAL";
	processed: number;
	retired: number;
	errors: string[];
}

const SCAN_KEY = "scan";
const LAST_SCAN_KEY = "lastScan";
const BATCH = 25;
const STALE_AFTER_MS = 2 * 60 * 1000;
const MAX_ERRORS = 20;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function collectionPlans(ctx: PluginContext): Promise<CollectionPlan[]> {
	const collections: CollectionSchemaInfo[] = (await ctx.schema?.listCollections()) ?? [];
	return collections.map((c) => ({
		slug: c.slug,
		label: c.labelSingular ?? c.label,
		pattern: c.urlPattern,
		routable: c.routable,
		titleField: c.titleField,
		urlFields: c.fields.filter((f) => f.type === "url").map((f) => f.slug),
	}));
}

/**
 * Could an entry live at this path? Yes when it fits a routable collection's URL pattern and
 * doesn't look like a file. A link to such a path with no entry behind it is broken; a link
 * to anything else (home page, listings, feeds) points at a page we simply don't map.
 */
export function looksLikeEntryPath(path: string, plans: CollectionPlan[]): boolean {
	const last = path.slice(path.lastIndexOf("/") + 1);
	if (last.includes(".")) return false;
	return plans.some((p) => p.routable && entryPathMatcher(p.pattern, p.slug)?.test(path));
}

function entryLabel(item: Entry, plan: CollectionPlan): string {
	const title = plan.titleField ? item.data[plan.titleField] : item.data.title;
	if (typeof title === "string" && title.trim()) return title.trim().slice(0, 200);
	return item.slug ?? item.id;
}

/** A discovered node merged over what's stored, so human annotations and firstSeenAt survive. */
function discoveredNode(
	existing: GraphNode | undefined,
	fresh: Pick<GraphNode, "type" | "label" | "ref"> & Partial<GraphNode>,
	now: string,
	scanId: string,
): GraphNode & { scanId: string } {
	return {
		...existing,
		...fresh,
		search: fresh.label.toLowerCase(),
		provenance: "DISCOVERED",
		active: true,
		firstSeenAt: existing?.firstSeenAt ?? now,
		lastSeenAt: now,
		schemaVersion: SCHEMA_VERSION,
		scanId,
	};
}

/**
 * Recompute a URL node's status from the edges that point at it, the single source of truth:
 * a published entry there → resolved; otherwise broken if it looks like an entry path, or
 * unknown if not; and with nothing pointing at it at all, it leaves the map.
 */
export async function settleUrl(ctx: PluginContext, plans: CollectionPlan[], nodeId: string): Promise<boolean> {
	const nodes = nodesOf(ctx);
	const node = await nodes.get(nodeId);
	if (!node || node.type !== "URL" || node.provenance !== "DISCOVERED") return false;
	const inbound = await activeEdges(ctx, [nodeId], "inbound", 50);
	const hasPage = inbound.some((e) => e.relation === "PUBLISHES_AS");
	const next = { ...node };
	if (!hasPage && inbound.length === 0) next.active = false;
	else if (hasPage) next.resolved = true;
	else if (looksLikeEntryPath(node.ref, plans)) next.resolved = false;
	else delete next.resolved;
	if (next.active === node.active && next.resolved === node.resolved) return false;
	await nodes.put(nodeId, next);
	return true;
}

/**
 * Re-read one entry's graph: its CONTENT node, its URL, and its outgoing links. Outgoing
 * discovered edges it no longer has are retired; that's safe because the entry was read whole.
 * `settle` recomputes the touched URLs right away (hooks); a full scan settles them at the end.
 */
export async function refreshEntry(
	ctx: PluginContext,
	plans: CollectionPlan[],
	plan: CollectionPlan,
	item: Entry,
	scanId: string,
	settle: boolean,
): Promise<void> {
	if (item.status !== "published") return retireEntry(ctx, plans, plan.slug, item.id);

	const now = new Date().toISOString();
	const nodes = nodesOf(ctx);
	const edges = edgesOf(ctx);
	const contentId = contentNodeId(plan.slug, item.id);
	// Translations are mapped as entries without a URL: we don't reproduce EmDash's locale
	// prefixes, and guessing would collide translations onto one path (see README limits).
	const isDefaultLocale = !item.locale || item.locale === ctx.site.locale;
	const path =
		plan.routable && item.slug && isDefaultLocale ? entryPath(plan.pattern, plan.slug, item.slug, item.id) : null;

	const links = extractLinks(item.data, plan.urlFields).flatMap((link) => {
		const target = internalPath(link.href, path ?? "/", ctx.site.url);
		return target && target !== path ? [{ ...link, target }] : [];
	});

	const nodeIds = [contentId, ...(path ? [urlNodeId(path)] : []), ...links.map((l) => urlNodeId(l.target))];
	const existing = await nodes.getMany([...new Set(nodeIds)]);

	const nodeDocs = new Map<string, GraphNode>();
	nodeDocs.set(
		contentId,
		discoveredNode(existing.get(contentId), { type: "CONTENT", label: entryLabel(item, plan), ref: `${plan.slug}/${item.id}` }, now, scanId),
	);
	if (path) {
		nodeDocs.set(urlNodeId(path), discoveredNode(existing.get(urlNodeId(path)), { type: "URL", label: path, ref: path, resolved: true }, now, scanId));
	}
	for (const link of links) {
		const id = urlNodeId(link.target);
		if (nodeDocs.has(id)) continue;
		const prior = existing.get(id);
		// A first guess for brand-new URLs; settleUrl has the final word.
		const resolved = prior?.active ? prior.resolved : looksLikeEntryPath(link.target, plans) ? false : undefined;
		const doc = discoveredNode(prior, { type: "URL", label: link.target, ref: link.target }, now, scanId);
		if (resolved === undefined) delete doc.resolved;
		else doc.resolved = resolved;
		nodeDocs.set(id, doc);
	}

	const edgeDocs = new Map<string, GraphEdge>();
	const edge = (source: string, relation: GraphEdge["relation"], target: string, field: string, evidence: GraphEdge["evidence"]) => {
		edgeDocs.set(edgeId(source, relation, target, field), {
			sourceNodeId: source,
			targetNodeId: target,
			relation,
			provenance: "DISCOVERED",
			evidence: { sourceId: `${plan.slug}/${item.id}`, observedAt: now, ...evidence },
			active: true,
			scanId,
			firstSeenAt: now,
			lastSeenAt: now,
			schemaVersion: SCHEMA_VERSION,
		});
	};
	if (path) edge(contentId, "PUBLISHES_AS", urlNodeId(path), "", { href: path });
	for (const link of links) edge(contentId, "LINKS_TO", urlNodeId(link.target), link.field, { fieldPath: link.path, href: link.href });

	const previous = await queryAll(edges, { sourceNodeId: contentId, provenance: "DISCOVERED" });
	const prevById = new Map(previous.map((p) => [p.id, p.data]));
	for (const [id, doc] of edgeDocs) {
		const first = prevById.get(id)?.firstSeenAt;
		if (first) doc.firstSeenAt = first;
	}
	const stale = previous.filter((p) => p.data.active && !edgeDocs.has(p.id));

	await nodes.putMany([...nodeDocs].map(([id, data]) => ({ id, data })));
	await edges.putMany([
		...[...edgeDocs].map(([id, data]) => ({ id, data })),
		...stale.map((p) => ({ id: p.id, data: { ...p.data, active: false } })),
	]);

	if (settle) {
		// A renamed slug or a removed link changes the status of the URLs left behind.
		const touched = new Set([...stale.map((e) => e.data.targetNodeId), ...links.map((l) => urlNodeId(l.target))]);
		for (const id of touched) await settleUrl(ctx, plans, id);
	}
}

/** An entry left the published site: hide its node and links, then re-settle the URLs it touched. */
export async function retireEntry(ctx: PluginContext, plans: CollectionPlan[], collection: string, entryId: string): Promise<void> {
	const nodes = nodesOf(ctx);
	const edges = edgesOf(ctx);
	const contentId = contentNodeId(collection, entryId);
	const outgoing = (await queryAll(edges, { sourceNodeId: contentId, provenance: "DISCOVERED" })).filter((e) => e.data.active);
	await edges.putMany(outgoing.map((e) => ({ id: e.id, data: { ...e.data, active: false } })));
	const content = await nodes.get(contentId);
	if (content?.active) await nodes.put(contentId, { ...content, active: false });
	for (const id of new Set(outgoing.map((e) => e.data.targetNodeId))) await settleUrl(ctx, plans, id);
}

/** Refresh one entry from a content hook. Never scans the site (SPEC D8). */
export async function refreshFromHook(ctx: PluginContext, collection: string, entryId: string): Promise<void> {
	const plans = await collectionPlans(ctx);
	const plan = plans.find((p) => p.slug === collection);
	if (!plan) return;
	const item = await ctx.content?.get(collection, entryId);
	if (!item) return retireEntry(ctx, plans, collection, entryId);
	const running = await ctx.kv.get<ScanState>(SCAN_KEY);
	await refreshEntry(ctx, plans, plan, item, running?.id ?? "hook", true);
}

export async function retireFromHook(ctx: PluginContext, collection: string, entryId: string): Promise<void> {
	await retireEntry(ctx, await collectionPlans(ctx), collection, entryId);
}

export async function getScanStatus(ctx: PluginContext): Promise<{ running: ScanState | null; last: LastScan | null }> {
	return {
		running: await ctx.kv.get<ScanState>(SCAN_KEY),
		last: await ctx.kv.get<LastScan>(LAST_SCAN_KEY),
	};
}

/** Start a scan, or join the one in progress (two admins clicking at once share it). */
export async function startScan(ctx: PluginContext): Promise<ScanState> {
	const running = await ctx.kv.get<ScanState>(SCAN_KEY);
	if (running && Date.now() - Date.parse(running.updatedAt ?? running.startedAt) < STALE_AFTER_MS) return running;
	const now = new Date().toISOString();
	const state: ScanState = {
		id: `scan_${crypto.randomUUID()}`,
		startedAt: now,
		updatedAt: now,
		phase: "collect",
		collections: await collectionPlans(ctx),
		index: 0,
		processed: 0,
		retired: 0,
		errors: [],
	};
	await ctx.kv.set(SCAN_KEY, state);
	return state;
}

/**
 * Advance scan `scanId` by one bounded batch. The admin calls this until `done`, so no single
 * request runs long. Reconciliation runs only after every collection was read cleanly, so a
 * failed or abandoned scan never retires anything (SPEC D7). Writes are compare-and-set: if
 * another tab advanced the scan meanwhile, this step's state is dropped instead of rolling
 * theirs back (the work it did is idempotent).
 */
export async function scanStep(
	ctx: PluginContext,
	scanId: string,
): Promise<{ state: ScanState | null; last: LastScan | null; done: boolean }> {
	const versioned = await ctx.kv.getVersioned<ScanState>(SCAN_KEY);
	const state = versioned?.value;
	if (!state) return { state: null, last: await ctx.kv.get<LastScan>(LAST_SCAN_KEY), done: true };
	if (state.id !== scanId) throw PluginRouteError.conflict("A newer scan replaced this one. Reload to follow it.");
	const plans = state.collections;

	if (state.phase === "collect") {
		const plan = plans[state.index];
		if (!plan) {
			state.phase = "reconcile-edges";
			state.cursor = undefined;
		} else {
			try {
				const page = await ctx.content!.list(plan.slug, { limit: BATCH, cursor: state.cursor, where: { status: "published" } });
				for (const item of page.items) {
					try {
						await refreshEntry(ctx, plans, plan, item, state.id, false);
						state.processed++;
					} catch (error) {
						if (state.errors.length < MAX_ERRORS) state.errors.push(`${plan.slug}/${item.id}: ${errorText(error)}`);
					}
				}
				if (page.hasMore && page.cursor) state.cursor = page.cursor;
				else {
					state.index++;
					state.cursor = undefined;
				}
			} catch (error) {
				// The whole collection couldn't be listed (e.g. deleted mid-scan): note it and move on.
				if (state.errors.length < MAX_ERRORS) state.errors.push(`${plan.slug}: ${errorText(error)}`);
				state.index++;
				state.cursor = undefined;
			}
		}
	} else if (state.errors.length) {
		// Failed entries' links weren't seen, so reconciling would wrongly retire them.
		return finish(ctx, state);
	} else if (state.phase === "reconcile-edges") {
		const page = await edgesOf(ctx).query({ where: { provenance: "DISCOVERED" }, limit: 100, cursor: state.cursor });
		const stale = page.items.filter((row) => row.data.active && row.data.scanId !== state.id);
		if (stale.length) {
			await edgesOf(ctx).putMany(stale.map((row) => ({ id: row.id, data: { ...row.data, active: false } })));
			state.retired += stale.length;
		}
		if (page.hasMore && page.cursor) state.cursor = page.cursor;
		else {
			state.phase = "reconcile-nodes";
			state.cursor = undefined;
		}
	} else {
		// Entries this scan didn't see are gone; every URL is re-settled from its now-current edges.
		const page = await nodesOf(ctx).query({ where: { provenance: "DISCOVERED" }, limit: 50, cursor: state.cursor });
		for (const row of page.items) {
			if (!row.data.active) continue;
			if (row.data.type === "URL") {
				if ((await settleUrl(ctx, plans, row.id)) && !(await nodesOf(ctx).get(row.id))?.active) state.retired++;
			} else if ((row.data as { scanId?: string }).scanId !== state.id) {
				await nodesOf(ctx).put(row.id, { ...row.data, active: false });
				state.retired++;
			}
		}
		if (page.hasMore && page.cursor) state.cursor = page.cursor;
		else return finish(ctx, state);
	}

	state.updatedAt = new Date().toISOString();
	const write = await ctx.kv.compareAndSet(SCAN_KEY, versioned!.revision, state);
	const current = write.applied ? state : await ctx.kv.get<ScanState>(SCAN_KEY);
	return { state: current, last: await ctx.kv.get<LastScan>(LAST_SCAN_KEY), done: !current };
}

async function finish(ctx: PluginContext, state: ScanState) {
	const last: LastScan = {
		id: state.id,
		startedAt: state.startedAt,
		finishedAt: new Date().toISOString(),
		status: state.errors.length ? "PARTIAL" : "SUCCEEDED",
		processed: state.processed,
		retired: state.retired,
		errors: state.errors,
	};
	await ctx.kv.set(LAST_SCAN_KEY, last);
	await ctx.kv.delete(SCAN_KEY);
	return { state: null, last, done: true };
}
