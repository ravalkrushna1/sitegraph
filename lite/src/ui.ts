// Block Kit rendering for SiteGraph Lite. Pure functions: data in, blocks out.

import type { Block, BlockResponse, LinkElement, TableBlock } from "@emdash-cms/blocks";

import type { EdgeRecord as GraphEdgeRecord } from "../../native/src/domain/impact.js";
import {
	CRITICALITIES,
	DOCUMENTED_NODE_TYPES,
	DOCUMENTED_RELATION_TYPES,
	type GraphNode,
} from "../../native/src/domain/graph.js";
import { PROVENANCE_LABEL, RELATION_LABEL, REVERSE_RELATION_LABEL, TYPE_LABEL } from "../../native/src/domain/labels.js";
import type { LastScan, ScanState } from "../../native/src/scan.js";

export type Node = GraphNode & { id: string };
export type Edge = GraphEdgeRecord;

export type View = "connections" | "inbound" | "outbound";

const isBroken = (n: Pick<Node, "type" | "resolved">) => n.type === "URL" && n.resolved === false;
const kindOf = (n: Node) => (isBroken(n) ? "Broken link" : TYPE_LABEL[n.type]);
const titleCase = (s: string) => s[0] + s.slice(1).toLowerCase();
const date = (iso?: string) => (iso ? new Date(iso).toISOString().slice(0, 10) : "");

/** Where to open the real thing a node stands for: the entry editor, or its doc link. */
function openLink(node: Node): LinkElement | undefined {
	if (node.type === "CONTENT") {
		const [collection, id] = node.ref.split("/");
		if (collection && id) return { type: "link", label: "Open in editor", target: { kind: "content", collection, id } };
	}
	if (node.docUrl) return { type: "link", label: "Open documentation", target: { kind: "external", url: node.docUrl } };
	return undefined;
}

const exploreButton = (node: Node) => ({ type: "button" as const, action_id: "open", label: "Explore", value: node.id });

export function errorResponse(message: string): BlockResponse {
	return { blocks: [{ type: "banner", variant: "error", title: "SiteGraph couldn't do that", description: message }] };
}

// ── Overview ─────────────────────────────────────────────────────────────────

export interface OverviewData {
	siteUrl: string | null;
	counts: Record<Node["type"], number>;
	edges: number;
	brokenLinks: number;
	scan: { running: ScanState | null; last: LastScan | null };
}

export interface BrokenRow {
	path: string;
	href: string;
	page: Node;
	field?: string;
}

function scanStatus(scan: OverviewData["scan"]): string {
	if (scan.running) return `Scanning: ${scan.running.processed} entries read so far. It keeps going in the background; reload to see progress.`;
	if (!scan.last) return "Your site hasn't been scanned yet.";
	const when = `Last scanned ${scan.last.finishedAt.replace("T", " ").slice(0, 16)} UTC`;
	return scan.last.status === "PARTIAL"
		? `${when}. ${scan.last.errors.length} entries couldn't be read, so nothing was cleared from the map.`
		: `${when}. Read ${scan.last.processed} entries.`;
}

const HOW_TO: Block = {
	type: "accordion",
	label: "How to use SiteGraph",
	default_open: false,
	blocks: [
		{ type: "context", text: "1. Scan once. After that the map updates itself whenever an entry is saved, published or deleted." },
		{ type: "context", text: "2. Fix broken links below: each row is a page that links somewhere nothing is published." },
		{ type: "context", text: "3. Explore: pick a page to see what it links to, what links to it, and what depends on it before you change it." },
		{ type: "context", text: "4. Document: add the forms, services, workflows and owners your CMS can't see, and how they connect." },
	],
};

