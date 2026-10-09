// Graph operations shared by both editions. Each edition validates its own input
// (native: zod routes; lite: hand-written guards) and maps GraphError to its own error UI.
// Like scan.ts, this imports only *types* from "emdash".

import type { PluginContext } from "emdash";

import {
	CRITICALITIES,
	type Criticality,
	DOCUMENTED_NODE_TYPES,
	DOCUMENTED_RELATION_TYPES,
	edgeId,
	type GraphEdge,
	type GraphNode,
	NODE_TYPES,
	type NodeType,
	type RelationType,
	SCHEMA_VERSION,
} from "./domain/graph.js";
import { type Direction, impact, MAX_EDGES } from "./domain/impact.js";
import { getScanStatus } from "./scan.js";
import { activeEdges, edgesOf, nodesOf, queryAll } from "./store.js";

export class GraphError extends Error {
	constructor(
		readonly kind: "bad_request" | "not_found",
		message: string,
	) {
		super(message);
		this.name = "GraphError";
	}
}

export type NodeWithId = GraphNode & { id: string };

const NEIGHBOUR_CAP = 200;

export interface AnnotationInput {
	description?: string;
	criticality?: Criticality | null;
	notes?: string;
	docUrl?: string;
	lastVerifiedAt?: string | null;
}

const ANNOTATION_KEYS = ["description", "criticality", "notes", "docUrl", "lastVerifiedAt"] as const;
const LIMITS = { label: 200, description: 2000, notes: 5000, docUrl: 2000 } as const;

/**
 * Checks every edition relies on, whatever validated the input first: lengths, known enums,
 * and doc links that can only ever be http(s) (they're rendered as links).
 */
function checkAnnotation(input: AnnotationInput): void {
	for (const key of ["description", "notes", "docUrl"] as const) {
		const value = input[key];
		if (value !== undefined && (typeof value !== "string" || value.length > LIMITS[key])) {
			throw new GraphError("bad_request", `${key} is too long.`);
		}
	}
	if (input.docUrl && !/^https?:\/\//i.test(input.docUrl.trim())) {
		throw new GraphError("bad_request", "Doc links must start with http:// or https://.");
	}
	if (input.criticality != null && !CRITICALITIES.includes(input.criticality)) {
		throw new GraphError("bad_request", "Unknown criticality.");
	}
	if (input.lastVerifiedAt != null && Number.isNaN(Date.parse(input.lastVerifiedAt))) {
		throw new GraphError("bad_request", "lastVerifiedAt must be a date.");
	}
}

/** Copy only the annotation fields that were sent; empty strings and null clear a field. */
function applyAnnotation<T extends object>(target: T, input: AnnotationInput): T {
	const out = { ...target } as Record<string, unknown>;
	for (const key of ANNOTATION_KEYS) {
		const value = typeof input[key] === "string" ? (input[key] as string).trim() : input[key];
		if (value === undefined) continue;
		if (value === "" || value === null) delete out[key];
		else out[key] = value;
	}
	return out as T;
}

export async function nodesById(ctx: PluginContext, ids: string[]): Promise<NodeWithId[]> {
	const found = await nodesOf(ctx).getMany([...new Set(ids)]);
	return [...found].map(([nodeId, data]) => ({ id: nodeId, ...data }));
}

export async function requireNode(ctx: PluginContext, nodeId: string): Promise<GraphNode> {
	const node = await nodesOf(ctx).get(nodeId);
	if (!node || !node.active) throw new GraphError("not_found", "That item doesn't exist (or a scan removed it).");
	return node;
}

export async function overview(ctx: PluginContext) {
	const nodes = nodesOf(ctx);
	const counts = Object.fromEntries(
		await Promise.all(NODE_TYPES.map(async (type) => [type, await nodes.count({ type, active: true })] as const)),
	) as Record<NodeType, number>;
	return {
		siteUrl: ctx.site.url || null,
		counts,
		edges: await edgesOf(ctx).count({ active: true }),
		brokenLinks: await nodes.count({ type: "URL", active: true, resolved: false }),
		scan: await getScanStatus(ctx),
	};
}

