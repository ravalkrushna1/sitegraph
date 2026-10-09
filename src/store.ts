import type { PluginContext, StorageCollection } from "emdash";

import type { EdgeRecord } from "./domain/impact.js";
import type { GraphEdge, GraphNode } from "./domain/graph.js";

export const STORAGE = {
	nodes: { indexes: ["type", "active", "search", "provenance", "resolved"] },
	edges: { indexes: ["sourceNodeId", "targetNodeId", "provenance", "active"] },
};

export interface NodeRecord extends GraphNode {
	id: string;
	/** Scan that last saw a discovered node. */
	scanId?: string;
}

export const nodesOf = (ctx: PluginContext) => ctx.storage.nodes as StorageCollection<Omit<NodeRecord, "id">>;
export const edgesOf = (ctx: PluginContext) => ctx.storage.edges as StorageCollection<GraphEdge>;

const PAGE = 100;

/** Documents matching `where`, page by page, stopping once `max` are read. */
export async function queryAll<T>(
	collection: StorageCollection<T>,
	where: Record<string, string | boolean | { in: string[] }>,
	max = Infinity,
): Promise<Array<{ id: string; data: T }>> {
	const out: Array<{ id: string; data: T }> = [];
	let cursor: string | undefined;
	do {
		const page = await collection.query({ where, limit: PAGE, cursor });
		out.push(...page.items);
		cursor = page.hasMore && out.length < max ? page.cursor : undefined;
	} while (cursor);
	return out.slice(0, max);
}

/**
 * Active edges touching any of `nodeIds`, used by impact and neighbourhood views. Stops reading
 * at `max`, so a hub page linked from every footer can't make a request read the whole table.
 */
export async function activeEdges(
	ctx: PluginContext,
	nodeIds: string[],
	direction: "inbound" | "outbound",
	max = Infinity,
): Promise<EdgeRecord[]> {
	const field = direction === "outbound" ? "sourceNodeId" : "targetNodeId";
	const out: EdgeRecord[] = [];
	for (let i = 0; i < nodeIds.length && out.length < max; i += PAGE) {
		const rows = await queryAll(edgesOf(ctx), { [field]: { in: nodeIds.slice(i, i + PAGE) }, active: true }, max - out.length);
		for (const row of rows) out.push({ id: row.id, ...row.data });
	}
	return out;
}