export function renderOverview(data: OverviewData, broken: BrokenRow[], notice?: string): BlockResponse {
	const c = data.counts;
	const documented = c.FORM + c.SERVICE + c.WORKFLOW + c.TEAM_MEMBER;
	const scanned = Boolean(data.scan.last);
	const blocks: Block[] = [
		{ type: "header", text: "SiteGraph" },
		{ type: "context", text: "Finds broken internal links and shows what depends on a page. Read-only: it never changes your content." },
	];
	if (!data.siteUrl) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "Your site URL isn't set",
			description: "Only relative links (like /about) are recognised until it is. Set it in Settings.",
		});
	}
	if (notice) blocks.push({ type: "banner", variant: "default", description: notice });
	blocks.push(
		{
			type: "stats",
			items: [
				{ label: "Entries", value: c.CONTENT },
				{ label: "Connections", value: data.edges },
				{ label: "Broken links", value: data.brokenLinks, ...(data.brokenLinks ? { trend: "down" as const } : {}) },
				{ label: "Documented things", value: documented },
			],
		},
		{
			type: "section",
			text: scanStatus(data.scan),
			accessory: {
				type: "button",
				action_id: "scan",
				label: data.scan.running ? "Continue scan" : scanned ? "Rescan site" : "Scan site",
				style: "primary",
			},
		},
	);

	if (!scanned && !data.scan.running) {
		blocks.push({
			type: "empty",
			title: "Map your site",
			description: "Scan once to read your published entries and the links between them. Nothing on your site changes.",
		});
	} else {
		blocks.push({ type: "header", text: "Broken links" });
		const table: TableBlock = {
			type: "table",
			page_action_id: "broken_page",
			columns: [
				{ key: "path", label: "Links to", format: "code" },
				{ key: "page", label: "On page" },
				{ key: "field", label: "Where" },
				{ key: "fix", label: "Fix", format: "element" },
			],
			rows: broken.map((row) => ({
				path: row.path,
				page: row.page.label,
				field: row.field ?? "",
				fix: openLink(row.page),
			})),
			empty_text: "No broken internal links. Links to your home page, listings and files are never counted as broken.",
		};
		blocks.push(table);
		if (broken.length && data.brokenLinks > new Set(broken.map((b) => b.path)).size) {
			blocks.push({ type: "context", text: "Showing the first 100. Fix these and rescan to see more." });
		}
	}
	blocks.push(HOW_TO);
	return { blocks };
}

export function renderWidget(data: OverviewData): BlockResponse {
	if (!data.scan.last) {
		return {
			blocks: [
				{ type: "context", text: "Your site hasn't been mapped yet." },
				{ type: "actions", elements: [{ type: "link", label: "Run the first scan", target: { kind: "plugin-page", path: "/overview" } }] },
			],
		};
	}
	return {
		blocks: [
			{
				type: "stats",
				items: [
					{ label: "Entries mapped", value: data.counts.CONTENT },
					{ label: "Broken internal links", value: data.brokenLinks },
				],
			},
			{ type: "actions", elements: [{ type: "link", label: "Open SiteGraph", target: { kind: "plugin-page", path: "/overview" } }] },
		],
	};
}

// ── Explore ──────────────────────────────────────────────────────────────────

export interface ExploreSelection {
	node: Node;
	view: View;
	depth: number;
	edges?: Edge[];
	neighbours?: Node[];
	impact?: { hits: Array<{ nodeId: string; depth: number; path: Edge[]; confirmed: boolean }>; nodes: Node[]; truncated: boolean };
}

function pickerOptions(nodes: Node[]) {
	return [...nodes]
		.sort((a, b) => a.label.localeCompare(b.label))
		.map((n) => ({ label: `${n.label} (${kindOf(n).toLowerCase()})`, value: n.id }));
}

function exploreForm(nodes: Node[], selected?: ExploreSelection): Block {
	return {
		type: "form",
		block_id: "explore",
		fields: [
			{
				type: "combobox",
				action_id: "node",
				label: "Page, URL or documented item",
				placeholder: "Start typing a title or /path",
				options: pickerOptions(nodes),
				...(selected ? { initial_value: selected.node.id } : {}),
			},
			{
				type: "select",
				action_id: "view",
				label: "Show",
				initial_value: selected?.view ?? "connections",
				options: [
					{ label: "Its connections", value: "connections" },
					{ label: "What depends on it (impact)", value: "inbound" },
					{ label: "What it depends on", value: "outbound" },
				],
			},
			{
				type: "select",
				action_id: "depth",
				label: "Steps to follow (impact only)",
				initial_value: String(selected?.depth ?? 2),
				options: [
					{ label: "1", value: "1" },
					{ label: "2", value: "2" },
					{ label: "3", value: "3" },
				],
				condition: { field: "view", neq: "connections" },
			},
		],
		submit: { label: "Show", action_id: "explore" },
	};
}

function nodeSummary(node: Node): Block[] {
	const blocks: Block[] = [
		{ type: "header", text: node.label },
		{
			type: "fields",
			fields: [
				{ label: "Kind", value: kindOf(node) },
				{ label: "Source", value: PROVENANCE_LABEL[node.provenance] },
				{ label: "Criticality", value: node.criticality ? titleCase(node.criticality) : "Not set" },
				{ label: "Last checked by a person", value: date(node.lastVerifiedAt) || "Never" },
			],
		},
	];
	if (node.description) blocks.push({ type: "section", text: node.description });
	if (isBroken(node)) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "Broken link",
			description: "No published entry lives at this path. Pages linking here lead to a 404.",
		});
	}
	const link = openLink(node);
	if (link) blocks.push({ type: "actions", elements: [link] });
	return blocks;
}

