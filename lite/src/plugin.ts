// SiteGraph Lite: the sandboxed, registry-installable edition. Graph rules, scanning and graph
// operations are shared with the native edition (../../native/src); this file only parses
// admin interactions (by hand: no zod in sandboxed bundles) and wires hooks.

import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import type { Criticality } from "../../native/src/domain/graph.js";
import * as graph from "../../native/src/graph-service.js";
import {
	getScanStatus,
	refreshFromHook,
	retireFromHook,
	ScanConflictError,
	scanStep,
	startScan,
} from "../../native/src/scan.js";
import {
	type BrokenRow,
	errorResponse,
	type ExploreSelection,
	type Node,
	renderDocument,
	renderExplore,
	renderOverview,
	renderWidget,
	type View,
} from "./ui.js";

// Sandboxed calls are small on purpose: a few entries per step, and a few seconds of steps per
// call; cron picks up the rest. Cloudflare caps each sandboxed call at 50 ms CPU and 10
// subrequests (SPEC D15).
const SCAN_BATCH = 5;
const SCAN_BUDGET_MS = 4000;
const CRON_NAME = "scan";
const PICKER_MAX = 500;
const BROKEN_MAX = 100;

type Interaction =
	| { type: "page_load"; page: string }
	| { type: "block_action"; page: string; action_id: string; value: unknown }
	| { type: "form_submit"; page: string; action_id: string; values: Record<string, unknown> };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 5000): string => (typeof v === "string" ? v.slice(0, max) : "");

/** Returns undefined for anything malformed. `page` defaults to the overview. */
function parseInteraction(input: unknown): Interaction | undefined {
	if (!isRecord(input)) return undefined;
	const page = typeof input.page === "string" ? input.page : "/overview";
	if (input.type === "page_load") return { type: "page_load", page };
	if (typeof input.action_id !== "string") return undefined;
	if (input.type === "block_action") return { type: "block_action", page, action_id: input.action_id, value: input.value };
	if (input.type === "form_submit" && isRecord(input.values)) {
		return { type: "form_submit", page, action_id: input.action_id, values: input.values };
	}
	return undefined;
}

/** Run scan steps until done or out of time budget; schedule cron to continue if needed. */
async function advanceScan(ctx: PluginContext, scanId: string) {
	const started = Date.now();
	let result = await scanStep(ctx, scanId, SCAN_BATCH);
	while (!result.done && Date.now() - started < SCAN_BUDGET_MS) result = await scanStep(ctx, scanId, SCAN_BATCH);
	if (!result.done) await ctx.cron?.schedule(CRON_NAME, { schedule: new Date(Date.now() + 60_000).toISOString() });
	return result;
}

// ── Pages ────────────────────────────────────────────────────────────────────

async function overviewPage(ctx: PluginContext, notice?: string) {
	const [data, broken] = await Promise.all([graph.overview(ctx), graph.brokenLinks(ctx, BROKEN_MAX)]);
	return renderOverview(data, broken as BrokenRow[], notice);
}

async function explorePage(ctx: PluginContext, nodeId?: string, view: View = "connections", depth = 2) {
	const { items, capped } = await graph.listNodes(ctx, PICKER_MAX);
	if (!nodeId) return renderExplore(items, capped);
	let sel: ExploreSelection;
	if (view === "connections") {
		const hood = await graph.neighborhood(ctx, nodeId);
		sel = { node: hood.center, view, depth, edges: hood.edges, neighbours: hood.nodes };
	} else {
		const impact = await graph.impactFor(ctx, nodeId, view, depth);
		const node = impact.nodes.find((n) => n.id === nodeId) as Node;
		sel = { node, view, depth, impact };
	}
	return renderExplore(items, capped, sel);
}

async function documentPage(ctx: PluginContext) {
	const [{ items }, documented] = await Promise.all([graph.listNodes(ctx, PICKER_MAX), graph.documented(ctx)]);
	return renderDocument(items, documented);
}

const ok = (message: string) => ({ toast: { type: "success" as const, message } });

