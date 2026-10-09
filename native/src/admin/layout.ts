// Graph layout: seed new nodes on a ring, then relax them so boxes don't overlap each other
// and don't sit on top of lines they aren't part of. Only `movable` nodes move, so what the
// person already sees (or dragged into place) stays put.

export type Point = { x: number; y: number };

export const NODE_W = 176;
export const NODE_H = 62;

const GAP_X = NODE_W + 36;
const GAP_Y = NODE_H + 36;
const EDGE_LENGTH = 250;
const LINE_CLEARANCE = NODE_H / 2 + 18;
const ITERATIONS = 220;
// ponytail: O(n²) pairs + O(edges × nodes) line checks per step; fine for the ≤500-node
// views the API returns. A spatial grid is the upgrade if views ever get bigger.

/** Place new nodes on a ring around `origin`. */
export function seedRing(origin: Point, ids: string[], taken: Map<string, Point>): Map<string, Point> {
	const fresh = ids.filter((id) => !taken.has(id));
	const radius = Math.max(EDGE_LENGTH, fresh.length * 34);
	const placed = new Map<string, Point>();
	fresh.forEach((id, i) => {
		const angle = (2 * Math.PI * i) / Math.max(fresh.length, 1) - Math.PI / 2;
		placed.set(id, { x: origin.x + radius * Math.cos(angle), y: origin.y + radius * Math.sin(angle) });
	});
	return placed;
}

/** Push `movable` nodes apart and off unrelated lines; pull linked nodes toward EDGE_LENGTH. */
export function relax(
	positions: Map<string, Point>,
	edges: Array<{ sourceNodeId: string; targetNodeId: string }>,
	movable: Set<string>,
): Map<string, Point> {
	const pos = new Map([...positions].map(([id, p]) => [id, { ...p }]));
	const ids = [...pos.keys()];
	const links = edges.filter((e) => pos.has(e.sourceNodeId) && pos.has(e.targetNodeId) && e.sourceNodeId !== e.targetNodeId);
	if (![...movable].some((id) => pos.has(id))) return pos;

	for (let step = 0; step < ITERATIONS; step++) {
		const cooling = 1 - step / ITERATIONS;
		const force = new Map(ids.map((id) => [id, { x: 0, y: 0 }]));
		const add = (id: string, x: number, y: number) => {
			const f = force.get(id)!;
			f.x += x;
			f.y += y;
		};

		// Boxes repel when they come closer than one box plus a gap.
		for (let i = 0; i < ids.length; i++) {
			for (let j = i + 1; j < ids.length; j++) {
				const a = pos.get(ids[i]!)!;
				const b = pos.get(ids[j]!)!;
				let dx = b.x - a.x;
				let dy = b.y - a.y;
				if (dx === 0 && dy === 0) dx = (i % 2 ? 1 : -1) * 0.5;
				const ox = GAP_X - Math.abs(dx);
				const oy = GAP_Y - Math.abs(dy);
				if (ox <= 0 || oy <= 0) continue;
				// Separate along the axis that needs the smaller move.
				const [px, py] = ox / GAP_X < oy / GAP_Y ? [Math.sign(dx) * ox, 0] : [0, Math.sign(dy || 1) * oy];
				add(ids[i]!, -px / 2, -py / 2);
				add(ids[j]!, px / 2, py / 2);
			}
		}

		// Linked boxes settle at a readable distance.
		for (const e of links) {
			const a = pos.get(e.sourceNodeId)!;
			const b = pos.get(e.targetNodeId)!;
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const d = Math.hypot(dx, dy) || 1;
			const pull = ((d - EDGE_LENGTH) / d) * 0.06;
			add(e.sourceNodeId, dx * pull, dy * pull);
			add(e.targetNodeId, -dx * pull, -dy * pull);
		}

		// A box sitting on a line it isn't part of gets nudged sideways off it.
		for (const e of links) {
			const a = pos.get(e.sourceNodeId)!;
			const b = pos.get(e.targetNodeId)!;
			const vx = b.x - a.x;
			const vy = b.y - a.y;
			const len2 = vx * vx + vy * vy || 1;
			for (const id of ids) {
				if (id === e.sourceNodeId || id === e.targetNodeId || !movable.has(id)) continue;
				const p = pos.get(id)!;
				const t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
				if (t <= 0.05 || t >= 0.95) continue;
				const cx = a.x + t * vx;
				const cy = a.y + t * vy;
				let nx = p.x - cx;
				let ny = p.y - cy;
				const d = Math.hypot(nx, ny);
				if (d >= LINE_CLEARANCE) continue;
				if (d < 1e-6) [nx, ny] = [-vy, vx];
				const n = Math.hypot(nx, ny) || 1;
				add(id, (nx / n) * (LINE_CLEARANCE - d), (ny / n) * (LINE_CLEARANCE - d));
			}
		}

		for (const id of ids) {
			if (!movable.has(id)) continue;
			const f = force.get(id)!;
			const p = pos.get(id)!;
			const limit = 40 * cooling + 2;
			p.x += Math.max(-limit, Math.min(limit, f.x));
			p.y += Math.max(-limit, Math.min(limit, f.y));
		}
	}
	return pos;
}