function connectionsTable(sel: ExploreSelection): Block {
	const names = new Map((sel.neighbours ?? []).map((n) => [n.id, n]));
	const rows = (sel.edges ?? []).flatMap((edge) => {
		const outgoing = edge.sourceNodeId === sel.node.id;
		const otherId = outgoing ? edge.targetNodeId : edge.sourceNodeId;
		const other = names.get(otherId);
		if (!other) return [];
		// Edges that land on this entry's URL rather than the entry itself still mean "links here".
		const relation = outgoing ? RELATION_LABEL[edge.relation] : edge.targetNodeId === sel.node.id ? REVERSE_RELATION_LABEL[edge.relation] : "links here";
		return [
			{
				relation: edge.label ? `${relation} (${edge.label})` : relation,
				item: other.label,
				kind: kindOf(other),
				source: PROVENANCE_LABEL[edge.provenance],
				open: exploreButton(other),
			},
		];
	});
	return {
		type: "table",
		page_action_id: "connections_page",
		columns: [
			{ key: "relation", label: "This" },
			{ key: "item", label: "Item" },
			{ key: "kind", label: "Kind", format: "badge" },
			{ key: "source", label: "Source" },
			{ key: "open", label: "", format: "element" },
		],
		rows,
		empty_text: "Nothing is connected to this yet.",
	};
}

function impactBlocks(sel: ExploreSelection): Block[] {
	const result = sel.impact;
	if (!result) return [];
	const names = new Map(result.nodes.map((n) => [n.id, n]));
	const name = (id: string) => names.get(id)?.label ?? id;
	// A page's own URL is the same page; only show URLs that are broken.
	const hits = result.hits
		.filter((h) => {
			const n = names.get(h.nodeId);
			return n && (n.type !== "URL" || isBroken(n));
		})
		.sort((a, b) => a.depth - b.depth);
	const blocks: Block[] = [
		{
			type: "context",
			text:
				sel.view === "inbound"
					? `If “${sel.node.label}” changes, these could be affected. A connection is potential impact, not proof something will break.`
					: `“${sel.node.label}” relies on these.`,
		},
		{
			type: "table",
			page_action_id: "impact_page",
			columns: [
				{ key: "item", label: "Item" },
				{ key: "how", label: "How far", format: "badge" },
				{ key: "path", label: "Why" },
				{ key: "certainty", label: "Certainty" },
				{ key: "open", label: "", format: "element" },
			],
			rows: hits.map((h) => {
				const node = names.get(h.nodeId)!;
				return {
					item: `${node.label} (${kindOf(node).toLowerCase()})`,
					how: h.depth <= 1 ? "Direct" : `${h.depth} steps`,
					path: h.path
						.filter((e) => e.relation !== "PUBLISHES_AS")
						.map((e) => `${name(e.sourceNodeId)} ${RELATION_LABEL[e.relation]} ${name(e.targetNodeId)}`)
						.join(", then "),
					certainty: h.confirmed ? "Confirmed" : "Includes a guess",
					open: exploreButton(node),
				};
			}),
			empty_text: `Nothing found within ${sel.depth} step${sel.depth > 1 ? "s" : ""}.`,
		},
	];
	if (result.truncated) blocks.push({ type: "context", text: "Stopped at 500 items. Try fewer steps." });
	return blocks;
}

function notesForm(node: Node): Block {
	return {
		type: "form",
		block_id: "notes",
		fields: [
			{ type: "text_input", action_id: "description", label: "Purpose", multiline: true, initial_value: node.description ?? "", placeholder: "What does this do for the business?" },
			{
				type: "select",
				action_id: "criticality",
				label: "Criticality",
				initial_value: node.criticality ?? "",
				options: [{ label: "Not set", value: "" }, ...CRITICALITIES.map((c) => ({ label: titleCase(c), value: c }))],
			},
			{ type: "text_input", action_id: "notes", label: "Maintenance notes", multiline: true, initial_value: node.notes ?? "", placeholder: "Never paste passwords or API keys here." },
			{ type: "text_input", action_id: "docUrl", label: "Runbook or doc link", initial_value: node.docUrl ?? "", placeholder: "https://" },
			{ type: "toggle", action_id: "checked", label: "Mark as checked by a person today", initial_value: false },
		],
		submit: { label: "Save notes", action_id: `note:${node.id}` },
	};
}

export function renderExplore(nodes: Node[], capped: boolean, sel?: ExploreSelection): BlockResponse {
	const blocks: Block[] = [
		{ type: "header", text: "Explore" },
		{ type: "context", text: "Pick something to see what it's connected to, or what depends on it before you change it." },
	];
	if (nodes.length === 0) {
		blocks.push({
			type: "empty",
			title: "Nothing to explore yet",
			description: "Scan your site from the SiteGraph page first.",
			actions: [{ type: "link", label: "Go to SiteGraph", target: { kind: "plugin-page", path: "/overview" } }],
		});
		return { blocks };
	}
	blocks.push(exploreForm(nodes, sel));
	if (capped) blocks.push({ type: "context", text: "The list shows the first 500 items." });
	if (sel) {
		blocks.push({ type: "divider" }, ...nodeSummary(sel.node));
		blocks.push(...(sel.view === "connections" ? [connectionsTable(sel)] : impactBlocks(sel)));
		blocks.push({ type: "accordion", label: "Notes about this item", default_open: false, blocks: [notesForm(sel.node)] });
	}
	return { blocks };
}