export async function searchNodes(
	ctx: PluginContext,
	opts: { q?: string; type?: NodeType; broken?: boolean; cursor?: string; limit?: number },
) {
	// ponytail: prefix match on the lowercased label (storage has no substring index);
	// a real search index is the upgrade if people search mid-title.
	const where: Record<string, string | boolean | { startsWith: string }> = { active: true };
	if (opts.q) where.search = { startsWith: opts.q.toLowerCase() };
	if (opts.type) where.type = opts.type;
	if (opts.broken) Object.assign(where, { type: "URL", resolved: false });
	const page = await nodesOf(ctx).query({ where, limit: opts.limit ?? 50, cursor: opts.cursor });
	return { items: page.items.map((row) => ({ id: row.id, ...row.data })), cursor: page.hasMore ? (page.cursor ?? null) : null };
}

/** Every active node, for pickers. Capped; the caller says so when it's hit. */
export async function listNodes(ctx: PluginContext, max: number): Promise<{ items: NodeWithId[]; capped: boolean }> {
	const rows = await queryAll(nodesOf(ctx), { active: true }, max + 1);
	return {
		items: rows.slice(0, max).map((r) => ({ id: r.id, ...r.data })),
		capped: rows.length > max,
	};
}

/** Broken links paired with the pages that contain them, which is what someone has to fix. */
export async function brokenLinks(ctx: PluginContext, max: number) {
	const broken = (await queryAll(nodesOf(ctx), { type: "URL", active: true, resolved: false }, max)).map((r) => ({
		id: r.id,
		...r.data,
	}));
	const edges = (await activeEdges(ctx, broken.map((b) => b.id), "inbound", max)).filter((e) => e.relation === "LINKS_TO");
	const pages = new Map((await nodesById(ctx, edges.map((e) => e.sourceNodeId))).map((n) => [n.id, n]));
	const byId = new Map(broken.map((b) => [b.id, b]));
	return edges.flatMap((e) => {
		const target = byId.get(e.targetNodeId);
		const page = pages.get(e.sourceNodeId);
		return target && page ? [{ path: target.ref, href: e.evidence?.href ?? target.ref, page, field: e.evidence?.fieldPath }] : [];
	});
}

export async function neighborhood(ctx: PluginContext, nodeId: string) {
	const center = await requireNode(ctx, nodeId);
	const cap = NEIGHBOUR_CAP + 1;
	const [outbound, inbound] = await Promise.all([
		activeEdges(ctx, [nodeId], "outbound", cap),
		activeEdges(ctx, [nodeId], "inbound", cap),
	]);
	// An entry and its URL are one page: also show what links to the entry's URL.
	const ownUrls = outbound.filter((e) => e.relation === "PUBLISHES_AS").map((e) => e.targetNodeId);
	const linkers = ownUrls.length ? await activeEdges(ctx, ownUrls, "inbound", cap) : [];
	const all = [...new Map([...outbound, ...inbound, ...linkers].map((e) => [e.id, e])).values()];
	const edges = all.slice(0, NEIGHBOUR_CAP);
	const nodes = await nodesById(ctx, edges.flatMap((e) => [e.sourceNodeId, e.targetNodeId]));
	return { center: { id: nodeId, ...center }, nodes, edges, truncated: all.length > edges.length, total: all.length };
}

export async function impactFor(ctx: PluginContext, nodeId: string, direction: Direction, depth: number) {
	await requireNode(ctx, nodeId);
	const result = await impact(nodeId, direction, depth, (ids, dir) => activeEdges(ctx, ids, dir, MAX_EDGES));
	const nodes = await nodesById(ctx, [result.start, ...result.hits.map((h) => h.nodeId)]);
	return { ...result, nodes };
}

export async function saveNode(
	ctx: PluginContext,
	input: { id?: string; type?: string; label?: string } & AnnotationInput,
): Promise<NodeWithId> {
	checkAnnotation(input);
	const nodes = nodesOf(ctx);
	const label = input.label?.trim();
	if (label !== undefined && (label.length === 0 || label.length > LIMITS.label)) {
		throw new GraphError("bad_request", "Names must be 1 to 200 characters.");
	}

	if (input.id) {
		const existing = await requireNode(ctx, input.id);
		// Discovered nodes take annotations only; their type and label come from the site.
		const renamed = existing.provenance === "DOCUMENTED" && label ? { label, search: label.toLowerCase() } : {};
		const updated = applyAnnotation({ ...existing, ...renamed }, input);
		await nodes.put(input.id, updated);
		return { id: input.id, ...updated };
	}

	const type = DOCUMENTED_NODE_TYPES.find((t) => t === input.type);
	if (!type || !label) throw new GraphError("bad_request", "A new item needs a kind and a name.");
	const now = new Date().toISOString();
	const created = applyAnnotation<GraphNode>(
		{
			type,
			label,
			search: label.toLowerCase(),
			ref: label,
			provenance: "DOCUMENTED",
			active: true,
			firstSeenAt: now,
			lastSeenAt: now,
			schemaVersion: SCHEMA_VERSION,
		},
		input,
	);
	const newId = `doc:${crypto.randomUUID()}`;
	await nodes.put(newId, created);
	return { id: newId, ...created };
}

