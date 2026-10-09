// Discovery: turns published EmDash entries into CONTENT/URL nodes and PUBLISHES_AS/LINKS_TO edges.
// Read-only towards content (SPEC D3). Rescans are idempotent thanks to deterministic IDs.

import type { CollectionSchemaInfo, PluginContext, StorageCollection } from "emdash";

import {
	contentNodeId,
	edgeId,
	type GraphEdge,
	type GraphNode,
	SCHEMA_VERSION,
	urlNodeId,
} from "./domain/graph.js";
import { entryPath, extractLinks, internalPath } from "./domain/links.js";
import { edgesOf, nodesOf, queryAll } from "./store.js";

/** The slice of a plugin-visible content item that discovery reads. */
interface Entry {
	id: string;
	slug: string | null;
	status: string;
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
	phase: "collect" | "reconcile-nodes" | "reconcile-edges";
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
const STALE_LOCK_MS = 10 * 60 * 1000;
const MAX_ERRORS = 20;

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

function entryLabel(item: Entry, plan: CollectionPlan): string {
	const title = plan.titleField ? item.data[plan.titleField] : item.data.title;
	if (typeof title === "string" && title.trim()) return title.trim().slice(0, 200);
	return item.slug ?? item.id;
}

/** A discovered node merged over what's stored, so human annotations and firstSeenAt survive. */
function discoveredNode(
	existing: Omit<GraphNode, never> | undefined,
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
 * Re-read one entry's graph: its CONTENT node, its URL, and its outgoing links. Outgoing
 * discovered edges it no longer has are retired; that's safe because the entry was read whole.
 */
export async function refreshEntry(
	ctx: PluginContext,
	plan: CollectionPlan,
	item: Entry,
	scanId: string,
): Promise<void> {
	if (item.status !== "published") return retireEntry(ctx, plan.slug, item.id);

	const now = new Date().toISOString();
	const nodes = nodesOf(ctx);
	const edges = edgesOf(ctx);
	const contentId = contentNodeId(plan.slug, item.id);
	const path = plan.routable && item.slug ? entryPath(plan.pattern, plan.slug, item.slug, item.id) : null;

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
		// Whether a page lives here is decided by whichever entry publishes as it.
		const prior = existing.get(id);
		nodeDocs.set(id, discoveredNode(prior, { type: "URL", label: link.target, ref: link.target, resolved: prior?.resolved ?? false }, now, scanId));
	}

	const edgeDocs = new Map<string, GraphEdge>();
	const edge = (source: string, relation: GraphEdge["relation"], target: string, field: string, evidence: GraphEdge["evidence"]) => {
		const id = edgeId(source, relation, target, field);
		edgeDocs.set(id, {
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
}

/** An entry left the published site: hide its node and links, mark its URL as having no page. */
export async function retireEntry(ctx: PluginContext, collection: string, entryId: string): Promise<void> {
	const nodes = nodesOf(ctx);
	const edges = edgesOf(ctx);
	const contentId = contentNodeId(collection, entryId);
	const outgoing = (await queryAll(edges, { sourceNodeId: contentId, provenance: "DISCOVERED" })).filter((e) => e.data.active);
	const urls = outgoing.filter((e) => e.data.relation === "PUBLISHES_AS").map((e) => e.data.targetNodeId);
	const docs = await nodes.getMany([contentId, ...urls]);

	await edges.putMany(outgoing.map((e) => ({ id: e.id, data: { ...e.data, active: false } })));
	await nodes.putMany(
		[...docs].map(([id, data]) => ({ id, data: id === contentId ? { ...data, active: false } : { ...data, resolved: false } })),
	);
}

/** Refresh one entry from a content hook. Never scans the site (SPEC D8). */
export async function refreshFromHook(ctx: PluginContext, collection: string, entryId: string): Promise<void> {
	const plan = (await collectionPlans(ctx)).find((p) => p.slug === collection);
	if (!plan) return;
	const item = await ctx.content?.get(collection, entryId);
	const running = await ctx.kv.get<ScanState>(SCAN_KEY);
	if (!item) return retireEntry(ctx, collection, entryId);
	await refreshEntry(ctx, plan, item, running?.id ?? "hook");
}

export async function getScanStatus(ctx: PluginContext): Promise<{ running: ScanState | null; last: LastScan | null }> {
	return {
		running: await ctx.kv.get<ScanState>(SCAN_KEY),
		last: await ctx.kv.get<LastScan>(LAST_SCAN_KEY),
	};
}

export async function startScan(ctx: PluginContext): Promise<ScanState> {
	const running = await ctx.kv.get<ScanState>(SCAN_KEY);
	if (running && Date.now() - Date.parse(running.startedAt) < STALE_LOCK_MS) return running;
	const state: ScanState = {
		id: `scan_${crypto.randomUUID()}`,
		startedAt: new Date().toISOString(),
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
 * Advance the running scan by one bounded batch. The admin calls this until `done`, so no
 * single request runs long. Reconciliation runs only after every collection was read, so a
 * failed or abandoned scan never retires anything (SPEC D7).
 */
export async function scanStep(ctx: PluginContext): Promise<{ state: ScanState | null; last: LastScan | null; done: boolean }> {
	const state = await ctx.kv.get<ScanState>(SCAN_KEY);
	if (!state) return { state: null, last: await ctx.kv.get<LastScan>(LAST_SCAN_KEY), done: true };

	if (state.phase === "collect") {
		const plan = state.collections[state.index];
		if (!plan) {
			state.phase = "reconcile-nodes";
			state.cursor = undefined;
		} else {
			const page = await ctx.content!.list(plan.slug, { limit: BATCH, cursor: state.cursor, where: { status: "published" } });
			for (const item of page.items) {
				try {
					await refreshEntry(ctx, plan, item, state.id);
					state.processed++;
				} catch (error) {
					if (state.errors.length < MAX_ERRORS) state.errors.push(`${plan.slug}/${item.id}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (page.hasMore && page.cursor) state.cursor = page.cursor;
			else {
				state.index++;
				state.cursor = undefined;
			}
		}
	} else {
		// Retire discovered records this scan didn't see. Skipped when entries failed,
		// because their links weren't seen either and would be wrongly retired.
		const page = state.errors.length
			? { items: [], hasMore: false, cursor: undefined }
			: state.phase === "reconcile-nodes"
				? await retireUnseen(nodesOf(ctx), state)
				: await retireUnseen(edgesOf(ctx), state);
		if (page.hasMore && page.cursor) state.cursor = page.cursor;
		else if (state.phase === "reconcile-nodes") {
			state.phase = "reconcile-edges";
			state.cursor = undefined;
		} else {
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
	}

	await ctx.kv.set(SCAN_KEY, state);
	return { state, last: await ctx.kv.get<LastScan>(LAST_SCAN_KEY), done: false };
}

async function retireUnseen<T extends { active: boolean; scanId?: string }>(
	collection: StorageCollection<T>,
	state: ScanState,
): Promise<{ hasMore: boolean; cursor?: string }> {
	const page = await collection.query({ where: { provenance: "DISCOVERED" }, limit: 100, cursor: state.cursor });
	const stale = page.items.filter((row) => row.data.active && row.data.scanId !== state.id);
	if (stale.length) {
		await collection.putMany(stale.map((row) => ({ id: row.id, data: { ...row.data, active: false } })));
		state.retired += stale.length;
	}
	return page;
}
