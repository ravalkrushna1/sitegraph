// Platform-neutral graph model. No EmDash, React or storage imports in src/domain/.

export const NODE_TYPES = ["CONTENT", "URL", "FORM", "SERVICE", "WORKFLOW", "TEAM_MEMBER"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Node types a person can create; CONTENT and URL only come from scans. */
export const DOCUMENTED_NODE_TYPES = ["FORM", "SERVICE", "WORKFLOW", "TEAM_MEMBER"] as const;

export const RELATION_TYPES = [
	"PUBLISHES_AS",
	"LINKS_TO",
	"SUBMITS_TO",
	"DEPENDS_ON",
	"PART_OF",
	"OWNED_BY",
	"RELATED_TO",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/** Relations a person can document; PUBLISHES_AS and LINKS_TO only come from scans. */
export const DOCUMENTED_RELATION_TYPES = [
	"SUBMITS_TO",
	"DEPENDS_ON",
	"PART_OF",
	"OWNED_BY",
	"RELATED_TO",
] as const;

// INFERRED is reserved: nothing produces it yet (SPEC D5).
export type Provenance = "DISCOVERED" | "DOCUMENTED" | "INFERRED";

export const CRITICALITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type Criticality = (typeof CRITICALITIES)[number];

export const SCHEMA_VERSION = 1;

/** Human context that scans must never overwrite. */
export interface Annotation {
	description?: string;
	criticality?: Criticality;
	notes?: string;
	docUrl?: string;
	lastVerifiedAt?: string;
}

export interface GraphNode extends Annotation {
	type: NodeType;
	label: string;
	/** Lowercased label, indexed for prefix search. */
	search: string;
	/** Stable outside reference: "posts/<id>" for content, the path for URLs. */
	ref: string;
	provenance: Provenance;
	/** URL nodes: true when a published entry lives at this path. */
	resolved?: boolean;
	active: boolean;
	firstSeenAt: string;
	lastSeenAt: string;
	schemaVersion: number;
}

export interface Evidence {
	sourceId?: string;
	fieldPath?: string;
	href?: string;
	observedAt?: string;
}

export interface GraphEdge {
	sourceNodeId: string;
	targetNodeId: string;
	relation: RelationType;
	/** Required for RELATED_TO. */
	label?: string;
	provenance: Provenance;
	evidence?: Evidence;
	active: boolean;
	/** Scan that last saw a discovered edge; reconciliation retires the rest. */
	scanId?: string;
	firstSeenAt: string;
	lastSeenAt: string;
	schemaVersion: number;
}

export const contentNodeId = (collection: string, entryId: string): string =>
	`content:${collection}:${entryId}`;

export const urlNodeId = (path: string): string => `url:${path}`;

export const edgeId = (
	source: string,
	relation: RelationType,
	target: string,
	fieldPath = "",
): string => `${source}|${relation}|${target}|${fieldPath}`;
