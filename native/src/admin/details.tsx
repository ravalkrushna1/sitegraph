import { Badge, Button, Input } from "@cloudflare/kumo";
import * as React from "react";

import { CRITICALITIES, DOCUMENTED_RELATION_TYPES, type RelationType } from "../domain/graph.js";
import type { Direction } from "../domain/impact.js";
import {
	api,
	type Edge,
	type Impact,
	isBroken,
	message,
	type Node,
	PROVENANCE_LABEL,
	RELATION_LABEL,
	TYPE_LABEL,
} from "./api.js";
import { fieldName } from "../domain/labels.js";
import { NodePicker } from "./node-picker.js";

const formatDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : null);

/** Where to see or change the real thing this node stands for. */
function SourceLink({ node, siteUrl }: { node: Node; siteUrl: string | null }) {
	if (node.type === "CONTENT") {
		const [collection, id] = node.ref.split("/");
		return <a href={`/_emdash/admin/content/${collection}/${id}`}>Open in editor</a>;
	}
	if (node.type === "URL" && !isBroken(node)) return <a href={`${siteUrl ?? ""}${node.ref}`} target="_blank" rel="noreferrer">View page</a>;
	if (node.docUrl) return <a href={node.docUrl} target="_blank" rel="noreferrer">Open documentation</a>;
	return null;
}

export function Details({
	node,
	edges,
	lookup,
	siteUrl,
	onChanged,
	onFocus,
	onShowImpact,
}: {
	node: Node;
	edges: Edge[];
	lookup: (id: string) => Node | undefined;
	siteUrl: string | null;
	onChanged: () => void;
	onFocus: (id: string) => void;
	onShowImpact: (impact: Impact) => void;
}) {
	const [tab, setTab] = React.useState<"about" | "impact">("about");
	React.useEffect(() => setTab("about"), [node.id]);

	return (
		<aside className="sg-details" aria-label={`Details for ${node.label}`}>
			<header className="sg-details-head">
				<span className="sg-kind" data-type={node.type}>
					{isBroken(node) ? "Broken link" : TYPE_LABEL[node.type]}
				</span>
				<h2>{node.label}</h2>
				<p className="sg-muted">
					{PROVENANCE_LABEL[node.provenance]}
					{node.lastSeenAt ? `, last seen ${formatDate(node.lastSeenAt)}` : ""}
				</p>
				{isBroken(node) ? (
					<p className="sg-warn">No published entry lives at this path. The pages linking here lead to a 404.</p>
				) : null}
				<SourceLink node={node} siteUrl={siteUrl} />
			</header>

			<div className="sg-tabs" role="tablist">
				<button role="tab" aria-selected={tab === "about"} onClick={() => setTab("about")}>
					About
				</button>
				<button role="tab" aria-selected={tab === "impact"} onClick={() => setTab("impact")}>
					Impact
				</button>
			</div>

			{tab === "about" ? (
				<>
					<AnnotationForm key={node.id} node={node} onSaved={onChanged} />
					<Connections node={node} edges={edges} lookup={lookup} onChanged={onChanged} onFocus={onFocus} />
					<AddRelationship node={node} onSaved={onChanged} />
					{node.provenance === "DOCUMENTED" ? <DeleteNode node={node} onDeleted={onChanged} /> : null}
				</>
			) : (
				<ImpactView key={node.id} node={node} lookup={lookup} onFocus={onFocus} onShow={onShowImpact} />
			)}
		</aside>
	);
}

function AnnotationForm({ node, onSaved }: { node: Node; onSaved: () => void }) {
	const [label, setLabel] = React.useState(node.label);
	const [description, setDescription] = React.useState(node.description ?? "");
	const [criticality, setCriticality] = React.useState(node.criticality ?? "");
	const [notes, setNotes] = React.useState(node.notes ?? "");
	const [docUrl, setDocUrl] = React.useState(node.docUrl ?? "");
	const [status, setStatus] = React.useState<{ busy?: boolean; error?: string; saved?: boolean }>({});

	const save = async (verify = false) => {
		setStatus({ busy: true });
		try {
			await api.saveNode({
				id: node.id,
				...(node.provenance === "DOCUMENTED" ? { label } : {}),
				description,
				criticality: (criticality || null) as Node["criticality"] | null,
				notes,
				docUrl,
				...(verify ? { lastVerifiedAt: new Date().toISOString() } : {}),
			});
			setStatus({ saved: true });
			onSaved();
		} catch (error) {
			setStatus({ error: message(error) });
		}
	};

	return (
		<form
			className="sg-section sg-form"
			onSubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<h3>What it is and why it matters</h3>
			{node.provenance === "DOCUMENTED" ? <Input label="Name" value={label} onChange={(e) => setLabel(e.target.value)} required /> : null}
			<label className="sg-field">
				<span>Purpose</span>
				<textarea rows={2} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} placeholder="What does this do for the business?" />
			</label>
			<label className="sg-field">
				<span>Criticality</span>
				<select value={criticality} onChange={(e) => setCriticality(e.target.value as typeof criticality)}>
					<option value="">Not set</option>
					{CRITICALITIES.map((c) => (
						<option key={c} value={c}>
							{c[0] + c.slice(1).toLowerCase()}
						</option>
					))}
				</select>
			</label>
			<label className="sg-field">
				<span>Maintenance notes</span>
				<textarea rows={3} value={notes} maxLength={5000} onChange={(e) => setNotes(e.target.value)} placeholder="Never paste passwords or API keys here. Link to your password manager instead." />
			</label>
			<Input label="Runbook or doc link" type="url" value={docUrl} onChange={(e) => setDocUrl(e.target.value)} placeholder="https://" />
			<p className="sg-muted">
				{node.lastVerifiedAt ? `Last checked by a person on ${formatDate(node.lastVerifiedAt)}.` : "Nobody has confirmed this yet."}
			</p>
			<div className="sg-row">
				<Button type="submit" variant="primary" size="sm" loading={status.busy}>
					Save
				</Button>
				<Button type="button" size="sm" onClick={() => void save(true)} disabled={status.busy}>
					Save and mark checked
				</Button>
			</div>
			{status.error ? <p role="alert" className="sg-error">{status.error}</p> : null}
			{status.saved ? <p role="status" className="sg-muted">Saved.</p> : null}
		</form>
	);
}

