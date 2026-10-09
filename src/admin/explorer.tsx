import { Button, Input, Loader } from "@cloudflare/kumo";
import * as React from "react";

import { DOCUMENTED_NODE_TYPES, NODE_TYPES, type NodeType } from "../domain/graph.js";
import {
	api,
	type Edge,
	type Impact,
	isBroken,
	type LastScan,
	message,
	type Node,
	type Overview,
	PROVENANCE_LABEL,
	RELATION_LABEL,
	TYPE_LABEL,
} from "./api.js";
import { Details } from "./details.js";
import { GraphCanvas } from "./graph-canvas.js";
import { type Point, relax, seedRing } from "./layout.js";
import { useNodeSearch } from "./node-picker.js";

interface Graph {
	nodes: Map<string, Node>;
	edges: Map<string, Edge>;
	pos: Map<string, Point>;
	expanded: Set<string>;
}

const EMPTY: Graph = { nodes: new Map(), edges: new Map(), pos: new Map(), expanded: new Set() };

function merge(graph: Graph, around: string, nodes: Node[], edges: Edge[]): Graph {
	const next: Graph = {
		nodes: new Map(graph.nodes),
		edges: new Map(graph.edges),
		pos: new Map(graph.pos),
		expanded: new Set(graph.expanded).add(around),
	};
	for (const n of nodes) next.nodes.set(n.id, n);
	for (const e of edges) next.edges.set(e.id, e);
	if (!next.pos.has(around)) next.pos.set(around, { x: 0, y: 0 });
	const fresh = seedRing(next.pos.get(around)!, nodes.map((n) => n.id), next.pos);
	if (fresh.size === 0) return next;
	for (const [id, p] of fresh) next.pos.set(id, p);
	// Only the newly shown nodes move, so what's already on screen stays where it was.
	next.pos = relax(next.pos, [...next.edges.values()], new Set(fresh.keys()));
	return next;
}

function useOverview() {
	const [overview, setOverview] = React.useState<Overview>();
	const [error, setError] = React.useState<string>();
	const load = React.useCallback(() => {
		api.overview().then(setOverview, (e: unknown) => setError(message(e)));
	}, []);
	React.useEffect(load, [load]);
	return { overview, error, reload: load };
}

