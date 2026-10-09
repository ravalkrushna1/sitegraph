import { apiFetch, parseApiResponse } from "emdash/plugin-utils";

import type { Criticality, GraphEdge, GraphNode, NodeType, RelationType } from "../domain/graph.js";
import type { Direction, ImpactHit } from "../domain/impact.js";

export type Node = GraphNode & { id: string };
export type Edge = GraphEdge & { id: string };

export interface Overview {
	siteUrl: string | null;
	counts: Record<NodeType, number>;
	edges: number;
	brokenLinks: number;
	scan: { running: ScanState | null; last: LastScan | null };
}

export interface ScanState {
	id: string;
	phase: string;
	processed: number;
	index: number;
	collections: unknown[];
}

export interface LastScan {
	finishedAt: string;
	status: "SUCCEEDED" | "PARTIAL";
	processed: number;
	retired: number;
	errors: string[];
}

export interface Neighborhood {
	center: Node;
	nodes: Node[];
	edges: Edge[];
	truncated: boolean;
	total: number;
}

export interface Impact {
	start: string;
	hits: Array<Omit<ImpactHit, "path"> & { path: Edge[] }>;
	edges: Edge[];
	nodes: Node[];
	truncated: boolean;
}

export interface NodeInput {
	id?: string;
	type?: NodeType;
	label?: string;
	description?: string;
	criticality?: Criticality | null;
	notes?: string;
	docUrl?: string;
	lastVerifiedAt?: string | null;
}

async function call<T>(route: string, body?: unknown): Promise<T> {
	const res = await apiFetch(`/_emdash/api/plugins/sitegraph/${route}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	return parseApiResponse<T>(res, "SiteGraph couldn't complete that request.");
}

export const api = {
	overview: () => call<Overview>("overview"),
	startScan: () => call<{ state: ScanState }>("scan/start"),
	scanStep: () => call<{ state: ScanState | null; last: LastScan | null; done: boolean }>("scan/step"),
	search: (q: string, opts: { type?: NodeType; broken?: boolean } = {}) =>
		call<{ items: Node[]; cursor: string | null }>("nodes/search", { q, ...opts }),
	neighborhood: (nodeId: string) => call<Neighborhood>("graph/neighborhood", { nodeId }),
	impact: (nodeId: string, direction: Direction, depth: number) =>
		call<Impact>("graph/impact", { nodeId, direction, depth }),
	saveNode: (input: NodeInput) => call<Node>("nodes/save", input),
	deleteNode: (id: string) => call<{ deleted: string }>("nodes/delete", { id }),
	saveEdge: (input: { sourceNodeId: string; targetNodeId: string; relation: RelationType; label?: string }) =>
		call<Edge>("edges/save", input),
	deleteEdge: (id: string) => call<{ deleted: string }>("edges/delete", { id }),
	export: () => call<unknown>("export"),
};

export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const TYPE_LABEL: Record<NodeType, string> = {
	CONTENT: "Entry",
	URL: "URL",
	FORM: "Form",
	SERVICE: "Service",
	WORKFLOW: "Workflow",
	TEAM_MEMBER: "Person or team",
};

export const RELATION_LABEL: Record<RelationType, string> = {
	PUBLISHES_AS: "is published at",
	LINKS_TO: "links to",
	SUBMITS_TO: "submits to",
	DEPENDS_ON: "depends on",
	PART_OF: "is part of",
	OWNED_BY: "is owned by",
	RELATED_TO: "is related to",
};

export const PROVENANCE_LABEL = {
	DISCOVERED: "Found by scan",
	DOCUMENTED: "Added by a person",
	INFERRED: "Guessed",
} as const;

/** A URL node with no published entry behind it: an internal link that leads nowhere. */
export const isBroken = (node: Pick<Node, "type" | "resolved">): boolean => node.type === "URL" && node.resolved === false;