function Connections({
	node,
	edges,
	lookup,
	onChanged,
	onFocus,
}: {
	node: Node;
	edges: Edge[];
	lookup: (id: string) => Node | undefined;
	onChanged: () => void;
	onFocus: (id: string) => void;
}) {
	const [error, setError] = React.useState<string>();
	const mine = edges.filter((e) => e.sourceNodeId === node.id || e.targetNodeId === node.id);

	const remove = async (edge: Edge) => {
		const other = lookup(edge.sourceNodeId === node.id ? edge.targetNodeId : edge.sourceNodeId);
		if (!window.confirm(`Remove "${RELATION_LABEL[edge.relation]} ${other?.label ?? "this node"}"? This only changes SiteGraph, not your site.`)) return;
		try {
			await api.deleteEdge(edge.id);
			onChanged();
		} catch (e) {
			setError(message(e));
		}
	};

	return (
		<section className="sg-section">
			<h3>Connections ({mine.length})</h3>
			{mine.length === 0 ? <p className="sg-muted">Nothing connects here yet.</p> : null}
			<ul className="sg-list">
				{mine.map((edge) => {
					const outgoing = edge.sourceNodeId === node.id;
					const other = lookup(outgoing ? edge.targetNodeId : edge.sourceNodeId);
					return (
						<li key={edge.id} className="sg-conn">
							<span className="sg-conn-rel">
								{outgoing ? RELATION_LABEL[edge.relation] : `← ${RELATION_LABEL[edge.relation]}`}
								{edge.label ? ` (${edge.label})` : ""}
							</span>
							<button type="button" className="sg-link" onClick={() => onFocus(other?.id ?? (outgoing ? edge.targetNodeId : edge.sourceNodeId))}>
								{other?.label ?? "Not loaded yet"}
							</button>
							<span className="sg-prov" data-prov={edge.provenance}>
								{PROVENANCE_LABEL[edge.provenance]}
								{edge.evidence?.fieldPath ? `, in the ${fieldName(edge.evidence.fieldPath)} field` : ""}
							</span>
							{edge.provenance === "DOCUMENTED" ? (
								<button type="button" className="sg-link sg-danger" onClick={() => void remove(edge)}>
									Remove
								</button>
							) : null}
						</li>
					);
				})}
			</ul>
			{error ? <p role="alert" className="sg-error">{error}</p> : null}
		</section>
	);
}

function AddRelationship({ node, onSaved }: { node: Node; onSaved: () => void }) {
	const [relation, setRelation] = React.useState<RelationType>("DEPENDS_ON");
	const [target, setTarget] = React.useState<Node | null>(null);
	const [label, setLabel] = React.useState("");
	const [status, setStatus] = React.useState<{ busy?: boolean; error?: string }>({});

	const save = async () => {
		if (!target) return;
		setStatus({ busy: true });
		try {
			await api.saveEdge({ sourceNodeId: node.id, targetNodeId: target.id, relation, ...(label ? { label } : {}) });
			setTarget(null);
			setLabel("");
			setStatus({});
			onSaved();
		} catch (error) {
			setStatus({ error: message(error) });
		}
	};

	return (
		<form
			className="sg-section sg-form"
			onSubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<h3>Add a relationship</h3>
			<p className="sg-muted">Record what the CMS can't see, like the CRM a form feeds.</p>
			<label className="sg-field">
				<span>This {TYPE_LABEL[node.type].toLowerCase()}</span>
				<select value={relation} onChange={(e) => setRelation(e.target.value as RelationType)}>
					{DOCUMENTED_RELATION_TYPES.map((r) => (
						<option key={r} value={r}>
							{RELATION_LABEL[r]}
						</option>
					))}
				</select>
			</label>
			<NodePicker value={target} onChange={setTarget} exclude={node.id} />
			{relation === "RELATED_TO" ? (
				<Input label="How are they related?" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={200} />
			) : null}
			<Button type="submit" size="sm" disabled={!target} loading={status.busy}>
				Add relationship
			</Button>
			{status.error ? <p role="alert" className="sg-error">{status.error}</p> : null}
		</form>
	);
}