export function Explorer() {
	const { overview, error: overviewError, reload } = useOverview();
	const [graph, setGraph] = React.useState<Graph>(EMPTY);
	const [centerId, setCenterId] = React.useState<string | null>(null);
	const [selectedId, setSelectedId] = React.useState<string | null>(null);
	const [view, setView] = React.useState<"graph" | "table">("graph");
	const [error, setError] = React.useState<string>();
	const [busy, setBusy] = React.useState(false);

	const focus = React.useCallback(async (id: string) => {
		setBusy(true);
		setError(undefined);
		try {
			const hood = await api.neighborhood(id);
			setGraph(merge(EMPTY, id, [hood.center, ...hood.nodes], hood.edges));
			setCenterId(id);
			setSelectedId(id);
			if (hood.truncated) setError(`Showing ${hood.edges.length} of ${hood.total} connections. Expand neighbours to explore further.`);
		} catch (e) {
			setError(message(e));
		} finally {
			setBusy(false);
		}
	}, []);

	const expand = React.useCallback(async (id: string) => {
		try {
			const hood = await api.neighborhood(id);
			setGraph((g) => merge(g, id, [hood.center, ...hood.nodes], hood.edges));
		} catch (e) {
			setError(message(e));
		}
	}, []);

	/** Re-read every expanded neighbourhood after an edit, keeping where things were drawn. */
	const refresh = React.useCallback(async () => {
		reload();
		const ids = [...graph.expanded];
		try {
			const hoods = await Promise.all(ids.map((id) => api.neighborhood(id).catch(() => null)));
			let next: Graph = { ...EMPTY, pos: graph.pos };
			hoods.forEach((hood, i) => {
				if (hood) next = merge(next, ids[i]!, [hood.center, ...hood.nodes], hood.edges);
			});
			setGraph(next);
			if (selectedId && !next.nodes.has(selectedId)) setSelectedId(null);
		} catch (e) {
			setError(message(e));
		}
	}, [graph, reload, selectedId]);

	const showImpact = React.useCallback((impact: Impact) => {
		const depthOf = new Map(impact.hits.map((h) => [h.nodeId, h.depth]));
		const pos = new Map<string, Point>([[impact.start, { x: 0, y: 0 }]]);
		const rings = new Map<number, string[]>();
		for (const n of impact.nodes) {
			if (n.id === impact.start) continue;
			const d = depthOf.get(n.id) ?? 1;
			rings.set(d, [...(rings.get(d) ?? []), n.id]);
		}
		for (const [d, ids] of rings) {
			ids.forEach((id, i) => {
				const angle = (2 * Math.PI * i) / ids.length - Math.PI / 2 + d * 0.6;
				const r = 260 * Math.max(d, 0.6);
				pos.set(id, { x: r * Math.cos(angle), y: r * Math.sin(angle) });
			});
		}
		const movable = new Set([...pos.keys()].filter((id) => id !== impact.start));
		setGraph({
			nodes: new Map(impact.nodes.map((n) => [n.id, n])),
			edges: new Map(impact.edges.map((e) => [e.id, e])),
			pos: relax(pos, impact.edges, movable),
			expanded: new Set([impact.start]),
		});
		setCenterId(impact.start);
		setView("graph");
	}, []);

	const nodes = [...graph.nodes.values()];
	const edges = [...graph.edges.values()];
	const selected = selectedId ? graph.nodes.get(selectedId) : undefined;
	const hasData = overview ? Object.values(overview.counts).some((c) => c > 0) : false;

	return (
		<div className="sg-root">
			<header className="sg-top">
				<div>
					<h1>SiteGraph</h1>
					<p className="sg-muted">How your pages, links and the services behind them depend on each other.</p>
				</div>
				<ScanButton overview={overview} onDone={() => void refresh()}>
					<ExportButton disabled={!hasData} />
				</ScanButton>
			</header>

			{overviewError ? <p role="alert" className="sg-error">{overviewError}</p> : null}
			{overview ? <Stats overview={overview} /> : <Loader />}

			{overview && !hasData && !overview.scan.running ? (
				<div className="sg-empty">
					<h2>Map your site</h2>
					<p>
						Run a scan to read your published entries and the links between them. It only reads content; nothing on
						your site changes. After that, the map updates itself whenever an entry is saved.
					</p>
				</div>
			) : (
				<div className="sg-workspace" data-has-details={selected ? "" : undefined}>
					<Finder key={overview?.scan.last?.finishedAt ?? "never"} onPick={(id) => void focus(id)} onCreated={(id) => void focus(id)} brokenCount={overview?.brokenLinks ?? 0} />

					<section className="sg-stage" aria-label="Graph">
						<div className="sg-stage-bar">
							<div className="sg-tabs" role="tablist">
								<button role="tab" aria-selected={view === "graph"} onClick={() => setView("graph")}>
									Graph
								</button>
								<button role="tab" aria-selected={view === "table"} onClick={() => setView("table")}>
									Table
								</button>
							</div>
							<Legend />
						</div>
						{error ? <p role="status" className="sg-warn sg-stage-note">{error}</p> : null}
						{busy ? (
							<div className="sg-stage-empty">
								<Loader />
							</div>
						) : nodes.length === 0 ? (
							<StageEmpty brokenCount={overview?.brokenLinks ?? 0} onPick={(id) => void focus(id)} />
						) : view === "graph" ? (
							<>
								<GraphCanvas
									nodes={nodes}
									edges={edges}
									positions={graph.pos}
									centerId={centerId}
									selectedId={selectedId}
									onSelect={setSelectedId}
									onExpand={(id) => void expand(id)}
									onMove={(id, p) => setGraph((g) => ({ ...g, pos: new Map(g.pos).set(id, p) }))}
								/>
								<p className="sg-hint">Click to inspect. Double-click to show its connections. Drag to rearrange.</p>
							</>
						) : (
							<GraphTable nodes={nodes} edges={edges} onSelect={setSelectedId} />
						)}
					</section>

					{selected ? (
						<Details
							node={selected}
							edges={edges}
							lookup={(id) => graph.nodes.get(id)}
							siteUrl={overview?.siteUrl ?? null}
							onChanged={() => void refresh()}
							onFocus={(id) => (graph.nodes.has(id) ? setSelectedId(id) : void focus(id))}
							onShowImpact={showImpact}
						/>
					) : null}
				</div>
			)}
		</div>
	);
}

function Stats({ overview }: { overview: Overview }) {
	const c = overview.counts;
	const documented = c.FORM + c.SERVICE + c.WORKFLOW + c.TEAM_MEMBER;
	return (
		<dl className="sg-stats">
			<div>
				<dt>Entries</dt>
				<dd>{c.CONTENT}</dd>
			</div>
			<div>
				<dt>Connections</dt>
				<dd>{overview.edges}</dd>
			</div>
			<div data-alert={overview.brokenLinks > 0 || undefined}>
				<dt>Broken links</dt>
				<dd>{overview.brokenLinks}</dd>
			</div>
			<div>
				<dt>Documented things</dt>
				<dd>{documented}</dd>
			</div>
			{!overview.siteUrl ? (
				<p className="sg-warn">
					Your site URL isn't set, so only relative links (like /about) are recognised. Set it in Settings.
				</p>
			) : null}
		</dl>
	);
}