export async function deleteNode(ctx: PluginContext, id: string) {
	const node = await requireNode(ctx, id);
	if (node.provenance !== "DOCUMENTED") {
		throw new GraphError("bad_request", "Discovered items come from your content. Change the content instead.");
	}
	const touching = [
		...(await queryAll(edgesOf(ctx), { sourceNodeId: id })),
		...(await queryAll(edgesOf(ctx), { targetNodeId: id })),
	];
	await edgesOf(ctx).deleteMany(touching.map((e) => e.id));
	await nodesOf(ctx).delete(id);
	return { deleted: id, edgesDeleted: touching.length };
}

export async function saveEdge(
	ctx: PluginContext,
	input: { sourceNodeId: string; targetNodeId: string; relation: string; label?: string },
	userId?: string,
) {
	const { sourceNodeId, targetNodeId } = input;
	const relation = DOCUMENTED_RELATION_TYPES.find((r) => r === input.relation);
	const label = input.label?.trim();
	if (!relation) throw new GraphError("bad_request", "Pick a relationship.");
	if (sourceNodeId === targetNodeId) throw new GraphError("bad_request", "An item can't depend on itself.");
	if (relation === "RELATED_TO" && !label) throw new GraphError("bad_request", "Say how they're related: “is related to” needs a description.");
	if (label && label.length > LIMITS.label) throw new GraphError("bad_request", "Keep the description under 200 characters.");
	await requireNode(ctx, sourceNodeId);
	await requireNode(ctx, targetNodeId);
	const now = new Date().toISOString();
	const key = edgeId(sourceNodeId, relation, targetNodeId, "doc");
	const existing = await edgesOf(ctx).get(key);
	const edge: GraphEdge = {
		sourceNodeId,
		targetNodeId,
		relation: relation as RelationType,
		...(label ? { label } : {}),
		provenance: "DOCUMENTED",
		evidence: { observedAt: now, ...(userId ? { sourceId: `user:${userId}` } : {}) },
		active: true,
		firstSeenAt: existing?.firstSeenAt ?? now,
		lastSeenAt: now,
		schemaVersion: SCHEMA_VERSION,
	};
	await edgesOf(ctx).put(key, edge);
	return { id: key, ...edge };
}

export async function deleteEdge(ctx: PluginContext, id: string) {
	const edge = await edgesOf(ctx).get(id);
	if (!edge) throw new GraphError("not_found", "That relationship doesn't exist.");
	if (edge.provenance !== "DOCUMENTED") {
		throw new GraphError("bad_request", "Discovered links come from your content. Edit the content instead.");
	}
	await edgesOf(ctx).delete(id);
	return { deleted: id };
}

export async function documented(ctx: PluginContext) {
	const nodes = (await queryAll(nodesOf(ctx), { provenance: "DOCUMENTED", active: true }, 500)).map((r) => ({ id: r.id, ...r.data }));
	const edges = (await queryAll(edgesOf(ctx), { provenance: "DOCUMENTED", active: true }, 500)).map((r) => ({ id: r.id, ...r.data }));
	return { nodes, edges };
}

export async function exportGraph(ctx: PluginContext) {
	return {
		format: "sitegraph",
		schemaVersion: SCHEMA_VERSION,
		plugin: { id: ctx.plugin.id, version: ctx.plugin.version },
		site: ctx.site.url || null,
		exportedAt: new Date().toISOString(),
		nodes: (await queryAll(nodesOf(ctx), { active: true })).map((r) => ({ id: r.id, ...r.data })),
		edges: (await queryAll(edgesOf(ctx), { active: true })).map((r) => ({ id: r.id, ...r.data })),
	};
}