// ── Document ─────────────────────────────────────────────────────────────────

export function renderDocument(all: Node[], documented: { nodes: Node[]; edges: Edge[] }): BlockResponse {
	const names = new Map(all.map((n) => [n.id, n.label]));
	const blocks: Block[] = [
		{ type: "header", text: "Document" },
		{
			type: "context",
			text: "Record what your CMS can't see: the form that sends leads to your CRM, the workflow a page belongs to, who owns it.",
		},
		{
			type: "columns",
			columns: [
				[
					{ type: "header", text: "Add an item" },
					{
						type: "form",
						block_id: "add_node",
						fields: [
							{ type: "select", action_id: "kind", label: "Kind", initial_value: "SERVICE", options: DOCUMENTED_NODE_TYPES.map((t) => ({ label: TYPE_LABEL[t], value: t })) },
							{ type: "text_input", action_id: "name", label: "Name", placeholder: "e.g. HubSpot CRM" },
							{ type: "text_input", action_id: "description", label: "Purpose (optional)" },
							{
								type: "select",
								action_id: "criticality",
								label: "Criticality",
								initial_value: "",
								options: [{ label: "Not set", value: "" }, ...CRITICALITIES.map((c) => ({ label: titleCase(c), value: c }))],
							},
						],
						submit: { label: "Add item", action_id: "add_node" },
					},
				],
				[
					{ type: "header", text: "Add a relationship" },
					{
						type: "form",
						block_id: "add_edge",
						fields: [
							{ type: "combobox", action_id: "from", label: "This", placeholder: "Pick a page or item", options: pickerOptions(all) },
							{
								type: "select",
								action_id: "relation",
								label: "Relationship",
								initial_value: "DEPENDS_ON",
								options: DOCUMENTED_RELATION_TYPES.map((r) => ({ label: RELATION_LABEL[r], value: r })),
							},
							{ type: "combobox", action_id: "to", label: "That", placeholder: "Pick a page or item", options: pickerOptions(all) },
							{ type: "text_input", action_id: "label", label: "How are they related?", condition: { field: "relation", eq: "RELATED_TO" } },
						],
						submit: { label: "Add relationship", action_id: "add_edge" },
					},
				],
			],
		},
		{ type: "header", text: "Documented items" },
		{
			type: "table",
			page_action_id: "doc_nodes_page",
			columns: [
				{ key: "name", label: "Name" },
				{ key: "kind", label: "Kind", format: "badge" },
				{ key: "criticality", label: "Criticality" },
				{ key: "purpose", label: "Purpose" },
				{ key: "open", label: "", format: "element" },
				{ key: "remove", label: "", format: "element" },
			],
			rows: documented.nodes.map((n) => ({
				name: n.label,
				kind: TYPE_LABEL[n.type],
				criticality: n.criticality ? titleCase(n.criticality) : "",
				purpose: n.description ?? "",
				open: exploreButton(n),
				remove: {
					type: "button",
					action_id: "del_node",
					label: "Delete",
					style: "danger",
					value: n.id,
					confirm: { title: `Delete “${n.label}”?`, text: "This removes it and every relationship to it from SiteGraph. Your site isn't affected.", confirm: "Delete", deny: "Cancel", style: "danger" },
				},
			})),
			empty_text: "Nothing documented yet. Add your CRM, forms or workflows above.",
		},
		{ type: "header", text: "Documented relationships" },
		{
			type: "table",
			page_action_id: "doc_edges_page",
			columns: [
				{ key: "from", label: "This" },
				{ key: "relation", label: "Relationship" },
				{ key: "to", label: "That" },
				{ key: "remove", label: "", format: "element" },
			],
			rows: documented.edges.map((e) => ({
				from: names.get(e.sourceNodeId) ?? "(removed)",
				relation: e.label ? `${RELATION_LABEL[e.relation]} (${e.label})` : RELATION_LABEL[e.relation],
				to: names.get(e.targetNodeId) ?? "(removed)",
				remove: {
					type: "button",
					action_id: "del_edge",
					label: "Remove",
					style: "danger",
					value: e.id,
					confirm: { title: "Remove this relationship?", text: "Only SiteGraph changes; your site isn't affected.", confirm: "Remove", deny: "Cancel", style: "danger" },
				},
			})),
			empty_text: "No relationships recorded yet.",
		},
	];
	return { blocks };
}