async function handle(i: Interaction, ctx: PluginContext, userId?: string) {
	if (i.page === "widget:overview") return renderWidget(await graph.overview(ctx));

	if (i.page === "/explore") {
		if (i.type === "form_submit" && i.action_id === "explore") {
			const view: View = i.values.view === "inbound" || i.values.view === "outbound" ? i.values.view : "connections";
			const depth = Math.min(3, Math.max(1, Number(i.values.depth) || 2));
			const nodeId = str(i.values.node, 600);
			if (!nodeId) return { ...(await explorePage(ctx)), toast: { type: "error" as const, message: "Pick something to explore first." } };
			return explorePage(ctx, nodeId, view, depth);
		}
		if (i.type === "block_action" && i.action_id === "open" && typeof i.value === "string") return explorePage(ctx, i.value);
		if (i.type === "form_submit" && i.action_id.startsWith("note:")) {
			const nodeId = i.action_id.slice("note:".length);
			const criticality = str(i.values.criticality, 20);
			await graph.saveNode(ctx, {
				id: nodeId,
				description: str(i.values.description),
				criticality: criticality ? (criticality as Criticality) : null,
				notes: str(i.values.notes),
				docUrl: str(i.values.docUrl, 2000),
				...(i.values.checked === true ? { lastVerifiedAt: new Date().toISOString() } : {}),
			});
			return { ...(await explorePage(ctx, nodeId)), ...ok("Notes saved.") };
		}
		return explorePage(ctx);
	}

	if (i.page === "/document") {
		if (i.type === "form_submit" && i.action_id === "add_node") {
			const criticality = str(i.values.criticality, 20);
			const node = await graph.saveNode(ctx, {
				type: str(i.values.kind, 40),
				label: str(i.values.name, 200),
				description: str(i.values.description),
				...(criticality ? { criticality: criticality as Criticality } : {}),
			});
			return { ...(await documentPage(ctx)), ...ok(`Added “${node.label}”.`) };
		}
		if (i.type === "form_submit" && i.action_id === "add_edge") {
			await graph.saveEdge(
				ctx,
				{
					sourceNodeId: str(i.values.from, 600),
					targetNodeId: str(i.values.to, 600),
					relation: str(i.values.relation, 40),
					label: str(i.values.label, 200) || undefined,
				},
				userId,
			);
			return { ...(await documentPage(ctx)), ...ok("Relationship added.") };
		}
		if (i.type === "block_action" && i.action_id === "del_node" && typeof i.value === "string") {
			await graph.deleteNode(ctx, i.value);
			return { ...(await documentPage(ctx)), ...ok("Deleted.") };
		}
		if (i.type === "block_action" && i.action_id === "del_edge" && typeof i.value === "string") {
			await graph.deleteEdge(ctx, i.value);
			return { ...(await documentPage(ctx)), ...ok("Relationship removed.") };
		}
		if (i.type === "block_action" && i.action_id === "open" && typeof i.value === "string") return explorePage(ctx, i.value);
		return documentPage(ctx);
	}

	if (i.type === "block_action" && i.action_id === "scan") {
		const state = await startScan(ctx);
		const result = await advanceScan(ctx, state.id);
		if (!result.done) return overviewPage(ctx, "Scanning. It keeps going in the background; reload this page to see progress.");
		const last = result.last;
		const summary = last
			? `Scan complete. Read ${last.processed} entries; ${last.retired ? `${last.retired} out-of-date links or pages cleared` : "nothing was out of date"}.`
			: "Scan complete.";
		return { ...(await overviewPage(ctx)), ...ok(summary) };
	}
	return overviewPage(ctx);
}

const entryId = (content: Record<string, unknown>): string | null => (typeof content.id === "string" ? content.id : null);

const plugin: SandboxedPlugin = {
	// Hooks refresh only the entry that changed (SPEC D8), the same as the native edition.
	hooks: {
		"content:afterSave": async (event, ctx) => {
			const id = entryId(event.content);
			if (id) await refreshFromHook(ctx, event.collection, id);
		},
		"content:afterPublish": async (event, ctx) => {
			const id = entryId(event.content);
			if (id) await refreshFromHook(ctx, event.collection, id);
		},
		"content:afterRestore": async (event, ctx) => {
			const id = entryId(event.content);
			if (id) await refreshFromHook(ctx, event.collection, id);
		},
		"content:afterUnpublish": async (event, ctx) => {
			const id = entryId(event.content);
			if (id) await retireFromHook(ctx, event.collection, id);
		},
		"content:afterDelete": async (event, ctx) => {
			await retireFromHook(ctx, event.collection, event.id);
		},
		cron: async (event, ctx) => {
			if (event.name !== CRON_NAME) return;
			const { running } = await getScanStatus(ctx);
			if (running) await advanceScan(ctx, running.id);
		},
	},
	routes: {
		// Default permission: plugins:manage (Admins), like every page of this plugin.
		admin: {
			handler: async (routeCtx, ctx) => {
				const interaction = parseInteraction(routeCtx.input);
				if (!interaction) return errorResponse("That request didn't look like an admin page action.");
				try {
					return await handle(interaction, ctx, routeCtx.user?.id);
				} catch (error) {
					if (error instanceof graph.GraphError || error instanceof ScanConflictError) {
						return errorResponse(error.message);
					}
					ctx.log.error("SiteGraph admin action failed", { page: interaction.page, error: String(error) });
					return errorResponse("Something went wrong. Check the server log for details.");
				}
			},
		},
	},
};

export default plugin;
