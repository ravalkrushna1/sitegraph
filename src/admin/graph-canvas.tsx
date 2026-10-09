// A small SVG graph view: pan, zoom, drag, fit. Hand-rolled on purpose: React Flow's
// zustand dependency breaks against EmDash's use-sync-external-store shim and takes the
// whole admin down with it. We already lay nodes out ourselves, so this is all we need.

import * as React from "react";

import { type Edge, isBroken, type Node, RELATION_LABEL, TYPE_LABEL } from "./api.js";

export type Point = { x: number; y: number };
type View = { x: number; y: number; k: number };

const W = 176;
const H = 62;
const MIN_K = 0.2;
const MAX_K = 2;
const DRAG_THRESHOLD = 4;

// Provenance is carried by line style, never colour alone (SPEC D4).
const DASH = { DISCOVERED: undefined, DOCUMENTED: "7 5", INFERRED: "2 5" } as const;
const QUIET = new Set(["LINKS_TO", "PUBLISHES_AS"]);

/** Where the segment from a box's centre towards `to` leaves the box. */
function boxExit(from: Point, to: Point): Point {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	if (dx === 0 && dy === 0) return from;
	const scale = 1 / Math.max(Math.abs(dx) / (W / 2 + 4), Math.abs(dy) / (H / 2 + 4));
	return { x: from.x + dx * scale, y: from.y + dy * scale };
}

function fit(points: Point[], width: number, height: number): View {
	if (points.length === 0 || width === 0) return { x: width / 2, y: height / 2, k: 1 };
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	const minX = Math.min(...xs) - W / 2 - 40;
	const maxX = Math.max(...xs) + W / 2 + 40;
	const minY = Math.min(...ys) - H / 2 - 40;
	const maxY = Math.max(...ys) + H / 2 + 40;
	const k = Math.min(1.2, Math.max(MIN_K, Math.min(width / (maxX - minX), height / (maxY - minY))));
	return { k, x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k };
}

