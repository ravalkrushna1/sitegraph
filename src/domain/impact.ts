import type { GraphEdge } from "./graph.js";

export type Direction = "inbound" | "outbound" | "both";

export const MAX_DEPTH = 3;
export const MAX_NODES = 500;
export const MAX_EDGES = 1000;

export interface EdgeRecord extends GraphEdge {
	id: string;
}

/** Fetch active edges touching any of the given nodes, in the given direction. */
export type EdgeFetcher = (nodeIds: string[], direction: "inbound" | "outbound") => Promise<EdgeRecord[]>;

export interface ImpactHit {
	nodeId: string;
	depth: number;
	/** Edges from the start node to this one, in order. */
	path: EdgeRecord[];
	/** True when every edge on the path is DISCOVERED or DOCUMENTED. */
	confirmed: boolean;
}

export interface ImpactResult {
	start: string;
	hits: ImpactHit[];
	edges: EdgeRecord[];
	truncated: boolean;
}

/**
 * Bounded breadth-first search. "outbound" follows what the start node points at;
 * "inbound" finds what points at it (what could break if it changes). Each node is
 * reached once, by its shortest path, so cycles end the walk. Reachability is potential
 * impact, never proof of it.
 */
export async function impact(
	start: string,
	direction: Direction,
	depth: number,
	fetchEdges: EdgeFetcher,
): Promise<ImpactResult> {
	const maxDepth = Math.max(1, Math.min(MAX_DEPTH, Math.floor(depth)));
	const reached = new Map<string, ImpactHit>([[start, { nodeId: start, depth: 0, path: [], confirmed: true }]]);
	const edges = new Map<string, EdgeRecord>();
	let frontier = [start];
	let truncated = false;

	for (let level = 1; level <= maxDepth && frontier.length > 0 && !truncated; level++) {
		const next: string[] = [];
		// An entry and its URL are one page: PUBLISHES_AS is walked both ways and costs no
		// depth, otherwise "inbound from an entry" would spend a hop before reaching linkers.
		let batch = frontier;
		while (batch.length > 0 && !truncated) {
			const samePage: string[] = [];
			for (const dir of ["outbound", "inbound"] as const) {
				for (const edge of await fetchEdges(batch, dir)) {
					const free = edge.relation === "PUBLISHES_AS";
					if (direction !== "both" && dir !== direction && !free) continue;
					const from = dir === "outbound" ? edge.sourceNodeId : edge.targetNodeId;
					const to = dir === "outbound" ? edge.targetNodeId : edge.sourceNodeId;
					const parent = reached.get(from);
					if (!parent) continue;
					if (edges.size >= MAX_EDGES) {
						truncated = true;
						break;
					}
					edges.set(edge.id, edge);
					if (reached.has(to)) continue;
					if (reached.size >= MAX_NODES) {
						truncated = true;
						break;
					}
					reached.set(to, {
						nodeId: to,
						depth: free ? parent.depth : level,
						path: [...parent.path, edge],
						confirmed: parent.confirmed && edge.provenance !== "INFERRED",
					});
					(free ? samePage : next).push(to);
				}
			}
			batch = samePage;
		}
		frontier = next;
	}

	reached.delete(start);
	return { start, hits: [...reached.values()], edges: [...edges.values()], truncated };
}