function StageEmpty({ brokenCount, onPick }: { brokenCount: number; onPick: (id: string) => void }) {
	const [error, setError] = React.useState<string>();
	const showBroken = async () => {
		try {
			const first = (await api.search("", { broken: true })).items[0];
			if (first) onPick(first.id);
		} catch (e) {
			setError(message(e));
		}
	};
	return (
		<div className="sg-stage-empty">
			<div className="sg-stage-empty-body">
				<h2>How to use SiteGraph</h2>
				<ol className="sg-steps">
					<li>
						<strong>Pick something on the left.</strong> Its connections appear here. Double-click any box to follow
						its connections further.
					</li>
					<li>
						<strong>Add what your CMS can't see.</strong> Forms, services like your CRM, workflows and owners, with{" "}
						<em>Add a form, service or workflow</em>, then <em>Add a relationship</em> on a page.
					</li>
					<li>
						<strong>Before you change something, open its Impact tab.</strong> It lists everything that depends on it,
						step by step.
					</li>
				</ol>
				<p>The map keeps itself up to date when entries are saved. Rescan after bulk imports.</p>
				{brokenCount > 0 ? (
					<Button onClick={() => void showBroken()}>
						{brokenCount === 1 ? "Show the broken link" : `Show a broken link (${brokenCount})`}
					</Button>
				) : null}
				{error ? <p role="alert" className="sg-error">{error}</p> : null}
			</div>
		</div>
	);
}

function scanSummary(last: LastScan): string {
	const read = `Read ${last.processed} ${last.processed === 1 ? "entry" : "entries"}`;
	const retired =
		last.retired === 0
			? "nothing was out of date"
			: `${last.retired} out-of-date ${last.retired === 1 ? "link or page" : "links or pages"} cleared from the map`;
	return `${read}; ${retired}.`;
}

function ScanButton({ overview, onDone, children }: { overview?: Overview; onDone: () => void; children?: React.ReactNode }) {
	const [progress, setProgress] = React.useState<string>();
	const [finished, setFinished] = React.useState<LastScan>();
	const [error, setError] = React.useState<string>();
	const last = overview?.scan.last;

	const run = async () => {
		setError(undefined);
		setFinished(undefined);
		setProgress("Starting scan…");
		try {
			await api.startScan();
			for (;;) {
				const step = await api.scanStep();
				if (step.done) {
					if (step.last) setFinished(step.last);
					break;
				}
				setProgress(`${step.state?.phase === "collect" ? "Reading entries" : "Tidying up"}: ${step.state?.processed ?? 0} read`);
			}
			setProgress(undefined);
			onDone();
		} catch (e) {
			setProgress(undefined);
			setError(message(e));
		}
	};

	return (
		<div className="sg-scan">
			<div className="sg-row">
				{children}
				<Button variant="primary" onClick={() => void run()} loading={!!progress} disabled={!!progress}>
					{last ? "Rescan site" : "Scan site"}
				</Button>
			</div>
			<span className="sg-muted" role="status">
				{progress ??
					(finished
						? `Scan complete. ${scanSummary(finished)}`
						: last
							? `${last.status === "PARTIAL" ? "Last scan was incomplete" : "Last scanned"} ${new Date(last.finishedAt).toLocaleString()}`
							: "Never scanned")}
			</span>
			{last?.status === "PARTIAL" ? (
				<details className="sg-muted">
					<summary>{last.errors.length} entries couldn't be read</summary>
					<ul>
						{last.errors.map((e) => (
							<li key={e}>{e}</li>
						))}
					</ul>
				</details>
			) : null}
			{error ? <p role="alert" className="sg-error">{error}</p> : null}
		</div>
	);
}

function ExportButton({ disabled }: { disabled: boolean }) {
	const [error, setError] = React.useState<string>();
	const run = async () => {
		try {
			const data = await api.export();
			const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
			const a = Object.assign(document.createElement("a"), { href: url, download: `sitegraph-${new Date().toISOString().slice(0, 10)}.json` });
			a.click();
			URL.revokeObjectURL(url);
		} catch (e) {
			setError(message(e));
		}
	};
	return (
		<>
			<Button onClick={() => void run()} disabled={disabled}>
				Export JSON
			</Button>
			{error ? <p role="alert" className="sg-error">{error}</p> : null}
		</>
	);
}