export function GraphCanvas({
	nodes,
	edges,
	positions,
	centerId,
	selectedId,
	onSelect,
	onExpand,
	onMove,
}: {
	nodes: Node[];
	edges: Edge[];
	positions: Map<string, Point>;
	centerId: string | null;
	selectedId: string | null;
	onSelect: (id: string | null) => void;
	onExpand: (id: string) => void;
	onMove: (id: string, point: Point) => void;
}) {
	const svgRef = React.useRef<SVGSVGElement>(null);
	const [view, setView] = React.useState<View>({ x: 0, y: 0, k: 1 });
	const drag = React.useRef<{ kind: "pan" | "node"; id?: string; start: Point; origin: Point; moved: boolean } | null>(null);
	const markerId = React.useId().replace(/:/g, "");

	const fitAll = React.useCallback(() => {
		const el = svgRef.current;
		if (!el) return;
		setView(fit([...positions.values()], el.clientWidth, el.clientHeight));
	}, [positions]);

	// Refit when the graph is re-centred (a new search pick or an impact view), not on every drag.
	React.useEffect(fitAll, [centerId, nodes.length]);

	// Wheel zoom around the cursor. Registered natively so preventDefault stops page scroll.
	React.useEffect(() => {
		const el = svgRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const rect = el.getBoundingClientRect();
			const cx = e.clientX - rect.left;
			const cy = e.clientY - rect.top;
			setView((v) => {
				const k = Math.min(MAX_K, Math.max(MIN_K, v.k * Math.exp(-e.deltaY * 0.0015)));
				return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
			});
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, []);

	const zoomBy = (factor: number) => {
		const el = svgRef.current;
		if (!el) return;
		const cx = el.clientWidth / 2;
		const cy = el.clientHeight / 2;
		setView((v) => {
			const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
			return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
		});
	};

	const onPointerDown = (e: React.PointerEvent, id?: string) => {
		if (e.button !== 0) return;
		e.stopPropagation();
		(e.currentTarget as Element).setPointerCapture(e.pointerId);
		const origin = id ? positions.get(id)! : { x: view.x, y: view.y };
		drag.current = { kind: id ? "node" : "pan", id, start: { x: e.clientX, y: e.clientY }, origin, moved: false };
	};

	const onPointerMove = (e: React.PointerEvent) => {
		const d = drag.current;
		if (!d) return;
		const dx = e.clientX - d.start.x;
		const dy = e.clientY - d.start.y;
		if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
		d.moved = true;
		if (d.kind === "pan") setView((v) => ({ ...v, x: d.origin.x + dx, y: d.origin.y + dy }));
		else if (d.id) onMove(d.id, { x: d.origin.x + dx / view.k, y: d.origin.y + dy / view.k });
	};

	const onPointerUp = () => {
		const d = drag.current;
		drag.current = null;
		if (d && !d.moved) onSelect(d.kind === "node" ? d.id! : null);
	};

	const visible = nodes.filter((n) => positions.has(n.id));

	return (
		<div className="sg-canvas">
			<svg
				ref={svgRef}
				className="sg-svg"
				role="group"
				aria-label="Dependency graph"
				onPointerDown={(e) => onPointerDown(e)}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
			>
				<defs>
					<marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
						<path d="M0,0 L10,5 L0,10 z" className="sg-arrow" />
					</marker>
					<pattern id={`${markerId}-dots`} width={24 * view.k} height={24 * view.k} x={view.x} y={view.y} patternUnits="userSpaceOnUse">
						<circle cx={1} cy={1} r={1} className="sg-dot" />
					</pattern>
				</defs>
				<rect width="100%" height="100%" fill={`url(#${markerId}-dots)`} />
				<g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
					{edges.map((edge) => {
						const a = positions.get(edge.sourceNodeId);
						const b = positions.get(edge.targetNodeId);
						if (!a || !b) return null;
						const start = boxExit(a, b);
						const end = boxExit(b, a);
						const label = QUIET.has(edge.relation) ? null : edge.label || RELATION_LABEL[edge.relation];
						const active = edge.sourceNodeId === selectedId || edge.targetNodeId === selectedId;
						return (
							<g key={edge.id} className="sg-edge" data-prov={edge.provenance} data-active={active || undefined}>
								<line x1={start.x} y1={start.y} x2={end.x} y2={end.y} strokeDasharray={DASH[edge.provenance]} markerEnd={`url(#${markerId})`} />
								{label ? (
									<text x={(start.x + end.x) / 2} y={(start.y + end.y) / 2 - 6} textAnchor="middle">
										{label}
									</text>
								) : null}
							</g>
						);
					})}
					{visible.map((node) => {
						const p = positions.get(node.id)!;
						const broken = isBroken(node);
						return (
							<foreignObject key={node.id} x={p.x - W / 2} y={p.y - H / 2} width={W} height={H} className="sg-fo">
								<div
									className="sg-node"
									data-type={node.type}
									data-broken={broken || undefined}
									data-selected={node.id === selectedId || undefined}
									data-center={node.id === centerId || undefined}
									role="button"
									tabIndex={0}
									aria-pressed={node.id === selectedId}
									aria-label={`${broken ? "Broken link" : TYPE_LABEL[node.type]}: ${node.label}. Press Enter to inspect, Shift+Enter to show its connections.`}
									title={node.label}
									onPointerDown={(e) => onPointerDown(e, node.id)}
									onDoubleClick={() => onExpand(node.id)}
									onKeyDown={(e) => {
										if (e.key !== "Enter" && e.key !== " ") return;
										e.preventDefault();
										if (e.shiftKey) onExpand(node.id);
										else onSelect(node.id);
									}}
								>
									<span className="sg-node-type">{broken ? "Broken link" : TYPE_LABEL[node.type]}</span>
									<span className="sg-node-label">{node.label}</span>
									{node.criticality && node.criticality !== "LOW" ? (
										<span className="sg-node-crit" data-level={node.criticality}>
											{node.criticality[0] + node.criticality.slice(1).toLowerCase()}
										</span>
									) : null}
								</div>
							</foreignObject>
						);
					})}
				</g>
			</svg>
			<div className="sg-zoom" role="toolbar" aria-label="Zoom">
				<button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
					+
				</button>
				<button type="button" onClick={() => zoomBy(0.8)} aria-label="Zoom out">
					−
				</button>
				<button type="button" onClick={fitAll}>
					Fit
				</button>
			</div>
		</div>
	);
}

/** Place new nodes on a ring around `origin`, nudging past spots already taken. */
export function ringLayout(origin: Point, ids: string[], taken: Map<string, Point>): Map<string, Point> {
	const placed = new Map<string, Point>();
	const fresh = ids.filter((id) => !taken.has(id));
	const radius = Math.max(220, fresh.length * 30);
	fresh.forEach((id, i) => {
		const angle = (2 * Math.PI * i) / Math.max(fresh.length, 1) - Math.PI / 2;
		let point = { x: origin.x + radius * Math.cos(angle), y: origin.y + radius * Math.sin(angle) };
		const crowded = (p: Point) =>
			[...taken.values(), ...placed.values()].some((q) => Math.abs(q.x - p.x) < W && Math.abs(q.y - p.y) < H + 12);
		for (let step = 0; step < 6 && crowded(point); step++) point = { x: point.x + 60, y: point.y + 80 };
		placed.set(id, point);
	});
	return placed;
}
