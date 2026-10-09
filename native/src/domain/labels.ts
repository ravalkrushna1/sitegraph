// Plain-language names for the graph, shared by both editions' UIs.

import type { NodeType, Provenance, RelationType } from "./graph.js";

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

/** The same relationships read from the other end ("A links to B" → "B is linked from A"). */
export const REVERSE_RELATION_LABEL: Record<RelationType, string> = {
	PUBLISHES_AS: "is the URL of",
	LINKS_TO: "is linked from",
	SUBMITS_TO: "receives from",
	DEPENDS_ON: "is needed by",
	PART_OF: "includes",
	OWNED_BY: "owns",
	RELATED_TO: "is related to",
};

export const PROVENANCE_LABEL: Record<Provenance, string> = {
	DISCOVERED: "Found by scan",
	DOCUMENTED: "Added by a person",
	INFERRED: "Guessed",
};
