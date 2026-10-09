import { z } from "astro/zod";
import type { PluginContext, RouteContext } from "emdash";
import { PluginRouteError } from "emdash";

import {
	CRITICALITIES,
	DOCUMENTED_NODE_TYPES,
	DOCUMENTED_RELATION_TYPES,
	edgeId,
	type GraphEdge,
	type GraphNode,
	NODE_TYPES,
	SCHEMA_VERSION,
} from "./domain/graph.js";
import { impact, MAX_DEPTH, MAX_EDGES } from "./domain/impact.js";
import { getScanStatus, scanStep, startScan } from "./scan.js";
import { activeEdges, edgesOf, nodesOf, queryAll } from "./store.js";

// Reads are for Editors and up (the graph can reveal unpublished structure);
// anything that changes the graph or runs a scan is admin-only.
const READ = "plugins:read" as const;
const MANAGE = "plugins:manage" as const;

const id = z.string().min(1).max(600);
const text = (max: number) => z.string().trim().max(max);
const safeUrl = z
	.string()
	.trim()
	.max(2000)
	.refine((v) => v === "" || /^https?:\/\//i.test(v), "Only http(s) links are allowed");

const annotation = {
	description: text(2000).optional(),
	criticality: z.enum(CRITICALITIES).nullable().optional(),
	notes: text(5000).optional(),
	docUrl: safeUrl.optional(),
	lastVerifiedAt: z.iso.datetime().nullable().optional(),
};

const nodeSaveInput = z.object({
	id: id.optional(),
	type: z.enum(DOCUMENTED_NODE_TYPES).optional(),
	label: text(200).min(1).optional(),
	...annotation,
});

const NEIGHBOUR_CAP = 200;

type Ctx<T = unknown> = RouteContext<T>;

async function nodesById(ctx: PluginContext, ids: string[]): Promise<Array<GraphNode & { id: string }>> {
	const found = await nodesOf(ctx).getMany([...new Set(ids)]);
	return [...found].map(([nodeId, data]) => ({ id: nodeId, ...data }));
}

async function requireNode(ctx: PluginContext, nodeId: string) {
	const node = await nodesOf(ctx).get(nodeId);
	if (!node || !node.active) throw PluginRouteError.notFound("That node doesn't exist (or a scan retired it).");
	return node;
}

/** Copy only the annotation fields that were sent; empty strings and null clear a field. */
type AnnotationInput = z.infer<z.ZodObject<typeof annotation>>;

function applyAnnotation<T extends object>(target: T, input: AnnotationInput): T {
	const out = { ...target } as Record<string, unknown>;
	for (const key of Object.keys(annotation)) {
		const value = input[key as keyof typeof annotation];
		if (value === undefined) continue;
		if (value === "" || value === null) delete out[key];
		else out[key] = value;
	}
	return out as T;
}

export const routes = {
	health: {
		permission: READ,
		handler: async (ctx: Ctx) => ({ plugin: ctx.plugin.id, version: ctx.plugin.version, siteUrl: ctx.site.url || null }),
	},

	overview: {
		permission: READ,
		handler: async (ctx: Ctx) => {
			const nodes = nodesOf(ctx);
			const counts = Object.fromEntries(
				await Promise.all(NODE_TYPES.map(async (type) => [type, await nodes.count({ type, active: true })] as const)),
			);
			return {
				siteUrl: ctx.site.url || null,
				counts,
				edges: await edgesOf(ctx).count({ active: true }),
				brokenLinks: await nodes.count({ type: "URL", active: true, resolved: false }),
				scan: await getScanStatus(ctx),
			};
		},
	},

	"scan/start": {
		permission: MANAGE,
		handler: async (ctx: Ctx) => ({ state: await startScan(ctx) }),
	},

	"scan/step": {
		permission: MANAGE,
		input: z.object({ scanId: z.string().min(1).max(100) }),
		handler: async (ctx: Ctx<{ scanId: string }>) => scanStep(ctx, ctx.input.scanId),
	},

	"nodes/search": {
		permission: READ,
		input: z.object({
			q: text(200).default(""),
			type: z.enum(NODE_TYPES).optional(),
			broken: z.boolean().optional(),
			cursor: z.string().optional(),
		}),
		handler: async (ctx: Ctx<{ q: string; type?: GraphNode["type"]; broken?: boolean; cursor?: string }>) => {
			const { q, type, broken, cursor } = ctx.input;
			// ponytail: prefix match on the lowercased label (storage has no substring index);
			// a real search index is the upgrade if people search mid-title.
			const where: Record<string, string | boolean | { startsWith: string }> = { active: true };
			if (q) where.search = { startsWith: q.toLowerCase() };
			if (type) where.type = type;
			if (broken) Object.assign(where, { type: "URL", resolved: false });
			const page = await nodesOf(ctx).query({ where, limit: 50, cursor });
			return { items: page.items.map((row) => ({ id: row.id, ...row.data })), cursor: page.hasMore ? page.cursor : null };
		},
	},

	"graph/neighborhood": {
		permission: READ,
		input: z.object({ nodeId: id }),
		handler: async (ctx: Ctx<{ nodeId: string }>) => {
			const center = await requireNode(ctx, ctx.input.nodeId);
			const cap = NEIGHBOUR_CAP + 1;
			const [outbound, inbound] = await Promise.all([
				activeEdges(ctx, [ctx.input.nodeId], "outbound", cap),
				activeEdges(ctx, [ctx.input.nodeId], "inbound", cap),
			]);
			// An entry and its URL are one page: also show what links to the entry's URL.
			const ownUrls = outbound.filter((e) => e.relation === "PUBLISHES_AS").map((e) => e.targetNodeId);
			const linkers = ownUrls.length ? await activeEdges(ctx, ownUrls, "inbound", cap) : [];
			const all = [...new Map([...outbound, ...inbound, ...linkers].map((e) => [e.id, e])).values()];
			const edges = all.slice(0, NEIGHBOUR_CAP);
			const nodes = await nodesById(ctx, edges.flatMap((e) => [e.sourceNodeId, e.targetNodeId]));
			return {
				center: { id: ctx.input.nodeId, ...center },
				nodes,
				edges,
				truncated: all.length > edges.length,
				total: all.length,
			};
		},
	},

	"graph/impact": {
		permission: READ,
		input: z.object({
			nodeId: id,
			direction: z.enum(["inbound", "outbound", "both"]).default("inbound"),
			depth: z.number().int().min(1).max(MAX_DEPTH).default(2),
		}),
		handler: async (ctx: Ctx<{ nodeId: string; direction: "inbound" | "outbound" | "both"; depth: number }>) => {
			await requireNode(ctx, ctx.input.nodeId);
			const result = await impact(ctx.input.nodeId, ctx.input.direction, ctx.input.depth, (ids, dir) =>
				activeEdges(ctx, ids, dir, MAX_EDGES),
			);
			const nodes = await nodesById(ctx, [result.start, ...result.hits.map((h) => h.nodeId)]);
			return { ...result, nodes };
		},
	},

	"nodes/save": {
		permission: MANAGE,
		input: nodeSaveInput,
		handler: async (ctx: Ctx<z.infer<typeof nodeSaveInput>>) => {
			const nodes = nodesOf(ctx);
			const now = new Date().toISOString();
			const { id: nodeId, type, label } = ctx.input;

			if (nodeId) {
				const existing = await requireNode(ctx, nodeId);
				// Discovered nodes take annotations only; their type and label come from the site.
				const renamed = existing.provenance === "DOCUMENTED" && label ? { label, search: label.toLowerCase() } : {};
				const updated = applyAnnotation({ ...existing, ...renamed }, ctx.input);
				await nodes.put(nodeId, updated);
				return { id: nodeId, ...updated };
			}

			if (!type || !label) throw PluginRouteError.badRequest("A new node needs a type and a label.");
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
				ctx.input,
			);
			const newId = `doc:${crypto.randomUUID()}`;
			await nodes.put(newId, created);
			return { id: newId, ...created };
		},
	},

	"nodes/delete": {
		permission: MANAGE,
		input: z.object({ id }),
		handler: async (ctx: Ctx<{ id: string }>) => {
			const node = await requireNode(ctx, ctx.input.id);
			if (node.provenance !== "DOCUMENTED") {
				throw PluginRouteError.badRequest("Discovered nodes come from your content. Change the content instead.");
			}
			const touching = [
				...(await queryAll(edgesOf(ctx), { sourceNodeId: ctx.input.id })),
				...(await queryAll(edgesOf(ctx), { targetNodeId: ctx.input.id })),
			];
			await edgesOf(ctx).deleteMany(touching.map((e) => e.id));
			await nodesOf(ctx).delete(ctx.input.id);
			return { deleted: ctx.input.id, edgesDeleted: touching.length };
		},
	},

	"edges/save": {
		permission: MANAGE,
		input: z.object({
			sourceNodeId: id,
			targetNodeId: id,
			relation: z.enum(DOCUMENTED_RELATION_TYPES),
			label: text(200).optional(),
		}),
		handler: async (
			ctx: Ctx<{ sourceNodeId: string; targetNodeId: string; relation: GraphEdge["relation"]; label?: string }>,
		) => {
			const { sourceNodeId, targetNodeId, relation, label } = ctx.input;
			if (sourceNodeId === targetNodeId) throw PluginRouteError.badRequest("A node can't depend on itself.");
			if (relation === "RELATED_TO" && !label) {
				throw PluginRouteError.badRequest("Say how they're related: RELATED_TO needs a label.");
			}
			await requireNode(ctx, sourceNodeId);
			await requireNode(ctx, targetNodeId);
			const now = new Date().toISOString();
			const edgeKey = edgeId(sourceNodeId, relation, targetNodeId, "doc");
			const existing = await edgesOf(ctx).get(edgeKey);
			const edge: GraphEdge = {
				sourceNodeId,
				targetNodeId,
				relation,
				...(label ? { label } : {}),
				provenance: "DOCUMENTED",
				evidence: { observedAt: now, ...(ctx.user?.id ? { sourceId: `user:${ctx.user.id}` } : {}) },
				active: true,
				firstSeenAt: existing?.firstSeenAt ?? now,
				lastSeenAt: now,
				schemaVersion: SCHEMA_VERSION,
			};
			await edgesOf(ctx).put(edgeKey, edge);
			return { id: edgeKey, ...edge };
		},
	},

	"edges/delete": {
		permission: MANAGE,
		input: z.object({ id }),
		handler: async (ctx: Ctx<{ id: string }>) => {
			const edge = await edgesOf(ctx).get(ctx.input.id);
			if (!edge) throw PluginRouteError.notFound("That relationship doesn't exist.");
			if (edge.provenance !== "DOCUMENTED") {
				throw PluginRouteError.badRequest("Discovered links come from your content. Edit the content instead.");
			}
			await edgesOf(ctx).delete(ctx.input.id);
			return { deleted: ctx.input.id };
		},
	},

	export: {
		permission: READ,
		handler: async (ctx: Ctx) => ({
			format: "sitegraph",
			schemaVersion: SCHEMA_VERSION,
			plugin: { id: ctx.plugin.id, version: ctx.plugin.version },
			site: ctx.site.url || null,
			exportedAt: new Date().toISOString(),
			nodes: (await queryAll(nodesOf(ctx), { active: true })).map((r) => ({ id: r.id, ...r.data })),
			edges: (await queryAll(edgesOf(ctx), { active: true })).map((r) => ({ id: r.id, ...r.data })),
		}),
	},
};