function Finder({ onPick, onCreated, brokenCount }: { onPick: (id: string) => void; onCreated: (id: string) => void; brokenCount: number }) {
	const [query, setQuery] = React.useState("");
	const [type, setType] = React.useState<NodeType | "">("");
	const [broken, setBroken] = React.useState(false);
	const { items, loading, error } = useNodeSearch(query, { type: type || undefined, broken });

	return (
		<nav className="sg-finder" aria-label="Find in graph">
			<Input label="Search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Title or /path" />
			<div className="sg-filters">
				<select aria-label="Type" value={type} onChange={(e) => setType(e.target.value as NodeType | "")} disabled={broken}>
					<option value="">All types</option>
					{NODE_TYPES.map((t) => (
						<option key={t} value={t}>
							{TYPE_LABEL[t]}
						</option>
					))}
				</select>
				<label className="sg-check">
					<input type="checkbox" checked={broken} onChange={(e) => setBroken(e.target.checked)} />
					Broken links ({brokenCount})
				</label>
			</div>
			{error ? <p role="alert" className="sg-error">{error}</p> : null}
			<ul className="sg-results" aria-busy={loading}>
				{items.map((n) => (
					<li key={n.id}>
						<button type="button" onClick={() => onPick(n.id)}>
							<span className="sg-result-label">{n.label}</span>
							<span className="sg-kind" data-type={n.type} data-broken={isBroken(n) || undefined}>
								{isBroken(n) ? "Broken link" : TYPE_LABEL[n.type]}
							</span>
						</button>
					</li>
				))}
				{!loading && items.length === 0 ? <li className="sg-muted">{query ? "No matches. Names match from their first letter." : "Nothing here yet."}</li> : null}
			</ul>
			<AddNode onCreated={onCreated} />
		</nav>
	);
}

function AddNode({ onCreated }: { onCreated: (id: string) => void }) {
	const [open, setOpen] = React.useState(false);
	const [type, setType] = React.useState<(typeof DOCUMENTED_NODE_TYPES)[number]>("SERVICE");
	const [label, setLabel] = React.useState("");
	const [status, setStatus] = React.useState<{ busy?: boolean; error?: string }>({});

	if (!open) {
		return (
			<Button size="sm" onClick={() => setOpen(true)}>
				Add a form, service or workflow
			</Button>
		);
	}

	return (
		<form
			className="sg-form sg-add"
			onSubmit={async (e) => {
				e.preventDefault();
				setStatus({ busy: true });
				try {
					const node = await api.saveNode({ type, label });
					setLabel("");
					setOpen(false);
					setStatus({});
					onCreated(node.id);
				} catch (err) {
					setStatus({ error: message(err) });
				}
			}}
		>
			<label className="sg-field">
				<span>Kind</span>
				<select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
					{DOCUMENTED_NODE_TYPES.map((t) => (
						<option key={t} value={t}>
							{TYPE_LABEL[t]}
						</option>
					))}
				</select>
			</label>
			<Input label="Name" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. HubSpot CRM" required maxLength={200} />
			<div className="sg-row">
				<Button type="submit" size="sm" variant="primary" loading={status.busy}>
					Add
				</Button>
				<Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
					Cancel
				</Button>
			</div>
			{status.error ? <p role="alert" className="sg-error">{status.error}</p> : null}
		</form>
	);
}

function Legend() {
	return (
		<ul className="sg-legend" aria-label="Line styles">
			<li>
				<svg width="28" height="8" aria-hidden="true"><line x1="0" y1="4" x2="28" y2="4" /></svg>
				{PROVENANCE_LABEL.DISCOVERED}
			</li>
			<li>
				<svg width="28" height="8" aria-hidden="true"><line x1="0" y1="4" x2="28" y2="4" strokeDasharray="7 5" /></svg>
				{PROVENANCE_LABEL.DOCUMENTED}
			</li>
		</ul>
	);
}

function GraphTable({ nodes, edges, onSelect }: { nodes: Node[]; edges: Edge[]; onSelect: (id: string) => void }) {
	const name = new Map(nodes.map((n) => [n.id, n.label]));
	return (
		<div className="sg-table-wrap">
			<table className="sg-table">
				<caption>Connections shown on the graph</caption>
				<thead>
					<tr>
						<th scope="col">From</th>
						<th scope="col">Relationship</th>
						<th scope="col">To</th>
						<th scope="col">Source</th>
					</tr>
				</thead>
				<tbody>
					{edges.map((e) => (
						<tr key={e.id}>
							<td>
								<button type="button" className="sg-link" onClick={() => onSelect(e.sourceNodeId)}>
									{name.get(e.sourceNodeId) ?? e.sourceNodeId}
								</button>
							</td>
							<td>
								{RELATION_LABEL[e.relation]}
								{e.label ? ` (${e.label})` : ""}
							</td>
							<td>
								<button type="button" className="sg-link" onClick={() => onSelect(e.targetNodeId)}>
									{name.get(e.targetNodeId) ?? e.targetNodeId}
								</button>
							</td>
							<td>
								{PROVENANCE_LABEL[e.provenance]}
								{e.evidence?.fieldPath ? `, ${e.evidence.fieldPath}` : ""}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
