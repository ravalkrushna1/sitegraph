import { z } from "astro/zod";
import type { RouteContext } from "emdash";
import { PluginRouteError } from "emdash";

import { CRITICALITIES, DOCUMENTED_NODE_TYPES, DOCUMENTED_RELATION_TYPES, NODE_TYPES } from "./domain/graph.js";
import { MAX_DEPTH } from "./domain/impact.js";
import * as graph from "./graph-service.js";
import { ScanConflictError, scanStep, startScan } from "./scan.js";

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

const nodeSaveInput = z.object({
	id: id.optional(),
	type: z.enum(DOCUMENTED_NODE_TYPES).optional(),
	label: text(200).min(1).optional(),
	description: text(2000).optional(),
	criticality: z.enum(CRITICALITIES).nullable().optional(),
	notes: text(5000).optional(),
	docUrl: safeUrl.optional(),
	lastVerifiedAt: z.iso.datetime().nullable().optional(),
});

type Ctx<T = unknown> = RouteContext<T>;

/** Run a shared graph operation, turning its domain errors into HTTP ones. */
async function run<T>(op: () => Promise<T>): Promise<T> {
	try {
		return await op();
	} catch (error) {
		if (error instanceof graph.GraphError) {
			throw error.kind === "not_found" ? PluginRouteError.notFound(error.message) : PluginRouteError.badRequest(error.message);
		}
		if (error instanceof ScanConflictError) throw PluginRouteError.conflict(error.message);
		throw error;
	}
}

export const routes = {
	health: {
		permission: READ,
		handler: async (ctx: Ctx) => ({ plugin: ctx.plugin.id, version: ctx.plugin.version, siteUrl: ctx.site.url || null }),
	},

	overview: {
		permission: READ,
		handler: async (ctx: Ctx) => graph.overview(ctx),
	},

	"scan/start": {
		permission: MANAGE,
		handler: async (ctx: Ctx) => ({ state: await startScan(ctx) }),
	},

	"scan/step": {
		permission: MANAGE,
		input: z.object({ scanId: z.string().min(1).max(100) }),
		handler: async (ctx: Ctx<{ scanId: string }>) => run(() => scanStep(ctx, ctx.input.scanId)),
	},

	"nodes/search": {
		permission: READ,
		input: z.object({
			q: text(200).default(""),
			type: z.enum(NODE_TYPES).optional(),
			broken: z.boolean().optional(),
			cursor: z.string().optional(),
		}),
		handler: async (ctx: Ctx<{ q: string; type?: (typeof NODE_TYPES)[number]; broken?: boolean; cursor?: string }>) =>
			graph.searchNodes(ctx, ctx.input),
	},

	"graph/neighborhood": {
		permission: READ,
		input: z.object({ nodeId: id }),
		handler: async (ctx: Ctx<{ nodeId: string }>) => run(() => graph.neighborhood(ctx, ctx.input.nodeId)),
	},

	"graph/impact": {
		permission: READ,
		input: z.object({
			nodeId: id,
			direction: z.enum(["inbound", "outbound", "both"]).default("inbound"),
			depth: z.number().int().min(1).max(MAX_DEPTH).default(2),
		}),
		handler: async (ctx: Ctx<{ nodeId: string; direction: "inbound" | "outbound" | "both"; depth: number }>) =>
			run(() => graph.impactFor(ctx, ctx.input.nodeId, ctx.input.direction, ctx.input.depth)),
	},

	"nodes/save": {
		permission: MANAGE,
		input: nodeSaveInput,
		handler: async (ctx: Ctx<z.infer<typeof nodeSaveInput>>) => run(() => graph.saveNode(ctx, ctx.input)),
	},

	"nodes/delete": {
		permission: MANAGE,
		input: z.object({ id }),
		handler: async (ctx: Ctx<{ id: string }>) => run(() => graph.deleteNode(ctx, ctx.input.id)),
	},

	"edges/save": {
		permission: MANAGE,
		input: z.object({
			sourceNodeId: id,
			targetNodeId: id,
			relation: z.enum(DOCUMENTED_RELATION_TYPES),
			label: text(200).optional(),
		}),
		handler: async (ctx: Ctx<{ sourceNodeId: string; targetNodeId: string; relation: string; label?: string }>) =>
			run(() => graph.saveEdge(ctx, ctx.input, ctx.user?.id)),
	},

	"edges/delete": {
		permission: MANAGE,
		input: z.object({ id }),
		handler: async (ctx: Ctx<{ id: string }>) => run(() => graph.deleteEdge(ctx, ctx.input.id)),
	},

	export: {
		permission: READ,
		handler: async (ctx: Ctx) => graph.exportGraph(ctx),
	},
};