function DeleteNode({ node, onDeleted }: { node: Node; onDeleted: () => void }) {
	const [error, setError] = React.useState<string>();
	return (
		<section className="sg-section">
			<Button
				variant="destructive"
				size="sm"
				onClick={async () => {
					if (!window.confirm(`Delete "${node.label}" and every relationship to it? Your site isn't affected.`)) return;
					try {
						await api.deleteNode(node.id);
						onDeleted();
					} catch (e) {
						setError(message(e));
					}
				}}
			>
				Delete {TYPE_LABEL[node.type].toLowerCase()}
			</Button>
			{error ? <p role="alert" className="sg-error">{error}</p> : null}
		</section>
	);
}

const DIRECTIONS: Array<{ value: Direction; label: string }> = [
	{ value: "inbound", label: "What depends on this" },
	{ value: "outbound", label: "What this depends on" },
	{ value: "both", label: "Both" },
];

function ImpactView({
	node,
	lookup,
	onFocus,
	onShow,
}: {
	node: Node;
	lookup: (id: string) => Node | undefined;
	onFocus: (id: string) => void;
	onShow: (impact: Impact) => void;
}) {
	const [direction, setDirection] = React.useState<Direction>("inbound");
	const [depth, setDepth] = React.useState(2);
	const [result, setResult] = React.useState<Impact>();
	const [status, setStatus] = React.useState<{ busy?: boolean; error?: string }>({});

	const run = async () => {
		setStatus({ busy: true });
		try {
			setResult(await api.impact(node.id, direction, depth));
			setStatus({});
		} catch (error) {
			setStatus({ error: message(error) });
		}
	};

	const names = new Map(result?.nodes.map((n) => [n.id, n]));
	const name = (id: string) => names.get(id)?.label ?? lookup(id)?.label ?? id;
	const hits = (result?.hits ?? []).filter((h) => names.get(h.nodeId)?.type !== "URL" || isBroken(names.get(h.nodeId)!));
	const groups = [
		{ title: "Confirmed connections", items: hits.filter((h) => h.confirmed) },
		{ title: "Through a guessed link", items: hits.filter((h) => !h.confirmed) },
	];

	return (
		<section className="sg-section">
			<h3>If “{node.label}” changes</h3>
			<p className="sg-muted">Lists what's connected, step by step. A connection is potential impact, not proof something will break.</p>
			<div className="sg-row">
				<label className="sg-field">
					<span>Follow</span>
					<select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
						{DIRECTIONS.map((d) => (
							<option key={d.value} value={d.value}>
								{d.label}
							</option>
						))}
					</select>
				</label>
				<label className="sg-field">
					<span>Steps</span>
					<select value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
						{[1, 2, 3].map((d) => (
							<option key={d} value={d}>
								{d}
							</option>
						))}
					</select>
				</label>
			</div>
			<div className="sg-row">
				<Button size="sm" variant="primary" onClick={() => void run()} loading={status.busy}>
					Check impact
				</Button>
				{result ? (
					<Button size="sm" onClick={() => onShow(result)}>
						Show on graph
					</Button>
				) : null}
			</div>
			{status.error ? <p role="alert" className="sg-error">{status.error}</p> : null}

			{result ? (
				hits.length === 0 ? (
					<p className="sg-muted">Nothing is connected in that direction within {depth} step{depth > 1 ? "s" : ""}.</p>
				) : (
					groups
						.filter((g) => g.items.length)
						.map((group) => (
							<div key={group.title} className="sg-impact-group">
								<h4>
									{group.title} ({group.items.length})
								</h4>
								<ol className="sg-list">
									{group.items
										.sort((a, b) => a.depth - b.depth)
										.map((hit) => (
											<li key={hit.nodeId} className="sg-hit">
												<button type="button" className="sg-link" onClick={() => onFocus(hit.nodeId)}>
													{name(hit.nodeId)}
												</button>
												<Badge variant={hit.depth <= 1 ? "warning" : "secondary"}>
													{hit.depth <= 1 ? "Direct" : `${hit.depth} steps away`}
												</Badge>
												<p className="sg-path">
													{hit.path
														.filter((e) => e.relation !== "PUBLISHES_AS")
														.map((e) => `${name(e.sourceNodeId)} ${RELATION_LABEL[e.relation]} ${name(e.targetNodeId)}`)
														.join(", then ")}
												</p>
											</li>
										))}
								</ol>
							</div>
						))
				)
			) : null}
			{result?.truncated ? <p className="sg-warn">Stopped early: more than 500 connected items. Narrow the direction or steps.</p> : null}
		</section>
	);
}
